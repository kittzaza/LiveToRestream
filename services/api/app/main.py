from __future__ import annotations

import datetime as dt
import re
import secrets
import string
from contextlib import contextmanager
from urllib.parse import urlparse
from urllib.request import urlopen
import xml.etree.ElementTree as ET

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.crypto import StreamKeyCrypto, stream_key_hash
from app.db import Base, SessionLocal, engine
from app.models import Session as StreamSession
from app.models import Stream, Target
from app.redis_client import get_redis
from app.schemas import IngestHookPayload, SessionOut, SessionSummaryOut, StreamCreate, StreamOut, StreamResolveOut, StreamStatusOut, StreamSummaryOut, TargetCreate, TargetOut, TargetPatch, TargetStatusOut, TargetSummaryOut
from app.settings import settings

app = FastAPI(title="Restream Control Plane")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.dashboard_origin, "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"] ,
)


def _require_auth(request: Request) -> None:
    token = settings.api_auth_token
    if not token:
        return

    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        provided = auth.split(" ", 1)[1].strip()
    else:
        provided = (request.headers.get("x-api-token") or "").strip()

    if not secrets.compare_digest(provided, token):
        raise HTTPException(status_code=401, detail="unauthorized")


def _generate_stream_key_letters(length: int = 32) -> str:
    return "".join(secrets.choice(string.ascii_letters) for _ in range(length))


def _normalize_rtmp_url(value: str) -> str:
    url = re.sub(r"\s+", "", value or "")
    # Prefer RTMPS for YouTube; many networks block RTMP/1935.
    if url.startswith("rtmp://a.rtmp.youtube.com/live2/"):
        return url.replace("rtmp://a.rtmp.youtube.com/live2/", "rtmps://a.rtmps.youtube.com/live2/", 1)
    return url


def _validate_target_rtmp_url_or_422(rtmp_url: str) -> None:
    url = _normalize_rtmp_url(rtmp_url)
    if not url:
        raise HTTPException(status_code=422, detail="rtmp_url must not be empty")

    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    path = parsed.path or ""

    if scheme not in {"rtmp", "rtmps"}:
        raise HTTPException(status_code=422, detail="rtmp_url must start with rtmp:// or rtmps://")

    # YouTube: enforce a minimally sane URL so misconfigurations don't silently fail.
    if host in {"a.rtmp.youtube.com", "a.rtmps.youtube.com"}:
        m = re.match(r"^/live2/([^/?#]+)$", path)
        if not m:
            raise HTTPException(
                status_code=422,
                detail="YouTube URL must be like rtmps://a.rtmps.youtube.com/live2/<stream_key>",
            )
        stream_key = m.group(1)

        lower_key = stream_key.lower()
        if lower_key in {"streamyt", "defaultstreamkey"}:
            raise HTTPException(
                status_code=422,
                detail="YouTube stream key is a placeholder; paste the full key from YouTube Studio",
            )

        # Real YouTube stream keys are typically longer than short placeholders.
        if len(stream_key) < 16:
            raise HTTPException(
                status_code=422,
                detail="YouTube stream key looks too short; paste the full key from YouTube Studio",
            )


def _ingest_stat_url() -> str:
    # Derive http stat endpoint from rtmp://<host>/<app>
    parsed = urlparse(settings.ingest_rtmp_url)
    host = parsed.hostname or "ingest"
    return f"http://{host}:8080/stat"


def _ingest_app_name() -> str:
    parsed = urlparse(settings.ingest_rtmp_url)
    path = (parsed.path or "/").strip("/")
    # rtmp://ingest/live -> app name = live
    return path.split("/")[0] if path else "live"


