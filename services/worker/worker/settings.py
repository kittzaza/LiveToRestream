from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    redis_url: str
    ingest_rtmp_url: str = "rtmp://ingest/live"
    worker_node_name: str = "worker-1"
    # Microseconds. Forces FFmpeg to error out if network IO stalls so the worker can retry.
    ffmpeg_rw_timeout_us: int = 15_000_000


settings = Settings()
