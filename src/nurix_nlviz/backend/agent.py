"""
LangGraph-based agent that:
1. Connects to Genie MCP via SSE transport
2. Runs a ReAct agent with the Genie tool + pin_chart tool
3. Streams back typed events: thinking, sql, rows, chart, done, error
"""

from __future__ import annotations

import asyncio
import json
import traceback
from typing import Any, AsyncIterator

import mlflow
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from .chart_router import pick_chart_type, pick_chart_type_with_llm
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
        ws = WorkspaceClient()
        auth = ws.config.authenticate()
        return auth.get("Authorization", "").replace("Bearer ", "")
    except Exception as exc:
        logger.warning(f"Could not refresh token: {exc}")
        return ""


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
                temperature=0,
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
                # Extract tool results (SQL + data) from agent messages
                if "messages" in chunk:
                    for msg in chunk["messages"]:
                        # Tool calls on the agent side
                        if hasattr(msg, "tool_calls"):
                            for tc in (msg.tool_calls or []):
                                if "genie" in tc.get("name", "").lower() or "query" in tc.get("name", "").lower():
                                    yield _make_event({"type": "thinking", "text": "Querying your data..."})

                        # Tool results
                        content = getattr(msg, "content", None)
                        if content and isinstance(content, str) and len(content) > 20:
                            # Try to extract SQL
                            if "SELECT" in content.upper() and collected_sql is None:
                                lines = content.split("\n")
                                sql_lines = []
                                in_sql = False
                                for line in lines:
                                    if line.strip().upper().startswith("SELECT"):
                                        in_sql = True
                                    if in_sql:
                                        sql_lines.append(line)
                                        if line.strip().endswith(";") or (line.strip() == "" and sql_lines):
                                            break
                                if sql_lines:
                                    collected_sql = "\n".join(sql_lines).strip()
                                    yield _make_event({"type": "sql", "sql": collected_sql})

                            # Try to parse tabular data from tool message
                            if hasattr(msg, "name") and msg.name and collected_rows is None:
                                parsed = _try_parse_genie_result(content)
                                if parsed:
                                    collected_columns, collected_rows = parsed
                                    yield _make_event({
                                        "type": "rows",
                                        "columns": collected_columns,
                                        "rows": collected_rows[:100],
                                    })

                # Final agent answer
                if "agent" in chunk:
                    agent_msgs = chunk["agent"].get("messages", [])
                    for msg in agent_msgs:
                        content = getattr(msg, "content", "")
                        if content and isinstance(content, str) and not getattr(msg, "tool_calls", None):
                            # This is the final answer
                            # Extract SQL from final message if not found yet
                            if "SELECT" in content.upper() and collected_sql is None:
                                for line in content.split("\n"):
                                    if line.strip().upper().startswith("SELECT"):
                                        collected_sql = line.strip()
                                        yield _make_event({"type": "sql", "sql": collected_sql})
                                        break

            # Emit chart after collecting rows
            if collected_rows is not None and collected_columns is not None:
                chart_type, chart_config = pick_chart_type(collected_columns)

                # Use LLM if columns are ambiguous (no clear rule hit)
                if chart_type == "bar" and collected_sql and len(collected_columns) <= 2:
                    pass  # bar is a safe default

                chart_data = _rows_to_chart_data(collected_columns, collected_rows)
                yield _make_event({
                    "type": "chart",
                    "chartType": chart_type,
                    "config": chart_config,
                    "data": chart_data[:200],
                    "sql": collected_sql,
                    "columns": collected_columns,
                    "rows": collected_rows[:100],
                })
            elif collected_sql:
                # We have SQL but no rows parsed — still send a done event
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


def _try_parse_genie_result(content: str) -> tuple[list[dict], list[list]] | None:
    """
    Try to parse columns and rows from a Genie tool result string.
    Genie typically returns JSON with columns/rows or a markdown table.
    """
    # Try JSON parse first
    try:
        data = json.loads(content)
        if isinstance(data, dict):
            if "columns" in data and "rows" in data:
                cols = [{"name": c, "type": "string"} for c in data["columns"]]
                return cols, data["rows"]
            if "result" in data:
                inner = data["result"]
                if isinstance(inner, dict) and "columns" in inner:
                    cols = [{"name": c.get("name", c) if isinstance(c, dict) else c, "type": c.get("type", "string") if isinstance(c, dict) else "string"} for c in inner["columns"]]
                    return cols, inner.get("rows", [])
        if isinstance(data, list) and data and isinstance(data[0], dict):
            cols = [{"name": k, "type": "string"} for k in data[0].keys()]
            rows = [[r.get(c["name"]) for c in cols] for r in data]
            return cols, rows
    except (json.JSONDecodeError, ValueError):
        pass

    # Try markdown table
    lines = [l.strip() for l in content.split("\n") if "|" in l]
    if len(lines) >= 2:
        headers = [h.strip() for h in lines[0].split("|") if h.strip()]
        data_lines = [l for l in lines[2:] if not l.replace("|", "").replace("-", "").strip() == ""]
        if headers and data_lines:
            cols = [{"name": h, "type": "string"} for h in headers]
            rows = []
            for line in data_lines[:100]:
                vals = [v.strip() for v in line.split("|") if v.strip() or True]
                vals = [v for i, v in enumerate(vals) if i < len(headers) + 1]
                # remove first/last empty from pipe split
                if vals and vals[0] == "":
                    vals = vals[1:]
                if vals and vals[-1] == "":
                    vals = vals[:-1]
                rows.append(vals[:len(headers)])
            return cols, rows

    return None


def _rows_to_chart_data(columns: list[dict], rows: list[list]) -> list[dict]:
    """Convert column/rows format to [{col: val, ...}] for Recharts."""
    result = []
    col_names = [c["name"] for c in columns]
    for row in rows:
        if isinstance(row, dict):
            result.append(row)
        elif isinstance(row, list):
            result.append({col_names[i]: row[i] for i in range(min(len(col_names), len(row)))})
    return result
