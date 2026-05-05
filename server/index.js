import 'dotenv/config'
import express from 'express'
import http from 'http'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { WebSocketServer } from 'ws'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const server = http.createServer(app)

const PORT = Number(process.env.PORT || 3001)
const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173'
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-in-production'
const MAX_ROOM_MINUTES = Number(process.env.MAX_ROOM_MINUTES || 180)
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || APP_ORIGIN).split(',').map(s => s.trim()).filter(Boolean)
)

app.use(helmet({
  contentSecurityPolicy: false
}))
app.use(express.json({ limit: '64kb' }))

app.use('/api/rooms', rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
}))

const rooms = new Map()

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signToken(payload) {
  const body = base64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload || typeof payload !== 'object') return null
    if (payload.exp && Date.now() > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

function randomId(len = 10) {
  return crypto.randomBytes(Math.ceil(len * 0.75)).toString('base64url').slice(0, len)
}

function sanitizeName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ')
  return n.slice(0, 32) || 'Guest'
}

function sanitizeRoomId(roomId) {
  return String(roomId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
}

function getPublicRoom(room) {
  return {
    roomId: room.roomId,
    title: room.title,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    count: room.peers.size
  }
}

function createRoom(title, creatorName) {
  const roomId = randomId(8)
  const now = Date.now()
  const room = {
    roomId,
    title: title || `${sanitizeName(creatorName)}'s room`,
    createdAt: now,
    expiresAt: now + MAX_ROOM_MINUTES * 60 * 1000,
    peers: new Map(),
    history: [],
    lastActivity: now
  }
  rooms.set(roomId, room)
  return room
}

function getRoom(roomId) {
  return rooms.get(roomId)
}

function broadcast(room, payload, exceptPeerId = null) {
  const message = JSON.stringify(payload)
  for (const [peerId, peer] of room.peers.entries()) {
    if (peerId === exceptPeerId) continue
    if (peer.socket.readyState === 1) peer.socket.send(message)
  }
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId)
  if (!room) return
  if (room.peers.size === 0 || Date.now() > room.expiresAt) rooms.delete(roomId)
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() })
})

app.post('/api/rooms', (req, res) => {
  const name = sanitizeName(req.body?.name)
  const title = sanitizeName(req.body?.title || '')
  const room = createRoom(title, name)
  const hostId = randomId(12)
  const payload = {
    roomId: room.roomId,
    role: 'host',
    userId: hostId,
    name,
    exp: room.expiresAt
  }
  const token = signToken(payload)
  room.history.push({ type: 'created', at: Date.now(), by: name })
  room.lastActivity = Date.now()
  res.json({
    roomId: room.roomId,
    token,
    title: room.title,
    joinUrl: `${APP_ORIGIN}/room/${room.roomId}?t=${encodeURIComponent(token)}`
  })
})

