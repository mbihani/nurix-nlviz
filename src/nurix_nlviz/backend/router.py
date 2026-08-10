import json
import traceback
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .._metadata import api_prefix
from .agent import (
    run_chat_agent_via_external,
    run_refine_via_external,
    _get_token,
)
from .chart_router import generate_chart_html
from .config import AppConfig
from .logger import logger
from .models import AskAboutVizRequest, ChatRequest, FilterEntry, FilterRequest, HealthOut, PinIn, PinOut, RefineRequest
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


@api.get("/db_status", operation_id="dbStatus")
async def db_status():
    return db_module.get_db_status()


@api.post("/chat", operation_id="chat")
async def chat(
    body: ChatRequest,
    config: ConfigDep,
):
    """SSE stream for NL-to-Viz chat. Streams typed events."""

    async def event_generator():
        async for chunk in run_chat_agent_via_external(
            question=body.question,
            session_id=body.session_id,
            deep_research=body.deep_research,
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
    """Apply a natural-language refinement instruction to an existing chart via nurix-agent."""
    try:
        new_html = await run_refine_via_external(
            chart_html=body.chart_html,
            instruction=body.refine_instruction,
            session_id=body.session_id,
            config=config,
        )
        # Return both keys: `chart_html` (consumed by the frontend refine handlers)
        # and `html` (matches the nurix-agent event shape).
        return {"chart_html": new_html, "html": new_html}
    except Exception as exc:
        logger.error(f"Error refining chart: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


@api.post("/ask_about_viz", operation_id="askAboutViz")
async def ask_about_viz_endpoint(body: AskAboutVizRequest, config: ConfigDep):
    """Proxy chart-specific questions to nurix-agent and preserve its SSE stream."""

    async def event_generator():
        upstream_sent_done = False
        try:
            # Token acquisition belongs inside the stream's try block so auth
            # failures are delivered as a useful SSE error event.
            token = await _get_token(config)
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream(
                    "POST",
                    f"{config.nurix_agent_url}/ask_about_viz",
                    json=body.model_dump(),
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "text/event-stream",
                        "Content-Type": "application/json",
                    },
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            yield line + "\n\n"
                            try:
                                event = json.loads(line[6:])
                                if event.get("type") == "done":
                                    upstream_sent_done = True
                            except Exception:
                                pass
                        elif line.startswith(": ping"):
                            continue
            if not upstream_sent_done:
                yield 'data: {"type":"done"}\n\n'
        except Exception as exc:
            logger.error(f"nurix-agent ask-about-viz proxy error: {exc}\n{traceback.format_exc()}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            if not upstream_sent_done:
                yield 'data: {"type":"done"}\n\n'

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
            mlflow_trace_id=body.mlflow_trace_id,
            conversation_id=body.conversation_id,
            response_id=body.response_id,
            deep_research=body.deep_research,
            research_run_id=body.research_run_id,
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


@api.post("/filter", operation_id="applyFilter")
async def apply_filter(body: FilterRequest, config: ConfigDep):
    """Re-run pinned chart queries with an injected WHERE filter and regenerate HTML."""
    import re

    try:
        token = await _get_token(config)
        results = []

        for pin_id in body.pin_ids:
            # Load current pin
            pins = db_module.list_pins(body.session_id)
            pin = next((p for p in pins if p["id"] == pin_id), None)
            if not pin or not pin.get("sql_query"):
                continue

            sql = pin["sql_query"].strip().rstrip(";")

            # Merge old single-filter + new multi-filter into one list
            all_filters = list(body.filters)
            if body.filter_col and body.filter_val not in ('', 'All', 'all'):
                all_filters.append(FilterEntry(col=body.filter_col, val=body.filter_val))

            # Build combined WHERE clause using subquery wrapper
            where_parts = []
            for f in all_filters:
                safe_col = re.sub(r'[^a-zA-Z0-9_]', '', f.col)
                safe_val = f.val.replace("'", "''")
                if safe_col and f.val not in ('', 'All', 'all'):
                    where_parts.append(f"{safe_col} = '{safe_val}'")

            if where_parts:
                filtered_sql = f"SELECT * FROM ({sql}) AS _filtered WHERE {' AND '.join(where_parts)}"
            else:
                filtered_sql = sql

            # Execute via Databricks Statement Execution API
            try:
                from databricks.sdk import WorkspaceClient
                ws = WorkspaceClient()
                stmt = ws.statement_execution.execute_statement(
                    warehouse_id=config.sql_warehouse_id,
                    statement=filtered_sql,
                    wait_timeout="30s",
                )
                manifest = stmt.manifest
                result = stmt.result
                if manifest and result and stmt.status and stmt.status.state.value == "SUCCEEDED":
                    schema_cols = (manifest.schema.columns if manifest.schema else []) or []
                    data_array = result.data_array or []
                    columns = [{"name": c.name, "type": c.type_text or "string"} for c in schema_cols]
                    rows = []
                    for row in data_array:
                        rows.append([v for v in row])

                    chart_html = await generate_chart_html(
                        columns=columns,
                        rows=rows[:200],
                        question=pin["question"],
                        config=config,
                        token=token,
                    )
                    # Persist updated chart
                    db_module.update_pin_config(pin_id, chart_html)
                    results.append({"pin_id": pin_id, "chart_html": chart_html})
                else:
                    # Return current chart unchanged if query fails
                    results.append({"pin_id": pin_id, "chart_html": pin["chart_config"]})
            except Exception as exc:
                logger.warning(f"Filter re-run failed for pin {pin_id}: {exc}")
                results.append({"pin_id": pin_id, "chart_html": pin["chart_config"]})

        return results

    except Exception as exc:
        logger.error(f"Error applying filter: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))
