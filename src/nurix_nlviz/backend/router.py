import json
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .._metadata import api_prefix
from .agent import run_chat_agent, _get_token
from .chart_router import refine_chart_html
from .config import AppConfig
from .logger import logger
from .models import ChatRequest, HealthOut, PinIn, PinOut, RefineRequest
from . import db as db_module


class PinUpdateRequest(BaseModel):
    chart_config: str | None = None
    x: int | None = None
    y: int | None = None
    width: int | None = None
    height: int | None = None

api = APIRouter(prefix=api_prefix)


def get_config(request: Request) -> AppConfig:
    return request.app.state.config


ConfigDep = Annotated[AppConfig, Depends(get_config)]


@api.get("/health", response_model=HealthOut, operation_id="health")
async def health():
    return HealthOut(status="ok")


@api.post("/chat", operation_id="chat")
async def chat(
    body: ChatRequest,
    config: ConfigDep,
):
    """SSE stream for NL-to-Viz chat. Streams typed events."""

    async def event_generator():
        async for chunk in run_chat_agent(
            question=body.question,
            session_id=body.session_id,
            config=config,
        ):
            yield chunk

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@api.post("/refine", operation_id="refineChart")
async def refine_chart_endpoint(body: RefineRequest, config: ConfigDep):
    """Apply a natural-language refinement instruction to an existing chart."""
    try:
        token = await _get_token(config)
        chart_html = await refine_chart_html(
            current_html=body.chart_html,
            refine_instruction=body.refine_instruction,
            columns=body.columns or [],
            config=config,
            token=token,
        )
        return {"chart_html": chart_html}
    except Exception as exc:
        logger.error(f"Error refining chart: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@api.get("/pins", response_model=list[PinOut], operation_id="getPins")
async def get_pins(session_id: str):
    try:
        rows = db_module.list_pins(session_id)
        return [PinOut(**r) for r in rows]
    except Exception as exc:
        logger.error(f"Error fetching pins: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@api.post("/pins", response_model=PinOut, operation_id="createPin")
async def create_pin(body: PinIn):
    try:
        pin_id = db_module.insert_pin(
            session_id=body.session_id,
            question=body.question,
            sql_query=body.sql_query,
            chart_type=body.chart_type,
            chart_config=body.chart_config,
            rows_json=body.rows_json,
            x=body.x,
            y=body.y,
            width=body.width,
            height=body.height,
        )
        rows = db_module.list_pins(body.session_id)
        pin = next((r for r in rows if r["id"] == pin_id), None)
        if not pin:
            raise HTTPException(status_code=500, detail="Pin created but not found")
        return PinOut(**pin)
    except Exception as exc:
        logger.error(f"Error creating pin: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@api.patch("/pins/{pin_id}", response_model=PinOut, operation_id="updatePin")
async def update_pin(pin_id: int, body: PinUpdateRequest):
    try:
        # Layout-only update (x/y/width/height)
        if body.x is not None or body.y is not None or body.width is not None or body.height is not None:
            updated = db_module.update_pin_layout(
                pin_id,
                x=body.x if body.x is not None else 0,
                y=body.y if body.y is not None else 0,
                width=body.width if body.width is not None else 600,
                height=body.height if body.height is not None else 400,
            )
            if not updated:
                raise HTTPException(status_code=404, detail="Pin not found")
            return PinOut(**updated)
        # Config update
        if body.chart_config is not None:
            updated = db_module.update_pin_config(pin_id, body.chart_config)
            if not updated:
                raise HTTPException(status_code=404, detail="Pin not found")
            return PinOut(**updated)
        raise HTTPException(status_code=400, detail="Nothing to update")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Error updating pin: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@api.delete("/pins/{pin_id}", operation_id="deletePin")
async def delete_pin(pin_id: int):
    deleted = db_module.delete_pin(pin_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Pin not found")
    return {"deleted": True}
