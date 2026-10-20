"""Environment-backed configuration for the agent and HTTP service."""

from __future__ import annotations

from dataclasses import dataclass
import os


def _as_bool(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings with safe, local-development defaults."""

    app_name: str = "atlanta_grocery_rescue"
    agent_model: str = "gemini-2.5-flash"
    matcher_provider: str = "agent.matcher:match_surplus"
    enable_bigquery_mcp: bool = False
    bigquery_mcp_url: str = "https://bigquery.googleapis.com/mcp"
    google_cloud_project: str | None = None
    cors_allow_origins: tuple[str, ...] = (
        "http://localhost:3000",
        "http://localhost:5173",
    )

    @classmethod
    def from_env(cls) -> "Settings":
        defaults = cls()
        origins = tuple(
            origin.strip()
            for origin in os.getenv(
                "CORS_ALLOW_ORIGINS",
                "http://localhost:3000,http://localhost:5173",
            ).split(",")
            if origin.strip()
        )
        return cls(
            app_name=os.getenv("APP_NAME", defaults.app_name),
            agent_model=os.getenv("AGENT_MODEL", defaults.agent_model),
            matcher_provider=os.getenv("MATCHER_PROVIDER", defaults.matcher_provider),
            enable_bigquery_mcp=_as_bool(os.getenv("ENABLE_BIGQUERY_MCP")),
            bigquery_mcp_url=os.getenv(
                "BIGQUERY_MCP_URL", defaults.bigquery_mcp_url
            ),
            google_cloud_project=os.getenv("GOOGLE_CLOUD_PROJECT")
            or os.getenv("GCLOUD_PROJECT"),
            cors_allow_origins=origins,
        )


settings = Settings.from_env()
