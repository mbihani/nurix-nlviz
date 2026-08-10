"""
Database layer — supports Lakebase and explicitly configured SQLite.
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
_configured_backend: str | None = None
_resolved_backend: str | None = None
_last_init_error: str | None = None


def init_db(config: AppConfig) -> None:
    global _config, _engine, _configured_backend, _resolved_backend, _last_init_error
    _config = config
    _configured_backend = config.db_type
    _resolved_backend = None
    _last_init_error = None

    if config.db_type == "sqlite":
        _init_sqlite()
        _resolved_backend = "sqlite"
    else:
        _init_lakebase(config)


def get_db_status() -> dict[str, Any]:
    return {
        "configured": _configured_backend,
        "resolved": _resolved_backend,
        "pid": os.getpid(),
        "last_init_error": _last_init_error,
    }


def _init_sqlite() -> None:
    logger.info(f"Resolved database backend=sqlite pid={os.getpid()} path={_sqlite_path}")
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
            height INTEGER DEFAULT 400,
            mlflow_trace_id TEXT,
            conversation_id TEXT,
            response_id TEXT,
            deep_research BOOLEAN DEFAULT FALSE,
            research_run_id TEXT
        )
    """)
    # idempotent: add columns if missing from older databases
    for col, typedef in [("x", "INTEGER DEFAULT 0"), ("y", "INTEGER DEFAULT 0"),
                         ("width", "INTEGER DEFAULT 600"), ("height", "INTEGER DEFAULT 400"),
                         ("mlflow_trace_id", "TEXT"), ("conversation_id", "TEXT"),
                         ("response_id", "TEXT"), ("deep_research", "INTEGER DEFAULT 0"),
                         ("research_run_id", "TEXT")]:
        try:
            con.execute(f"ALTER TABLE pinned_charts ADD COLUMN {col} {typedef}")
        except Exception:
            pass  # column already exists
    con.commit()
    con.close()
    logger.info("SQLite table initialized")


def _init_lakebase(config: AppConfig) -> None:
    global _engine, _resolved_backend, _last_init_error
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
        _resolved_backend = "lakebase"
        logger.info(f"Resolved database backend=lakebase pid={os.getpid()}")

    except Exception as exc:
        _last_init_error = f"{type(exc).__name__}: {exc}"
        _engine = None
        logger.error(
            f"Lakebase initialization failed pid={os.getpid()}: {_last_init_error}",
            exc_info=True,
        )
        raise


