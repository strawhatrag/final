// server.js – final version using Socket.IO Redis adapter + Redis persistence

import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import path from "path";
import { fileURLToPath } from "url";

// -------------------------
// Path + Express
// -------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------------------------
// Redis setup
// -------------------------
const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_URL = `redis://${REDIS_HOST}:6379`;
const STROKE_KEY = "whiteboard:strokes";

const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();
const dbClient = pubClient.duplicate();

await Promise.all([
  pubClient.connect(),
  subClient.connect(),
  dbClient.connect(),
]);
console.log(`✅ Connected to Redis at ${REDIS_HOST}`);

// -------------------------
// Socket.IO with Redis adapter
// -------------------------
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
io.adapter(createAdapter(pubClient, subClient));

// Helper: load all strokes from Redis list
async function getFullBoard() {
  const items = await dbClient.lRange(STROKE_KEY, 0, -1);
  return items.map((s) => JSON.parse(s));
}

// -------------------------
// Socket.IO events
// -------------------------
io.on("connection", (socket) => {
  let userId = null;
  console.log("🟢 Client connected:", socket.id);

  socket.on("register", async (data) => {
    userId = data?.userId || socket.id.slice(0, 5).toUpperCase();

    // Tell the client what ID we’re using
    socket.emit("user-info", { userId });

    // Send them the current full board from Redis
    const strokes = await getFullBoard();
    socket.emit("init-board", strokes);

    console.log(
      `👤 User ${userId} registered, strokes sent: ${strokes.length}`
    );
  });

  // DRAW: store + broadcast to everyone else
  socket.on("draw", async (data) => {
    if (!userId) return;

    const stroke = { ...data, userId };
    await dbClient.rPush(STROKE_KEY, JSON.stringify(stroke));

    // broadcast to all *other* clients across ALL nodes
    socket.broadcast.emit("draw", stroke);
  });

  // CLEAR ALL: wipe Redis + broadcast to all
  socket.on("clear-all", async () => {
    if (!userId) return;

    await dbClient.del(STROKE_KEY);
    io.emit("clear-all"); // Redis adapter sends to clients on all app containers
    console.log(`🧹 Full board cleared by ${userId}`);
  });

  // CLEAR MINE: remove only this user’s strokes + broadcast filtered board
  socket.on("clear-mine", async () => {
    if (!userId) return;

    const strokes = await getFullBoard();
    const remaining = strokes.filter((s) => s.userId !== userId);

    await dbClient.del(STROKE_KEY);
    if (remaining.length) {
      await dbClient.rPush(
        STROKE_KEY,
        remaining.map((s) => JSON.stringify(s))
      );
    }

    // Tell ALL clients (across nodes) to redraw from filtered board
    io.emit("reset-board", remaining);
    console.log(
      `🧽 User ${userId} cleared their strokes. Remaining strokes: ${remaining.length}`
    );
  });

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected:", socket.id, "user:", userId);
  });
});

// -------------------------
// Start HTTP server
// -------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Node listening on http://localhost:${PORT}`);
});
