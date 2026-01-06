from __future__ import annotations

import datetime as dt
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass

import redis

from worker.settings import settings


@dataclass
class ProcHandle:
    popen: subprocess.Popen
    stream_id: str
    target_id: str


def _redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


def build_ffmpeg_cmd(input_url: str, output_url: str) -> list[str]:
    # Minimal restream. For some platforms (notably Facebook) transcoding to a strict baseline
    # profile is more reliable than stream-copy.
    is_facebook = "facebook.com" in (output_url or "")

    output_effective = output_url

    base = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "info",
        # Ensure we get periodic progress lines in container logs even without a TTY.
        "-stats",
        "-stats_period",
        "2",
        # If network IO stalls (ingest hiccup, upstream drop), fail fast so the worker can retry.
        "-rw_timeout",
        str(settings.ffmpeg_rw_timeout_us),
        # RTMP live pulls can connect mid-stream; give FFmpeg time to see the video headers/keyframe
        # so it doesn't treat the input as audio-only.
        "-analyzeduration",
        "5M",
        "-probesize",
        "5M",
        "-i",
        input_url,
    ]

    if is_facebook:
        base += [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "baseline",
            "-g",
            "60",
            "-keyint_min",
            "60",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "44100",
        ]
    else:
        base += [
            "-c:v",
            "copy",
            "-c:a",
            "copy",
        ]

    base += [
        # Apply the same IO timeout to the output connection.
        "-rw_timeout",
        str(settings.ffmpeg_rw_timeout_us),
        "-f",
        "flv",
        output_effective,
    ]

    return base


def _extract_ingest_stream_key(input_url: str) -> str | None:
    prefix = (settings.ingest_rtmp_url or "").rstrip("/") + "/"
    if input_url.startswith(prefix):
        stream_key = input_url[len(prefix) :].strip("/")
        return stream_key or None
    return None


def _ingest_has_stream(stream_key: str) -> bool:
    try:
        with urllib.request.urlopen(settings.ingest_stat_url, timeout=2) as resp:
            xml = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, ValueError):
        return False

    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return False

    # Look for /rtmp/server/application[name='live']/live/stream/name == stream_key
    for app in root.findall("./server/application"):
        name_el = app.find("name")
        if name_el is None or (name_el.text or "").strip() != "live":
            continue
        for stream in app.findall("./live/stream"):
            stream_name_el = stream.find("name")
            if stream_name_el is not None and (stream_name_el.text or "").strip() == stream_key:
                return True
    return False


def wait_for_ingest_stream(stream_key: str, timeout_s: float) -> bool:
    deadline = time.time() + max(0.0, timeout_s)
    while time.time() < deadline:
        if _ingest_has_stream(stream_key):
            return True
        time.sleep(1.0)
    return _ingest_has_stream(stream_key)


