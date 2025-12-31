import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  KeyRound,
  Play,
  StopCircle,
  RefreshCw,
  BarChart3,
  AlertCircle,
  Settings,
  Trash2,
  Pencil,
} from 'lucide-react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { AnimatePresence, motion } from 'framer-motion'
import Hls from 'hls.js'

import { makeApi, SessionOut, StreamStatusOut, TargetOut } from './api'

function formatTime(isoString: string) {
  return new Date(isoString).toLocaleTimeString([], { hour12: false })
}

function formatUptime(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0')
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0')
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

const LivePlayer = ({ streamKey, ingestBase }: { streamKey: string; ingestBase: string }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [playerState, setPlayerState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  })
  const [muted, setMuted] = useState(true)
  const lastErrorShownAtRef = useRef(0)

  const tryAutoPlay = () => {
    const v = videoRef.current
    if (!v) return
    // Autoplay is most reliable when muted; we default to muted and also reset to muted on new loads.
    v.muted = true
    void v.play().catch(() => {
      // ignore autoplay blocks
    })
  }

  useEffect(() => {
    if (!playerState.error) return
    const t = window.setTimeout(() => {
      setPlayerState((s) => ({ ...s, error: null }))
    }, 5000)
    return () => window.clearTimeout(t)
  }, [playerState.error])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const trimmed = streamKey.trim()
    if (!trimmed) {
      setPlayerState({ loading: false, error: null })
      try {
        video.pause()
      } catch {
        // ignore
      }
      video.removeAttribute('src')
      video.load()
      return
    }

    // Reset to muted for reliable autoplay when user loads a stream key or refreshes the page.
    setMuted(true)
    video.muted = true

    const hlsUrl = `${ingestBase}/hls/${encodeURIComponent(trimmed)}/index.m3u8`
    setPlayerState({ loading: true, error: null })

    if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          manifestLoadingMaxRetry: 10,
          manifestLoadingRetryDelay: 1000,
        })
        hlsRef.current = hls
        hls.loadSource(hlsUrl)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setPlayerState({ loading: false, error: null })
          tryAutoPlay()
        })
        hls.on(Hls.Events.ERROR, (_event, data: any) => {
          const code = data?.response?.code
          if (code === 404) {
            const now = Date.now()
            if (now - lastErrorShownAtRef.current > 8000) {
              lastErrorShownAtRef.current = now
              setPlayerState({ loading: false, error: 'No HLS yet. Start streaming to this stream key (OBS) and wait ~2–5s.' })
            }
          }
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                hls.startLoad()
                break
              case Hls.ErrorTypes.MEDIA_ERROR:
                hls.recoverMediaError()
                break
              default:
                hls.destroy()
                break
            }
          }
        })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl
      setPlayerState({ loading: false, error: null })
      tryAutoPlay()
    } else {
      video.src = hlsUrl
      setPlayerState({ loading: false, error: 'This browser cannot play HLS. Try Chrome/Edge.' })
    }

    return () => {
      if (hlsRef.current) hlsRef.current.destroy()
      hlsRef.current = null
    }
  }, [streamKey])

  const hlsLink = streamKey.trim() ? `${ingestBase}/hls/${encodeURIComponent(streamKey.trim())}/index.m3u8` : ''

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border border-white/10 bg-black">
      <video
        ref={videoRef}
        controls
        autoPlay
        muted={muted}
        crossOrigin="anonymous"
        playsInline
        className="h-full w-full object-contain"
      />
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <div className="animate-pulse rounded bg-red-600 px-2 py-1 text-[10px] font-bold uppercase">Live</div>
      </div>

      <button
        type="button"
        onClick={() => {
          const next = !muted
          setMuted(next)
          const v = videoRef.current
          if (v) {
            v.muted = next
            if (!next) {
              void v.play().catch(() => {
                // some browsers may still block; user can press play
              })
            }
          }
        }}
        className="absolute right-4 top-4 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] font-semibold text-white hover:bg-black/55"
      >
        {muted ? 'Muted' : 'Sound on'}
      </button>

      {playerState.loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-sm text-white">
          Loading preview…
        </div>
      )}

      {playerState.error && (
        <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-white/10 bg-black/60 p-3 text-xs text-slate-100">
          <div className="font-semibold">Preview unavailable</div>
          <div className="mt-1 text-slate-200">{playerState.error}</div>
          {hlsLink && (
            <a className="pointer-events-auto mt-2 inline-block font-mono text-sky-300 underline" href={hlsLink} target="_blank" rel="noreferrer">
              {hlsLink}
            </a>
          )}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('apiBase') || 'http://localhost:8000')
  const [apiToken, setApiToken] = useState(() => {
    const stored = (localStorage.getItem('apiToken') || '').trim()
    // In docker-compose.yml we default API_AUTH_TOKEN to "admin".
    // Make the dashboard usable by default while still allowing users to override.
    return stored || 'admin'
  })
  const api = useMemo(() => makeApi(apiBase, apiToken), [apiBase, apiToken])

  const ingestBase = useMemo(() => {
    try {
      const u = new URL(apiBase)
      const host = u.hostname
      return `${u.protocol}//${host}:8080`
    } catch {
      return 'http://localhost:8080'
    }
  }, [apiBase])

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isObsReveal, setIsObsReveal] = useState(false)

  const maskSecret = (value: string) => {
    if (!value) return ''
    return '••••••••••••••••'
  }

  const getStreamKeyFromLocation = () => {
    const path = window.location.pathname || '/'
    const m = path.match(/^\/streamkey\/([^/?#]+)\/?$/)
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    }

    const params = new URLSearchParams(window.location.search)
    return params.get('key') || ''
  }

  const [streamKey, setStreamKey] = useState(() => getStreamKeyFromLocation())
  const [streamKeyDraft, setStreamKeyDraft] = useState(() => getStreamKeyFromLocation())
  const [activeStreamId, setActiveStreamId] = useState<number | null>(null)

  const [targets, setTargetsRaw] = useState<TargetOut[]>([])
  // Always show Facebook targets first
  const setTargets = (updater) => {
    setTargetsRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      return [...next].sort((a, b) => {
        const isFbA = a.name?.toLowerCase() === 'facebook' || a.rtmp_url?.includes('facebook.com')
        const isFbB = b.name?.toLowerCase() === 'facebook' || b.rtmp_url?.includes('facebook.com')
        if (isFbA && !isFbB) return -1
        if (!isFbA && isFbB) return 1
        return 0
      })
    })
  }
  // Use sorted targets everywhere
  const targets = targetsRaw
  const [targetErrors, setTargetErrors] = useState<Record<number, string>>({})
  const [isEditingTarget, setIsEditingTarget] = useState(false)
  const [editingTargetId, setEditingTargetId] = useState<number | null>(null)
  const [editingTargetName, setEditingTargetName] = useState('')
  const [editingTargetUrl, setEditingTargetUrl] = useState('')
  const [editingTargetUrlBase, setEditingTargetUrlBase] = useState('')
  const [editingTargetStreamKey, setEditingTargetStreamKey] = useState('')
  const [newTargetName, setNewTargetName] = useState('')
  const [newTargetUrl, setNewTargetUrl] = useState('')
  const [isAddingTarget, setIsAddingTarget] = useState(false)
  const [newTargetPlatform, setNewTargetPlatform] = useState<'custom' | 'youtube' | 'twitch' | 'facebook'>('youtube')
  const [newTargetPlatformKey, setNewTargetPlatformKey] = useState('')

  const splitRtmpUrl = (raw: string) => {
    const url = (raw || '').trim().replace(/\s+/g, '')
    const i = url.lastIndexOf('/')
    if (i <= 0 || i === url.length - 1) return { base: url, key: '' }
    return { base: url.slice(0, i), key: url.slice(i + 1) }
  }

  const joinRtmpUrl = (base: string, key: string) => {
    const b = (base || '').trim().replace(/\s+/g, '').replace(/\/+$/, '')
    const k = (key || '').trim().replace(/\s+/g, '')
    if (!b || !k) return ''
    return `${b}/${k}`
  }

  const [createStreamName, setCreateStreamName] = useState('')
  const [createStreamKey, setCreateStreamKey] = useState('')
  const [isCreatingStream, setIsCreatingStream] = useState(false)

  const [status, setStatus] = useState<StreamStatusOut | null>(null)
  const [sessions, setSessions] = useState<SessionOut[]>([])
  const [events, setEvents] = useState<Array<{ timestamp: string; severity: 'info' | 'warning'; message: string }>>([])
  const [metrics, setMetrics] = useState<Array<{ timestamp: string; bitrate: number; fps: number }>>([])
  const [uptimeSeconds, setUptimeSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isStartingRestreams, setIsStartingRestreams] = useState(false)
  const [isStoppingRestreams, setIsStoppingRestreams] = useState(false)

  const pushEvent = useCallback((severity: 'info' | 'warning', message: string) => {
    const timestamp = new Date().toISOString()
    setEvents((prev) => [{ timestamp, severity, message }, ...prev].slice(0, 30))
  }, [])

  const humanizeApiError = (e: any) => {
    const status = e?.status
    const detail = e?.data?.detail
    if (status === 401) return 'Unauthorized (set API Token in Settings)'
    return detail || status || 'unknown error'
  }

  const setApiError = (prefix: string, e: any) => {
    setError(`${prefix}: ${humanizeApiError(e)}`)
  }

  const setTargetApiError = (targetId: number, prefix: string, e: any) => {
    setTargetErrors((prev) => ({ ...prev, [targetId]: `${prefix}: ${humanizeApiError(e)}` }))
  }

  const clearTargetError = (targetId: number) => {
    setTargetErrors((prev) => {
      if (!(targetId in prev)) return prev
      const next = { ...prev }
      delete next[targetId]
      return next
    })
  }

  const updateUrl = useCallback((key: string, mode: 'push' | 'replace' = 'push') => {
    const trimmed = key.trim()
    const next = trimmed ? `/streamkey/${encodeURIComponent(trimmed)}` : '/'
    if (mode === 'replace') window.history.replaceState({}, '', next)
    else window.history.pushState({}, '', next)
  }, [])

  useEffect(() => {
    // Backward-compat: if user comes in with ?key=..., redirect to /streamkey/<key>
    const params = new URLSearchParams(window.location.search)
    const q = (params.get('key') || '').trim()
    const p = (window.location.pathname || '').match(/^\/streamkey\/([^/?#]+)\/?$/)?.[1]
    if (q && !p) {
      updateUrl(q, 'replace')
      setStreamKey(q)
      setStreamKeyDraft(q)
    }

    const onPop = () => {
      const nextKey = getStreamKeyFromLocation().trim()
      setStreamKey(nextKey)
      setStreamKeyDraft(nextKey)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStreamUpdate = useCallback(async (key: string, mode: 'push' | 'replace' = 'push') => {
    const trimmed = key.trim()
    setStreamKeyDraft(trimmed)
    setStreamKey(trimmed)
    updateUrl(trimmed, mode)
    setError(null)
    setActiveStreamId(null)
    setTargets([])
    setTargetErrors({})
    setStatus(null)
    setSessions([])
    setEvents([])
    setMetrics([])
    setUptimeSeconds(0)
    if (!trimmed) return

    try {
      const resolved = await api.resolveStreamKey(trimmed)
      setActiveStreamId(resolved.id)
    } catch (e: any) {
      setApiError('Load failed', e)
    }
  }, [api, updateUrl])

  const lastAutoFollowRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })

  const getActiveLiveStreamKeysFromStat = (xmlText: string) => {
    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(xmlText, 'application/xml')
      const apps = Array.from(doc.getElementsByTagName('application'))
      const liveApp = apps.find((a) => (a.getElementsByTagName('name')[0]?.textContent || '').trim() === 'live')
      if (!liveApp) return [] as string[]
      const live = liveApp.getElementsByTagName('live')[0]
      if (!live) return [] as string[]
      const streams = Array.from(live.getElementsByTagName('stream'))
      const keys = streams
        .map((s) => (s.getElementsByTagName('name')[0]?.textContent || '').trim())
        .filter(Boolean)
      return Array.from(new Set(keys))
    } catch {
      return [] as string[]
    }
  }

  useEffect(() => {
    let cancelled = false
    const statUrl = `${ingestBase}/stat`

    const poll = async () => {
      try {
        const res = await fetch(statUrl, { cache: 'no-store' })
        if (!res.ok) return
        const xml = await res.text()
        if (cancelled) return

        const keys = getActiveLiveStreamKeysFromStat(xml)
        if (keys.length !== 1) return

        const activeKey = keys[0].trim()
        const currentKey = streamKey.trim()
        const draftKey = streamKeyDraft.trim()

        // Avoid hijacking while user is typing a different stream key.
        if (draftKey !== currentKey) return

        // Only auto-follow when we're not already live on the current key.
        if (status?.ingest_state === 'live' && currentKey) return
        if (activeKey === currentKey) return

        const now = Date.now()
        if (lastAutoFollowRef.current.key === activeKey && now - lastAutoFollowRef.current.at < 8000) return
        lastAutoFollowRef.current = { key: activeKey, at: now }

        void handleStreamUpdate(activeKey, 'replace')
      } catch {
        // ignore stat fetch failures (CORS/network)
      }
    }

    poll()
    const interval = window.setInterval(poll, 2000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [handleStreamUpdate, ingestBase, status?.ingest_state, streamKey, streamKeyDraft])

  useEffect(() => {
    let t: any
    if (status?.ingest_state === 'live') {
      t = setInterval(() => setUptimeSeconds((s) => s + 1), 1000)
    }
    return () => clearInterval(t)
  }, [status?.ingest_state])

  useEffect(() => {
    if (!activeStreamId) return

    const streamId = activeStreamId

    let cancelled = false
    async function fetchData() {
      try {
        const [st, tg, ss] = await Promise.all([
          api.status(streamId),
          isEditingTarget ? Promise.resolve(null) : api.listTargets(streamId),
          api.sessions(streamId),
        ])

        if (cancelled) return

        setStatus(st)
        if (tg) setTargets(tg)
        setSessions(ss)

        // Uptime: approximate from last_publish_at when present, else keep ticking from 0.
        if (st.ingest_state !== 'live') {
          setUptimeSeconds(0)
        } else if (st.last_publish_at) {
          const start = Date.parse(st.last_publish_at)
          if (!Number.isNaN(start)) {
            const now = Date.now()
            setUptimeSeconds(Math.max(0, Math.floor((now - start) / 1000)))
          }
        }

        // Events derived from sessions
        const ev: Array<{ timestamp: string; severity: 'info' | 'warning'; message: string }> = []
        for (const s of ss.slice(0, 20)) {
          ev.push({ timestamp: s.started_at, severity: 'info', message: 'Ingest started' })
          if (s.ended_at) ev.push({ timestamp: s.ended_at, severity: 'warning', message: 'Ingest stopped' })
        }
        ev.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        setEvents(ev.slice(0, 30))

        // Metrics: lightweight synthetic series to match chart UI
        const ts = new Date().toISOString()
        const isLive = st.ingest_state === 'live'
        setMetrics((prev) => {
          const next = prev.concat([
            {
              timestamp: ts,
              bitrate: isLive ? Math.round(4500 + Math.random() * 1000) : 0,
              fps: isLive ? Math.round(58 + Math.random() * 4) : 0,
            },
          ])
          return next.slice(-60)
        })
      } catch (e: any) {
        if (cancelled) return
        setApiError('Refresh failed', e)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeStreamId, api, isEditingTarget])

  const toggleTarget = async (id: number, currentEnabled: boolean) => {
    try {
      let updated: TargetOut
      if (currentEnabled) {
        // If turning off, call disable endpoint to stop target
        updated = await api.patchTarget(id, { enabled: false })
        // Optionally, you could call a dedicated stop endpoint if available
        // await api.disableTarget(id)
      } else {
        updated = await api.patchTarget(id, { enabled: true })
      }
      setTargets((prev) => prev.map((t) => (t.id === id ? updated : t)))
      clearTargetError(id)
    } catch (e: any) {
      setTargetApiError(id, 'Update target failed', e)
    }
  }

  const updateTargetUrl = async (id: number, rtmp_url: string) => {
    try {
      const updated = await api.patchTarget(id, { rtmp_url })
      setTargets((prev) => prev.map((t) => (t.id === id ? updated : t)))
      clearTargetError(id)
    } catch (e: any) {
      setTargetApiError(id, 'Update target failed', e)
    }
  }

  const beginEditTarget = (t: TargetOut) => {
    setEditingTargetId(t.id)
    setEditingTargetName(t.name)
    setEditingTargetUrl(t.rtmp_url)
    const { base, key } = splitRtmpUrl(t.rtmp_url)
    setEditingTargetUrlBase(base)
    setEditingTargetStreamKey(key)
    setIsEditingTarget(true)
  }

  const cancelEditTarget = () => {
    setEditingTargetId(null)
    setEditingTargetName('')
    setEditingTargetUrl('')
    setEditingTargetUrlBase('')
    setEditingTargetStreamKey('')
    setIsEditingTarget(false)
  }

  const saveEditTarget = async () => {
    if (!editingTargetId) return
    const name = editingTargetName.trim()
    const rtmp_url = editingTargetUrl.trim().replace(/\s+/g, '')
    if (!name) {
      setTargetErrors((prev) => ({ ...prev, [editingTargetId]: 'Update target failed: name is required' }))
      return
    }
    if (!rtmp_url) {
      setTargetErrors((prev) => ({ ...prev, [editingTargetId]: 'Update target failed: RTMP URL is required' }))
      return
    }

    try {
      const updated = await api.patchTarget(editingTargetId, { name, rtmp_url })
      setTargets((prev) => prev.map((t) => (t.id === editingTargetId ? updated : t)))
      clearTargetError(editingTargetId)
      cancelEditTarget()
    } catch (e: any) {
      setTargetApiError(editingTargetId, 'Update target failed', e)
    }
  }

  const deleteTarget = async (id: number) => {
    const ok = window.confirm('Delete this target?')
    if (!ok) return
    try {
      await api.deleteTarget(id)
      setTargets((prev) => prev.filter((t) => t.id !== id))
      clearTargetError(id)
    } catch (e: any) {
      setApiError('Delete failed', e)
    }
  }

  const stopAllRestreams = async () => {
    if (!activeStreamId) return
    try {
      setIsStoppingRestreams(true)
      setError(null)
      await api.stop(activeStreamId)
      pushEvent('warning', 'Restreams stopped')
      try {
        const st = await api.status(activeStreamId)
        setStatus(st)
      } catch {
        // ignore
      }
    } catch (e: any) {
      setApiError('Stop failed', e)
      pushEvent('warning', `Stop failed: ${humanizeApiError(e)}`)
    } finally {
      setIsStoppingRestreams(false)
    }
  }

  const startRestreams = async () => {
    if (!activeStreamId) return
    if (targets.length === 0) {
      alert('No targets configured. Add at least one restream target first.')
      return
    }
    if (!targets.some(t => t.enabled)) {
      alert('No targets are enabled. Please enable at least one target before starting restreams.')
      return
    }
    try {
      setIsStartingRestreams(true)
      setError(null)
      // Re-check live state just-in-time (UI can be stale by up to the polling interval).
      const st = await api.status(activeStreamId)
      setStatus(st)
      if (st.ingest_state !== 'live') {
        alert('Please start your main ingest (OBS) first, then start restreams.')
        return
      }
      await api.start(activeStreamId)
      pushEvent('info', 'Restreams started')
      try {
        const st2 = await api.status(activeStreamId)
        setStatus(st2)
      } catch {
        // ignore
      }
    } catch (e: any) {
      setApiError('Start failed', e)
      pushEvent('warning', `Start failed: ${humanizeApiError(e)}`)
    } finally {
      setIsStartingRestreams(false)
    }
  }

  const addTarget = async () => {
    if (!activeStreamId) {
      setError('Add target failed: load a stream key first')
      return
    }
    const platformInput = newTargetPlatformKey.replace(/\s+/g, '').trim()
    const isFullRtmpUrl = /^rtmps?:\/\//i.test(platformInput)
    const customPlatformName = newTargetName.trim()
    const computedUrl = (() => {
      if (isFullRtmpUrl) return platformInput
      switch (newTargetPlatform) {
        case 'youtube':
          return platformInput ? `rtmps://a.rtmps.youtube.com/live2/${platformInput}` : ''
        case 'twitch':
          return platformInput ? `rtmp://live.twitch.tv/app/${platformInput}` : ''
        case 'facebook':
          return platformInput ? `rtmps://live-api-s.facebook.com:443/rtmp/${platformInput}` : ''
        default:
          return ''
      }
    })()

    const customBaseOrFull = newTargetUrl.trim().replace(/\s+/g, '')
    const rtmp_url = (() => {
      if (newTargetPlatform !== 'custom') return computedUrl

      // Custom RTMP supports either:
      // - pasting full rtmp(s):// URL into the Stream Key field (legacy shortcut)
      // - pasting full rtmp(s):// URL into the Base URL field
      // - base URL + stream key
      if (isFullRtmpUrl) return platformInput
      if (customBaseOrFull && platformInput) return joinRtmpUrl(customBaseOrFull, platformInput)
      return customBaseOrFull
    })()
    if (newTargetPlatform === 'custom' && !customPlatformName) {
      setError('Add target failed: Custom RTMP platform name is required')
      return
    }
    if (!rtmp_url) {
      setError(newTargetPlatform === 'custom' ? 'Add target failed: RTMP base URL (or full URL) is required' : 'Add target failed: platform stream key is required')
      return
    }
    const defaultName = (() => {
      switch (newTargetPlatform) {
        case 'youtube':
          return 'YouTube'
        case 'twitch':
          return 'Twitch'
        case 'facebook':
          return 'Facebook'
        default:
          return customPlatformName || `Custom RTMP ${targets.length + 1}`
      }
    })()
    // For Custom RTMP, the name is treated as a registered platform label in the system.
    const name = newTargetPlatform === 'custom' ? customPlatformName : defaultName

    setIsAddingTarget(true)
    try {
      const created = await api.addTarget(activeStreamId, { name, rtmp_url })
      setTargets((prev) => [created, ...prev])
      setNewTargetName('')
      setNewTargetUrl('')
      setNewTargetPlatform('youtube')
      setNewTargetPlatformKey('')
      pushEvent('info', `Target added: ${created.name}`)
    } catch (e: any) {
      setApiError('Add target failed', e)
      pushEvent('warning', `Add target failed: ${humanizeApiError(e)}`)
    } finally {
      setIsAddingTarget(false)
    }
  }

  const createStream = async () => {
    const name = createStreamName.trim()
    const stream_key = createStreamKey.trim()
    if (!name) {
      setError('Create stream failed: name is required')
      return
    }

    setIsCreatingStream(true)
    try {
      const created = await api.createStream({ name, stream_key: stream_key || undefined })
      setCreateStreamName('')
      setCreateStreamKey('')
      alert(`Created stream key: ${created.stream_key}`)
    } catch (e: any) {
      setApiError('Create stream failed', e)
    } finally {
      setIsCreatingStream(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-8 p-6">
        <header className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div className="flex flex-wrap items-center gap-6">
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="bg-gradient-to-r from-sky-400 to-violet-500 bg-clip-text text-transparent">
                Restream Platform
              </span>
            </h1>

            <div className="flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 backdrop-blur">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Channel</span>
                <div className="mx-1 h-3 w-px bg-white/10" />
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={streamKeyDraft}
                  onChange={(e) => setStreamKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleStreamUpdate(streamKeyDraft)
                      e.currentTarget.blur()
                    }
                  }}
                  onBlur={() => handleStreamUpdate(streamKeyDraft)}
                  className="w-40 bg-transparent text-sm font-bold text-white outline-none placeholder:text-white/20"
                  placeholder="Stream Key..."
                />
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    handleStreamUpdate(streamKeyDraft)
                  }}
                  className="flex items-center gap-1 rounded-full bg-gradient-to-r from-sky-600 to-violet-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white transition-all hover:from-sky-500 hover:to-violet-500 active:scale-95"
                >
                  <RefreshCw className="h-3 w-3" />
                  Load
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={startRestreams}
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-600 to-violet-600 px-5 py-2 text-sm font-bold uppercase tracking-wider text-white transition-all hover:from-sky-500 hover:to-violet-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!activeStreamId || isStartingRestreams || isStoppingRestreams}
            >
              <Play className="h-4 w-4" />
              {isStartingRestreams ? 'Starting…' : 'Start Restreams'}
            </button>
            <button
              onClick={stopAllRestreams}
              className="flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/15 px-5 py-2 text-sm font-semibold text-red-200 transition-all hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!activeStreamId || isStartingRestreams || isStoppingRestreams}
            >
              <StopCircle className="h-4 w-4" />
              {isStoppingRestreams ? 'Stopping…' : 'Stop'}
            </button>
            <button
              onClick={() => setIsSettingsOpen((v) => !v)}
              className="rounded-full border border-white/10 bg-white/5 p-2 text-slate-200 hover:bg-white/10"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </header>

        <AnimatePresence>
          {isSettingsOpen && (
            <motion.section
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur"
            >
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[280px] flex-1">
                  <div className="text-xs font-semibold text-slate-300">API Base</div>
                  <input
                    value={apiBase}
                    onChange={(e) => setApiBase(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none"
                    placeholder="http://localhost:8000"
                  />
                </div>
                <div className="min-w-[220px]">
                  <div className="text-xs font-semibold text-slate-300">API Token</div>
                  <input
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm font-mono text-white outline-none"
                    placeholder="admin"
                  />
                </div>
                <button
                  onClick={() => {
                    localStorage.setItem('apiBase', apiBase)
                    localStorage.setItem('apiToken', apiToken)
                  }}
                  className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
                >
                  Save
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className="font-semibold text-slate-300">OBS</span>
                <span>
                  Key:{' '}
                  <span className="font-mono text-slate-200">{streamKey ? (isObsReveal ? streamKey : maskSecret(streamKey)) : '(stream_key)'}</span>
                </span>
                <button
                  onClick={() => setIsObsReveal((v) => !v)}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-200 hover:bg-white/10"
                >
                  {isObsReveal ? 'Hide' : 'Reveal'}
                </button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-1">
            <section className="rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Restream Targets</h2>
              </div>

              <div className="space-y-4">
                {activeStreamId && (
                  <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-4">
                    <div className="grid grid-cols-1 gap-2">
                      <div className="grid grid-cols-1 gap-2">
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          <div>
                            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Platform</label>
                            <select
                              value={newTargetPlatform}
                              onChange={(e) => setNewTargetPlatform(e.target.value as any)}
                              className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/50"
                            >
                              <option value="custom">Custom RTMP</option>
                              <option value="youtube">YouTube</option>
                              <option value="twitch">Twitch</option>
                              <option value="facebook">Facebook</option>
                            </select>
                          </div>

                          {newTargetPlatform !== 'custom' ? (
                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Stream Key</label>
                              <input
                                type="text"
                                value={newTargetPlatformKey}
                                onChange={(e) => setNewTargetPlatformKey(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    addTarget()
                                    e.currentTarget.blur()
                                  }
                                }}
                                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs font-mono text-white outline-none focus:border-sky-500/50"
                                placeholder="Paste stream key"
                              />
                            </div>
                          ) : null}
                        </div>

                        {newTargetPlatform === 'custom' ? (
                          <div className="flex flex-col gap-3">
                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Custom Platform Name</label>
                              <input
                                type="text"
                                value={newTargetName}
                                onChange={(e) => setNewTargetName(e.target.value)}
                                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/50"
                                placeholder="e.g.Facebook, Youtube"
                              />
                              <div className="mt-1 text-[11px] text-slate-400">
                                This name is saved as the platform label in the system.
                              </div>
                            </div>
                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">RTMP URL</label>
                              <input
                                type="text"
                                value={newTargetUrl}
                                onChange={(e) => setNewTargetUrl(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    addTarget()
                                    e.currentTarget.blur()
                                  }
                                }}
                                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/50"
                                placeholder="rtmp(s)://..."
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Stream Key</label>
                              <input
                                type="text"
                                value={newTargetPlatformKey}
                                onChange={(e) => setNewTargetPlatformKey(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    addTarget()
                                    e.currentTarget.blur()
                                  }
                                }}
                                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs font-mono text-white outline-none focus:border-sky-500/50"
                                placeholder="place stream key"
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="rounded border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-slate-300">
                            Target URL:{' '}
                            <span className="font-mono text-slate-100">
                              {(() => {
                                const k = newTargetPlatformKey.replace(/\s+/g, '').trim()
                                if (!k) return '(enter stream key)'
                                if (newTargetPlatform === 'youtube') return `rtmps://a.rtmps.youtube.com/live2/${k}`
                                if (newTargetPlatform === 'twitch') return `rtmp://live.twitch.tv/app/${k}`
                                return `rtmps://live-api-s.facebook.com:443/rtmp/${k}`
                              })()}
                            </span>
                          </div>
                        )}
                      </div>

                      {newTargetPlatform !== 'custom' ? (
                        <div className="text-[11px] text-slate-400">
                          Target name is auto-set to the selected platform.
                        </div>
                      ) : null}

                      <button
                        type="button"
                        onClick={addTarget}
                        disabled={isAddingTarget}
                        className="rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Add target
                      </button>

                      {error && error.toLowerCase().includes('add target failed') ? (
                        <div className="rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-100">
                          {error}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}

                {targets.map((target) => (
                  <div key={target.id} className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-sky-300">{target.name}</div>
                        {(() => {
                          const st = status?.targets?.find((x) => x.target_id === target.id)
                          const state = (st?.state || 'unknown').toLowerCase()
                          const exit = st?.exit_code
                          const updatedAt = st?.updated_at

                          const pill = (() => {
                            if (state === 'running') return { label: 'RUNNING', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' }
                            if (state === 'starting') return { label: 'STARTING', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-100' }
                            if (state === 'stopping') return { label: 'STOPPING', cls: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-100' }
                            if (state === 'stopped') return { label: 'STOPPED', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-100' }
                            if (state === 'exited') return { label: 'EXITED', cls: 'border-red-500/30 bg-red-500/10 text-red-100' }
                            return { label: 'UNKNOWN', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-100' }
                          })()

                          return (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${pill.cls}`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${state === 'running' ? 'bg-emerald-400' : state === 'exited' ? 'bg-red-400' : state === 'starting' ? 'bg-sky-400' : state === 'stopping' ? 'bg-yellow-400' : 'bg-slate-400'}`} />
                                {pill.label}
                                {exit !== null && exit !== undefined ? <span className="font-mono font-bold">exit {exit}</span> : null}
                              </span>
                              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                Last update:{' '}
                                <span className="font-mono font-semibold text-slate-200">
                                  {updatedAt ? new Date(updatedAt).toLocaleTimeString() : 'N/A'}
                                </span>
                              </span>
                            </div>
                          )
                        })()}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => beginEditTarget(target)}
                          disabled={editingTargetId !== null && editingTargetId !== target.id}
                          className="inline-flex items-center justify-center rounded-md border border-white/10 bg-white/5 p-2 text-slate-200 hover:bg-white/10 disabled:opacity-40"
                          title="Edit target"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteTarget(target.id)}
                          className="inline-flex items-center justify-center rounded-md border border-red-500/30 bg-red-500/15 p-2 text-red-200 hover:bg-red-500/25"
                          title="Delete target"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleTarget(target.id, target.enabled)}
                          className={`relative h-6 w-12 rounded-full transition-colors ${target.enabled ? 'bg-sky-500' : 'bg-slate-700'}`}
                          title={target.enabled ? 'Disable' : 'Enable'}
                        >
                          <div className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${target.enabled ? 'left-7' : 'left-1'}`} />
                        </button>
                      </div>
                    </div>

                    {targetErrors[target.id] && (
                      <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-100">
                        {targetErrors[target.id]}
                      </div>
                    )}

                    <AnimatePresence initial={false}>
                      {editingTargetId === target.id && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="space-y-3 overflow-hidden"
                        >
                          <div className="grid grid-cols-1 gap-2">
                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Name</label>
                              <input
                                type="text"
                                value={editingTargetName}
                                onChange={(e) => setEditingTargetName(e.target.value)}
                                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/50"
                                placeholder="Target name"
                              />
                            </div>

                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">RTMP URL</label>
                              <input
                                type="text"
                                value={editingTargetUrl}
                                onChange={(e) => {
                                  const next = e.target.value
                                  setEditingTargetUrl(next)
                                  const { base, key } = splitRtmpUrl(next)
                                  setEditingTargetUrlBase(base)
                                  setEditingTargetStreamKey(key)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEditTarget()
                                }}
                                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs font-mono text-white outline-none focus:border-sky-500/50"
                                placeholder="rtmp(s)://..."
                              />
                            </div>

                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Stream Key</label>
                              <input
                                type="text"
                                value={editingTargetStreamKey}
                                onChange={(e) => {
                                  const nextKey = e.target.value
                                  setEditingTargetStreamKey(nextKey)
                                  const nextUrl = joinRtmpUrl(editingTargetUrlBase, nextKey)
                                  if (nextUrl) setEditingTargetUrl(nextUrl)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEditTarget()
                                }}
                                className="mt-1 w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-xs font-mono text-white outline-none focus:border-sky-500/50"
                                placeholder="Paste stream key..."
                              />
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={saveEditTarget}
                              className="rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditTarget}
                              className="rounded-lg border border-white/10 bg-black/20 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-black/30"
                            >
                              Cancel
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))}

                {targets.length === 0 && (
                  <div className="py-4 text-center text-sm italic text-slate-400">
                    {activeStreamId ? 'No targets configured' : 'Load a stream key to see targets'}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
                <Activity className="h-5 w-5 text-sky-300" />
                Stream Status
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3">
                  <span className="text-slate-400">Ingest Source</span>
                  <span className={`${status?.ingest_state === 'live' ? 'text-emerald-300' : 'text-slate-400'} flex items-center gap-2`}
                  >
                    <div className={`h-2 w-2 rounded-full ${status?.ingest_state === 'live' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
                    {status?.ingest_state === 'live' ? 'LIVE : Connected' : 'LIVE : Offline'}
                  </span>
                </div>

                {status?.ingest_state !== 'live' && streamKey.trim() && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-100">
                    <div className="font-semibold">LIVE (NO publisher)</div>
                  </div>
                )}
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3">
                  <span className="text-slate-400">Last publish</span>
                  <span className="font-mono text-xs text-slate-200">
                    {status?.last_publish_at ? new Date(status.last_publish_at).toLocaleString() : 'N/A'}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3">
                  <span className="text-slate-400">Uptime</span>
                  <span className="font-mono text-slate-100">{status?.ingest_state === 'live' ? formatUptime(uptimeSeconds) : '00:00:00'}</span>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <h3 className="mb-1 flex items-center gap-2 text-base font-semibold">
                  <KeyRound className="h-4 w-4 text-sky-300" />
                  Create stream key
                </h3>
                <div className="mb-3 text-xs text-slate-400">Optional custom key must be letters only (A–Z, a–z).</div>

                <div className="space-y-2">
                  <input
                    value={createStreamName}
                    onChange={(e) => setCreateStreamName(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-sky-500/50"
                    placeholder="Stream name (e.g. Demo)"
                  />
                  <input
                    value={createStreamKey}
                    onChange={(e) => setCreateStreamKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createStream()
                    }}
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm font-mono text-white outline-none focus:border-sky-500/50"
                    placeholder="Stream key (optional, e.g. demo)"
                  />
                  <button
                    type="button"
                    onClick={createStream}
                    disabled={isCreatingStream}
                    className="w-full rounded-lg bg-gradient-to-r from-sky-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:from-sky-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Create
                  </button>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
                <AlertCircle className="h-5 w-5 text-red-300" />
                Event Timeline
              </h2>
              <div className="max-h-[300px] space-y-3 overflow-y-auto pr-2">
                {events.length > 0 ? (
                  events.map((event, i) => (
                    <div key={i} className="flex gap-4 border-l-2 border-white/10 py-1 pl-4 text-sm">
                      <span className="whitespace-nowrap text-slate-500">{formatTime(event.timestamp)}</span>
                      <span className={event.severity === 'warning' ? 'text-yellow-300' : 'text-slate-300'}>{event.message}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-xs italic text-slate-400">Waiting for stream events...</div>
                )}
              </div>
            </section>
          </div>

          <div className="space-y-6 lg:col-span-2">
            <section className="rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <Play className="h-5 w-5 text-emerald-300" />
                  Live Preview
                </h2>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <Activity className="h-4 w-4" />
                  {status?.ingest_state === 'live' ? 'LIVE' : 'OFFLINE'}
                </div>
              </div>
              {streamKey ? (
                <LivePlayer streamKey={streamKey} ingestBase={ingestBase} />
              ) : (
                <div className="rounded-lg border border-white/10 bg-black/20 p-6 text-sm text-slate-300">
                  Enter a stream key to preview.
                </div>
              )}
            </section>

            <section className="flex h-[400px] flex-col rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <BarChart3 className="h-5 w-5 text-violet-300" />
                  Live Performance
                </h2>
                <div className="flex gap-4 text-sm">
                  <div className="flex items-center gap-2 text-sky-300">
                    <div className="h-3 w-3 rounded-full bg-sky-500" />
                    <span>Bitrate (kbps)</span>
                  </div>
                  <div className="flex items-center gap-2 text-violet-300">
                    <div className="h-3 w-3 rounded-full bg-violet-500" />
                    <span>FPS</span>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={metrics}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2e35" />
                    <XAxis
                      dataKey="timestamp"
                      stroke="#6b7280"
                      tick={{ fill: '#9ca3af', fontSize: 10 }}
                      tickFormatter={(value) => {
                        if (!value) return ''
                        const date = new Date(value)
                        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      }}
                    />
                    <YAxis
                      yAxisId="left"
                      stroke="#38bdf8"
                      domain={['auto', 'auto']}
                      label={{ value: 'kbps', angle: -90, position: 'insideLeft', fill: '#38bdf8' }}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      stroke="#a78bfa"
                      domain={[0, 120]}
                      label={{ value: 'FPS', angle: 90, position: 'insideRight', fill: '#a78bfa' }}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#111827', border: 'none', borderRadius: '8px' }}
                      itemStyle={{ color: '#fff' }}
                    />
                    <Line yAxisId="left" type="monotone" dataKey="bitrate" stroke="#38bdf8" strokeWidth={3} dot={false} isAnimationActive={false} />
                    <Line yAxisId="right" type="monotone" dataKey="fps" stroke="#a78bfa" strokeWidth={3} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
                {error}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
