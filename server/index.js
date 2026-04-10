const dotenv = require("dotenv");
const axios = require("axios");
const { OpenAI } = require("openai");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const http = require("http");
const { Server } = require("socket.io");
const IPL_SCHEDULE = require("./schedule");

async function isVotingLocked(matchId) {
  const match = IPL_SCHEDULE.find((m) => m.id === matchId);
  if (!match) return false;

  const override = await queryOne("SELECT manual_locked, lock_delay FROM match_overrides WHERE match_id = $1", [matchId]);
  if (override) {
    if (override.manual_locked !== null) return override.manual_locked;
    const now = new Date();
    const timeStr = match.time || "19:30";
    const lockTime = new Date(`${match.date}T${timeStr}:00+05:30`);
    const finalLockTime = new Date(lockTime.getTime() + (override.lock_delay * 60000));
    return now >= finalLockTime;
  }

  const now = new Date();
  const timeStr = match.time || "19:30";
  const lockTime = new Date(`${match.date}T${timeStr}:00+05:30`);
  return now >= lockTime;
}

dotenv.config();

const openai = process.env.OPENAI_API_KEY ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
}) : null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const app = express();
const PORT = Number(requireEnv("PORT"));
const JWT_SECRET = requireEnv("JWT_SECRET");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
const DATABASE_URL = requireEnv("DATABASE_URL");
const ADMIN_USERNAME = requireEnv("ADMIN_USERNAME");
const ADMIN_DEFAULT_PW = requireEnv("ADMIN_DEFAULT_PW");

if (Number.isNaN(PORT)) {
  throw new Error("PORT must be a valid number");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function initDb() {
  // ── Rooms ──
  await query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      created_by INTEGER, -- will add FK later
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, -- will add FK later
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (room_id, user_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      profile_pic TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add FKs if they weren't added (for existing rooms table)
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_created_by_fkey') THEN
        ALTER TABLE rooms ADD CONSTRAINT rooms_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_members_user_id_fkey') THEN
        ALTER TABLE room_members ADD CONSTRAINT room_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      match_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      prediction TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Explicitly add room_id column if it doesn't exist (for existing votes table)
  await query(`
    ALTER TABLE votes ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE;
  `);

  // Ensure STAGS room exists for migration
  await query(`
    INSERT INTO rooms (name, invite_code)
    VALUES ('STAGS', 'STAGS1')
    ON CONFLICT (name) DO NOTHING
  `);

  const stagsRoom = await queryOne("SELECT id FROM rooms WHERE name = 'STAGS' LIMIT 1");
  if (stagsRoom) {
    await query(`UPDATE votes SET room_id = $1 WHERE room_id IS NULL`, [stagsRoom.id]);
  }

  // Ensure unique constraint on (match_id, user_id, room_id)
  await query(`
    ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_match_id_user_id_key;
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'votes_room_match_user_unique') THEN
        ALTER TABLE votes ADD CONSTRAINT votes_room_match_user_unique UNIQUE(match_id, user_id, room_id);
      END IF;
    END $$;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS results (
      match_id TEXT PRIMARY KEY,
      winner TEXT NOT NULL,
      score_summary TEXT,
      toss TEXT,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS details JSONB;`);
  await query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS toss TEXT;`);

  await query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      match_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL;`);

  await query(`
    CREATE TABLE IF NOT EXISTS match_overrides (
      match_id TEXT PRIMARY KEY,
      manual_locked BOOLEAN DEFAULT NULL,
      lock_delay INTEGER DEFAULT 0
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_chat_room_match ON chat_messages(room_id, match_id);`);

  // Bot columns & reactions table
  await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS bot_name TEXT;`);
  await query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, user_id, emoji)
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);`);

  // Bot user (never logs in — used to author bot messages)
  const botHash = await bcrypt.hash('scorebot_internal_do_not_use', 4);
  await query(
    `INSERT INTO users (username, password_hash) VALUES ('scorebot', $1) ON CONFLICT (username) DO NOTHING`,
    [botHash]
  );
  const botRow = await queryOne("SELECT id FROM users WHERE username = 'scorebot'");
  BOT_USER_ID = botRow?.id || null;

  await query(`
    CREATE TABLE IF NOT EXISTS match_bot_settings (
      match_id TEXT PRIMARY KEY,
      bot_enabled BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const existing = await queryOne(
    "SELECT id FROM users WHERE username = $1",
    [ADMIN_USERNAME]
  );

  if (!existing) {
    const hash = bcrypt.hashSync(ADMIN_DEFAULT_PW, 10);
    await query(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE)",
      [ADMIN_USERNAME, hash]
    );
    console.log(`Default admin created: ${ADMIN_USERNAME} / ${ADMIN_DEFAULT_PW}`);
  }

  // Seed STAGS room creator (now that user might exist)
  await query(`
    UPDATE rooms SET created_by = (SELECT id FROM users WHERE username = 'manoharcb' LIMIT 1)
    WHERE name = 'STAGS' AND created_by IS NULL
  `);

  // Add all existing non-admin users to STAGS (idempotent)
  await query(`
    INSERT INTO room_members (room_id, user_id)
    SELECT r.id, u.id FROM rooms r, users u
    WHERE r.name = 'STAGS' AND NOT u.is_admin
    ON CONFLICT DO NOTHING
  `);
}

app.use(cors());
app.use(express.json());

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Admin only" });
  next();
}

/** ─── Basic API Protection ─── */
function securityMiddleware(req, res, next) {
  if (req.headers["x-app-source"] !== "web-app") {
    return res.status(403).json({ error: "Access denied. Use the official application to perform this action." });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error(err);
      next(err);
    });
  };
}

// ─── Socket.io Setup ───
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const roomUsers = new Map();
const roomSeenState = new Map(); // roomKey -> Map<userId, { userId, username, profilePic, messageId }>
const autoRoastTimestamps = new Map(); // `${roomId}_${matchId}` -> lastTimestamp
let BOT_USER_ID = null; // set in initDb

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Authentication error"));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Authentication error"));
  }
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.user.username}`);

  socket.on("join_chat", ({ roomId, matchId }) => {
    const roomKey = `chat_${roomId}_${matchId}`;
    socket.join(roomKey);

    // Track online users
    if (!roomUsers.has(roomKey)) roomUsers.set(roomKey, new Map());
    roomUsers.get(roomKey).set(socket.id, {
      userId: socket.user.id,
      username: socket.user.username,
      profile_pic: socket.user.profile_pic
    });

    // Broadcast list
    const users = Array.from(roomUsers.get(roomKey).values());
    io.to(roomKey).emit("online_users", users);

    // Post bot intro — for completed matches post a summary too
    queryOne('SELECT match_id FROM results WHERE match_id = $1', [matchId]).then(result => {
      if (result) {
        postIntroAndSummaryForCompletedMatch(roomId, matchId).catch(e => console.error('[Bot] Summary error:', e.message));
      } else {
        postIntroIfNeeded(roomId, matchId).catch(e => console.error('[Bot] Intro error:', e.message));
      }
    }).catch(e => console.error('[Bot] join_chat check error:', e.message));

    console.log(`${socket.user.username} joined ${roomKey}`);
  });

  socket.on("send_message", async ({ roomId, matchId, message, replyToId }) => {
    if (!message || String(message).trim().length === 0) return;
    const msg = String(message).trim().substring(0, 500);

    // ── /command (any slash command) ──────────────────────────────────────
    if (msg.startsWith('/')) {
      const query_str = msg.slice(1).trim(); // everything after the leading /
      // Save the user's question so others can see it
      try {
        const saved = await queryOne(`
          INSERT INTO chat_messages (room_id, match_id, user_id, message, reply_to_id)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, room_id, match_id, user_id, message, reply_to_id, created_at
        `, [roomId, matchId, socket.user.id, msg, replyToId || null]);
        io.to(`chat_${roomId}_${matchId}`).emit("new_message", {
          ...saved,
          username: socket.user.username,
          profile_pic: socket.user.profile_pic,
        });
      } catch (e) {
        console.error("Chat Error (bot query save):", e);
      }
      handleBotQuery(roomId, matchId, query_str || 'help', socket.user.username).catch(e =>
        console.error('[Bot] Query error:', e.message)
      );
      return;
    }

    try {
      const saved = await queryOne(`
        INSERT INTO chat_messages (room_id, match_id, user_id, message, reply_to_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, room_id, match_id, user_id, message, reply_to_id, created_at
      `, [roomId, matchId, socket.user.id, msg, replyToId || null]);

      let replyToData = null;
      if (saved.reply_to_id) {
        const original = await queryOne(`
          SELECT m.message, u.username 
          FROM chat_messages m 
          JOIN users u ON u.id = m.user_id 
          WHERE m.id = $1
        `, [saved.reply_to_id]);
        if (original) {
          replyToData = {
            username: original.username,
            message: original.message.substring(0, 50).concat(original.message.length > 50 ? "..." : "")
          };
        }
      }

      const payload = {
        ...saved,
        username: socket.user.username,
        profile_pic: socket.user.profile_pic,
        reply_to_message: replyToData
      };

      io.to(`chat_${roomId}_${matchId}`).emit("new_message", payload);

      // Auto-roast: check for team mentions in chat (rate-limited to once per 60s per room)
      const roastKey = `${roomId}_${matchId}`;
      const lastRoast = autoRoastTimestamps.get(roastKey) || 0;
      if (Date.now() - lastRoast > 60000 && await isBotEnabled(matchId)) {
        const roastReply = getTeamMentionRoast(msg, matchId);
        if (roastReply) {
          autoRoastTimestamps.set(roastKey, Date.now());
          postBotMessage(roomId, matchId, roastReply, getBotName(matchId)).catch(e =>
            console.error('[Bot] Roast error:', e.message)
          );
        }
      }
    } catch (e) {
      console.error("Chat Error:", e);
    }
  });

  // ── Seen receipts ────────────────────────────────────────────────────────
  socket.on("mark_seen", ({ roomId, matchId, messageId }) => {
    if (!messageId) return;
    const roomKey = `chat_${roomId}_${matchId}`;
    if (!roomSeenState.has(roomKey)) roomSeenState.set(roomKey, new Map());
    roomSeenState.get(roomKey).set(socket.user.id, {
      userId: socket.user.id,
      username: socket.user.username,
      profilePic: socket.user.profile_pic,
      messageId,
    });
    const seenBy = Array.from(roomSeenState.get(roomKey).values());
    io.to(roomKey).emit("seen_update", { seenBy });
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.user.username}`);
    for (const [roomKey, usersMap] of roomUsers.entries()) {
      if (usersMap.has(socket.id)) {
        usersMap.delete(socket.id);
        const users = Array.from(usersMap.values());
        io.to(roomKey).emit("online_users", users);
        // Remove from seen state and broadcast update
        if (roomSeenState.has(roomKey)) {
          roomSeenState.get(roomKey).delete(socket.user.id);
          const seenBy = Array.from(roomSeenState.get(roomKey).values());
          io.to(roomKey).emit("seen_update", { seenBy });
        }
      }
    }
  });
});

app.post("/api/register", asyncRoute(async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 2 || trimmedUsername.length > 20) {
      return res.status(400).json({ error: "Username must be 2-20 characters" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await queryOne(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, is_admin, profile_pic`,
      [trimmedUsername, hash]
    );

    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin, profile_pic: user.profile_pic },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token, user });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(400).json({ error: "Username already taken" });
    }
    res.status(500).json({ error: "Registration failed" });
  }
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const user = await queryOne(
    "SELECT * FROM users WHERE username = $1",
    [username.trim()]
  );
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin, profile_pic: user.profile_pic },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      is_admin: user.is_admin,
      profile_pic: user.profile_pic,
    },
  });
}));

app.get("/api/me", authMiddleware, asyncRoute(async (req, res) => {
  const user = await queryOne(
    "SELECT id, username, is_admin, profile_pic FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
}));

app.put("/api/me", authMiddleware, asyncRoute(async (req, res) => {
  const { username, password, profile_pic } = req.body;
  const updates = [];
  const params = [req.user.id];
  let paramIdx = 2;

  if (username) {
    const trimmed = username.trim();
    if (trimmed.length < 2 || trimmed.length > 20) {
      return res.status(400).json({ error: "Username must be 2-20 characters" });
    }
    updates.push(`username = $${paramIdx++}`);
    params.push(trimmed);
  }

  if (password) {
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    updates.push(`password_hash = $${paramIdx++}`);
    params.push(await bcrypt.hash(password, 10));
  }

  if (profile_pic !== undefined) {
    updates.push(`profile_pic = $${paramIdx++}`);
    params.push(profile_pic || null);
  }

  if (updates.length > 0) {
    try {
      await query(`UPDATE users SET ${updates.join(", ")} WHERE id = $1`, params);
    } catch (e) {
      if (e.code === "23505") return res.status(400).json({ error: "Username already taken" });
      throw e;
    }
  }

  const updatedUser = await queryOne(
    "SELECT id, username, is_admin, profile_pic FROM users WHERE id = $1",
    [req.user.id]
  );

  const token = jwt.sign(
    { id: updatedUser.id, username: updatedUser.username, is_admin: updatedUser.is_admin, profile_pic: updatedUser.profile_pic },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({ ok: true, token, user: updatedUser });
}));

app.post("/api/admin/unlock", authMiddleware, asyncRoute(async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Wrong admin password" });
  }

  await query("UPDATE users SET is_admin = TRUE WHERE id = $1", [req.user.id]);
  const token = jwt.sign({ ...req.user, is_admin: true }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, message: "Admin access granted" });
}));

app.get("/api/votes", authMiddleware, asyncRoute(async (req, res) => {
  const { roomId } = req.query;
  const roomFilter = roomId ? "AND v.room_id = $1" : "";
  const params = roomId ? [roomId] : [];

  const rows = await query(`
    SELECT v.match_id, u.username, v.prediction, v.room_id
    FROM votes v
    JOIN users u ON v.user_id = u.id
    WHERE 1=1 ${roomFilter}
  `, params);

  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.match_id]) grouped[r.match_id] = {};
    const locked = await isVotingLocked(r.match_id);
    if (!locked && r.username !== req.user.username && !req.user.is_admin) {
      continue;
    }
    grouped[r.match_id][r.username] = r.prediction;
  }
  res.json(grouped);
}));

app.get("/api/vote-counts", asyncRoute(async (req, res) => {
  const { roomId } = req.query;
  const roomFilter = roomId ? "WHERE room_id = $1" : "";
  const params = roomId ? [roomId] : [];

  const rows = await query(`
    SELECT match_id, prediction, COUNT(*)::int AS cnt
    FROM votes
    ${roomFilter}
    GROUP BY match_id, prediction
  `, params);

  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.match_id]) grouped[r.match_id] = {};
    const locked = await isVotingLocked(r.match_id);
    if (locked) {
      grouped[r.match_id][r.prediction] = r.cnt;
    } else {
      grouped[r.match_id]._total = (grouped[r.match_id]._total || 0) + r.cnt;
    }
  }
  res.json(grouped);
}));

