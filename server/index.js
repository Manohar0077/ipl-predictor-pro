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
let matchesCache = require("./schedule");
const webpush = require("web-push");

async function isVotingLocked(matchId) {
  const match = matchesCache.find((m) => m.id === matchId);
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

function getPollOpenMatches(matches, results, overrides) {
  const open = [];
  const openIds = new Set();
  const add = (m) => {
    if (!openIds.has(m.id)) {
      open.push(m);
      openIds.add(m.id);
    }
  };

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (results[m.id]) continue;
    if (i === 0 || results[matches[i - 1]?.id]) {
      add(m);
      const next = matches[i + 1];
      if (next && !results[next.id] && next.date === m.date) {
        add(next);
      }
      break;
    }
  }

  if (overrides) {
    Object.keys(overrides).forEach(id => {
      const match = matches.find(m => m.id === id);
      if (match && !results[match.id]) {
        add(match);
      }
    });
  }

  return open.sort((a, b) => {
    const idxA = matches.findIndex(m => m.id === a.id);
    const idxB = matches.findIndex(m => m.id === b.id);
    return idxA - idxB;
  });
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

// ─── Lightweight DB caches (avoids hitting DB on every 3s poll) ──────────────
let _completedIdsCache = { set: null, ts: 0 };
let _roomIdsCache = { ids: null, ts: 0 };
const COMPLETED_IDS_TTL = 30 * 1000;
const ROOM_IDS_TTL = 60 * 1000;

async function getCachedCompletedIds() {
  const now = Date.now();
  if (_completedIdsCache.set && now - _completedIdsCache.ts < COMPLETED_IDS_TTL) {
    return _completedIdsCache.set;
  }
  const rows = await query('SELECT match_id FROM results');
  _completedIdsCache = { set: new Set(rows.map(r => r.match_id)), ts: now };
  return _completedIdsCache.set;
}

async function getCachedRoomIds() {
  const now = Date.now();
  if (_roomIdsCache.ids && now - _roomIdsCache.ts < ROOM_IDS_TTL) {
    return _roomIdsCache.ids;
  }
  const rows = await query('SELECT id FROM rooms');
  _roomIdsCache = { ids: rows.map(r => r.id), ts: now };
  return _roomIdsCache.ids;
}

// Invalidate caches when results/rooms change (called after writes)
function invalidateResultsCache() { _completedIdsCache.ts = 0; }
function invalidateRoomsCache() { _roomIdsCache.ts = 0; }

async function loadMatchesCache() {
  try {
    const rows = await query(
      `SELECT id, match_num, date::text AS date, time, team1, team2,
              COALESCE(venue, '') AS venue, espn_event_id
       FROM matches ORDER BY match_num ASC`
    );
    if (rows.length > 0) {
      matchesCache = rows;
      console.log(`[Matches] Loaded ${matchesCache.length} matches from DB`);
    }
  } catch (e) {
    console.error('[Matches] Error loading from DB, using hardcoded schedule:', e.message);
  }
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
      is_room_admin BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (room_id, user_id)
    );
  `);

  // Add is_room_admin to existing room_members tables
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'room_members' AND column_name = 'is_room_admin') THEN
        ALTER TABLE room_members ADD COLUMN is_room_admin BOOLEAN DEFAULT FALSE;
      END IF;
    END $$;
  `);

  // Backfill: ensure all existing room creators are marked as room admins
  await query(`
    UPDATE room_members rm
    SET is_room_admin = TRUE
    FROM rooms r
    WHERE rm.room_id = r.id AND rm.user_id = r.created_by AND rm.is_room_admin = FALSE
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      is_test_user BOOLEAN DEFAULT FALSE,
      profile_pic TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Migration: Add is_test_user to existing users table
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_test_user') THEN
        ALTER TABLE users ADD COLUMN is_test_user BOOLEAN DEFAULT FALSE;
      END IF;
    END $$;
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

  await query(`
    CREATE TABLE IF NOT EXISTS match_scores (
      match_id TEXT PRIMARY KEY,
      team1 TEXT,
      team1_runs INTEGER,
      team1_overs NUMERIC(5,2),
      team1_wickets INTEGER,
      team2 TEXT,
      team2_runs INTEGER,
      team2_overs NUMERIC(5,2),
      team2_wickets INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
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

  await query(`
    CREATE TABLE IF NOT EXISTS room_join_requests (
      id SERIAL PRIMARY KEY,
      room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room_id, user_id)
    );
  `);

  // VAPID keys (single-row; auto-generated on first startup)
  await query(`
    CREATE TABLE IF NOT EXISTS vapid_keys (
      id INTEGER PRIMARY KEY DEFAULT 1,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Push subscriptions (one row per browser/device per user)
  await query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);`);

  // Matches table (stores IPL schedule, synced from ESPN)
  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      espn_event_id TEXT,
      match_num INTEGER UNIQUE NOT NULL,
      date DATE NOT NULL,
      time TEXT NOT NULL DEFAULT '19:30',
      team1 TEXT NOT NULL,
      team2 TEXT NOT NULL,
      venue TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed from hardcoded schedule if table is empty
  const matchCountRow = await queryOne('SELECT COUNT(*)::int AS n FROM matches');
  if (!matchCountRow || matchCountRow.n === 0) {
    const SEED_SCHEDULE = require('./schedule');
    for (let i = 0; i < SEED_SCHEDULE.length; i++) {
      const m = SEED_SCHEDULE[i];
      await query(
        `INSERT INTO matches (id, match_num, date, time, team1, team2, venue)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [m.id, i + 1, m.date, m.time || '19:30', m.team1, m.team2, m.venue || '']
      );
    }
    console.log(`[Matches] Seeded ${SEED_SCHEDULE.length} matches from hardcoded schedule`);
  }

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

  // STAGS auto-join removed — users join via invite code / join request only.
  // Auto-adding on every startup was causing removed users to be re-added.
}

// ─── Push Notification Setup ──────────────────────────────────────────────────

let VAPID_PUBLIC_KEY = null;

async function initVapid() {
  let keys = await queryOne('SELECT public_key, private_key FROM vapid_keys WHERE id = 1');
  if (!keys) {
    const generated = webpush.generateVAPIDKeys();
    await query(
      `INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [generated.publicKey, generated.privateKey]
    );
    keys = { public_key: generated.publicKey, private_key: generated.privateKey };
    console.log('[Push] Generated new VAPID keys');
  }
  webpush.setVapidDetails(
    'mailto:admin@ipl-predictor.app',
    keys.public_key,
    keys.private_key
  );
  VAPID_PUBLIC_KEY = keys.public_key;
  console.log('[Push] VAPID configured');
}

async function sendPushToUser(userId, payload) {
  const subs = await query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      console.log(`[Push] Sent to user ${userId}: "${payload.title}"`);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        console.log(`[Push] Subscription expired for user ${userId}, removing`);
        await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
      } else {
        console.error('[Push] Failed for user', userId, ':', e.statusCode, e.message);
      }
    }
  }
}

async function broadcastPush(payload) {
  const subs = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
      }
    }
  }
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

// ─── Push Notification Routes ─────────────────────────────────────────────────

