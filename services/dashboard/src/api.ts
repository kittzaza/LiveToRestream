export type StreamOut = { id: number; name: string; stream_key: string }
export type StreamResolveOut = { id: number; name: string; is_active: boolean; created_at: string }
export type StreamKeyOut = { stream_id: number; stream_key: string }
export type StreamSummaryOut = {
  id: number
  name: string
  is_active: boolean
  created_at: string
  ingest_state: string
  last_publish_at?: string | null
}
export type TargetOut = { id: number; name: string; rtmp_url: string; enabled: boolean }
export type TargetPatch = { name?: string; rtmp_url?: string; enabled?: boolean }
export type StreamStatusOut = {
  stream_id: number
  ingest_state: string
  last_publish_at?: string | null
  targets: Array<{ target_id: number; state: string; pid?: number | null; exit_code?: number | null; updated_at?: string | null }>
}
export type SessionOut = {
  id: number
  stream_id: number
  started_at: string
  ended_at?: string | null
}

async function readJsonOrText(res: Response) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function makeApi(apiBase: string, apiToken?: string) {
  const base = apiBase.replace(/\/$/, '')
  const token = (apiToken || '').trim()

  function authHeaders(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  return {
    async resolveStreamKey(stream_key: string) {
      const url = new URL(`${base}/streams/resolve`)
      url.searchParams.set('stream_key', stream_key)
      const res = await fetch(url.toString(), { headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as StreamResolveOut
    },

    async listStreams() {
      const res = await fetch(`${base}/streams`, { headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as StreamSummaryOut[]
    },

    async createStream(payload: { name: string; stream_key?: string }) {
      const res = await fetch(`${base}/streams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as StreamOut
    },

    async rotateStreamKey(streamId: number, payload: { stream_key?: string }) {
      const res = await fetch(`${base}/streams/${streamId}/stream_key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as StreamKeyOut
    },

    async deleteStream(streamId: number) {
      const res = await fetch(`${base}/streams/${streamId}`, { method: 'DELETE', headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as { ok: boolean }
    },

    async addTarget(streamId: number, payload: { name: string; rtmp_url: string }) {
      const res = await fetch(`${base}/streams/${streamId}/targets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as TargetOut
    },

    async listTargets(streamId: number) {
      const res = await fetch(`${base}/streams/${streamId}/targets`, { headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as TargetOut[]
    },

    async patchTarget(targetId: number, payload: TargetPatch) {
      const res = await fetch(`${base}/targets/${targetId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as TargetOut
    },

    async deleteTarget(targetId: number) {
      const res = await fetch(`${base}/targets/${targetId}`, { method: 'DELETE', headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as { ok: boolean }
    },

    async start(streamId: number) {
      const res = await fetch(`${base}/streams/${streamId}/start`, { method: 'POST', headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data
    },

    async stop(streamId: number) {
      const res = await fetch(`${base}/streams/${streamId}/stop`, { method: 'POST', headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data
    },

    async restart(streamId: number) {
      const res = await fetch(`${base}/streams/${streamId}/restart`, { method: 'POST', headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data
    },

    async status(streamId: number) {
      const res = await fetch(`${base}/streams/${streamId}/status`, { headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as StreamStatusOut
    },

    async sessions(streamId: number) {
      const res = await fetch(`${base}/streams/${streamId}/sessions`, { headers: authHeaders() })
      const data = await readJsonOrText(res)
      if (!res.ok) throw { status: res.status, data }
      return data as SessionOut[]
    },
  }
}
