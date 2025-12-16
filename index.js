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

// spyRooms = {
//   abc123: {
//     id,
//     players: [{ id, username }],
//     started: false,
//     pair: { real, spy }
//   }
// }
const spyRooms = [];

const spyWordPairs = [
  { real: "Airport", spy: "Bus Station" },
  { real: "Hospital", spy: "Clinic" },
  { real: "School", spy: "Library" },
  { real: "Beach", spy: "Desert" },
  { real: "Restaurant", spy: "Kitchen" }
];

spyIO.on("connection", (socket) => {
  console.log("Spy connected:", socket.id);

  socket.data.roomId = null;

  /* CREATE LOBBY */
  socket.on("createLobby", ({ username }, cb) => {
    if (!username) return cb?.({ ok: false, error: "Username required" });

    const roomId = makeRoomId();
    const pair =
      spyWordPairs[Math.floor(Math.random() * spyWordPairs.length)];

    spyRooms[roomId] = {
      id: roomId,
      players: [{ id: socket.id, username }],
      started: false,
      pair
    };

    socket.join(roomId);
    socket.data.roomId = roomId;

    cb?.({ ok: true, roomId });

    spyIO.to(roomId).emit("lobbyUpdate", {
      id: roomId,
      players: spyRooms[roomId].players
    });
  });

  /* JOIN LOBBY */
  socket.on("joinLobby", ({ roomId, username }, cb) => {
    const room = spyRooms[roomId];
    if (!room) return cb?.({ ok: false, error: "Lobby not found" });
    if (room.started)
      return cb?.({ ok: false, error: "Game already started" });

    room.players.push({ id: socket.id, username });
    socket.join(roomId);
    socket.data.roomId = roomId;

    cb?.({ ok: true });

    spyIO.to(roomId).emit("lobbyUpdate", {
      id: roomId,
      players: room.players
    });
  });

  /* START GAME */
  socket.on("startGame", () => {
    const roomId = socket.data.roomId;
    const room = spyRooms[roomId];
    if (!room || room.started) return;

    room.started = true;

    // Build cards
    const total = room.players.length;
    const cards = [];

    for (let i = 0; i < total - 1; i++) {
      cards.push({ type: "real", word: room.pair.real });
    }
    cards.push({ type: "spy", word: room.pair.spy });

    // Shuffle
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }

    // Assign privately
    room.players.forEach((p, i) => {
      spyIO.to(p.id).emit("yourCard", cards[i]);
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = spyRooms[roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete spyRooms[roomId];
    } else {
      spyIO.to(roomId).emit("lobbyUpdate", {
        id: roomId,
        players: room.players
      });
    }

    console.log("Spy disconnected:", socket.id);
  });
});


/* ============================================
   START SERVER
============================================ */
server.listen(4000, () => {
  console.log("Server running on http://localhost:4000");
});