app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not ready' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', authMiddleware, asyncRouteEarly(async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh  = EXCLUDED.p256dh,
           auth    = EXCLUDED.auth`,
    [req.user.id, endpoint, keys.p256dh, keys.auth]
  );
  res.json({ ok: true });
}));

app.delete('/api/push/subscribe', authMiddleware, asyncRouteEarly(async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await query(
    'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
    [endpoint, req.user.id]
  );
  res.json({ ok: true });
}));

// asyncRouteEarly — identical to asyncRoute but defined before it for the push routes above
function asyncRouteEarly(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => { console.error(err); next(err); });
  };
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

      // Push notifications to room members not currently in the chat
      if (VAPID_PUBLIC_KEY) {
        const roomKey = `chat_${roomId}_${matchId}`;
        const activeSocketRoom = io.sockets.adapter.rooms.get(roomKey);
        const onlineUserIds = new Set();
        if (activeSocketRoom) {
          for (const sid of activeSocketRoom) {
            const sock = io.sockets.sockets.get(sid);
            if (sock?.user?.id) onlineUserIds.add(sock.user.id);
          }
        }

        const [members, roomRow] = await Promise.all([
          query('SELECT user_id FROM room_members WHERE room_id = $1', [roomId]),
          queryOne('SELECT name FROM rooms WHERE id = $1', [roomId]),
        ]);
        const roomName = roomRow?.name ?? 'Room';
        const matchInfo = matchesCache.find(m => m.id === matchId);
        const matchLabel = matchInfo ? `${matchInfo.team1} vs ${matchInfo.team2}` : 'Live Match';
        const preview = msg.length > 80 ? msg.slice(0, 80) + '…' : msg;

        // Resolve who owns the replied-to message (if any)
        let replyTargetUserId = null;
        if (saved.reply_to_id) {
          const replyOwner = await queryOne(
            'SELECT user_id FROM chat_messages WHERE id = $1',
            [saved.reply_to_id]
          );
          replyTargetUserId = replyOwner?.user_id ?? null;
        }

        // Parse @mentions from the message text
        const mentionedHandles = new Set(
          [...msg.matchAll(/@([\w]+)/g)].map(m => m[1].toLowerCase())
        );
        const memberUserIds = new Set(members.map(m => m.user_id));
        let mentionedUserIds = new Set();
        if (mentionedHandles.size > 0) {
          const rows = await query(
            `SELECT id FROM users WHERE LOWER(username) = ANY($1) AND id != $2`,
            [[...mentionedHandles], socket.user.id]
          );
          // Only notify members of this room
          mentionedUserIds = new Set(rows.map(r => r.id).filter(id => memberUserIds.has(id)));
        }

        for (const member of members) {
          if (member.user_id === socket.user.id) continue;

          const isMentioned = mentionedUserIds.has(member.user_id);
          const isReplyToMember = replyTargetUserId === member.user_id;
          const isOffline = !onlineUserIds.has(member.user_id);

          // Mentions and replies always notify; other messages only notify offline members
          if (!isMentioned && !isReplyToMember && !isOffline) continue;

          let title;
          if (isMentioned) {
            title = `${socket.user.username} mentioned you in ${roomName}`;
          } else if (isReplyToMember) {
            title = `${socket.user.username} replied to you in ${roomName}`;
          } else {
            title = `${socket.user.username} · ${roomName}`;
          }

          sendPushToUser(member.user_id, {
            title,
            body: preview,
            icon: '/ipl-icon.png',
            tag: `chat_${roomId}_${matchId}`,
            data: {
              url: `/rooms/${roomId}/chat/${matchId}`,
              roomName,
              sender: socket.user.username,
            },
          }).catch(() => { });
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

  // reject if match is already completed
  const matchCompleted = await queryOne("SELECT 1 FROM results WHERE match_id = $1", [matchId]);
  if (matchCompleted) {
    return res.status(400).json({ error: "Voting is closed — this match has already been completed" });
  }

  // reject if voting window is locked
  const isLocked = await isVotingLocked(matchId);
  if (isLocked) {
    return res.status(400).json({ error: "Voting is locked for this match" });
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

  // reject if match is already completed
  const bulkMatchCompleted = await queryOne("SELECT 1 FROM results WHERE match_id = $1", [matchId]);
  if (bulkMatchCompleted) {
    return res.status(400).json({ error: "Voting is closed — this match has already been completed" });
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
  const rows = await query(`
    SELECT r.match_id, r.winner, r.score_summary, r.toss,
           ms.team1 AS t1_short, ms.team1_runs, ms.team1_wickets, ms.team1_overs,
           ms.team2 AS t2_short, ms.team2_runs, ms.team2_wickets, ms.team2_overs
    FROM results r
    LEFT JOIN match_scores ms ON r.match_id = ms.match_id
  `);
  const map = {};
  for (const r of rows) {
    map[r.match_id] = {
      winner: r.winner,
      scoreSummary: r.score_summary || null,
      toss: r.toss || null,
      team1: r.team1_runs !== null ? { runs: r.team1_runs, wickets: r.team1_wickets, overs: r.team1_overs } : null,
      team2: r.team2_runs !== null ? { runs: r.team2_runs, wickets: r.team2_wickets, overs: r.team2_overs } : null,
    };
  }
  res.json(map);
}));

app.post("/api/result", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { matchId, winner, scoreSummary } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  if (!winner) {
    await query("DELETE FROM results WHERE match_id = $1", [matchId]);
    await query("DELETE FROM match_scores WHERE match_id = $1", [matchId]);
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

    // Try to fetch and populate structured scores for NRR
    try {
      const espnId = matchESPNIdMap.get(matchId);
      if (espnId) {
        const summary = await fetchESPNSummary(espnId);
        if (summary) {
          const s1 = parseRunsWickets(summary.team1);
          const s2 = parseRunsWickets(summary.team2);
          const ov1 = parseOversNew(summary.team1, summary.status);
          const ov2 = parseOversNew(summary.team2, summary.status);

          await query(`
            INSERT INTO match_scores (
              match_id, team1, team1_runs, team1_overs, team1_wickets,
              team2, team2_runs, team2_overs, team2_wickets
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (match_id) DO UPDATE SET
              team1_runs = EXCLUDED.team1_runs, team1_overs = EXCLUDED.team1_overs, team1_wickets = EXCLUDED.team1_wickets,
              team2_runs = EXCLUDED.team2_runs, team2_overs = EXCLUDED.team2_overs, team2_wickets = EXCLUDED.team2_wickets
          `, [
            matchId,
            summary.team1.short, s1.runs, ov1, s1.wickets,
            summary.team2.short, s2.runs, ov2, s2.wickets
          ]);
        }
      }
    } catch (e) {
      console.error(`[Scores] Manual result score sync failed for ${matchId}:`, e.message);
    }

    // Notify all clients and send push
    invalidateResultsCache();
    io.emit('result_updated', { matchId, winner });
    const match = matchesCache.find(m => m.id === matchId);
    let pushTitle, pushBody;
    if (winner === 'nr') {
      pushTitle = '🌧️ Match Abandoned';
      pushBody = match ? `${match.team1} vs ${match.team2} — No Result` : 'No Result';
    } else if (winner === 'draw') {
      pushTitle = '🤝 It\'s a Tie!';
      pushBody = match ? `${match.team1} vs ${match.team2}` : 'Match tied';
    } else {
      pushTitle = `🏆 ${winner} Won!`;
      pushBody = (scoreSummary !== undefined && scoreSummary !== '') ? scoreSummary : (match ? `${match.team1} vs ${match.team2}` : winner);
    }
    broadcastPush({ title: pushTitle, body: pushBody, icon: '/favicon.ico', tag: `result_${matchId}`, data: { url: `/poll/${matchId}` } })
      .catch(e => console.error('[Push] Broadcast failed:', e.message));

    // Bot win announcement
    if (!winPostedSet.has(matchId) && match && await isBotEnabled(matchId)) {
      winPostedSet.add(matchId);
      const allRooms = await query('SELECT id FROM rooms');
      const botName = getBotName(matchId);
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
        await postBotMessage(room.id, matchId, winMsg, botName);
      }
    }
  }

  res.json({ ok: true });
}));

function computeUserTimingStats(voteRows) {
  if (!voteRows || voteRows.length === 0) return {};

  const matchMap = new Map(matchesCache.map((m) => [m.id, m]));
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

/** Compute cricket-style NRR2 for each user based on their predictions and match scores */
async function computeNRR2Stats(userIds, roomId = null) {
  if (!userIds || userIds.length === 0) return {};

  const scores = await query(`SELECT * FROM match_scores`);
  const scoreMap = new Map(scores.map(s => [s.match_id, s]));

  const voteSql = roomId
    ? `SELECT user_id, match_id, prediction FROM votes WHERE user_id = ANY($1::int[]) AND room_id = $2`
    : `SELECT user_id, match_id, prediction FROM votes WHERE user_id = ANY($1::int[])`;
  const voteParams = roomId ? [userIds, roomId] : [userIds];
  const votes = await query(voteSql, voteParams);

  // function to convert over format (19.2) to decimal (19.333)
  const toDecimalOvers = (ov) => {
    const str = String(ov);
    if (!str.includes('.')) return parseFloat(ov);
    const [w, b] = str.split('.').map(Number);
    return w + (b / 6);
  };

  const uStats = {};
  for (const uid of userIds) {
    uStats[uid] = { runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0 };
  }

  for (const v of votes) {
    const s = scoreMap.get(v.match_id);
    if (!s) continue;
    const us = uStats[v.user_id];
    if (!us) continue;

    const vIsT1 = (v.prediction === s.team1);
    const vIsT2 = (v.prediction === s.team2);

    if (vIsT1) {
      us.runsFor += s.team1_runs;
      us.oversFor += (s.team1_wickets === 10 ? 20.0 : toDecimalOvers(s.team1_overs));
      us.runsAgainst += s.team2_runs;
      us.oversAgainst += (s.team2_wickets === 10 ? 20.0 : toDecimalOvers(s.team2_overs));
    } else if (vIsT2) {
      us.runsFor += s.team2_runs;
      us.oversFor += (s.team2_wickets === 10 ? 20.0 : toDecimalOvers(s.team2_overs));
      us.runsAgainst += s.team1_runs;
      us.oversAgainst += (s.team1_wickets === 10 ? 20.0 : toDecimalOvers(s.team1_overs));
    }
  }

  const result = {};
  for (const uid of userIds) {
    const us = uStats[uid];
    if (us.oversFor === 0 || us.oversAgainst === 0) {
      result[uid] = null;
    } else {
      result[uid] = (us.runsFor / us.oversFor) - (us.runsAgainst / us.oversAgainst);
    }
  }
  return result;
}

async function getRoomLeaderboard(roomId) {
  const board = await query(`
    SELECT
      u.id AS user_id,
      u.username,
      u.profile_pic,
      rm.is_room_admin,
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
    FROM room_members rm
    JOIN users u ON u.id = rm.user_id
    LEFT JOIN votes v ON v.user_id = u.id AND v.room_id = rm.room_id
    LEFT JOIN results r ON r.match_id = v.match_id
    WHERE rm.room_id = $1 AND u.is_test_user = FALSE
    GROUP BY u.id, u.username, u.profile_pic, rm.is_room_admin
  `, [roomId]);
  return board;
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
    WHERE u.is_test_user = FALSE
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
      nrr2: null, // Placeholder, will update after enrichment
      first_vote_at: t.firstVoteAt ? t.firstVoteAt.toISOString() : null,
    };
  });

  // Calculate NRR2 for all users
  const userIds = enriched.map(e => e.user_id);
  const nrr2Stats = await computeNRR2Stats(userIds);
  enriched.forEach(e => {
    e.nrr2 = nrr2Stats[e.user_id];
  });

  enriched.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.correct !== a.correct) return b.correct - a.correct;

    // NRR2 (Cricket NRR) tie-breaker
    const n2A = a.nrr2 ?? -Infinity;
    const n2B = b.nrr2 ?? -Infinity;
    if (n2B !== n2A) return n2B - n2A;
    const valA = a.nrr ?? -Infinity;
    const valB = b.nrr ?? -Infinity;
    if (valB !== valA) return valB - valA;
    return a.username.localeCompare(b.username);
  });

  return enriched.map((row, i) => ({ ...row, rank: i + 1 }));
}

app.get("/api/last-poll-summary", authMiddleware, asyncRoute(async (req, res) => {
  const { roomId } = req.query;

  // 1. Get the latest match with a result
  const lastResult = await queryOne(`
    SELECT r.match_id, r.winner, r.score_summary, r.created_at,
           ms.team1_runs, ms.team1_wickets, ms.team1_overs,
           ms.team2_runs, ms.team2_wickets, ms.team2_overs
    FROM results r
    LEFT JOIN match_scores ms ON r.match_id = ms.match_id
    ORDER BY r.created_at DESC
    LIMIT 1
  `);

  if (!lastResult) {
    return res.json({ noData: true });
  }

  const matchId = lastResult.match_id;
  const match = matchesCache.find(m => m.id === matchId);
  if (!match) return res.json({ noData: true });

  // 2. Get votes for this match, filtered by room if provided
  const votesQuery = roomId
    ? `SELECT v.user_id, u.username, v.prediction
       FROM votes v
       JOIN users u ON v.user_id = u.id
       WHERE v.match_id = $1 AND v.room_id = $2`
    : `SELECT v.user_id, u.username, v.prediction
       FROM votes v
       JOIN users u ON v.user_id = u.id
       WHERE v.match_id = $1`;
  const votesParams = roomId ? [matchId, roomId] : [matchId];
  const votes = await query(votesQuery, votesParams);

  // 3. User specific status
  const userVote = votes.find(v => v.user_id === req.user.id);
  const isCorrect = userVote && (
    userVote.prediction === lastResult.winner ||
    (['nr', 'draw'].includes(lastResult.winner))
  );

  const userStatus = userVote
    ? (isCorrect ? 'won' : 'lost')
    : 'no_vote';

  // 4. Rank Change Calculation — use room leaderboard if roomId provided
  const currentBoard = roomId
    ? await getRoomLeaderboard(parseInt(roomId))
    : await getLeaderboardInternal();

  // Previous points calculation for all users
  const prevBoard = currentBoard.map(user => {
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

    // NRR2 (Cricket NRR) tie-breaker
    const n2A = a.nrr2 ?? -Infinity;
    const n2B = b.nrr2 ?? -Infinity;
    if (n2B !== n2A) return n2B - n2A;
    const valA = a.nrr ?? -Infinity;
    const valB = b.nrr ?? -Infinity;
    if (valB !== valA) return valB - valA;
    return a.username.localeCompare(b.username);
  });

  const getRank = (board, userId) => {
    const idx = board.findIndex(u => u.user_id === userId);
    return idx === -1 ? board.length + 1 : idx + 1;
  };

  const currentRank = getRank(currentBoard, req.user.id);

  const prevRank = getRank(prevBoard, req.user.id);
  const pointsGained = (userVote && (lastResult.winner === 'nr' || lastResult.winner === 'draw'))
    ? 1
    : (userVote && userVote.prediction === lastResult.winner ? 2 : 0);

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
    team1Score: { runs: lastResult.team1_runs, wickets: lastResult.team1_wickets, overs: lastResult.team1_overs },
    team2Score: { runs: lastResult.team2_runs, wickets: lastResult.team2_wickets, overs: lastResult.team2_overs },
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
  const users = await query("SELECT id, username, is_test_user FROM users ORDER BY username ASC");
  res.json(users);
}));

// Admin: toggle test user status
app.put("/api/admin/users/:userId/test-user", authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { is_test_user } = req.body;
  if (isNaN(userId)) return res.status(400).json({ error: "Invalid user id" });
  if (typeof is_test_user !== "boolean") return res.status(400).json({ error: "is_test_user must be boolean" });

  await query("UPDATE users SET is_test_user = $1 WHERE id = $2", [is_test_user, userId]);
  res.json({ ok: true });
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
      `INSERT INTO room_members (room_id, user_id, is_room_admin) VALUES ($1, $2, TRUE) ON CONFLICT (room_id, user_id) DO UPDATE SET is_room_admin = TRUE`,
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

// Request to join a room (creates a pending request for admin approval)
app.post("/api/rooms/join-request", authMiddleware, asyncRoute(async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: "Invite code required" });

  const room = await queryOne(
    "SELECT id, name, invite_code, created_by FROM rooms WHERE UPPER(invite_code) = UPPER($1)",
    [inviteCode.trim()]
  );
  if (!room) return res.status(404).json({ error: "Invalid invite code" });

  const alreadyMember = await queryOne(
    "SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2",
    [room.id, req.user.id]
  );
  if (alreadyMember) return res.status(400).json({ error: "You are already a member of this room" });

  const existing = await queryOne(
    "SELECT status FROM room_join_requests WHERE room_id = $1 AND user_id = $2",
    [room.id, req.user.id]
  );
  if (existing) {
    if (existing.status === 'pending') return res.status(400).json({ error: "You already have a pending request for this room" });
    if (existing.status === 'approved') return res.status(400).json({ error: "Your request was already approved — try joining directly" });
    // Rejected previously — allow re-request
    await query(
      "UPDATE room_join_requests SET status = 'pending', created_at = NOW() WHERE room_id = $1 AND user_id = $2",
      [room.id, req.user.id]
    );
    io.emit("join_request_new", { roomId: room.id, roomName: room.name, username: req.user.username });
    notifyRoomAdminsOfJoinRequest(room.id, room.name, req.user.username);
    return res.json({ ok: true, message: "Join request re-submitted. A room admin will review it." });
  }

  await query(
    "INSERT INTO room_join_requests (room_id, user_id) VALUES ($1, $2)",
    [room.id, req.user.id]
  );
  io.emit("join_request_new", { roomId: room.id, roomName: room.name, username: req.user.username });
  notifyRoomAdminsOfJoinRequest(room.id, room.name, req.user.username);
  res.json({ ok: true, message: "Join request sent! A room admin will review it." });
}));

async function notifyRoomAdminsOfJoinRequest(roomId, roomName, requesterUsername) {
  if (!VAPID_PUBLIC_KEY) return;
  try {
    const admins = await query(
      "SELECT user_id FROM room_members WHERE room_id = $1 AND is_room_admin = TRUE",
      [roomId]
    );
    for (const admin of admins) {
      sendPushToUser(admin.user_id, {
        title: `🔔 New join request — ${roomName}`,
        body: `${requesterUsername} wants to join your room.`,
        icon: '/favicon.ico',
        tag: `join_request_${roomId}`,
        data: { url: '/rooms' },
      }).catch(() => { });
    }
  } catch (e) {
    console.error('[Push] notifyRoomAdmins error:', e.message);
  }
}

// My rooms
app.get("/api/rooms/mine", authMiddleware, asyncRoute(async (req, res) => {
  const rooms = await query(`
    SELECT r.id, r.name, r.invite_code, r.created_by,
           rm.is_room_admin AS user_is_room_admin,
           COUNT(DISTINCT rm2.user_id)::int AS member_count,
           (
             SELECT COUNT(*)::int
             FROM room_join_requests rjr
             WHERE rjr.room_id = r.id AND rjr.status = 'pending'
           ) AS pending_requests
    FROM rooms r
    JOIN room_members rm  ON rm.room_id  = r.id AND rm.user_id = $1
    JOIN room_members rm2 ON rm2.room_id = r.id
    GROUP BY r.id, r.name, r.invite_code, r.created_by, rm.is_room_admin
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
      rm.is_room_admin,
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
    GROUP BY u.id, u.username, u.profile_pic, rm.is_room_admin
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

  const nrr2Map = await computeNRR2Stats(userIds, roomId);

  const enriched = board.map((row) => {
    const t = timing[row.user_id] || {};
    const n2 = nrr2Map[row.user_id] ?? null;
    return { ...row, nrr: t.nrr ?? null, nrr2: n2 };
  });

  enriched.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.correct !== a.correct) return b.correct - a.correct;

    // NRR2 (Cricket NRR) tie-breaker
    const n2A = a.nrr2 ?? -Infinity;
    const n2B = b.nrr2 ?? -Infinity;
    if (n2B !== n2A) return n2B - n2A;
    const valA = a.nrr ?? -Infinity;
    const valB = b.nrr ?? -Infinity;
    if (valB !== valA) return valB - valA;
    return a.username.localeCompare(b.username);
  });

  return enriched.map((row, i) => ({ ...row, rank: i + 1 }));
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
  const room = await queryOne("SELECT id, name, invite_code, created_by FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const members = await query(
    `SELECT u.username FROM users u JOIN room_members rm ON rm.user_id = u.id WHERE rm.room_id = $1 ORDER BY u.username ASC`,
    [roomId]
  );
  res.json({ ...room, members: members.map(m => m.username) });
}));

