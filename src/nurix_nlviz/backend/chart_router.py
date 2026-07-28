"""
Rule-based chart type router.  Returns (chart_type, config) from column metadata
without calling an LLM for common patterns.  Falls back to LLM only when the
rule engine cannot confidently classify.
"""

from __future__ import annotations

import json
from typing import Any

TEMPORAL_COLS = {"review_timestamp", "processed_at"}
CATEGORICAL_COLS = {
    "sentiment_label",
    "product",
    "platform",
    "source",
    "country",
    "feature_area",
    "ai_category",
}
PIE_CARDINALITY_COLS = {"sentiment_label", "product", "platform"}  # low-cardinality
NUMERIC_COLS = {"rating", "urgency_score", "session_duration_sec"}
ID_COLS = {"review_id", "user_id"}

_NUMERIC_TYPES = {"int", "integer", "bigint", "float", "double", "decimal", "numeric", "number", "long"}
_TEMPORAL_TYPES = {"timestamp", "date", "datetime"}
_STRING_TYPES = {"string", "varchar", "text", "char"}


def _is_numeric(col: dict) -> bool:
    name = col.get("name", "").lower()
    dtype = col.get("type", "").lower()
    if name in NUMERIC_COLS:
        return True
    return any(t in dtype for t in _NUMERIC_TYPES)


def _is_temporal(col: dict) -> bool:
    name = col.get("name", "").lower()
    dtype = col.get("type", "").lower()
    if name in TEMPORAL_COLS:
        return True
    return any(t in dtype for t in _TEMPORAL_TYPES)


def _is_categorical(col: dict) -> bool:
    name = col.get("name", "").lower()
    dtype = col.get("type", "").lower()
    if name in CATEGORICAL_COLS:
        return True
    if name in ID_COLS:
        return False
    return any(t in dtype for t in _STRING_TYPES)


def _is_pie_candidate(col: dict) -> bool:
    name = col.get("name", "").lower()
    return name in PIE_CARDINALITY_COLS


def pick_chart_type(columns: list[dict]) -> tuple[str, dict]:
    """
    Returns (chart_type, recharts_config).
    chart_type: "bar" | "line" | "scatter" | "pie" | "counter"
    recharts_config: {xKey, yKey, nameKey, dataKey}
    """
    if not columns:
        return "counter", {}

    names = [c.get("name", "") for c in columns]
    temporal = [c for c in columns if _is_temporal(c)]
    numerics = [c for c in columns if _is_numeric(c)]
    cats = [c for c in columns if _is_categorical(c)]

    # Single value → counter
    if len(columns) == 1 and numerics:
        return "counter", {"dataKey": numerics[0]["name"]}

    # Temporal + numeric → line chart
    if temporal and numerics:
        x_key = temporal[0]["name"]
        y_key = numerics[0]["name"]
        name_key = cats[0]["name"] if cats else x_key
        return "line", {"xKey": x_key, "yKey": y_key, "nameKey": name_key, "dataKey": y_key}

    # Two numerics → scatter
    if len(numerics) >= 2 and not cats:
        return "scatter", {
            "xKey": numerics[0]["name"],
            "yKey": numerics[1]["name"],
            "dataKey": numerics[1]["name"],
        }

    # Pie: low-cardinality categorical + single numeric, and looks like share/count
    if cats and numerics and len(columns) == 2 and _is_pie_candidate(cats[0]):
        return "pie", {
            "nameKey": cats[0]["name"],
            "dataKey": numerics[0]["name"],
        }

    # Categorical + numeric → bar (most common)
    if cats and numerics:
        x_key = cats[0]["name"]
        y_key = numerics[0]["name"]
        return "bar", {"xKey": x_key, "yKey": y_key, "nameKey": x_key, "dataKey": y_key}

    # Categorical only (e.g. counts) → bar with count
    if cats and not numerics:
        return "bar", {"xKey": cats[0]["name"], "yKey": "count", "nameKey": cats[0]["name"], "dataKey": "count"}

    # All numerics → bar histogram-style
    if numerics:
        return "bar", {"xKey": numerics[0]["name"], "yKey": numerics[1]["name"] if len(numerics) > 1 else numerics[0]["name"]}

    return "bar", {"xKey": names[0] if names else "x", "yKey": names[1] if len(names) > 1 else "y"}


async def pick_chart_type_with_llm(
    columns: list[dict],
    sql: str,
    config,
    token: str,
) -> tuple[str, dict]:
    """
    LLM fallback for uncertain chart classification.
    Uses the AI Gateway with Claude Sonnet-5.
    Returns (chart_type, recharts_config).
    """
    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(
            base_url=config.ai_gateway_base_url,
            api_key=token,
        )

        schema_info = """
enriched_reviews columns:
review_id (string), user_id (string), product (string: Free/Pro/Enterprise),
feature_area (string), feature_detail (string), rating (int 1-5),
review_text (string), source (string), review_timestamp (timestamp),
platform (string), app_version (string), country (string),
session_duration_sec (int), is_premium_user (boolean),
sentiment_label (string: Positive/Neutral/Negative),
ai_summary (string), ai_category (string), urgency_score (int 0-10),
processed_at (timestamp)
"""

        system = (
            "You are a data visualization expert. "
            "Given SQL query results columns, return ONLY valid JSON with this exact shape:\n"
            '{"chartType": "bar|line|scatter|pie|counter", "xKey": "...", "yKey": "...", "nameKey": "...", "dataKey": "..."}\n'
            "No explanation, no markdown, just the JSON object.\n"
            f"Context schema:\n{schema_info}"
        )

        col_desc = ", ".join(f"{c['name']} ({c.get('type', 'unknown')})" for c in columns)
        user_msg = f"SQL: {sql}\nResult columns: {col_desc}\nChoose the best Recharts chart type."

        response = await client.chat.completions.create(
            model=config.claude_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=256,
            temperature=0,
        )

        raw = response.choices[0].message.content or "{}"
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        data = json.loads(raw)
        chart_type = data.get("chartType", "bar")
        cfg = {k: v for k, v in data.items() if k != "chartType"}
        return chart_type, cfg

    except Exception as exc:
        from .logger import logger
        logger.warning(f"LLM chart classification failed: {exc}, falling back to rule-based")
        return pick_chart_type(columns)
