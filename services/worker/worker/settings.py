from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # Provide a default so modules can be imported/tested without requiring env vars.
    # In docker-compose this is overridden by REDIS_URL.
    redis_url: str = "redis://redis:6379/0"
    ingest_rtmp_url: str = "rtmp://ingest/live"
    ingest_stat_url: str = "http://ingest:8080/stat"
    worker_node_name: str = "worker-1"
    # Microseconds. Forces FFmpeg to error out if network IO stalls so the worker can retry.
    ffmpeg_rw_timeout_us: int = 15_000_000


settings = Settings()
