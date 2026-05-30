import { useEffect, useRef, useState } from "react";
import { X, Trophy, Star, Crown } from "lucide-react";
import type { LeaderboardEntry } from "@/lib/api";
import { getAvatarUrl } from "@/lib/utils";

// ─── Confetti particle ───────────────────────────────────────────────────────
const COLORS = [
  "#FFD700", "#FF6B35", "#C8102E", "#1C3C6A", "#00A86B",
  "#FF4DFF", "#00CFFF", "#FFA500", "#7FFF00", "#FF1493",
];

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  color: string;
  shape: "circle" | "rect" | "triangle";
  animDuration: number;
  animDelay: number;
  drift: number;
}

function makeParticles(n: number): Particle[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: -10 - Math.random() * 20,
    size: 6 + Math.random() * 8,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    shape: (["circle", "rect", "triangle"] as const)[Math.floor(Math.random() * 3)],
    animDuration: 3 + Math.random() * 3,
    animDelay: Math.random() * 2,
    drift: (Math.random() - 0.5) * 60,
  }));
}

// ─── Avatar ring ─────────────────────────────────────────────────────────────
function AvatarRing({
  entry,
  size,
  className = "",
}: {
  entry: LeaderboardEntry;
  size: number;
  className?: string;
}) {
  return (
    <div
      className={`rounded-full overflow-hidden border-4 border-yellow-400 shadow-xl shadow-yellow-400/30 ${className}`}
      style={{ width: size, height: size }}
    >
      <img
        src={getAvatarUrl(entry.profile_pic, entry.username)}
        alt={entry.username}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────
interface ChampionBannerProps {
  leaderboard: (LeaderboardEntry & { rank: number })[];
  roomName: string;
  onClose: () => void;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ChampionBanner({
  leaderboard,
  roomName,
  onClose,
}: ChampionBannerProps) {
  const [particles] = useState(() => makeParticles(80));
  const [visible, setVisible] = useState(false);
  const styleRef = useRef<HTMLStyleElement | null>(null);

  // Inject keyframes once
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes champ-fall {
        0%   { transform: translateY(0) rotate(0deg) translateX(0); opacity: 1; }
        80%  { opacity: 1; }
        100% { transform: translateY(110vh) rotate(720deg) translateX(var(--drift)); opacity: 0; }
      }
      @keyframes champ-glow {
        0%, 100% { box-shadow: 0 0 30px 6px #FFD700aa, 0 0 80px 20px #FF6B3540; }
        50%       { box-shadow: 0 0 60px 16px #FFD700cc, 0 0 120px 40px #FF6B3570; }
      }
      @keyframes champ-crown {
        0%, 100% { transform: translateY(0) rotate(-6deg) scale(1); }
        50%       { transform: translateY(-8px) rotate(6deg) scale(1.1); }
      }
      @keyframes champ-star {
        0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.6; }
        50%       { transform: scale(1.4) rotate(180deg); opacity: 1; }
      }
      @keyframes champ-slide-up {
        from { transform: translateY(40px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }
      @keyframes champ-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes champ-pulse-ring {
        0%   { transform: scale(1);   opacity: 0.8; }
        50%  { transform: scale(1.08); opacity: 0.4; }
        100% { transform: scale(1);   opacity: 0.8; }
      }
      @keyframes champ-float {
        0%, 100% { transform: translateY(0); }
        50%       { transform: translateY(-12px); }
      }
      @keyframes champ-shimmer {
        0%   { background-position: -200% center; }
        100% { background-position: 200% center; }
      }
    `;
    document.head.appendChild(style);
    styleRef.current = style;
    // Trigger entrance animation
    requestAnimationFrame(() => setVisible(true));
    return () => { style.remove(); };
  }, []);

  const champion = leaderboard[0];
  const second   = leaderboard[1];
  const third    = leaderboard[2];

  if (!champion) return null;

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 400);
  };

  return (
    <div
      role="dialog"
      aria-label="IPL 2026 Championship Results"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(8px)",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.4s ease",
      }}
    >
      {/* ── Confetti ── */}
      {particles.map((p) => (
        <div
          key={p.id}
          style={{
            position: "absolute",
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            backgroundColor: p.shape !== "triangle" ? p.color : "transparent",
            borderRadius: p.shape === "circle" ? "50%" : p.shape === "rect" ? "2px" : 0,
            borderLeft: p.shape === "triangle" ? `${p.size / 2}px solid transparent` : undefined,
            borderRight: p.shape === "triangle" ? `${p.size / 2}px solid transparent` : undefined,
            borderBottom: p.shape === "triangle" ? `${p.size}px solid ${p.color}` : undefined,
            // @ts-ignore
            "--drift": `${p.drift}px`,
            animation: `champ-fall ${p.animDuration}s ${p.animDelay}s ease-in infinite`,
            pointerEvents: "none",
          }}
        />
      ))}

      {/* ── Card ── */}
      <div
        style={{
          position: "relative",
          width: "min(92vw, 520px)",
          maxHeight: "92vh",
          overflowY: "auto",
          borderRadius: 24,
          background: "linear-gradient(160deg, hsl(222,47%,9%) 0%, hsl(222,40%,14%) 100%)",
          border: "1.5px solid hsl(38,92%,50%,0.4)",
          boxShadow: "0 0 60px 10px hsl(38,92%,50%,0.18), 0 40px 80px rgba(0,0,0,0.6)",
          animation: "champ-slide-up 0.5s 0.1s cubic-bezier(0.16,1,0.3,1) both",
          scrollbarWidth: "none",
        }}
      >
        {/* Close */}
        <button
          onClick={handleClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            zIndex: 10,
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            color: "rgba(255,255,255,0.7)",
            cursor: "pointer",
            padding: "6px",
            display: "flex",
            alignItems: "center",
            lineHeight: 0,
            transition: "background 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.15)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
        >
          <X size={16} />
        </button>

        {/* ── Header ── */}
        <div style={{ padding: "32px 24px 20px", textAlign: "center" }}>
          {/* Trophy icon */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "linear-gradient(135deg, hsl(38,92%,50%), hsl(45,100%,60%))",
              marginBottom: 12,
              animation: "champ-float 3s ease-in-out infinite",
            }}
          >
            <Trophy size={28} color="#fff" strokeWidth={2.5} />
          </div>

          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "hsl(38,92%,55%)",
              fontWeight: 600,
              marginBottom: 4,
              animation: "champ-fade-in 0.6s 0.3s both",
            }}
          >
            IPL 2026 · {roomName}
          </div>
          <div
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: "clamp(2.2rem, 8vw, 3.4rem)",
              letterSpacing: "0.06em",
              lineHeight: 1,
              background: "linear-gradient(135deg, #FFD700, #FFA500, #FF6B35)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              animation: "champ-fade-in 0.6s 0.35s both",
            }}
          >
            Final Results
          </div>
          <div
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: "clamp(1rem, 4vw, 1.3rem)",
              letterSpacing: "0.1em",
              color: "rgba(255,255,255,0.45)",
              marginTop: 2,
              animation: "champ-fade-in 0.6s 0.4s both",
            }}
          >
            Tournament Over · All 74 Matches Played
          </div>
        </div>

        {/* ── Champion spotlight ── */}
        <div
          style={{
            padding: "28px 24px",
            borderTop: "1px solid rgba(255,215,0,0.12)",
            borderBottom: "1px solid rgba(255,215,0,0.12)",
            background: "radial-gradient(ellipse 80% 60% at 50% 50%, hsl(38,80%,20%,0.35) 0%, transparent 70%)",
            textAlign: "center",
            animation: "champ-fade-in 0.6s 0.45s both",
          }}
        >
          {/* Crown */}
          <div
            style={{
              fontSize: 40,
              lineHeight: 1,
              marginBottom: 8,
              animation: "champ-crown 2.5s ease-in-out infinite",
              display: "inline-block",
            }}
          >
            👑
          </div>

          {/* Avatar with pulsing ring */}
          <div style={{ position: "relative", display: "inline-block", marginBottom: 14 }}>
            <div
              style={{
                position: "absolute",
                inset: -8,
                borderRadius: "50%",
                border: "3px solid #FFD700",
                opacity: 0.6,
                animation: "champ-pulse-ring 2s ease-in-out infinite",
              }}
            />
            <div
              style={{
                position: "absolute",
                inset: -18,
                borderRadius: "50%",
                border: "2px solid #FFD700",
                opacity: 0.25,
                animation: "champ-pulse-ring 2s 0.4s ease-in-out infinite",
              }}
            />
            <div
              style={{
                width: 100,
                height: 100,
                borderRadius: "50%",
                overflow: "hidden",
                border: "4px solid #FFD700",
                animation: "champ-glow 2.5s ease-in-out infinite",
              }}
            >
              <img
                src={getAvatarUrl(champion.profile_pic, champion.username)}
                alt={champion.username}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
          </div>

          {/* Stars */}
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 10 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Star
                key={i}
                size={14}
                fill="#FFD700"
                color="#FFD700"
                style={{ animation: `champ-star 1.8s ${i * 0.15}s ease-in-out infinite` }}
              />
            ))}
          </div>

          <div
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: "clamp(1.8rem, 7vw, 2.6rem)",
              letterSpacing: "0.05em",
              color: "#fff",
              marginBottom: 2,
            }}
          >
            {champion.username}
          </div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: "hsl(38,92%,55%)",
              fontWeight: 600,
              marginBottom: 16,
            }}
          >
            🏆 Prediction Champion
          </div>

          {/* Score chips */}
          <div
            style={{
              display: "inline-flex",
              gap: 10,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            {[
              { label: "Points", value: String(champion.points), accent: true },
              { label: "Correct", value: String(champion.correct) },
              { label: "Win %", value: (champion.voted - champion.nr) >= 5 ? `${((champion.correct / (champion.voted - champion.nr)) * 100).toFixed(1)}%` : `${champion.correct}/${champion.voted - champion.nr}` },
            ].map(({ label, value, accent }) => (
              <div
                key={label}
                style={{
                  background: accent
                    ? "linear-gradient(135deg, hsl(38,92%,50%,0.2), hsl(45,100%,60%,0.1))"
                    : "rgba(255,255,255,0.05)",
                  border: `1px solid ${accent ? "hsl(38,92%,50%,0.4)" : "rgba(255,255,255,0.1)"}`,
                  borderRadius: 10,
                  padding: "6px 14px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: accent ? 26 : 20,
                    letterSpacing: "0.03em",
                    background: accent
                      ? "linear-gradient(135deg, #FFD700, #FFA500)"
                      : "none",
                    WebkitBackgroundClip: accent ? "text" : undefined,
                    WebkitTextFillColor: accent ? "transparent" : "#fff",
                    backgroundClip: accent ? "text" : undefined,
                  }}
                >
                  {value}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: "0.15em",
                    color: "rgba(255,255,255,0.45)",
                    marginTop: -2,
                  }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Runner-ups ── */}
        {(second || third) && (
          <div
            style={{
              padding: "20px 24px",
              animation: "champ-fade-in 0.6s 0.6s both",
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.35)",
                marginBottom: 12,
                textAlign: "center",
              }}
            >
              Runner-ups
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              {[second, third].filter(Boolean).map((entry, idx) => {
                const isSecond = idx === 0;
                const medal = isSecond ? "🥈" : "🥉";
                const borderColor = isSecond ? "#94a3b8" : "#c2763c";
                return (
                  <div
                    key={entry!.username}
                    style={{
                      flex: 1,
                      maxWidth: 200,
                      background: "rgba(255,255,255,0.04)",
                      border: `1px solid ${borderColor}40`,
                      borderRadius: 14,
                      padding: "14px 12px",
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 22, marginBottom: 8 }}>{medal}</div>
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: "50%",
                        overflow: "hidden",
                        border: `3px solid ${borderColor}`,
                        margin: "0 auto 8px",
                      }}
                    >
                      <img
                        src={getAvatarUrl(entry!.profile_pic, entry!.username)}
                        alt={entry!.username}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    </div>
                    <div
                      style={{
                        fontFamily: "'Bebas Neue', sans-serif",
                        fontSize: 18,
                        letterSpacing: "0.04em",
                        color: "#fff",
                        marginBottom: 2,
                      }}
                    >
                      {entry!.username}
                    </div>
                    <div
                      style={{
                        fontFamily: "'Bebas Neue', sans-serif",
                        fontSize: 22,
                        background: "linear-gradient(135deg, hsl(38,92%,55%), hsl(45,100%,65%))",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        backgroundClip: "text",
                      }}
                    >
                      {entry!.points}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        textTransform: "uppercase",
                        letterSpacing: "0.15em",
                        color: "rgba(255,255,255,0.35)",
                        marginTop: -2,
                      }}
                    >
                      pts · {entry!.correct} correct
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Full Leaderboard rows (4th onwards) ── */}
        {leaderboard.length > 3 && (
          <div
            style={{
              padding: "0 24px 24px",
              animation: "champ-fade-in 0.6s 0.7s both",
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.3)",
                marginBottom: 8,
                textAlign: "center",
              }}
            >
              Full Standings
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {leaderboard.slice(3).map((entry) => (
                <div
                  key={entry.username}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 10,
                    padding: "8px 12px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'Bebas Neue', sans-serif",
                      fontSize: 16,
                      color: "rgba(255,255,255,0.35)",
                      minWidth: 24,
                    }}
                  >
                    #{entry.rank}
                  </span>
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: "50%",
                      overflow: "hidden",
                      border: "1.5px solid rgba(255,255,255,0.15)",
                      flexShrink: 0,
                    }}
                  >
                    <img
                      src={getAvatarUrl(entry.profile_pic, entry.username)}
                      alt={entry.username}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  </div>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      fontWeight: 600,
                      color: "rgba(255,255,255,0.8)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.username}
                  </span>
                  <span
                    style={{
                      fontFamily: "'Bebas Neue', sans-serif",
                      fontSize: 18,
                      background: "linear-gradient(135deg, hsl(38,92%,55%), hsl(45,100%,65%))",
                      WebkitBackgroundClip: "text",
                      WebkitTextFillColor: "transparent",
                      backgroundClip: "text",
                    }}
                  >
                    {entry.points}
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", minWidth: 30, textAlign: "right" }}>
                    {entry.correct}✓
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid rgba(255,255,255,0.07)",
            textAlign: "center",
            animation: "champ-fade-in 0.6s 0.75s both",
          }}
        >
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", marginBottom: 12 }}>
            THANK YOU FOR PLAYING IPL PREDICTOR PRO 2026 🏏
          </div>
          <button
            onClick={handleClose}
            style={{
              background: "linear-gradient(135deg, hsl(38,92%,50%), hsl(45,100%,55%))",
              border: "none",
              borderRadius: 10,
              color: "#000",
              cursor: "pointer",
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 16,
              letterSpacing: "0.08em",
              padding: "10px 32px",
              transition: "opacity 0.2s, transform 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; e.currentTarget.style.transform = "scale(1.03)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1)"; }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
