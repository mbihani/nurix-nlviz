"""
Database layer — supports both Lakebase (PostgreSQL via Databricks SDK) and
SQLite as a fallback.  Backend is chosen via DB_TYPE env var.
"""

import json
import os
import sqlite3
import time
from typing import Any

from .config import AppConfig
from .logger import logger

_config: AppConfig | None = None
_engine: Any = None  # SQLAlchemy Engine (Lakebase) or None (SQLite)
_sqlite_path = "/tmp/nurix_pins.db"


def init_db(config: AppConfig) -> None:
    global _config, _engine
    _config = config

    if config.db_type == "sqlite":
        _init_sqlite()
    else:
        _init_lakebase(config)


def _init_sqlite() -> None:
    logger.info(f"Using SQLite at {_sqlite_path}")
    con = sqlite3.connect(_sqlite_path)
    con.execute("""
        CREATE TABLE IF NOT EXISTS pinned_charts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            question TEXT NOT NULL,
            sql_query TEXT,
            chart_type TEXT NOT NULL,
            chart_config TEXT NOT NULL,
            rows_json TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            x INTEGER DEFAULT 0,
            y INTEGER DEFAULT 0,
            width INTEGER DEFAULT 600,
            height INTEGER DEFAULT 400
        )
    """)
    # idempotent: add columns if missing from older databases
    for col, typedef in [("x", "INTEGER DEFAULT 0"), ("y", "INTEGER DEFAULT 0"),
                         ("width", "INTEGER DEFAULT 600"), ("height", "INTEGER DEFAULT 400")]:
        try:
            con.execute(f"ALTER TABLE pinned_charts ADD COLUMN {col} {typedef}")
        except Exception:
            pass  # column already exists
    con.commit()
    con.close()
    logger.info("SQLite table initialized")


def _init_lakebase(config: AppConfig) -> None:
    global _engine
    try:
        from databricks.sdk import WorkspaceClient
        import sqlalchemy
        from sqlalchemy import event as sqla_event

        ws = WorkspaceClient()

        def _engine_url() -> str:
            instance = ws.database.get_database_instance(config.lakebase_instance)
            username = (
                ws.config.client_id
                if ws.config.client_id
                else ws.current_user.me().user_name
            )
            host = instance.read_write_dns
            port = 5432
            database = config.lakebase_database
            return f"postgresql+psycopg2://{username}:@{host}:{port}/{database}"

        url = _engine_url()
        _engine = sqlalchemy.create_engine(
            url,
            pool_recycle=45 * 60,
            pool_pre_ping=True,
            connect_args={"sslmode": "require"},
            pool_size=4,
        )

        def _before_connect(dialect, conn_rec, cargs, cparams):
            cred = ws.database.generate_database_credential(
                instance_names=[config.lakebase_instance]
            )
            cparams["password"] = cred.token

        sqla_event.listen(_engine, "do_connect", _before_connect)

        _create_table_with_retry(_engine)
        logger.info("Lakebase initialized successfully")

    except Exception as exc:
        logger.warning(
            f"Lakebase init failed ({exc}). Falling back to SQLite."
        )
        _engine = None
        _config.db_type = "sqlite"  # type: ignore[union-attr]
        _init_sqlite()


def _create_table_with_retry(engine) -> None:
    import sqlalchemy

    ddl = sqlalchemy.text("""
        CREATE TABLE IF NOT EXISTS pinned_charts (
            id SERIAL PRIMARY KEY,
            session_id TEXT NOT NULL,
            question TEXT NOT NULL,
            sql_query TEXT,
            chart_type TEXT NOT NULL,
            chart_config JSONB NOT NULL,
            rows_json JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            x INTEGER DEFAULT 0,
            y INTEGER DEFAULT 0,
            width INTEGER DEFAULT 600,
            height INTEGER DEFAULT 400
        )
    """)

    alter_stmts = [
        "ALTER TABLE pinned_charts ADD COLUMN IF NOT EXISTS x INTEGER DEFAULT 0",
        "ALTER TABLE pinned_charts ADD COLUMN IF NOT EXISTS y INTEGER DEFAULT 0",
        "ALTER TABLE pinned_charts ADD COLUMN IF NOT EXISTS width INTEGER DEFAULT 600",
        "ALTER TABLE pinned_charts ADD COLUMN IF NOT EXISTS height INTEGER DEFAULT 400",
    ]

    for attempt in range(3):
        try:
            with engine.begin() as conn:
                conn.execute(ddl)
                for stmt in alter_stmts:
                    try:
                        conn.execute(sqlalchemy.text(stmt))
                    except Exception:
                        pass  # column already exists
            logger.info("pinned_charts table ready")
            return
        except Exception as exc:
            err_str = str(exc).lower()
            if "permission" in err_str or "privilege" in err_str or "access" in err_str:
                logger.error(
                    "PERMISSION ERROR: Grant CREATE on schema public to the app service "
                    "principal, then restart the app. "
                    f"Details: {exc}"
                )
                raise
            logger.warning(f"Table create attempt {attempt+1} failed: {exc}")
            time.sleep(2)
    raise RuntimeError("Failed to create pinned_charts table after 3 attempts")


