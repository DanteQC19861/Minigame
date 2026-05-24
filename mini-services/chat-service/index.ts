import { createServer } from 'http'
import { Server } from 'socket.io'

const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ─── Types ──────────────────────────────────
interface OnlineUser {
  id: string
  socketId: string
  username: string
  avatar: string
  level: number
  vipPlan: string
  currentRoom: string
}

interface ChatMessage {
  id: string
  userId: string
  username: string
  avatar: string
  content: string
  type: 'text' | 'system' | 'emote' | 'trade' | 'level_up' | 'achievement'
  room: string
  timestamp: Date
  level?: number
  vipPlan?: string
}

interface Room {
  id: string
  name: string
  type: 'public' | 'private' | 'trade' | 'vip'
  users: Set<string>
  maxUsers: number
  minLevel: number
}

// ─── State ──────────────────────────────────
const onlineUsers = new Map<string, OnlineUser>()
const rooms = new Map<string, Room>()
const typingUsers = new Map<string, Set<string>>()
const rateLimiter = new Map<string, { count: number; lastReset: number }>()
const messageHistory = new Map<string, ChatMessage[]>()
const MAX_HISTORY = 50
const RATE_LIMIT = 15 // messages per 10 seconds
const RATE_WINDOW = 10000 // 10 seconds

// ─── Initialize Default Rooms ───────────────
const defaultRooms: Room[] = [
  { id: 'general', name: 'General', type: 'public', users: new Set(), maxUsers: 200, minLevel: 1 },
  { id: 'trade', name: 'Intercambio', type: 'trade', users: new Set(), maxUsers: 100, minLevel: 3 },
  { id: 'vip', name: 'Sala VIP', type: 'vip', users: new Set(), maxUsers: 50, minLevel: 5 },
  { id: 'games', name: 'Juegos', type: 'public', users: new Set(), maxUsers: 200, minLevel: 1 },
  { id: 'mining', name: 'Minería', type: 'public', users: new Set(), maxUsers: 150, minLevel: 2 },
]

defaultRooms.forEach(room => rooms.set(room.id, room))

// ─── Helpers ────────────────────────────────
const generateId = () => Math.random().toString(36).substr(2, 12)

const createSystemMessage = (content: string, room: string): ChatMessage => ({
  id: generateId(),
  userId: 'system',
  username: 'Sistema',
  avatar: '/avatars/system.png',
  content,
  type: 'system',
  room,
  timestamp: new Date(),
})

const addToHistory = (room: string, message: ChatMessage) => {
  if (!messageHistory.has(room)) {
    messageHistory.set(room, [])
  }
  const history = messageHistory.get(room)!
  history.push(message)
  if (history.length > MAX_HISTORY) {
    history.shift()
  }
}

const checkRateLimit = (socketId: string): boolean => {
  const now = Date.now()
  const entry = rateLimiter.get(socketId)
  if (!entry || now - entry.lastReset > RATE_WINDOW) {
    rateLimiter.set(socketId, { count: 1, lastReset: now })
    return true
  }
  if (entry.count >= RATE_LIMIT) {
    return false
  }
  entry.count++
  return true
}

const sanitizeContent = (content: string): string => {
  return content
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .substring(0, 500)
}

