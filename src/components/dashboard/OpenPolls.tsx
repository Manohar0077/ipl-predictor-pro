import React from "react";
import MatchPoll from "@/components/MatchPoll";
import { isVotingLocked, type Match } from "@/lib/data";
import { Coffee } from "lucide-react";


interface Props {
  isLoading?: boolean;
  openPolls: Match[];
  voteCounts: Record<string, Record<string, number>>;
  myVotes: Record<string, string>;
  allVotes: Record<string, Record<string, string>>;
  onVote: (matchId: string, prediction: string, isBulk?: boolean) => Promise<void>;
  completedCount: number;
  totalMatchCount: number;
  results: Record<string, any>;
  overrides: Record<string, any>;
  roomId?: number;
  liveScores?: Record<string, { score: string | null; status: string | null; updatedAt: string }>;
  onShowSummary?: () => void;
}

const OpenPolls = React.memo(({ isLoading, openPolls, voteCounts, myVotes, allVotes, onVote, completedCount, totalMatchCount, results, overrides, roomId, liveScores, onShowSummary }: Props) => {
  if (isLoading) {
    return (
      <div className="mb-8">
        <div className="mb-4 flex items-center gap-2">
          <div className="h-8 w-64 animate-pulse rounded-lg bg-muted/60" />
        </div>
        <div className="space-y-4">
          <div className="h-64 w-full animate-pulse rounded-2xl bg-muted/30 border border-border" />
        </div>
      </div>
    );
  }

  if (openPolls.length > 0) {
    return (
      <div className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-destructive" />
            <h2 className="font-display text-xl sm:text-3xl text-gradient-gold leading-tight">
              {openPolls.some(m => isVotingLocked(m, overrides[m.id]))
                ? "LIVE MATCH IN PROGRESS"
                : `LIVE POLL${openPolls.length > 1 ? "S" : ""} — VOTE NOW!`}
            </h2>
          </div>
          {onShowSummary && (
            <button
              onClick={onShowSummary}
              className="flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-bold text-primary transition-all hover:bg-primary/10 active:scale-95 shadow-sm"
            >
              <Coffee size={14} /> VIEW LAST RESULT
            </button>
          )}
        </div>
        <div className="space-y-4">
          {openPolls.map(match => {
            const counts = voteCounts[match.id] || {};
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            return (
              <MatchPoll
                key={match.id}
                match={match}
                voteCounts={counts}
                totalVotes={total}
                myPick={myVotes[match.id] || null}
                result={undefined}
                onVote={onVote}
                isOpen
                allVotes={allVotes[match.id] || {}}
                override={overrides[match.id]}
                roomId={roomId}
                liveScore={liveScores?.[match.id]}
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-8 text-center">
      <h2 className="font-display text-5xl text-gradient-gold sm:text-6xl text-center">
        POLLS
      </h2>
      <div className="mt-4 rounded-2xl bg-gradient-card border border-border p-8">
        <p className="text-muted-foreground">
          {completedCount >= totalMatchCount && totalMatchCount > 0
            ? "🏆 IPL 2026 is complete! Check the leaderboard!"
            : completedCount === 0
              ? "🚀 IPL 2026 starts March 28! First poll opens then."
              : "⏳ Next poll opens after the current match finishes."}
        </p>
      </div>
    </div>
  );
});

OpenPolls.displayName = "OpenPolls";

export default OpenPolls;
