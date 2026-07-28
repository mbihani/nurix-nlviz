import os
from pathlib import Path
from typing import ClassVar

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

project_root = Path(__file__).parent.parent.parent.parent
env_file = project_root / ".env"

if env_file.exists():
    load_dotenv(dotenv_path=env_file)


class AppConfig(BaseSettings):
    model_config: ClassVar[SettingsConfigDict] = SettingsConfigDict(
        env_file=env_file,
        extra="ignore",
    )

    databricks_host: str = Field(
        default="https://fevm-stable-classic-7ppxjq.cloud.databricks.com",
        validation_alias="DATABRICKS_HOST",
    )
    genie_space_id: str = Field(
        default="01f11dcb53181defb69ee49bd73bca10",
        validation_alias="GENIE_SPACE_ID",
    )
    sql_warehouse_id: str = Field(
        default="24b0352e1b0dca66",
        validation_alias="SQL_WAREHOUSE_ID",
    )
    ai_gateway_endpoint: str = Field(
        default="enterpret-ai-gateway",
        validation_alias="AI_GATEWAY_ENDPOINT",
    )
    claude_model: str = Field(
        default="databricks-claude-sonnet-5",
        validation_alias="CLAUDE_MODEL",
    )
    mlflow_experiment: str = Field(
        default="nurix-nlviz-traces",
        validation_alias="MLFLOW_EXPERIMENT",
    )
    db_type: str = Field(
        default="lakebase",
        validation_alias="DB_TYPE",
    )
    lakebase_instance: str = Field(
        default="nurix-nlviz-db",
        validation_alias="LAKEBASE_INSTANCE",
    )
    lakebase_database: str = Field(
        default="databricks_postgres",
        validation_alias="LAKEBASE_DATABASE",
    )
    databricks_config_profile: str = Field(
        default="fevm-stable",
        validation_alias="DATABRICKS_CONFIG_PROFILE",
    )

    @property
    def genie_mcp_url(self) -> str:
        host = self.databricks_host.rstrip("/")
        return f"{host}/api/2.0/mcp/genie/{self.genie_space_id}"

    @property
    def ai_gateway_base_url(self) -> str:
        host = self.databricks_host.rstrip("/")
        return f"{host}/serving-endpoints/{self.ai_gateway_endpoint}/invocations"