def _ingest_has_publisher(stream_key: str) -> bool:
    # Query nginx-rtmp stat XML and check for a publishing client.
    # This is more reliable than Redis state because players (like worker) can connect even when no one is publishing.
    stat_url = _ingest_stat_url()
    app_name = _ingest_app_name()
    try:
        with urlopen(stat_url, timeout=2) as resp:
            data = resp.read()
        root = ET.fromstring(data)

        def _is_publishing(el: ET.Element | None) -> bool:
            if el is None:
                return False
            # nginx-rtmp may render <publishing/> (empty) or <publishing>1</publishing>
            txt = (el.text or "").strip().lower()
            return txt in {"", "1", "true", "yes"}

        for app in root.findall(".//application"):
            name_el = app.find("name")
            if name_el is None or (name_el.text or "").strip() != app_name:
                continue
            for stream in app.findall(".//live/stream"):
                sname = (stream.findtext("name") or "").strip()
                if sname != stream_key:
                    continue
                # Some nginx-rtmp builds include <publishing/> at the stream level.
                if _is_publishing(stream.find("publishing")):
                    return True

                for client in stream.findall("client"):
                    if _is_publishing(client.find("publishing")):
                        return True
                return False
        return False
    except Exception:
        return False


def _is_recent_publish(last_publish_at: str | None, grace_seconds: int = 15) -> bool:
    if not last_publish_at:
        return False
    try:
        iso = str(last_publish_at).strip()
        # Be tolerant of Zulu suffix.
        if iso.endswith("Z"):
            iso = iso[:-1] + "+00:00"
        ts = dt.datetime.fromisoformat(iso)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=dt.timezone.utc)
        now = dt.datetime.now(dt.timezone.utc)
        return (now - ts).total_seconds() <= grace_seconds
    except Exception:
        return False


def _rate_limit(request: Request, bucket: str) -> None:
    """Very small Redis-backed fixed-window rate limit.

    Applies only to dashboard/control endpoints (not ingest webhooks).
    """
    _require_auth(request)
    r = get_redis()
    client_ip = request.client.host if request.client else "unknown"
    window = settings.api_rate_limit_window_seconds
    key = f"restream:ratelimit:{bucket}:{client_ip}:{int(dt.datetime.now(dt.timezone.utc).timestamp()) // window}"
    current = r.incr(key)
    if current == 1:
        r.expire(key, window)
    if current > settings.api_rate_limit_per_window:
        raise HTTPException(status_code=429, detail="rate limit exceeded")


@contextmanager
def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_db():
    with db_session() as db:
        yield db


@app.on_event("startup")
def _startup() -> None:
    Base.metadata.create_all(bind=engine)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/streams", response_model=StreamOut)
def create_stream(payload: StreamCreate, request: Request, db: Session = Depends(get_db)) -> StreamOut:
    _rate_limit(request, "streams:create")
    crypto = StreamKeyCrypto(settings.stream_key_secret)

    # Stream key rules:
    # - If user provided a custom key, use it (letters only) and reject duplicates.
    # - Otherwise use default 'admin'. If taken, fall back to a random letters-only key.
    if payload.stream_key:
        if _find_stream_by_key(db, payload.stream_key) is not None:
            raise HTTPException(status_code=409, detail="stream_key already in use")
        raw_key = payload.stream_key
    else:
        default_key = "admin"
        if _find_stream_by_key(db, default_key) is None:
            raw_key = default_key
        else:
            raw_key = None
            for _ in range(10):
                candidate = _generate_stream_key_letters(32)
                if _find_stream_by_key(db, candidate) is None:
                    raw_key = candidate
                    break
            if raw_key is None:
                raise HTTPException(status_code=500, detail="failed to generate stream key")

    cipher = crypto.encrypt(raw_key)
    key_hash = stream_key_hash(raw_key)

    stream = Stream(name=payload.name, stream_key_ciphertext=cipher, stream_key_hash=key_hash)
    db.add(stream)
    db.commit()
    db.refresh(stream)

    return StreamOut(id=stream.id, name=stream.name, stream_key=raw_key)


