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
    repository_backend: str = "memory"
    firestore_database: str = "(default)"
    firestore_state_collection: str = "workflow_internal"
    cloud_tasks_queue: str = "pantry-relay-expirations"
    cloud_tasks_location: str = "us-central1"
    cloud_tasks_callback_url: str | None = None
    cloud_tasks_service_account: str | None = None
    task_oidc_audience: str | None = None
    task_local_secret: str | None = None
    coordinator_token: str = "demo-coordinator-token"
    token_pepper: str = "local-development-only"
    demo_mode: bool = True
    workflow_matcher_enabled: bool = True
    workflow_demo_fallback: bool = True
    hold_minutes: int = 10
    response_window_minutes: int = 10
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
            repository_backend=os.getenv(
                "WORKFLOW_REPOSITORY", defaults.repository_backend
            ).strip().lower(),
            firestore_database=os.getenv(
                "FIRESTORE_DATABASE", defaults.firestore_database
            ),
            firestore_state_collection=os.getenv(
                "FIRESTORE_STATE_COLLECTION", defaults.firestore_state_collection
            ),
            cloud_tasks_queue=os.getenv(
                "CLOUD_TASKS_QUEUE", defaults.cloud_tasks_queue
            ),
            cloud_tasks_location=os.getenv(
                "CLOUD_TASKS_LOCATION",
                os.getenv("GOOGLE_CLOUD_LOCATION", defaults.cloud_tasks_location),
            ),
            cloud_tasks_callback_url=os.getenv("CLOUD_TASKS_CALLBACK_URL"),
            cloud_tasks_service_account=os.getenv("CLOUD_TASKS_SERVICE_ACCOUNT"),
            task_oidc_audience=os.getenv("TASK_OIDC_AUDIENCE"),
            task_local_secret=os.getenv("TASK_LOCAL_SECRET"),
            coordinator_token=os.getenv(
                "COORDINATOR_TOKEN", defaults.coordinator_token
            ).strip(),
            token_pepper=os.getenv("TOKEN_PEPPER", defaults.token_pepper).strip(),
            demo_mode=_as_bool(os.getenv("DEMO_MODE"), default=True),
            workflow_matcher_enabled=_as_bool(
                os.getenv("WORKFLOW_MATCHER_ENABLED"), default=True
            ),
            workflow_demo_fallback=_as_bool(
                os.getenv("WORKFLOW_DEMO_FALLBACK"), default=True
            ),
            hold_minutes=int(os.getenv("HOLD_MINUTES", defaults.hold_minutes)),
            response_window_minutes=int(
                os.getenv("RESPONSE_WINDOW_MINUTES", defaults.response_window_minutes)
            ),
            cors_allow_origins=origins,
        )


settings = Settings.from_env()