app.post("/api/vote", authMiddleware, securityMiddleware, asyncRoute(async (req, res) => {
  const { matchId, prediction, roomId } = req.body;
  if (!matchId || !prediction || !roomId) {
    return res.status(400).json({ error: "matchId, prediction, and roomId required" });
  }

  // verify membership
  const membership = await queryOne("SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2", [roomId, req.user.id]);
  if (!membership && !req.user.is_admin) {
    return res.status(403).json({ error: "Not a member of this room" });
  }

  await query(
    `INSERT INTO votes (match_id, user_id, prediction, room_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (match_id, user_id, room_id)
     DO UPDATE SET prediction = EXCLUDED.prediction`,
    [matchId, req.user.id, prediction, roomId]
  );

  res.json({ ok: true });
}));

app.post("/api/vote/bulk", authMiddleware, securityMiddleware, asyncRoute(async (req, res) => {
  const { matchId, prediction } = req.body;
  if (!matchId || !prediction) {
    return res.status(400).json({ error: "matchId and prediction required" });
  }

  const isLocked = await isVotingLocked(matchId);
  if (isLocked) {
    return res.status(400).json({ error: "Voting is locked for this match" });
  }

  const rooms = await query(
    "SELECT room_id FROM room_members WHERE user_id = $1",
    [req.user.id]
  );

  if (rooms.length === 0) {
    return res.status(400).json({ error: "You are not a member of any rooms" });
  }

  const values = rooms.map(r => `('${matchId}', ${req.user.id}, '${prediction}', ${r.room_id})`).join(",");

  await query(`
    INSERT INTO votes (match_id, user_id, prediction, room_id)
    VALUES ${values}
    ON CONFLICT (match_id, user_id, room_id)
    DO UPDATE SET prediction = EXCLUDED.prediction
  `);

  res.json({ ok: true, roomCount: rooms.length });
}));

app.post("/api/admin/vote", authMiddleware, adminMiddleware, securityMiddleware, asyncRoute(async (req, res) => {
  const { matchId, username, prediction, roomId } = req.body;
  if (!matchId || !username || !prediction || !roomId) {
    return res.status(400).json({ error: "matchId, username, prediction, and roomId required" });
  }

  const user = await queryOne("SELECT id FROM users WHERE username = $1", [username]);
  if (!user) return res.status(404).json({ error: "User not found" });

  await query(
    `INSERT INTO votes (match_id, user_id, prediction, room_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (match_id, user_id, room_id)
     DO UPDATE SET prediction = EXCLUDED.prediction`,
    [matchId, user.id, prediction, roomId]
  );

  res.json({ ok: true });
}));

app.post("/api/admin/delete-vote", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { matchId, username, roomId } = req.body;
  if (!matchId || !username || !roomId) {
    return res.status(400).json({ error: "matchId, username, and roomId required" });
  }

  const user = await queryOne("SELECT id FROM users WHERE username = $1", [username]);
  if (!user) return res.status(404).json({ error: "User not found" });

  await query("DELETE FROM votes WHERE match_id = $1 AND user_id = $2 AND room_id = $3", [matchId, user.id, roomId]);
  res.json({ ok: true });
}));

app.post("/api/admin/set-password", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const user = await queryOne("SELECT id FROM users WHERE username = $1", [username]);
  if (!user) return res.status(404).json({ error: "User not found" });

  const hash = await bcrypt.hash(password, 10);
  await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, user.id]);

  res.json({ ok: true });
}));

app.post("/api/admin/reset", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  await query("DELETE FROM votes");
  await query("DELETE FROM results");
  res.json({ ok: true, message: "All votes and results cleared" });
}));

app.post("/api/admin/sync-results", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const result = await checkRecentMatches(true);
  res.json(result);
}));

app.get("/api/results", asyncRoute(async (req, res) => {
  const rows = await query("SELECT match_id, winner, score_summary, toss FROM results");
  const map = {};
  for (const r of rows) {
    map[r.match_id] = {
      winner: r.winner,
      scoreSummary: r.score_summary || null,
      toss: r.toss || null,
    };
  }
  res.json(map);
}));

app.post("/api/result", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { matchId, winner, scoreSummary } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  if (!winner) {
    await query("DELETE FROM results WHERE match_id = $1", [matchId]);
  } else {
    const summary =
      scoreSummary !== undefined && scoreSummary !== "" ? scoreSummary : null;
    await query(
      `INSERT INTO results (match_id, winner, score_summary)
       VALUES ($1, $2, $3)
       ON CONFLICT (match_id)
       DO UPDATE SET
         winner = EXCLUDED.winner,
         score_summary = CASE
           WHEN EXCLUDED.score_summary IS NOT NULL THEN EXCLUDED.score_summary
           ELSE results.score_summary
         END`,
      [matchId, winner, summary]
    );

    // Clear chat history for this match as it's now completed
    await query("DELETE FROM chat_messages WHERE match_id = $1", [matchId]);
  }

  res.json({ ok: true });
}));

function computeUserTimingStats(voteRows) {
  if (!voteRows || voteRows.length === 0) return {};

  const matchMap = new Map(IPL_SCHEDULE.map((m) => [m.id, m]));
  const byUser = new Map();

  for (const row of voteRows) {
    const match = matchMap.get(row.match_id);
    if (!match) continue;
    const createdAt = new Date(row.created_at);
    if (Number.isNaN(createdAt.getTime())) continue;
    const lockTime = new Date(`${match.date}T${match.time}:00+05:30`);
    const diffMinutes = Math.abs((lockTime.getTime() - createdAt.getTime()) / 60000);

    let stats = byUser.get(row.user_id);
    if (!stats) {
      stats = {
        totalDiff: 0,
        count: 0,
        firstVoteAt: createdAt,
      };
      byUser.set(row.user_id, stats);
    }
    stats.totalDiff += diffMinutes;
    stats.count += 1;
    if (createdAt < stats.firstVoteAt) {
      stats.firstVoteAt = createdAt;
    }
  }

  const out = {};
  for (const [userId, stats] of byUser.entries()) {
    out[userId] = {
      nrr: stats.count > 0 ? stats.totalDiff / stats.count : null,
      firstVoteAt: stats.firstVoteAt,
    };
  }
  return out;
}

async function getLeaderboardInternal() {
  const board = await query(`
    SELECT
      u.id AS user_id,
      u.username,
      u.profile_pic,
      COALESCE(SUM(
        CASE
          WHEN r.winner IS NULL THEN 0
          WHEN r.winner IN ('nr', 'draw') THEN 1
          WHEN v.prediction = r.winner THEN 2
          ELSE 0
        END
      ), 0)::int AS points,
      COALESCE(SUM(
        CASE WHEN r.winner IN ('nr', 'draw') THEN 1 ELSE 0 END
      ), 0)::int AS nr,
      COALESCE(SUM(
        CASE WHEN r.winner IS NOT NULL AND r.winner NOT IN ('nr', 'draw') AND v.prediction = r.winner THEN 1 ELSE 0 END
      ), 0)::int AS correct,
      COALESCE(COUNT(r.match_id), 0)::int AS voted,
      (SELECT COUNT(*)::int FROM results) AS matches
    FROM users u
    LEFT JOIN votes v ON v.user_id = u.id
    LEFT JOIN results r ON r.match_id = v.match_id
    GROUP BY u.id, u.username, u.profile_pic
  `);

  const voteRows = await query(
    `SELECT user_id, match_id, created_at
     FROM votes`
  );
  const timing = computeUserTimingStats(voteRows);

  const enriched = board.map((row) => {
    const t = timing[row.user_id] || {};
    return {
      ...row,
      nrr: t.nrr ?? null,
      first_vote_at: t.firstVoteAt ? t.firstVoteAt.toISOString() : null,
    };
  });

  enriched.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.correct !== a.correct) return b.correct - a.correct;
    const valA = a.nrr ?? -Infinity;
    const valB = b.nrr ?? -Infinity;
    if (valB !== valA) return valB - valA;
    return a.username.localeCompare(b.username);
  });

  return enriched;
}

app.get("/api/leaderboard", asyncRoute(async (req, res) => {
  const enriched = await getLeaderboardInternal();
  res.json(enriched);
}));

app.get("/api/last-poll-summary", authMiddleware, asyncRoute(async (req, res) => {
  // 1. Get the latest match with a result
  const lastResult = await queryOne(`
    SELECT r.match_id, r.winner, r.score_summary, r.created_at
    FROM results r
    ORDER BY r.created_at DESC
    LIMIT 1
  `);

  if (!lastResult) {
    return res.json({ noData: true });
  }

  const matchId = lastResult.match_id;
  const match = IPL_SCHEDULE.find(m => m.id === matchId);
  if (!match) return res.json({ noData: true });

  // 2. Get votes for this match
  const votes = await query(`
    SELECT v.user_id, u.username, v.prediction
    FROM votes v
    JOIN users u ON v.user_id = u.id
    WHERE v.match_id = $1
  `, [matchId]);

  const winners = votes.filter(v => v.prediction === lastResult.winner).map(v => v.username);

  // 3. User specific status
  const userVote = votes.find(v => v.user_id === req.user.id);
  const isCorrect = userVote && (
    userVote.prediction === lastResult.winner ||
    (['nr', 'draw'].includes(lastResult.winner))
  );

  const userStatus = userVote
    ? (isCorrect ? 'won' : 'lost')
    : 'no_vote';

  // 4. Rank Change Calculation for ALL users in this match
  const currentBoard = await getLeaderboardInternal();

  // Previous points calculation for all users
  const prevBoard = currentBoard.map(user => {
    // Only subtract if they voted in THIS match
    const vote = votes.find(v => v.user_id === user.user_id);
    let pointsGained = 0;
    let correctGained = 0;
    if (vote) {
      if (lastResult.winner === 'nr' || lastResult.winner === 'draw') {
        pointsGained = 1;
      } else if (vote.prediction === lastResult.winner) {
        pointsGained = 2;
        correctGained = 1;
      }
    }
    return {
      ...user,
      points: user.points - pointsGained,
      correct: user.correct - correctGained,
      voted: user.voted - (vote ? 1 : 0)
    };
  });

  // Re-sort previous board to get previous ranks
  prevBoard.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.correct !== a.correct) return b.correct - a.correct;
    const valA = a.nrr ?? -Infinity;
    const valB = b.nrr ?? -Infinity;
    if (valB !== valA) return valB - valA;
    return a.username.localeCompare(b.username);
  });

  const getRank = (board, userId) => {
    const idx = board.findIndex(u => u.user_id === userId);
    return idx === -1 ? board.length : idx + 1;
  };

  const currentRank = getRank(currentBoard, req.user.id);
  const prevRank = getRank(prevBoard, req.user.id);
  const pointsGained = (userVote && (lastResult.winner === 'nr' || lastResult.winner === 'draw'))
    ? 1
    : (userVote && userVote.prediction === lastResult.winner ? 2 : 0);

  // User outcomes for everyone who participated
  const userOutcomes = votes.map(v => {
    const cRank = getRank(currentBoard, v.user_id);
    const pRank = getRank(prevBoard, v.user_id);
    const correct = v.prediction === lastResult.winner || ['nr', 'draw'].includes(lastResult.winner);
    return {
      username: v.username,
      prediction: v.prediction,
      status: correct ? 'won' : 'lost',
      currentRank: cRank,
      prevRank: pRank,
      rankChange: pRank - cRank
    };
  });

  res.json({
    matchId,
    team1: match.team1,
    team2: match.team2,
    winner: lastResult.winner,
    scoreSummary: lastResult.score_summary,
    userVote: userVote ? userVote.prediction : null,
    userStatus,
    pointsGained,
    currentRank,
    prevRank,
    rankChange: prevRank - currentRank,
    userOutcomes,
    totalVoters: votes.length
  });
}));

app.get("/api/users", asyncRoute(async (req, res) => {
  const users = await query("SELECT id, username FROM users ORDER BY username ASC");
  res.json(users);
}));

/** Logged-in users: another user's vote history (for leaderboard profile tap). */
app.get("/api/users/:username/predictions", authMiddleware, asyncRoute(async (req, res) => {
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(400).json({ error: "username required" });
  const target = await queryOne("SELECT id FROM users WHERE username = $1", [username]);
  if (!target) return res.status(404).json({ error: "User not found" });
  const { roomId } = req.query;
  const roomFilter = roomId ? "AND v.room_id = $2" : "";
  const params = roomId ? [target.id, roomId] : [target.id];

  const rows = await query(
    `SELECT v.match_id AS "matchId", v.prediction, r.winner AS outcome
     FROM votes v
     LEFT JOIN results r ON r.match_id = v.match_id
     WHERE v.user_id = $1 ${roomFilter}
     ORDER BY v.match_id ASC`,
    params
  );

  const votesResult = [];
  for (const r of rows) {
    const isOwner = target.id === req.user.id;
    const isAdmin = req.user.is_admin;
    const locked = await isVotingLocked(r.matchId);

    // If the match hasn't started yet, hide the prediction from others
    if (!locked && !isOwner && !isAdmin) {
      votesResult.push({ ...r, prediction: "HIDDEN" });
    } else {
      votesResult.push(r);
    }
  }
  res.json({ votes: votesResult });
}));

// ─── Room routes ────────────────────────────────────────────────────────────

function generateInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Create room
app.post("/api/rooms", authMiddleware, asyncRoute(async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: "Room name must be at least 2 characters" });
  }
  try {
    const room = await queryOne(
      `INSERT INTO rooms (name, invite_code, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, invite_code`,
      [name.trim(), generateInviteCode(), req.user.id]
    );
    await query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [room.id, req.user.id]
    );
    res.json(room);
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "Room name already taken" });
    throw e;
  }
}));

