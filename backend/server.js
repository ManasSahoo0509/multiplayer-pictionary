
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { Server } from "socket.io";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT) || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: "100kb" }));

const io = new Server(httpServer, {
  cors: { origin: CLIENT_URL, methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e6,
});

const rooms = new Map();
const turnTimers = new Map();
const hintTimers = new Map();
const disconnectTimers = new Map();

const WORDS = {
  easy: ["cat", "dog", "sun", "tree", "fish", "book", "cake", "star"],
  normal: [
    "elephant", "rainbow", "pizza", "airplane", "guitar",
    "mountain", "butterfly", "football", "computer", "watermelon",
    "sunflower", "dinosaur", "lighthouse", "basketball", "telescope",
  ],
  hard: [
    "submarine", "observatory", "earthquake", "skyscraper",
    "constellation", "microscope", "waterfall", "helicopter",
  ],
};

app.get("/", (_req, res) => {
  res.json({ success: true, message: "Pictionary backend is running" });
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, rooms: rooms.size });
});

function ackError(ack, message) {
  if (typeof ack === "function") ack({ success: false, message });
}

function cleanName(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, 24)
    : "";
}

function makeRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;

  do {
    id = Array.from(
      { length: 6 },
      () => chars[randomInt(chars.length)]
    ).join("");
  } while (rooms.has(id));

  return id;
}

function normalizeAnswer(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function getRoomForSocket(socket) {
  const roomId = socket.data.roomId;
  const playerId = socket.data.playerId;

  if (!roomId || !playerId) return null;

  const room = rooms.get(roomId);
  if (!room) return null;

  const player = room.players.get(playerId);
  if (!player || player.socketId !== socket.id) return null;

  return { room, player, roomId };
}

function hintPattern(word, revealed = new Set()) {
  return [...word]
    .map((character, index) => {
      if (character === " ") return " ";
      return revealed.has(index) ? character : "_";
    })
    .join(" ");
}

function publicRoomState(room) {
  const now = Date.now();

  return {
    roomId: room.id,
    hostId: room.hostId,
    status: room.status,
    settings: { ...room.settings },
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
      isHost: player.id === room.hostId,
    })),
    game: {
      round: room.game.round,
      totalRounds: room.settings.rounds,
      drawerId: room.game.drawerId,
      timeLeft: room.game.endsAt
        ? Math.max(0, Math.ceil((room.game.endsAt - now) / 1000))
        : 0,
      endsAt: room.game.endsAt,
      message: room.game.message,
      guessedPlayerIds: [...room.game.guessedPlayerIds],
      hintPattern: room.game.secretWord
        ? hintPattern(room.game.secretWord, room.game.hintPositions)
        : "",
      hintsRevealed: room.game.hintPositions.size,
    },
  };
}

function emitRoomState(room) {
  const state = publicRoomState(room);
  io.to(room.id).emit("room:state", state);
  io.to(room.id).emit("game:state", state);
}

function emitNotice(room, message) {
  io.to(room.id).emit("game:notice", { message });
}

function privateWord(room) {
  const drawer = room.players.get(room.game.drawerId);
  if (!drawer?.connected || !drawer.socketId) return;

  io.to(drawer.socketId).emit("game:private-state", {
    secretWord: room.game.secretWord,
    drawerId: drawer.id,
  });
}

function clearTimer(map, roomId) {
  const timer = map.get(roomId);
  if (timer) clearTimeout(timer);
  map.delete(roomId);
}

function clearRoomTimers(roomId) {
  clearTimer(turnTimers, roomId);
  clearTimer(hintTimers, roomId);
}

function addChatMessage(room, type, playerName, text) {
  const message = {
    id: randomUUID(),
    type,
    playerName,
    text,
    createdAt: new Date().toISOString(),
  };

  room.chatMessages.push(message);
  if (room.chatMessages.length > 100) room.chatMessages.shift();

  io.to(room.id).emit("chat:message", message);
}

