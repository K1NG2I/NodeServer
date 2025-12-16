// server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*" } });

/* ============================================
   🔵 CHESS NAMESPACE — /chess
============================================ */
const chessIO = io.of("/chess");

// Store rooms:
// rooms = {
//   xyz123: {
//      id,
//      players: [{id, username, color}],
//      engine,
//      fen
//   }
// }
const chessRooms = {};

// Generate room code
function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

chessIO.on("connection", (socket) => {
  console.log("Chess connected:", socket.id);

  /* CREATE ROOM */
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

    cb({
      ok: true,
      roomId,
      color: "white",
      fen: chessRooms[roomId].fen
    });

    // SEND SAFE ROOM UPDATE
    chessIO.to(roomId).emit("roomUpdate", {
      id: roomId,
      players: chessRooms[roomId].players,
      fen: chessRooms[roomId].fen
    });
  });

  /* JOIN ROOM */
  socket.on("joinRoom", ({ roomId, username }, cb) => {
    const room = chessRooms[roomId];
    if (!room) return cb({ ok: false, error: "Room not found" });
    if (room.players.length >= 2)
      return cb({ ok: false, error: "Room full" });

    const color = "black";

    room.players.push({ id: socket.id, username, color });
    socket.join(roomId);

    cb({
      ok: true,
      roomId,
      color,
      fen: room.fen
    });

    chessIO.to(roomId).emit("roomUpdate", {
      id: roomId,
      players: room.players,
      fen: room.fen
    });
  });

  /* HANDLE MOVE */
  socket.on("makeMove", ({ roomId, from, to, promotion }, cb) => {
    const room = chessRooms[roomId];
    if (!room) return cb({ ok: false, error: "Invalid room" });

    try {
      const result = room.engine.move({ from, to, promotion });
      if (!result) return cb({ ok: false, error: "Illegal move" });

      room.fen = room.engine.fen();
      cb({ ok: true });

      chessIO.to(roomId).emit("movePlayed", {
        move: result,
        fen: room.fen
      });
    } catch (e) {
      cb({ ok: false, error: "Illegal move" });
    }
  });

  socket.on("disconnect", () => {
    console.log("Chess disconnected:", socket.id);
    // Not removing players to avoid breaking rooms while playing.
  });
});

/* ============================================
   🔴 LIVE DOTS NAMESPACE — /live
============================================ */
const liveIO = io.of("/live");

// rooms = {
//   xyz123: { users: { socketId: {...} } }
// }
const liveRooms = {};

function randomPos() {
  return {
    x: Math.floor(10 + Math.random() * 80),
    y: Math.floor(10 + Math.random() * 80),
  };
}