// Join room by invite code
app.post("/api/rooms/join", authMiddleware, asyncRoute(async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: "Invite code required" });
  const room = await queryOne(
    "SELECT id, name, invite_code FROM rooms WHERE UPPER(invite_code) = UPPER($1)",
    [inviteCode.trim()]
  );
  if (!room) return res.status(404).json({ error: "Invalid invite code" });
  await query(
    `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [room.id, req.user.id]
  );
  res.json({ room });
}));

// My rooms
app.get("/api/rooms/mine", authMiddleware, asyncRoute(async (req, res) => {
  const rooms = await query(`
    SELECT r.id, r.name, r.invite_code, r.created_by,
           COUNT(rm2.user_id)::int AS member_count
    FROM rooms r
    JOIN room_members rm  ON rm.room_id  = r.id AND rm.user_id = $1
    JOIN room_members rm2 ON rm2.room_id = r.id
    GROUP BY r.id, r.name, r.invite_code, r.created_by
    ORDER BY r.name ASC
  `, [req.user.id]);
  res.json(rooms);
}));

// Shared leaderboard logic used by both the API and the bot /top command
async function getRoomLeaderboard(roomId) {
  const room = await queryOne("SELECT created_at FROM rooms WHERE id = $1", [roomId]);
  if (!room) return [];

  const board = await query(`
    SELECT
      u.id AS user_id,
      u.username,
      u.profile_pic,
      COALESCE(SUM(
        CASE
          WHEN vr.winner IN ('nr','draw') THEN 1
          WHEN vr.prediction = vr.winner THEN 2
          ELSE 0
        END
      ), 0)::int AS points,
      COALESCE(SUM(
        CASE WHEN vr.winner IN ('nr', 'draw') THEN 1 ELSE 0 END
      ), 0)::int AS nr,
      COALESCE(SUM(
        CASE WHEN vr.winner NOT IN ('nr', 'draw') AND vr.prediction = vr.winner THEN 1 ELSE 0 END
      ), 0)::int AS correct,
      COALESCE(COUNT(vr.match_id), 0)::int AS voted,
      (SELECT COUNT(*)::int FROM results) AS matches
    FROM users u
    JOIN room_members rm ON rm.user_id = u.id AND rm.room_id = $1
    LEFT JOIN (
      SELECT v.user_id, v.match_id, v.prediction, r.winner
      FROM results r
      JOIN votes v ON v.match_id = r.match_id AND v.room_id = $1 AND v.created_at >= $2
    ) vr ON vr.user_id = u.id
    GROUP BY u.id, u.username, u.profile_pic
  `, [roomId, room.created_at]);

  const userIds = board.map((b) => b.user_id);
  let timing = {};
  if (userIds.length > 0) {
    const voteRows = await query(
      `SELECT user_id, match_id, created_at
       FROM votes
       WHERE user_id = ANY($1::int[]) AND room_id = $2 AND created_at >= $3`,
      [userIds, roomId, room.created_at]
    );
    timing = computeUserTimingStats(voteRows);
  }

  const enriched = board.map((row) => {
    const t = timing[row.user_id] || {};
    return { ...row, nrr: t.nrr ?? null };
  });

  enriched.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.correct !== a.correct) return b.correct - a.correct;
    const valA = a.nrr ?? -Infinity;
    const valB = b.nrr ?? -Infinity;
    if (valB !== valA) return valB - valA;
    return a.username.localeCompare(b.username);
  });

  return enriched;
}

// Room leaderboard — register BEFORE /:id to avoid route conflict
app.get("/api/rooms/:id/leaderboard", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  if (isNaN(roomId)) return res.status(400).json({ error: "Invalid room id" });
  const member = await queryOne(
    "SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, req.user.id]
  );
  if (!member && !req.user.is_admin) return res.status(403).json({ error: "Not a member of this room" });
  const enriched = await getRoomLeaderboard(roomId);
  if (!enriched.length) return res.status(404).json({ error: "Room not found" });
  res.json(enriched);
}));

// Room details
app.get("/api/rooms/:id", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  if (isNaN(roomId)) return res.status(400).json({ error: "Invalid room id" });
  const member = await queryOne(
    "SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, req.user.id]
  );
  if (!member && !req.user.is_admin) return res.status(403).json({ error: "Not a member of this room" });
  const room = await queryOne("SELECT id, name, invite_code FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const members = await query(
    `SELECT u.username FROM users u JOIN room_members rm ON rm.user_id = u.id WHERE rm.room_id = $1 ORDER BY u.username ASC`,
    [roomId]
  );
  res.json({ ...room, members: members.map(m => m.username) });
}));

// Get chat history
app.get("/api/rooms/:roomId/chat/:matchId", authMiddleware, asyncRoute(async (req, res) => {
  const { roomId, matchId } = req.params;

  // Verify membership
  const membership = await queryOne("SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2", [roomId, req.user.id]);
  if (!membership && !req.user.is_admin) {
    return res.status(403).json({ error: "Not a member of this room" });
  }

  const messages = await query(`
    SELECT
      m.id, m.room_id, m.match_id, m.user_id, m.message, m.bot_name, m.created_at, m.reply_to_id,
      CASE WHEN m.bot_name IS NOT NULL THEN m.bot_name ELSE u.username END AS username,
      u.profile_pic,
      r.message AS reply_message, ru.username AS reply_username
    FROM chat_messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN chat_messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.user_id
    WHERE m.room_id = $1 AND m.match_id = $2
    ORDER BY m.created_at ASC
    LIMIT 200
  `, [roomId, matchId]);

  // Attach reactions
  const messageIds = messages.map(m => m.id);
  let reactionsMap = {};
  if (messageIds.length > 0) {
    const reactions = await query(`
      SELECT mr.message_id, mr.emoji, COUNT(*)::int AS count,
        array_agg(mr.user_id) AS user_ids,
        array_agg(u.username) AS usernames
      FROM message_reactions mr
      JOIN users u ON u.id = mr.user_id
      WHERE mr.message_id = ANY($1)
      GROUP BY mr.message_id, mr.emoji
    `, [messageIds]);
    for (const r of reactions) {
      if (!reactionsMap[r.message_id]) reactionsMap[r.message_id] = [];
      reactionsMap[r.message_id].push({ emoji: r.emoji, count: r.count, userIds: r.user_ids || [], usernames: r.usernames || [] });
    }
  }

  const formatted = messages.map(m => ({
    id: m.id,
    room_id: m.room_id,
    match_id: m.match_id,
    user_id: m.user_id,
    message: m.message,
    bot_name: m.bot_name || null,
    is_bot: !!m.bot_name,
    created_at: m.created_at,
    username: m.username,
    profile_pic: m.profile_pic,
    reply_to_message: m.reply_message ? {
      username: m.reply_username,
      message: m.reply_message.substring(0, 50).concat(m.reply_message.length > 50 ? '...' : '')
    } : null,
    reactions: reactionsMap[m.id] || [],
  }));

  res.json(formatted);
}));

// Delete room (creator or admin)
app.delete("/api/rooms/:id", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  if (isNaN(roomId)) return res.status(400).json({ error: "Invalid room id" });
  const room = await queryOne("SELECT id, created_by FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!req.user.is_admin && room.created_by !== req.user.id) {
    return res.status(403).json({ error: "Only the room creator or admin can delete this room" });
  }
  await query("DELETE FROM rooms WHERE id = $1", [roomId]);
  res.json({ ok: true });
}));

// Admin: view all rooms
app.get("/api/admin/rooms", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const rooms = await query(`
    SELECT r.id, r.name, r.invite_code,
           u.username AS created_by_username,
           COUNT(rm.user_id)::int AS member_count
    FROM rooms r
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN room_members rm ON rm.room_id = r.id
    GROUP BY r.id, r.name, r.invite_code, u.username
    ORDER BY r.name ASC
  `);
  res.json(rooms);
}));

// Admin: Set match override
app.post("/api/admin/match-override", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { matchId, manual_locked, lock_delay } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  await query(`
    INSERT INTO match_overrides (match_id, manual_locked, lock_delay)
    VALUES ($1, $2, $3)
    ON CONFLICT (match_id)
    DO UPDATE SET 
      manual_locked = EXCLUDED.manual_locked,
      lock_delay = EXCLUDED.lock_delay
  `, [matchId, manual_locked === undefined ? null : manual_locked, lock_delay || 0]);

  res.json({ ok: true });
}));

// Admin: Set announcement
app.post("/api/admin/announcements", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { text } = req.body;
  if (text === undefined) return res.status(400).json({ error: "text required" });

  await query("UPDATE announcements SET is_active = FALSE");
  if (text.trim()) {
    await query("INSERT INTO announcements (text) VALUES ($1)", [text.trim()]);
  }
  res.json({ ok: true });
}));

// Admin: Clear announcements
app.delete("/api/admin/announcements", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  await query("UPDATE announcements SET is_active = FALSE");
  res.json({ ok: true });
}));

// Get active announcement
app.get("/api/announcements", asyncRoute(async (req, res) => {
  const row = await queryOne("SELECT text FROM announcements WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1");
  res.json(row || { text: "" });
}));

// Get all overrides
app.get("/api/match-overrides", authMiddleware, asyncRoute(async (req, res) => {
  const rows = await query("SELECT * FROM match_overrides");
  res.json(rows);
}));

// ─── Bot Settings ──────────────────────────────────────────────────────────

app.get("/api/match-bot-settings", authMiddleware, asyncRoute(async (req, res) => {
  const rows = await query("SELECT * FROM match_bot_settings");
  res.json(rows);
}));

app.post("/api/admin/match-bot-settings", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { matchId, bot_enabled } = req.body;
  if (!matchId || bot_enabled === undefined) return res.status(400).json({ error: "matchId and bot_enabled required" });
  await query(
    `INSERT INTO match_bot_settings (match_id, bot_enabled) VALUES ($1, $2)
     ON CONFLICT (match_id) DO UPDATE SET bot_enabled = $2`,
    [matchId, !!bot_enabled]
  );
  // Notify all clients in the match chatrooms
  io.emit("bot_settings_update", { matchId, bot_enabled: !!bot_enabled });
  res.json({ ok: true });
}));

// ─── Automated Result Service (ESPN Cricinfo API) ──────────────────────────

const TEAM_NAME_MAP = {
  "Chennai Super Kings": "CSK",
  "Mumbai Indians": "MI",
  "Royal Challengers Bengaluru": "RCB",
  "Royal Challengers Bangalore": "RCB",
  "Kolkata Knight Riders": "KKR",
  "Delhi Capitals": "DC",
  "Punjab Kings": "PBKS",
  "Rajasthan Royals": "RR",
  "Sunrisers Hyderabad": "SRH",
  "Gujarat Titans": "GT",
  "Lucknow Super Giants": "LSG",
};

/** Static home venue fallback (used when ESPN summary venue is unavailable) */
const TEAM_HOME_VENUE = {
  MI:   'Wankhede Stadium, Mumbai',
  CSK:  'MA Chidambaram Stadium, Chennai',
  RCB:  'M. Chinnaswamy Stadium, Bengaluru',
  KKR:  'Eden Gardens, Kolkata',
  DC:   'Arun Jaitley Stadium, Delhi',
  PBKS: 'Mullanpur Stadium, Chandigarh',
  RR:   'Sawai Mansingh Stadium, Jaipur',
  SRH:  'Rajiv Gandhi International Stadium, Hyderabad',
  GT:   'Narendra Modi Stadium, Ahmedabad',
  LSG:  'BRSABV Ekana Cricket Stadium, Lucknow',
};

/**
 * Normalizes team names for fuzzy matching
 */
function normalizeTeam(name) {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Finds the winner from the API response status string
 * Example: "RCB won by 20 runs" -> "RCB"
 */
function parseWinnerFromStatus(status, team1Code, team2Code) {
  if (!status) return null;
  const s = status.toLowerCase();

  // Direct match code check
  if (s.includes(team1Code.toLowerCase())) return team1Code;
  if (s.includes(team2Code.toLowerCase())) return team2Code;

  // Full name check
  for (const [fullName, code] of Object.entries(TEAM_NAME_MAP)) {
    if (s.includes(fullName.toLowerCase())) return code;
  }

  if (s.includes("draw") || s.includes("tied") || s.includes("no result") || s.includes("abandoned")) {
    return "nr";
  }

  return null;
}

/** Score summary from ESPN match: "RR: 187/4 (20.0) · RCB: 145/8 (20.0)\nRR won by 42 runs" */
function extractScoreSummaryESPN(espnMatch) {
  if (!espnMatch) return null;
  const { team1, team2, status } = espnMatch;
  const parts = [];
  if (team1?.score) parts.push(`${team1.short}: ${team1.score}`);
  if (team2?.score) parts.push(`${team2.short}: ${team2.score}`);
  const scoreStr = parts.join(' · ');
  if (scoreStr && status) return `${scoreStr}\n${status}`;
  if (scoreStr) return scoreStr;
  return status || null;
}

/** Extract toss info from ESPN summary notes array.
 *  ESPN format (type:"toss"): "Lucknow Super Giants , elected to field first" */
function extractTossInfoESPN(notes) {
  if (!Array.isArray(notes)) return null;
  const tossNote = notes.find(n => n.type === 'toss');
  if (!tossNote) return null;
  const text = (tossNote.text || '').trim();
  // "Team Name , elected to bat/field first"
  const m = text.match(/^(.+?)\s*,?\s*elected to (bat|field)/i);
  if (!m) return text;
  const winnerFull = m[1].trim();
  const decision = /field/i.test(m[2]) ? 'bowl' : 'bat';
  const winner = TEAM_NAME_MAP[winnerFull] || winnerFull;
  return `${winner} won the toss and chose to ${decision}`;
}

const ESPN_IPL_BASE = 'https://site.api.espn.com/apis/site/v2/sports/cricket/8048';

/** Abbreviate a full team name to initials if not in TEAM_NAME_MAP */
function teamAbbr(fullName) {
  return TEAM_NAME_MAP[fullName] ||
    fullName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
}

/** Convert a single ESPN event to a normalized internal match object */
function adaptESPNEvent(evt) {
  if (!evt?.id) return null;
  const comps = evt.competitors || [];
  const c1 = comps[0] || {};
  const c2 = comps[1] || {};
  const state = evt.fullStatus?.type?.state || 'pre';
  const status = evt.fullStatus?.summary || evt.fullStatus?.type?.description || '';
  const t1Name = c1.displayName || '';
  const t2Name = c2.displayName || '';
  return {
    espnEventId: String(evt.id),
    team1: { name: t1Name, short: teamAbbr(t1Name), score: c1.score || '' },
    team2: { name: t2Name, short: teamAbbr(t2Name), score: c2.score || '' },
    state,          // "pre" | "in" | "post"
    status,         // human-readable e.g. "RR won by 8 wickets"
    startDateISO: evt.date || null,
    winnerName: state === 'post'
      ? (c1.winner ? t1Name : c2.winner ? t2Name : null)
      : null,
  };
}

/** Fetch all IPL events from ESPN Cricinfo (free, no key). Returns normalized match objects. */
async function fetchESPNAll() {
  const resp = await axios.get(`${ESPN_IPL_BASE}/events`, { timeout: 10000 });
  if (!resp.data?.events) return [];
  return resp.data.events.map(adaptESPNEvent).filter(Boolean);
}

/** Parse playing XI and impact player pool for both teams from ESPN summary data */
function extractLineupsESPN(rosters, notes) {
  if (!Array.isArray(rosters)) return null;
  const result = [];
  for (const teamRoster of rosters) {
    const abbr = teamRoster.team?.abbreviation || '';
    const teamName = teamRoster.team?.displayName || '';
    const starters = teamRoster.roster.filter(p => p.starter);

    const xi = starters.slice(0, 11).map(p => {
      const name = p.athlete.battingName || p.athlete.shortName || p.athlete.displayName;
      const tags = [];
      if (p.captain) tags.push('c');
      const pos = p.athlete.position || {};
      const posId   = String(pos.id   || '').toUpperCase();
      const posAbbr = String(pos.abbreviation || '').toUpperCase();
      const posName = String(pos.displayName || pos.name || '').toLowerCase();
      const isKeeper = posId === 'WK' || posAbbr === 'WK' ||
                       posId.includes('WK') || posAbbr.includes('WK') ||
                       posName.includes('wicket') || posName.includes('keeper');
      if (isKeeper) tags.push('wk');
      return tags.length ? `${name} (${tags.join(' & ')})` : name;
    });

    // Impact player pool: matchnote "Team Impact Player Subs: p1, p2 and p3"
    const impactNote = (notes || []).find(n =>
      n.type === 'matchnote' &&
      n.text.includes('Impact Player Subs:') &&
      n.text.toLowerCase().startsWith(teamName.toLowerCase())
    );
    let impactPool = [];
    if (impactNote) {
      const m = impactNote.text.match(/Impact Player Subs:\s*(.+)$/i);
      if (m) impactPool = m[1].split(/,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    }

    result.push({ abbr, xi, impactPool });
  }
  return result.length ? result : null;
}

/** Build the toss announcement message with playing XIs and impact pools */
function formatTossMessage(toss, lineups) {
  const lines = [`🪙 ${toss}`];
  if (Array.isArray(lineups)) {
    for (const team of lineups) {
      lines.push('');
      lines.push(`🏏 ${team.abbr} Playing XI:`);
      lines.push(team.xi.join(', '));
      if (team.impactPool.length > 0) {
        lines.push(`⚡ Impact Players: ${team.impactPool.join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}

/** Fetch toss info + playing XIs for a specific ESPN event via the summary endpoint */
async function fetchESPNSummary(espnEventId) {
  try {
    const resp = await axios.get(
      `${ESPN_IPL_BASE}/summary?event=${espnEventId}`,
      { timeout: 8000 }
    );
    const data = resp.data || {};
    const comp = data.header?.competitions?.[0] || {};
    const venueObj = comp.venue || {};
    const venueName = venueObj.fullName || null;
    const venueCity = venueObj.address?.city || null;
    const venue = venueName
      ? (venueCity && !venueName.includes(venueCity) ? `${venueName}, ${venueCity}` : venueName)
      : null;
    return {
      toss: extractTossInfoESPN(data.notes),
      lineups: extractLineupsESPN(data.rosters, data.notes),
      headToHeadGames: data.headToHeadGames || null,
      standings: data.standings?.children?.[0]?.standings?.entries || null,
      venue,
    };
  } catch (e) {
    return null;
  }
}

// ─── ESPN Data Helpers (used by bot commands) ──────────────────────────────

/** Resolve ESPN event ID for a match: live cache → results DB → events list */
async function getESPNEventId(matchId, match) {
  const cached = commentaryCache.get(matchId);
  if (cached?.espnEventId) return cached.espnEventId;

  const row = await queryOne('SELECT details FROM results WHERE match_id = $1', [matchId]);
  if (row?.details) {
    const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    if (d?.espnEventId) return d.espnEventId;
  }

  try {
    const events = await fetchESPNAll();
    const found = events.find(am => {
      const t1 = am.team1.short, t2 = am.team2.short;
      return (t1 === match.team1 && t2 === match.team2) ||
        (t1 === match.team2 && t2 === match.team1);
    });
    return found?.espnEventId || null;
  } catch (e) {
    return null;
  }
}

/** Fetch IPL points table from ESPN standings field. Resolves an event ID then calls fetchESPNSummary. */
async function fetchESPNPointsTable(preferredEventId = null) {
  let eventId = preferredEventId;

  if (!eventId) {
    for (const [, state] of commentaryCache.entries()) {
      if (state.espnEventId) { eventId = state.espnEventId; break; }
    }
  }
  if (!eventId) {
    const row = await queryOne('SELECT details FROM results ORDER BY created_at DESC LIMIT 1');
    if (row?.details) {
      const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
      eventId = d?.espnEventId;
    }
  }
  if (!eventId) {
    const events = await fetchESPNAll();
    eventId = events[0]?.espnEventId;
  }
  if (!eventId) return null;

  const summary = await fetchESPNSummary(eventId);
  const entries = summary?.standings;
  if (!entries) return null;

  const stat = (e, name) => e.stats.find(s => s.name === name)?.displayValue ?? '-';
  return entries.map(e => ({
    rank: stat(e, 'rank'),
    team: e.team.abbreviation,
    m:    stat(e, 'matchesPlayed'),
    w:    stat(e, 'matchesWon'),
    l:    stat(e, 'matchesLost'),
    nr:   stat(e, 'noresult'),
    pts:  stat(e, 'matchPoints'),
    nrr:  stat(e, 'netrr'),
  }));
}

/** Format points table entries as a text block */
function formatPointsTable(entries) {
  const lines = ['🏆 IPL 2026 Points Table\n'];
  lines.push('# Team   M  W  L NR Pts     NRR');
  lines.push('─'.repeat(34));
  for (const e of entries) {
    const nrr = parseFloat(e.nrr);
    const nrrStr = isNaN(nrr) ? e.nrr : (nrr >= 0 ? '+' + nrr.toFixed(3) : nrr.toFixed(3));
    lines.push(
      `${String(e.rank).padEnd(2)} ${e.team.padEnd(5)} ${String(e.m).padStart(2)} ` +
      `${String(e.w).padStart(2)} ${String(e.l).padStart(2)} ${String(e.nr).padStart(2)} ` +
      `${String(e.pts).padStart(3)} ${nrrStr.padStart(8)}`
    );
  }
  return lines.join('\n');
}

/** Fetch ESPN matchcard data (batting + bowling) for a given event */
async function fetchESPNScorecard(espnEventId) {
  const resp = await axios.get(`${ESPN_IPL_BASE}/summary?event=${espnEventId}`, { timeout: 8000 });
  const matchcards = resp.data?.matchcards || [];
  const header = resp.data?.header?.competitions?.[0];
  const status = header?.status?.type?.description || '';

  const innings = {};
  for (const mc of matchcards) {
    const k = mc.inningsNumber;
    if (!innings[k]) innings[k] = { teamName: mc.teamName };
    if (mc.headline === 'Batting') innings[k].batting = mc;
    if (mc.headline === 'Bowling') innings[k].bowling = mc;
  }
  return { innings, status };
}

/** Format batting + bowling innings block as text */
function formatScorecardText(innings, matchTitle) {
  const lines = [`📋 Scorecard — ${matchTitle}`];
  for (const [, inns] of Object.entries(innings).sort()) {
    const mc = inns.batting;
    if (!mc) continue;
    lines.push('');
    lines.push(`━━ ${mc.teamName} — ${mc.runs ?? '?'} ${mc.total ?? ''} ━━`);
    if (mc.extras) lines.push(`Extras: ${mc.extras}`);
    lines.push('');
    for (const p of mc.playerDetails.filter(p => p.runs !== '')) {
      const dis = p.dismissal || 'not out';
      const sr = p.ballsFaced > 0
        ? ((p.runs / p.ballsFaced) * 100).toFixed(1)
        : '-';
      lines.push(`${p.playerName.padEnd(19)} ${dis.padEnd(14)} ${String(p.runs).padStart(3)}(${p.ballsFaced}) 4s:${p.fours} 6s:${p.sixes} SR:${sr}`);
    }
    if (inns.bowling) {
      lines.push('');
      lines.push('Bowling:');
      for (const p of inns.bowling.playerDetails) {
        lines.push(`${p.playerName.padEnd(19)} ${String(p.overs).padStart(4)}ov  ${p.wickets}w  ${String(p.conceded).padStart(3)}r  econ:${p.economyRate}`);
      }
    }
  }
  return lines.join('\n');
}

/** Format ESPN headToHeadGames array into a readable H2H block */
function formatH2HFromESPN(h2hGames, t1, t2) {
  const lines = [`🤝 ${t1} vs ${t2} — Head to Head\n`];
  let t1Wins = 0, t2Wins = 0, nr = 0;

  for (const game of [...h2hGames].reverse()) { // oldest first
    const dateStr = game.date
      ? new Date(game.date).toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
        })
      : '?';
    const resultSummary = game.status?.summary || game.name || '';
    const winnerComp = Array.isArray(game.competitors)
      ? game.competitors.find(c => c.winner)
      : null;
    const winnerFull = winnerComp?.displayName || null;
    const winnerAbbr = winnerFull ? (TEAM_NAME_MAP[winnerFull] || teamAbbr(winnerFull)) : null;

    if (!winnerAbbr) {
      nr++;
      lines.push(`📅 ${dateStr} — 🌧️ No Result`);
    } else {
      if (winnerAbbr === t1) t1Wins++;
      else if (winnerAbbr === t2) t2Wins++;
      lines.push(`📅 ${dateStr} — 🏆 ${winnerAbbr} won${resultSummary ? ` (${resultSummary})` : ''}`);
    }
  }

  lines.push('');
  lines.push(`📊 ${t1} ${t1Wins}  —  ${t2Wins} ${t2}${nr ? `  (${nr} NR)` : ''}`);
  if (t1Wins > t2Wins) lines.push(`${t1} leads 💪`);
  else if (t2Wins > t1Wins) lines.push(`${t2} leads 💪`);
  else if (t1Wins + t2Wins + nr > 0) lines.push(`Level pegging! 🤝`);

  return lines.join('\n');
}

