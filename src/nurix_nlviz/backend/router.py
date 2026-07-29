import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .._metadata import api_prefix
from .agent import run_chat_agent
from .chart_router import generate_html_report
from .config import AppConfig
from .logger import logger
from .models import ChatRequest, HealthOut, PinIn, PinOut
from . import db as db_module


class PinUpdateRequest(BaseModel):
    chart_config: dict[str, Any] | None = None
    x: int | None = None
    y: int | None = None
    width: int | None = None
    height: int | None = None


class RefineRequest(BaseModel):
    original_question: str
    refinement: str
    columns: list[str]
    rows: list[list]

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
async def refine_chart(req: RefineRequest, config: ConfigDep):
    """Re-ask Claude to regenerate HTML with a refinement instruction."""
    try:
        from openai import AsyncOpenAI
        from databricks.sdk import WorkspaceClient

        ws = WorkspaceClient()
        auth = ws.config.authenticate()
        token = auth.get("Authorization", "").replace("Bearer ", "")

        client = AsyncOpenAI(
            base_url=config.ai_gateway_base_url,
            api_key=token,
        )
        html = await generate_html_report(
            question=f"{req.original_question} — {req.refinement}",
            columns=[{"name": c} for c in req.columns],
            rows=req.rows,
            client=client,
        )
        return {"html": html}
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
        updated = db_module.update_pin_layout(
            pin_id,
            x=body.x,
            y=body.y,
            width=body.width,
            height=body.height,
            chart_config=body.chart_config,
        )
        if not updated:
            raise HTTPException(status_code=404, detail="Pin not found")
        return PinOut(**updated)
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
