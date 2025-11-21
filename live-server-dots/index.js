// server/live-dots-server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4100;

// rooms: { roomId: { users: { socketId: userObj }, createdAt } }
const rooms = {};

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function randomPosition() {
  return { x: Math.floor(10 + Math.random() * 80), y: Math.floor(10 + Math.random() * 80) };
}

io.on('connection', (socket) => {
  console.log('live-dots: connected', socket.id);

  // default: not in any room until joinRoom/createRoom
  socket.data.roomId = null;

  // Create room and join
  socket.on('createRoom', ({ username }, cb) => {
    const roomId = makeRoomId();
    rooms[roomId] = { users: {}, createdAt: Date.now() };
    // let the same socket join after creation
    socket.join(roomId);
    socket.data.roomId = roomId;

    const pos = randomPosition();
    rooms[roomId].users[socket.id] = {
      id: socket.id,
      name: (username || 'Guest').slice(0,24),
      x: pos.x, y: pos.y,
      color: '#2c2c2c',
      connectedAt: Date.now()
    };

    // send init state to creator
    const state = { you: rooms[roomId].users[socket.id], users: rooms[roomId].users, roomId };
    cb && cb({ ok: true, roomId, state });

    // notify other (none yet)
    socket.to(roomId).emit('userJoined', rooms[roomId].users[socket.id]);
    console.log(`${socket.id} created room ${roomId}`);
  });

  // Join existing room
  socket.on('joinRoom', ({ roomId, username }, cb) => {
    const room = rooms[roomId];
    if (!room) {
      return cb && cb({ ok: false, error: 'Room not found' });
    }
    socket.join(roomId);
    socket.data.roomId = roomId;

    const pos = randomPosition();
    room.users[socket.id] = {
      id: socket.id,
      name: (username || 'Guest').slice(0,24),
      x: pos.x, y: pos.y,
      color: '#2c2c2c',
      connectedAt: Date.now()
    };

    // send init state to joiner
    const state = { you: room.users[socket.id], users: room.users, roomId };
    cb && cb({ ok: true, roomId, state });

    // broadcast presence to room
    io.to(roomId).emit('userJoined', room.users[socket.id]);
    io.to(roomId).emit('roomState', { users: room.users, roomId });
    console.log(`${socket.id} joined room ${roomId}`);
  });

  // setColor / setName operate within current room
  socket.on('setColor', ({ color }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (typeof color === 'string' && /^#([0-9a-fA-F]{6})$/.test(color)) {
      rooms[roomId].users[socket.id].color = color;
      io.to(roomId).emit('userUpdated', { id: socket.id, patch: { color } });
    }
  });

  socket.on('setName', ({ name }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const safe = String(name || '').slice(0,24);
    rooms[roomId].users[socket.id].name = safe;
    io.to(roomId).emit('userUpdated', { id: socket.id, patch: { name: safe } });
  });

  // movement: dx/dy or absolute x/y (percent)
  socket.on('move', ({ dx, dy, x: absX, y: absY }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const u = rooms[roomId].users[socket.id];
    if (!u) return;

    if (typeof absX === 'number' && typeof absY === 'number') {
      u.x = Math.max(0, Math.min(100, Math.round(absX)));
      u.y = Math.max(0, Math.min(100, Math.round(absY)));
    } else if (typeof dx === 'number' && typeof dy === 'number') {
      u.x = Math.max(0, Math.min(100, Math.round(u.x + dx)));
      u.y = Math.max(0, Math.min(100, Math.round(u.y + dy)));
    } else {
      return;
    }
    io.to(roomId).emit('userMoved', { id: socket.id, x: u.x, y: u.y });
  });

  // request full state for current room
  socket.on('getState', (cb) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return cb && cb({ ok: false, error: 'Not in room' });
    cb && cb({ ok: true, state: { users: rooms[roomId].users, roomId } });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].users[socket.id];
      io.to(roomId).emit('userLeft', { id: socket.id });
      // if empty room, remove it
      if (Object.keys(rooms[roomId].users).length === 0) {
        delete rooms[roomId];
        console.log('deleted empty room', roomId);
      }
    }
    console.log('live-dots: disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Live-dots server listening on http://localhost:${PORT}`);
});