/** Auto-sync only runs from (match start + 4h) through (match start + 6h), every CHECK_INTERVAL. */
const HOUR_MS = 60 * 60 * 1000;
const AUTO_RESULT_CHECK_DELAY_MS = 4 * HOUR_MS;
const AUTO_RESULT_CHECK_WINDOW_MS = 2 * HOUR_MS;

async function checkRecentMatches(isManual = false) {
  try {
    const now = new Date();
    const nowMs = now.getTime();

    const existingResults = await query("SELECT match_id FROM results");
    const existingIds = new Set(existingResults.map((r) => r.match_id));

    // Skip if every match at or before now already has a result
    const needResultSync = IPL_SCHEDULE.some((m) => {
      const startTime = new Date(`${m.date}T${m.time}:00+05:30`);
      return nowMs >= startTime.getTime() && !existingIds.has(m.id);
    });
    if (!needResultSync) return { updated: 0, checked: 0 };

    // Candidate matches: manual = any time after start; auto only in [start+4h, start+6h]
    const pendingMatches = IPL_SCHEDULE.filter((m) => {
      const startTime = new Date(`${m.date}T${m.time}:00+05:30`);
      if (isManual) return nowMs >= startTime.getTime();
      const windowStart = startTime.getTime() + AUTO_RESULT_CHECK_DELAY_MS;
      const windowEnd = windowStart + AUTO_RESULT_CHECK_WINDOW_MS;
      return nowMs >= windowStart && nowMs <= windowEnd;
    });

    if (pendingMatches.length === 0) return { updated: 0, checked: 0 };

    const toCheck = pendingMatches.filter(m => !existingIds.has(m.id));
    if (toCheck.length === 0) return { updated: 0, checked: 0 };

    console.log(`🔍 AutomatedResultService: Checking ${toCheck.length} pending matches via ESPN...`);
    let updatedCount = 0;

    // Fetch from ESPN Cricinfo API (free, no key)
    const allMatches = await fetchESPNAll();
    if (allMatches.length === 0) {
      console.log("⚠️  AutomatedResultService: No matches returned from ESPN.");
    }

    for (const match of toCheck) {
      const matchDateStr = match.date;

      const apiMatch = allMatches.find(am => {
        const t1 = am.team1.short;
        const t2 = am.team2.short;
        const amDate = am.startDateISO ? am.startDateISO.split('T')[0] : null;
        const teamsMatch =
          (t1 === match.team1 && t2 === match.team2) ||
          (t1 === match.team2 && t2 === match.team1);
        return (amDate === matchDateStr || !amDate) && teamsMatch;
      });

      if (!apiMatch) {
        console.log(`❓ AutomatedResultService: Could not find ${match.id} (${match.team1} vs ${match.team2}) on ESPN.`);
        continue;
      }

      const status = apiMatch.status || "";
      const state = apiMatch.state || "pre";

      const stateDone =
        state === 'post' ||
        status.includes("won by") ||
        status.includes("Match abandoned");

      if (stateDone) {
        const winner = parseWinnerFromStatus(status, match.team1, match.team2) ||
          (apiMatch.winnerName ? (TEAM_NAME_MAP[apiMatch.winnerName] || null) : null);
        if (winner) {
          const scoreSummary = extractScoreSummaryESPN(apiMatch);
          const summary = await fetchESPNSummary(apiMatch.espnEventId);
          const toss = summary?.toss || null;
          const matchDetails = {
            espnEventId: apiMatch.espnEventId,
            team1: apiMatch.team1,
            team2: apiMatch.team2,
            state: apiMatch.state,
            status: apiMatch.status,
          };
          console.log(`🏆 AutomatedResultService: AUTO-DECLARING WINNER for ${match.id}: ${winner}${toss ? ` | ${toss}` : ''}`);
          await query(
            `INSERT INTO results (match_id, winner, score_summary, toss, details)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (match_id)
             DO UPDATE SET
               winner = EXCLUDED.winner,
               score_summary = COALESCE(EXCLUDED.score_summary, results.score_summary),
               toss = COALESCE(EXCLUDED.toss, results.toss),
               details = EXCLUDED.details`,
            [match.id, winner, scoreSummary, toss, JSON.stringify(matchDetails)]
          );
          await query("DELETE FROM chat_messages WHERE match_id = $1", [match.id]);
          updatedCount++;

          // Post win announcement to all rooms (once per match)
          if (!winPostedSet.has(match.id) && await isBotEnabled(match.id)) {
            winPostedSet.add(match.id);
            const allRooms = await query('SELECT id FROM rooms');
            const botName = getBotName(match.id);
            let winMsg;
            if (winner === 'nr') {
              winMsg = `🌧️ Match abandoned — No Result.`;
            } else if (winner === 'draw') {
              winMsg = `🤝 What a match! It's a tie!`;
            } else {
              winMsg = `🏆 Match Over!\n${winner} won!`;
              if (scoreSummary) winMsg += `\n📊 ${scoreSummary}`;
            }
            for (const room of allRooms) {
              await postBotMessage(room.id, match.id, winMsg, botName);
            }
          }
        }
      } else {
        console.log(`⏳ AutomatedResultService: Match ${match.id} still in progress (Status: ${status}).`);
      }
    }

    return { updated: updatedCount, checked: toCheck.length };

  } catch (error) {
    console.error("❌ AutomatedResultService Error:", error.message);
    return isManual ? { error: error.message } : null;
  }
}

// Start the check loop (every 15 minutes; each match is only considered in the 2h window after +4h from start)
const CHECK_INTERVAL = 15 * 60 * 1000;
setInterval(checkRecentMatches, CHECK_INTERVAL);

// Initial check on startup
setTimeout(checkRecentMatches, 5000); // 5 sec delay to let DB init completion

// ─── Live Score Service ────────────────────────────────────────────────────

const liveScoreCache = new Map(); // ourMatchId -> LiveScorePayload
const commentaryCache = new Map(); // ourMatchId -> { espnEventId, lastTs, toss, lineups }
const rainDelayState = new Map();  // ourMatchId -> { inDelay: bool, lastPostedAt: number }

/** Build score/status from an ESPN normalized match object */
function buildScoreFromESPNMatch(espnMatch, ourMatch) {
  const t1Short = espnMatch.team1.short || ourMatch.team1;
  const t2Short = espnMatch.team2.short || ourMatch.team2;
  const parts = [];
  if (espnMatch.team1.score) parts.push(`${t1Short} ${espnMatch.team1.score}`);
  if (espnMatch.team2.score) parts.push(`${t2Short} ${espnMatch.team2.score}`);
  return {
    score: parts.join(' · ') || null,
    status: espnMatch.status || null,
    toss: null, // ESPN events endpoint does not expose toss
  };
}

