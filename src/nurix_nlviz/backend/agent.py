"""
LangGraph-based agent that:
1. Connects to Genie MCP via SSE transport
2. Runs a ReAct agent with the Genie tool + pin_chart tool
3. Streams back typed events: thinking, sql, rows, chart, done, error
"""

from __future__ import annotations

import json
import traceback
from typing import Any, AsyncIterator

import httpx
import mlflow
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from .chart_router import decompose_question, generate_chart_html
from .config import AppConfig
from .logger import logger

try:
    mlflow.langchain.autolog()
except Exception:
    pass  # mlflow autolog is best-effort; don't crash if langchain version unsupported


def _make_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _get_token(config: AppConfig) -> str:
    """Refresh SP token via Databricks SDK — works both locally and in deployed app."""
    try:
        from databricks.sdk import WorkspaceClient
        ws = WorkspaceClient(host=config.databricks_host)
        auth = ws.config.authenticate()
        token = auth.get("Authorization", "").replace("Bearer ", "")
        if not token:
            raise RuntimeError("WorkspaceClient returned empty Authorization header — check SP credentials")
        return token
    except Exception as exc:
        logger.error(f"Could not obtain Databricks token: {exc}")
        raise RuntimeError(f"Authentication failed: {exc}") from exc


class GenieVizAgent:
    """
    Self-contained LangGraph agent for Genie-backed chart generation.

    Usage:
        agent = GenieVizAgent(config)
        async for chunk in agent.stream(question, session_id):
            ...
    """

    def __init__(self, config: AppConfig) -> None:
        self.config = config

    async def stream(self, question: str, session_id: str) -> AsyncIterator[str]:
        """Public entry point. Delegates to _stream_inner and catches ExceptionGroup/TaskGroup errors."""
        error_msg: str | None = None
        try:
            async for event in self._stream_inner(question, session_id):
                yield event
        except BaseException as exc:
            # ExceptionGroup (Python 3.11+) surfaces as BaseException with .exceptions;
            # anyio TaskGroup errors also arrive this way when they escape async generators.
            cause: BaseException = exc
            if hasattr(exc, "exceptions") and exc.exceptions:  # type: ignore[union-attr]
                cause = exc.exceptions[0]  # type: ignore[union-attr]
            error_msg = str(cause)
            logger.error(f"Agent outer error ({type(exc).__name__}): {cause}\n{traceback.format_exc()}")

        if error_msg is not None:
            yield _make_event({"type": "error", "message": error_msg})

    async def _stream_inner(self, question: str, session_id: str) -> AsyncIterator[str]:
        """Create MCP client, build the graph, and stream SSE events."""
        try:
            from langchain_mcp_adapters.client import MultiServerMCPClient

            token = await _get_token(self.config)

            yield _make_event({"type": "thinking", "text": "Connecting to Genie..."})

            # Build MCP client — NOT a context manager in langchain-mcp-adapters 0.1.0+
            # Databricks Genie MCP uses streamable HTTP (POST-based), not legacy SSE (GET-based)
            mcp_client = MultiServerMCPClient(
                {
                    "genie": {
                        "transport": "streamable_http",
                        "url": self.config.genie_mcp_url,
                        "headers": {"Authorization": f"Bearer {token}"},
                    }
                }
            )
            genie_tools = await mcp_client.get_tools()

            config = self.config

            # pin_chart tool — inserts directly into DB
            @tool
            def pin_chart(
                question: str,
                sql: str,
                chart_type: str,
                chart_config_json: str,
                rows_json: str = "[]",
            ) -> str:
                """Pin a chart to the user's pinned charts gallery."""
                from . import db

                try:
                    cfg = json.loads(chart_config_json)
                    rows = json.loads(rows_json)
                    db.insert_pin(
                        session_id=session_id,
                        question=question,
                        sql_query=sql,
                        chart_type=chart_type,
                        chart_config=cfg,
                        rows_json=rows,
                    )
                    return "Chart pinned successfully."
                except Exception as exc:
                    return f"Failed to pin chart: {exc}"

            all_tools = genie_tools + [pin_chart]

            # LLM via AI Gateway (OpenAI-compatible)
            llm = ChatOpenAI(
                base_url=config.ai_gateway_base_url,
                api_key=token,
                model=config.claude_model,
                streaming=False,
            )

            from langgraph.prebuilt import create_react_agent

            system_prompt = (
                "You are a helpful data analyst assistant for the Enterpret customer feedback platform. "
                "You have access to a Genie Space connected to the `enriched_reviews` table which contains "
                "20 columns including: review_id, user_id, product (Free/Pro/Enterprise), feature_area, "
                "feature_detail, rating (1-5), review_text, source, review_timestamp, platform, app_version, "
                "country, session_duration_sec, is_premium_user, sentiment_label (Positive/Neutral/Negative), "
                "ai_summary, ai_category, urgency_score (0-10), processed_at.\n\n"
                "When answering questions:\n"
                "1. Use the Genie tool to query the data\n"
                "2. Provide a clear, concise answer\n"
                "3. Return the SQL used and the result data\n"
                "Always be helpful and explain insights from the data."
            )

            agent = create_react_agent(
                llm,
                all_tools,
                prompt=system_prompt,
            )

            yield _make_event({"type": "thinking", "text": "Asking Genie..."})

            # Track collected data across agent steps
            collected_sql: str | None = None
            collected_rows: list | None = None
            collected_columns: list | None = None

            async for chunk in agent.astream(
                {"messages": [{"role": "user", "content": question}]}
            ):
                # Tool results arrive in the "tools" key as ToolMessage objects
                # Agent messages (AIMessage) arrive in the "agent" key
                for chunk_key in ("tools", "messages"):
                    if chunk_key not in chunk:
                        continue
                    val = chunk[chunk_key]
                    msgs = val.get("messages", []) if isinstance(val, dict) else []
                    for msg in msgs:
                        msg_type = type(msg).__name__

                        # AIMessage — tool call announcements and final answers
                        if msg_type == "AIMessage":
                            for tc in (getattr(msg, "tool_calls", None) or []):
                                if "genie" in tc.get("name", "").lower() or "query" in tc.get("name", "").lower():
                                    yield _make_event({"type": "thinking", "text": "Querying your data..."})

                            content = getattr(msg, "content", "")
                            if content and isinstance(content, str) and not getattr(msg, "tool_calls", None):
                                if "SELECT" in content.upper() and collected_sql is None:
                                    for line in content.split("\n"):
                                        if line.strip().upper().startswith("SELECT"):
                                            collected_sql = line.strip()
                                            yield _make_event({"type": "sql", "sql": collected_sql})
                                            break

                        # ToolMessage — Genie query result
                        elif msg_type == "ToolMessage" and getattr(msg, "name", None):
                            raw_content = getattr(msg, "content", None)
                            logger.info(f"GENIE_TOOL_RESULT type={type(raw_content).__name__} preview={str(raw_content)[:200]}")

                            parsed = _try_parse_genie_result(raw_content)
                            if parsed and collected_rows is None:
                                collected_columns, collected_rows = parsed
                                yield _make_event({
                                    "type": "rows",
                                    "columns": collected_columns,
                                    "rows": collected_rows[:100],
                                })

                            # Also extract SQL from the tool result text
                            if collected_sql is None:
                                text = _extract_text(raw_content)
                                if "SELECT" in text.upper():
                                    for line in text.split("\n"):
                                        if line.strip().upper().startswith("SELECT"):
                                            collected_sql = line.strip()
                                            yield _make_event({"type": "sql", "sql": collected_sql})
                                            break

                # Also check top-level "agent" key for final answer
                if "agent" in chunk:
                    for msg in chunk["agent"].get("messages", []):
                        content = getattr(msg, "content", "")
                        if content and isinstance(content, str) and not getattr(msg, "tool_calls", None):
                            if "SELECT" in content.upper() and collected_sql is None:
                                for line in content.split("\n"):
                                    if line.strip().upper().startswith("SELECT"):
                                        collected_sql = line.strip()
                                        yield _make_event({"type": "sql", "sql": collected_sql})
                                        break

            # Emit chart(s) after collecting rows
            if collected_rows is not None and collected_columns is not None:
                specs = await decompose_question(
                    question,
                    collected_columns,
                    collected_rows[:5],
                    config=config,
                    token=token,
                )
                if specs and len(specs) > 1:
                    total = len(specs)
                    for idx, spec in enumerate(specs):
                        spec_question = spec.get("description") or spec.get("title") or question
                        chart_html = await generate_chart_html(
                            collected_columns,
                            collected_rows[:200],
                            spec_question,
                            config=config,
                            token=token,
                        )
                        yield _make_event({
                            "type": "chart",
                            "html": chart_html,
                            "sql": collected_sql,
                            "columns": collected_columns,
                            "chart_index": idx,
                            "chart_total": total,
                            "title": spec.get("title", f"Chart {idx + 1}"),
                        })
                else:
                    chart_html = await generate_chart_html(
                        collected_columns,
                        collected_rows[:200],
                        question,
                        config=config,
                        token=token,
                    )
                    yield _make_event({
                        "type": "chart",
                        "html": chart_html,
                        "sql": collected_sql,
                        "columns": collected_columns,
                        "chart_index": 0,
                        "chart_total": 1,
                    })
            elif collected_sql:
                yield _make_event({"type": "thinking", "text": "Processing results..."})

            yield _make_event({"type": "done"})

        except Exception as exc:
            logger.error(f"Agent error: {exc}\n{traceback.format_exc()}")
            yield _make_event({"type": "error", "message": str(exc)})


