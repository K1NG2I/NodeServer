// server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ============================================
   UTILS
============================================ */
function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

/* ============================================
   🔵 CHESS NAMESPACE — /chess
============================================ */
const chessIO = io.of("/chess");
const chessRooms = {};

chessIO.on("connection", (socket) => {
  console.log("Chess connected:", socket.id);

  socket.on("createRoom", ({ username }, cb) => {
    const roomId = makeRoomId();
    const engine = new Chess();

    chessRooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, username, color: "white" }],
      engine,
      fen: engine.fen()
    };

    socket.join(roomId);

    if (typeof cb === "function") {
      cb({ ok: true, roomId, color: "white", fen: engine.fen() });
    }

    chessIO.to(roomId).emit("roomUpdate", {
      id: roomId,
      players: chessRooms[roomId].players,
      fen: engine.fen()
    });
  });

  socket.on("joinRoom", ({ roomId, username }, cb) => {
    const room = chessRooms[roomId];
    if (!room || room.players.length >= 2) {
      if (typeof cb === "function") cb({ ok: false });
      return;
    }

    room.players.push({ id: socket.id, username, color: "black" });
    socket.join(roomId);

    if (typeof cb === "function") {
      cb({ ok: true, roomId, color: "black", fen: room.fen });
    }

    chessIO.to(roomId).emit("roomUpdate", {
      id: roomId,
      players: room.players,
      fen: room.fen
    });
  });

  socket.on("makeMove", ({ roomId, from, to, promotion }, cb) => {
    const room = chessRooms[roomId];
    if (!room) {
      if (typeof cb === "function") cb({ ok: false });
      return;
    }

    const result = room.engine.move({ from, to, promotion });
    if (!result) {
      if (typeof cb === "function") cb({ ok: false });
      return;
    }

    room.fen = room.engine.fen();
    if (typeof cb === "function") cb({ ok: true });

    chessIO.to(roomId).emit("movePlayed", {
      move: result,
      fen: room.fen
    });
  });
});

/* ============================================
   🔴 LIVE DOTS NAMESPACE — /live
============================================ */
const liveIO = io.of("/live");
const liveRooms = {};

function randomPos() {
  return { x: Math.random() * 80 + 10, y: Math.random() * 80 + 10 };
}