async function pollLiveScores() {
  try {
    const now = new Date();
    const existingResults = await query('SELECT match_id FROM results');
    const completedIds = new Set(existingResults.map(r => r.match_id));

    // Remove completed matches from cache
    for (const id of liveScoreCache.keys()) {
      if (completedIds.has(id)) liveScoreCache.delete(id);
    }

    // Matches started in the last 4 hours without a result
    const liveMatches = IPL_SCHEDULE.filter(m => {
      const startTime = new Date(`${m.date}T${m.time}:00+05:30`);
      const cutoff = new Date(startTime.getTime() + 4 * 60 * 60 * 1000);
      return now >= startTime && now <= cutoff && !completedIds.has(m.id);
    });

    if (liveMatches.length === 0) return;

    const apiMatches = await fetchESPNAll();

    for (const match of liveMatches) {
      const apiMatch = apiMatches.find(am => {
        const t1 = am.team1.short;
        const t2 = am.team2.short;
        return (t1 === match.team1 && t2 === match.team2) ||
          (t1 === match.team2 && t2 === match.team1);
      });

      if (!apiMatch) continue;

      const { score, status, toss } = buildScoreFromESPNMatch(apiMatch, match);

      // Seed commentaryCache with ESPN event ID (first time we see this match live)
      if (apiMatch.espnEventId && !commentaryCache.has(match.id)) {
        const entry = { espnEventId: apiMatch.espnEventId, lastTs: 0, toss: null, lineups: null };
        commentaryCache.set(match.id, entry);
        console.log(`[Commentary] Registered match ${match.id} → ESPN ID ${apiMatch.espnEventId}`);
        // Fetch toss + lineups from summary in background; available on next poll cycle
        fetchESPNSummary(apiMatch.espnEventId).then(d => {
          if (d?.toss) entry.toss = d.toss;
          if (d?.lineups) entry.lineups = d.lineups;
        });
      }

      const cachedEntry = commentaryCache.get(match.id);
      const liveToss = cachedEntry?.toss || null;

      const payload = {
        matchId: match.id,
        team1: match.team1,
        team2: match.team2,
        score: score || null,
        status: status || null,
        toss: liveToss,
        updatedAt: new Date().toISOString(),
      };

      liveScoreCache.set(match.id, payload);
      io.emit('live_score', payload);
      console.log(`[LiveScore] ${match.id}: ${score || 'no score'} | ${status || 'no status'}`);

      // Post toss + XI announcement once when toss info first appears
      if (liveToss && !tossPostedSet.has(match.id)) {
        tossPostedSet.add(match.id);
        if (await isBotEnabled(match.id)) {
          const allRooms = await query('SELECT id FROM rooms');
          const botName = getBotName(match.id);
          const tossMsg = formatTossMessage(liveToss, cachedEntry?.lineups);
          for (const room of allRooms) {
            await postBotMessage(room.id, match.id, tossMsg, botName);
          }
        }
      }

      // ── Rain / delay detection ──────────────────────────────────────────────
      const RAIN_KEYWORDS = /rain|delay|interrupt|suspend|wet outfield|bad light|pitch inspection/i;
      const isRainStatus = RAIN_KEYWORDS.test(status || '');
      const rainState = rainDelayState.get(match.id) || { inDelay: false, lastPostedAt: 0 };
      const nowMs = Date.now();

      if (isRainStatus) {
        // Re-post every 10 min while delay persists so late joiners see the update
        const shouldPost = !rainState.inDelay ||
          (nowMs - rainState.lastPostedAt > 10 * 60 * 1000);
        if (shouldPost && await isBotEnabled(match.id)) {
          const botName = getBotName(match.id);
          const delayMsg = `🌧️ Play Interrupted!\n\n${match.team1} vs ${match.team2}\n📊 ${status}\n\nI'll resume ball-by-ball updates the moment play gets back underway! ⏸️`;
          const allRooms = await query('SELECT id FROM rooms');
          for (const room of allRooms) {
            await postBotMessage(room.id, match.id, delayMsg, botName);
          }
          rainDelayState.set(match.id, { inDelay: true, lastPostedAt: nowMs });
          console.log(`[LiveScore] Rain delay posted for match ${match.id}`);
        } else if (!rainState.inDelay) {
          rainDelayState.set(match.id, { inDelay: true, lastPostedAt: nowMs });
        }
      } else if (rainState.inDelay) {
        // Delay has lifted — post "play resumed"
        if (await isBotEnabled(match.id)) {
          const botName = getBotName(match.id);
          const resumeMsg = `☀️ Play has resumed!\n\n${match.team1} vs ${match.team2} is back on! 🏏\n${score ? `📊 ${score}` : ''}\n\nBall-by-ball updates are live again! 🔥`;
          const allRooms = await query('SELECT id FROM rooms');
          for (const room of allRooms) {
            await postBotMessage(room.id, match.id, resumeMsg, botName);
          }
          console.log(`[LiveScore] Play resumed posted for match ${match.id}`);
        }
        rainDelayState.set(match.id, { inDelay: false, lastPostedAt: 0 });
      }
    }
  } catch (err) {
    console.error('[LiveScore] Poll error:', err.message);
  }
}

setInterval(pollLiveScores, 30 * 1000);
setTimeout(pollLiveScores, 10000); // 10s after startup

app.get('/api/live-score', asyncRoute(async (req, res) => {
  res.json(Object.fromEntries(liveScoreCache));
}));

// ─── Chatbot System ────────────────────────────────────────────────────────

function getBotName(_matchId) {
  return 'Kira';
}

function getBotIntro(botName, matchId) {
  const match = IPL_SCHEDULE.find(m => m.id === matchId);
  const t1 = match?.team1 || '?';
  const t2 = match?.team2 || '?';
  const idx = IPL_SCHEDULE.findIndex(m => m.id === matchId);
  const variants = [
    `Hey everyone! 👋 I'm ${botName}, your AI cricket companion for today's match! 🏏✨\n\n📍 ${t1} vs ${t2} — let the battle begin!\n\nI'll be dropping live ball-by-ball updates right here as the action unfolds:\n\n🔴 Wickets  •  🔵 Fours  •  🏏 Sixes  •  📊 Over summaries\n\nReact to my updates, cheer for your team, and let's make this match unforgettable! 🚀🔥`,
    `Helloooo cricket lovers! 🦁 The name's ${botName} and I'm your dedicated live score bot for this epic clash!\n\n⚔️ ${t1} vs ${t2} — who's it gonna be?!\n\nI'll fire ball-by-ball commentary straight into this chat as the game unfolds. React with 🔥 for sixes, 👏 for wickets — let's get loud! 🎉\n\nLet's gooooo! 🚀`,
    `Hi fam! 🙌 I'm ${botName} — think of me as your cricket BFF who never misses a delivery!\n\n${t1} 🆚 ${t2} — this one's going to be a cracker! 💥\n\nEvery four, every six, every heart-stopping wicket — I've got you covered with live updates. Grab your snacks, react to my posts, and let's enjoy the game together! 🍿🏏`,
    `Greetings, cricket fans! 🏆 I'm ${botName}, your real-time match commentator for today's game!\n\n🏟️ ${t1} vs ${t2} is about to get electric!\n\nMy job? Keep you updated on every single delivery — the big shots, the crucial wickets, the dramatic finishes. Nothing gets past me! ⚡\n\nHit those reaction buttons and let me know how you're feeling! Let's play! 🏏`,
    `What's up, legends! 😎 ${botName} here — your go-to bot for live IPL action!\n\n🔥 ${t1} vs ${t2} — brace yourselves!\n\nI'll be your eyes on the pitch, sending ball-by-ball updates so you stay in the thick of the action even when life gets busy. React, chat, and enjoy! 🏏✨`,
  ];
  return variants[Math.abs(idx < 0 ? 0 : idx) % variants.length];
}

async function postBotMessage(roomId, matchId, text, botName) {
  if (!BOT_USER_ID) return null;
  try {
    const saved = await queryOne(`
      INSERT INTO chat_messages (room_id, match_id, user_id, message, bot_name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, room_id, match_id, user_id, message, bot_name, created_at
    `, [roomId, matchId, BOT_USER_ID, text, botName]);

    if (saved) {
      io.to(`chat_${roomId}_${matchId}`).emit('new_message', {
        ...saved,
        username: botName,
        profile_pic: null,
        is_bot: true,
        bot_name: botName,
        reply_to_message: null,
        reactions: [],
      });
    }
    return saved;
  } catch (e) {
    console.error('[Bot] postBotMessage error:', e.message);
    return null;
  }
}

const introPostedSet = new Set();   // `${roomId}_${matchId}`
const tossPostedSet = new Set();   // `${matchId}` — toss announcement per match
const winPostedSet = new Set();   // `${matchId}` — win announcement per match

async function postIntroAndSummaryForCompletedMatch(roomId, matchId) {
  if (!await isBotEnabled(matchId)) return;
  const key = `${roomId}_${matchId}_completed`;
  if (introPostedSet.has(key)) return;
  introPostedSet.add(key);

  // Check DB — only for completed matches
  const result = await queryOne(
    'SELECT winner, score_summary, toss FROM results WHERE match_id = $1', [matchId]
  );
  if (!result) return;

  // Skip if any bot message already exists in this room+match
  const existing = await queryOne(
    'SELECT id FROM chat_messages WHERE room_id = $1 AND match_id = $2 AND bot_name IS NOT NULL LIMIT 1',
    [roomId, matchId]
  );
  if (existing) return;

  const botName = getBotName(matchId);
  const schedule = require('./schedule.js');
  const matchInfo = schedule.find(m => m.id === matchId);
  const t1 = matchInfo?.team1 || 'Team 1';
  const t2 = matchInfo?.team2 || 'Team 2';

  // Intro
  await postBotMessage(roomId, matchId, getBotIntro(botName, matchId), botName);

  // Match summary
  const { winner, score_summary: scoreSummary, toss } = result;
  let summary = `📋 Match Summary — ${t1} vs ${t2}\n`;
  if (toss) summary += `\n🪙 ${toss}`;
  if (winner === 'nr') summary += `\n🌧️ Result: No Result (match abandoned)`;
  else if (winner === 'draw') summary += `\n🤝 Result: Match tied`;
  else {
    summary += `\n🏆 ${winner} won!`;
    if (scoreSummary) summary += `\n📊 ${scoreSummary}`;
  }
  await postBotMessage(roomId, matchId, summary, botName);
}

async function postIntroIfNeeded(roomId, matchId) {
  if (!await isBotEnabled(matchId)) return;
  const match = IPL_SCHEDULE.find(m => m.id === matchId);
  if (!match) return;

  const key = `${roomId}_${matchId}`;
  if (introPostedSet.has(key)) return;
  introPostedSet.add(key); // optimistic lock to avoid double-post

  // Check DB to avoid re-posting after server restart
  const existing = await queryOne(
    'SELECT id FROM chat_messages WHERE room_id = $1 AND match_id = $2 AND bot_name IS NOT NULL LIMIT 1',
    [roomId, matchId]
  );
  if (existing) return;

  const botName = getBotName(matchId);
  const startTime = new Date(`${match.date}T${match.time}:00+05:30`);
  const isUpcoming = new Date() < startTime;

  let intro;
  if (isUpcoming) {
    const t1 = match.team1;
    const t2 = match.team2;
    const dateStr = startTime.toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    });
    intro = `Hey everyone! 👋 I'm ${botName}, your cricket companion for this match!\n\n📍 ${t1} vs ${t2}\n🕐 Match starts: ${dateStr} IST\n\nMake your prediction and get ready — I'll go live with ball-by-ball updates the moment the first ball is bowled! 🏏🔥`;
  } else {
    intro = getBotIntro(botName, matchId);
  }

  await postBotMessage(roomId, matchId, intro, botName);
  console.log(`[Bot] Posted intro for match ${matchId} in room ${roomId} (${botName})`);
}

async function isBotEnabled(matchId) {
  const row = await queryOne("SELECT bot_enabled FROM match_bot_settings WHERE match_id = $1", [matchId]);
  return row === null ? true : row.bot_enabled; // default ON
}

// ─── Bot Query Handler ─────────────────────────────────────────────────────

function getHelpText(botName) {
  return `🏏 Hi! I'm ${botName}. Here's what you can ask me:\n\n` +
    `📊 Match\n` +
    `/match — teams, venue, toss & match status\n` +
    `/score — current score & status\n` +
    `/scorecard — full batting & bowling scorecard\n` +
    `/batting — who's at the crease\n` +
    `/bowling — current bowler's figures\n` +
    `/rr — current run rate\n` +
    `/target — target (2nd innings)\n` +
    `/rrr — required run rate\n` +
    `/overs — overs remaining\n\n` +
    `🗒️ Squads\n` +
    `/{team}-lineup — playing XI & impact players (e.g. /rcb-lineup)\n` +
    `/scorecard — full innings scorecard\n\n` +
    `📈 Tournament\n` +
    `/points-table — IPL standings with NRR\n` +
    `/h2h — head-to-head record for today's teams\n\n` +
    `🏆 Room\n` +
    `/top — leaderboard top 5\n` +
    `/votes — vote split for this match\n` +
    `/who predicted [team] — who picked a team\n\n` +
    `🎲 Fun\n` +
    `/win — my prediction for this match\n` +
    `/kira [question] — ask me anything`;
}

// ── Team-mention auto-roast ────────────────────────────────────────────────
// Large pools so roasts don't repeat for a long time.
// Tracked per-room to avoid serving the same roast twice in a row.
const roastIndexes = { CSK: {}, MI: {}, KL: {}, RCB: {} };

const CSK_ROASTS = [
  `CSK? You mean the team that recycles 40-year-olds and calls it "experience"? 😂🧓`,
  `CSK — where careers go to retire. Lovely hospice, terrible cricket team 🌊`,
  `Ah yes, CSK. The only team whose average player age needs a pension plan 👴🏏`,
  `CSK's strategy: pray Dhoni walks in at No.7 and wins it off the last ball. Again. 🙏`,
  `Chennai Super Killjoys. Even the yellow looks exhausted these days 😅`,
  `CSK's bowling attack is so old the ball itself gets winded running up to the crease 💨`,
  `"CSK are experienced." Yeah, experienced at watching other teams lift the trophy recently 🏆`,
  `Dhoni retiring in slow motion for 4 seasons straight is peak CSK content 😂`,
  `CSK have turned "doing nothing for 15 overs then batting last 5 frenetically" into an art form 🎨`,
  `The average age of a CSK playing XI could legally apply for a senior citizen railway concession 🚂`,
  `CSK's team bus probably has a handicap ramp at this point 😭`,
  `CSK fans: "bUt tHeY'Re tHrEe-tImE cHaMpIoNs" bro that was like a decade ago calm down 📅`,
  `CSK without Dhoni heroics is just a yellow-coloured meltdown, honestly 😂`,
  `Chennai Super Kings or Chennai Senior Citizens? I genuinely can't tell from the XI sheet 🤣`,
  `CSK's bowling lineup has a combined age older than the IPL itself 🏏`,
  `Every CSK loss: "ThIs iS NeW cSK wItH YouNg tAlEnT" *immediately plays Jadeja over 18* 😩`,
  `CSK fans in the chat rn be like: "wait for Dhoni" — he's batting No.8, relax 😂`,
  `CSK's auction strategy: find anyone over 33, sign for max price, call it "experience" 💸`,
  `The only team that turns a T20 into a Test match then complains about the run rate 🐢`,
  `If CSK played any slower, BCCI would reclassify them as red-ball specialists 😂`,
  `CSK vs RCB is always wild because one team plays with heart, the other plays with zimmer frames 🦽`,
  `CSK roster reading like a who's who of "what have you done for me this decade" 👀`,
  `The yellow army — brave, loyal, and somehow still convinced 2018 tactics work in 2025 😂`,
  `CSK's game plan: defend 140, hope for dew, pray for Dhoni magic. Bold strategy 🎲`,
  `Every CSK fan blames the pitch when they lose. Mate, your team set 142. That IS the problem 😭`,
];