async def run_chat_agent(
    question: str,
    session_id: str,
    config: AppConfig,
) -> AsyncIterator[str]:
    """
    Streams SSE events for a chat question.
    Thin wrapper around GenieVizAgent for backwards compatibility.
    """
    agent = GenieVizAgent(config)
    async for chunk in agent.stream(question, session_id):
        yield chunk


async def run_chat_agent_via_external(
    question: str,
    session_id: str,
    deep_research: bool,
    config: AppConfig,
) -> AsyncIterator[str]:
    """Proxy chat to nurix-agent, forwarding SSE events."""
    try:
        token = await _get_token(config)
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{config.nurix_agent_url}/chat",
                json={
                    "question": question,
                    "session_id": session_id,
                    "deep_research": deep_research,
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                },
            ) as response:
                response.raise_for_status()
                upstream_sent_done = False
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        yield line + "\n\n"
                        try:
                            ev = json.loads(line[6:])
                            if ev.get("type") in ("done", "error", "rejected"):
                                upstream_sent_done = True
                        except Exception:
                            pass
                    elif line.startswith(": ping"):
                        continue  # skip keepalives
                if not upstream_sent_done:
                    yield _make_event({"type": "done"})
    except Exception as exc:
        logger.error(f"nurix-agent chat proxy error: {exc}\n{traceback.format_exc()}")
        yield _make_event({"type": "error", "message": str(exc)})
        yield _make_event({"type": "done"})


