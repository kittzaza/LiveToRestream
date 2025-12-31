from __future__ import annotations

import redis

from app.settings import settings


def get_redis() -> redis.Redis:
    # decode_responses=True keeps payloads as str
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)