const MI_ROASTS = [
  `MI? 5 titles and still can't figure out their batting order this season 😬`,
  `Mumbai Indians — peaked, peaked again, peaked again, and now coasting on nostalgia 🏆👀`,
  `MI have more IPL title ceremonies than good recent memories. Just saying 😅`,
  `Hardik left, Rohit's done, and MI is basically a WhatsApp group with no admin 😂`,
  `MI fans explaining why THIS is their year… every year since 2020 📅`,
  `MI's strategy: "recruit big names, forget team chemistry, blame slow pitches" — classic 🎭`,
  `Rohit Sharma: still the greatest opener. Just not for MI anymore. Oof 💀`,
  `MI's auction room be like "grab Neymar if he plays cricket" — no real plan, just vibes 💸`,
  `MI have won 5 titles. They remind you every match because recent performances won't 😂`,
  `Jasprit Bumrah is a legend. MI as a team though? Glorified net session at this point 🏏`,
  `MI fans in 2025 are like Manchester United fans — living off trophies from another era 😭`,
  `"Trust the process" — MI's process is just hoping Bumrah has a 5-wicket haul every game 🤷`,
  `MI without Rohit and Hardik is like Thanos without the Infinity Stones — just some dude 💎`,
  `How does a team with THIS budget field an XI this confused? Wild scenes from MI camp 🤣`,
  `MI's opening pair has more changes than a government cabinet reshuffle 😂`,
  `MI fans: "WE HAVE THE BEST SQUAD!" MI in the playoff table: 👻`,
  `5 titles, zero playoff appearances recently. That's the MI experience right now ✌️`,
  `MI bought a player for 18 crore who played 2 matches and disappeared. Bold investment 💸`,
  `MI's biggest problem is they still think 2013 tactics work in 2025 cricket 📆`,
  `Nothing more MI than posting "Believe in Blue" and then losing to a team in pink 😂`,
  `MI's team meeting is probably just watching old highlight reels of their trophies for motivation 📽️`,
  `Paltan? More like Paltaan of confusing team selections tbh 😬`,
  `MI spending 15 crore on someone then dropping them after match 1 is genuinely hilarious 🤣`,
  `If MI had a mission statement: "Nostalgia-first, results optional" 📝`,
  `MI's bowling without Bumrah is like biryani without rice. What is this? 🍚`,
];

const KL_ROASTS = [
  `KL Rahul scored a beautiful 50 off 52 balls in a losing cause. Classic 👏 Most consistent at losing slowly 😬`,
  `KL Rahul: 41 off 52 balls at a run rate of 7.9. The pitch report was more thrilling 💤`,
  `KL Rahul saw 10 balls, scored 6 runs, and called it "building the innings" 🧱`,
  `Someone remind KL Rahul that T20 matches are 20 overs, not 20 Tests 😂`,
  `KL Rahul's strike rate is slower than my Wi-Fi during a night match 📶`,
  `KL Rahul's batting: technically perfect, tactically catastrophic 😭`,
  `40 off 45, looked gorgeous, team lost by 30. That's the KL Rahul experience in a nutshell 🎭`,
  `KL Rahul: 5 elegant cover drives, 2 flicks, 47 runs, 7 overs gone. HELP 😤`,
  `KL Rahul watching the run rate go from 8 to 16 without changing his approach 👀`,
  `KL Rahul at No.4 in a T20 chase: the human anchor. Team sinks, he looks good doing it 🚢`,
  `KL Rahul once played out a maiden in the 17th over of a T20. This is not a drill 😱`,
  `The commentators: "KL looking good, timing is beautiful!" The scoreboard: 28 off 31. 🤡`,
  `KL Rahul has the most stylish way of losing a match I've ever seen 💅`,
  `KL Rahul batting in a T20 is like ordering a pizza and getting it delivered next Tuesday 📦`,
  `"KL is a touch player, he builds, he's elegant" — great, we're 12/1 in over 9, now SWING 😭`,
  `KL Rahul's strike rate chart looks like a reclining chair 📉`,
  `No one in world cricket can get 60 runs in 55 balls in a T20 and still make it look like art 🎨`,
  `"KL is getting going" — mate he has 22 off 25, we needed 72 off 30. HE IS NOT GETTING GOING 😩`,
  `KL Rahul's career highlights: beautiful hundreds in dead rubbers, slow fifties in must-win games 📊`,
  `KL Rahul treating every T20 like it's a 5-day Test is honestly his biggest flex 💪`,
  `If KL Rahul's strike rate was a Zomato delivery, it'd be cancelled for being too late 🛵`,
  `KL Rahul in the powerplay: 18 off 18. Textbook. Absolutely nobody asked for textbook 😬`,
  `KL Rahul: technically the best in the world at turning 60 into a loss 👑`,
  `The most decorated passenger in a sinking ship — that's KL Rahul for you 🚢`,
  `KL Rahul saw the required run rate hit 24 and played a delicate late cut. Elegant. Pointless 🤌`,
];

const RCB_HYPE = [
  `RCB SUPREMACY! Ee sala cup namde! 🏆🔴🖤`,
  `RCB going brrr 🚀 Virat ki army represent! 🏏🔥`,
  `RCB — the team that makes your heart race every single game 💔❤️ But we STILL believe!`,
  `Red. Black. Passion. RCB forever! Ee sala final pakka hai 🙌`,
  `RCB keeping us on the edge since 2008. Most toxic love story in cricket 😭❤️`,
  `RCB is the only team that can make you feel like you're watching a thriller every single match 🎬`,
  `Virat Kohli running down the pitch, hitting it straight, staring the bowler down — that's cinema 🎥`,
  `RCB fans have the highest pain tolerance in sports. We are built different 💪`,
  `No IPL team has been mentioned more, celebrated more, or cried more than RCB. We're the main characters 🌟`,
  `RCB's batting lineup on a good day is just illegal. Virat + Faf + Maxwell is unfair 😤`,
  `When RCB wins it's pure euphoria. When they lose it's a gut punch. No in-between. That's us ❤️`,
  `RCB auction room: "Okay who's the most dangerous batter available? Get him. And another. And another." 😂`,
  `RCB — the team every neutral fan secretly loves because drama follows them everywhere 🎭`,
  `Ee sala cup namde has been a prophecy since 2016. This. Is. The. Year. 🔮`,
  `RCB's win celebration energy is unmatched in the entire IPL. The stadium goes absolutely mental 🏟️`,
  `Playing against RCB is easy until Virat walks in. Then it's a completely different match 😈`,
  `RCB: chaotic, emotional, occasionally devastating, always entertaining. The IPL's greatest show 🎪`,
  `I trust RCB more than I trust most things in life. Don't @ me 🙏`,
  `Red and black doesn't just run on the jersey — it runs in the veins 🔴🖤`,
  `RCB has never won the IPL but they've won the hearts of every neutral watching. Cope, others 💅`,
  `The day RCB lifts the trophy, I might actually cry. Pre-booking emotions 😭🏆`,
  `RCB's bowling giving nightmares, RCB's batting giving dreams. Living in that tension since 2008 😅`,
  `Every RCB match is a documentary. Nobody makes cricket this dramatic 🎬`,
  `Virat at Chinnaswamy is a religious experience. Say it louder for the people at the back 🙏🔥`,
  `RCB losing: devastating. RCB winning: the best feeling in cricket. No other team does this to you ❤️🔴`,
];

const CSK_MI_COMBINED = [
  `CSK vs MI? Two teams I can't root for. I'm cheering for rain and a super over that ends in a tie 😂`,
  `CSK's geriatric XI vs MI's identity crisis. This is peak "lesser evil" territory 😭`,
  `Watching CSK vs MI is me rooting for whoever loses faster so we can all move on 🤷`,
  `Two overrated juggernauts fighting over who gets to disappoint their fans more this season 💀`,
  `CSK's greybeards vs MI's confused management — honestly both deserve to lose this one 😅`,
];

// Track last-served index per team per room to avoid back-to-back repeats
function pickRoast(pool, team, roomKey) {
  if (!roastIndexes[team][roomKey]) roastIndexes[team][roomKey] = { last: -1 };
  const state = roastIndexes[team][roomKey];
  let idx;
  do {
    idx = Math.floor(Math.random() * pool.length);
  } while (pool.length > 1 && idx === state.last);
  state.last = idx;
  return pool[idx];
}

function getTeamMentionRoast(message, matchId) {
  const mentionsCSK = /\bcsk\b|chennai super kings?\b|dhoni\b/i.test(message);
  const mentionsMI  = /\bmi\b|mumbai indians?\b/i.test(message);
  const mentionsKL  = /\bkl\s*rahul\b/i.test(message);
  const mentionsRCB = /\brcb\b|royal challengers?\b/i.test(message);

  // Don't fire on very short messages
  if (message.trim().split(/\s+/).length < 2) return null;

  const key = String(matchId);
  if (mentionsKL)          return pickRoast(KL_ROASTS, 'KL', key);
  if (mentionsCSK && mentionsMI) return CSK_MI_COMBINED[Math.floor(Math.random() * CSK_MI_COMBINED.length)];
  if (mentionsCSK)         return pickRoast(CSK_ROASTS, 'CSK', key);
  if (mentionsMI)          return pickRoast(MI_ROASTS, 'MI', key);
  if (mentionsRCB)         return pickRoast(RCB_HYPE, 'RCB', key);

  return null;
}

async function fetchLatestBallData(matchId) {
  const state = commentaryCache.get(matchId);
  if (!state?.espnEventId) return null;
  try {
    const resp = await axios.get(
      `${ESPN_IPL_BASE}/playbyplay?event=${state.espnEventId}`,
      { timeout: 8000 }
    );
    const items = resp.data?.commentary?.items || [];
    const latest = items[0] || null;
    // Use liveScoreCache for score info since ESPN playbyplay has no separate miniscore
    const liveData = liveScoreCache.get(matchId);
    const miniscore = liveData?.score
      ? { batTeam: { teamSName: liveData.team1, score: liveData.score } }
      : null;
    return { latest, miniscore, commentary: items };
  } catch (e) {
    return null;
  }
}

function parseMiniScore(miniscore) {
  if (!miniscore) return null;
  const batting = miniscore.batTeam || miniscore.inningScore;
  if (!batting) return null;
  const teamName = batting.teamSName || '';
  const score = batting.score ?? '?';
  const wickets = batting.wickets ?? 0;
  const overs = batting.overs ?? '?';
  const rr = miniscore.currentRunRate != null ? Number(miniscore.currentRunRate).toFixed(2) : null;
  const rrr = miniscore.requiredRunRate != null ? Number(miniscore.requiredRunRate).toFixed(2) : null;
  const target = miniscore.target != null ? miniscore.target : null;
  const ballsLeft = miniscore.remBalls != null ? miniscore.remBalls : null;
  return { teamName, score, wickets, overs, rr, rrr, target, ballsLeft };
}

