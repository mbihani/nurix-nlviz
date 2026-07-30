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
    # Add layout columns to existing tables (idempotent)
    for col, default in [("x", 0), ("y", 0), ("width", 600), ("height", 400)]:
        try:
            con.execute(f"ALTER TABLE pinned_charts ADD COLUMN {col} INTEGER DEFAULT {default}")
        except sqlite3.OperationalError:
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

    alter_cols = [
        ("x", "INTEGER DEFAULT 0"),
        ("y", "INTEGER DEFAULT 0"),
        ("width", "INTEGER DEFAULT 600"),
        ("height", "INTEGER DEFAULT 400"),
    ]

    for attempt in range(3):
        try:
            with engine.begin() as conn:
                conn.execute(ddl)
                for col, col_def in alter_cols:
                    try:
                        conn.execute(sqlalchemy.text(
                            f"ALTER TABLE pinned_charts ADD COLUMN IF NOT EXISTS {col} {col_def}"
                        ))
                    except Exception:
                        pass
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
                            CAST(:chart_config AS jsonb), CAST(:rows_json AS jsonb), :x, :y, :width, :height)
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


def list_pins(session_id: str) -> list[dict]:
    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        con.row_factory = sqlite3.Row
        cur = con.execute(
            "SELECT * FROM pinned_charts WHERE session_id = ? ORDER BY created_at DESC",
            (session_id,),
        )
        rows = [dict(r) for r in cur.fetchall()]
        con.close()
        for r in rows:
            r["chart_config"] = json.loads(r["chart_config"]) if r["chart_config"] else {}
            r["rows_json"] = json.loads(r["rows_json"]) if r["rows_json"] else None
            r.setdefault("x", 0)
            r.setdefault("y", 0)
            r.setdefault("width", 600)
            r.setdefault("height", 400)
        return rows
    else:
        import sqlalchemy

        with _engine.connect() as conn:
            result = conn.execute(
                sqlalchemy.text("""
                    SELECT id, session_id, question, sql_query, chart_type,
                           chart_config, rows_json, created_at,
                           COALESCE(x, 0) AS x, COALESCE(y, 0) AS y,
                           COALESCE(width, 600) AS width, COALESCE(height, 400) AS height
                    FROM pinned_charts
                    WHERE session_id = :session_id
                    ORDER BY created_at DESC
                """),
                {"session_id": session_id},
            )
            rows = []
            for row in result.mappings():
                r = dict(row)
                if isinstance(r.get("chart_config"), str):
                    r["chart_config"] = json.loads(r["chart_config"])
                if isinstance(r.get("rows_json"), str):
                    r["rows_json"] = json.loads(r["rows_json"])
                if r.get("created_at"):
                    r["created_at"] = str(r["created_at"])
                rows.append(r)
            return rows


def update_pin_layout(
    pin_id: int,
    x: int | None = None,
    y: int | None = None,
    width: int | None = None,
    height: int | None = None,
    chart_config: dict | None = None,
) -> dict | None:
    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        con.row_factory = sqlite3.Row
        sets = []
        params: list = []
        if x is not None:
            sets.append("x = ?"); params.append(x)
        if y is not None:
            sets.append("y = ?"); params.append(y)
        if width is not None:
            sets.append("width = ?"); params.append(width)
        if height is not None:
            sets.append("height = ?"); params.append(height)
        if chart_config is not None:
            sets.append("chart_config = ?"); params.append(json.dumps(chart_config))
        if not sets:
            con.close()
            return None
        params.append(pin_id)
        cur = con.execute(
            f"UPDATE pinned_charts SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        if cur.rowcount == 0:
            con.close()
            return None
        con.commit()
        cur2 = con.execute("SELECT * FROM pinned_charts WHERE id = ?", (pin_id,))
        row = cur2.fetchone()
        con.close()
        if not row:
            return None
        r = dict(row)
        r["chart_config"] = json.loads(r["chart_config"]) if r["chart_config"] else {}
        r["rows_json"] = json.loads(r["rows_json"]) if r["rows_json"] else None
        r.setdefault("x", 0)
        r.setdefault("y", 0)
        r.setdefault("width", 600)
        r.setdefault("height", 400)
        return r
    else:
        import sqlalchemy

        sets = []
        params: dict = {"id": pin_id}
        if x is not None:
            sets.append("x = :x"); params["x"] = x
        if y is not None:
            sets.append("y = :y"); params["y"] = y
        if width is not None:
            sets.append("width = :width"); params["width"] = width
        if height is not None:
            sets.append("height = :height"); params["height"] = height
        if chart_config is not None:
            sets.append("chart_config = CAST(:chart_config AS jsonb)")
            params["chart_config"] = json.dumps(chart_config)
        if not sets:
            return None

        with _engine.begin() as conn:
            result = conn.execute(
                sqlalchemy.text(f"""
                    UPDATE pinned_charts
                    SET {', '.join(sets)}
                    WHERE id = :id
                    RETURNING id, session_id, question, sql_query, chart_type,
                              chart_config, rows_json, created_at,
                              COALESCE(x, 0) AS x, COALESCE(y, 0) AS y,
                              COALESCE(width, 600) AS width, COALESCE(height, 400) AS height
                """),
                params,
            )
            row = result.mappings().fetchone()
            if not row:
                return None
            r = dict(row)
            if isinstance(r.get("chart_config"), str):
                r["chart_config"] = json.loads(r["chart_config"])
            if isinstance(r.get("rows_json"), str):
                r["rows_json"] = json.loads(r["rows_json"])
            if r.get("created_at"):
                r["created_at"] = str(r["created_at"])
            return r


def update_pin_config(pin_id: int, chart_config: dict) -> dict | None:
    return update_pin_layout(pin_id, chart_config=chart_config)


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
