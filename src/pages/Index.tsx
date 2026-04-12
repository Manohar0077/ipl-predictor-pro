import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { useAuth } from "@/lib/auth";
import { useRoom } from "@/lib/room";
import { api } from "@/lib/api";
import { getPollOpenMatches, type MatchResult } from "@/lib/data";
import { useMatches } from "@/lib/matches";
import { Users, Bell, BellOff } from "lucide-react";
import { registerServiceWorker, subscribeToPush, unsubscribeFromPush, isPushSubscribed } from "@/lib/push";
import OpenPolls from "@/components/dashboard/OpenPolls";
import CompletedMatches from "@/components/dashboard/CompletedMatches";
import UpcomingMatches from "@/components/dashboard/UpcomingMatches";
import Footer from "@/components/Footer";
import PollSummaryBanner from "@/components/PollSummaryBanner";
import type { PollSummary, MatchOverride } from "@/lib/api";
import AnnouncementMarquee from "@/components/AnnouncementMarquee";
import { getSocket, connectSocket } from "@/lib/socket";

const PAGE_SIZE = 10;

const Index = () => {
  const matches = useMatches();
  const { user } = useAuth();
  const { activeRoom, loading: roomLoading } = useRoom();
  const navigate = useNavigate();
  const [myVotes, setMyVotes] = useState<Record<string, string>>({});
  const [voteCounts, setVoteCounts] = useState<Record<string, Record<string, number>>>();
  const [allVotes, setAllVotes] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<Record<string, MatchResult>>({});
  const [overrides, setOverrides] = useState<Record<string, MatchOverride>>({});
  const [announcement, setAnnouncement] = useState("");
  const [liveScores, setLiveScores] = useState<Record<string, { score: string | null; status: string | null; updatedAt: string }>>({});
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  // Pagination for upcoming
  const [upcomingPage, setUpcomingPage] = useState(1);
  const [summary, setSummary] = useState<PollSummary | null>(null);
  const [showSummary, setShowSummary] = useState(false);

  const loadData = useCallback(async () => {
    if (!activeRoom) return;
    try {
      const [votes, counts, r, ovs, ann, liveScoreData] = await Promise.all([
        api.getVotes(activeRoom.id),
        api.getVoteCounts(activeRoom.id),
        api.getResults(),
        api.getMatchOverrides(),
        api.getAnnouncement(),
        api.getLiveScores(),
      ]);
      if (user) {
        const mine: Record<string, string> = {};
        for (const [matchId, matchVotes] of Object.entries(votes)) {
          if (matchVotes[user.username]) {
            mine[matchId] = matchVotes[user.username];
          }
        }
        setMyVotes(mine);
      }
      setAllVotes(votes);
      setVoteCounts(counts);
      setResults(r);

      const ovMap: Record<string, MatchOverride> = {};
      ovs.forEach(o => { ovMap[o.match_id] = o; });
      setOverrides(ovMap);
      setAnnouncement(ann.text);
      setLiveScores(liveScoreData);
    } catch {
      // API not available
    }
  }, [user, activeRoom]);

  useEffect(() => {
    if (!user) { navigate("/login"); return; }
    if (!roomLoading && !activeRoom) { navigate("/rooms"); return; }
    loadData();

    registerServiceWorker();
    isPushSubscribed().then(setPushSubscribed);

    // Check for last poll summary - only on first load after login
    const isJustLoggedIn = sessionStorage.getItem("justLoggedIn") === "true";
    if (isJustLoggedIn) {
      api.getLastPollSummary().then((res) => {
        if (res && !res.noData) {
          setSummary(res);
          setShowSummary(true);
        }
        sessionStorage.removeItem("justLoggedIn");
      }).catch(() => {
        sessionStorage.removeItem("justLoggedIn");
      });
    }

    const id = setInterval(loadData, 30000);
    return () => clearInterval(id);
  }, [user, navigate, loadData, activeRoom, roomLoading]);

  // Real-time live score updates via Socket.IO
  useEffect(() => {
    const sock = getSocket();
    const liveScoreHandler = (data: { matchId: string; score: string | null; status: string | null; updatedAt: string }) => {
      setLiveScores(prev => ({ ...prev, [data.matchId]: data }));
    };
    const resultUpdatedHandler = () => { loadData(); };
    sock.on('live_score', liveScoreHandler);
    sock.on('result_updated', resultUpdatedHandler);
    if (!sock.connected) connectSocket();
    return () => {
      sock.off('live_score', liveScoreHandler);
      sock.off('result_updated', resultUpdatedHandler);
    };
  }, [loadData]);

  const handlePushToggle = async () => {
    setPushLoading(true);
    try {
      if (pushSubscribed) {
        await unsubscribeFromPush();
        setPushSubscribed(false);
      } else {
        const ok = await subscribeToPush();
        setPushSubscribed(ok);
      }
    } catch {
      // ignore
    } finally {
      setPushLoading(false);
    }
  };

  const handleVote = async (matchId: string, prediction: string, isBulk?: boolean) => {
    if (!activeRoom) return;
    try {
      if (isBulk) {
        await api.bulkVote(matchId, prediction);
      } else {
        await api.vote(matchId, prediction, activeRoom.id);
      }
      await loadData();
    } catch {}
  };

  // Memoized Lists
  const openPolls = useMemo(() => getPollOpenMatches(matches, results, overrides), [matches, results, overrides]);

  const pastMatches = useMemo(() => {
    return matches.filter(m => results[m.id]).reverse();
  }, [matches, results]);

  const upcomingLocked = useMemo(() => {
    const openIds = new Set(openPolls.map(o => o.id));
    return matches.filter(m => !results[m.id] && !openIds.has(m.id));
  }, [matches, results, openPolls]);

  const paginatedUpcoming = useMemo(() => {
    return upcomingLocked.slice((upcomingPage - 1) * PAGE_SIZE, upcomingPage * PAGE_SIZE);
  }, [upcomingLocked, upcomingPage]);

  const totalUpcomingPages = Math.ceil(upcomingLocked.length / PAGE_SIZE);

  if (!user) return null;

  const completedCount = Object.keys(results).length;

  if (roomLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!activeRoom) {
    return null; // Side effect in useEffect will handle redirect
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      {showSummary && summary && (
        <PollSummaryBanner 
          summary={summary} 
          onClose={() => {
            setShowSummary(false);
          }} 
        />
      )}

      <main className="container mx-auto px-4 py-8 max-w-2xl relative z-10">
        <AnnouncementMarquee text={announcement} />
        
        {/* Active Room Indicator */}
        <div className="mb-6 flex items-center justify-between rounded-2xl border border-primary/20 bg-primary/5 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/20 text-primary">
              <Users size={20} />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Active Room</p>
              <h3 className="font-display text-2xl text-foreground leading-none">{activeRoom.name}</h3>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {'Notification' in window && (
              <button
                onClick={handlePushToggle}
                disabled={pushLoading}
                title={pushSubscribed ? 'Disable notifications' : 'Enable notifications'}
                className="flex items-center justify-center rounded-lg border border-border bg-background p-1.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {pushSubscribed ? <Bell size={15} className="text-primary" /> : <BellOff size={15} />}
              </button>
            )}
            <button
              onClick={() => navigate("/rooms")}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Switch Room
            </button>
          </div>
        </div>

        {/* Active / Live Polls */}
        <OpenPolls
          openPolls={openPolls}
          voteCounts={voteCounts ?? {}}
          myVotes={myVotes}
          allVotes={allVotes}
          onVote={handleVote}
          completedCount={completedCount}
          totalMatchCount={matches.length}
          results={results}
          overrides={overrides}
          roomId={activeRoom.id}
          liveScores={liveScores}
        />

        {/* Completed Matches – horizontal scrolling cards */}
        <CompletedMatches
          pastMatches={pastMatches}
          paginatedPast={pastMatches}
          pastPage={1}
          totalPastPages={1}
          setPastPage={() => {}}
          voteCounts={voteCounts ?? {}}
          myVotes={myVotes}
          results={results}
          onVote={handleVote}
          roomId={activeRoom.id}
        />

        {/* Upcoming Matches */}
        <UpcomingMatches
          upcomingLocked={upcomingLocked}
          paginatedUpcoming={paginatedUpcoming}
          upcomingPage={upcomingPage}
          totalUpcomingPages={totalUpcomingPages}
          setUpcomingPage={setUpcomingPage}
          roomId={activeRoom.id}
          overrides={overrides}
        />

        <Footer />
      </main>
    </div>
  );
};

export default Index;
