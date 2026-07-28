# nurix-nlviz — Configuration Guide

This app is a customer-facing NL-to-Viz prototype: chat with your Genie Space,
see charts rendered with Recharts, and pin charts to a persistent gallery backed by Lakebase.

---

## REQUIRED

These must be set before the app will run correctly.

| Marker | File | Description |
|--------|------|-------------|
| `CONFIGURE(BRANDING_TITLE)` | `src/nurix_nlviz/ui/config/branding.ts` | App title shown in header |
| `CONFIGURE(GENIE_SPACE_ID)` | `app.yml` → `GENIE_SPACE_ID` env var | Genie Space ID for NL queries |
| `CONFIGURE(LAKEBASE_CONNECTION_STRING)` | `app.yml` → `LAKEBASE_INSTANCE` env var | Lakebase instance name (or set `DB_TYPE=sqlite` to skip) |

---

## CUSTOMIZE

These change the look and feel or data pipeline.

| Marker | File | Description |
|--------|------|-------------|
| `CONFIGURE(BRANDING_SUBTITLE)` | `src/nurix_nlviz/ui/config/branding.ts` | Subtitle/tagline below the title |
| `CONFIGURE(BRANDING_PRIMARY_COLOR)` | `src/nurix_nlviz/ui/config/branding.ts` | Primary hex color (button, accents) |
| `CONFIGURE(AI_GATEWAY_ENDPOINT)` | `app.yml` → `AI_GATEWAY_ENDPOINT` | AI Gateway endpoint name |
| `CONFIGURE(BRANDING_LOGO_URL)` | `src/nurix_nlviz/ui/config/branding.ts` | Optional: URL to a logo image |

---

## OPTIONAL

| Marker | File | Description |
|--------|------|-------------|
| `CONFIGURE(SQL_WAREHOUSE_ID)` | `app.yml` → `SQL_WAREHOUSE_ID` | Warehouse for fallback SQL execution |
| `CONFIGURE(MLFLOW_EXPERIMENT)` | `app.yml` → `MLFLOW_EXPERIMENT` | MLflow experiment name for traces |
| `CONFIGURE(DB_TYPE)` | `app.yml` → `DB_TYPE` | `lakebase` (default) or `sqlite` (no DB required) |

---

## Architecture

```
Browser (React + Recharts)
    │  SSE /api/chat
    ▼
FastAPI (uvicorn)
    │  LangGraph ReAct agent
    ├──► Genie MCP (SSE transport) ──► Genie Space → enriched_reviews
    ├──► Rule-based chart router (no LLM for common cases)
    ├──► AI Gateway / Claude Sonnet-5 (only for ambiguous chart types)
    └──► Lakebase (or SQLite fallback) — pinned_charts table
         │
         ◄── GET /api/pins?session_id=...  (load on mount, persist across refreshes)
```

## Local Development

```bash
cd nurix-nlviz
uv sync
uv run apx dev start
```

Add a `.env` file with:
```
DATABRICKS_CONFIG_PROFILE=fevm-stable
DB_TYPE=sqlite   # easier for local dev
```

## Deployment

```bash
uv run apx build
databricks apps deploy --profile fevm-stable
```

The app needs these Databricks resources:
- Genie Space `01f11dcb53181defb69ee49bd73bca10` (CAN_RUN)
- Serving endpoint `enterpret-ai-gateway` (CAN_QUERY)
- Database instance `nurix-nlviz-db` (CAN_CONNECT_AND_CREATE) — or set DB_TYPE=sqlite