// ─── Socket Handlers ────────────────────────
io.on('connection', (socket) => {
  console.log(`[Chat] Connection: ${socket.id}`)

  // ── Authenticate ──
  socket.on('auth', (data: { userId: string; username: string; avatar: string; level: number; vipPlan: string }) => {
    const { userId, username, avatar, level, vipPlan } = data

    // Check if user already connected
    const existingUser = Array.from(onlineUsers.values()).find(u => u.id === userId)
    if (existingUser) {
      io.sockets.sockets.get(existingUser.socketId)?.disconnect(true)
      onlineUsers.delete(existingUser.socketId)
    }

    const user: OnlineUser = {
      id: userId,
      socketId: socket.id,
      username,
      avatar,
      level,
      vipPlan,
      currentRoom: 'general',
    }

    onlineUsers.set(socket.id, user)

    // Join default room
    socket.join('general')
    rooms.get('general')?.users.add(socket.id)

    // Send initial data
    const roomList = Array.from(rooms.values()).map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      userCount: r.users.size,
      maxUsers: r.maxUsers,
      minLevel: r.minLevel,
    }))

    socket.emit('init', {
      rooms: roomList,
      onlineUsers: Array.from(onlineUsers.values()).map(u => ({
        id: u.id,
        username: u.username,
        avatar: u.avatar,
        level: u.level,
        vipPlan: u.vipPlan,
      })),
      history: messageHistory.get('general') || [],
    })

    // Broadcast join
    const joinMsg = createSystemMessage(`${username} se unió al chat`, 'general')
    addToHistory('general', joinMsg)
    io.to('general').emit('user-joined', {
      user: { id: userId, username, avatar, level, vipPlan },
      message: joinMsg,
      onlineCount: onlineUsers.size,
    })

    io.emit('online-count', { count: onlineUsers.size })
    console.log(`[Chat] ${username} joined (Level ${level}, ${vipPlan})`)
  })

  // ── Send Message ──
  socket.on('message', (data: { content: string; room?: string }) => {
    const user = onlineUsers.get(socket.id)
    if (!user) return socket.emit('error', { message: 'No autenticado' })

    if (!checkRateLimit(socket.id)) {
      return socket.emit('error', { message: 'Demasiados mensajes. Espera un momento.' })
    }

    const room = data.room || user.currentRoom
    const roomData = rooms.get(room)
    if (!roomData) return socket.emit('error', { message: 'Sala no encontrada' })

    // Check level requirement
    if (user.level < roomData.minLevel) {
      return socket.emit('error', { message: `Necesitas nivel ${roomData.minLevel} para entrar a esta sala` })
    }

    // Check VIP room access
    if (roomData.type === 'vip' && user.vipPlan === 'free') {
      return socket.emit('error', { message: 'Esta sala es solo para usuarios VIP' })
    }

    const content = sanitizeContent(data.content)
    if (!content) return

    // Detect special message types
    let type: ChatMessage['type'] = 'text'
    if (content.startsWith('/emote ') || content.startsWith('/me ')) {
      type = 'emote'
    } else if (content.startsWith('/trade ')) {
      type = 'trade'
    }

    const message: ChatMessage = {
      id: generateId(),
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      content: type === 'emote' ? content.replace(/^\/(emote|me)\s+/, '') : content.replace(/^\/trade\s+/, ''),
      type,
      room,
      timestamp: new Date(),
      level: user.level,
      vipPlan: user.vipPlan,
    }

    addToHistory(room, message)
    io.to(room).emit('message', message)

    // Clear typing indicator
    const typingSet = typingUsers.get(room)
    if (typingSet) {
      typingSet.delete(socket.id)
      io.to(room).emit('typing', { users: Array.from(typingSet).map(sid => onlineUsers.get(sid)?.username).filter(Boolean) })
    }
  })

  // ── Join Room ──
  socket.on('join-room', (data: { roomId: string }) => {
    const user = onlineUsers.get(socket.id)
    if (!user) return

    const targetRoom = rooms.get(data.roomId)
    if (!targetRoom) return socket.emit('error', { message: 'Sala no encontrada' })

    if (user.level < targetRoom.minLevel) {
      return socket.emit('error', { message: `Necesitas nivel ${targetRoom.minLevel}` })
    }

    if (targetRoom.type === 'vip' && user.vipPlan === 'free') {
      return socket.emit('error', { message: 'Solo usuarios VIP' })
    }

    if (targetRoom.users.size >= targetRoom.maxUsers) {
      return socket.emit('error', { message: 'Sala llena' })
    }

    // Leave current room
    const currentRoom = rooms.get(user.currentRoom)
    if (currentRoom) {
      currentRoom.users.delete(socket.id)
      socket.leave(user.currentRoom)
      const leaveMsg = createSystemMessage(`${user.username} salió de la sala`, user.currentRoom)
      addToHistory(user.currentRoom, leaveMsg)
      io.to(user.currentRoom).emit('user-left-room', {
        user: { id: user.id, username: user.username },
        message: leaveMsg,
      })
    }

    // Join new room
    socket.join(data.roomId)
    targetRoom.users.add(socket.id)
    user.currentRoom = data.roomId

    const joinMsg = createSystemMessage(`${user.username} se unió a la sala`, data.roomId)
    addToHistory(data.roomId, joinMsg)

    socket.emit('room-joined', {
      room: { id: data.roomId, name: targetRoom.name, type: targetRoom.type },
      history: messageHistory.get(data.roomId) || [],
    })

    io.to(data.roomId).emit('user-joined-room', {
      user: { id: user.id, username: user.username, avatar: user.avatar, level: user.level },
      message: joinMsg,
    })

    // Update room list for all
    io.emit('rooms-update', Array.from(rooms.values()).map(r => ({
      id: r.id, name: r.name, type: r.type,
      userCount: r.users.size, maxUsers: r.maxUsers, minLevel: r.minLevel,
    })))
  })

  // ── Typing Indicator ──
  socket.on('typing', (data: { room: string; isTyping: boolean }) => {
    const user = onlineUsers.get(socket.id)
    if (!user) return

    const room = data.room || user.currentRoom
    if (!typingUsers.has(room)) {
      typingUsers.set(room, new Set())
    }

    const typingSet = typingUsers.get(room)!
    if (data.isTyping) {
      typingSet.add(socket.id)
    } else {
      typingSet.delete(socket.id)
    }

    io.to(room).emit('typing', {
      users: Array.from(typingSet).map(sid => onlineUsers.get(sid)?.username).filter(Boolean),
    })
  })

  // ── Private Message ──
  socket.on('private-message', (data: { targetUserId: string; content: string }) => {
    const user = onlineUsers.get(socket.id)
    if (!user) return

    if (!checkRateLimit(socket.id)) {
      return socket.emit('error', { message: 'Rate limit' })
    }

    const target = Array.from(onlineUsers.values()).find(u => u.id === data.targetUserId)
    if (!target) return socket.emit('error', { message: 'Usuario no encontrado' })

    const content = sanitizeContent(data.content)
    if (!content) return

    const message: ChatMessage = {
      id: generateId(),
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      content,
      type: 'text',
      room: 'private',
      timestamp: new Date(),
      level: user.level,
      vipPlan: user.vipPlan,
    }

    io.to(target.socketId).emit('private-message', { ...message, isIncoming: true })
    socket.emit('private-message', { ...message, isIncoming: false, targetUsername: target.username })
  })

  // ── Game Notification Broadcast ──
  socket.on('game-event', (data: { type: string; message: string; room?: string }) => {
    const user = onlineUsers.get(socket.id)
    if (!user) return

    const room = data.room || 'general'
    const msg = createSystemMessage(`🎮 ${user.username}: ${data.message}`, room)
    msg.type = 'achievement'
    addToHistory(room, msg)
    io.to(room).emit('message', msg)
  })

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id)
    if (user) {
      // Remove from room
      const room = rooms.get(user.currentRoom)
      if (room) {
        room.users.delete(socket.id)
        const leaveMsg = createSystemMessage(`${user.username} salió del chat`, user.currentRoom)
        addToHistory(user.currentRoom, leaveMsg)
        io.to(user.currentRoom).emit('user-left', {
          user: { id: user.id, username: user.username },
          message: leaveMsg,
          onlineCount: onlineUsers.size - 1,
        })
      }

      onlineUsers.delete(socket.id)

      // Clean up typing
      typingUsers.forEach((set) => set.delete(socket.id))

      io.emit('online-count', { count: onlineUsers.size })
      console.log(`[Chat] ${user.username} disconnected`)
    }
  })

  socket.on('error', (error) => {
    console.error(`[Chat] Socket error (${socket.id}):`, error)
  })
})

// ─── Start Server ───────────────────────────
const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`[Chat Service] WebSocket server running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[Chat Service] SIGTERM received, shutting down...')
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[Chat Service] SIGINT received, shutting down...')
  httpServer.close(() => process.exit(0))
})