@app.get("/streams", response_model=list[StreamSummaryOut])
def list_streams(
    request: Request,
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> list[StreamSummaryOut]:
    _rate_limit(request, "streams:list")
    stmt = select(Stream).order_by(Stream.created_at.desc()).limit(limit).offset(offset)
    streams = db.execute(stmt).scalars().all()

    r = get_redis()
    pipe = r.pipeline(transaction=False)
    for s in streams:
        ingest_key = f"restream:ingest:{s.id}"
        pipe.hget(ingest_key, "state")
        pipe.hget(ingest_key, "last_publish_at")
    raw = pipe.execute() if streams else []

    out: list[StreamSummaryOut] = []
    for idx, s in enumerate(streams):
        state = raw[idx * 2] if raw else None
        last_publish_at = raw[idx * 2 + 1] if raw else None
        out.append(
            StreamSummaryOut(
                id=s.id,
                name=s.name,
                is_active=s.is_active,
                created_at=s.created_at,
                ingest_state=state or "offline",
                last_publish_at=last_publish_at,
            )
        )
    return out


@app.get("/streams/resolve", response_model=StreamResolveOut)
def resolve_stream_by_key(
    request: Request,
    stream_key: str = Query(min_length=1, max_length=64, pattern=r"^[A-Za-z]+$"),
    db: Session = Depends(get_db),
) -> StreamResolveOut:
    _rate_limit(request, "streams:resolve")
    stream = _find_stream_by_key(db, stream_key)
    if stream is None:
        raise HTTPException(status_code=404, detail="stream not found")
    return StreamResolveOut(id=stream.id, name=stream.name, is_active=stream.is_active, created_at=stream.created_at)


@app.post("/streams/{stream_id}/targets", response_model=TargetOut)
def add_target(stream_id: int, payload: TargetCreate, request: Request, db: Session = Depends(get_db)) -> TargetOut:
    _rate_limit(request, "targets:add")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")

    name = payload.name.strip()
    rtmp_url = re.sub(r"\s+", "", payload.rtmp_url)
    if not name:
        raise HTTPException(status_code=422, detail="name must not be empty")
    _validate_target_rtmp_url_or_422(rtmp_url)

    target = Target(stream_id=stream_id, name=name, rtmp_url=rtmp_url, enabled=True)
    db.add(target)
    db.commit()
    db.refresh(target)

    return TargetOut(id=target.id, name=target.name, rtmp_url=target.rtmp_url, enabled=target.enabled)


@app.get("/streams/{stream_id}/targets", response_model=list[TargetOut])
def list_targets(stream_id: int, request: Request, db: Session = Depends(get_db)) -> list[TargetOut]:
    _rate_limit(request, "targets:list")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")
    db.refresh(stream)
    return [TargetOut(id=t.id, name=t.name, rtmp_url=_normalize_rtmp_url(t.rtmp_url), enabled=t.enabled) for t in stream.targets]


@app.patch("/targets/{target_id}", response_model=TargetOut)
def patch_target(target_id: int, payload: TargetPatch, request: Request, db: Session = Depends(get_db)) -> TargetOut:
    _rate_limit(request, "targets:patch")
    target = db.get(Target, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="target not found")

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="name must not be empty")
        target.name = name
    if payload.rtmp_url is not None:
        rtmp_url = re.sub(r"\s+", "", payload.rtmp_url)
        _validate_target_rtmp_url_or_422(rtmp_url)
        target.rtmp_url = rtmp_url

    if payload.enabled is not None:
        target.enabled = payload.enabled
        # If disabling, stop the restream process immediately
        if payload.enabled is False:
            _enqueue_stop_target(target.stream_id, target.id, force=True, source="target:patch_disable")

    db.add(target)
    db.commit()
    db.refresh(target)
    return TargetOut(id=target.id, name=target.name, rtmp_url=_normalize_rtmp_url(target.rtmp_url), enabled=target.enabled)


