import mlflow
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles

from .._metadata import app_name, dist_dir
from .config import AppConfig
from .logger import logger
from .router import api
from . import db as db_module


_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}


class NoCacheHTMLStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if "text/html" in response.headers.get("content-type", ""):
            response.headers.update(_NO_CACHE_HEADERS)
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = AppConfig()
    logger.info(f"Starting {app_name}")
    logger.info(f"  DB type: {config.db_type}")
    logger.info(f"  Genie Space: {config.genie_space_id}")
    logger.info(f"  AI Gateway: {config.ai_gateway_endpoint}")

    # Initialize MLflow
    try:
        mlflow.set_experiment(config.mlflow_experiment)
        logger.info(f"MLflow experiment: {config.mlflow_experiment}")
    except Exception as exc:
        logger.warning(f"MLflow setup failed (non-fatal): {exc}")

    # Initialize database
    try:
        db_module.init_db(config)
    except Exception as exc:
        logger.error(f"DB initialization failed: {exc}")
        # Don't crash on DB init failure — app still works without pins

    app.state.config = config
    yield


app = FastAPI(title=app_name, lifespan=lifespan)

# CORS for local dev
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api)

# Serve static frontend if dist exists
if dist_dir.exists():
    ui = NoCacheHTMLStaticFiles(directory=dist_dir, html=True)
    app.mount("/", ui)
