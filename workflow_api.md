# Workflow & API (ระบบปัจจุบัน)

เอกสารนี้อธิบาย “flow การทำงานจริง” ของระบบ LivetoRestream โดยเน้น API, ingest hooks, และการคุยกับ worker ผ่าน Redis

> หมายเหตุ: Dashboard เรียก API ผ่าน nginx proxy path `/api/*` (same-origin) ไม่ต้องตั้งค่า API Base บน UI แล้ว

---

## ภาพรวมสถาปัตยกรรม

1) ผู้ใช้สร้าง Stream/Targets ผ่าน Dashboard หรือเรียก API
2) OBS publish ไปที่ ingest (nginx-rtmp)
3) ingest เรียก webhook เข้า API เพื่อ validate stream key + ทำ session + trigger งาน
4) API enqueue งานลง Redis stream `restream:jobs`
5) worker อ่าน job แล้ว run/stop FFmpeg ต่อ target
6) worker เขียนสถานะ per-target กลับเข้า Redis เพื่อให้ API/Dashboard แสดงผล

---

## Authentication (Login/Logout)

ระบบปัจจุบันใช้ “บัญชีเดียว” (admin) และ JWT (HS256)

### Endpoint

- `POST /auth/login`
	- Request: `{ "username": "admin", "password": "admin" }`
	- Response: `{ "access_token": "...", "token_type": "bearer" }`

- `POST /auth/logout`
	- Stateless (ฝั่ง client ล้าง token เอง)

### Header ที่ต้องส่งใน control-plane endpoints

- `Authorization: Bearer <access_token>`

### Legacy (optional)

API ยังรองรับ token แบบเก่า `API_AUTH_TOKEN` ถ้าตั้งค่าไว้ (แต่ใน docker-compose ล่าสุดตั้งเป็นค่าว่าง)

---

## กลุ่ม Endpoints (Control plane)

### Streams

- `POST /streams`
	- สร้าง stream และคืน `stream_key`
	- `stream_key` ต้องเป็น A–Z/a–z เท่านั้น
	- ถ้าไม่ส่ง key: ใช้ `admin` ถ้ายังว่าง ไม่งั้นสุ่ม key

- `GET /streams`
	- list streams (summary)

- `GET /streams/resolve?stream_key=...`
	- หา stream จาก key (dashboard ใช้ตอนปุ่ม Load)

- `GET /streams/{id}/status`
	- ดู ingest_state + last_publish_at + สถานะ targets (อ่านจาก Redis)

- `POST /streams/{id}/start`
	- เริ่ม restream ทุก target ที่ enabled
	- มี guard: จะ start ได้ก็ต่อเมื่อ ingest มี publisher จริง (อ่านจาก `/stat` หรือ heartbeat)

- `POST /streams/{id}/stop`
	- สั่งหยุด restream ทุก target (enqueue stop jobs) และ set `is_active=False`

- `POST /streams/{id}/restart`
	- stop+start (มี debounce เพื่อกัน spam)

- `POST /streams/{id}/reconnect`
	- forced reconnect (ส่ง start แบบ `force_restart=1`)

- `POST /streams/{id}/stream_key`
	- เปลี่ยน/สุ่ม stream key ใหม่ (rotate)
	- เมื่อ rotate: จะ enqueue stop jobs ทันที และ mark ingest state offline

- `DELETE /streams/{id}`
	- ลบ stream (รวมถึงลบ stream key ออกจากระบบ)
	- cascade ลบ targets/sessions
	- cleanup Redis แบบ best-effort

### Targets

- `POST /streams/{id}/targets`
	- เพิ่ม target `{ name, rtmp_url }`

- `GET /streams/{id}/targets`
	- list targets

- `PATCH /targets/{target_id}`
	- แก้ name/rtmp_url/enabled
	- ถ้า enabled=false → enqueue stop target ทันที

- `POST /targets/{target_id}/restart`
	- ถ้า ingest live → stop+start ทันที
	- ถ้า ingest offline → queue pending restart (จะถูก apply ตอน ingest live)

- `DELETE /targets/{target_id}`
	- ลบ target

