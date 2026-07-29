"""
Rule-based chart type router.  Returns (chart_type, figure_dict) from column metadata
without calling an LLM for common patterns.  Falls back to LLM only when the
rule engine cannot confidently classify.
"""

from __future__ import annotations

import json
from typing import Any

import plotly.graph_objects as go

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

PALETTE = ["#FF3621", "#2272B4", "#00A972", "#F6A623", "#1B3139", "#9B59B6", "#E74C3C", "#3498DB"]


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


def pick_chart_type(columns: list[dict]) -> str:
    """Returns chart_type: 'bar' | 'line' | 'scatter' | 'pie' | 'counter'"""
    if not columns:
        return "counter"

    temporal = [c for c in columns if _is_temporal(c)]
    numerics = [c for c in columns if _is_numeric(c)]
    cats = [c for c in columns if _is_categorical(c)]

    if len(columns) == 1 and numerics:
        return "counter"
    if temporal and numerics:
        return "line"
    if len(numerics) >= 2 and not cats:
        return "scatter"
    if cats and numerics and len(columns) == 2 and _is_pie_candidate(cats[0]):
        return "pie"
    if cats and numerics:
        return "bar"
    if cats and not numerics:
        return "bar"
    if numerics:
        return "bar"
    return "bar"


def build_figure(chart_type: str, columns: list[dict], rows: list[list]) -> dict:
    """Build a Plotly figure dict from column/row data."""
    col_names = [c["name"] for c in columns]

    def col_vals(idx: int) -> list:
        return [row[idx] if isinstance(row, list) else row.get(col_names[idx]) for row in rows]

    # identify column indices
    temporal_idx = next((i for i, c in enumerate(columns) if _is_temporal(c)), None)
    numeric_indices = [i for i, c in enumerate(columns) if _is_numeric(c)]
    cat_indices = [i for i, c in enumerate(columns) if _is_categorical(c)]

    layout_base: dict[str, Any] = {
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(0,0,0,0)",
        "autosize": True,
        "margin": {"t": 40, "b": 60, "l": 60, "r": 20},
        "font": {"family": "Inter, sans-serif", "size": 12},
    }

    if chart_type == "counter":
        idx = numeric_indices[0] if numeric_indices else 0
        value = col_vals(idx)[0] if rows else 0
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = 0
        fig = go.Figure(
            data=[go.Indicator(mode="number", value=value, title={"text": col_names[idx]})],
            layout=go.Layout(**layout_base),
        )
        return fig.to_dict()

    if chart_type == "line":
        x_idx = temporal_idx if temporal_idx is not None else (cat_indices[0] if cat_indices else 0)
        y_idx = numeric_indices[0] if numeric_indices else (1 if len(col_names) > 1 else 0)
        fig = go.Figure(
            data=[go.Scatter(
                x=col_vals(x_idx),
                y=col_vals(y_idx),
                mode="lines+markers",
                name=col_names[y_idx],
                line={"color": PALETTE[0], "width": 2},
                marker={"color": PALETTE[0], "size": 6},
            )],
            layout=go.Layout(
                **layout_base,
                xaxis={"title": col_names[x_idx]},
                yaxis={"title": col_names[y_idx]},
            ),
        )
        return fig.to_dict()

    if chart_type == "scatter":
        x_idx = numeric_indices[0] if len(numeric_indices) > 0 else 0
        y_idx = numeric_indices[1] if len(numeric_indices) > 1 else 1
        fig = go.Figure(
            data=[go.Scatter(
                x=col_vals(x_idx),
                y=col_vals(y_idx),
                mode="markers",
                name=f"{col_names[x_idx]} vs {col_names[y_idx]}",
                marker={"color": PALETTE[0], "size": 8, "opacity": 0.7},
            )],
            layout=go.Layout(
                **layout_base,
                xaxis={"title": col_names[x_idx]},
                yaxis={"title": col_names[y_idx]},
            ),
        )
        return fig.to_dict()

    if chart_type == "pie":
        label_idx = cat_indices[0] if cat_indices else 0
        value_idx = numeric_indices[0] if numeric_indices else 1
        fig = go.Figure(
            data=[go.Pie(
                labels=col_vals(label_idx),
                values=col_vals(value_idx),
                marker={"colors": PALETTE},
                hole=0.3,
            )],
            layout=go.Layout(**layout_base),
        )
        return fig.to_dict()

    # bar (default)
    x_idx = cat_indices[0] if cat_indices else (temporal_idx if temporal_idx is not None else 0)
    y_idx = numeric_indices[0] if numeric_indices else (1 if len(col_names) > 1 else 0)
    x_vals = col_vals(x_idx)
    y_vals = col_vals(y_idx)
    colors = [PALETTE[i % len(PALETTE)] for i in range(len(x_vals))]
    fig = go.Figure(
        data=[go.Bar(
            x=x_vals,
            y=y_vals,
            name=col_names[y_idx],
            marker={"color": colors},
        )],
        layout=go.Layout(
            **layout_base,
            xaxis={"title": col_names[x_idx]},
            yaxis={"title": col_names[y_idx]},
        ),
    )
    return fig.to_dict()


async def pick_chart_type_with_llm(
    columns: list[dict],
    sql: str,
    config,
    token: str,
    rows: list[list] | None = None,
) -> dict:
    """
    LLM fallback for uncertain chart classification.
    Returns a Plotly figure dict.
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
            "Given SQL query result columns, return ONLY valid JSON with this exact shape:\n"
            '{"chartType": "bar|line|scatter|pie|counter"}\n'
            "No explanation, no markdown, just the JSON object.\n"
            f"Context schema:\n{schema_info}"
        )

        col_desc = ", ".join(f"{c['name']} ({c.get('type', 'unknown')})" for c in columns)
        user_msg = f"SQL: {sql}\nResult columns: {col_desc}\nChoose the best Plotly chart type."

        response = await client.chat.completions.create(
            model=config.claude_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=64,
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

    except Exception as exc:
        from .logger import logger
        logger.warning(f"LLM chart classification failed: {exc}, falling back to rule-based")
        chart_type = pick_chart_type(columns)

    return build_figure(chart_type, columns, rows or [])