@app.post("/targets/{target_id}/enable", response_model=TargetOut)
def enable_target(target_id: int, request: Request, db: Session = Depends(get_db)) -> TargetOut:
    _rate_limit(request, "targets:enable")
    target = db.get(Target, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="target not found")

    _validate_target_rtmp_url_or_422(target.rtmp_url)
    target.enabled = True
    db.add(target)
    db.commit()
    db.refresh(target)

    stream = db.get(Stream, target.stream_id)
    if stream and stream.is_active:
        stream_key = stream_key_from_stream(stream)
        r = get_redis()
        ingest_key = f"restream:ingest:{stream.id}"
        last_publish_at = r.hget(ingest_key, "last_publish_at")
        if _ingest_has_publisher(stream_key) or _is_recent_publish(last_publish_at):
            _enqueue_start_target(stream, target, source="target:enable")

    return TargetOut(id=target.id, name=target.name, rtmp_url=_normalize_rtmp_url(target.rtmp_url), enabled=target.enabled)


@app.post("/targets/{target_id}/disable", response_model=TargetOut)
def disable_target(target_id: int, request: Request, db: Session = Depends(get_db)) -> TargetOut:
    _rate_limit(request, "targets:disable")
    target = db.get(Target, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="target not found")

    target.enabled = False
    db.add(target)
    db.commit()
    db.refresh(target)

    # Stop only this target (best-effort).
    _enqueue_stop_target(target.stream_id, target.id, force=True, source="target:disable")

    return TargetOut(id=target.id, name=target.name, rtmp_url=_normalize_rtmp_url(target.rtmp_url), enabled=target.enabled)