// Set/unset room admin role for a member (room admins, room creator, or global admin)
app.put("/api/rooms/:id/members/:userId/admin", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);
  if (isNaN(roomId) || isNaN(targetUserId)) return res.status(400).json({ error: "Invalid id" });

  const room = await queryOne("SELECT id, created_by FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const callerMembership = await queryOne(
    "SELECT is_room_admin FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, req.user.id]
  );
  if (!req.user.is_admin && !callerMembership?.is_room_admin) {
    return res.status(403).json({ error: "Only room admins can manage admin roles" });
  }
  // Protect the creator's own admin status
  if (targetUserId === room.created_by) {
    return res.status(400).json({ error: "Cannot change admin status of room creator" });
  }

  const { is_room_admin } = req.body;
  if (typeof is_room_admin !== "boolean") return res.status(400).json({ error: "is_room_admin must be boolean" });

  const targetMember = await queryOne(
    "SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, targetUserId]
  );
  if (!targetMember) return res.status(404).json({ error: "User is not a member of this room" });

  await query(
    "UPDATE room_members SET is_room_admin = $1 WHERE room_id = $2 AND user_id = $3",
    [is_room_admin, roomId, targetUserId]
  );
  res.json({ ok: true });
}));

// Remove a member from a room (room admins; cannot remove room creator)
app.delete("/api/rooms/:id/members/:userId", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);
  if (isNaN(roomId) || isNaN(targetUserId)) return res.status(400).json({ error: "Invalid id" });

  const room = await queryOne("SELECT id, created_by FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const callerMembership = await queryOne(
    "SELECT is_room_admin FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, req.user.id]
  );
  if (!req.user.is_admin && !callerMembership?.is_room_admin) {
    return res.status(403).json({ error: "Only room admins can remove members" });
  }
  if (targetUserId === room.created_by) {
    return res.status(400).json({ error: "Cannot remove the room creator" });
  }

  await query("DELETE FROM room_members WHERE room_id = $1 AND user_id = $2", [roomId, targetUserId]);
  invalidateRoomsCache();
  res.json({ ok: true });
}));

// Get pending join requests for a room (creator or admin)
app.get("/api/rooms/:id/join-requests", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  if (isNaN(roomId)) return res.status(400).json({ error: "Invalid room id" });

  const room = await queryOne("SELECT id, created_by FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const membership = await queryOne(
    "SELECT is_room_admin FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, req.user.id]
  );
  if (!req.user.is_admin && !membership?.is_room_admin) {
    return res.status(403).json({ error: "Only room admins can view join requests" });
  }

  const requests = await query(`
    SELECT rjr.id, rjr.room_id, rjr.user_id, rjr.status, rjr.created_at,
           u.username, u.profile_pic
    FROM room_join_requests rjr
    JOIN users u ON u.id = rjr.user_id
    WHERE rjr.room_id = $1 AND rjr.status = 'pending'
    ORDER BY rjr.created_at ASC
  `, [roomId]);

  res.json(requests);
}));

// Approve a join request (creator or admin)
app.post("/api/rooms/:id/join-requests/:requestId/approve", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  const requestId = parseInt(req.params.requestId);
  if (isNaN(roomId) || isNaN(requestId)) return res.status(400).json({ error: "Invalid id" });

  const room = await queryOne("SELECT id, name, created_by FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const approveMembership = await queryOne(
    "SELECT is_room_admin FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, req.user.id]
  );
  if (!req.user.is_admin && !approveMembership?.is_room_admin) {
    return res.status(403).json({ error: "Only room admins can approve join requests" });
  }

  const joinReq = await queryOne(
    "SELECT id, user_id, status FROM room_join_requests WHERE id = $1 AND room_id = $2",
    [requestId, roomId]
  );
  if (!joinReq) return res.status(404).json({ error: "Join request not found" });
  if (joinReq.status !== 'pending') return res.status(400).json({ error: "Request is no longer pending" });

  await query(
    "INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [roomId, joinReq.user_id]
  );
  await query("UPDATE room_join_requests SET status = 'approved' WHERE id = $1", [requestId]);
  io.emit("join_request_approved", { userId: joinReq.user_id, roomId });
  invalidateRoomsCache();

  // Notify the approved user
  if (VAPID_PUBLIC_KEY) {
    sendPushToUser(joinReq.user_id, {
      title: `✅ Request approved — ${room.name}`,
      body: `Your request to join "${room.name}" was approved! You're in.`,
      icon: '/favicon.ico',
      tag: `join_approved_${roomId}`,
      data: { url: '/rooms' },
    }).catch(() => { });
  }

  res.json({ ok: true });
}));

