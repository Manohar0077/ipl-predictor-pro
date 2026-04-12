import type { MatchResult, Match } from "@/lib/data";

const API_URL = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, "");

if (!API_URL) {
  throw new Error("VITE_API_URL is required in the frontend .env file");
}

function getToken(): string | null {
  return localStorage.getItem("ipl_token");
}

function setToken(token: string) {
  localStorage.setItem("ipl_token", token);
}

function clearToken() {
  localStorage.removeItem("ipl_token");
  localStorage.removeItem("ipl_user");
  localStorage.removeItem("active_room_id");
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-App-Source": "web-app",
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
  profile_pic?: string;
}

export interface LeaderboardEntry {
  user_id?: number;
  username: string;
  profile_pic?: string;
  points: number;
  nr: number;
  correct: number;
  voted: number;
  matches: number;
  /** Average absolute minutes between vote time and match time (higher is better). */
  nrr?: number | null;
  is_room_admin?: boolean;
}

export interface UserPredictionVote {
  matchId: string;
  prediction: string;
  outcome: string | null;
}

export interface Room {
  id: number;
  name: string;
  invite_code: string;
  member_count?: number;
  members?: string[];
  created_by?: number;
  created_by_username?: string;
  pending_requests?: number;
  user_is_room_admin?: boolean;
}

export interface JoinRequest {
  id: number;
  room_id: number;
  user_id: number;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  username: string;
  profile_pic?: string;
}

export interface UserOutcome {
  username: string;
  prediction: string;
  status: "won" | "lost";
  currentRank: number;
  prevRank: number;
  rankChange: number;
}

export interface MatchOverride {
  match_id: string;
  manual_locked: boolean | null;
  lock_delay: number;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: number[];
  usernames: string[];
}

export interface ChatMessage {
  id: number;
  room_id: number;
  match_id: string;
  user_id: number;
  message: string;
  username: string;
  profile_pic?: string;
  created_at: string;
  bot_name?: string | null;
  is_bot?: boolean;
  reply_to_message?: {
    username: string;
    message: string;
  } | null;
  reactions?: MessageReaction[];
}

export interface PollSummary {
  noData?: boolean;
  matchId: string;
  team1: string;
  team2: string;
  winner: string;
  scoreSummary?: string | null;
  userVote: string | null;
  userStatus: 'won' | 'lost' | 'no_vote';
  pointsGained: number;
  currentRank: number;
  prevRank: number;
  rankChange: number;
  userOutcomes: UserOutcome[];
  totalVoters: number;
}

