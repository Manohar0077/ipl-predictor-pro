import { useState, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import Header from "@/components/Header";
import { useAuth } from "@/lib/auth";
import { api, type LeaderboardEntry, type Room } from "@/lib/api";
import UserPredictionsDialog from "@/components/UserPredictionsDialog";
import { ArrowLeft, Copy, Check, Shield } from "lucide-react";

import { getAvatarUrl, assignRanks } from "@/lib/utils";
import Footer from "@/components/Footer";



/* ─── Skeleton loading ─── */
const SkeletonRow = ({ delay = 0 }: { delay?: number }) => (
  <div className="flex items-center gap-4 rounded-xl border border-border bg-gradient-card p-4 animate-pulse" style={{ animationDelay: `${delay}ms` }}>
    <div className="h-10 w-10 rounded-full bg-muted/60" />
    <div className="flex-1 space-y-2">
      <div className="h-3 w-32 rounded bg-muted/60" />
      <div className="h-2 w-20 rounded bg-muted/40" />
    </div>
    <div className="h-8 w-12 rounded bg-muted/60" />
  </div>
);

const SkeletonPodium = () => (
  <div className="flex items-end justify-center gap-3 mb-10 animate-pulse">
    {[80, 110, 60].map((h, i) => (
      <div key={i} className="flex flex-col items-center gap-2" style={{ order: i === 1 ? 0 : i === 0 ? 1 : 2 }}>
        <div className="rounded-full bg-muted/50" style={{ width: i === 1 ? 80 : 64, height: i === 1 ? 80 : 64 }} />
        <div className="h-3 w-16 rounded bg-muted/50" />
        <div className="rounded-t-xl bg-muted/30 border border-border/30" style={{ width: 90, height: h }} />
      </div>
    ))}
  </div>
);

/* ─── Podium config ─── */
const podiumConfig = [
  { order: 1, avatarPx: 80, height: 110, width: 100, medal: "🥇", bg: "from-yellow-500/20 to-yellow-600/10", border: "border-yellow-500/40" },
  { order: 0, avatarPx: 64, height: 80, width: 90, medal: "🥈", bg: "from-slate-400/20 to-slate-500/10", border: "border-slate-400/40" },
  { order: 2, avatarPx: 56, height: 60, width: 90, medal: "🥉", bg: "from-orange-500/20 to-orange-600/10", border: "border-orange-500/40" },
];

function PodiumTile({ entry, rank, cfg, isCurrentUser, onAvatarClick }: {
  entry: LeaderboardEntry & { rank: number };
  rank: 1 | 2 | 3;
  cfg: typeof podiumConfig[0];
  isCurrentUser: boolean;
  onAvatarClick: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-1 cursor-pointer"
      style={{ order: cfg.order }}
      onClick={onAvatarClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onAvatarClick();
      }}
    >
      <span className="text-2xl leading-none mb-1">{cfg.medal}</span>
      <div
        title={`${entry.username}'s predictions`}
        className={`rounded-full flex items-center justify-center font-display font-bold text-background border-2 ${cfg.border} shadow-lg ${isCurrentUser ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""} overflow-hidden bg-transparent`}
        style={{ width: cfg.avatarPx, height: cfg.avatarPx, fontSize: cfg.avatarPx * 0.35 }}
      >
        <img src={getAvatarUrl(entry.profile_pic, entry.username)} alt={entry.username} className="h-full w-full object-cover" />
      </div>
      <p className={`text-xs font-semibold text-center max-w-[88px] truncate leading-tight ${isCurrentUser ? "text-primary" : "text-foreground"}`}>
        {entry.username}
        {isCurrentUser && <span className="block text-[9px] text-primary/70">(You)</span>}
      </p>
      <p className="font-display text-lg text-gradient-gold leading-none">{entry.points}</p>
      <p className="text-[9px] text-muted-foreground uppercase tracking-wider">pts</p>
      <div
        className={`w-full rounded-t-xl bg-gradient-to-t ${cfg.bg} border ${cfg.border} flex items-start justify-center pt-2`}
        style={{ height: cfg.height, width: cfg.width }}
      >
        <span className="font-display text-3xl text-muted-foreground/50">#{rank}</span>
      </div>
    </div>
  );
}