// Reject a join request (creator or admin)
app.post("/api/rooms/:id/join-requests/:requestId/reject", authMiddleware, asyncRoute(async (req, res) => {
  const roomId = parseInt(req.params.id);
  const requestId = parseInt(req.params.requestId);
  if (isNaN(roomId) || isNaN(requestId)) return res.status(400).json({ error: "Invalid id" });

  const room = await queryOne("SELECT id, name, created_by FROM rooms WHERE id = $1", [roomId]);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const rejectMembership = await queryOne(
    "SELECT is_room_admin FROM room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, req.user.id]
  );
  if (!req.user.is_admin && !rejectMembership?.is_room_admin) {
    return res.status(403).json({ error: "Only room admins can reject join requests" });
  }

  const joinReq = await queryOne(
    "SELECT id, user_id, status FROM room_join_requests WHERE id = $1 AND room_id = $2",
    [requestId, roomId]
  );
  if (!joinReq) return res.status(404).json({ error: "Join request not found" });
  if (joinReq.status !== 'pending') return res.status(400).json({ error: "Request is no longer pending" });

  await query("UPDATE room_join_requests SET status = 'rejected' WHERE id = $1", [requestId]);

  // Notify the rejected user
  if (VAPID_PUBLIC_KEY) {
    sendPushToUser(joinReq.user_id, {
      title: `❌ Request declined — ${room.name}`,
      body: `Your request to join "${room.name}" was not approved.`,
      icon: '/favicon.ico',
      tag: `join_rejected_${roomId}`,
      data: { url: '/rooms' },
    }).catch(() => { });
  }

  res.json({ ok: true });
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
  MI: 'Wankhede Stadium, Mumbai',
  CSK: 'MA Chidambaram Stadium, Chennai',
  RCB: 'M. Chinnaswamy Stadium, Bengaluru',
  KKR: 'Eden Gardens, Kolkata',
  DC: 'Arun Jaitley Stadium, Delhi',
  PBKS: 'Mullanpur Stadium, Chandigarh',
  RR: 'Sawai Mansingh Stadium, Jaipur',
  SRH: 'Rajiv Gandhi International Stadium, Hyderabad',
  GT: 'Narendra Modi Stadium, Ahmedabad',
  LSG: 'BRSABV Ekana Cricket Stadium, Lucknow',
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

/** Extract the match result description (e.g. "Lucknow Super Giants won by 3 wkts") from
 *  ESPN summary. Checks, in priority order:
 *  1. comp.status.type.detail — ESPN sometimes puts the win line here
 *  2. data.notes — a note whose text contains "won by / tie / abandoned"
 *  3. comp.situation.lastPlay.text — fallback live-play field */
function extractResultTextESPN(notes, statusDetail, situation) {
  const WIN_RE = /won by|tie[d]?|abandoned|no result/i;
  if (statusDetail && WIN_RE.test(statusDetail)) return statusDetail;
  if (Array.isArray(notes)) {
    const rn = notes.find(n => n.type === 'result' || (n.text && WIN_RE.test(n.text)));
    if (rn?.text) return rn.text.trim();
  }
  const lastPlayText = situation?.lastPlay?.text || situation?.text || '';
  if (lastPlayText && WIN_RE.test(lastPlayText)) return lastPlayText.trim();
  return null;
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

/** Convert a single ESPN event to a normalized internal match object.
 *  ESPN cricket nests competitors inside competitions[0], not on the event root. */
function adaptESPNEvent(evt) {
  if (!evt?.id) return null;
  // ESPN cricket: competitors live inside competitions[0]
  const comp = (evt.competitions || [])[0] || {};
  const comps = comp.competitors || evt.competitors || [];
  const c1 = comps[0] || {};
  const c2 = comps[1] || {};
  // Status lives on the competition object
  const compStatus = comp.status || evt.status || {};
  const state = compStatus.type?.state || 'pre';
  // Use detail (e.g. "CSK 143/6 (16.3 overs)") first, fall back to description
  const status = compStatus.type?.detail || compStatus.type?.description || compStatus.displayClock || '';
  // Team name may be under competitor.team.displayName (cricket) or competitor.displayName
  const t1Name = c1.team?.displayName || c1.displayName || '';
  const t2Name = c2.team?.displayName || c2.displayName || '';
  // Always resolve via TEAM_NAME_MAP first — ESPN abbreviations vary (e.g. "PBK" vs "PBKS", "LKN" vs "LSG")
  const t1Abbr = TEAM_NAME_MAP[t1Name] || c1.team?.abbreviation || teamAbbr(t1Name);
  const t2Abbr = TEAM_NAME_MAP[t2Name] || c2.team?.abbreviation || teamAbbr(t2Name);
  const t1Winner = c1.winner ?? false;
  const t2Winner = c2.winner ?? false;
  return {
    espnEventId: String(evt.id),
    team1: { name: t1Name, short: t1Abbr, score: c1.score || '' },
    team2: { name: t2Name, short: t2Abbr, score: c2.score || '' },
    state,
    status,
    startDateISO: evt.date || null,
    winnerName: state === 'post'
      ? (t1Winner ? t1Name : t2Winner ? t2Name : null)
      : null,
  };
}

/** Fetch all IPL events from ESPN Cricinfo (free, no key). Returns normalized match objects.
 *  datesParam: optional ESPN dates string, e.g. "20260410" or "20260410-20260411".
 *  Without it ESPN returns only current-day events, so pass dates for historical lookups. */
async function fetchESPNAll(datesParam = null) {
  const url = datesParam
    ? `${ESPN_IPL_BASE}/events?limit=100&dates=${datesParam}`
    : `${ESPN_IPL_BASE}/events?limit=100`;
  console.log(`[ESPN] GET ${url}`);
  const resp = await axios.get(url, { timeout: 10000 });
  const events = resp.data?.events || [];
  console.log(`[ESPN] ${resp.status} ${url} — ${events.length} events, top-level keys: ${Object.keys(resp.data || {}).join(', ')}`);
  if (!events.length) return [];
  const first = events[0];
  console.log(`[ESPN] First event: id=${first?.id}, state=${first?.competitions?.[0]?.status?.type?.state}`);
  return events.map(adaptESPNEvent).filter(Boolean);
}

/** Sync ESPN event IDs into the matches table. Fetches all IPL 2026 events from ESPN
 *  and matches them to DB rows by date + team abbreviations. */
async function syncMatchesFromESPN() {
  try {
    console.log('[Matches] Syncing schedule from ESPN...');
    const espnEvents = await fetchESPNAll('20260301-20260531');
    if (!espnEvents.length) {
      console.log('[Matches] ESPN returned 0 events for schedule sync');
      return { updated: 0 };
    }

    let updated = 0;
    const existing = await query('SELECT id, team1, team2, date::text AS date FROM matches');

    for (const evt of espnEvents) {
      const t1 = evt.team1.short;
      const t2 = evt.team2.short;
      const evtDate = evt.startDateISO?.split('T')[0];
      if (!t1 || !t2 || !evtDate) continue;

      const match = existing.find(m =>
        m.date === evtDate && (
          (m.team1 === t1 && m.team2 === t2) ||
          (m.team1 === t2 && m.team2 === t1)
        )
      );

      if (match && evt.espnEventId) {
        const r = await query(
          `UPDATE matches SET espn_event_id = $1
           WHERE id = $2 AND (espn_event_id IS NULL OR espn_event_id != $1)
           RETURNING id`,
          [evt.espnEventId, match.id]
        );
        if (r.length > 0) {
          console.log(`[Matches] Updated ESPN ID for ${match.id}: ${evt.espnEventId}`);
          updated++;
        }
      }
    }

    await loadMatchesCache();
    console.log(`[Matches] Sync complete: updated ${updated} ESPN IDs`);
    return { updated };
  } catch (e) {
    console.error('[Matches] Sync error:', e.message);
    return { error: e.message };
  }
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
      const posId = String(pos.id || '').toUpperCase();
      const posAbbr = String(pos.abbreviation || '').toUpperCase();
      const posName = String(pos.displayName || pos.name || '').toLowerCase();
      const isKeeper = posId === 'WK' || posAbbr === 'WK' ||
        posId.includes('WK') || posAbbr.includes('WK') ||
        posName.includes('wicket') || posName.includes('keeper');
      if (isKeeper) tags.push('wk');
      return tags.length ? `${name} (${tags.join(' & ')})` : name;
    });

    // Impact player pool — Strategy 1: scan all notes for impact-related text
    let impactPool = [];
    const teamNameLower = teamName.toLowerCase();
    const abbrLower = abbr.toLowerCase();
    for (const n of (notes || [])) {
      const text = n.text || '';
      const textLower = text.toLowerCase();
      // Note must reference this team and mention "impact"
      const mentionsTeam = textLower.includes(teamNameLower) || textLower.includes(abbrLower);
      const mentionsImpact = /impact\s+player|impact\s+sub/i.test(text);
      if (!mentionsTeam || !mentionsImpact) continue;
      // Extract names after a colon or "are:" / "is:"
      const colonIdx = text.indexOf(':');
      if (colonIdx !== -1) {
        const raw = text.slice(colonIdx + 1).trim();
        impactPool = raw.split(/,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
      }
      if (impactPool.length) break;
    }

    // Strategy 2: if notes gave nothing, look for non-starter players explicitly
    // flagged as impact subs on the roster (ESPN sometimes uses eligible/substitute flags)
    if (!impactPool.length) {
      const nonStarters = teamRoster.roster.filter(p => !p.starter);
      for (const p of nonStarters) {
        const isImpact =
          p.eligible === true ||
          p.substitute === true ||
          /impact/i.test(p.status?.type?.description || '') ||
          /impact/i.test(p.position?.displayName || '');
        if (isImpact) {
          const name = p.athlete?.battingName || p.athlete?.shortName || p.athlete?.displayName;
          if (name) impactPool.push(name);
        }
      }
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

/** Extract human-readable result text ("Team won by X") from a completed match.
 *  Checks status detail, notes array, and situation.lastPlay as fallbacks. */
function extractResultTextESPN(notes, statusDetail, situation) {
  const WIN_RE = /won by|tie[d]?|abandoned|no result/i;
  if (statusDetail && WIN_RE.test(statusDetail)) return statusDetail;
  if (Array.isArray(notes)) {
    const rn = notes.find(n => n.type === 'result' || (n.text && WIN_RE.test(n.text)));
    if (rn?.text) return rn.text.trim();
  }
  const lastPlayText = situation?.lastPlay?.text || situation?.text || '';
  if (lastPlayText && WIN_RE.test(lastPlayText)) return lastPlayText.trim();
  return null;
}

/** Fetch toss info + playing XIs for a specific ESPN event via the summary endpoint.
 *  Also returns state/status/winnerName/team1/team2 for use in checkRecentMatches. */
async function fetchESPNSummary(espnEventId) {
  try {
    const url = `${ESPN_IPL_BASE}/summary?event=${espnEventId}`;
    console.log(`[ESPN] GET ${url}`);
    const resp = await axios.get(url, { timeout: 8000 });
    const data = resp.data || {};
    const topKeys = Object.keys(data);
    console.log(`[ESPN] ${resp.status} ${url} — keys: ${topKeys.join(', ')}`);

    const comp = data.header?.competitions?.[0] || {};

    // Venue
    const venueObj = comp.venue || {};
    const venueName = venueObj.fullName || null;
    const venueCity = venueObj.address?.city || null;
    const venue = venueName
      ? (venueCity && !venueName.includes(venueCity) ? `${venueName}, ${venueCity}` : venueName)
      : null;

    // Competition-level state / result (used by checkRecentMatches)
    const competitors = comp.competitors || [];
    const c1 = competitors[0] || {};
    const c2 = competitors[1] || {};
    const t1Name = c1.team?.displayName || c1.displayName || '';
    const t2Name = c2.team?.displayName || c2.displayName || '';
    const t1Abbr = TEAM_NAME_MAP[t1Name] || c1.team?.abbreviation || teamAbbr(t1Name);
    const t2Abbr = TEAM_NAME_MAP[t2Name] || c2.team?.abbreviation || teamAbbr(t2Name);
    const state = comp.status?.type?.state || 'pre';
    const statusSummary = comp.status?.summary || '';             // e.g. "CSK won by 23 runs"
    const statusDetail = comp.status?.type?.detail || comp.status?.type?.description || '';
    // Prefer status.summary (direct win text) over detail/notes fallbacks
    const resultText = statusSummary || extractResultTextESPN(data.notes, statusDetail, comp.situation);
    const winnerName = state === 'post'
      ? (c1.winner ? t1Name : c2.winner ? t2Name : null)
      : null;
    console.log(`[ESPN] Summary event=${espnEventId}: state=${state}, result="${resultText || statusDetail}", winner=${winnerName || 'none'}`);

    // Debug: log notes so impact-player matching can be verified in server logs
    if (data.notes?.length) {
      console.log(`[ESPN] Notes for event ${espnEventId}:`, JSON.stringify(data.notes.map(n => ({ type: n.type, text: (n.text || '').slice(0, 120) }))));
    }
    // Extract high-fidelity data from structured linescores
    const extractTeamDataLS = (competitor) => {
      const res = { runs: 0, wickets: 0, overs: 0, balls: 0 };
      if (!competitor || !competitor.linescores) return res;

      // The definitive source is the linescore where isBatting is true
      const activeLS = competitor.linescores.find(ls => ls.isBatting === true)
        || competitor.linescores.find(ls => ls.runs > 0)
        || competitor.linescores[0];

      if (activeLS) {
        res.runs = activeLS.runs || 0;
        res.wickets = activeLS.wickets ?? 0;
        res.overs = activeLS.overs || 0;
      }
      return res;
    };

    const td1 = extractTeamDataLS(c1);
    const td2 = extractTeamDataLS(c2);
    const b1 = extractBallsFromRoster(data.rosters, t1Abbr);
    const b2 = extractBallsFromRoster(data.rosters, t2Abbr);

    return {
      toss: extractTossInfoESPN(data.notes),
      lineups: extractLineupsESPN(data.rosters, data.notes),
      headToHeadGames: data.headToHeadGames || null,
      standings: data.standings?.children?.[0]?.standings?.entries || null,
      venue,
      // Result info
      state,
      status: resultText || statusDetail,
      winnerName,
      team1: {
        name: t1Name,
        short: t1Abbr,
        score: String(c1.score || ''),
        wickets: td1.wickets,
        runs: td1.runs,
        overs: td1.overs,
        balls: b1
      },
      team2: {
        name: t2Name,
        short: t2Abbr,
        score: String(c2.score || ''),
        wickets: td2.wickets,
        runs: td2.runs,
        overs: td2.overs,
        balls: b2
      },
    };
  } catch (e) {
    console.error(`[ESPN] fetchESPNSummary error for event ${espnEventId}:`, e.message);
    return null;
  }
}

// ─── ESPN Data Helpers (used by bot commands) ──────────────────────────────

/** Resolve ESPN event ID for a match: live cache → matchESPNIdMap → results DB */
async function getESPNEventId(matchId, match) {
  // 1. Live commentary cache (populated during active polling)
  const cached = commentaryCache.get(matchId);
  if (cached?.espnEventId) return cached.espnEventId;

  // 2. matchESPNIdMap loaded from DB at startup
  const fromMap = matchESPNIdMap.get(matchId);
  if (fromMap) return fromMap;

  // 3. results DB (for completed matches that stored espnEventId in details)
  const row = await queryOne('SELECT details FROM results WHERE match_id = $1', [matchId]);
  if (row?.details) {
    try {
      const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
      if (d?.espnEventId) return d.espnEventId;
    } catch { }
  }

  return null;
}

/** Fetch IPL points table from ESPN standings field. Resolves an event ID then calls fetchESPNSummary. */
async function fetchESPNPointsTable(preferredEventId = null) {
  let eventId = preferredEventId;

  // 1. Live commentary cache
  if (!eventId) {
    for (const [, state] of commentaryCache.entries()) {
      if (state.espnEventId) { eventId = state.espnEventId; break; }
    }
  }
  // 2. matchESPNIdMap from DB (any known ESPN ID will have standings)
  if (!eventId) {
    for (const [, espnId] of matchESPNIdMap.entries()) {
      eventId = espnId; break;
    }
  }
  // 3. Most recent completed result that stored an ESPN ID
  if (!eventId) {
    const row = await queryOne('SELECT details FROM results ORDER BY created_at DESC LIMIT 1');
    if (row?.details) {
      try {
        const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
        eventId = d?.espnEventId;
      } catch { }
    }
  }
  if (!eventId) return null;

  const summary = await fetchESPNSummary(eventId);
  const entries = summary?.standings;
  if (!entries) return null;

  const stat = (e, name) => e.stats.find(s => s.name === name)?.displayValue ?? '-';
  return entries.map(e => ({
    rank: stat(e, 'rank'),
    team: e.team.abbreviation,
    m: stat(e, 'matchesPlayed'),
    w: stat(e, 'matchesWon'),
    l: stat(e, 'matchesLost'),
    nr: stat(e, 'noresult'),
    pts: stat(e, 'matchPoints'),
    nrr: stat(e, 'netrr'),
  }));
}

/** Format points table as a monospace-aligned table */
function formatPointsTable(entries) {
  const HDR = `${'#'.padStart(2)}  ${'Team'.padEnd(5)}  ${'M'.padStart(2)}  ${'W'.padStart(2)}  ${'L'.padStart(2)}  ${'NR'.padStart(2)}  ${'Pts'.padStart(3)}     NRR`;
  const SEP = '─'.repeat(HDR.length);
  const lines = ['🏆 IPL 2026 Points Table', '', HDR, SEP];
  for (const e of entries) {
    const nrr = parseFloat(e.nrr);
    const nrrStr = isNaN(nrr) ? (e.nrr || '—') : (nrr >= 0 ? '+' + nrr.toFixed(3) : nrr.toFixed(3));
    lines.push(
      `${String(e.rank).padStart(2)}  ${String(e.team).padEnd(5)}  ` +
      `${String(e.m).padStart(2)}  ${String(e.w).padStart(2)}  ` +
      `${String(e.l).padStart(2)}  ${String(e.nr).padStart(2)}  ` +
      `${String(e.pts).padStart(3)}  ${nrrStr.padStart(8)}`
    );
  }
  return lines.join('\n');
}

/** Fetch ESPN matchcard data (batting + bowling) for a given event */
async function fetchESPNScorecard(espnEventId) {
  const url = `${ESPN_IPL_BASE}/summary?event=${espnEventId}`;
  console.log(`[ESPN] GET ${url} (scorecard)`);
  const resp = await axios.get(url, { timeout: 8000 });
  const matchcards = resp.data?.matchcards || [];
  const header = resp.data?.header?.competitions?.[0];
  const statusSummary = header?.status?.summary || '';
  const statusDetail = header?.status?.type?.detail || header?.status?.type?.description || '';
  const status = statusSummary || statusDetail;
  const competitors = header?.competitors || [];
  const matchState = header?.status?.type?.state || 'pre';
  console.log(`[ESPN] ${resp.status} ${url} (scorecard) — matchcards: ${matchcards.length}, state: ${matchState}, status: "${status}"`);

  const innings = {};
  for (const mc of matchcards) {
    const k = mc.inningsNumber;
    if (!innings[k]) innings[k] = { teamName: mc.teamName };
    if (mc.headline === 'Batting') innings[k].batting = mc;
    if (mc.headline === 'Bowling') innings[k].bowling = mc;
  }

  // For completed matches, cross-check matchcard runs against the header's competitor
  // scores. The header updates immediately on match end; matchcards can lag behind and
  // still show the mid-innings state. Any innings whose run total doesn't match the
  // competitor's final score is stale — delete it so the placeholder fallback fires.
  if (matchState === 'post' && competitors.length) {
    // Build abbr → final runs map from competitors (ground truth)
    const compRunsByAbbr = {};
    for (const comp of competitors) {
      const name = comp.team?.displayName || comp.displayName || '';
      const abbr = TEAM_NAME_MAP[name] || teamAbbr(name) || name;
      const runs = (comp.score || '').split('/')[0].trim();
      if (abbr && runs) compRunsByAbbr[abbr] = runs;
    }
    for (const [k, inns] of Object.entries(innings)) {
      if (!inns.batting) continue;
      // matchcard teamName may be abbreviated ("CSK") or full ("Chennai Super Kings")
      const mcTeam = inns.teamName || '';
      const mcAbbr = TEAM_NAME_MAP[mcTeam] || mcTeam;
      const expected = compRunsByAbbr[mcAbbr];
      const actual = String(inns.batting.runs ?? '');
      if (expected && actual !== expected) {
        console.log(`[Scorecard] Stale innings removed (key=${k}, team=${mcTeam}): matchcard runs=${actual}, competitor final=${expected}`);
        delete innings[k];
      }
    }
  }

  const rosters = resp.data?.rosters || [];
  return { innings, status, competitors, rosters };
}

/** Flatten rosters stats array (nested or outer) into a plain key→value map */
function rosterStatsMap(ls) {
  const arr =
    ls?.linescores?.[0]?.statistics?.categories?.[0]?.stats ||
    ls?.statistics?.categories?.[0]?.stats || [];
  const m = {};
  for (const s of arr) m[s.name] = s.value;
  return m;
}

const DISMISSAL_CARD = {
  'not out': 'not out', 'c': 'caught', 'b': 'bowled', 'lbw': 'lbw',
  'run out': 'run out', 'st': 'stumped', 'c&b': 'c&b', 'retired': 'retired',
  'hit wicket': 'hit wicket', 'obstructing': 'obstructing', 'timed out': 'timed out',
};

/**
 * Build both innings from rosters[].roster[].linescores[].statistics.
 * Returns an array of { inningsNumber, teamName, teamAbbr, score, batters[], bowlers[] }
 * sorted by inningsNumber. Batters sorted by battingPosition; bowlers by order bowled.
 *
 * Uses rosters instead of matchcards because:
 *  - rosters always have up-to-date final stats (no stale mid-innings cache)
 *  - both innings are always present (one per period per player)
 *  - includes captain/WK flags and full dismissal info
 */
function buildScorecardFromRosters(rosters, competitors) {
  // competitor scores: abbr → full score string (e.g. "212/2")
  const compScore = {};
  for (const comp of competitors) {
    const name = comp.team?.displayName || comp.displayName || '';
    const abbr = TEAM_NAME_MAP[name] || teamAbbr(name) || name;
    if (abbr) compScore[abbr] = comp.score || '';
  }

  // periods: inningsNumber → { batters[], bowlers[] }
  const periods = {};

  for (const roster of rosters) {
    const tName = roster.team?.displayName || '';
    const tAbbr = roster.team?.abbreviation || TEAM_NAME_MAP[tName] || teamAbbr(tName) || tName;

    for (const player of roster.roster || []) {
      const name = player.athlete?.battingName || player.athlete?.displayName || '';
      const isWK = player.position?.abbreviation === 'WK' ||
        player.athlete?.position?.abbreviation === 'WK';
      const isCap = !!player.captain;

      for (const ls of player.linescores || []) {
        const period = ls.period;
        if (!periods[period]) periods[period] = { batters: [], bowlers: [] };

        const s = rosterStatsMap(ls);

        if (s.batted === 1) {
          const dis = s.dismissalCard || 'not out';
          periods[period].batters.push({
            teamName: tName, teamAbbr: tAbbr, name, isWK, isCap,
            position: s.battingPosition ?? 99,
            runs: s.runs ?? 0,
            balls: s.ballsFaced ?? 0,
            fours: s.fours ?? 0,
            sixes: s.sixes ?? 0,
            sr: typeof s.strikeRate === 'number' ? s.strikeRate.toFixed(1) : '-',
            dismissal: DISMISSAL_CARD[dis] || dis,
          });
        }

        if ((s.balls ?? 0) > 0) {
          const b = s.balls;
          const ov = `${Math.floor(b / 6)}.${b % 6}`;
          periods[period].bowlers.push({
            name,
            overs: ov,
            ballsCount: b,           // raw count for computing innings total overs
            runs: s.conceded ?? 0,
            wickets: s.wickets ?? 0,
            maidens: s.maidens ?? 0,
            econ: typeof s.economyRate === 'number' ? s.economyRate.toFixed(2) : '-',
          });
        }
      }
    }
  }

  const innings = [];
  for (const [period, data] of Object.entries(periods).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const batters = data.batters.sort((a, b) => a.position - b.position);
    if (!batters.length) continue;
    const { teamName, teamAbbr: tAbbr } = batters[0];

    // Compute total overs from bowler ball counts and append to score
    // if the competitor score string doesn't already include overs info.
    const totalBalls = data.bowlers.reduce((sum, b) => sum + (b.ballsCount || 0), 0);
    let score = compScore[tAbbr] || '';
    if (totalBalls > 0 && !score.includes('(')) {
      const ovFull = Math.floor(totalBalls / 6);
      const ovPart = totalBalls % 6;
      score = `${score} (${ovFull}.${ovPart} ov)`;
    }

    innings.push({
      inningsNumber: Number(period),
      teamName,
      teamAbbr: tAbbr,
      score,
      batters,
      bowlers: data.bowlers,
    });
  }
  return innings;
}

/** Format innings built from rosters data as a monospace-friendly tabular scorecard */
function formatRosterScorecard(innings, matchTitle) {
  const BAT_HDR = `${'Batter'.padEnd(22)} ${'Dismissal'.padEnd(11)} ${'R'.padStart(4)} ${'B'.padStart(4)} ${'4s'.padStart(4)} ${'6s'.padStart(4)} ${'SR'.padStart(7)}`;
  const BAT_SEP = '─'.repeat(BAT_HDR.length);
  const BWL_HDR = `${'Bowler'.padEnd(22)} ${'O'.padStart(5)} ${'R'.padStart(4)} ${'W'.padStart(4)} ${'Econ'.padStart(6)}`;
  const BWL_SEP = '─'.repeat(BWL_HDR.length);

  const lines = [`📋 Scorecard — ${matchTitle}`];

  for (const inns of innings) {
    lines.push('');
    lines.push(`━━ ${inns.teamAbbr} — ${inns.score} ━━`);
    lines.push('');
    lines.push(BAT_HDR);
    lines.push(BAT_SEP);

    for (const p of inns.batters) {
      const suffix = [p.isCap ? '(c)' : '', p.isWK ? '(wk)' : ''].filter(Boolean).join('');
      const label = (p.name + (suffix ? ' ' + suffix : '')).slice(0, 22).padEnd(22);
      const dis = (p.dismissal || 'not out').slice(0, 11).padEnd(11);
      lines.push(
        `${label} ${dis} ` +
        `${String(p.runs).padStart(4)} ${String(p.balls).padStart(4)} ` +
        `${String(p.fours).padStart(4)} ${String(p.sixes).padStart(4)} ${String(p.sr).padStart(7)}`
      );
    }

    if (inns.bowlers.length) {
      lines.push('');
      lines.push(BWL_HDR);
      lines.push(BWL_SEP);
      // Sort by overs bowled descending so primary bowlers appear first
      const sortedBowlers = [...inns.bowlers].sort((a, b) => parseFloat(b.overs) - parseFloat(a.overs));
      for (const p of sortedBowlers) {
        lines.push(
          `${p.name.padEnd(22)} ${String(p.overs).padStart(5)} ` +
          `${String(p.runs).padStart(4)} ${String(p.wickets).padStart(4)} ${String(p.econ).padStart(6)}`
        );
      }
    }
  }

  return lines.join('\n');
}

/** Format batting + bowling innings block as text (tabular format) */
function formatScorecardText(innings, matchTitle, competitors = []) {
  const BAT_HDR = `${'Batter'.padEnd(20)} ${'Dismissal'.padEnd(14)} ${'R'.padStart(4)} ${'B'.padStart(4)} ${'4s'.padStart(4)} ${'6s'.padStart(4)} ${'SR'.padStart(7)}`;
  const BAT_SEP = '─'.repeat(BAT_HDR.length);
  const BWL_HDR = `${'Bowler'.padEnd(20)} ${'O'.padStart(5)} ${'R'.padStart(4)} ${'W'.padStart(4)} ${'Econ'.padStart(6)}`;
  const BWL_SEP = '─'.repeat(BWL_HDR.length);

  const lines = [`📋 Scorecard — ${matchTitle}`];

  // Build a set of abbreviations already covered by real matchcard innings
  // (teamName in matchcards is usually an abbreviation like "CSK")
  const coveredAbbrs = new Set(
    Object.values(innings)
      .map(i => { const n = i.teamName || ''; return TEAM_NAME_MAP[n] || n; })
      .filter(Boolean)
  );

  // If a competitor's team has no real innings entry (ESPN matchcards lag behind on
  // match end), add a placeholder so at least their final total is visible.
  for (const comp of competitors) {
    const name = comp.team?.displayName || comp.displayName || '';
    const abbr = TEAM_NAME_MAP[name] || teamAbbr(name) || name;
    if (abbr && !coveredAbbrs.has(abbr) && comp.score) {
      const placeholderKey = `0_${name}`; // sorts before numeric inningsNumber keys
      innings[placeholderKey] = {
        teamName: name,
        placeholder: true,
        score: comp.score,
      };
    }
  }

  for (const [, inns] of Object.entries(innings).sort()) {
    lines.push('');
    if (inns.placeholder) {
      lines.push(`━━ ${inns.teamName} — ${inns.score} ━━`);
      lines.push(`(Detailed scorecard loading…)`);
      continue;
    }

    const mc = inns.batting;
    if (!mc) continue;

    lines.push(`━━ ${mc.teamName} — ${mc.runs ?? '?'} ${mc.total ?? ''} ━━`);
    lines.push('');
    lines.push(BAT_HDR);
    lines.push(BAT_SEP);

    for (const p of mc.playerDetails.filter(p => p.runs !== '')) {
      const dis = (p.dismissal || 'not out').slice(0, 14);
      const sr = p.ballsFaced > 0
        ? ((p.runs / p.ballsFaced) * 100).toFixed(1)
        : '-';
      lines.push(
        `${p.playerName.padEnd(20)} ${dis.padEnd(14)} ` +
        `${String(p.runs).padStart(4)} ${String(p.ballsFaced).padStart(4)} ` +
        `${String(p.fours).padStart(4)} ${String(p.sixes).padStart(4)} ${String(sr).padStart(7)}`
      );
    }

    if (mc.extras) lines.push(`Extras: ${mc.extras}`);

    if (inns.bowling) {
      lines.push('');
      lines.push(BWL_HDR);
      lines.push(BWL_SEP);
      for (const p of inns.bowling.playerDetails) {
        lines.push(
          `${p.playerName.padEnd(20)} ${String(p.overs).padStart(5)} ` +
          `${String(p.conceded).padStart(4)} ${String(p.wickets).padStart(4)} ${String(p.economyRate).padStart(6)}`
        );
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

/** Helper to parse "180/5" or "180" into {runs, wickets} */
function parseRunsWickets(teamSummary) {
  if (!teamSummary) return { runs: 0, wickets: 0 };

  // 1. Priority: Explicit runs and wickets from linescores
  if (teamSummary.runs !== undefined) {
    return { runs: teamSummary.runs, wickets: teamSummary.wickets || 0 };
  }

  const scoreStr = String(teamSummary.score || "");
  const cleaned = scoreStr.split('(')[0].trim(); // remove (20 ov) parts
  const parts = cleaned.split('/');

  const runs = parseInt(parts[0]) || 0;
  let wickets = parseInt(parts[1]) || (scoreStr.toLowerCase().includes('all out') ? 10 : 0);

  // Use explicit wickets from API if provided
  if (teamSummary.wickets !== undefined && teamSummary.wickets !== null) {
    wickets = parseInt(teamSummary.wickets);
  }

  return { runs, wickets };
}

/** Helper to parse overs for a team from various sources in ESPN summary */
function parseOversNew(teamSummary, status) {
  // 1. Use balls count from rosters (most accurate structured data)
  if (teamSummary.balls !== undefined && teamSummary.balls !== null && teamSummary.balls > 0) {
    const overs = Math.floor(teamSummary.balls / 6) + (teamSummary.balls % 6) / 10;
    return Math.min(20.0, overs);
  }

  // 2. Use explicit overs from linescore API
  if (teamSummary.overs !== undefined && teamSummary.overs !== null) {
    return Math.min(20.0, teamSummary.overs);
  }

  // 3. Try to parse from the score string itself if it has "(19.2 ov)"
  const scoreStr = String(teamSummary.score || "");
  const scoreMatch = scoreStr.match(/\(([\d\.]+)\s*ov\)/i);
  if (scoreMatch && scoreMatch[1]) {
    const val = parseFloat(scoreMatch[1]);
    if (val > 0 && val <= 20) return val;
  }

  // 4. Fallback to status regex (more specific to avoid team name parentheticals)
  if (status && teamSummary.short) {
    const regex = new RegExp(teamSummary.short + '\\s+\\d+[^\\(]*\\(([\\d\\.]+)', 'i');
    const match = status.match(regex);
    if (match && match[1]) {
      const val = parseFloat(match[1]);
      if (val > 0 && val <= 20.0) return val;
    }
  }

  return 20.0;
}

/** Backfill match_scores table for all matches with ESPN IDs */
async function backfillMatchScores() {
  console.log('[Scores] Starting dynamic backfill (no truncate, throttled)...');
  try {
    const matchesToBackfill = await query(`
      SELECT id AS match_id, espn_event_id, team1 AS t1_local, team2 AS t2_local
      FROM matches
      WHERE espn_event_id IS NOT NULL
    `);

    if (matchesToBackfill.length === 0) {
      console.log('[Scores] No matches to refill.');
      return;
    }

    console.log(`[Scores] Attempting to refill ${matchesToBackfill.length} matches...`);
    for (const matchRow of matchesToBackfill) {
      try {
        console.log(`[Scores] Fetching data for ${matchRow.match_id} (ESPN: ${matchRow.espn_event_id})...`);
        const summary = await fetchESPNSummary(matchRow.espn_event_id);

        if (!summary) {
          console.log(`[Scores] ⚠️ No data for ${matchRow.match_id}`);
          continue;
        }

        const s1 = parseRunsWickets(summary.team1);
        const s2 = parseRunsWickets(summary.team2);
        const ov1 = parseOversNew(summary.team1, summary.status);
        const ov2 = parseOversNew(summary.team2, summary.status);

        let team1Data = { runs: s1.runs, wickets: s1.wickets, overs: ov1, short: summary.team1.short };
        let team2Data = { runs: s2.runs, wickets: s2.wickets, overs: ov2, short: summary.team2.short };

        if (summary.team1.short !== matchRow.t1_local && summary.team2.short === matchRow.t1_local) {
          team1Data = { runs: s2.runs, wickets: s2.wickets, overs: ov2, short: summary.team2.short };
          team2Data = { runs: s1.runs, wickets: s1.wickets, overs: ov1, short: summary.team1.short };
        }

        await query(`
          INSERT INTO match_scores (
            match_id, team1, team1_runs, team1_overs, team1_wickets,
            team2, team2_runs, team2_overs, team2_wickets
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (match_id) DO UPDATE SET
            team1_runs = EXCLUDED.team1_runs, team1_overs = EXCLUDED.team1_overs, team1_wickets = EXCLUDED.team1_wickets,
            team2_runs = EXCLUDED.team2_runs, team2_overs = EXCLUDED.team2_overs, team2_wickets = EXCLUDED.team2_wickets
        `, [
          matchRow.match_id,
          team1Data.short, team1Data.runs, team1Data.overs, team1Data.wickets,
          team2Data.short, team2Data.runs, team2Data.overs, team2Data.wickets
        ]);
        
        console.log(`[Scores] ✅ Successfully saved ${matchRow.match_id}`);
        await new Promise(r => setTimeout(r, 250)); // Throttling to prevent API blocks
      } catch (e) {
        console.error(`[Scores] ❌ Error on ${matchRow.match_id}:`, e.message);
      }
    }
    console.log('[Scores] Dynamic backfill complete.');
  } catch (err) {
    console.error('[Scores] ❌ Global refill failure:', err.message);
  }
}

async function checkRecentMatches(isManual = false) {
  try {
    const now = new Date();
    const nowMs = now.getTime();

    const existingResults = await query("SELECT match_id FROM results");
    const existingIds = new Set(existingResults.map((r) => r.match_id));

    // Skip if every match at or before now already has a result
    const needResultSync = matchesCache.some((m) => {
      const startTime = new Date(`${m.date}T${m.time}:00+05:30`);
      return nowMs >= startTime.getTime() && !existingIds.has(m.id);
    });
    if (!needResultSync) return { updated: 0, checked: 0 };

    // Candidate matches: manual = any time after start; auto only in [start+4h, start+6h]
    const pendingMatches = matchesCache.filter((m) => {
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
    const notFoundOnESPN = [];
    const stillInProgress = [];

    for (const match of toCheck) {
      // Use espn_event_id directly via the summary endpoint
      const espnId = matchESPNIdMap.get(match.id);
      if (!espnId) {
        console.log(`❓ AutomatedResultService: No ESPN ID for ${match.id} (${match.team1} vs ${match.team2}), skipping`);
        notFoundOnESPN.push(`${match.team1} vs ${match.team2}`);
        continue;
      }

      console.log(`🔍 AutomatedResultService: Fetching summary for ${match.id} (event ${espnId})`);
      const summary = await fetchESPNSummary(espnId);
      if (!summary) {
        console.log(`❓ AutomatedResultService: Summary unavailable for ${match.id} (event ${espnId})`);
        notFoundOnESPN.push(`${match.team1} vs ${match.team2}`);
        continue;
      }

      const status = summary.status || "";
      const state = summary.state || "pre";

      const stateDone =
        state === 'post' ||
        /won by|match abandoned/i.test(status);

      if (stateDone) {
        const winner = parseWinnerFromStatus(status, match.team1, match.team2) ||
          (summary.winnerName ? (TEAM_NAME_MAP[summary.winnerName] || null) : null);
        if (winner) {
          const scoreSummary = summary.status || null; // e.g. "Rajasthan Royals won by 1 run"
          const toss = summary.toss || null;
          const matchDetails = {
            espnEventId: espnId,
            team1: summary.team1,
            team2: summary.team2,
            state,
            status,
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

          // Populate structured match_scores table
          try {
            const rosters = summary.lineups || []; // summary contains lineups from fetchESPNSummary
            // Re-fetch with scorecard if needed, but summary usually has enough for NRR if we parse it
            const s1 = parseRunsWickets(summary.team1);
            const s2 = parseRunsWickets(summary.team2);

            const ov1 = parseOversNew(summary.team1, summary.status);
            const ov2 = parseOversNew(summary.team2, summary.status);

            await query(`
                 INSERT INTO match_scores (
                   match_id, team1, team1_runs, team1_overs, team1_wickets,
                   team2, team2_runs, team2_overs, team2_wickets
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (match_id) DO UPDATE SET
                   team1_runs = EXCLUDED.team1_runs, team1_overs = EXCLUDED.team1_overs, team1_wickets = EXCLUDED.team1_wickets,
                   team2_runs = EXCLUDED.team2_runs, team2_overs = EXCLUDED.team2_overs, team2_wickets = EXCLUDED.team2_wickets
               `, [
              match.id,
              summary.team1.short, s1.runs, ov1, s1.wickets,
              summary.team2.short, s2.runs, ov2, s2.wickets
            ]);
          } catch (e) {
            console.error(`[Scores] Failed to populate match_scores for ${match.id}:`, e.message);
          }

          await query("DELETE FROM chat_messages WHERE match_id = $1", [match.id]);
          updatedCount++;
          invalidateResultsCache();
          io.emit('result_updated', { matchId: match.id, winner });

          // Push notification to all subscribed users
          let pushTitle, pushBody;
          if (winner === 'nr') {
            pushTitle = '🌧️ Match Abandoned';
            pushBody = `${match.team1} vs ${match.team2} — No Result`;
          } else if (winner === 'draw') {
            pushTitle = '🤝 It\'s a Tie!';
            pushBody = `${match.team1} vs ${match.team2}`;
          } else {
            pushTitle = `🏆 ${winner} Won!`;
            pushBody = scoreSummary || `${match.team1} vs ${match.team2}`;
          }
          broadcastPush({ title: pushTitle, body: pushBody, icon: '/favicon.ico', tag: `result_${match.id}`, data: { url: `/poll/${match.id}` } })
            .catch(e => console.error('[Push] Broadcast failed:', e.message));

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
        stillInProgress.push(`${match.team1} vs ${match.team2}`);
      }
    }

    return { updated: updatedCount, checked: toCheck.length, notFound: notFoundOnESPN, inProgress: stillInProgress };

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

// ─── Vote Reminder: push to users who haven't voted 30 min before match ──────
const voteReminderSent = new Set(); // matchId — prevent duplicate reminders
setInterval(async () => {
  if (!VAPID_PUBLIC_KEY) return;
  try {
    const now = new Date();
    const completedIds = await getCachedCompletedIds();
    for (const match of matchesCache) {
      if (completedIds.has(match.id) || voteReminderSent.has(match.id)) continue;
      const startTime = new Date(`${match.date}T${match.time}:00+05:30`);
      const diffMs = startTime.getTime() - now.getTime();
      // Window: 25–35 min before start
      if (diffMs >= 25 * 60 * 1000 && diffMs <= 35 * 60 * 1000) {
        voteReminderSent.add(match.id);
        const voted = await query('SELECT DISTINCT user_id FROM votes WHERE match_id = $1', [match.id]);
        const votedIds = new Set(voted.map(r => r.user_id));
        const allSubs = await query('SELECT DISTINCT user_id FROM push_subscriptions');
        const unvoted = allSubs.filter(s => !votedIds.has(s.user_id));
        for (const sub of unvoted) {
          sendPushToUser(sub.user_id, {
            title: '⏰ Vote before it locks!',
            body: `${match.team1} vs ${match.team2} starts in ~30 min`,
            icon: '/favicon.ico',
            tag: `reminder_${match.id}`,
            data: { url: '/' },
          }).catch(() => { });
        }
        console.log(`[Push] Vote reminder sent for match ${match.id} to ${unvoted.length} user(s)`);
        break;
      }
    }
  } catch (e) {
    console.error('[Push] Vote reminder error:', e.message);
  }
}, 60 * 1000);

// ─── Post-toss Vote Reminder: fires immediately on toss, then once more 10 min later ──
// Only targets room members who haven't voted yet (not all push subscribers).
const tossReminderState = new Map(); // matchId -> { count: number, lastSentMs: number }
setInterval(async () => {
  if (!VAPID_PUBLIC_KEY) return;
  try {
    const now = Date.now();
    const completedIds = await getCachedCompletedIds();
    for (const [matchId, detectedAt] of tossDetectedAt) {
      if (completedIds.has(matchId)) continue;

      const match = matchesCache.find(m => m.id === matchId);
      if (!match) continue;

      // Stop sending once the match starts (voting locks)
      const startTime = new Date(`${match.date}T${match.time}:00+05:30`);
      if (now >= startTime.getTime()) continue;

      const state = tossReminderState.get(matchId) || { count: 0, lastSentMs: 0 };
      if (state.count >= 2) continue;

      const TEN_MIN = 10 * 60 * 1000;
      // First reminder: fires immediately when toss is detected (no wait)
      // Second reminder: 10 min after the first
      if (state.count > 0 && (now - state.lastSentMs) < TEN_MIN) continue;

      const voted = await query('SELECT DISTINCT user_id FROM votes WHERE match_id = $1', [matchId]);
      const votedIds = new Set(voted.map(r => r.user_id));
      // Only send to room members who have push subscriptions and haven't voted
      const roomMemberSubs = await query(
        `SELECT DISTINCT ps.user_id
         FROM push_subscriptions ps
         JOIN room_members rm ON rm.user_id = ps.user_id`
      );
      const unvoted = roomMemberSubs.filter(s => !votedIds.has(s.user_id));

      if (unvoted.length === 0) {
        state.count = 2; // everyone voted, no more reminders needed
        tossReminderState.set(matchId, state);
        continue;
      }

      const minsLeft = Math.max(0, Math.round((startTime.getTime() - now) / 60000));
      const isLastReminder = state.count === 1;
      for (const sub of unvoted) {
        sendPushToUser(sub.user_id, {
          title: `🗳️ Cast your vote! ${match.team1} vs ${match.team2}`,
          body: isLastReminder
            ? `⚠️ Last chance! Match starts in ~${minsLeft} min. Vote before it locks!`
            : `Toss is done! Match starts in ~${minsLeft} min. Don't miss voting!`,
          icon: '/ipl-icon.png',
          tag: `toss_reminder_${matchId}`,
          data: { url: '/' },
        }).catch(() => { });
      }

      state.count++;
      state.lastSentMs = now;
      tossReminderState.set(matchId, state);
      console.log(`[Push] Post-toss vote reminder #${state.count}/2 for ${matchId} → ${unvoted.length} room member(s), ~${minsLeft} min to start`);
    }
  } catch (e) {
    console.error('[Push] Post-toss reminder error:', e.message);
  }
}, 60 * 1000);

// ─── Live Score Service ────────────────────────────────────────────────────

const liveScoreCache = new Map();    // ourMatchId -> LiveScorePayload
const commentaryCache = new Map();   // ourMatchId -> { espnEventId, lastId, toss, lineups, seenIds }
// lastId: null = uninitialized (skip existing items on first poll); number = last ESPN item id posted
const rainDelayState = new Map();    // ourMatchId -> { inDelay: bool, lastPostedAt: number }
const liveScoreBotState = new Map(); // ourMatchId -> { lastScore, lastPostedAt, lastWickets }
const resultTriggerSet = new Set();  // ourMatchId -> triggered (prevent duplicate auto-result triggers)
const matchESPNIdMap = new Map();    // ourMatchId -> espnEventId (loaded from DB at startup)
const tossDetectedAt = new Map();    // ourMatchId -> timestamp when toss was first detected

async function loadMatchESPNIds() {
  try {
    const rows = await query('SELECT id, espn_event_id FROM matches WHERE espn_event_id IS NOT NULL');
    for (const row of rows) matchESPNIdMap.set(row.id, row.espn_event_id);
    console.log(`[Matches] Loaded ${matchESPNIdMap.size} ESPN IDs from DB`);
  } catch (e) {
    console.error('[Matches] Could not load ESPN IDs from DB:', e.message);
  }
}

/** Sum all wickets fallen from a score string like "MI 182/5 (20) · CSK 143/6 (16.3)" */
function parseWicketsFromScore(score) {
  let total = 0;
  for (const m of (score || '').matchAll(/\/(\d+)/g)) total += parseInt(m[1]) || 0;
  return total;
}

// Stable dedup key for ESPN commentary items
function itemKey(item) {
  const primary = item.id ?? item.sequence ?? item.sequenceNumber;
  if (primary != null && String(primary) !== '') return String(primary);
  const over = item.over?.overs ?? '';
  const txt = (item.shortText || item.text || '').slice(0, 30);
  const key = `${over}_${txt}`;
  return key !== '_' ? key : null;
}

/** Unified match data poller — one /summary call per live match replaces
 *  the old /events + /playbyplay approach. Handles live scores, ball-by-ball
 *  commentary, toss announcements, rain delays, and result triggers. */
async function pollMatchData() {
  try {
    const now = new Date();
    const completedIds = await getCachedCompletedIds();

    for (const id of liveScoreCache.keys()) {
      if (completedIds.has(id)) liveScoreCache.delete(id);
    }

    // Matches within monitoring window: 90 min before start (catches toss) to 6h after start
    const liveMatches = matchesCache.filter(m => {
      const startTime = new Date(`${m.date}T${m.time}:00+05:30`);
      const preWindow = new Date(startTime.getTime() - 90 * 60 * 1000);
      const cutoff = new Date(startTime.getTime() + 6 * 60 * 60 * 1000);
      return now >= preWindow && now <= cutoff && !completedIds.has(m.id);
    });

    if (liveMatches.length === 0) return;

    const roomIds = await getCachedRoomIds();

    for (const match of liveMatches) {
      const espnId = matchESPNIdMap.get(match.id);
      if (!espnId) {
        console.log(`[Poll] No ESPN ID for ${match.id}, skipping`);
        continue;
      }

      // ── Fetch summary ───────────────────────────────────────────────────────
      let data;
      try {
        const url = `${ESPN_IPL_BASE}/summary?event=${espnId}`;
        console.log(`[ESPN] GET ${url}`);
        const resp = await axios.get(url, { timeout: 10000 });
        console.log(`[ESPN] ${resp.status} ${url}`);
        data = resp.data || {};
      } catch (e) {
        console.error(`[Poll] Fetch error for ${match.id} (event ${espnId}):`, e.message);
        continue;
      }

      // ── Scores & state ──────────────────────────────────────────────────────
      const comp = data.header?.competitions?.[0] || {};
      const competitors = comp.competitors || [];
      const c1 = competitors[0] || {};
      const c2 = competitors[1] || {};
      const t1Name = c1.team?.displayName || c1.displayName || '';
      const t2Name = c2.team?.displayName || c2.displayName || '';
      const t1Abbr = TEAM_NAME_MAP[t1Name] || c1.team?.abbreviation || teamAbbr(t1Name);
      const t2Abbr = TEAM_NAME_MAP[t2Name] || c2.team?.abbreviation || teamAbbr(t2Name);

      const scoreParts = [];
      if (c1.score) scoreParts.push(`${t1Abbr} ${c1.score}`);
      if (c2.score) scoreParts.push(`${t2Abbr} ${c2.score}`);
      const score = scoreParts.join(' · ') || null;

      const state = comp.status?.type?.state || 'pre';
      // status.summary has the human-readable result ("CSK won by 23 runs") for completed matches
      const statusSummary = comp.status?.summary || '';
      const statusDetail = comp.status?.type?.detail || comp.status?.type?.description || '';
      const statusRaw = statusSummary || statusDetail;

      // Enrich in-progress status with live run-rate info from situation
      const situation = comp.situation || {};
      const crr = situation.currentRunRate != null ? Number(situation.currentRunRate).toFixed(2) : null;
      const rrr = situation.requiredRunRate != null ? Number(situation.requiredRunRate).toFixed(2) : null;
      let status = statusRaw;
      if (state === 'in' && (crr || rrr)) {
        const rrParts = [];
        if (crr) rrParts.push(`CRR: ${crr}`);
        if (rrr) rrParts.push(`RRR: ${rrr}`);
        status = [statusRaw, rrParts.join(' · ')].filter(Boolean).join(' | ');
      }

      const matchAppearsOver = state === 'post' ||
        /won by|match abandoned|no result|tied/i.test(statusRaw);

      if (matchAppearsOver && !completedIds.has(match.id) && !resultTriggerSet.has(match.id)) {
        resultTriggerSet.add(match.id);
        console.log(`[Poll] Match ${match.id} appears over — triggering result sync`);
        checkRecentMatches(true).catch(e => console.error('[Poll] Result trigger failed:', e.message));
      }

      // ── Toss & lineups ──────────────────────────────────────────────────────
      const toss = extractTossInfoESPN(data.notes);
      const lineups = extractLineupsESPN(data.rosters, data.notes);

      if (!commentaryCache.has(match.id)) {
        commentaryCache.set(match.id, { espnEventId: espnId, lastId: null, toss: null, lineups: null, seenIds: null });
        console.log(`[Commentary] Registered match ${match.id} → ESPN ID ${espnId}`);
      }
      const cachedEntry = commentaryCache.get(match.id);
      if (toss) cachedEntry.toss = toss;
      if (lineups) cachedEntry.lineups = lineups;

      // Record the first moment toss is available (drives post-toss vote reminders)
      if (toss && !tossDetectedAt.has(match.id)) {
        tossDetectedAt.set(match.id, Date.now());
        console.log(`[Toss] Detected toss for ${match.id}: ${toss}`);
      }

      // ── Emit live_score ─────────────────────────────────────────────────────
      const payload = {
        matchId: match.id,
        team1: match.team1,
        team2: match.team2,
        score: score || null,
        status: status || null,
        toss: toss || cachedEntry.toss || null,
        updatedAt: new Date().toISOString(),
      };
      liveScoreCache.set(match.id, payload);
      io.emit('live_score', payload);
      console.log(`[LiveScore] ${match.id}: ${score || 'no score'} | ${statusRaw || 'no status'}`);

      const botEnabled = roomIds.length > 0 && await isBotEnabled(match.id);

      // ── Bot: toss announcement (fires as soon as toss is detected, before match starts) ───
      if (toss && !tossPostedSet.has(match.id) && botEnabled) {
        tossPostedSet.add(match.id);
        // Include lineups in message if already available; omit gracefully if not yet
        const tossMsg = formatTossMessage(toss, lineups || null);
        const botName = getBotName(match.id);
        for (const roomId of roomIds) await postBotMessage(roomId, match.id, tossMsg, botName);
        console.log(`[Toss] Announcement posted for ${match.id}`);

        // Push notification to all users about toss result
        if (VAPID_PUBLIC_KEY) {
          broadcastPush({
            title: `🪙 Toss: ${match.team1} vs ${match.team2}`,
            body: toss,
            icon: '/ipl-icon.png',
            tag: `toss_${match.id}`,
            data: { url: '/' },
          }).catch(e => console.error('[Push] Toss notification error:', e.message));
        }
      }

      // ── Rain / delay detection ───────────────────────────────────────────────
      const RAIN_KEYWORDS = /rain|delay|interrupt|suspend|wet outfield|bad light|pitch inspection/i;
      const isRainStatus = RAIN_KEYWORDS.test(statusRaw || '');
      const rainState = rainDelayState.get(match.id) || { inDelay: false, lastPostedAt: 0 };
      const nowMs = Date.now();

      if (isRainStatus) {
        const shouldPost = !rainState.inDelay || (nowMs - rainState.lastPostedAt > 10 * 60 * 1000);
        if (shouldPost && botEnabled) {
          const delayMsg = `🌧️ Play Interrupted!\n\n${match.team1} vs ${match.team2}\n📊 ${statusRaw}\n\nI'll resume ball-by-ball updates the moment play gets back underway! ⏸️`;
          const botName = getBotName(match.id);
          for (const roomId of roomIds) await postBotMessage(roomId, match.id, delayMsg, botName);
          rainDelayState.set(match.id, { inDelay: true, lastPostedAt: nowMs });
          console.log(`[LiveScore] Rain delay posted for match ${match.id}`);
        } else if (!rainState.inDelay) {
          rainDelayState.set(match.id, { inDelay: true, lastPostedAt: nowMs });
        }
      } else if (rainState.inDelay) {
        if (botEnabled) {
          const resumeMsg = `☀️ Play has resumed!\n\n${match.team1} vs ${match.team2} is back on! 🏏\n${score ? `📊 ${score}` : ''}\n\nBall-by-ball updates are live again! 🔥`;
          const botName = getBotName(match.id);
          for (const roomId of roomIds) await postBotMessage(roomId, match.id, resumeMsg, botName);
          console.log(`[LiveScore] Play resumed posted for match ${match.id}`);
        }
        rainDelayState.set(match.id, { inDelay: false, lastPostedAt: 0 });
      }

      // ── Ball-by-ball commentary ──────────────────────────────────────────────
      // commentaries lives at header.competitions[0].commentaries in the summary
      // response — an object keyed by numeric string ball IDs e.g. {"13030":{...}}
      const commObj = data.header?.competitions?.[0]?.commentaries || {};
      // Only include real ball deliveries (over.overs > 0); overs=0 items are between-innings placeholders
      const commItems = Object.values(commObj).filter(i => i.over && Number(i.over.overs) > 0);

      if (!cachedEntry.seenIds) cachedEntry.seenIds = new Set();

      if (cachedEntry.lastId === null) {
        // First poll: log structure, seed existing items as seen without posting
        console.log(`[Commentary] ESPN summary keys=${JSON.stringify(Object.keys(data))} items=${commItems.length} match=${match.id}`);
        if (commItems[0]) console.log(`[Commentary] First item sample: ${JSON.stringify(commItems[0]).slice(0, 400)}`);
        for (const item of commItems) { const k = itemKey(item); if (k) cachedEntry.seenIds.add(k); }
        cachedEntry.lastId = 0;
        console.log(`[Commentary] Initialized match ${match.id}: ${cachedEntry.seenIds.size} existing balls seeded`);
        continue;
      }

      if (!botEnabled || commItems.length === 0) continue;

      const newItems = commItems
        .filter(item => { const k = itemKey(item); return k && !cachedEntry.seenIds.has(k); })
        .sort((a, b) => {
          const na = Number(a.id ?? a.sequenceNumber ?? 0);
          const nb = Number(b.id ?? b.sequenceNumber ?? 0);
          if (!isNaN(na) && !isNaN(nb) && na !== 0 && nb !== 0) return na - nb;
          return (a.over?.overs ?? 0) - (b.over?.overs ?? 0);
        });

      if (newItems.length > 0) {
        const botName = getBotName(match.id);
        let posted = 0;
        for (const item of newItems) {
          const k = itemKey(item);
          if (k) cachedEntry.seenIds.add(k);
          const msg = formatESPNCommentaryItem(item, score);
          if (!msg) continue;
          for (const roomId of roomIds) await postBotMessage(roomId, match.id, msg, botName);
          posted++;
        }
        if (posted > 0) console.log(`[Commentary] Posted ${posted} ball(s) for match ${match.id}`);
      }
    }
  } catch (err) {
    console.error('[Poll] Error:', err.message);
  }
}

setInterval(pollMatchData, 5 * 1000);
setTimeout(pollMatchData, 10000); // 10s after startup

app.get('/api/live-score', asyncRoute(async (req, res) => {
  res.json(Object.fromEntries(liveScoreCache));
}));

app.get('/api/matches', asyncRoute(async (req, res) => {
  res.json(matchesCache);
}));

app.post('/api/admin/sync-schedule', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const result = await syncMatchesFromESPN();
  res.json(result);
}));

// ─── Chatbot System ────────────────────────────────────────────────────────

function getBotName(_matchId) {
  return 'Kira';
}

function getBotIntro(botName, matchId) {
  const match = matchesCache.find(m => m.id === matchId);
  const t1 = match?.team1 || '?';
  const t2 = match?.team2 || '?';
  const idx = matchesCache.findIndex(m => m.id === matchId);
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
  const matchInfo = matchesCache.find(m => m.id === matchId);
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
  const match = matchesCache.find(m => m.id === matchId);
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


async function fetchLatestBallData(matchId) {
  const cached = commentaryCache.get(matchId);
  if (!cached?.espnEventId) return null;
  try {
    const url = `${ESPN_IPL_BASE}/summary?event=${cached.espnEventId}`;
    console.log(`[ESPN] GET ${url} (fetchLatestBallData)`);
    const resp = await axios.get(url, { timeout: 8000 });
    console.log(`[ESPN] ${resp.status} ${url}`);
    const data = resp.data || {};
    const comp = data.header?.competitions?.[0] || {};
    const situation = comp.situation || {};

    // Most recent ball from commentaries (sorted newest-first by id)
    // Filter: only real deliveries (over.overs > 0); overs=0 items are between-innings placeholders
    const commObj = comp.commentaries || {};
    const commItems = Object.values(commObj).filter(i => i.over && Number(i.over.overs) > 0);
    commItems.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    const latest = commItems[0] || null;

    // Build miniscore from competitors linescores
    const competitors = comp.competitors || [];
    const battingComp = competitors.find(c => c.linescores?.[0]?.isBatting) || competitors[0];
    const lscore = battingComp?.linescores?.[0];
    const runs = lscore?.runs ?? null;
    const wickets = lscore?.wickets ?? 0;
    const overs = lscore?.overs ?? null;
    const target = (lscore?.target > 0) ? lscore.target : null;
    const teamAbbr = battingComp?.team?.abbreviation || battingComp?.team?.displayName || '';

    // CRR: prefer situation field; fall back to runs / overs
    let crr = situation.currentRunRate != null ? Number(situation.currentRunRate).toFixed(2) : null;
    if (!crr && runs != null && overs && Number(overs) > 0) {
      crr = (runs / Number(overs)).toFixed(2);
    }
    // RRR: prefer situation; fall back to calculation if target known
    let rrr = situation.requiredRunRate != null ? Number(situation.requiredRunRate).toFixed(2) : null;
    if (!rrr && target && runs != null && overs != null) {
      const ballsBowled = Math.round(Number(overs) * 6);
      const ballsLeft = 120 - ballsBowled;
      if (ballsLeft > 0) {
        rrr = (((target - runs) / ballsLeft) * 6).toFixed(2);
      }
    }
    const remBalls = situation.remainingBalls ?? null;

    const miniscore = runs != null ? {
      batTeam: { teamSName: teamAbbr, score: `${runs}/${wickets}`, wickets, overs: overs ?? '?' },
      currentRunRate: crr,
      requiredRunRate: rrr,
      target,
      remBalls,
    } : null;

    return { latest, miniscore, commentary: commItems };
  } catch (e) {
    console.error('[fetchLatestBallData] Error:', e.message);
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
  const matchInfo = matchesCache.find(m => m.id === matchId);
  const t1 = matchInfo?.team1 || 'Team 1';
  const t2 = matchInfo?.team2 || 'Team 2';

  // Check if this is a completed match
  const completedResult = await queryOne(
    'SELECT winner, score_summary, toss, details FROM results WHERE match_id = $1', [matchId]
  );
  const isCompleted = !!completedResult;

  // Match has started if the live score cache has a score entry for it
  const hasFirstBall = !!liveData?.score;

  const matchStart = matchInfo
    ? new Date(`${matchInfo.date}T${matchInfo.time || '19:30'}:00+05:30`)
    : null;

  // isNotStarted: match not completed AND no live score yet
  const isNotStarted = !isCompleted && !hasFirstBall;
  // isDelayed: scheduled time has passed but still no live score
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
      const batter = ball?.batsman;
      if (!batter?.athlete?.name) {
        reply = liveData?.score
          ? `🏏 Batting info not available right now. Score: ${liveData.score}`
          : `No live match data yet, ${askerUsername}!`;
      } else {
        const batterName = espnPlayerName(batter.athlete);
        let msg = `🏏 At the Crease\n\n`;
        msg += `⚡ *Striker:* ${batterName} — ${batter.totalRuns ?? 0}* off ${batter.faced ?? 0}`;
        const nsBatter = ball.otherBatsman;
        if (nsBatter?.athlete?.name) {
          msg += `\n🔄 *Non-striker:* ${espnPlayerName(nsBatter.athlete)} — ${nsBatter.totalRuns ?? 0}* off ${nsBatter.faced ?? 0}`;
        }
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
      const bowler = ball?.bowler;
      if (!bowler?.athlete?.name) {
        reply = `Bowling info not available right now, ${askerUsername}!`;
      } else {
        const bowlerName = espnPlayerName(bowler.athlete);
        const curOver = ball.over?.overs ?? '?';
        reply = `⚾ Current Bowler\n\n${bowlerName} — ${curOver} ov, ${bowler.conceded ?? 0} runs, ${bowler.wickets ?? 0} wkts`;
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
      const HDR = `${'#'.padEnd(2)}  ${'Player'.padEnd(16)}  ${'Pts'.padStart(3)}  ${'✓'.padStart(3)}  ${'Voted'.padStart(5)}`;
      const SEP = '─'.repeat(HDR.length);
      const rows = top5.map((r, i) =>
        `${medals[i].padEnd(2)}  ${r.username.slice(0, 16).padEnd(16)}  ` +
        `${String(r.points).padStart(3)}  ${String(r.correct).padStart(3)}  ${String(r.voted).padStart(5)}`
      );
      reply = `🏆 Room Leaderboard (Top 5)\n\n${HDR}\n${SEP}\n${rows.join('\n')}`;
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
                content: `You are Kira — a sharp, funny, and completely neutral cricket analyst in this IPL chatroom.

PERSONALITY:
- You have no favourite team. You roast ALL teams equally and fairly.
- You love cricket and give honest, data-driven takes. No bias, no fan loyalty.
- You appreciate good cricket wherever it comes from — great bowling, smart batting, clutch moments.
- You're funny and sarcastic but fair. If CSK plays well, credit them. If RCB collapses, roast them. Same rule for every team.
- You find team loyalties amusing and gently poke fun at all fanbases equally.

STYLE:
- Talk like a knowledgeable friend in a WhatsApp group — casual, punchy, cricket-aware.
- Use cricket slang and stats where relevant. Keep responses under 3 sentences.
- Never say "As an AI" or "I'm here to help". Just chat like a match analyst friend.
- Trash talk is fine but must be equal-opportunity — no team gets a free pass.
- When asked about match data, use the context but add your own witty, unbiased take.

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
      reply = isCompleted
        ? `Couldn't load scorecard — ESPN match data not available for this match.`
        : `Scorecard isn't available yet — match hasn't started! 🏏`;
    } else {
      try {
        const { innings, status, competitors, rosters } = await fetchESPNScorecard(espnId);
        const title = `${t1} vs ${t2}${status ? ' — ' + status : ''}`;

        // Prefer rosters-based scorecard — always has up-to-date final stats
        // for both innings and never shows stale mid-innings data.
        const rosterInnings = buildScorecardFromRosters(rosters, competitors);
        if (rosterInnings.length > 0) {
          reply = formatRosterScorecard(rosterInnings, title);
        } else if (!Object.keys(innings).length && !competitors.length) {
          reply = `No scorecard data yet. Check back once the first ball is bowled! 🏏`;
        } else {
          reply = formatScorecardText(innings, title, competitors);
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

/** Format a single ESPN playbyplay item into a ball-by-ball chat message.
 *  Field names verified against live ESPN cricket API (/playbyplay?event=1527689).
 *
 *  Actual playType.description values:
 *    "out"    → wicket  |  "four"   → boundary four
 *    "run"    → runs    |  "no run" → dot ball
 *    "wide"   → wide    |  "bye"    → bye
 *    "no ball"→ no ball
 *  Sixes have playType="run" with scoreValue=6 (no dedicated "six" type).
 *  Batter/bowler names are at athlete.name — shortName does not exist.
 */
/**
 * Convert full player name → "F LastName" format (e.g. "Virat Kohli" → "V Kohli").
 * Falls back to shortName if available, or the full name if single word.
 * Verified field paths from ESPN playbyplay API (event 1527689):
 *   athlete.shortName  – "Kohli" / "Archer"
 *   athlete.name       – "Virat Kohli" / "Jofra Archer"
 */
function espnPlayerName(athlete) {
  if (!athlete) return null;
  const full = (athlete.name || '').trim();
  if (!full) return null;
  const parts = full.split(/\s+/);
  if (parts.length === 1) return parts[0];
  // "Virat Kohli" → "V Kohli", "Jasprit Bumrah" → "J Bumrah"
  return `${parts[0][0]} ${parts.slice(1).join(' ')}`;
}

/**
 * Format a single ESPN playbyplay commentary item into a ball-by-ball chat message.
 *
 * Verified field paths from live API (event 1527689, IPL 2026):
 *   over.overs            – decimal over notation (0.2, 5.3 …)
 *   playType.description  – "no run" | "out" | "four" | "run" | "wide" | "bye"
 *   scoreValue            – runs scored; sixes have playType="run" + scoreValue=6
 *   dismissal.dismissal   – boolean, true on a wicket ball
 *   batsman.athlete.name  – full batter name
 *   batsman.totalRuns     – batter runs scored so far
 *   batsman.faced         – balls faced so far
 *   bowler.athlete.name   – full bowler name
 *   bowler.wickets        – wickets taken in this innings
 *   bowler.conceded       – runs conceded in this innings
 *   homeScore             – batting team score string e.g. "0/1"
 *   awayScore             – fielding team score string e.g. "0"
 *   shortText             – "Archer to Padikkal, no run"  (line 4)
 *   text                  – HTML commentary text          (line 5)
 */
function formatESPNCommentaryItem(item, matchScore) {
  // ── Line 1: Over • Event ─────────────────────────────────────────────────
  const overOvers = item.over?.overs;
  const overStr = overOvers != null ? `Over ${overOvers}` : null;

  const typeDesc = (item.playType?.description || '').toLowerCase();
  const shortTextLow = (item.shortText || '').toLowerCase();
  const scoreVal = Number(item.scoreValue ?? 0);

  const isWicket = item.dismissal?.dismissal === true || typeDesc === 'out';
  const isSix = scoreVal === 6;
  const isFour = typeDesc === 'four' || scoreVal === 4;
  // summary API has no playType — fall back to shortText for wide / no-ball
  const isWide = typeDesc === 'wide' || shortTextLow.includes('wide');
  const isNoBall = typeDesc === 'no ball' || typeDesc === 'noball' || shortTextLow.includes('no ball');
  const isDot = typeDesc === 'no run' ||
    (!isWicket && !isSix && !isFour && !isWide && !isNoBall && scoreVal === 0);

  let eventLabel;
  if (isWicket) eventLabel = '❌ WICKET!';
  else if (isSix) eventLabel = '🚀 SIX!';
  else if (isFour) eventLabel = '💥 FOUR!';
  else if (isWide) eventLabel = '↔️ Wide';
  else if (isNoBall) eventLabel = '⚠️ No Ball';
  else if (isDot) eventLabel = '⬛ Dot';
  else eventLabel = `+${scoreVal}`;

  const line1 = [overStr, eventLabel].filter(Boolean).join('  •  ');
  if (!line1) return null;

  // ── Line 2: 🏏 V Kohli 34(22)   ⚾ J Bumrah 2/28 ─────────────────────────
  const batter = espnPlayerName(item.batsman?.athlete);
  const batterRuns = item.batsman?.totalRuns ?? 0;
  const batterBalls = item.batsman?.faced ?? 0;

  const bowler = espnPlayerName(item.bowler?.athlete);
  const bowlerWkts = item.bowler?.wickets ?? 0;
  const bowlerRuns = item.bowler?.conceded ?? 0;

  const battingStr = batter ? `🏏 ${batter} ${batterRuns}(${batterBalls})` : null;
  const bowlingStr = bowler ? `⚾ ${bowler} ${bowlerWkts}/${bowlerRuns}` : null;
  const line2 = [battingStr, bowlingStr].filter(Boolean).join('   ');

  // ── Line 3: 📊 score ─────────────────────────────────────────────────────
  // Prefer the live score cache value; fall back to homeScore/awayScore on the item
  let line3 = '';
  if (matchScore) {
    // Replace the overs count in the score string with the ball's exact position.
    // ESPN's competitors[i].score shows completed overs (e.g. "2/20 ov") while
    // the ball itself knows it's at over 2.1 — so we patch it in.
    const fixedScore = overOvers != null
      ? matchScore.replace(/\(([\d.]+)\/([\d]+) ov/, `(${overOvers}/$2 ov`)
      : matchScore;
    line3 = `📊 ${fixedScore}`;
  } else if (item.homeScore || item.awayScore) {
    const parts = [item.homeScore, item.awayScore].filter(Boolean);
    line3 = `📊 ${parts.join(' · ')}`;
  } else if (item.innings?.totalRuns != null) {
    const abbr = item.team?.abbreviation || item.team?.name || '';
    line3 = `📊 ${abbr} ${item.innings.totalRuns}/${item.innings.wickets ?? 0} (${overOvers ?? '?'} ov)`;
  }

  // ── Lines 4-5: "Archer to Padikkal, no run" + stripped HTML commentary ──
  const shortText = (item.shortText || '').trim();
  const commText = (item.text || '').replace(/<[^>]+>/g, '').trim();

  const textParts = [];
  if (shortText) textParts.push(shortText);
  if (commText && commText !== shortText) textParts.push(commText);

  return [line1, line2, line3, textParts.join('\n')].filter(Boolean).join('\n');
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

  // Over + ball number
  const overStr = (ball.oversNum != null && ball.ballNbr != null)
    ? `${ball.oversNum}.${ball.ballNbr}`
    : null;

  // Must have at least over info or text to be worth posting
  if (!overStr && !text) return null;

  // Event emoji/label
  let eventLabel = '';
  if (event === 'WICKET') eventLabel = '❌ WICKET!';
  else if (runs === '6' || event === 'SIX') eventLabel = '🚀 SIX!';
  else if (runs === '4' || event === 'BOUNDARY' || event === 'FOUR') eventLabel = '💥 FOUR!';
  else if (event === 'WIDE') eventLabel = '↔️ Wide';
  else if (event === 'NO_BALL') eventLabel = '⚠️ No Ball';
  else if (runs === '0') eventLabel = '⬛ Dot';
  else eventLabel = `+${runs}`;

  // Line 1: Over + event
  const line1 = [overStr ? `Over ${overStr}` : null, eventLabel].filter(Boolean).join('  •  ');

  // Line 2: 🏏 Batter runs(balls)   ⚾ Bowler wkts/runs
  const batter = ball.batsmanStriker;
  const bowler = ball.bowlerStriker;
  let line2 = '';
  if (batter || bowler) {
    const batterStr = batter
      ? `🏏 ${batter.batName} ${batter.batRuns ?? 0}(${batter.batBalls ?? 0})`
      : null;
    const bowlerStr = bowler
      ? `⚾ ${bowler.bowlName} ${bowler.bowlWkts ?? 0}/${bowler.bowlRuns ?? 0}`
      : null;
    line2 = [batterStr, bowlerStr].filter(Boolean).join('   ');
  }

  // Line 3: Team score
  let line3 = '';
  if (matchScore) {
    line3 = `📊 ${matchScore}`;
  }

  // Line 4: Commentary text
  const line4 = text;

  return [line1, line2, line3, line4].filter(Boolean).join('\n');
}

// pollCommentary removed — commentary is now handled inside pollMatchData
// using the /summary endpoint which returns both scores and ball-by-ball items.

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

app.post('/api/admin/push/broadcast', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });

  await broadcastPush({
    title,
    body,
    icon: '/ipl-icon.png',
    data: { url: '/' },
  });

  res.json({ ok: true });
}));

app.post('/api/admin/push/send', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { userIds, title, body } = req.body;
  if (!Array.isArray(userIds) || !title || !body) {
    return res.status(400).json({ error: 'userIds (array), title, and body are required' });
  }

  const payload = {
    title,
    body,
    icon: '/ipl-icon.png',
    tag: 'admin_notification',
    data: { url: '/' },
  };

  for (const userId of userIds) {
    sendPushToUser(userId, payload).catch(e => console.error(`[Push] Failed for ${userId}:`, e.message));
  }

  res.json({ ok: true });
}));

app.post('/api/admin/push/remind-voters', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const results = await query('SELECT match_id, winner FROM results');
  const resultsMap = {};
  results.forEach(r => { resultsMap[r.match_id] = r; });

  const overridesRows = await query('SELECT match_id, manual_locked, lock_delay FROM match_overrides');
  const overridesMap = {};
  overridesRows.forEach(o => { overridesMap[o.match_id] = o; });

  const openMatches = getPollOpenMatches(matchesCache, resultsMap, overridesMap);
  if (openMatches.length === 0) return res.json({ ok: true, sentCount: 0, message: 'No open polls found' });

  const openMatchIds = openMatches.map(m => m.id);

  // Find users who have NOT voted in AT LEAST ONE of these open matches, and have push subscriptions
  const usersToRemind = await query(`
    SELECT DISTINCT ps.user_id
    FROM push_subscriptions ps
    WHERE ps.user_id NOT IN (
      SELECT DISTINCT user_id
      FROM votes
      WHERE match_id = ANY($1)
    )
  `, [openMatchIds]);

  if (usersToRemind.length === 0) return res.json({ ok: true, sentCount: 0, message: 'Everyone has already voted' });

  for (const user of usersToRemind) {
    await sendPushToUser(user.user_id, {
      title: '🏏 Don\'t miss your vote!',
      body: `Today's IPL polls are LIVE! Place your prediction now and climb the leaderboard! 🏆`,
      icon: '/ipl-icon.png',
      data: { url: '/' },
    });
  }

  res.json({ ok: true, sentCount: usersToRemind.length });
}));

app.post('/api/push/test', authMiddleware, asyncRoute(async (req, res) => {
  const subs = await query('SELECT id FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
  if (subs.length === 0) return res.status(400).json({ error: 'No subscriptions found for your account' });
  await sendPushToUser(req.user.id, {
    title: '🏏 Test notification',
    body: 'Push notifications are working!',
    icon: '/ipl-icon.png',
    data: { url: '/' },
  });
  res.json({ ok: true, subscriptions: subs.length });
}));

app.get("/api/debug/m01", asyncRoute(async (req, res) => {
  const row = await queryOne('SELECT * FROM match_scores WHERE match_id = $1', ['m01']);
  res.json(row || { error: "Match m01 not found in match_scores table" });
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

app.post('/api/admin/refresh-scores', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  console.log('[Admin] Score refresh triggered by', req.user.username);
  // Run backfill in background so we don't time out the request
  backfillMatchScores().catch(e => console.error('[Scores] Manual refresh failed:', e.message));
  res.json({ ok: true, message: 'Score refresh started in background' });
}));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[Error]', err.stack);
  res.status(500).json({ error: "Internal server error" });
});

initDb()
  .then(async () => {
    await loadMatchESPNIds();
    await initVapid();
    await backfillMatchScores();
    server.listen(PORT, () => {
      console.log(`IPL Predictor API with Chat running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