app.get('/api/rooms/:roomId', (req, res) => {
  const roomId = sanitizeRoomId(req.params.roomId)
  const room = getRoom(roomId)
  if (!room) return res.status(404).json({ error: 'Room not found' })
  res.json(getPublicRoom(room))
})

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(__dirname, '..', 'dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  if (!req.url?.startsWith('/ws')) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', ws => {
  ws.alive = true
  ws.peerId = null
  ws.roomId = null
  ws.user = null

  ws.on('pong', () => { ws.alive = true })

  ws.on('message', raw => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      ws.close(1003, 'Invalid JSON')
      return
    }

    const type = msg?.type

    if (type === 'join') {
      const roomId = sanitizeRoomId(msg.roomId)
      const token = String(msg.token || '')
      const name = sanitizeName(msg.name)
      const payload = verifyToken(token)

      if (!payload || payload.roomId !== roomId) {
        ws.send(JSON.stringify({ type: 'error', code: 'forbidden', message: 'Invalid invite token' }))
        ws.close(1008, 'Forbidden')
        return
      }

      const room = getRoom(roomId)
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', code: 'not_found', message: 'Room does not exist' }))
        ws.close(1008, 'Room not found')
        return
      }

      if (room.peers.size >= 16) {
        ws.send(JSON.stringify({ type: 'error', code: 'room_full', message: 'Room is full' }))
        ws.close(1013, 'Room full')
        return
      }

      const peerId = randomId(12)
      ws.peerId = peerId
      ws.roomId = roomId
      ws.user = { name, muted: true, video: true, handRaised: false, speaking: false, screen: false }

      room.peers.set(peerId, { socket: ws, ...ws.user })
      room.lastActivity = Date.now()

      const peers = [...room.peers.entries()]
        .filter(([id]) => id !== peerId)
        .map(([id, peer]) => ({ id, name: peer.name, muted: peer.muted, video: peer.video, handRaised: peer.handRaised, screen: peer.screen }))

      ws.send(JSON.stringify({
        type: 'joined',
        room: getPublicRoom(room),
        self: { id: peerId, name },
        peers
      }))

      broadcast(room, {
        type: 'peer-joined',
        peer: { id: peerId, name, muted: true, video: true, handRaised: false, screen: false }
      }, peerId)

      room.history.push({ type: 'joined', at: Date.now(), by: name })
      return
    }

    if (!ws.roomId || !ws.peerId) return
    const room = getRoom(ws.roomId)
    if (!room || !room.peers.has(ws.peerId)) return
    room.lastActivity = Date.now()

    if (type === 'signal') {
      const to = String(msg.to || '')
      const target = room.peers.get(to)
      if (!target) return
      target.socket.send(JSON.stringify({
        type: 'signal',
        from: ws.peerId,
        data: msg.data
      }))
      return
    }

    if (type === 'state') {
      const peer = room.peers.get(ws.peerId)
      if (!peer) return
      peer.muted = !!msg.muted
      peer.video = !!msg.video
      peer.handRaised = !!msg.handRaised
      peer.speaking = !!msg.speaking
      peer.screen = !!msg.screen
      peer.name = sanitizeName(msg.name || peer.name)
      broadcast(room, {
        type: 'state',
        peerId: ws.peerId,
        muted: peer.muted,
        video: peer.video,
        handRaised: peer.handRaised,
        speaking: peer.speaking,
        screen: peer.screen,
        name: peer.name
      }, ws.peerId)
      return
    }

    if (type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 500)
      if (!text) return
      const peer = room.peers.get(ws.peerId)
      if (!peer) return
      broadcast(room, {
        type: 'chat',
        id: randomId(12),
        from: ws.peerId,
        name: peer.name,
        text,
        at: Date.now()
      })
      return
    }

    if (type === 'leave') {
      ws.close(1000, 'Left')
    }
  })

  ws.on('close', () => {
    const roomId = ws.roomId
    const peerId = ws.peerId
    if (!roomId || !peerId) return
    const room = getRoom(roomId)
    if (!room) return
    const peer = room.peers.get(peerId)
    if (peer) {
      room.peers.delete(peerId)
      broadcast(room, { type: 'peer-left', peerId }, peerId)
      room.history.push({ type: 'left', at: Date.now(), by: peer.name })
    }
    cleanupRoom(roomId)
  })
})

setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    for (const [peerId, peer] of room.peers.entries()) {
      if (peer.socket.readyState !== 1) room.peers.delete(peerId)
    }
    if (Date.now() > room.expiresAt) {
      for (const [, peer] of room.peers.entries()) {
        try { peer.socket.close(1001, 'Room expired') } catch {}
      }
      rooms.delete(roomId)
      continue
    }
    if (room.peers.size === 0 && Date.now() - room.lastActivity > 60 * 1000) rooms.delete(roomId)
  }
}, 30000)

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) {
      try { ws.terminate() } catch {}
      continue
    }
    ws.alive = false
    try { ws.ping() } catch {}
  }
}, 30000)

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})