/* ─── Copy button ─── */
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <button onClick={copy} className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors" title="Copy code">
      {copied ? <Check size={13} className="text-secondary" /> : <Copy size={13} />}
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/* ─── Main page ─── */
const RoomLeaderboard = () => {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [room, setRoom] = useState<Room | null>(null);
  const [leaderboard, setLeaderboard] = useState<(LeaderboardEntry & { rank: number })[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"podium" | "table">("podium");
  const [pickUser, setPickUser] = useState<string | null>(null);
  const [adminUpdating, setAdminUpdating] = useState<number | null>(null);
  const [memberRemoving, setMemberRemoving] = useState<number | null>(null);

  useEffect(() => {
    if (!user) { navigate("/login"); return; }
    const roomId = parseInt(id!);
    if (isNaN(roomId)) { navigate("/rooms"); return; }
    setLoading(true);
    Promise.all([api.getRoom(roomId), api.getRoomLeaderboard(roomId)])
      .then(([roomData, boardData]) => {
        setRoom(roomData);
        setLeaderboard(assignRanks(boardData));
      })
      .catch(() => navigate("/rooms"))
      .finally(() => setLoading(false));
  }, [user, navigate, id]);

  const handleToggleAdmin = async (entry: LeaderboardEntry & { rank: number }) => {
    if (!entry.user_id || !room) return;
    setAdminUpdating(entry.user_id);
    try {
      await api.setRoomMemberAdmin(room.id, entry.user_id, !entry.is_room_admin);
      setLeaderboard(prev => prev.map(e =>
        e.user_id === entry.user_id ? { ...e, is_room_admin: !entry.is_room_admin } : e
      ));
    } catch (e: any) {
      alert(e.message || "Failed to update admin status");
    } finally {
      setAdminUpdating(null);
    }
  };

  const handleRemoveMember = async (entry: LeaderboardEntry & { rank: number }) => {
    if (!entry.user_id || !room) return;
    if (!confirm(`Remove ${entry.username} from this room?`)) return;
    setMemberRemoving(entry.user_id);
    try {
      await api.removeRoomMember(room.id, entry.user_id);
      setLeaderboard(prev => assignRanks(prev.filter(e => e.user_id !== entry.user_id)));
    } catch (e: any) {
      alert(e.message || "Failed to remove member");
    } finally {
      setMemberRemoving(null);
    }
  };

  if (!user) return null;

  // Current user's leaderboard entry (for is_room_admin check)
  const currentUserEntry = leaderboard.find(e => e.username === user.username);
  const isCurrentUserRoomAdmin = currentUserEntry?.is_room_admin ?? false;
  // Can manage admin roles and remove members: global admin, room creator, or room admin
  const canManageAdmins = user.is_admin || room?.created_by === user.id || isCurrentUserRoomAdmin;

  const top3 = leaderboard.slice(0, 3);
  const rest = leaderboard.slice(3);

  // Reorder for podium: [2nd, 1st, 3rd]
  const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean) as (LeaderboardEntry & { rank: number })[];

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="container mx-auto max-w-4xl px-4 py-6 md:py-8">

        {/* Back link */}
        <Link to="/rooms" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft size={15} /> Back to Rooms
        </Link>

        {/* Title */}
        <div className="mb-8 text-center">
          {room ? (
            <>
              <h2 className="font-display text-5xl text-gradient-gold sm:text-6xl">{room.name.toUpperCase()}</h2>
            </>
          ) : (
            <div className="h-14 w-48 mx-auto rounded bg-muted/40 animate-pulse" />
          )}
        </div>

        {/* Tab Toggler */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex p-1 bg-muted/50 rounded-xl border border-border">
            <button
              onClick={() => setView("podium")}
              className={`px-6 py-2 rounded-lg text-sm font-semibold transition-all ${view === "podium"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:text-foreground"
                }`}
            >
              PODIUM
            </button>
            <button
              onClick={() => setView("table")}
              className={`px-6 py-2 rounded-lg text-sm font-semibold transition-all ${view === "table"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:text-foreground"
                }`}
            >
              POINTS TABLE
            </button>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <>
            <SkeletonPodium />
            <div className="space-y-2">{[0, 1, 2, 3].map(i => <SkeletonRow key={i} delay={i * 60} />)}</div>
          </>
        )}

        {/* Empty */}
        {!loading && leaderboard.length === 0 && (
          <div className="rounded-2xl bg-gradient-card border border-border p-12 text-center">
            <span className="text-5xl">📊</span>
            <h3 className="mt-4 font-display text-3xl text-foreground">No Scores Yet</h3>
            <p className="mt-2 text-muted-foreground">Members need to start voting to see scores!</p>
          </div>
        )}

        {/* Podium + list View */}
        {!loading && leaderboard.length > 0 && view === "podium" && (
          <>
            <div className="flex items-end justify-center gap-3 mb-10 px-2">
              {podiumOrder.map((entry, idx) => {
                // idx 0 -> Silver position (Left), idx 1 -> Gold position (Middle), idx 2 -> Bronze position (Right)
                // This corresponds to cfg mapping: idx 0 -> podiumConfig[1], idx 1 -> podiumConfig[0], idx 2 -> podiumConfig[2]
                const cfgIndex = idx === 0 ? 1 : idx === 1 ? 0 : 2;
                return (
                  <PodiumTile
                    key={entry.username}
                    entry={entry}
                    rank={entry.rank as 1 | 2 | 3}
                    cfg={podiumConfig[cfgIndex]}
                    isCurrentUser={entry.username === user.username}
                    onAvatarClick={() => setPickUser(entry.username)}
                  />
                );
              })}
            </div>

            {rest.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground uppercase tracking-widest mb-3 pl-1">Rankings</p>
                {rest.map((entry, i) => (
                  <div
                    key={entry.username}
                    className={`flex items-center gap-4 rounded-xl border p-4 transition-all animate-slide-up cursor-pointer ${entry.username === user.username ? "border-primary/50 bg-primary/5" : "border-border bg-gradient-card"
                      }`}
                    style={{ animationDelay: `${i * 50}ms` }}
                    onClick={() => setPickUser(entry.username)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setPickUser(entry.username);
                    }}
                    aria-label={`Open ${entry.username}'s predictions`}
                  >
                    <div className="flex h-10 w-10 items-center justify-center shrink-0">
                      <span className="font-display text-xl text-muted-foreground">#{entry.rank}</span>
                    </div>
                    <button
                      type="button"
                      title={`${entry.username}'s predictions`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPickUser(entry.username);
                      }}
                      className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden text-foreground cursor-pointer ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <img src={getAvatarUrl(entry.profile_pic, entry.username)} alt={entry.username} className="h-full w-full object-cover" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground truncate flex items-center gap-1.5">
                        {entry.username}
                        {entry.is_room_admin && <Shield size={13} title="Room Admin" className="text-amber-400 shrink-0" />}
                        {entry.username === user.username && <span className="text-xs text-primary">(You)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{entry.voted} voted · {entry.correct} correct · {entry.nr} NR · {entry.matches} total</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-display text-3xl text-gradient-gold leading-none">{entry.points}</p>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Points</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Table View */}
        {!loading && leaderboard.length > 0 && view === "table" && (
          <div className="animate-fade-in overflow-x-auto rounded-2xl border border-border bg-gradient-card shadow-xl">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border/50 bg-muted/20">
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground" title="Current ranking based on Points, Wins, then NRR">Rank</th>
                  <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground" title="Player name and avatar">Player</th>
                  <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground" title="Total matches completed in the IPL session">Matches</th>
                  <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground" title="Number of matches you have placed a vote on">Voted</th>
                  <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground text-secondary" title="Number of correct predictions">Wins</th>
                  <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground text-destructive" title="Number of incorrect predictions">Losses</th>
                  <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground text-primary" title="Win percentage (Wins / Voted)">Win %</th>
                  <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground" title="Matches with No Result (Abandoned/Rain)">NR</th>
                  <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground" title="Net Run Rate: The total run rate difference of teams you voted for vs their opposition.">NRR</th>
                  <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-muted-foreground" title="Total score: 2 points for Win, 1 for No Result">Pts</th>
                  {canManageAdmins && <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground" />}
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((entry) => (
                  <tr
                    key={entry.username}
                    className={`border-b border-border/30 transition-colors hover:bg-muted/10 ${entry.username === user.username ? "bg-primary/5" : ""}`}
                    onClick={() => setPickUser(entry.username)}
                    style={{ cursor: "pointer" }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setPickUser(entry.username);
                    }}
                  >
                    <td className="px-4 py-4 font-display text-lg text-muted-foreground">#{entry.rank}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          title={`${entry.username}'s predictions`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPickUser(entry.username);
                          }}
                          className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden border border-border cursor-pointer ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          <img src={getAvatarUrl(entry.profile_pic, entry.username)} alt={entry.username} className="h-full w-full object-cover" />
                        </button>
                        <span className={`font-semibold flex items-center gap-1.5 ${entry.username === user.username ? "text-primary" : "text-foreground"}`}>
                          {entry.username}
                          {entry.is_room_admin && <Shield size={13} title="Room Admin" className="text-amber-400 shrink-0" />}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center text-sm font-medium">{entry.matches}</td>
                    <td className="px-4 py-4 text-center text-sm font-medium">{entry.voted}</td>
                    <td className="px-4 py-4 text-center text-sm font-medium text-secondary">{entry.correct}</td>
                    <td className="px-4 py-4 text-center text-sm font-medium text-destructive">{entry.voted - entry.correct - entry.nr}</td>
                    <td className="px-4 py-4 text-center text-sm font-medium text-primary">{entry.voted > 0 ? ((entry.correct / entry.voted) * 100).toFixed(1) + '%' : '0.0%'}</td>
                    <td className="px-4 py-4 text-center text-sm font-medium text-muted-foreground">{entry.nr}</td>
                    <td className={`px-4 py-4 text-center text-sm font-bold ${entry.nrr2 && entry.nrr2 > 0 ? 'text-secondary' : entry.nrr2 && entry.nrr2 < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {entry.nrr2 == null ? "—" : (entry.nrr2 > 0 ? "+" : "") + entry.nrr2.toFixed(3)}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <span className="font-display text-xl text-gradient-gold">{entry.points}</span>
                    </td>
                    {canManageAdmins && (
                      <td className="px-3 py-4" onClick={(e) => e.stopPropagation()}>
                        {entry.username !== user.username && entry.user_id !== room?.created_by && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleToggleAdmin(entry)}
                              disabled={adminUpdating === entry.user_id}
                              className={`rounded px-1.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-40 whitespace-nowrap ${entry.is_room_admin ? "text-amber-400 hover:bg-amber-400/10" : "text-muted-foreground hover:text-amber-400 hover:bg-amber-400/10"}`}
                              title={entry.is_room_admin ? "Demote from admin" : "Promote to admin"}
                            >
                              {adminUpdating === entry.user_id ? "…" : entry.is_room_admin ? "Demote" : "Make Admin"}
                            </button>
                            <button
                              onClick={() => handleRemoveMember(entry)}
                              disabled={memberRemoving === entry.user_id}
                              className="rounded px-1.5 py-1 text-[10px] font-medium text-rose-400 hover:bg-rose-400/10 transition-colors disabled:opacity-40"
                              title="Remove from room"
                            >
                              {memberRemoving === entry.user_id ? "…" : "Remove"}
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Footer />
      </main>

      <UserPredictionsDialog
        username={pickUser}
        roomId={parseInt(id!)}
        open={!!pickUser}
        onOpenChange={(o) => {
          if (!o) setPickUser(null);
        }}
      />
    </div>
  );
};

export default RoomLeaderboard;