function scheduleHint(room) {
  clearTimer(hintTimers, room.id);

  const timer = setTimeout(() => {
    const current = rooms.get(room.id);

    if (!current || current.status !== "drawing" || !current.game.secretWord) {
      return clearTimer(hintTimers, room.id);
    }

    const positions = current.game.hintPositions;
    const letters = [...current.game.secretWord]
      .map((character, index) => ({ character, index }))
      .filter((item) => item.character !== " ")
      .map((item) => item.index);

    const maximum = Math.max(1, Math.ceil(letters.length / 2));
    const available = letters.filter((index) => !positions.has(index));

    if (!available.length || positions.size >= maximum) {
      return clearTimer(hintTimers, room.id);
    }

    positions.add(available[randomInt(available.length)]);

    io.to(room.id).emit("game:hint", {
      hintPattern: hintPattern(current.game.secretWord, positions),
      hintsRevealed: positions.size,
    });

    emitRoomState(current);
    scheduleHint(current);
  }, 15000);

  hintTimers.set(room.id, timer);
}

function finishGame(room) {
  clearRoomTimers(room.id);

  room.status = "finished";
  room.game.endsAt = null;
  room.game.drawerId = null;
  room.game.message = "Game finished";
  room.game.secretWord = null;

  const scoreboard = [...room.players.values()]
    .map(({ id, name, score }) => ({ id, name, score }))
    .sort((a, b) => b.score - a.score);

  io.to(room.id).emit("game:finished", { scoreboard });
  emitRoomState(room);
}

function startTurn(room) {
  if (room.status === "finished") return;

  const activePlayers = room.game.turnOrder
    .map((id) => room.players.get(id))
    .filter((player) => player?.connected);

  if (activePlayers.length < 2) {
    finishGame(room);
    return;
  }

  let attempts = 0;
  let drawerId = room.game.turnOrder[room.game.turnIndex];

  while (
    (!room.players.has(drawerId) ||
      !room.players.get(drawerId).connected) &&
    attempts < room.game.turnOrder.length
  ) {
    room.game.turnIndex += 1;

    if (room.game.turnIndex >= room.game.turnOrder.length) {
      room.game.turnIndex = 0;
      room.game.round += 1;
    }

    if (room.game.round > room.settings.rounds) {
      finishGame(room);
      return;
    }

    drawerId = room.game.turnOrder[room.game.turnIndex];
    attempts += 1;
  }

  const drawer = room.players.get(drawerId);
  if (!drawer) return finishGame(room);

  room.status = "drawing";
  room.game.drawerId = drawerId;
  room.game.secretWord =
    (WORDS[room.settings.words] || WORDS.normal)[
      randomInt((WORDS[room.settings.words] || WORDS.normal).length)
    ];
  room.game.endsAt = Date.now() + room.settings.drawTime * 1000;
  room.game.message = `${drawer.name} is drawing`;
  room.game.guessedPlayerIds = new Set();
  room.game.hintPositions = new Set();
  room.game.correctGuessCount = 0;
  room.drawingStrokes = [];

  io.to(room.id).emit("drawing:cleared");
  io.to(room.id).emit("game:started", {
    drawerId,
    drawerName: drawer.name,
    round: room.game.round,
    totalRounds: room.settings.rounds,
    drawTime: room.settings.drawTime,
  });

  privateWord(room);
  emitRoomState(room);
  scheduleHint(room);

  const timer = setTimeout(() => {
    const current = rooms.get(room.id);
    if (current?.status === "drawing") advanceTurn(current, "time");
  }, room.settings.drawTime * 1000);

  turnTimers.set(room.id, timer);
}

function advanceTurn(room, reason = "time") {
  if (room.status !== "drawing") return;

  clearRoomTimers(room.id);

  const answer = room.game.secretWord;
  const drawer = room.players.get(room.game.drawerId);

  io.to(room.id).emit("game:turn-ended", {
    reason,
    answer,
    drawerName: drawer?.name || "Drawer",
  });

  room.game.turnIndex += 1;

  if (room.game.turnIndex >= room.game.turnOrder.length) {
    room.game.turnIndex = 0;
    room.game.round += 1;
  }

  if (room.game.round > room.settings.rounds) {
    finishGame(room);
    return;
  }

  startTurn(room);
}

