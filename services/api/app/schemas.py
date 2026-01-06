from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field


class StreamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    stream_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z]+$",
        description="Optional custom stream key (English letters only: A-Z, a-z).",
    )


class StreamOut(BaseModel):
    id: int
    name: str
    stream_key: str


class StreamSummaryOut(BaseModel):
    id: int
    name: str
    is_active: bool
    created_at: dt.datetime
    ingest_state: str
    last_publish_at: str | None = None


class StreamResolveOut(BaseModel):
    id: int
    name: str
    is_active: bool
    created_at: dt.datetime


class StreamKeyRotateIn(BaseModel):
    stream_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z]+$",
        description="Optional new stream key (English letters only). If omitted, a random letters-only key is generated.",
    )


class StreamKeyOut(BaseModel):
    stream_id: int
    stream_key: str


class TargetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    rtmp_url: str = Field(min_length=1)


class TargetOut(BaseModel):
    id: int
    name: str
    rtmp_url: str
    enabled: bool


class TargetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    rtmp_url: str | None = Field(default=None, min_length=1)
    enabled: bool | None = None


class TargetSummaryOut(BaseModel):
    id: int
    stream_id: int
    name: str
    rtmp_url: str
    enabled: bool
    created_at: dt.datetime


class SessionOut(BaseModel):
    id: int
    stream_id: int
    started_at: dt.datetime
    ended_at: dt.datetime | None


class SessionSummaryOut(BaseModel):
    id: int
    stream_id: int
    started_at: dt.datetime
    ended_at: dt.datetime | None
    ingest_addr: str | None = None
    ingest_app: str | None = None
    ingest_name: str | None = None


class TargetStatusOut(BaseModel):
    target_id: int
    state: str
    pid: int | None = None
    exit_code: int | None = None
    updated_at: str | None = None


class StreamStatusOut(BaseModel):
    stream_id: int
    ingest_state: str
    last_publish_at: str | None = None
    targets: list[TargetStatusOut]


class IngestHookPayload(BaseModel):
    # nginx-rtmp passes querystring/form fields; we accept both
    name: str | None = None  # stream key
    app: str | None = None
    addr: str | None = None