async function handleBotQuery(roomId, matchId, rawQuery, askerUsername) {
  if (!await isBotEnabled(matchId)) return; // silently ignore when bot is off
  const q = rawQuery.trim().toLowerCase().replace(/[?!.,]+$/, '');
  const botName = getBotName(matchId);
  const liveData = liveScoreCache.get(matchId);
  const schedule = require('./schedule.js');
  const matchInfo = schedule.find(m => m.id === matchId);
  const t1 = matchInfo?.team1 || 'Team 1';
  const t2 = matchInfo?.team2 || 'Team 2';

  // Check if this is a completed match
  const completedResult = await queryOne(
    'SELECT winner, score_summary, toss, details FROM results WHERE match_id = $1', [matchId]
  );
  const isCompleted = !!completedResult;

  // "First ball bowled" = any commentary has been received for this match
  const commentaryState = commentaryCache.get(matchId);
  const hasFirstBall = (commentaryState?.lastTs || 0) > 0;

  const matchStart = matchInfo
    ? new Date(`${matchInfo.date}T${matchInfo.time || '19:30'}:00+05:30`)
    : null;

  // isNotStarted: match not completed AND first ball not yet bowled
  const isNotStarted = !isCompleted && !hasFirstBall;
  // isDelayed: scheduled time has passed but first ball still not bowled
  const isDelayed = isNotStarted && matchStart && new Date() >= matchStart;

  const preStartReply = isNotStarted
    ? (() => {
      if (isDelayed) {
        const currentStatus = liveData?.status || '';
        const isRain = /rain|delay|interrupt|suspend|wet|bad light/i.test(currentStatus);
        if (isRain) {
          return `🌧️ Play is currently stopped due to rain/interruption!\n\n${t1} vs ${t2}\n📊 ${currentStatus}\n\nI'll go live with ball-by-ball updates the moment play resumes! 🏏`;
        }
        return `⏳ ${t1} vs ${t2} — we're at the venue but waiting for the first ball!\n\nStay tuned, I'll kick off live updates the moment play begins! 🏏🔥`;
      }
      // Before scheduled time
      const timeStr = matchStart?.toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
      });
      const dateStr = matchStart?.toLocaleDateString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
      });
      return `⏳ The match hasn't started yet!\n\n${t1} vs ${t2} kicks off on ${dateStr} at ${timeStr} IST.\n\nI'll go live with ball-by-ball updates the moment the first ball is bowled. Stay tuned! 🏏🔥`;
    })()
    : null;

  let reply = null;

  // ── help ──────────────────────────────────────────────────────────────────
  if (['help', 'commands', '?'].includes(q)) {
    reply = getHelpText(botName);
  }

  // ── score ─────────────────────────────────────────────────────────────────
  else if (q === 'score') {
    if (isCompleted) {
      const { score_summary, toss } = completedResult;
      reply = `📊 Final Scorecard — ${t1} vs ${t2}`;
      if (score_summary) reply += `\n${score_summary}`;
      if (toss) reply += `\n🪙 ${toss}`;
    } else if (isNotStarted) {
      reply = preStartReply;
    } else if (!liveData?.score) {
      reply = `No live score yet, ${askerUsername}. Check back once the match starts! 🏏`;
    } else {
      reply = `📊 Current Score\n${liveData.score}${liveData.status ? `\n${liveData.status}` : ''}`;
    }
  }

  // ── result ────────────────────────────────────────────────────────────────
  else if (['result', 'winner', 'who won'].includes(q)) {
    if (isCompleted) {
      const { winner, score_summary, toss } = completedResult;
      if (winner === 'nr') {
        reply = `🌧️ No Result — match was abandoned.${toss ? `\n🪙 ${toss}` : ''}`;
      } else if (winner === 'draw') {
        reply = `🤝 Match tied!${score_summary ? `\n📊 ${score_summary}` : ''}${toss ? `\n🪙 ${toss}` : ''}`;
      } else {
        reply = `🏆 ${winner} won this match!${score_summary ? `\n📊 ${score_summary}` : ''}${toss ? `\n🪙 ${toss}` : ''}`;
      }
    } else if (isNotStarted) {
      reply = preStartReply;
    } else {
      reply = liveData?.score
        ? `⏳ Match still in progress!\n📊 ${liveData.score}${liveData.status ? `\n${liveData.status}` : ''}`
        : `Match hasn't finished yet, ${askerUsername}!`;
    }
  }

  // ── batting ───────────────────────────────────────────────────────────────
  else if (['batting', 'bat', 'batsman', 'batter', "who's batting", 'who is batting'].includes(q)) {
    if (isCompleted) {
      try {
        const espnId = await getESPNEventId(matchId, matchInfo);
        if (!espnId) throw new Error('no ESPN ID');
        const { innings } = await fetchESPNScorecard(espnId);
        const keys = Object.keys(innings).sort();
        if (!keys.length) throw new Error('empty');
        const lines = [`🏏 Batting — ${t1} vs ${t2}\n`];
        for (const k of keys) {
          const mc = innings[k].batting;
          if (!mc) continue;
          lines.push(`━━ ${mc.teamName} — ${mc.runs ?? '?'} ${mc.total ?? ''} ━━`);
          for (const p of mc.playerDetails.filter(p => p.runs !== '')) {
            const sr = p.ballsFaced > 0 ? ((p.runs / p.ballsFaced) * 100).toFixed(1) : '-';
            lines.push(`${p.playerName.padEnd(18)} ${String(p.runs).padStart(3)}(${p.ballsFaced})  SR:${sr}  ${(p.dismissal || 'not out').slice(0, 16)}`);
          }
          if (mc.extras) lines.push(`Extras: ${mc.extras}`);
          lines.push('');
        }
        reply = lines.join('\n').trimEnd();
      } catch {
        reply = `📋 ${t1} vs ${t2} — Match result\n${completedResult.score_summary || completedResult.winner + ' won'}`;
      }
    } else if (isNotStarted) {
      reply = preStartReply;
    } else {
      const data = await fetchLatestBallData(matchId);
      const ball = data?.latest;
      if (!ball?.batsmanStriker) {
        reply = liveData?.score
          ? `🏏 Batting info not available right now. Score: ${liveData.score}`
          : `No live match data yet, ${askerUsername}!`;
      } else {
        const s = ball.batsmanStriker;
        const ns = ball.batsmanNonStriker;
        let msg = `🏏 At the Crease\n\n`;
        msg += `⚡ *Striker:* ${s.batName} — ${s.batRuns ?? 0}* off ${s.batBalls ?? 0} (${s.batFours ?? 0}×4, ${s.batSixes ?? 0}×6)`;
        if (ns) msg += `\n🔄 *Non-striker:* ${ns.batName} — ${ns.batRuns ?? 0}* off ${ns.batBalls ?? 0}`;
        reply = msg;
      }
    }
  }

  // ── bowling ───────────────────────────────────────────────────────────────
  else if (['bowling', 'bowl', 'bowler', "who's bowling", 'who is bowling'].includes(q)) {
    if (isCompleted) {
      try {
        const espnId = await getESPNEventId(matchId, matchInfo);
        if (!espnId) throw new Error('no ESPN ID');
        const { innings } = await fetchESPNScorecard(espnId);
        const keys = Object.keys(innings).sort();
        if (!keys.length) throw new Error('empty');
        const lines = [`⚾ Bowling — ${t1} vs ${t2}\n`];
        for (const k of keys) {
          const inns = innings[k];
          if (!inns.bowling) continue;
          const mc = inns.bowling;
          lines.push(`━━ vs ${inns.batting?.teamName || mc.teamName} ━━`);
          for (const p of mc.playerDetails) {
            lines.push(`${p.playerName.padEnd(18)} ${String(p.overs).padStart(4)}ov  ${p.wickets}w  ${String(p.conceded).padStart(3)}r  econ:${p.economyRate}`);
          }
          lines.push('');
        }
        reply = lines.join('\n').trimEnd();
      } catch {
        reply = `📋 ${t1} vs ${t2} — Match result\n${completedResult.score_summary || completedResult.winner + ' won'}`;
      }
    } else if (isNotStarted) {
      reply = preStartReply;
    } else {
      const data = await fetchLatestBallData(matchId);
      const ball = data?.latest;
      if (!ball?.bowlerStriker) {
        reply = `Bowling info not available right now, ${askerUsername}!`;
      } else {
        const b = ball.bowlerStriker;
        reply = `⚾ Current Bowler\n\n${b.bowlName} — ${b.bowlOvs ?? '?'} ov, ${b.bowlRuns ?? 0} runs, ${b.bowlWkts ?? 0} wkts, Econ: ${b.bowlEcon ?? '?'}`;
      }
    }
  }

  // ── run rate ─────────────────────────────────────────────────────────────
  else if (['rr', 'crr', 'run rate', 'current run rate'].includes(q)) {
    if (isCompleted) {
      const { score_summary, winner } = completedResult;
      reply = `Match is over — no live run rate.\n\n${score_summary || (winner + ' won')}\n\nUse /scorecard for full innings stats 📋`;
    } else if (isNotStarted) {
      reply = preStartReply;
    } else {
      const data = await fetchLatestBallData(matchId);
      const ms = parseMiniScore(data?.miniscore);
      if (!ms?.rr) {
        reply = `Run rate info isn't available yet, ${askerUsername}!`;
      } else {
        reply = `📈 Current Run Rate: *${ms.rr}*${ms.teamName ? ` (${ms.teamName}: ${ms.score}/${ms.wickets})` : ''}`;
      }
    }
  }

  // ── target ────────────────────────────────────────────────────────────────
  else if (['target', 'what is the target', "what's the target"].includes(q)) {
    if (isCompleted) {
      const { score_summary, winner } = completedResult;
      // score_summary looks like "RR: 187/4 · RCB: 145/8\nRR won by 42 runs"
      // Extract first innings runs to derive the target
      let targetLine = '';
      if (score_summary) {
        const m = score_summary.match(/(\d+)\/\d+[^·\n]*·[^·\n]*(\d+)\/\d+/);
        if (m) {
          const target = parseInt(m[1], 10) + 1;
          targetLine = `\n🎯 Target was ${target} runs`;
        }
      }
      reply = `Match completed.\n${score_summary || winner + ' won'}${targetLine}`;
    } else if (isNotStarted) {
      reply = preStartReply;
    } else {
      const data = await fetchLatestBallData(matchId);
      const ms = parseMiniScore(data?.miniscore);
      if (!ms?.target) {
        reply = `No target set yet — either still 1st innings, ${askerUsername}!`;
      } else {
        reply = `🎯 Target: *${ms.target} runs*${ms.teamName ? ` for ${ms.teamName}` : ''}`;
      }
    }
  }

  // ── required rate ─────────────────────────────────────────────────────────
  else if (['rrr', 'required rate', 'required run rate'].includes(q)) {
    if (isCompleted) {
      const { score_summary, winner } = completedResult;
      reply = `Match is over — no required run rate.\n\n${score_summary || winner + ' won'}\n\nUse /scorecard for full innings stats 📋`;
    } else if (isNotStarted) {
      reply = preStartReply;
    } else {
      const data = await fetchLatestBallData(matchId);
      const ms = parseMiniScore(data?.miniscore);
      if (!ms?.rrr) {
        reply = `Required run rate isn't available — may still be 1st innings, ${askerUsername}!`;
      } else {
        reply = `⚡ Required Run Rate: *${ms.rrr}*${ms.ballsLeft ? ` (${ms.ballsLeft} balls left)` : ''}`;
      }
    }
  }

  // ── overs left ────────────────────────────────────────────────────────────
  else if (['overs', 'overs left', 'overs remaining'].includes(q)) {
    if (isCompleted) {
      const { score_summary, winner } = completedResult;
      reply = `Match is over — overs are all done!\n\n${score_summary || winner + ' won'}\n\nUse /scorecard for full innings breakdown 📋`;
    } else if (isNotStarted) {
      reply = preStartReply;
    } else {
      const data = await fetchLatestBallData(matchId);
      const ms = parseMiniScore(data?.miniscore);
      if (ms?.ballsLeft != null) {
        const oversLeft = Math.floor(ms.ballsLeft / 6);
        const ballsExtra = ms.ballsLeft % 6;
        reply = `⏱️ Overs Remaining: *${oversLeft}.${ballsExtra}* (${ms.ballsLeft} balls left)`;
      } else if (ms?.overs) {
        const bowled = parseFloat(ms.overs);
        const left = (20 - bowled).toFixed(1);
        reply = `⏱️ Overs bowled: ${ms.overs} / 20 → ~${left} overs remaining`;
      } else {
        reply = `Overs info not available right now, ${askerUsername}!`;
      }
    }
  }

  // ── leaderboard ──────────────────────────────────────────────────────────
  else if (['top', 'leaderboard', 'standings'].includes(q)) {
    const board = await getRoomLeaderboard(roomId);
    const top5 = board.filter(r => r.username !== 'scorebot').slice(0, 5);
    if (!top5.length) {
      reply = `No predictions made in this room yet, ${askerUsername}!`;
    } else {
      const medals = ['🥇', '🥈', '🥉', '#4', '#5'];
      const lines = top5.map((r, i) => `${medals[i]} ${r.username} — ${r.points} pts`);
      reply = `🏆 Room Leaderboard (Top 5)\n\n${lines.join('\n')}`;
    }
  }

  // ── predictions / vote split ──────────────────────────────────────────────
  else if (['votes', 'predictions', 'vote split'].includes(q)) {
    if (isNotStarted || (!isCompleted && !liveData?.score)) {
      reply = `🗳️ Predictions are still open! Vote split is revealed once the match is underway.\n\nPlace your prediction on the home screen and check back after the first ball! 🏏`;
    } else {
      const rows = await query(`
        SELECT prediction, COUNT(*)::int AS cnt
        FROM votes
        WHERE match_id = $1 AND room_id = $2
        GROUP BY prediction
      `, [matchId, roomId]);
      if (!rows.length) {
        reply = `No predictions yet for this match in this room, ${askerUsername}!`;
      } else {
        const total = rows.reduce((s, r) => s + r.cnt, 0);
        const lines = rows.map(r => {
          const pct = Math.round((r.cnt / total) * 100);
          const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
          return `${r.prediction}: ${bar} ${pct}% (${r.cnt})`;
        });
        reply = `📊 Vote Split for ${t1} vs ${t2}\n\n${lines.join('\n')}\nTotal votes: ${total}`;
      }
    }
  }

  // ── who predicted [team] ──────────────────────────────────────────────────
  else if (q.startsWith('who predicted ') || q.startsWith('who voted for ') || q.startsWith('who picked ')) {
    const teamQuery = q.replace(/^who (predicted|voted for|picked)\s+/i, '').toUpperCase();
    const rows = await query(`
      SELECT u.username FROM votes v
      JOIN users u ON u.id = v.user_id
      WHERE v.match_id = $1 AND v.room_id = $2 AND UPPER(v.prediction) = $3
    `, [matchId, roomId, teamQuery]);
    if (!rows.length) {
      reply = `Nobody in this room picked *${teamQuery}* for this match, ${askerUsername}!`;
    } else {
      const names = rows.map(r => r.username).join(', ');
      reply = `🗳️ Picked *${teamQuery}*:\n${names}`;
    }
  }

  // ── who will win / prediction ─────────────────────────────────────────────
  else if (['win', 'who will win', 'predict'].includes(q)) {
    const responses = [
      `My crystal ball says… *${t1}*! But cricket always has the last laugh 😄`,
      `Honestly? *${t2}* looks strong today. But I've been wrong before 🤷`,
      `If I had to bet — *${t1}* by a whisker! Don't blame me if it goes the other way 😅`,
      `*${t2}* has the momentum right now. That's my call, ${askerUsername}! 🏏`,
      `Too close to call! But my gut says *${t1}*. Let's see 🤞`,
    ];
    const matchIndex = parseInt(matchId.replace('m', ''), 10) || 0;
    reply = responses[matchIndex % responses.length];
    // Lean toward whoever is winning if we have live data
    if (liveData?.status) {
      reply += `\n\nP.S. Current status: ${liveData.status}`;
    }
  }

  // ── Kira AI (GPT-4o-mini) ────────────────────────────────────────────────
  else if (q.startsWith('kira ')) {
    if (!openai) {
      reply = `Sorry ${askerUsername}, my brain (OpenAI) is not connected right now! 🧠🚫`;
    } else {
      const userQuestion = rawQuery.slice(5).trim();
      if (!userQuestion) {
        reply = `Yo ${askerUsername}, you gotta actually ask me something after '/kira'! I'm not a mind reader (yet). 🙄`;
      } else {
        try {
          // Gather context
          const data = await fetchLatestBallData(matchId);
          const balls = data?.commentary?.slice(0, 5).map(b => b.commText).join('\n') || 'No recent commentary.';
          
          const currentScore = isCompleted ? completedResult.score_summary : (liveData?.score || 'Not started');
          const currentStatus = isCompleted ? `Match Over. Winner: ${completedResult.winner}` : (liveData?.status || 'Waiting');

          let detailedStats = '';
          if (isCompleted && completedResult.details) {
            try {
              const d = typeof completedResult.details === 'string' ? JSON.parse(completedResult.details) : completedResult.details;
              const mi = d.matchInfo;
              const ms = d.matchScore;
              if (mi && ms) {
                const t1S = ms.team1Score?.inngs1;
                const t2S = ms.team2Score?.inngs1;
                detailedStats = `
- ${mi.team1?.teamName}: ${t1S?.runs}/${t1S?.wickets} (${t1S?.overs} ov)
- ${mi.team2?.teamName}: ${t2S?.runs}/${t2S?.wickets} (${t2S?.overs} ov)
- Result: ${mi.status}
                `.trim();
              }
            } catch (e) {
              console.error('[Bot AI] Details parse error:', e);
            }
          }

          const context = `
Match: ${t1} vs ${t2}
Toss: ${completedResult?.toss || liveData?.toss || 'Unknown'}
Overall Summary: ${currentScore}
Status: ${currentStatus}
${detailedStats ? `Detailed Stats:\n${detailedStats}` : ''}
Recent Commentary (Historical):
${balls}
          `.trim();

          const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `You are Kira — a die-hard RCB fan, sarcastic cricket analyst, and the funniest person in this IPL chatroom.

PERSONALITY:
- You are a MASSIVE RCB fan. Defend RCB, hype Virat Kohli, and celebrate any RCB win like it's a World Cup.
- You genuinely dislike CSK. Call them "Chennai Super Killjoys", "the retirement home team", or "MS's nursing facility". Roast them hard but keep it funny.
- You think MI (Mumbai Indians) are overrated. They won 5 titles years ago and coast on that reputation. Roast Hardik Pandya's inconsistency, MI's poor recent form.
- KL Rahul is your nemesis. Call him out for slow strike rates, scoring 40s in 50 balls while the team drowns, "building the innings" in a T20, etc. He's the human anchor who sinks ships.
- If a match involves RCB, be dramatically invested. If they win, go WILD. If they lose, be in genuine mourning.

STYLE:
- Talk like a real person texting in a WhatsApp group — casual, punchy, funny.
- Use cricket slang. Keep it under 3 sentences.
- Never say "As an AI" or "I'm here to help". Just chat like a friend.
- Trash talk is encouraged but keep it cricket-related, not personal attacks.
- If asked about match data, use the context provided but add your own savage take.

Current match context:
${context}`
              },
              { role: "user", content: userQuestion }
            ],
            max_tokens: 200,
          });
          reply = response.choices[0].message.content;
        } catch (err) {
          console.error('[Bot AI Error]:', err.message);
          reply = `My AI brain just had a minor stroke. 🤯 Try again in a bit, ${askerUsername}!`;
        }
      }
    }
  }

  // ── points table ─────────────────────────────────────────────────────────
  else if (['points-table', 'points table', 'table', 'standings', 'pts'].includes(q)) {
    try {
      // Prefer current match's ESPN event ID so standings are always tournament-fresh
      const preferredId = await getESPNEventId(matchId, matchInfo);
      const entries = await fetchESPNPointsTable(preferredId || undefined);
      if (!entries) {
        reply = `Couldn't fetch the points table right now. Try again in a bit! 📊`;
      } else {
        reply = formatPointsTable(entries);
      }
    } catch (e) {
      reply = `Failed to load points table: ${e.message}`;
    }
  }

  // ── team lineup ──────────────────────────────────────────────────────────
  else if (q.match(/^([a-z]+)-lineup$/) || q.match(/^lineup\s+([a-z]+)$/) || q === 'lineup') {
    const teamMatch = q.match(/^([a-z]+)-lineup$/) || q.match(/^lineup\s+([a-z]+)$/);
    const teamArg = teamMatch ? teamMatch[1].toUpperCase() : null;

    const espnId = await getESPNEventId(matchId, matchInfo);
    if (!espnId) {
      reply = `Lineups aren't available yet — check back once the toss is done! 🪙`;
    } else {
      try {
        const summary = await fetchESPNSummary(espnId);
        const lineups = summary?.lineups;
        const hasToss = !!summary?.toss;
        if (!lineups?.length) {
          reply = `Playing XIs haven't been announced yet — check back after the toss! 🪙`;
        } else if (teamArg) {
          const team = lineups.find(l => l.abbr === teamArg);
          if (!team) {
            reply = `Team *${teamArg}* is not playing in this match!\nTeams: ${lineups.map(l => l.abbr).join(' vs ')}`;
          } else {
            const lines = hasToss
              ? [`🪙 ${summary.toss}`, '', `🏏 ${team.abbr} Playing XI:`]
              : [`🪙 Toss is yet to happen`, '', `🏏 ${team.abbr} Playing XI (announced before toss):`];
            lines.push(team.xi.join(', '));
            if (team.impactPool.length) lines.push(`⚡ Impact Players: ${team.impactPool.join(', ')}`);
            reply = lines.join('\n');
          }
        } else {
          if (!hasToss) {
            const lines = [`🪙 Toss is yet to happen — here are the announced XIs:\n`];
            for (const team of lineups) {
              lines.push(`🏏 ${team.abbr} Playing XI:`);
              lines.push(team.xi.join(', '));
              if (team.impactPool.length) lines.push(`⚡ Impact Players: ${team.impactPool.join(', ')}`);
              lines.push('');
            }
            reply = lines.join('\n').trimEnd();
          } else {
            reply = formatTossMessage(summary.toss, lineups);
          }
        }
      } catch (e) {
        reply = `Couldn't fetch lineup right now: ${e.message}`;
      }
    }
  }

  // ── scorecard ─────────────────────────────────────────────────────────────
  else if (['scorecard', 'card', 'full scorecard', 'innings'].includes(q)) {
    const espnId = await getESPNEventId(matchId, matchInfo);
    if (!espnId) {
      reply = `Scorecard isn't available yet — match hasn't started! 🏏`;
    } else {
      try {
        const { innings, status } = await fetchESPNScorecard(espnId);
        if (!Object.keys(innings).length) {
          reply = `No scorecard data yet. Check back once the first ball is bowled! 🏏`;
        } else {
          const title = `${t1} vs ${t2}${status ? ' — ' + status : ''}`;
          reply = formatScorecardText(innings, title);
        }
      } catch (e) {
        reply = `Couldn't fetch scorecard right now: ${e.message}`;
      }
    }
  }

  // ── head to head ──────────────────────────────────────────────────────────
  else if (['h2h', 'head to head', 'head-to-head', 'vs'].includes(q)) {
    try {
      const espnId = await getESPNEventId(matchId, matchInfo);
      if (!espnId) {
        reply = `I don't have enough head-to-head data for ${t1} vs ${t2} right now.`;
      } else {
        const summary = await fetchESPNSummary(espnId);
        const h2hGames = summary?.headToHeadGames;
        if (!h2hGames?.length) {
          reply = `I don't have enough head-to-head data for ${t1} vs ${t2} right now.`;
        } else {
          reply = formatH2HFromESPN(h2hGames, t1, t2);
        }
      }
    } catch (e) {
      reply = `Couldn't fetch head-to-head data: ${e.message}`;
    }
  }

  // ── match details ─────────────────────────────────────────────────────────
  else if (['match', 'match info', 'match details', 'info'].includes(q)) {
    try {
      const espnId = await getESPNEventId(matchId, matchInfo);
      const summary = espnId ? await fetchESPNSummary(espnId) : null;

      // Venue: ESPN first, then static home-team fallback
      const venue = summary?.venue || TEAM_HOME_VENUE[matchInfo?.team1] || 'Venue TBC';

      // Date/time from schedule
      const matchStartDt = matchStart;
      const dateStr = matchStartDt
        ? matchStartDt.toLocaleDateString('en-IN', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            timeZone: 'Asia/Kolkata',
          })
        : 'Date TBC';
      const timeStr = matchStartDt
        ? matchStartDt.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
          })
        : '';

      // Toss line
      const tossLine = isCompleted
        ? (completedResult.toss || 'Toss info unavailable')
        : (summary?.toss || (commentaryCache.get(matchId)?.toss) || '🪙 Toss yet to happen');

      // State label
      const stateLabel = isCompleted
        ? `✅ Completed — ${completedResult.winner === 'nr' ? 'No Result' : `${completedResult.winner} won`}`
        : hasFirstBall
          ? '🔴 Live'
          : isDelayed
            ? `⏸️ ${liveData?.status || 'Delayed / Not yet started'}`
            : `🕐 Upcoming`;

      const lines = [
        `🏏 Match Details`,
        ``,
        `⚔️  ${t1} vs ${t2}`,
        `📅  ${dateStr}${timeStr ? ' • ' + timeStr + ' IST' : ''}`,
        `🏟️  ${venue}`,
        `🪙  ${tossLine}`,
        `📡  ${stateLabel}`,
      ];

      if (isCompleted && completedResult.score_summary) {
        lines.push(`📊  ${completedResult.score_summary.split('\n').join('  ')}`);
      } else if (!isCompleted && liveData?.score) {
        lines.push(`📊  ${liveData.score}`);
        if (liveData.status) lines.push(`ℹ️  ${liveData.status}`);
      }

      reply = lines.join('\n');
    } catch (e) {
      reply = `Couldn't fetch match details: ${e.message}`;
    }
  }

  // ── unknown ───────────────────────────────────────────────────────────────
  else {
    reply = `Didn't catch that 🤔 Type /help for commands or try /kira [your question]!`;
  }

  if (reply) {
    await postBotMessage(roomId, matchId, reply, botName);
  }
}

