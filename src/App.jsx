import React, { useEffect, useMemo, useRef, useState } from 'react'
import { SelfieSegmentation } from '@mediapipe/selfie_segmentation'

function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function encodeSvg(svg) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

function makePreset(name, a, b, c, d) {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${a}" />
        <stop offset="55%" stop-color="${b}" />
        <stop offset="100%" stop-color="${c}" />
      </linearGradient>
      <filter id="blur">
        <feGaussianBlur stdDeviation="42" />
      </filter>
    </defs>
    <rect width="1280" height="720" fill="${d}" />
    <circle cx="180" cy="110" r="180" fill="${a}" opacity="0.22" filter="url(#blur)" />
    <circle cx="1140" cy="160" r="220" fill="${b}" opacity="0.2" filter="url(#blur)" />
    <circle cx="980" cy="610" r="280" fill="${c}" opacity="0.18" filter="url(#blur)" />
    <rect width="1280" height="720" fill="url(#g)" opacity="0.18" />
    <path d="M0 540 C 220 470, 390 650, 640 570 S 1060 460, 1280 560 L 1280 720 L 0 720 Z" fill="rgba(255,255,255,0.06)" />
    <path d="M0 600 C 180 530, 420 700, 680 620 S 1030 560, 1280 650 L 1280 720 L 0 720 Z" fill="rgba(0,0,0,0.14)" />
  </svg>`
  return { name, src: encodeSvg(svg) }
}

const PRESETS = [
  makePreset('Midnight', '#0f172a', '#4f46e5', '#14b8a6', '#050816'),
  makePreset('Aurora', '#8b5cf6', '#22c55e', '#06b6d4', '#08111f'),
  makePreset('Slate', '#1e293b', '#334155', '#0f766e', '#0b1020'),
  makePreset('Ember', '#fb7185', '#f97316', '#8b5cf6', '#120b11')
]

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
]

function useRoomPath() {
  const [pathState, setPathState] = useState({ roomId: null, token: null })
  useEffect(() => {
    const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)/)
    const roomId = match?.[1] || null
    const token = new URLSearchParams(window.location.search).get('t')
    setPathState({ roomId, token })
  }, [])
  return pathState
}

async function createRoom({ name, title }) {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, title })
  })
  if (!res.ok) throw new Error('Unable to create room')
  return res.json()
}

function buildWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

function useVirtualBackground(cameraStream, enabled, preset) {
  const [stream, setStream] = useState(null)
  const canvasRef = useRef(null)
  const videoRef = useRef(null)
  const rafRef = useRef(0)
  const segRef = useRef(null)

  useEffect(() => {
    if (!cameraStream) return
    const video = videoRef.current
    if (!video) return
    video.srcObject = cameraStream
    video.play().catch(() => {})
  }, [cameraStream])

  useEffect(() => {
    if (!cameraStream) {
      setStream(null)
      return
    }

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) {
      setStream(cameraStream)
      return
    }

    const track = cameraStream.getVideoTracks()[0]
    if (!enabled || !preset) {
      setStream(cameraStream)
      return
    }

    const ctx = canvas.getContext('2d', { alpha: false })
    let cancelled = false
    const bg = new Image()
    bg.src = preset.src

    const seg = new SelfieSegmentation({
      locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
    })

    seg.setOptions({ modelSelection: 1 })
    seg.onResults(results => {
      if (cancelled) return
      const width = results.image.videoWidth || results.image.width || 1280
      const height = results.image.videoHeight || results.image.height || 720
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height

      ctx.save()
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(bg, 0, 0, width, height)
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(results.segmentationMask, 0, 0, width, height)
      ctx.globalCompositeOperation = 'destination-over'
      ctx.drawImage(results.image, 0, 0, width, height)
      ctx.restore()
    })

    segRef.current = seg

    const loop = async () => {
      if (cancelled) return
      if (video.readyState >= 2) await seg.send({ image: video })
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)

    const canvasStream = canvas.captureStream(30)
    const audioTracks = cameraStream.getAudioTracks()
    const merged = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks])
    setStream(merged)

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      try { seg.close() } catch {}
      segRef.current = null
    }
  }, [cameraStream, enabled, preset])

  return { stream, videoRef, canvasRef }
}

function App() {
  const { roomId, token } = useRoomPath()
  const [name, setName] = useState(() => localStorage.getItem('meet-name') || '')
  const [roomMeta, setRoomMeta] = useState(null)
  const [invite, setInvite] = useState(() => ({ roomId, token }))
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [screen, setScreen] = useState('lobby')

  useEffect(() => {
    if (roomId && token) setScreen('room')
  }, [roomId, token])

  if (screen === 'room' && invite.roomId && invite.token) {
    return <RoomPage initialRoomId={invite.roomId} initialToken={invite.token} initialName={name} onLeave={() => setScreen('lobby')} onMeta={setRoomMeta} />
  }

  return (
    <Lobby
      name={name}
      setName={setName}
      onCreated={async (payload) => {
        setError('')
        localStorage.setItem('meet-name', name)
        setInvite({ roomId: payload.roomId, token: payload.token })
        window.history.pushState({}, '', `/room/${payload.roomId}?t=${encodeURIComponent(payload.token)}`)
        setScreen('room')
      }}
      onJoin={(roomId, tokenValue) => {
        setInvite({ roomId, token: tokenValue })
        window.history.pushState({}, '', `/room/${roomId}?t=${encodeURIComponent(tokenValue)}`)
        setScreen('room')
      }}
      error={error}
      setError={setError}
    />
  )
}

function Lobby({ name, setName, onCreated, onJoin, error, setError }) {
  const [roomCode, setRoomCode] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [title, setTitle] = useState('')

  return (
    <div className="join-wrap">
      <div className="join-box">
        <div className="card">
          <div className="stack">
            <div>
              <div className="badge"><span className="dot on" /> Open-source meeting room</div>
              <h2 style={{ marginTop: 12, fontSize: 36, lineHeight: 1.05 }}>Meet, share, and talk without accounts</h2>
              <p style={{ marginTop: 12 }}>Create a private room, send the invite link, and join with camera, microphone, screen share, noise suppression, echo cancellation, and background presets.</p>
            </div>
            <div className="input-row">
              <input className="input" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
              <input className="input" placeholder="Room title (optional)" value={title} onChange={e => setTitle(e.target.value)} />
              <button className="btn" onClick={async () => {
                if (!name.trim()) return setError('Please enter your name')
                try {
                  const payload = await createRoom({ name, title })
                  onCreated(payload)
                } catch (e) {
                  setError(e.message)
                }
              }}>Create room</button>
            </div>
            {error ? <div className="badge" style={{ color: '#fecaca', borderColor: 'rgba(239,68,68,0.3)' }}>{error}</div> : null}
          </div>
        </div>

        <div className="card">
          <div className="stack">
            <div>
              <h3>Join an existing room</h3>
              <p>Paste the room code and invite token from the link.</p>
            </div>
            <div className="input-row">
              <input className="input" placeholder="Room code" value={roomCode} onChange={e => setRoomCode(e.target.value)} />
              <textarea className="textarea" placeholder="Invite token" value={inviteToken} onChange={e => setInviteToken(e.target.value)} />
              <button className="btn secondary" onClick={() => {
                if (!roomCode.trim() || !inviteToken.trim()) return setError('Room code and invite token are required')
                if (!name.trim()) return setError('Please enter your name')
                localStorage.setItem('meet-name', name)
                onJoin(roomCode.trim(), inviteToken.trim())
              }}>Join room</button>
            </div>
            <div className="mini">Tip: inside a room press <span className="kbd">Space</span> to hold-to-talk.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function RoomPage({ initialRoomId, initialToken, initialName, onLeave, onMeta }) {
  const [name, setName] = useState(initialName || '')
  const [roomId] = useState(initialRoomId)
  const [token] = useState(initialToken)
  const [selfId, setSelfId] = useState(null)
  const [room, setRoom] = useState(null)
  const [connected, setConnected] = useState(false)
  const [muted, setMuted] = useState(true)
  const [videoOn, setVideoOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [handRaised, setHandRaised] = useState(false)
  const [speaker, setSpeaker] = useState(false)
  const [cameraStream, setCameraStream] = useState(null)
  const [streamReady, setStreamReady] = useState(false)
  const [bgEnabled, setBgEnabled] = useState(true)
  const [bgPreset, setBgPreset] = useState(PRESETS[0])
  const [chatText, setChatText] = useState('')
  const [messages, setMessages] = useState([])
  const [participants, setParticipants] = useState([])
  const [status, setStatus] = useState('connecting')
  const [error, setError] = useState('')
  const [pushTalk, setPushTalk] = useState(false)
  const [layout, setLayout] = useState('auto')
  const [stats, setStats] = useState({ bitrate: 0, rtt: 0, packetLoss: 0 })

  const wsRef = useRef(null)
  const pcMap = useRef(new Map())
  const remoteStreams = useRef(new Map())
  const localVideoRef = useRef(null)
  const mainVideoRef = useRef(null)
  const shareVideoRef = useRef(null)
  const sendersRef = useRef({ audio: null, video: null })
  const currentStreamRef = useRef(null)
  const pollingRef = useRef(0)
  const activeShareRef = useRef(null)

  const { stream: processedStream, videoRef: bgVideoRef, canvasRef } = useVirtualBackground(cameraStream, bgEnabled, bgPreset)

  useEffect(() => {
    localStorage.setItem('meet-name', name)
  }, [name])

  useEffect(() => {
    const onKeyDown = e => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        setPushTalk(true)
      }
    }
    const onKeyUp = e => {
      if (e.code === 'Space') {
        e.preventDefault()
        setPushTalk(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const pc of pcMap.current.values()) {
        try { pc.close() } catch {}
      }
      pcMap.current.clear()
      try { wsRef.current?.close() } catch {}
      stopStream(cameraStream)
      if (activeShareRef.current) stopStream(activeShareRef.current)
    }
  }, [])

  useEffect(() => {
    if (!cameraStream) return
    const video = localVideoRef.current
    if (video) {
      video.srcObject = processedStream || cameraStream
      video.play().catch(() => {})
    }
  }, [cameraStream, processedStream])

  useEffect(() => {
    if (!processedStream) return
    currentStreamRef.current = processedStream
    replaceOutgoingTrack('video', processedStream.getVideoTracks()[0] || null)
    replaceOutgoingTrack('audio', processedStream.getAudioTracks()[0] || null)
  }, [processedStream])

  useEffect(() => {
    const run = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
          }
        })
        setCameraStream(stream)
        setStreamReady(true)
        setMuted(true)
      } catch (e) {
        setError('Camera or microphone permission is required')
      }
    }
    run()
  }, [])

  useEffect(() => {
    if (!roomId || !token || !name.trim() || !streamReady) return
    const ws = new WebSocket(buildWsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('joining')
      ws.send(JSON.stringify({
        type: 'join',
        roomId,
        token,
        name: name.trim()
      }))
    }

    ws.onmessage = async event => {
      const msg = JSON.parse(event.data)
      if (msg.type === 'joined') {
        setConnected(true)
        setRoom(msg.room)
        setSelfId(msg.self.id)
        const list = [
          { id: msg.self.id, name: msg.self.name, muted: true, video: true, handRaised: false, speaking: false, screen: false, self: true },
          ...msg.peers.map(p => ({ ...p, self: false }))
        ]
        setParticipants(list)
        onMeta?.(msg.room)
        setStatus('connected')
        for (const peer of msg.peers) {
          await ensurePeer(peer.id, true)
        }
        syncLocalState(ws)
        return
      }

      if (msg.type === 'peer-joined') {
        setParticipants(prev => {
          const exists = prev.some(p => p.id === msg.peer.id)
          return exists ? prev : [...prev, { ...msg.peer, self: false }]
        })
        return
      }

      if (msg.type === 'peer-left') {
        setParticipants(prev => prev.filter(p => p.id !== msg.peerId))
        const pc = pcMap.current.get(msg.peerId)
        if (pc) {
          try { pc.close() } catch {}
          pcMap.current.delete(msg.peerId)
        }
        remoteStreams.current.delete(msg.peerId)
        setRemoteTick(t => t + 1)
        return
      }

      if (msg.type === 'state') {
        setParticipants(prev => prev.map(p => p.id === msg.peerId ? { ...p, muted: msg.muted, video: msg.video, handRaised: msg.handRaised, speaking: msg.speaking, screen: msg.screen, name: msg.name } : p))
        return
      }

      if (msg.type === 'chat') {
        setMessages(prev => [...prev, msg].slice(-100))
        return
      }

      if (msg.type === 'signal') {
        await handleSignal(msg.from, msg.data)
        return
      }

      if (msg.type === 'error') {
        setError(msg.message || 'Something went wrong')
      }
    }

    ws.onerror = () => setStatus('error')
    ws.onclose = () => setConnected(false)

    const tick = setInterval(async () => {
      try {
        const s = await collectStats()
        if (s) setStats(s)
      } catch {}
    }, 5000)
    pollingRef.current = tick

    return () => {
      clearInterval(tick)
      try { ws.close() } catch {}
    }
  }, [roomId, token, name, streamReady])

  function stopStream(stream) {
    if (!stream) return
    for (const track of stream.getTracks()) track.stop()
  }

  function syncLocalState(ws = wsRef.current) {
    if (!ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({
      type: 'state',
      name: name.trim(),
      muted,
      video: videoOn,
      handRaised,
      speaking: pushTalk || speaker,
      screen: sharing
    }))
  }

  function replaceOutgoingTrack(kind, track) {
    for (const pc of pcMap.current.values()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === kind)
      if (sender) sender.replaceTrack(track).catch(() => {})
    }
  }

  function createPeerConnection(peerId) {
    if (pcMap.current.has(peerId)) return pcMap.current.get(peerId)
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcMap.current.set(peerId, pc)

    const local = currentStreamRef.current || processedStream || cameraStream
    if (local) {
      for (const track of local.getTracks()) pc.addTrack(track, local)
    }

    pc.onicecandidate = ev => {
      if (ev.candidate) sendSignal(peerId, { candidate: ev.candidate })
    }

    pc.ontrack = ev => {
      const stream = ev.streams[0] || new MediaStream([ev.track])
      remoteStreams.current.set(peerId, stream)
      setRemoteTick(t => t + 1)
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        setParticipants(prev => prev.map(p => p.id === peerId ? { ...p, disconnected: true } : p))
      }
    }

    return pc
  }

  async function ensurePeer(peerId, createOffer = false) {
    const pc = createPeerConnection(peerId)
    if (createOffer) {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      })
      await pc.setLocalDescription(offer)
      sendSignal(peerId, { description: pc.localDescription })
    }
    return pc
  }

  async function handleSignal(from, data) {
    const pc = createPeerConnection(from)
    if (data.description) {
      const desc = data.description
      const collision = desc.type === 'offer' && pc.signalingState !== 'stable'
      if (collision) return
      await pc.setRemoteDescription(desc)
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendSignal(from, { description: pc.localDescription })
      }
      return
    }
    if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate)
      } catch {}
    }
  }

  function sendSignal(to, data) {
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'signal', to, data }))
  }

  async function collectStats() {
    let selectedPc = null
    for (const pc of pcMap.current.values()) {
      if (pc.connectionState === 'connected') {
        selectedPc = pc
        break
      }
    }
    if (!selectedPc) return null
    const stats = await selectedPc.getStats()
    let outbound = null
    let inbound = null
    stats.forEach(report => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') outbound = report
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) inbound = report
    })
    return {
      bitrate: outbound?.bytesSent ? Math.round(outbound.bytesSent / 1024) : 0,
      rtt: inbound?.currentRoundTripTime ? Math.round(inbound.currentRoundTripTime * 1000) : 0,
      packetLoss: outbound?.packetsLost || 0
    }
  }

  async function toggleMute() {
    if (!cameraStream) return
    const next = !muted
    setMuted(next)
    for (const track of cameraStream.getAudioTracks()) track.enabled = !next
    syncLocalState()
  }

  async function toggleVideo() {
    if (!cameraStream) return
    const next = !videoOn
    setVideoOn(next)
    for (const track of cameraStream.getVideoTracks()) track.enabled = next
    syncLocalState()
  }

  async function startScreenShare() {
    try {
      const share = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      })
      activeShareRef.current = share
      const shareTrack = share.getVideoTracks()[0]
      if (shareTrack) {
        setSharing(true)
        replaceOutgoingTrack('video', shareTrack)
        shareTrack.onended = () => stopScreenShare()
        const video = shareVideoRef.current
        if (video) {
          video.srcObject = share
          video.play().catch(() => {})
        }
        syncLocalState()
      }
    } catch {
      setSharing(false)
    }
  }

  function stopScreenShare() {
    const share = activeShareRef.current
    activeShareRef.current = null
    if (share) stopStream(share)
    setSharing(false)
    const local = currentStreamRef.current || processedStream || cameraStream
    const track = local?.getVideoTracks?.()[0] || cameraStream?.getVideoTracks?.()[0] || null
    replaceOutgoingTrack('video', track)
    syncLocalState()
  }

  function toggleHand() {
    const next = !handRaised
    setHandRaised(next)
    syncLocalState()
  }

  function sendChat() {
    const text = chatText.trim()
    if (!text) return
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'chat', text }))
    setChatText('')
  }

  useEffect(() => {
    if (!cameraStream) return
    const audioTracks = cameraStream.getAudioTracks()
    for (const track of audioTracks) track.enabled = !muted
  }, [muted, cameraStream])

  useEffect(() => {
    if (!cameraStream) return
    const videoTracks = cameraStream.getVideoTracks()
    for (const track of videoTracks) track.enabled = videoOn
  }, [videoOn, cameraStream])

  useEffect(() => {
    if (!cameraStream) return
    if (pushTalk) {
      setSpeaker(true)
      for (const track of cameraStream.getAudioTracks()) track.enabled = true
    } else {
      setSpeaker(false)
      for (const track of cameraStream.getAudioTracks()) track.enabled = !muted
    }
    syncLocalState()
  }, [pushTalk])

  const remoteList = [...participants].filter(p => !p.self)
  const [remoteTick, setRemoteTick] = useState(0)

  const mainTileStream = sharing && activeShareRef.current ? activeShareRef.current : (processedStream || cameraStream)

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <div className="logo" />
          <div>
            <h1>Open Meet</h1>
            <p>{room?.title || `Room ${roomId}`} · {connected ? 'Live' : status}</p>
          </div>
        </div>
        <div className="row">
          <div className="badge"><span className={`dot ${connected ? 'on' : 'warn'}`} /> {roomId}</div>
          <button className="btn secondary" onClick={async () => {
            const link = `${window.location.origin}/room/${roomId}?t=${encodeURIComponent(token)}`
            await navigator.clipboard.writeText(link)
          }}>Copy invite link</button>
          <button className="btn danger" onClick={() => {
            wsRef.current?.send(JSON.stringify({ type: 'leave' }))
            onLeave?.()
            window.location.href = '/'
          }}>Leave</button>
        </div>
      </div>

      <div className="layout">
        <div className="main-panel">
          <div className="hero">
            <div className="stack">
              <div className="preview">
                <video ref={localVideoRef} autoPlay playsInline muted />
                <div className="label">You · {name || 'Guest'}</div>
              </div>

              <div className="card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Video area</h3>
                    <div className="mini">Grid auto-adapts to participant count, like the clean tile layout style you asked for.</div>
                  </div>
                  <div className="badge">Layout: {layout}</div>
                </div>
              </div>

              <div className="grid">
                {remoteList.length === 0 ? (
                  <div className="card">
                    <h3>No one else is here yet</h3>
                    <p>Send the invite link and the room will fill automatically.</p>
                  </div>
                ) : remoteList.map((peer, idx) => (
                  <RemoteTile
                    key={`${peer.id}-${remoteTick}`}
                    peer={peer}
                    stream={remoteStreams.current.get(peer.id)}
                    self={peer.self}
                  />
                ))}
              </div>
            </div>

            <div className="stack">
              <div className="card">
                <h3>Background presets</h3>
                <p>Replace your background with one of the prepared scenes.</p>
                <div className="preset-grid" style={{ marginTop: 14 }}>
                  {PRESETS.map(p => (
                    <div
                      key={p.name}
                      className={`preset ${bgPreset?.name === p.name ? 'active' : ''}`}
                      onClick={() => setBgPreset(p)}
                    >
                      <img className="thumb" src={p.src} alt={p.name} />
                      <div className="name">{p.name}</div>
                    </div>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className={`btn ${bgEnabled ? '' : 'secondary'}`} onClick={() => setBgEnabled(v => !v)}>
                    {bgEnabled ? 'Background on' : 'Background off'}
                  </button>
                  <button className="btn secondary" onClick={() => setLayout(prev => prev === 'auto' ? 'speaker' : 'auto')}>Toggle layout</button>
                </div>
              </div>

              <div className="card">
                <h3>Quality</h3>
                <div className="list">
                  <div className="person"><div className="meta"><strong>Bitrate</strong><span>{stats.bitrate} KB sent</span></div><span className="badge"><span className="dot on" /> live</span></div>
                  <div className="person"><div className="meta"><strong>RTT</strong><span>{stats.rtt} ms</span></div></div>
                  <div className="person"><div className="meta"><strong>Packet loss</strong><span>{stats.packetLoss}</span></div></div>
                </div>
              </div>

              <div className="card">
                <h3>Participants</h3>
                <div className="list">
                  {participants.map(p => (
                    <div className="person" key={p.id}>
                      <div className="meta">
                        <strong>{p.name}{p.self ? ' (you)' : ''}</strong>
                        <span>{p.muted ? 'Muted' : 'Speaking'} · {p.video ? 'Camera on' : 'Camera off'}</span>
                      </div>
                      <div className="row">
                        {p.handRaised ? <span className="badge">Hand up</span> : null}
                        {p.screen ? <span className="badge">Sharing</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="side-panel">
          <div className="sidebar-head">
            <div>
              <strong>Room tools</strong>
              <div className="mini">Chat, mic controls, and secure invite flow</div>
            </div>
            <div className="badge"><span className={`dot ${connected ? 'on' : ''}`} /> {status}</div>
          </div>

          <div className="sidebar-body">
            <div className="chat">
              <div className="chat-log">
                {messages.length === 0 ? <div className="mini">No chat yet.</div> : messages.map(m => (
                  <div className="msg" key={m.id}>
                    <div className="who">{m.name}</div>
                    <div className="txt">{m.text}</div>
                  </div>
                ))}
              </div>
              <div className="row">
                <input className="input" placeholder="Type a message" value={chatText} onChange={e => setChatText(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendChat()} />
                <button className="btn secondary" onClick={sendChat}>Send</button>
              </div>
            </div>

            <div className="card" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <h4>Mic behavior</h4>
              <p>Hold <span className="kbd">Space</span> or the talk button to speak while your mic stays muted.</p>
            </div>

            <div className="gallery">
              <video ref={bgVideoRef} muted playsInline autoPlay style={{ display: 'none' }} />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>
          </div>
        </aside>
      </div>

      <div className="bottom-bar">
        <button className={`icon-btn ${muted ? 'off' : 'active'}`} onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
        <button className={`icon-btn ${videoOn ? 'active' : 'off'}`} onClick={toggleVideo}>{videoOn ? 'Camera on' : 'Camera off'}</button>
        <button className={`icon-btn ${sharing ? 'active' : ''}`} onClick={sharing ? stopScreenShare : startScreenShare}>{sharing ? 'Stop share' : 'Share screen'}</button>
        <button className={`icon-btn ${handRaised ? 'active' : ''}`} onClick={toggleHand}>{handRaised ? 'Hand up' : 'Raise hand'}</button>
        <button
          className={`icon-btn ${pushTalk ? 'active' : ''}`}
          onPointerDown={() => setPushTalk(true)}
          onPointerUp={() => setPushTalk(false)}
          onPointerLeave={() => setPushTalk(false)}
        >
          Push to talk
        </button>
        <button className="icon-btn secondary" onClick={() => navigator.clipboard.writeText(`${window.location.origin}/room/${roomId}?t=${encodeURIComponent(token)}`)}>Copy invite</button>
      </div>
    </div>
  )
}

function RemoteTile({ peer, stream }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !stream) return
    ref.current.srcObject = stream
    ref.current.play().catch(() => {})
  }, [stream])

  return (
    <div className={`tile ${peer.self ? 'me' : ''}`}>
      <video ref={ref} autoPlay playsInline muted={false} />
      <div className="name">{peer.name}</div>
      <div className="state">
        <span className={`dot ${peer.muted ? '' : 'on'}`} />
        {peer.muted ? 'Muted' : 'Live'}
      </div>
    </div>
  )
}


export default App