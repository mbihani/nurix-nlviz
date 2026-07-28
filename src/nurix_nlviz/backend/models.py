from datetime import datetime
from typing import Any

from pydantic import BaseModel


class PinIn(BaseModel):
    session_id: str
    question: str
    sql_query: str | None = None
    chart_type: str
    chart_config: dict[str, Any]
    rows_json: list | None = None


class ChatRequest(BaseModel):
    question: str
    session_id: str


class PinOut(BaseModel):
    id: int
    session_id: str
    question: str
    sql_query: str | None = None
    chart_type: str
    chart_config: dict[str, Any]
    rows_json: list | None = None
    created_at: str | None = None


class HealthOut(BaseModel):
    status: str = "ok"
