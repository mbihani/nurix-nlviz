from datetime import datetime
from typing import Any

from pydantic import BaseModel


class PinIn(BaseModel):
    session_id: str
    question: str
    sql_query: str | None = None
    chart_type: str
    chart_config: str
    rows_json: list | None = None
    x: int = 0
    y: int = 0
    width: int = 600
    height: int = 400


class ChatRequest(BaseModel):
    question: str
    session_id: str


class PinOut(BaseModel):
    id: int
    session_id: str
    question: str
    sql_query: str | None = None
    chart_type: str
    chart_config: str
    rows_json: list | None = None
    created_at: str | None = None
    x: int = 0
    y: int = 0
    width: int = 600
    height: int = 400


class HealthOut(BaseModel):
    status: str = "ok"


class RefineRequest(BaseModel):
    session_id: str
    chart_html: str
    refine_instruction: str
    columns: list[dict] | None = None


class FilterRequest(BaseModel):
    session_id: str
    filter_col: str
    filter_val: str
    pin_ids: list[int]
