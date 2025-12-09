// server.js – fresh version using Redis pub/sub (no socket.io adapter)

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { createClient } from "redis";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------
// Path + basic HTTP setup
// ---------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------------------------
// Redis setup
// ---------------------------
const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_URL = `redis://${REDIS_HOST}:6379`;
const REDIS_LIST_KEY = "whiteboard:strokes";
const REDIS_CHANNEL = "whiteboard-events";

// one client for commands
const redisClient = createClient({ url: REDIS_URL });
// one client for pub/sub
const redisSub = createClient({ url: REDIS_URL });

await redisClient.connect();
await redisSub.connect();
console.log("✅ Connected to Redis at", REDIS_HOST);

// local cache of strokes for this node
let strokes = [];

// Helper to load the full board from Redis list
async function loadBoardFromRedis() {
  const items = await redisClient.lRange(REDIS_LIST_KEY, 0, -1);
  // we’ll store newest at the right side, so no reverse needed
  return items.map((s) => JSON.parse(s));
}

// ---------------------------
// Redis subscriber: single source of truth
// ---------------------------
await redisSub.subscribe(REDIS_CHANNEL, async (raw) => {
  const msg = JSON.parse(raw);

  switch (msg.type) {
    case "init-sync": {
      // initial load when node starts
      strokes = await loadBoardFromRedis();
      break;
    }

    case "draw": {
      const stroke = msg.payload;
      strokes.push(stroke);
      io.emit("draw", stroke);
      break;
    }

    case "clear-all": {
      strokes = [];
      io.emit("clear-all");
      break;
    }

    case "clear-user": {
      const userId = msg.payload.userId;
      strokes = strokes.filter((s) => s.userId !== userId);
      io.emit("reset-board", strokes);
      break;
    }

    default:
      break;
  }
});

// trigger initial sync for this node
await redisClient.publish(REDIS_CHANNEL, JSON.stringify({ type: "init-sync" }));

// ---------------------------
// Socket.IO per-connection logic
// ---------------------------
io.on("connection", (socket) => {
  let userId = null;

  console.log("🟢 client connected:", socket.id);

  socket.on("register", async (data) => {
    userId = data?.userId || socket.id.slice(0, 5).toUpperCase();
    socket.emit("user-info", { userId });

    // on first connect, load from Redis (not local cache),
    // so brand new node after restart still has full history.
    const board = await loadBoardFromRedis();
    socket.emit("init-board", board);
  });

  socket.on("draw", async (data) => {
    if (!userId) return;
    const stroke = { ...data, userId };

    // 1) persist to Redis (append at tail)
    await redisClient.rPush(REDIS_LIST_KEY, JSON.stringify(stroke));

    // 2) publish event so ALL app nodes broadcast
    await redisClient.publish(
      REDIS_CHANNEL,
      JSON.stringify({ type: "draw", payload: stroke })
    );
  });

  socket.on("clear-all", async () => {
    if (!userId) return;

    // drop all persistent strokes
    await redisClient.del(REDIS_LIST_KEY);

    // tell all nodes to clear
    await redisClient.publish(
      REDIS_CHANNEL,
      JSON.stringify({ type: "clear-all" })
    );

    console.log("🧹 full clear by", userId);
  });

  socket.on("clear-mine", async () => {
    if (!userId) return;

    // read current board
    const board = await loadBoardFromRedis();
    const remaining = board.filter((s) => s.userId !== userId);

    // overwrite list with remaining strokes
    await redisClient.del(REDIS_LIST_KEY);
    if (remaining.length > 0) {
      const strs = remaining.map((s) => JSON.stringify(s));
      await redisClient.rPush(REDIS_LIST_KEY, strs);
    }

    await redisClient.publish(
      REDIS_CHANNEL,
      JSON.stringify({
        type: "clear-user",
        payload: { userId },
      })
    );

    console.log("🧽 user", userId, "cleared only their strokes");
  });

  socket.on("disconnect", () => {
    console.log("🔴 client disconnected:", socket.id, "user:", userId);
  });
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ node listening on http://localhost:${PORT}`);
});