function createRoom(socket, name, requestedPlayerId) {
  const roomId = makeRoomId();
  const playerId = requestedPlayerId || randomUUID();

  const room = {
    id: roomId,
    hostId: playerId,
    status: "waiting",
    settings: { rounds: 3, drawTime: 60, words: "normal" },
    players: new Map(),
    drawingStrokes: [],
    chatMessages: [],
    game: {
      round: 1,
      turnIndex: 0,
      turnOrder: [],
      drawerId: null,
      secretWord: null,
      endsAt: null,
      message: "Waiting for players",
      guessedPlayerIds: new Set(),
      hintPositions: new Set(),
      correctGuessCount: 0,
    },
  };

  room.players.set(playerId, {
    id: playerId,
    name,
    score: 0,
    connected: true,
    socketId: socket.id,
  });

  rooms.set(roomId, room);
  socket.join(roomId);
  socket.data.roomId = roomId;
  socket.data.playerId = playerId;

  return room;
}

function permanentlyRemovePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;

  clearTimer(disconnectTimers, `${room.id}:${playerId}`);
  room.players.delete(playerId);
  room.game.turnOrder = room.game.turnOrder.filter((id) => id !== playerId);

  if (room.players.size === 0) {
    clearRoomTimers(room.id);
    rooms.delete(room.id);
    return;
  }

  if (room.hostId === playerId) {
    room.hostId = room.players.keys().next().value;
  }

  if (room.status === "drawing" && room.game.drawerId === playerId) {
    advanceTurn(room, "drawer-left");
  } else {
    emitRoomState(room);
  }
}

function disconnectPlayer(socket) {
  const roomId = socket.data.roomId;
  const playerId = socket.data.playerId;
  const room = rooms.get(roomId);
  const player = room?.players.get(playerId);

  if (!room || !player || player.socketId !== socket.id) return;

  player.connected = false;
  player.socketId = null;
  emitRoomState(room);

  const timerKey = `${roomId}:${playerId}`;
  clearTimer(disconnectTimers, timerKey);

  const timer = setTimeout(() => {
    const currentRoom = rooms.get(roomId);
    if (currentRoom) permanentlyRemovePlayer(currentRoom, playerId);
    disconnectTimers.delete(timerKey);
  }, 30000);

  disconnectTimers.set(timerKey, timer);
}

