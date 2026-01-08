# Architecture Diagram (ระบบปัจจุบัน)

```mermaid
flowchart TD
    U[User Browser]
    OBS[OBS / Publisher]

    subgraph DASH[Dashboard]
        N[Nginx (static + reverse proxy)]
        UI[React/TypeScript UI]
        N --> UI
    end

    subgraph API[API / Control Plane]
        F[FastAPI]
        PG[(PostgreSQL)]
        R[(Redis)]
        F --> PG
        F --> R
    end

    subgraph ING[Ingest]
        RTMP[Nginx-RTMP (RTMP + /stat + HLS)]
    end

    subgraph WRK[Worker / Data Plane]
        WK[Worker Process]
        FF[FFmpeg]
        WK --> FF
    end

    %% User flow
    U -->|HTTP :3000| N
    UI -->|same-origin /api/*| N
    N -->|proxy /api/* -> http://api:8000| F

    %% Auth
    UI -->|POST /api/auth/login (JWT)| F

    %% Ingest publish + hooks
    OBS -->|RTMP publish rtmp://localhost/live/<stream_key>| RTMP
    RTMP -->|POST /ingest/on_publish + /on_update + /on_publish_done| F

    %% Worker job flow
    F -->|XADD Redis Streams: restream:jobs| R
    WK -->|XREADGROUP restream:jobs| R
    WK -->|GET /stat (HTTP 8080)| RTMP
    FF -->|pull RTMP input rtmp://ingest/live/<stream_key>| RTMP
    FF -->|push RTMP/RTMPS to target platforms| T[(Targets: YouTube/Twitch/Facebook/Custom)]

    %% Preview
    UI -->|GET /stat + /hls/* (HTTP 8080)| RTMP
```

## Notes

- Dashboard ไม่เรียก API ตรง ๆ แล้ว: เรียกผ่าน `http://localhost:3000/api/*` (nginx proxy ไปที่ API)
- API ทำหน้าที่เป็น control plane: login (JWT), สร้าง stream/targets, validate stream key, enqueue jobs ให้ worker
- Ingest ใช้ nginx-rtmp:
    - รับ RTMP publish (`/live/<stream_key>`)
    - มี `/stat` (XML) ให้ worker/UI ตรวจสอบสถานะ
    - สร้าง HLS เพื่อ preview (`/hls/*`)
- Worker อ่าน jobs จาก Redis Streams แล้วรัน FFmpeg:
    - FFmpeg “ดึง” input จาก ingest และ “ส่งออก” ไปยัง target RTMP/RTMPS