def insert_pin(
    session_id: str,
    question: str,
    sql_query: str | None,
    chart_type: str,
    chart_config: dict,
    rows_json: list | None,
    x: int = 0,
    y: int = 0,
    width: int = 600,
    height: int = 400,
) -> int:
    chart_config_str = json.dumps(chart_config)
    rows_str = json.dumps(rows_json) if rows_json is not None else None

    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        cur = con.execute(
            """INSERT INTO pinned_charts
               (session_id, question, sql_query, chart_type, chart_config, rows_json, x, y, width, height)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, question, sql_query, chart_type, chart_config_str, rows_str, x, y, width, height),
        )
        pin_id = cur.lastrowid
        con.commit()
        con.close()
        return pin_id  # type: ignore
    else:
        import sqlalchemy

        with _engine.begin() as conn:
            result = conn.execute(
                sqlalchemy.text("""
                    INSERT INTO pinned_charts
                    (session_id, question, sql_query, chart_type, chart_config, rows_json, x, y, width, height)
                    VALUES (:session_id, :question, :sql_query, :chart_type,
                            :chart_config::jsonb, :rows_json::jsonb, :x, :y, :width, :height)
                    RETURNING id
                """),
                {
                    "session_id": session_id,
                    "question": question,
                    "sql_query": sql_query,
                    "chart_type": chart_type,
                    "chart_config": chart_config_str,
                    "rows_json": rows_str,
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height,
                },
            )
            return result.scalar_one()


def _normalize_pin_row(r: dict) -> dict:
    r["chart_config"] = json.loads(r["chart_config"]) if isinstance(r.get("chart_config"), str) else (r.get("chart_config") or {})
    r["rows_json"] = json.loads(r["rows_json"]) if isinstance(r.get("rows_json"), str) else r.get("rows_json")
    if r.get("created_at"):
        r["created_at"] = str(r["created_at"])
    r.setdefault("x", 0)
    r.setdefault("y", 0)
    r.setdefault("width", 600)
    r.setdefault("height", 400)
    return r


def list_pins(session_id: str) -> list[dict]:
    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        con.row_factory = sqlite3.Row
        cur = con.execute(
            "SELECT * FROM pinned_charts WHERE session_id = ? ORDER BY created_at DESC",
            (session_id,),
        )
        rows = [_normalize_pin_row(dict(r)) for r in cur.fetchall()]
        con.close()
        return rows
    else:
        import sqlalchemy

        with _engine.connect() as conn:
            result = conn.execute(
                sqlalchemy.text("""
                    SELECT id, session_id, question, sql_query, chart_type,
                           chart_config, rows_json, created_at, x, y, width, height
                    FROM pinned_charts
                    WHERE session_id = :session_id
                    ORDER BY created_at DESC
                """),
                {"session_id": session_id},
            )
            return [_normalize_pin_row(dict(row)) for row in result.mappings()]


def update_pin_layout(pin_id: int, x: int, y: int, width: int, height: int) -> dict | None:
    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        con.row_factory = sqlite3.Row
        cur = con.execute(
            "UPDATE pinned_charts SET x=?, y=?, width=?, height=? WHERE id=?",
            (x, y, width, height, pin_id),
        )
        if cur.rowcount == 0:
            con.close()
            return None
        con.commit()
        cur2 = con.execute("SELECT * FROM pinned_charts WHERE id = ?", (pin_id,))
        row = cur2.fetchone()
        con.close()
        return _normalize_pin_row(dict(row)) if row else None
    else:
        import sqlalchemy

        with _engine.begin() as conn:
            result = conn.execute(
                sqlalchemy.text("""
                    UPDATE pinned_charts
                    SET x = :x, y = :y, width = :width, height = :height
                    WHERE id = :id
                    RETURNING id, session_id, question, sql_query, chart_type,
                              chart_config, rows_json, created_at, x, y, width, height
                """),
                {"x": x, "y": y, "width": width, "height": height, "id": pin_id},
            )
            row = result.mappings().fetchone()
            return _normalize_pin_row(dict(row)) if row else None


def update_pin_config(pin_id: int, chart_config: dict) -> dict | None:
    chart_config_str = json.dumps(chart_config)

    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        con.row_factory = sqlite3.Row
        cur = con.execute(
            "UPDATE pinned_charts SET chart_config = ? WHERE id = ?",
            (chart_config_str, pin_id),
        )
        if cur.rowcount == 0:
            con.close()
            return None
        con.commit()
        cur2 = con.execute("SELECT * FROM pinned_charts WHERE id = ?", (pin_id,))
        row = cur2.fetchone()
        con.close()
        return _normalize_pin_row(dict(row)) if row else None
    else:
        import sqlalchemy

        with _engine.begin() as conn:
            result = conn.execute(
                sqlalchemy.text("""
                    UPDATE pinned_charts
                    SET chart_config = :chart_config::jsonb
                    WHERE id = :id
                    RETURNING id, session_id, question, sql_query, chart_type,
                              chart_config, rows_json, created_at, x, y, width, height
                """),
                {"chart_config": chart_config_str, "id": pin_id},
            )
            row = result.mappings().fetchone()
            return _normalize_pin_row(dict(row)) if row else None


def delete_pin(pin_id: int) -> bool:
    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        cur = con.execute("DELETE FROM pinned_charts WHERE id = ?", (pin_id,))
        deleted = cur.rowcount > 0
        con.commit()
        con.close()
        return deleted
    else:
        import sqlalchemy

        with _engine.begin() as conn:
            result = conn.execute(
                sqlalchemy.text("DELETE FROM pinned_charts WHERE id = :id RETURNING id"),
                {"id": pin_id},
            )
            return result.rowcount > 0
