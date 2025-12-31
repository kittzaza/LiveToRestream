# Restream Platform (docker-compose)

This repo scaffolds a logical Restream architecture:
- **Ingest**: Nginx-RTMP (RTMP ingest + `/stat`)
- **Control plane**: FastAPI (stream key validation, sessions, targets)
- **Data plane**: FFmpeg worker (per-target restream processes)
- **Stores**: PostgreSQL + Redis

## Quick start

1) Start stack:

```bash
docker compose up --build
```

Dashboard UI (optional):
- Open `http://localhost:3000`

2) Create a stream (returns `stream_key`). You can optionally set a custom `stream_key` (English letters only: A-Z, a-z). If omitted, default is `admin` (or random if `admin` is already used):

```bash
curl -s -X POST http://localhost:8000/streams -H "content-type: application/json" -d '{"name":"demo"}'
```

Custom stream key example:

```bash
curl -s -X POST http://localhost:8000/streams -H "content-type: application/json" -d '{"name":"demo","stream_key":"demo"}'
```

3) Add a target (example: restream back into ingest under another app/key, for demo only):

```bash
curl -s -X POST http://localhost:8000/streams/{stream_id}/targets \
  -H "content-type: application/json" \
  -d '{"name":"demo-target","rtmp_url":"rtmp://ingest/out/echo"}'
```

4) Publish RTMP from OBS to ingest:
- Server: `rtmp://localhost/live`
- Stream key: `<stream_key>` (English letters only: A-Z, a-z)

Nginx will call:
- `POST /ingest/on_publish`
- `POST /ingest/on_publish_done`

and the API will enqueue worker jobs to start/stop FFmpeg per target.

## Notes
- This is a scaffold for the architecture; production hardening (JWT auth, RBAC, billing, GPU workers, K8s, metrics) can be layered on.