@app.post("/targets/{target_id}/restart")
def restart_target(target_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    _rate_limit(request, "targets:restart")
    target = db.get(Target, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="target not found")

    stream = db.get(Stream, target.stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")
    if not stream.is_active:
        raise HTTPException(status_code=409, detail="stream is stopped")
    if not target.enabled:
        raise HTTPException(status_code=409, detail="target is disabled")

    stream_key = stream_key_from_stream(stream)
    r = get_redis()
    ingest_key = f"restream:ingest:{stream.id}"
    last_publish_at = r.hget(ingest_key, "last_publish_at")
    is_publishing = _ingest_has_publisher(stream_key) or _is_recent_publish(last_publish_at)

    _validate_target_rtmp_url_or_422(target.rtmp_url)

    # Always attempt to stop the target now (no-op if not running).
    _enqueue_stop_target(stream.id, target.id, force=True, source="target:restart")

    if is_publishing:
        # Restart immediately.
        _enqueue_start_target(
            stream,
            target,
            force=True,
            source="target:restart",
            extra_fields={"force_restart": "1"},
        )
        return {"ok": True, "queued": False}

    # If ingest is not publishing, queue a restart that will be applied on the next publish.
    pending_key = f"restream:pending_restart:{stream.id}:{target.id}"
    r.set(pending_key, "1", ex=3600)
    return {"ok": True, "queued": True}


@app.delete("/targets/{target_id}")
def delete_target(target_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    _rate_limit(request, "targets:delete")
    target = db.get(Target, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="target not found")
    db.delete(target)
    db.commit()
    return {"ok": True}


@app.get("/targets", response_model=list[TargetSummaryOut])
def list_all_targets(
    request: Request,
    db: Session = Depends(get_db),
    stream_id: int | None = Query(None, ge=1),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[TargetSummaryOut]:
    _rate_limit(request, "targets:list_all")
    stmt = select(Target)
    if stream_id is not None:
        stmt = stmt.where(Target.stream_id == stream_id)
    stmt = stmt.order_by(Target.created_at.desc()).limit(limit).offset(offset)
    targets = db.execute(stmt).scalars().all()
    return [
        TargetSummaryOut(
            id=t.id,
            stream_id=t.stream_id,
            name=t.name,
            rtmp_url=_normalize_rtmp_url(t.rtmp_url),
            enabled=t.enabled,
            created_at=t.created_at,
        )
        for t in targets
    ]


@app.get("/sessions", response_model=list[SessionSummaryOut])
def list_all_sessions(
    request: Request,
    db: Session = Depends(get_db),
    stream_id: int | None = Query(None, ge=1),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[SessionSummaryOut]:
    _rate_limit(request, "sessions:list_all")
    stmt = select(StreamSession)
    if stream_id is not None:
        stmt = stmt.where(StreamSession.stream_id == stream_id)
    stmt = stmt.order_by(StreamSession.started_at.desc()).limit(limit).offset(offset)
    sessions = db.execute(stmt).scalars().all()
    return [
        SessionSummaryOut(
            id=s.id,
            stream_id=s.stream_id,
            started_at=s.started_at,
            ended_at=s.ended_at,
            ingest_addr=s.ingest_addr,
            ingest_app=s.ingest_app,
            ingest_name=s.ingest_name,
        )
        for s in sessions
    ]


def _find_stream_by_key(db: Session, stream_key: str) -> Stream | None:
    key_hash = stream_key_hash(stream_key)
    stmt = select(Stream).where(Stream.stream_key_hash == key_hash)
    return db.execute(stmt).scalar_one_or_none()


def _enqueue_start_jobs(
    stream: Stream,
    *,
    force: bool = False,
    source: str = "unknown",
    extra_fields: dict[str, str] | None = None,
) -> None:
    r = get_redis()
    input_url = f"{settings.ingest_rtmp_url}/{stream_key_from_stream(stream)}"

    for t in stream.targets:
        if not t.enabled:
            continue
        seq = r.incr(f"restream:seq:{stream.id}:{t.id}")
        # Small de-dup lock to avoid spamming identical starts.
        # For explicit restarts, bypass the lock to guarantee stop->start ordering.
        if not force:
            lock_key = f"restream:locks:start:{stream.id}:{t.id}"
            if not r.set(lock_key, "1", nx=True, ex=10):
                continue
        payload: dict[str, str] = {
            "action": "start",
            "stream_id": str(stream.id),
            "target_id": str(t.id),
            "seq": str(seq),
            "input_url": input_url,
            "output_url": _normalize_rtmp_url(t.rtmp_url),
            "source": source,
        }
        if extra_fields:
            payload.update({k: str(v) for k, v in extra_fields.items()})
        r.xadd("restream:jobs", payload)


def _debounce_action(stream_id: int, action: str, *, ttl_seconds: int) -> bool:
    """Return True if this action should be debounced (triggered too recently)."""
    r = get_redis()
    key = f"restream:locks:{action}:{stream_id}"
    return not bool(r.set(key, "1", nx=True, ex=ttl_seconds))


def _enqueue_stop_jobs(stream: Stream, *, force: bool = False, source: str = "unknown") -> None:
    r = get_redis()
    for t in stream.targets:
        seq = r.incr(f"restream:seq:{stream.id}:{t.id}")
        if not force:
            lock_key = f"restream:locks:stop:{stream.id}:{t.id}"
            if not r.set(lock_key, "1", nx=True, ex=10):
                continue
        r.xadd(
            "restream:jobs",
            {"action": "stop", "stream_id": str(stream.id), "target_id": str(t.id), "seq": str(seq), "source": source},
        )


def _enqueue_start_target(
    stream: Stream,
    target: Target,
    *,
    force: bool = False,
    source: str = "unknown",
    extra_fields: dict[str, str] | None = None,
) -> None:
    r = get_redis()
    input_url = f"{settings.ingest_rtmp_url}/{stream_key_from_stream(stream)}"
    seq = r.incr(f"restream:seq:{stream.id}:{target.id}")
    if not force:
        lock_key = f"restream:locks:start:{stream.id}:{target.id}"
        if not r.set(lock_key, "1", nx=True, ex=10):
            return

    payload: dict[str, str] = {
        "action": "start",
        "stream_id": str(stream.id),
        "target_id": str(target.id),
        "seq": str(seq),
        "input_url": input_url,
        "output_url": _normalize_rtmp_url(target.rtmp_url),
        "source": source,
    }
    if extra_fields:
        payload.update({k: str(v) for k, v in extra_fields.items()})
    r.xadd("restream:jobs", payload)


def _enqueue_stop_target(stream_id: int, target_id: int, *, force: bool = False, source: str = "unknown") -> None:
    r = get_redis()
    seq = r.incr(f"restream:seq:{stream_id}:{target_id}")
    if not force:
        lock_key = f"restream:locks:stop:{stream_id}:{target_id}"
        if not r.set(lock_key, "1", nx=True, ex=10):
            return
    r.xadd(
        "restream:jobs",
        {"action": "stop", "stream_id": str(stream_id), "target_id": str(target_id), "seq": str(seq), "source": source},
    )


def stream_key_from_stream(stream: Stream) -> str:
    crypto = StreamKeyCrypto(settings.stream_key_secret)
    return crypto.decrypt(stream.stream_key_ciphertext)


@app.post("/streams/{stream_id}/start")
def start_stream(stream_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    _rate_limit(request, "streams:start")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")

    # Guard: only start restream workers when a publisher is actually live on ingest.
    # If /stat is temporarily unavailable, fall back to the ingest heartbeat written by on_update.
    stream_key = stream_key_from_stream(stream)
    r = get_redis()
    ingest_key = f"restream:ingest:{stream.id}"
    last_publish_at = r.hget(ingest_key, "last_publish_at")
    if not (_ingest_has_publisher(stream_key) or _is_recent_publish(last_publish_at)):
        raise HTTPException(status_code=409, detail="ingest is not publishing; start OBS first")

    # Validate enabled targets up-front so users get actionable errors (e.g., YouTube key too short).
    db.refresh(stream)
    for t in stream.targets:
        if t.enabled:
            _validate_target_rtmp_url_or_422(t.rtmp_url)

    stream.is_active = True
    db.add(stream)
    db.commit()
    db.refresh(stream)
    _enqueue_start_jobs(stream, source="start")
    return {"ok": True}


@app.post("/streams/{stream_id}/stop")
def stop_stream(stream_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    _rate_limit(request, "streams:stop")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")
    stream.is_active = False
    db.add(stream)
    db.commit()
    db.refresh(stream)
    _enqueue_stop_jobs(stream, force=True, source="stop")
    return {"ok": True}


@app.post("/streams/{stream_id}/restart")
def restart_stream(stream_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    _rate_limit(request, "streams:restart")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")

    stream_key = stream_key_from_stream(stream)
    r = get_redis()
    ingest_key = f"restream:ingest:{stream.id}"
    last_publish_at = r.hget(ingest_key, "last_publish_at")
    if not (_ingest_has_publisher(stream_key) or _is_recent_publish(last_publish_at)):
        raise HTTPException(status_code=409, detail="ingest is not publishing; start OBS first")

    db.refresh(stream)
    for t in stream.targets:
        if t.enabled:
            _validate_target_rtmp_url_or_422(t.rtmp_url)

    # Protect against repeated /restart calls (e.g., user spam-click, external script, UI bug).
    # Stop/start flapping prevents platforms like YouTube from ever seeing a stable upstream.
    # First call in the window does a full stop+start; subsequent calls do a forced reconnect
    # (restart FFmpeg) without issuing stop jobs.
    debounced = _debounce_action(stream_id, "restart", ttl_seconds=120)

    stream.is_active = True
    db.add(stream)
    db.commit()
    db.refresh(stream)

    if debounced:
        _enqueue_start_jobs(
            stream,
            force=True,
            source="reconnect",
            extra_fields={"force_restart": "1"},
        )
        return {"ok": True, "debounced": True}

    _enqueue_stop_jobs(stream, force=True, source="restart")
    _enqueue_start_jobs(stream, force=True, source="restart", extra_fields={"force_restart": "1"})
    return {"ok": True, "debounced": False}


@app.post("/streams/{stream_id}/reconnect")
def reconnect_stream(stream_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    _rate_limit(request, "streams:restart")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")

    stream_key = stream_key_from_stream(stream)
    r = get_redis()
    ingest_key = f"restream:ingest:{stream.id}"
    last_publish_at = r.hget(ingest_key, "last_publish_at")
    if not (_ingest_has_publisher(stream_key) or _is_recent_publish(last_publish_at)):
        raise HTTPException(status_code=409, detail="ingest is not publishing; start OBS first")

    db.refresh(stream)
    for t in stream.targets:
        if t.enabled:
            _validate_target_rtmp_url_or_422(t.rtmp_url)

    stream.is_active = True
    db.add(stream)
    db.commit()
    db.refresh(stream)

    _enqueue_start_jobs(stream, force=True, source="reconnect", extra_fields={"force_restart": "1"})
    return {"ok": True}


@app.get("/streams/{stream_id}/sessions", response_model=list[SessionOut])
def list_sessions(stream_id: int, request: Request, db: Session = Depends(get_db)) -> list[SessionOut]:
    _rate_limit(request, "sessions:list")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")
    stmt = select(StreamSession).where(StreamSession.stream_id == stream_id).order_by(StreamSession.started_at.desc())
    sessions = db.execute(stmt).scalars().all()
    return [SessionOut(id=s.id, stream_id=s.stream_id, started_at=s.started_at, ended_at=s.ended_at) for s in sessions]


@app.get("/streams/{stream_id}/status", response_model=StreamStatusOut)
def stream_status(stream_id: int, request: Request, db: Session = Depends(get_db)) -> StreamStatusOut:
    _rate_limit(request, "status:get")
    stream = db.get(Stream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="stream not found")

    r = get_redis()
    ingest_key = f"restream:ingest:{stream_id}"
    last_publish_at = r.hget(ingest_key, "last_publish_at")

    stream_key = stream_key_from_stream(stream)
    ingest_state = "live" if (_ingest_has_publisher(stream_key) or _is_recent_publish(last_publish_at)) else "offline"

    # Per-target status written by worker
    target_statuses: list[TargetStatusOut] = []
    db.refresh(stream)
    for t in stream.targets:
        st_key = f"restream:target:{stream_id}:{t.id}"
        state = r.hget(st_key, "state") or "unknown"
        pid_raw = r.hget(st_key, "pid")
        exit_code_raw = r.hget(st_key, "exit_code")
        updated_at = r.hget(st_key, "updated_at")
        target_statuses.append(
            TargetStatusOut(
                target_id=t.id,
                state=state,
                pid=int(pid_raw) if pid_raw and pid_raw.isdigit() else None,
                exit_code=int(exit_code_raw) if exit_code_raw and exit_code_raw.lstrip("-").isdigit() else None,
                updated_at=updated_at,
            )
        )

    return StreamStatusOut(stream_id=stream_id, ingest_state=ingest_state, last_publish_at=last_publish_at, targets=target_statuses)


@app.post("/ingest/on_publish")
async def ingest_on_publish(request: Request, db: Session = Depends(get_db)):
    # nginx-rtmp typically sends as querystring; FastAPI merges query/form via request
    params = dict(request.query_params)
    if request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
        form = await request.form()
        params.update({k: str(v) for k, v in form.items()})

    payload = IngestHookPayload(**params)
    stream_key = payload.name
    if not stream_key:
        raise HTTPException(status_code=400, detail="missing stream key")

    stream = _find_stream_by_key(db, stream_key)
    if not stream:
        # Non-2xx response rejects publish
        raise HTTPException(status_code=403, detail="invalid stream key")

    # Create a session
    session = StreamSession(
        stream_id=stream.id,
        ingest_addr=payload.addr,
        ingest_app=payload.app,
        ingest_name=payload.name,
    )
    db.add(session)
    db.commit()

    # Persist runtime ingest status
    r = get_redis()
    r.hset(
        f"restream:ingest:{stream.id}",
        mapping={
            "state": "live",
            "last_publish_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        },
    )

    # Enqueue worker jobs only when restream is enabled for this stream.
    if stream.is_active:
        db.refresh(stream)

        # If user queued per-target restarts while ingest was offline, apply them now.
        r = get_redis()
        any_pending = False
        for t in stream.targets:
            pending_key = f"restream:pending_restart:{stream.id}:{t.id}"
            if r.exists(pending_key):
                any_pending = True
                r.delete(pending_key)
                if t.enabled:
                    _enqueue_stop_target(stream.id, t.id, force=True, source="pending_restart")
                    _enqueue_start_target(
                        stream,
                        t,
                        force=True,
                        source="pending_restart",
                        extra_fields={"force_restart": "1"},
                    )

        # If nothing was pending, default behavior: start all enabled targets.
        if not any_pending:
            _enqueue_start_jobs(stream, source="ingest_on_publish")

    return PlainTextResponse("ok", status_code=200)


@app.post("/ingest/on_publish_done")
async def ingest_on_publish_done(request: Request, db: Session = Depends(get_db)):
    params = dict(request.query_params)
    if request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
        form = await request.form()
        params.update({k: str(v) for k, v in form.items()})

    payload = IngestHookPayload(**params)
    stream_key = payload.name
    if not stream_key:
        return PlainTextResponse("ok", status_code=200)

    stream = _find_stream_by_key(db, stream_key)
    if not stream:
        return PlainTextResponse("ok", status_code=200)

    # Mark latest open session ended
    stmt = (
        select(StreamSession)
        .where(StreamSession.stream_id == stream.id)
        .where(StreamSession.ended_at.is_(None))
        .order_by(StreamSession.started_at.desc())
        .limit(1)
    )
    session = db.execute(stmt).scalar_one_or_none()
    if session:
        import datetime as dt

        session.ended_at = dt.datetime.now(dt.timezone.utc)
        db.add(session)
        db.commit()

    # Do not force-stop restreams here when the stream is still marked active.
    # OBS/RTMP publishers may briefly disconnect/reconnect; enqueueing stop jobs can race
    # with subsequent starts and leave targets offline.
    # If the user wants restreams stopped, they should call /streams/{id}/stop.
    if not stream.is_active:
        _enqueue_stop_jobs(stream, force=True, source="ingest_on_publish_done")

    r = get_redis()
    r.hset(
        f"restream:ingest:{stream.id}",
        mapping={
            "state": "offline",
            "last_publish_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        },
    )
    return PlainTextResponse("ok", status_code=200)


@app.post("/ingest/on_update")
async def ingest_on_update(request: Request, db: Session = Depends(get_db)):
    # Periodic heartbeat from nginx-rtmp while publishing.
    params = dict(request.query_params)
    if request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
        form = await request.form()
        params.update({k: str(v) for k, v in form.items()})

    payload = IngestHookPayload(**params)
    stream_key = payload.name
    if not stream_key:
        return PlainTextResponse("ok", status_code=200)

    stream = _find_stream_by_key(db, stream_key)
    if not stream:
        return PlainTextResponse("ok", status_code=200)

    r = get_redis()
    r.hset(
        f"restream:ingest:{stream.id}",
        mapping={
            "state": "live",
            "last_publish_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        },
    )

    # If on_publish was missed or delayed, on_update can still arrive while publishing.
    # Apply any queued per-target restarts here too, but only when nginx reports an
    # active publisher for this stream key (prevents spoofed webhook calls from
    # triggering restarts while offline).
    if stream.is_active:
        db.refresh(stream)

        pending_targets: list[Target] = []
        for t in stream.targets:
            pending_key = f"restream:pending_restart:{stream.id}:{t.id}"
            if r.exists(pending_key):
                pending_targets.append(t)

        if pending_targets and _ingest_has_publisher(stream_key):
            for t in pending_targets:
                pending_key = f"restream:pending_restart:{stream.id}:{t.id}"
                r.delete(pending_key)
                if t.enabled:
                    _enqueue_stop_target(stream.id, t.id, force=True, source="pending_restart")
                    _enqueue_start_target(
                        stream,
                        t,
                        force=True,
                        source="pending_restart",
                        extra_fields={"force_restart": "1"},
                    )
    return PlainTextResponse("ok", status_code=200)