def main() -> None:
    r = _redis()
    group = "workers"
    consumer = settings.worker_node_name

    # Ensure stream + group exists. In a real-world scenario, this might be an admin task,
    # but for simple docker-compose setup, the worker can create it.
    try:
        r.xgroup_create("restream:jobs", group, id="0", mkstream=True)
        print(f"[worker] created consumer group '{group}' on stream 'restream:jobs'", flush=True)
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" in str(e):
            print(f"[worker] consumer group '{group}' already exists", flush=True)
        else:
            # If Redis is down, this will fail here, which is intended.
            print(f"[worker] ERROR: failed to create consumer group: {e}", flush=True)
            raise

    procs: dict[tuple[str, str], ProcHandle] = {}
    last_seq: dict[tuple[str, str], int] = {}
    desired_state: dict[tuple[str, str], str] = {}
    last_start_params: dict[tuple[str, str], tuple[str, str]] = {}
    retry_attempt: dict[tuple[str, str], int] = {}
    retry_after: dict[tuple[str, str], float] = {}

    def status_key(stream_id: str, target_id: str) -> str:
        return f"restream:target:{stream_id}:{target_id}"

    def set_status(
        stream_id: str,
        target_id: str,
        state: str,
        pid: int | None = None,
        exit_code: int | None = None,
    ) -> None:
        mapping: dict[str, str] = {
            "state": state,
            "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "worker": consumer,
        }
        st_key = status_key(stream_id, target_id)
        if pid is not None:
            mapping["pid"] = str(pid)
        if exit_code is not None:
            mapping["exit_code"] = str(exit_code)
        r.hset(st_key, mapping=mapping)
        if pid is None:
            r.hdel(st_key, "pid")
        if exit_code is None:
            r.hdel(st_key, "exit_code")

    def stop_proc(stream_id: str, target_id: str) -> None:
        key = (stream_id, target_id)
        handle = procs.pop(key, None)
        if not handle:
            set_status(stream_id, target_id, "stopped")
            return
        try:
            set_status(stream_id, target_id, "stopping", pid=handle.popen.pid)
            handle.popen.send_signal(signal.SIGTERM)
            handle.popen.wait(timeout=5)
        except Exception:
            try:
                handle.popen.kill()
            except Exception:
                pass
        finally:
            set_status(stream_id, target_id, "stopped")

    def schedule_retry(key: tuple[str, str]) -> None:
        # Exponential backoff, capped.
        attempt = retry_attempt.get(key, 0) + 1
        retry_attempt[key] = attempt
        delay = min(10.0, 1.0 * (2 ** min(4, attempt - 1)))  # 1s,2s,4s,8s,10s...
        retry_after[key] = time.time() + delay

    def clear_retry(key: tuple[str, str]) -> None:
        retry_attempt.pop(key, None)
        retry_after.pop(key, None)

    def maybe_start_from_last(key: tuple[str, str]) -> None:
        # Start FFmpeg if the desired state is running and there is no current process.
        if desired_state.get(key) != "running":
            return
        if key in procs and procs[key].popen.poll() is None:
            return
        params = last_start_params.get(key)
        if not params:
            return
        now = time.time()
        due = retry_after.get(key, 0.0)
        if due and now < due:
            return

        stream_id, target_id = key
        input_url, output_url = params

        ingest_key = _extract_ingest_stream_key(input_url)
        if ingest_key:
            set_status(stream_id, target_id, "starting")
            ok = wait_for_ingest_stream(ingest_key, timeout_s=15.0)
            if not ok:
                print(
                    f"[worker] input not ready stream={stream_id} target={target_id} key={ingest_key} (waiting for publish); will retry",
                    flush=True,
                )
                schedule_retry(key)
                return

        cmd = build_ffmpeg_cmd(input_url, output_url)
        seq = last_seq.get(key, 0)
        print(
            f"[worker] start stream={stream_id} target={target_id} seq={seq} -> {output_url}",
            flush=True,
        )
        popen = subprocess.Popen(cmd)
        time.sleep(0.5)
        rc = popen.poll()
        if rc is not None:
            print(
                f"[worker] failed stream={stream_id} target={target_id} seq={seq} pid={popen.pid} rc={rc}",
                flush=True,
            )
            set_status(stream_id, target_id, "exited", pid=popen.pid, exit_code=rc)
            schedule_retry(key)
            return

        procs[key] = ProcHandle(popen=popen, stream_id=stream_id, target_id=target_id)
        set_status(stream_id, target_id, "running", pid=popen.pid)

    while True:
        # Block for jobs (but still loop frequently so we can reap exited FFmpeg processes and retry).
        resp = r.xreadgroup(group, consumer, {"restream:jobs": ">"}, count=10, block=1000)

        if resp:
            for _stream_name, messages in resp:
                for msg_id, fields in messages:
                    action = fields.get("action")
                    stream_id = fields.get("stream_id", "")
                    target_id = fields.get("target_id", "")
                    key = (stream_id, target_id)

                    seq_raw = fields.get("seq")
                    try:
                        seq = int(seq_raw) if seq_raw is not None else 0
                    except Exception:
                        seq = 0
                    prev_seq = last_seq.get(key, 0)
                    if seq and seq < prev_seq:
                        # Ignore out-of-order/old jobs.
                        r.xack("restream:jobs", group, msg_id)
                        continue

                    if action == "start":
                        input_url = fields.get("input_url")
                        output_url = fields.get("output_url")
                        force_restart = str(fields.get("force_restart") or "").strip() in {"1", "true", "True", "yes"}
                        if not input_url or not output_url:
                            r.xack("restream:jobs", group, msg_id)
                            continue

                        if seq:
                            last_seq[key] = seq
                        desired_state[key] = "running"
                        params = (input_url, output_url)
                        # If we're already running with the exact same params, treat as a no-op.
                        # If params changed (e.g., user updated URL/key), restart FFmpeg.
                        if key in procs and procs[key].popen.poll() is None:
                            if not force_restart and last_start_params.get(key) == params:
                                r.xack("restream:jobs", group, msg_id)
                                continue
                            stop_proc(stream_id, target_id)

                        last_start_params[key] = params
                        clear_retry(key)
                        maybe_start_from_last(key)
                        r.xack("restream:jobs", group, msg_id)

                    elif action == "stop":
                        if seq:
                            last_seq[key] = seq
                        desired_state[key] = "stopped"
                        clear_retry(key)
                        print(f"[worker] stop stream={stream_id} target={target_id} seq={last_seq.get(key, 0)}", flush=True)
                        stop_proc(stream_id, target_id)
                        r.xack("restream:jobs", group, msg_id)

                    else:
                        r.xack("restream:jobs", group, msg_id)

        # Cleanup exited (run even when there are no new jobs, otherwise status can get stuck at "running").
        for key, handle in list(procs.items()):
            if handle.popen.poll() is not None:
                procs.pop(key, None)
                rc = handle.popen.returncode
                seq = last_seq.get(key, 0)
                print(f"[worker] exited stream={handle.stream_id} target={handle.target_id} seq={seq} pid={handle.popen.pid} rc={rc}", flush=True)
                set_status(handle.stream_id, handle.target_id, "exited", pid=handle.popen.pid, exit_code=rc)
                if desired_state.get(key) == "running":
                    schedule_retry(key)

        # Retry loop: if desired state is running but FFmpeg is down, restart with backoff.
        for key in list(last_start_params.keys()):
            if desired_state.get(key) == "running" and key not in procs:
                maybe_start_from_last(key)


if __name__ == "__main__":
    main()