liveIO.on("connection", (socket) => {
  socket.data.roomId = null;

  socket.on("createRoom", ({ username }, cb) => {
    const roomId = makeRoomId();
    liveRooms[roomId] = { users: {} };
    socket.join(roomId);
    socket.data.roomId = roomId;

    liveRooms[roomId].users[socket.id] = {
      id: socket.id,
      name: username,
      ...randomPos(),
      color: "#2c2c2c"
    };

    if (typeof cb === "function") {
      cb({ ok: true, roomId, state: liveRooms[roomId] });
    }
  });

  socket.on("joinRoom", ({ roomId, username }, cb) => {
    const room = liveRooms[roomId];
    if (!room) {
      if (typeof cb === "function") cb({ ok: false });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;

    room.users[socket.id] = {
      id: socket.id,
      name: username,
      ...randomPos(),
      color: "#2c2c2c"
    };

    if (typeof cb === "function") {
      cb({ ok: true, roomId, state: room });
    }
  });
});

/* ============================================
   🕵️ SPY GAME NAMESPACE — /spy
============================================ */
const spyIO = io.of("/spy");

const DISCUSSION_TIME = 2 * 60 * 1000;
const VOTING_TIME = 1 * 60 * 1000;

const spyWordPairs = require("./data/spyWords.json");
const spyRooms = {};

function clearTimers(room) {
  if (room.timers?.discussion) clearTimeout(room.timers.discussion);
  if (room.timers?.voting) clearTimeout(room.timers.voting);
}

function emitState(room) {
  spyIO.to(room.id).emit("roomState", {
    id: room.id,
    hostId: room.hostId,
    players: room.players,
    spectators: room.spectators,
    phase: room.phase,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt
  });
}

function startDiscussion(room) {
  clearTimers(room);
  room.phase = "playing";
  room.phaseEndsAt = Date.now() + DISCUSSION_TIME;
  emitState(room);
  room.timers.discussion = setTimeout(() => startVoting(room), DISCUSSION_TIME);
}

function startVoting(room) {
  clearTimers(room);
  room.phase = "voting";
  room.votes = {};
  room.phaseEndsAt = Date.now() + VOTING_TIME;
  emitState(room);
  room.timers.voting = setTimeout(() => resolveVoting(room), VOTING_TIME);
}

function resolveVoting(room) {
  clearTimers(room);

  const tally = {};
  Object.values(room.votes).forEach(id => {
    tally[id] = (tally[id] || 0) + 1;
  });

  const kickedId = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
  if (!kickedId) return endGame(room, "spy");

  if (kickedId === room.spyId) return endGame(room, "players", kickedId);

  const kicked = room.players.find(p => p.id === kickedId);
  room.players = room.players.filter(p => p.id !== kickedId);
  room.spectators.push(kicked);

  spyIO.to(room.id).emit("playerKicked", { username: kicked.username });

  if (room.players.length === 2) return endGame(room, "spy");

  room.round += 1;
  startDiscussion(room);
}

function endGame(room, winner, kickedId = null) {
  clearTimers(room);
  room.phase = "ended";
  room.phaseEndsAt = Date.now();

  const all = room.players.concat(room.spectators);
  spyIO.to(room.id).emit("gameResult", {
    winner,
    spy: all.find(p => p.id === room.spyId)?.username,
    kicked: all.find(p => p.id === kickedId)?.username
  });

  emitState(room);
}

spyIO.on("connection", (socket) => {
  socket.data.roomId = null;

  socket.on("createLobby", ({ username }, cb) => {
    const roomId = makeRoomId();
    const pair = spyWordPairs[Math.floor(Math.random() * spyWordPairs.length)];

    spyRooms[roomId] = {
      id: roomId,
      hostId: socket.id,
      players: [{ id: socket.id, username }],
      spectators: [],
      spyId: null,
      pair,
      round: 1,
      phase: "lobby",
      votes: {},
      timers: {}
    };

    socket.join(roomId);
    socket.data.roomId = roomId;

    if (typeof cb === "function") cb({ ok: true, roomId });
    emitState(spyRooms[roomId]);
  });

  socket.on("joinLobby", ({ roomId, username }, cb) => {
    const room = spyRooms[roomId];
    if (!room || room.phase !== "lobby") {
      if (typeof cb === "function") cb({ ok: false });
      return;
    }

    room.players.push({ id: socket.id, username });
    socket.join(roomId);
    socket.data.roomId = roomId;

    if (typeof cb === "function") cb({ ok: true });
    emitState(room);
  });

  socket.on("startGame", () => {
    const room = spyRooms[socket.data.roomId];
    if (!room || socket.id !== room.hostId || room.players.length < 3) return;

    const spyIndex = Math.floor(Math.random() * room.players.length);
    room.spyId = room.players[spyIndex].id;

    room.players.forEach(p => {
      spyIO.to(p.id).emit("yourCard", {
        type: p.id === room.spyId ? "spy" : "real",
        word: p.id === room.spyId ? room.pair.spy : room.pair.real
      });
    });

    startDiscussion(room);
  });

  socket.on("castVote", ({ targetId }) => {
    const room = spyRooms[socket.data.roomId];
    if (!room || room.phase !== "voting") return;
    if (room.votes[socket.id]) return;
    room.votes[socket.id] = targetId;
  });

  socket.on("resetGame", () => {
    const room = spyRooms[socket.data.roomId];
    if (!room || socket.id !== room.hostId) return;

    clearTimers(room);
    room.players.push(...room.spectators);
    room.spectators = [];
    room.spyId = null;
    room.round = 1;
    room.phase = "lobby";
    room.votes = {};
    emitState(room);
  });
});

/* ============================================
   START SERVER
============================================ */
server.listen(4000, () => {
  console.log("Server running on http://localhost:4000");
});