### Sessions

- `GET /streams/{id}/sessions`
- `GET /sessions`

---

## Ingest Hooks (nginx-rtmp → API)

Ingest ใช้ nginx-rtmp และตั้งค่า callbacks:

- `POST /ingest/on_publish`
	- รับ params จาก nginx (query/form): `name`(stream key), `app`, `addr`
	- ถ้า key ไม่ถูกต้อง → API ตอบ non-2xx → nginx ปฏิเสธการ publish
	- ถ้าถูกต้อง:
		- สร้าง Session ใน DB
		- เขียน `restream:ingest:<stream_id>` ใน Redis (`state=live`, `last_publish_at=...`)
		- ถ้า stream.is_active: enqueue start jobs (หรือ apply pending restarts)

- `POST /ingest/on_update`
	- heartbeat ระหว่างกำลัง publish
	- update `last_publish_at`
	- apply pending restarts เฉพาะเมื่อ `/stat` รายงานว่ามี publisher จริง (กัน spoof)

- `POST /ingest/on_publish_done`
	- ปิด session ล่าสุด
	- set `state=offline`
	- ไม่ force-stop restreams ถ้า stream ยัง active (กัน OBS หลุดชั่วคราว)

---

## Redis: Job Queue + Runtime Status

### Job queue

- Stream name: `restream:jobs` (Redis Streams)
- Worker consumer group: `workers`

Job payload หลัก:
- `action`: `start` | `stop`
- `stream_id`, `target_id`
- `seq`: sequence กัน out-of-order
- `input_url`: `rtmp://ingest/live/<stream_key>`
- `output_url`: target rtmp/rtmps
- `force_restart` (optional)

### Status keys

- Ingest heartbeat:
	- `restream:ingest:<stream_id>`
		- `state`, `last_publish_at`, `last_publish_done_at`

- Target status (เขียนโดย worker):
	- `restream:target:<stream_id>:<target_id>`
		- `state`: `starting|running|stopping|stopped|exited`
		- `pid`, `exit_code`, `updated_at`, `worker`

### Pending restart

- `restream:pending_restart:<stream_id>:<target_id>`
	- ถ้า user กด restart ขณะ ingest offline
	- จะถูก consume ตอน ingest live

---

## Worker: FFmpeg behavior (สรุป)

1) อ่าน job จาก Redis
2) ถ้า start:
	 - รอให้ ingest มี stream key ใน `/stat` ก่อน (ลดกรณี FFmpeg เปิด input ไม่ทัน)
	 - สร้าง ffmpeg process per target
3) ถ้า stop:
	 - ส่ง SIGTERM แล้ว kill ถ้าจำเป็น
4) เขียนสถานะไป Redis

หมายเหตุ:
- Facebook output (url มี `facebook.com`) จะถูก transcode เป็น baseline เพื่อเสถียร
- กรณี `exit 251` ที่เป็น transient บางแบบ จะถูกถือเป็น “warming up” และคง state เป็น `starting` เพื่อไม่ให้ dashboard เตือนแรงเกินจริง

---

## Dashboard ↔ API ผ่าน /api (สำคัญ)

Dashboard ถูกเสิร์ฟโดย nginx และ proxy `location /api/` ไปที่ API container

ผลลัพธ์:
- frontend เรียก `fetch('/api/...')` ได้เลย
- ไม่ต้องแสดง API Base บน UI
- ลดปัญหา CORS

---

## ไฟล์ที่เกี่ยวข้อง (สำหรับ dev)

- API:
	- `services/api/app/main.py` (routes + core logic)
	- `services/api/app/schemas.py` (pydantic models)
	- `services/api/app/models.py` (SQLAlchemy models)
	- `services/api/app/settings.py` (env config)
- Ingest:
	- `services/ingest/nginx.conf` (rtmp app + hooks)
- Worker:
	- `services/worker/worker/main.py` (FFmpeg worker)
- Dashboard:
	- `services/dashboard/nginx.conf` (proxy /api)
	- `services/dashboard/src/api.ts` (API client)
	- `services/dashboard/src/App.tsx` (UI + flows)