export const api = {
  async getLastPollSummary(): Promise<PollSummary> {
    return apiFetch("/api/last-poll-summary");
  },
  // Auth — username + password only
  async register(username: string, password: string) {
    const data = await apiFetch("/api/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setToken(data.token);
    localStorage.setItem("ipl_user", JSON.stringify(data.user));
    return data.user as User;
  },

  async login(username: string, password: string) {
    const data = await apiFetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setToken(data.token);
    localStorage.setItem("ipl_user", JSON.stringify(data.user));
    return data.user as User;
  },

  logout() {
    clearToken();
  },

  getStoredUser(): User | null {
    const raw = localStorage.getItem("ipl_user");
    return raw ? JSON.parse(raw) : null;
  },

  isLoggedIn(): boolean {
    return !!getToken();
  },

  async me(): Promise<User> {
    const user = await apiFetch("/api/me");
    localStorage.setItem("ipl_user", JSON.stringify(user));
    return user;
  },

  // Admin
  async unlockAdmin(password: string) {
    const data = await apiFetch("/api/admin/unlock", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setToken(data.token);
    const user = api.getStoredUser();
    if (user) {
      user.is_admin = true;
      localStorage.setItem("ipl_user", JSON.stringify(user));
    }
    return data;
  },

  // Votes — returns counts only (no usernames revealed)
  async getVotes(roomId?: number): Promise<Record<string, Record<string, string>>> {
    const url = roomId ? `/api/votes?roomId=${roomId}` : "/api/votes";
    return apiFetch(url);
  },

  // Get vote counts (anonymous)
  async getVoteCounts(roomId?: number): Promise<Record<string, Record<string, number>>> {
    const url = roomId ? `/api/vote-counts?roomId=${roomId}` : "/api/vote-counts";
    return apiFetch(url);
  },

  async vote(matchId: string, prediction: string, roomId: number) {
    return apiFetch("/api/vote", {
      method: "POST",
      body: JSON.stringify({ matchId, prediction, roomId }),
    });
  },
  
  async bulkVote(matchId: string, prediction: string) {
    return apiFetch("/api/vote/bulk", {
      method: "POST",
      body: JSON.stringify({ matchId, prediction }),
    });
  },

  // Results
  async getResults(): Promise<Record<string, MatchResult>> {
    return apiFetch("/api/results");
  },

  async setResult(matchId: string, winner: string | null, scoreSummary?: string | null) {
    const body: Record<string, unknown> = { matchId, winner: winner || "" };
    if (scoreSummary !== undefined) body.scoreSummary = scoreSummary;
    return apiFetch("/api/result", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  async getUserPredictions(username: string, roomId?: number): Promise<{ votes: UserPredictionVote[] }> {
    const url = roomId ? `/api/users/${encodeURIComponent(username)}/predictions?roomId=${roomId}` : `/api/users/${encodeURIComponent(username)}/predictions`;
    return apiFetch(url);
  },

  // Admin: alter a user's vote
  async adminSetVote(matchId: string, username: string, prediction: string, roomId: number) {
    return apiFetch("/api/admin/vote", {
      method: "POST",
      body: JSON.stringify({ matchId, username, prediction, roomId }),
    });
  },

  // Admin: delete a user's vote
  async adminDeleteVote(matchId: string, username: string, roomId: number) {
    return apiFetch("/api/admin/delete-vote", { method: "POST", body: JSON.stringify({ matchId, username, roomId }) });
  },

  // Admin: set a user's password
  async adminSetPassword(username: string, password: string) {
    return apiFetch("/api/admin/set-password", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  async updateProfile(data: { username?: string; password?: string; profile_pic?: string | null }) {
    const res = await apiFetch("/api/me", { method: "PUT", body: JSON.stringify(data) });
    if (res.token) setToken(res.token);
    if (res.user) localStorage.setItem("ipl_user", JSON.stringify(res.user));
    return res;
  },

  // Admin: reset all data
  async adminReset() {
    return apiFetch("/api/admin/reset", { method: "POST" });
  },

  async syncResults(): Promise<{ updated: number; checked: number; error?: string }> {
    return apiFetch("/api/admin/sync-results", { method: "POST" });
  },

  // Rooms
  async createRoom(name: string): Promise<Room> {
    return apiFetch("/api/rooms", { method: "POST", body: JSON.stringify({ name }) });
  },

  async joinRoom(inviteCode: string): Promise<{ room: Room }> {
    return apiFetch("/api/rooms/join", { method: "POST", body: JSON.stringify({ inviteCode }) });
  },

  async getMyRooms(): Promise<Room[]> {
    return apiFetch("/api/rooms/mine");
  },

  async getRoom(id: number): Promise<Room> {
    return apiFetch(`/api/rooms/${id}`);
  },

  async getRoomLeaderboard(id: number): Promise<LeaderboardEntry[]> {
    return apiFetch(`/api/rooms/${id}/leaderboard`);
  },

  async deleteRoom(id: number): Promise<void> {
    return apiFetch(`/api/rooms/${id}`, { method: "DELETE" });
  },

  async requestJoinRoom(inviteCode: string): Promise<{ ok: boolean; message: string }> {
    return apiFetch("/api/rooms/join-request", {
      method: "POST",
      body: JSON.stringify({ inviteCode }),
    });
  },

  async getJoinRequests(roomId: number): Promise<JoinRequest[]> {
    return apiFetch(`/api/rooms/${roomId}/join-requests`);
  },

  async approveJoinRequest(roomId: number, requestId: number): Promise<{ ok: boolean }> {
    return apiFetch(`/api/rooms/${roomId}/join-requests/${requestId}/approve`, { method: "POST" });
  },

  async rejectJoinRequest(roomId: number, requestId: number): Promise<{ ok: boolean }> {
    return apiFetch(`/api/rooms/${roomId}/join-requests/${requestId}/reject`, { method: "POST" });
  },

  async getAllRoomsAdmin(): Promise<Room[]> {
    return apiFetch("/api/admin/rooms");
  },

  async getChatHistory(roomId: number, matchId: string): Promise<ChatMessage[]> {
    return apiFetch(`/api/rooms/${roomId}/chat/${matchId}`);
  },

  async getMatchOverrides(): Promise<MatchOverride[]> {
    return apiFetch("/api/match-overrides");
  },

  async setMatchOverride(matchId: string, manual_locked: boolean | null, lock_delay: number): Promise<void> {
    return apiFetch("/api/admin/match-override", {
      method: "POST",
      body: JSON.stringify({ matchId, manual_locked, lock_delay }),
    });
  },

  async getAnnouncement(): Promise<{ text: string }> {
    return apiFetch("/api/announcements");
  },

  async setAnnouncement(text: string): Promise<void> {
    return apiFetch("/api/admin/announcements", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  },

  async clearAnnouncement(): Promise<void> {
    return apiFetch("/api/admin/announcements", {
      method: "DELETE",
    });
  },

  async getLiveScores(): Promise<Record<string, { matchId: string; team1: string; team2: string; score: string | null; status: string | null; updatedAt: string }>> {
    return apiFetch('/api/live-score');
  },

  async toggleReaction(messageId: number, emoji: string): Promise<{ reactions: MessageReaction[] }> {
    return apiFetch('/api/reactions', {
      method: 'POST',
      body: JSON.stringify({ messageId, emoji }),
    });
  },

  async getMatches(): Promise<Match[]> {
    return apiFetch('/api/matches');
  },

  async syncSchedule(): Promise<{ updated: number; error?: string }> {
    return apiFetch('/api/admin/sync-schedule', { method: 'POST' });
  },

  async getMatchBotSettings(): Promise<{ match_id: string; bot_enabled: boolean }[]> {
    return apiFetch('/api/match-bot-settings');
  },

  async setMatchBotSetting(matchId: string, bot_enabled: boolean): Promise<void> {
    return apiFetch('/api/admin/match-bot-settings', {
      method: 'POST',
      body: JSON.stringify({ matchId, bot_enabled }),
    });
  },

  async setRoomMemberAdmin(roomId: number, userId: number, is_room_admin: boolean): Promise<{ ok: boolean }> {
    return apiFetch(`/api/rooms/${roomId}/members/${userId}/admin`, {
      method: 'PUT',
      body: JSON.stringify({ is_room_admin }),
    });
  },

  async removeRoomMember(roomId: number, userId: number): Promise<{ ok: boolean }> {
    return apiFetch(`/api/rooms/${roomId}/members/${userId}`, { method: 'DELETE' });
  },

  // Push notifications
  async getPushVapidKey(): Promise<{ publicKey: string }> {
    return apiFetch('/api/push/vapid-public-key');
  },

  async subscribePush(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    return apiFetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) });
  },

  async unsubscribePush(endpoint: string): Promise<void> {
    return apiFetch('/api/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) });
  },
};