io.on("connection", (socket) => {
  socket.on("room:create", (payload = {}, ack = () => {}) => {
    const name = cleanName(payload.name);
    if (!name) return ackError(ack, "Enter your name.");

    const room = createRoom(socket, name, payload.playerId);
    ack({
      success: true,
      roomId: room.id,
      playerId: socket.data.playerId,
      state: publicRoomState(room),
    });
    emitRoomState(room);
  });

  socket.on("room:join", (payload = {}, ack = () => {}) => {
    const roomId = String(payload.roomId || "").trim().toUpperCase();
    const name = cleanName(payload.name);
    const room = rooms.get(roomId);

    if (!name) return ackError(ack, "Enter your name.");
    if (!room) return ackError(ack, "Room not found.");
    if (room.status !== "waiting") {
      return ackError(ack, "This game has already started.");
    }
    if (room.players.size >= 8) {
      return ackError(ack, "Room is full (maximum 8 players).");
    }

    const playerId = payload.playerId || randomUUID();

    if (room.players.has(playerId)) {
      return ackError(ack, "This player is already in the room.");
    }

    room.players.set(playerId, {
      id: playerId,
      name,
      score: 0,
      connected: true,
      socketId: socket.id,
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;

    ack({
      success: true,
      roomId,
      playerId,
      state: publicRoomState(room),
    });

    emitRoomState(room);
    socket.emit("chat:history", room.chatMessages);
  });

  socket.on("room:reconnect", (payload = {}, ack = () => {}) => {
    const roomId = String(payload.roomId || "").trim().toUpperCase();
    const playerId = String(payload.playerId || "");
    const room = rooms.get(roomId);
    const player = room?.players.get(playerId);

    if (!room || !player) {
      return ackError(ack, "Your previous session has expired.");
    }

    clearTimer(disconnectTimers, `${roomId}:${playerId}`);

    player.connected = true;
    player.socketId = socket.id;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;

    ack({
      success: true,
      roomId,
      playerId,
      state: publicRoomState(room),
    });

    emitRoomState(room);
    socket.emit("chat:history", room.chatMessages);
    socket.emit("drawing:history", room.drawingStrokes);

    if (room.game.drawerId === playerId) privateWord(room);
  });

  socket.on("room:get-state", (_payload, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "You are not in a room.");

    ack({ success: true, state: publicRoomState(context.room) });
    socket.emit("chat:history", context.room.chatMessages);
    socket.emit("drawing:history", context.room.drawingStrokes);

    if (context.room.game.drawerId === context.player.id) {
      privateWord(context.room);
    }
  });

  socket.on("room:update-settings", (payload = {}, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "Join a room first.");

    const { room, player } = context;
    if (room.hostId !== player.id) {
      return ackError(ack, "Only the host can change settings.");
    }
    if (room.status !== "waiting") {
      return ackError(ack, "Settings cannot change during a game.");
    }

    const rounds = Number(payload.rounds);
    const drawTime = Number(payload.drawTime);

    if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 8) {
      room.settings.rounds = rounds;
    }
    if (Number.isInteger(drawTime) && drawTime >= 30 && drawTime <= 180) {
      room.settings.drawTime = drawTime;
    }
    if (["easy", "normal", "hard"].includes(payload.words)) {
      room.settings.words = payload.words;
    }

    ack({ success: true });
    emitRoomState(room);
  });

  socket.on("game:start", (_payload, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "Join a room first.");

    const { room, player } = context;

    if (room.hostId !== player.id) {
      return ackError(ack, "Only the host can start the game.");
    }
    if (room.status !== "waiting") {
      return ackError(ack, "The game has already started.");
    }
    if ([...room.players.values()].filter((p) => p.connected).length < 2) {
      return ackError(ack, "At least 2 connected players are required.");
    }

    for (const p of room.players.values()) p.score = 0;

    room.game.turnOrder = [...room.players.values()]
      .filter((p) => p.connected)
      .map((p) => p.id);

    for (let i = room.game.turnOrder.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [room.game.turnOrder[i], room.game.turnOrder[j]] =
        [room.game.turnOrder[j], room.game.turnOrder[i]];
    }

    room.game.round = 1;
    room.game.turnIndex = 0;

    ack({ success: true });
    startTurn(room);
  });

  socket.on("game:guess", (payload = {}, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "Join a room first.");

    const { room, player } = context;

    if (room.status !== "drawing") {
      return ackError(ack, "There is no active turn.");
    }
    if (player.id === room.game.drawerId) {
      return ackError(ack, "The drawer cannot guess.");
    }
    if (room.game.guessedPlayerIds.has(player.id)) {
      return ackError(ack, "You already guessed correctly this turn.");
    }

    const guess = typeof payload.guess === "string"
      ? payload.guess.trim().slice(0, 100)
      : "";

    if (!guess) return ackError(ack, "Type a guess first.");

    if (normalizeAnswer(guess) !== normalizeAnswer(room.game.secretWord)) {
      addChatMessage(room, "guess", player.name, guess);
      return ack({ success: true, correct: false });
    }

    const guesserPoints = 100;
    const drawerPoints = 50;

    room.game.guessedPlayerIds.add(player.id);
    room.game.correctGuessCount += 1;
    player.score += guesserPoints;

    const drawer = room.players.get(room.game.drawerId);
    if (drawer) drawer.score += drawerPoints;

    io.to(room.id).emit("guess:correct", {
      playerId: player.id,
      playerName: player.name,
      points: guesserPoints,
      drawerName: drawer?.name || "Drawer",
      drawerPoints,
    });

    emitRoomState(room);
    ack({ success: true, correct: true, points: guesserPoints });

    const eligible = [...room.players.values()]
      .filter((p) => p.connected && p.id !== room.game.drawerId);

    if (
      eligible.length > 0 &&
      eligible.every((p) => room.game.guessedPlayerIds.has(p.id))
    ) {
      advanceTurn(room, "everyone-guessed");
    }
  });

  socket.on("drawing:request-history", (_payload, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "Join a room first.");

    socket.emit("drawing:history", context.room.drawingStrokes);
    if (typeof ack === "function") ack({ success: true });
  });

  socket.on("drawing:stroke", (payload = {}, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "Join a room first.");

    const { room, player } = context;

    if (room.status !== "drawing" || room.game.drawerId !== player.id) {
      return ackError(ack, "Only the current drawer can draw.");
    }

    const point = payload.point;
    const start = payload.start;

    if (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 || point.x > 1 ||
      point.y < 0 || point.y > 1
    ) {
      return ackError(ack, "Invalid drawing point.");
    }

    const stroke = {
      strokeId: String(payload.strokeId || randomUUID()).slice(0, 80),
      segmentId: String(payload.segmentId || randomUUID()).slice(0, 80),
      start: start &&
        Number.isFinite(start.x) &&
        Number.isFinite(start.y)
        ? {
            x: Math.max(0, Math.min(1, start.x)),
            y: Math.max(0, Math.min(1, start.y)),
          }
        : null,
      point: { x: point.x, y: point.y },
      color: typeof payload.color === "string"
        ? payload.color.slice(0, 20)
        : "#222222",
      size: Number.isFinite(payload.size)
        ? Math.max(1, Math.min(40, payload.size))
        : 4,
      tool: ["pen", "eraser"].includes(payload.tool) ? payload.tool : "pen",
    };

    room.drawingStrokes.push(stroke);
    if (room.drawingStrokes.length > 5000) room.drawingStrokes.shift();

    // Other players receive the segment; the drawer already drew it locally.
    socket.to(room.id).emit("drawing:stroke", stroke);
    if (typeof ack === "function") ack({ success: true });
  });

  socket.on("drawing:undo", (_payload, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "Join a room first.");

    const { room, player } = context;

    if (room.status !== "drawing" || room.game.drawerId !== player.id) {
      return ackError(ack, "Only the current drawer can undo.");
    }

    if (room.drawingStrokes.length === 0) {
      if (typeof ack === "function") {
        ack({ success: true, message: "Nothing to undo." });
      }
      return;
    }

    // Remove every segment belonging to the latest complete gesture.
    const lastStroke = room.drawingStrokes[room.drawingStrokes.length - 1];
    const strokeId = lastStroke.strokeId;

    room.drawingStrokes = room.drawingStrokes.filter(
      (stroke) => stroke.strokeId !== strokeId
    );

    io.to(room.id).emit("drawing:undo", { strokeId });
    if (typeof ack === "function") ack({ success: true });
  });

  socket.on("drawing:clear", (_payload, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) return ackError(ack, "Join a room first.");

    const { room, player } = context;

    if (room.status !== "drawing" || room.game.drawerId !== player.id) {
      return ackError(ack, "Only the current drawer can clear.");
    }

    room.drawingStrokes = [];
    io.to(room.id).emit("drawing:cleared");
    if (typeof ack === "function") ack({ success: true });
  });

  socket.on("room:leave", (_payload, ack = () => {}) => {
    const context = getRoomForSocket(socket);
    if (!context) {
      if (typeof ack === "function") ack({ success: true });
      return;
    }

    const { room, player } = context;
    socket.leave(room.id);
    socket.data.roomId = null;
    socket.data.playerId = null;
    permanentlyRemovePlayer(room, player.id);

    if (typeof ack === "function") ack({ success: true });
  });

  socket.on("disconnect", () => {
    disconnectPlayer(socket);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Pictionary backend running on http://localhost:${PORT}`);
});
