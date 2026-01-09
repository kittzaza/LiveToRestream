# LivetoRestream (docker-compose)

This repository runs a small Restream platform locally using Docker Compose.

At a high level:

- **Ingest (data-in)**: Nginx-RTMP accepts RTMP publishes and exposes a `/stat` XML endpoint.
- **Control plane (API)**: FastAPI validates stream keys, stores streams/targets/sessions, and queues jobs for the worker.
- **Data plane (worker)**: FFmpeg processes pull from ingest and push to each target RTMP endpoint.
- **Stores**: PostgreSQL (persistent config + sessions) and Redis (jobs + runtime status).

---


## Services & Ports

Local ports exposed by docker-compose:

- **Dashboard**: <http://localhost:3000>
- **API (direct)**: <http://localhost:8000>
- **Ingest RTMP**: rtmp://localhost:1935
- **Ingest HTTP** (`/stat`, `/hls`, `/healthz`): <http://localhost:8080>
- **Postgres**: localhost:5432
- **Redis**: localhost:6379

Important: the dashboard calls the API through an **nginx reverse-proxy path**:

- Dashboard → **`/api/*`** → API container (no API Base URL shown in UI).

---

## Quick Start

1. Build and start the stack:

```bash
docker compose up --build
```

1. Open the dashboard:

- <http://localhost:3000>

1. Login (dev default):

- Username: `admin`
- Password: `admin`

Tokens intentionally **do not expire** in dev.

If the dashboard gets a `401`, it auto-opens Settings and prompts you to log in again.

---

## Typical Workflow (Dashboard)

1) Create a stream (gets you a **stream key**).
2) Start publishing from OBS to ingest using that stream key.
3) Add one or more restream targets.
4) Click **Start Restreams**.

---

## OBS (Publishing to Ingest)

OBS publishes into the ingest service (Nginx-RTMP) under application `live`.

OBS settings:

- Server: `rtmp://localhost/live`
- Stream Key: `<your_stream_key>`

Notes:

- Stream keys are restricted to English letters only (A–Z, a–z).
- The ingest server will reject publishing if the stream key is unknown.

---

## Restream Targets

Targets are RTMP/RTMPS destinations the worker pushes to.

Supported target types in the dashboard UI:

- YouTube: `rtmps://a.rtmps.youtube.com/live2/<key>`
- Twitch: `rtmp://live.twitch.tv/app/<key>`
- Facebook: `rtmps://live-api-s.facebook.com:443/rtmp/<key>`
- Custom RTMP:
  - You can paste a full `rtmp(s)://...` URL, or use base + stream key to build the final URL.

Worker behavior note:

- If the output URL contains `facebook.com`, the worker transcodes to a Facebook-friendly baseline.
- Otherwise it uses stream-copy (`-c:v copy -c:a copy`).

---

## API Authentication (Login/Logout)

Dashboard authentication is handled by the API.

Endpoints:

- `POST /auth/login` → returns `{ access_token, token_type }`
- `POST /auth/logout` → stateless; the dashboard just discards the token

The dashboard sends:

- `Authorization: Bearer <access_token>`

Dev defaults (docker-compose):

- Username: `admin`
- Password: `admin`

---

## API Reference (Common Operations)

The dashboard uses these; you can call them via curl as well.

Tip: because the API is protected, include the Authorization header.

### 1) Login

```bash
curl -s http://localhost:8000/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"admin"}'
```

Export the token (bash example):

```bash
TOKEN="<paste access_token>"
```

### 2) Create a stream

Create with auto/default key:

```bash
curl -s http://localhost:8000/streams \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"name":"demo"}'
```

Create with a custom key:

```bash
curl -s http://localhost:8000/streams \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"name":"demo","stream_key":"DemoKey"}'
```

### 3) Add a target

```bash
curl -s http://localhost:8000/streams/<stream_id>/targets \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"name":"YouTube","rtmp_url":"rtmps://a.rtmps.youtube.com/live2/<yt_key>"}'
```

### 4) Start / Stop restreams

```bash
curl -s -X POST http://localhost:8000/streams/<stream_id>/start -H "authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:8000/streams/<stream_id>/stop  -H "authorization: Bearer $TOKEN"
```

### 5) Rotate (change) a stream key

Set an explicit new key:

```bash
curl -s -X POST http://localhost:8000/streams/<stream_id>/stream_key \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"stream_key":"NewKey"}'
```

Generate a random new key:

```bash
curl -s -X POST http://localhost:8000/streams/<stream_id>/stream_key \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{}'
```

Important:

- Rotating a key stops restream jobs immediately.
- OBS must reconnect using the new key.

### 6) Delete a stream (removes the stream key)

```bash
curl -s -X DELETE http://localhost:8000/streams/<stream_id> -H "authorization: Bearer $TOKEN"
```

Deleting the stream removes its key from the system and cascades targets/sessions.

---

## Ingest Webhooks (How publishing is validated)

When OBS publishes to ingest (`application live`), Nginx-RTMP calls the API:

- `POST /ingest/on_publish` (validate stream key, open a session, start targets)
- `POST /ingest/on_update` (heartbeat while publishing)
- `POST /ingest/on_publish_done` (close session)

These are internal hooks used by ingest; they are not meant to be called manually.

---

## Monitoring & Debugging

### Ingest status XML

Check what streams are currently publishing:

- <http://localhost:8080/stat>

You should see a section like:

```xml
<application>
  <name>live</name>
  <live>
    <stream>
      <name>YOUR_STREAM_KEY</name>
      ...
      <publishing/>
    </stream>
  </live>
</application>
```

If the key in `/stat` does not match the stream key you think you’re using, the worker won’t be able to pull the ingest input.

### Worker “input not ready” / FFmpeg startup

It’s normal for FFmpeg to need a short warm-up window during RTMP startup.
The worker retries automatically and will keep the target in `starting` rather than spamming `exited` for common transient failures.

### Common issues

1. **Dashboard Load doesn’t resolve stream key**

Ensure you are logged in and the API container is healthy.

1. **Publish rejected by ingest**

Create the stream first (unknown keys are rejected). Only A–Z/a–z are allowed.

1. **Worker can’t pull ingest**

`/stat` must show the stream key under application `live`. Verify OBS is publishing to `rtmp://localhost/live`.

---

## Configuration (docker-compose)

Key env vars used in docker-compose:

- API:
  - `ADMIN_USERNAME`, `ADMIN_PASSWORD` (dev login)
  - `JWT_SECRET`
  - `STREAM_KEY_SECRET` (encryption key for storing stream keys)
  - `INGEST_RTMP_URL` (typically `rtmp://ingest/live`)
- Worker:
  - `INGEST_RTMP_URL`, `INGEST_STAT_URL`

---

## Production Notes (high level)

This is a dev-friendly setup. For production you would typically add:

- Expiring tokens + refresh strategy
- Proper password hashing + multiple users/roles
- Strong secrets management
- Metrics/log aggregation
- Horizontal scaling and orchestration (e.g., Kubernetes)
