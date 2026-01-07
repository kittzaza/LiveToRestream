from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str
    redis_url: str
    stream_key_secret: str
    ingest_rtmp_url: str = "rtmp://ingest/live"

    # Auth (dashboard/control plane)
    # MVP: single admin username/password. Token is a signed JWT (HS256).
    auth_enabled: bool = True
    jwt_secret: str = "dev-secret"
    admin_username: str = "admin"
    admin_password: str = "admin"

    # Legacy token support (optional). If set, this token is accepted as a Bearer/X-API-Token.
    api_auth_token: str | None = None
    dashboard_origin: str = "http://localhost:3000"

    # Minimal API protection (dashboard/control plane)
    api_rate_limit_per_window: int = 120
    api_rate_limit_window_seconds: int = 60


settings = Settings()
