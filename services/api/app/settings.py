from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str
    redis_url: str
    stream_key_secret: str
    ingest_rtmp_url: str = "rtmp://ingest/live"

    # Dashboard/API auth (optional). If set, all control-plane endpoints require a token.
    # Accepted headers: Authorization: Bearer <token> OR X-API-Token: <token>
    api_auth_token: str | None = None
    dashboard_origin: str = "http://localhost:3000"

    # Minimal API protection (dashboard/control plane)
    api_rate_limit_per_window: int = 120
    api_rate_limit_window_seconds: int = 60


settings = Settings()
