"""
Rule-based chart type router + Claude HTML chart generation.
"""

from __future__ import annotations

import json

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
PIE_CARDINALITY_COLS = {"sentiment_label", "product", "platform"}
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
    return col.get("name", "").lower() in PIE_CARDINALITY_COLS


def pick_chart_type(columns: list[dict]) -> str:
    """Rule-based chart type hint: 'bar' | 'line' | 'scatter' | 'pie' | 'counter'"""
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


_VIZ_SYSTEM_PROMPT = (
    "You are a data visualization expert. "
    "\n\nVISUALIZATION SELECTION GUIDE\n\n"
    "Choose the right chart type based on the data pattern:\n"
    "- Trend over time → Line or Area chart\n"
    "- Comparing categories → Bar chart (horizontal if >6 categories)\n"
    "- Part of a whole / proportions → Doughnut/Pie (max 6 slices; group rest as Other)\n"
    "- Distribution / spread / outliers → Histogram\n"
    "- Relationship between two numeric variables → Scatter plot\n"
    "- Flow through sequential stages → Funnel\n"
    "- Single KPI → Counter (large number, no axes)\n"
    "- Detailed data / high cardinality → Table\n"
    "\nAVAILABLE CHART TYPES (Chart.js): line, bar, doughnut, scatter, area (fill:true on line), "
    "histogram (bar with equal bins), counter (custom HTML), table (HTML table)\n"
    "\nANTI-PATTERNS — never do these:\n"
    "- Pie/doughnut with more than 6 slices — use bar instead\n"
    "- Bar chart for time series data — use line\n"
    "- Line chart for categorical (non-temporal) x-axis — use bar\n"
    "- High-cardinality color grouping (>10 unique values) — aggregate to Top-N + Other\n"
    "- Multiple counters when comparison matters — use bar\n"
    "\nCOLOR PALETTE (Databricks brand, use in this order for series):\n"
    "#FF3621, #2272B4, #00A972, #F6A623, #1B3139, #9B59B6, #E74C3C, #3498DB\n"
    "- #00A972 = positive/good, #FF3621 = negative/error, #2272B4 = primary blue\n"
    "- Chart background: transparent, page background: #1B1B1B\n"
    "\nSORTING:\n"
    "- Questions with 'top', 'most', 'highest', 'largest', 'best' → sort descending by metric\n"
    "- Time series → always sort chronologically ascending\n"
    "\nCHART QUALITY:\n"
    "- Always show axis labels and a chart title\n"
    "- Show gridlines on line/area charts\n"
    "- Use horizontal bar if >8 categories\n"
    "- Abbreviate large numbers (K, M, B) on axes\n"
    "- Limit legend to 8 entries max\n"
    "- Output a single H3 heading above the chart — no narrative paragraphs\n"
    "\nOUTPUT REQUIREMENTS:\n"
    "- Output ONLY a complete self-contained HTML document\n"
    "- Use Chart.js via CDN: https://cdn.jsdelivr.net/npm/chart.js\n"
    "- Include a single H3 heading (the question) above the chart\n"
    "- Chart fills full width, height 100%\n"
    "- Use Databricks brand colors: primary #FF3621, blue #2272B4, rest of palette above\n"
    "- NO explanatory text, NO markdown fences, just raw HTML starting with <!DOCTYPE html>\n"
)