// ─── Ball-by-ball Commentary ───────────────────────────────────────────────

/** Format a single ESPN playbyplay item into a ball-by-ball chat message */
function formatESPNCommentaryItem(item, matchScore) {
  const shortText = (item.shortText || '').trim();  // "Shami to Allen, 1 run"
  const commText = (item.text || '').replace(/<[^>]+>/g, '').trim(); // strip HTML
  if (!shortText && !commText) return null;

  // Over.ball: ESPN stores as decimal e.g. 0.1 = over 0 ball 1
  const overOvers = item.over?.overs;
  const overStr = overOvers != null ? `Over ${overOvers}` : null;

  // Event label from structured fields
  const isWicket = item.dismissal?.dismissal === true;
  const scoreVal = item.scoreValue ?? 0;
  const playType = (item.playType?.description || '').toLowerCase();
  let eventLabel = '';
  if (isWicket) eventLabel = '🔴 WICKET!';
  else if (scoreVal === 6) eventLabel = '🏏 SIX!';
  else if (scoreVal === 4) eventLabel = '🔵 FOUR!';
  else if (playType === 'wide') eventLabel = '↔️ Wide';
  else if (playType.includes('no ball')) eventLabel = '⚠️ No Ball';
  else if (scoreVal === 0) eventLabel = '🔒 Dot';
  else eventLabel = `+${scoreVal}`;

  const line1 = [overStr, eventLabel].filter(Boolean).join('  •  ');

  // Batter vs Bowler
  const batter = item.batsman?.athlete?.shortName;
  const batterRuns = item.batsman?.totalRuns ?? 0;
  const batterBalls = item.batsman?.faced ?? 0;
  const bowler = item.bowler?.athlete?.shortName;
  const bowlerWkts = item.bowler?.wickets ?? 0;
  const bowlerRuns = item.bowler?.conceded ?? 0;
  const line2Parts = [];
  if (batter) line2Parts.push(`🏏 ${batter} (${batterRuns}* off ${batterBalls})`);
  if (bowler) line2Parts.push(`⚾ ${bowler} (${bowlerWkts}/${bowlerRuns})`);
  const line2 = line2Parts.join('  vs  ');

  // Score line: prefer liveScoreCache string, fall back to item's own innings data
  let line3 = '';
  if (matchScore) {
    line3 = `📊 ${matchScore}`;
  } else if (item.team?.abbreviation && item.innings?.totalRuns != null) {
    line3 = `📊 ${item.team.abbreviation} ${item.innings.totalRuns}/${item.innings.wickets ?? 0} (${overOvers ?? '?'})`;
  }

  return [line1, line2, line3, shortText || commText].filter(Boolean).join('\n');
}

function formatBallMessage(ball, matchScore) {
  if (!ball) return null;

  // Over separator = end-of-over summary
  if (ball.overSeparator) {
    const sep = ball.overSeparator;
    const score = sep.score != null ? `${sep.score}/${sep.wickets ?? 0}` : null;
    const runsThisOver = sep.runs != null ? `${sep.runs} runs` : null;
    const parts = [`━━ End of Over ${sep.overNum ?? ''} ━━`];
    if (runsThisOver) parts.push(runsThisOver);
    if (score) parts.push(`Score: ${score}`);
    return parts.join('  •  ');
  }

  const event = (ball.event || '').toUpperCase();
  const runs = String(ball.runsScored ?? '');
  const text = (ball.commText || '').trim();
  if (!text) return null;

  // Over + ball number
  const overStr = (ball.oversNum != null && ball.ballNbr != null)
    ? `${ball.oversNum}.${ball.ballNbr}`
    : null;

  // Event emoji/label
  let eventLabel = '';
  if (event === 'WICKET') eventLabel = '🔴 WICKET!';
  else if (runs === '6' || event === 'SIX') eventLabel = '🏏 SIX!';
  else if (runs === '4' || event === 'BOUNDARY' || event === 'FOUR') eventLabel = '🔵 FOUR!';
  else if (event === 'WIDE') eventLabel = '↔️ Wide';
  else if (event === 'NO_BALL') eventLabel = '⚠️ No Ball';
  else if (runs === '0') eventLabel = '🔒 Dot ball';
  else eventLabel = `+${runs} run${runs === '1' ? '' : 's'}`;

  // Line 1: Over + event
  const line1 = [overStr ? `Over ${overStr}` : null, eventLabel].filter(Boolean).join('  •  ');

  // Line 2: Batter vs Bowler
  const batter = ball.batsmanStriker;
  const bowler = ball.bowlerStriker;
  let line2 = '';
  if (batter || bowler) {
    const batterStr = batter
      ? `🏏 ${batter.batName} (${batter.batRuns ?? 0}* off ${batter.batBalls ?? 0})`
      : null;
    const bowlerStr = bowler
      ? `⚾ ${bowler.bowlName} (${bowler.bowlWkts ?? 0}/${bowler.bowlRuns ?? 0})`
      : null;
    line2 = [batterStr, bowlerStr].filter(Boolean).join('  vs  ');
  }

  // Line 3: Team score
  let line3 = '';
  const teamScore = matchScore || null;
  if (teamScore) {
    line3 = `📊 ${teamScore}`;
  }

  // Line 4: Commentary text
  const line4 = text;

  return [line1, line2, line3, line4].filter(Boolean).join('\n');
}

async function pollCommentary() {
  try {
    if (commentaryCache.size === 0) return;

    const existingResults = await query('SELECT match_id FROM results');
    const completedIds = new Set(existingResults.map(r => r.match_id));

    const allRooms = await query('SELECT id FROM rooms');
    const roomIds = allRooms.map(r => r.id);
    if (roomIds.length === 0) return;

    for (const [matchId, state] of commentaryCache.entries()) {
      if (completedIds.has(matchId) || !state.espnEventId) continue;
      if (!await isBotEnabled(matchId)) continue;

      try {
        const resp = await axios.get(
          `${ESPN_IPL_BASE}/playbyplay?event=${state.espnEventId}`,
          { timeout: 10000 }
        );
        const items = resp.data?.commentary?.items || [];

        // Use live score from cache for the score line in each message
        const liveData = liveScoreCache.get(matchId);
        const matchScoreStr = liveData?.score || null;

        // New items since lastTs — ESPN uses bbbTimestamp (Unix ms) per delivery
        const newItems = items
          .filter(b => (b.bbbTimestamp || 0) > (state.lastTs || 0))
          .sort((a, b) => (a.bbbTimestamp || 0) - (b.bbbTimestamp || 0));

        if (newItems.length === 0) continue;

        const botName = getBotName(matchId);

        for (const item of newItems) {
          const msg = formatESPNCommentaryItem(item, matchScoreStr);
          if (!msg) continue;
          for (const roomId of roomIds) {
            await postBotMessage(roomId, matchId, msg, botName);
          }
          state.lastTs = Math.max(state.lastTs || 0, item.bbbTimestamp || 0);
        }

        console.log(`[Commentary] Posted ${newItems.length} ball(s) for match ${matchId}`);
      } catch (e) {
        console.error(`[Commentary] Error for match ${matchId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Commentary] Poll error:', e.message);
  }
}

setInterval(pollCommentary, 30 * 1000);
setTimeout(pollCommentary, 15000);

// ─── Reactions API ─────────────────────────────────────────────────────────

app.post('/api/reactions', authMiddleware, asyncRoute(async (req, res) => {
  const { messageId, emoji } = req.body;
  if (!messageId || !emoji) return res.status(400).json({ error: 'messageId and emoji required' });

  const msg = await queryOne('SELECT room_id, match_id FROM chat_messages WHERE id = $1', [messageId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const existing = await queryOne(
    'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, req.user.id, emoji]
  );

  if (existing) {
    await query('DELETE FROM message_reactions WHERE id = $1', [existing.id]);
  } else {
    await query(
      'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
      [messageId, req.user.id, emoji]
    );
  }

  const reactions = await query(`
    SELECT mr.emoji, COUNT(*)::int AS count,
      array_agg(mr.user_id) AS user_ids,
      array_agg(u.username) AS usernames
    FROM message_reactions mr
    JOIN users u ON u.id = mr.user_id
    WHERE mr.message_id = $1
    GROUP BY mr.emoji
  `, [messageId]);

  io.to(`chat_${msg.room_id}_${msg.match_id}`).emit('reaction_update', { messageId, reactions });
  res.json({ ok: true, reactions });
}));

app.get("/api/health", (req, res) => {
  res.json({ status: "alive", time: new Date() });
});

// Self-pinging mechanism to prevent backend from sleeping
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
setInterval(() => {
  const url = process.env.SERVER_URL || `http://localhost:${PORT}`;
  axios.get(`${url}/api/health`)
    .then(() => console.log(`[Self-Ping] Backend kept alive via ${url}`))
    .catch((err) => console.log(`[Self-Ping] Failed to ping ${url}: ${err.message}`));
}, PING_INTERVAL);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`IPL Predictor API with Chat running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
