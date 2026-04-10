# IPL Predictor Pro 2026

A full-stack web app for IPL match predictions with private rooms, leaderboards, real-time chat, and live scores.

## Features

- Predict match winners before each game starts
- Private prediction rooms with invite codes
- Global and per-room leaderboards
- Real-time chat during live matches (Socket.IO)
- Live score streaming from Cricbuzz (auto-updates every 30s)
- Admin dashboard to manage results, votes, and match overrides

---

## Prerequisites

- Node.js 18+
- PostgreSQL (local or hosted — e.g. Supabase, Render, Neon)

---

## Quick Start (Local Development)

### 1. Clone and install

```bash
git clone <repo-url>
cd ipl-predictor-pro-main
npm install
cd server && npm install && cd ..
```

### 2. Configure environment

**Frontend** — copy `.env.example` at the root:

```bash
cp .env.example .env
```

`.env`:
```
VITE_API_URL=http://localhost:3001
```

**Backend** — copy `server/.env.example`:

```bash
cp server/.env.example server/.env
```

`server/.env`:
```
PORT=3001
DATABASE_URL=postgresql://postgres:password@localhost:5432/ipl_predictor
JWT_SECRET=your-secret-key
ADMIN_PASSWORD=your-admin-unlock-password
ADMIN_USERNAME=admin
ADMIN_DEFAULT_PW=admin123
```

### 3. Create the database

```bash
createdb ipl_predictor
```

Tables are created automatically on first server start.

### 4. Run everything with one command

```bash
npm run dev:all
```

This starts both the frontend and backend concurrently:

| Process | URL |
|---------|-----|
| Frontend (Vite) | http://localhost:5173 |
| Backend (Express) | http://localhost:3001 |

The default admin account is created automatically using `ADMIN_USERNAME` / `ADMIN_DEFAULT_PW` from `server/.env`.

---

## Environment Variables

### Frontend (`/.env`)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | URL of the backend server |

### Backend (`/server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | yes | Port the backend listens on |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | Secret used to sign JWT tokens |
| `ADMIN_PASSWORD` | yes | Password to unlock admin mode in the UI |
| `ADMIN_USERNAME` | yes | Username for the seeded admin account |
| `ADMIN_DEFAULT_PW` | yes | Password for the seeded admin account |
| `SERVER_URL` | no | Public URL used for the self-ping keep-alive (Render deployments) |

---

## Scripts

Run from the project root:

| Command | Description |
|---------|-------------|
| `npm run dev:all` | Start frontend + backend together |
| `npm run dev` | Frontend only |
| `npm run dev:server` | Backend only (with auto-reload) |
| `npm run build` | Production build of the frontend |

---

## Live Scores

Live scores are fetched automatically every 30 seconds during in-progress matches and pushed to all connected clients via Socket.IO.

**Source:** Cricbuzz unofficial web API (`cricbuzz.com/api/cricket-match/live`) — free, no API key required.

Scores appear as a live banner inside the match card when voting is locked.

---

## Deployment

### Frontend → Vercel

1. Push the repo to GitHub
2. Import the project in Vercel
3. Set the environment variable `VITE_API_URL` to your backend URL
4. Deploy

### Backend → Render (or any Node host)

1. Create a new **Web Service** pointing to the `server/` directory
2. Set build command: `npm install`
3. Set start command: `node index.js`
4. Add all `server/.env` variables in the Render environment settings
5. Set `SERVER_URL` to the service's public URL (enables the self-ping keep-alive)

Provision a **PostgreSQL** database (Render, Supabase, or Neon) and paste the connection string into `DATABASE_URL`.

---

## Project Structure

```
ipl-predictor-pro-main/
├── src/                  # React frontend (Vite + TypeScript)
│   ├── pages/            # Index, Leaderboard, ChatRoom, Rooms, Admin, ...
│   ├── components/       # MatchPoll, Header, dashboard/*, ui/*
│   └── lib/              # api.ts, auth.tsx, data.ts, socket.ts
├── server/               # Express backend
│   ├── index.js          # All routes, Socket.IO, live score polling
│   └── schedule.js       # IPL 2026 match schedule (70 matches)
├── public/               # Static assets (team logos)
├── .env.example          # Frontend env template
└── server/.env.example   # Backend env template
```

---

## Admin Guide

1. Log in with the admin account (`ADMIN_USERNAME` / `ADMIN_DEFAULT_PW`)
2. Go to the Admin page and click **Unlock Admin** — enter `ADMIN_PASSWORD`
3. From the admin panel you can:
   - Set match results (winner + score summary)
   - Trigger automatic result sync from Cricbuzz
   - Override vote locks per match
   - Edit or delete individual votes
   - Post announcements (shown as a marquee on the dashboard)
   - Reset all votes and results