async def generate_chart_html(
    columns: list[dict],
    rows: list[list],
    question: str,
    config=None,
    token: str = "",
    refine_instruction: str | None = None,
    current_html: str | None = None,
) -> str:
    """Generate a self-contained HTML chart document using Claude via AI Gateway."""
    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(
            base_url=config.ai_gateway_base_url,
            api_key=token,
        )

        col_desc = ", ".join(f"{c['name']} ({c.get('type', 'unknown')})" for c in columns)
        chart_hint = pick_chart_type(columns)
        col_names = [c["name"] for c in columns]
        data_preview = json.dumps({"columns": col_names, "rows": rows[:50]}, default=str)

        if refine_instruction and current_html:
            user_msg = (
                f"Current HTML chart:\n```html\n{current_html}\n```\n\n"
                f"Refinement instruction: {refine_instruction}\n\n"
                f"Column metadata: {col_desc}\n\n"
                "Regenerate the full HTML document applying the refinement. "
                "Output ONLY raw HTML starting with <!DOCTYPE html>."
            )
        else:
            user_msg = (
                f"Question: {question}\n\n"
                f"Column metadata: {col_desc}\n"
                f"Suggested chart type (rule-based hint): {chart_hint}\n\n"
                f"Data (first 50 rows):\n{data_preview}\n\n"
                "Generate a complete self-contained HTML document visualizing this data. "
                "Output ONLY raw HTML starting with <!DOCTYPE html>."
            )

        response = await client.chat.completions.create(
            model=config.claude_model,
            messages=[
                {"role": "system", "content": _VIZ_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=4096,
        )

        raw = response.choices[0].message.content or ""
        # Handle content-block list shape: [{"type":"text","text":"..."}]
        if isinstance(raw, list):
            raw = " ".join(
                block.get("text", "") if isinstance(block, dict) else str(block)
                for block in raw
            )
        raw = raw.strip()
        # Strip markdown fences if present
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:])
            if raw.endswith("```"):
                raw = raw[:-3].strip()

        return raw

    except Exception as exc:
        from .logger import logger
        logger.warning(f"Claude chart generation failed: {exc}")
        return (
            f'<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;'
            f'height:100%;font-family:sans-serif;color:#666;">'
            f"<p>Chart generation failed: {exc}</p></body></html>"
        )


async def refine_chart_html(
    current_html: str,
    refine_instruction: str,
    columns: list[dict],
    config=None,
    token: str = "",
) -> str:
    """Refine an existing HTML chart with a natural language instruction."""
    return await generate_chart_html(
        columns=columns,
        rows=[],
        question="",
        config=config,
        token=token,
        refine_instruction=refine_instruction,
        current_html=current_html,
    )


_MULTI_CHART_KEYWORDS = {
    " and ", " also ", " both ", " compare ", " vs ", " versus ",
    "dashboard", "overview", "multiple", "breakdown and", "trend and",
}


def _is_multi_chart_question(question: str) -> bool:
    q = question.lower()
    return any(kw in q for kw in _MULTI_CHART_KEYWORDS)


async def decompose_question(
    question: str,
    columns: list[dict],
    rows: list[list],
    config=None,
    token: str = "",
) -> list[dict] | None:
    """
    Ask Claude if the question should produce multiple charts.
    Returns a list of specs [{title, chart_type, description}] (max 4) or None.
    """
    if not _is_multi_chart_question(question):
        return None

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(base_url=config.ai_gateway_base_url, api_key=token)

        col_names = [c["name"] for c in columns]
        data_preview = json.dumps({"columns": col_names, "rows": rows[:5]}, default=str)

        system = (
            "You are a data visualization decomposer. "
            "Given a question and data columns, decide if the question calls for multiple charts. "
            "If yes, return a JSON array of chart specs (max 4). "
            "If no or uncertain, return null. "
            "Each spec: {\"title\": str, \"chart_type\": str, \"description\": str}. "
            "chart_type must be one of: bar, line, pie, scatter, counter. "
            "Output ONLY valid JSON — no markdown, no explanation."
        )
        user_msg = (
            f"Question: {question}\n\n"
            f"Available columns: {', '.join(col_names)}\n\n"
            f"Data sample:\n{data_preview}\n\n"
            "Should this produce multiple charts? If yes, return a JSON array of specs (max 4). "
            "If no, return null."
        )

        response = await client.chat.completions.create(
            model=config.claude_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=512,
        )

        raw = (response.choices[0].message.content or "").strip()
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:])
            if raw.endswith("```"):
                raw = raw[:-3].strip()

        parsed = json.loads(raw)
        if isinstance(parsed, list) and len(parsed) > 1:
            return parsed[:4]
        return None

    except Exception:
        return None