liveIO.on("connection", (socket) => {
  console.log("LiveDots connected:", socket.id);

  socket.data.roomId = null;

  /* CREATE ROOM */
  socket.on("createRoom", ({ username }, cb) => {
    const roomId = makeRoomId();

    liveRooms[roomId] = { users: {} };
    socket.join(roomId);
    socket.data.roomId = roomId;

    const pos = randomPos();

    liveRooms[roomId].users[socket.id] = {
      id: socket.id,
      name: username || "Guest",
      x: pos.x,
      y: pos.y,
      color: "#2c2c2c"
    };

    cb({
      ok: true,
      roomId,
      state: {
        you: liveRooms[roomId].users[socket.id],
        users: liveRooms[roomId].users
      }
    });

    liveIO.to(roomId).emit("userJoined", liveRooms[roomId].users[socket.id]);
  });

  /* JOIN ROOM */
  socket.on("joinRoom", ({ roomId, username }, cb) => {
    const room = liveRooms[roomId];
    if (!room) return cb({ ok: false, error: "Room not found" });

    socket.join(roomId);
    socket.data.roomId = roomId;

    const pos = randomPos();

    room.users[socket.id] = {
      id: socket.id,
      name: username || "Guest",
      x: pos.x,
      y: pos.y,
      color: "#2c2c2c"
    };

    cb({
      ok: true,
      roomId,
      state: {
        you: room.users[socket.id],
        users: room.users
      }
    });

    liveIO.to(roomId).emit("userJoined", room.users[socket.id]);
  });

  /* SET COLOR */
  socket.on("setColor", ({ color }) => {
    const roomId = socket.data.roomId;
    const room = liveRooms[roomId];
    if (!room) return;

    room.users[socket.id].color = color;

    liveIO.to(roomId).emit("userUpdated", {
      id: socket.id,
      patch: { color }
    });
  });

  /* SET NAME */
  socket.on("setName", ({ name }) => {
    const roomId = socket.data.roomId;
    const room = liveRooms[roomId];
    if (!room) return;

    room.users[socket.id].name = name;

    liveIO.to(roomId).emit("userUpdated", {
      id: socket.id,
      patch: { name }
    });
  });

  /* MOVEMENT */
  socket.on("move", ({ dx, dy, x, y }) => {
    const roomId = socket.data.roomId;
    const room = liveRooms[roomId];
    if (!room) return;

    const user = room.users[socket.id];

    if (typeof x === "number") user.x = x;
    if (typeof y === "number") user.y = y;
    if (typeof dx === "number") user.x += dx;
    if (typeof dy === "number") user.y += dy;

    user.x = Math.max(0, Math.min(100, user.x));
    user.y = Math.max(0, Math.min(100, user.y));

    liveIO.to(roomId).emit("userMoved", {
      id: socket.id,
      x: user.x,
      y: user.y
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = liveRooms[roomId];
    if (room) {
      delete room.users[socket.id];
      liveIO.to(roomId).emit("userLeft", { id: socket.id });

      // delete empty rooms
      if (Object.keys(room.users).length === 0) delete liveRooms[roomId];
    }
    console.log("LiveDots disconnected:", socket.id);
  });
});
/* ============================================
   🕵️ SPY GAME NAMESPACE — /spy
============================================ */
const spyIO = io.of("/spy");

const DISCUSSION_TIME = 2 * 60 * 1000; // 2 min
const VOTING_TIME = 1 * 60 * 1000;     // 1 min

const spyWordPairs = [
  { real: "Airport", spy: "Bus Station" },
  { real: "Hospital", spy: "Clinic" },
  { real: "School", spy: "Library" },
  { real: "Beach", spy: "Desert" },
  { real: "Restaurant", spy: "Kitchen" }
];

// roomId -> room
const spyRooms = {};

function clearTimers(room) {
  if (room.timers.discussion) clearTimeout(room.timers.discussion);
  if (room.timers.voting) clearTimeout(room.timers.voting);
  room.timers.discussion = null;
  room.timers.voting = null;
}

function emitState(room) {
  spyIO.to(room.id).emit("roomState", {
    id: room.id,
    hostId: room.hostId,
    players: room.players,
    spectators: room.spectators,
    phase: room.phase,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt || null
  });
}

function startDiscussion(room) {
  clearTimers(room);

  room.phase = "playing";
  room.phaseEndsAt = Date.now() + DISCUSSION_TIME;

  emitState(room);

  room.timers.discussion = setTimeout(() => {
    startVoting(room);
  }, DISCUSSION_TIME);
}

function startVoting(room) {
  clearTimers(room);

  room.phase = "voting";
  room.votes = {};
  room.phaseEndsAt = Date.now() + VOTING_TIME;

  emitState(room);

  room.timers.voting = setTimeout(() => {
    resolveVoting(room);
  }, VOTING_TIME);
}

function resolveVoting(room) {
  clearTimers(room);

  const tally = {};
  Object.values(room.votes).forEach(id => {
    tally[id] = (tally[id] || 0) + 1;
  });

  let kickedId = null;
  let maxVotes = 0;

  for (const id in tally) {
    if (tally[id] > maxVotes) {
      kickedId = id;
      maxVotes = tally[id];
    }
  }

  // No votes → spy survives
  if (!kickedId) {
    endGame(room, "spy");
    return;
  }

  // Spy caught
  if (kickedId === room.spyId) {
    endGame(room, "players", kickedId);
    return;
  }

  // Move kicked to spectators
  const kickedPlayer = room.players.find(p => p.id === kickedId);
  room.players = room.players.filter(p => p.id !== kickedId);
  room.spectators.push(kickedPlayer);

  spyIO.to(room.id).emit("playerKicked", {
    username: kickedPlayer.username
  });

  // Spy wins if only 2 left
  if (room.players.length === 2) {
    endGame(room, "spy");
    return;
  }

  // Next round
  room.round += 1;
  startDiscussion(room);
}

function endGame(room, winner, kickedId = null) {
  clearTimers(room);

  room.phase = "ended";
  room.phaseEndsAt = Date.now();

  spyIO.to(room.id).emit("gameResult", {
    winner,
    spy: room.players.concat(room.spectators)
      .find(p => p.id === room.spyId)?.username,
    kicked: kickedId
      ? room.players.concat(room.spectators)
          .find(p => p.id === kickedId)?.username
      : null
  });

  emitState(room);
}

spyIO.on("connection", (socket) => {
  console.log("Spy connected:", socket.id);
  socket.data.roomId = null;

  /* CREATE LOBBY */
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
      timers: { discussion: null, voting: null },
      phaseEndsAt: null
    };

    socket.join(roomId);
    socket.data.roomId = roomId;

    cb?.({ ok: true, roomId });
    emitState(spyRooms[roomId]);
  });

  /* JOIN LOBBY */
  socket.on("joinLobby", ({ roomId, username }, cb) => {
    const room = spyRooms[roomId];
    if (!room) return cb?.({ ok: false, error: "Room not found" });
    if (room.phase !== "lobby")
      return cb?.({ ok: false, error: "Game already started" });

    room.players.push({ id: socket.id, username });
    socket.join(roomId);
    socket.data.roomId = roomId;

    cb?.({ ok: true });
    emitState(room);
  });

  /* START GAME (HOST ONLY) */
  socket.on("startGame", () => {
    const room = spyRooms[socket.data.roomId];
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.players.length < 3) return;

    const spyIndex = Math.floor(Math.random() * room.players.length);
    room.spyId = room.players[spyIndex].id;

    room.players.forEach(p => {
      const card =
        p.id === room.spyId
          ? { type: "spy", word: room.pair.spy }
          : { type: "real", word: room.pair.real };

      spyIO.to(p.id).emit("yourCard", card);
    });

    startDiscussion(room);
  });

  /* CAST VOTE */
  socket.on("castVote", ({ targetId }) => {
    const room = spyRooms[socket.data.roomId];
    if (!room || room.phase !== "voting") return;
    if (!room.players.find(p => p.id === socket.id)) return;
    if (room.votes[socket.id]) return;

    room.votes[socket.id] = targetId;
  });

  /* RESET GAME (HOST ONLY) */
  socket.on("resetGame", () => {
    const room = spyRooms[socket.data.roomId];
    if (!room) return;
    if (socket.id !== room.hostId) return;

    clearTimers(room);

    room.players = room.players.concat(room.spectators);
    room.spectators = [];
    room.spyId = null;
    room.round = 1;
    room.phase = "lobby";
    room.votes = {};
    room.phaseEndsAt = null;
    room.pair =
      spyWordPairs[Math.floor(Math.random() * spyWordPairs.length)];

    emitState(room);
  });

  socket.on("disconnect", () => {
    const room = spyRooms[socket.data.roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    room.spectators = room.spectators.filter(p => p.id !== socket.id);

    if (room.players.length === 0 && room.spectators.length === 0) {
      clearTimers(room);
      delete spyRooms[room.id];
      return;
    }

    emitState(room);
  });
});