async def run_refine_via_external(
    chart_html: str,
    instruction: str,
    session_id: str,
    config: AppConfig,
) -> str:
    """Proxy refine to nurix-agent."""
    # Collect SSE stream and return final chart html
    chart_html_result = chart_html  # fallback
    try:
        token = await _get_token(config)
        async with httpx.AsyncClient(timeout=60) as client:
            async with client.stream(
                "POST",
                f"{config.nurix_agent_url}/refine",
                json={
                    "chart_html": chart_html,
                    "instruction": instruction,
                    "session_id": session_id,
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                },
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        try:
                            event = json.loads(line[6:])
                            if event.get("type") == "chart":
                                chart_html_result = event.get("html", chart_html_result)
                        except Exception:
                            pass
    except Exception as exc:
        logger.error(f"nurix-agent refine proxy error: {exc}\n{traceback.format_exc()}")
    return chart_html_result


def _extract_text(content) -> str:
    """Flatten content (str or list of content blocks) to a plain string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") if isinstance(b, dict) else str(b)
            for b in content
        )
    return ""


def _try_parse_genie_result(content) -> tuple[list[dict], list[list]] | None:
    """
    Parse columns and rows from a Genie MCP tool result.

    Handles:
    - List of content blocks: [{"type": "text", "text": "<json>"}]  (Shape A — streamable_http)
    - Direct JSON string (Shape B)
    - Genie native {"content": {"queryAttachments": [{"statement_response": ...}]}} (Shape C)
    - {"columns": [...], "rows": [...]} (Shape D)
    - {"result": {"columns": [...], "rows": [...]}} (Shape E)
    - List of row dicts (Shape F)
    - Markdown table fallback
    """
    # Shape A — list of content blocks; recurse into each text block
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                result = _try_parse_genie_result(block["text"])
                if result:
                    return result
        return None

    if not isinstance(content, str) or len(content) < 10:
        return None

    # Try JSON parse
    try:
        data = json.loads(content)

        # Shape C — Genie native: {"content": {"queryAttachments": [...]}}
        if isinstance(data, dict) and "content" in data:
            attachments = data["content"].get("queryAttachments", [])
            for att in attachments:
                sr = att.get("statement_response", {})
                if sr.get("status", {}).get("state") != "SUCCEEDED":
                    continue
                manifest = sr.get("manifest", {})
                result = sr.get("result", {})
                schema_cols = manifest.get("schema", {}).get("columns", [])
                data_array = result.get("data_array", [])  # JSON_ARRAY format
                if schema_cols and data_array:
                    cols = [{"name": c["name"], "type": c.get("type_text", "string")}
                            for c in schema_cols]
                    rows = []
                    for row_obj in data_array:
                        vals = [v.get("string_value") for v in row_obj.get("values", [])]
                        rows.append(vals)
                    return cols, rows

        # Shape D — {"columns": [...], "rows": [...]}
        if isinstance(data, dict) and "columns" in data and "rows" in data:
            cols = [{"name": c if isinstance(c, str) else c.get("name", str(c)), "type": "string"}
                    for c in data["columns"]]
            return cols, data["rows"]

        # Shape E — {"result": {"columns": [...], "rows": [...]}}
        if isinstance(data, dict) and "result" in data:
            inner = data["result"]
            if isinstance(inner, dict) and "columns" in inner:
                cols = [{"name": c.get("name", c) if isinstance(c, dict) else c,
                         "type": c.get("type", "string") if isinstance(c, dict) else "string"}
                        for c in inner["columns"]]
                return cols, inner.get("rows", [])

        # Shape F — list of row dicts
        if isinstance(data, list) and data and isinstance(data[0], dict):
            cols = [{"name": k, "type": "string"} for k in data[0].keys()]
            rows = [[r.get(c["name"]) for c in cols] for r in data]
            return cols, rows

    except (json.JSONDecodeError, ValueError):
        pass

    # Markdown table fallback
    lines = [l.strip() for l in content.split("\n") if "|" in l]
    if len(lines) >= 2:
        headers = [h.strip() for h in lines[0].split("|") if h.strip()]
        data_lines = [l for l in lines[2:] if not set(l.replace("|", "").replace("-", "").strip()) <= {""}]
        if headers and data_lines:
            cols = [{"name": h, "type": "string"} for h in headers]
            rows = []
            for line in data_lines[:100]:
                vals = [v.strip() for v in line.split("|")]
                if vals and vals[0] == "":
                    vals = vals[1:]
                if vals and vals[-1] == "":
                    vals = vals[:-1]
                rows.append(vals[:len(headers)])
            return cols, rows

    return None