def _create_table_with_retry(engine) -> None:
    import sqlalchemy

    ddl = sqlalchemy.text("""
        CREATE TABLE IF NOT EXISTS pinned_charts (
            id SERIAL PRIMARY KEY,
            session_id TEXT NOT NULL,
            question TEXT NOT NULL,
            sql_query TEXT,
            chart_type TEXT NOT NULL,
            chart_config TEXT NOT NULL,
            rows_json JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            x INTEGER DEFAULT 0,
            y INTEGER DEFAULT 0,
            width INTEGER DEFAULT 600,
            height INTEGER DEFAULT 400,
            mlflow_trace_id TEXT,
            conversation_id TEXT,
            response_id TEXT,
            deep_research BOOLEAN DEFAULT FALSE,
            research_run_id TEXT
        )
    """)

    alter_stmts = {
        "x": "ALTER TABLE pinned_charts ADD COLUMN x INTEGER DEFAULT 0",
        "y": "ALTER TABLE pinned_charts ADD COLUMN y INTEGER DEFAULT 0",
        "width": "ALTER TABLE pinned_charts ADD COLUMN width INTEGER DEFAULT 600",
        "height": "ALTER TABLE pinned_charts ADD COLUMN height INTEGER DEFAULT 400",
        "mlflow_trace_id": "ALTER TABLE pinned_charts ADD COLUMN mlflow_trace_id TEXT",
        "conversation_id": "ALTER TABLE pinned_charts ADD COLUMN conversation_id TEXT",
        "response_id": "ALTER TABLE pinned_charts ADD COLUMN response_id TEXT",
        "deep_research": "ALTER TABLE pinned_charts ADD COLUMN deep_research BOOLEAN DEFAULT FALSE",
        "research_run_id": "ALTER TABLE pinned_charts ADD COLUMN research_run_id TEXT",
    }

    for attempt in range(3):
        try:
            with engine.begin() as conn:
                conn.execute(ddl)
                # CREATE TABLE IF NOT EXISTS cannot repair an existing JSONB column.
                # The generated chart is raw HTML, so migrate it explicitly and
                # idempotently before any inserts are accepted.
                chart_config_type = conn.execute(sqlalchemy.text("""
                    SELECT data_type
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'pinned_charts'
                      AND column_name = 'chart_config'
                """)).scalar_one_or_none()
                if chart_config_type != "text":
                    conn.execute(sqlalchemy.text("""
                        ALTER TABLE pinned_charts
                        ALTER COLUMN chart_config TYPE TEXT
                        USING chart_config::text
                    """))
                existing_columns = set(conn.execute(sqlalchemy.text("""
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'pinned_charts'
                """)).scalars())
                for column, stmt in alter_stmts.items():
                    if column not in existing_columns:
                        conn.execute(sqlalchemy.text(stmt))
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
    chart_config,
    rows_json: list | None,
    x: int = 0,
    y: int = 0,
    width: int = 600,
    height: int = 400,
    mlflow_trace_id: str | None = None,
    conversation_id: str | None = None,
    response_id: str | None = None,
    deep_research: bool = False,
    research_run_id: str | None = None,
) -> int:
    # chart_config is now an HTML string; accept str or dict (legacy)
    if isinstance(chart_config, dict):
        chart_config_str = json.dumps(chart_config)
    else:
        chart_config_str = str(chart_config) if chart_config is not None else ""
    rows_str = json.dumps(rows_json) if rows_json is not None else None

    if _config and _config.db_type == "sqlite":
        con = sqlite3.connect(_sqlite_path)
        cur = con.execute(
            """INSERT INTO pinned_charts
               (session_id, question, sql_query, chart_type, chart_config, rows_json, x, y, width, height,
                mlflow_trace_id, conversation_id, response_id, deep_research, research_run_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, question, sql_query, chart_type, chart_config_str, rows_str, x, y, width, height,
             mlflow_trace_id, conversation_id, response_id, deep_research, research_run_id),
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
                    (session_id, question, sql_query, chart_type, chart_config, rows_json, x, y, width, height,
                     mlflow_trace_id, conversation_id, response_id, deep_research, research_run_id)
                    VALUES (:session_id, :question, :sql_query, :chart_type,
                            :chart_config, CAST(:rows_json AS jsonb), :x, :y, :width, :height,
                            :mlflow_trace_id, :conversation_id, :response_id, :deep_research, :research_run_id)
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
                    "mlflow_trace_id": mlflow_trace_id,
                    "conversation_id": conversation_id,
                    "response_id": response_id,
                    "deep_research": deep_research,
                    "research_run_id": research_run_id,
                },
            )
            return result.scalar_one()


def _normalize_pin_row(r: dict) -> dict:
    # chart_config is an HTML string; return as-is
    cc = r.get("chart_config")
    if isinstance(cc, str):
        # Keep as string; legacy JSON blobs become their string representation
        r["chart_config"] = cc
    else:
        r["chart_config"] = cc or ""
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
                           chart_config, rows_json, created_at, x, y, width, height,
                           mlflow_trace_id, conversation_id, response_id, deep_research, research_run_id
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
                              chart_config, rows_json, created_at, x, y, width, height,
                              mlflow_trace_id, conversation_id, response_id, deep_research, research_run_id
                """),
                {"x": x, "y": y, "width": width, "height": height, "id": pin_id},
            )
            row = result.mappings().fetchone()
            return _normalize_pin_row(dict(row)) if row else None


def update_pin_config(pin_id: int, chart_config) -> dict | None:
    if isinstance(chart_config, dict):
        chart_config_str = json.dumps(chart_config)
    else:
        chart_config_str = str(chart_config) if chart_config is not None else ""

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
                    SET chart_config = :chart_config
                    WHERE id = :id
                    RETURNING id, session_id, question, sql_query, chart_type,
                              chart_config, rows_json, created_at, x, y, width, height,
                              mlflow_trace_id, conversation_id, response_id, deep_research, research_run_id
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
