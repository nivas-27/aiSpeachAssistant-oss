import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { StatTile } from "../components/charts/Charts";
import { useAuth } from "../context/auth-context";
import { fetchOverview, listSessions } from "../apiCalls/endpoints";
import "./Home.css";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatDuration(seconds) {
  if (!seconds) return "0m";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatDate(iso) {
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) {
    return `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [overview, setOverview] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [overviewData, sessionData] = await Promise.all([fetchOverview(), listSessions()]);
      setOverview(overviewData);
      setSessions(sessionData.sessions || []);
    } catch (loadError) {
      setError(loadError.message || "Could not load your dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totals = overview?.totals;
  const quality = overview?.quality;
  const streak = overview?.streak;
  const hasPractised = Boolean(totals?.sessions);

  return (
    <div className="home">
      <header className="home-header">
        <div>
          <p className="home-greeting">{greeting()},</p>
          <h1 className="home-name">{user?.full_name?.split(" ")[0] || "there"}</h1>
        </div>
        {streak?.current_days > 0 && (
          <div className="streak-chip" title="Consecutive days with a practice session">
            <span className="material-symbols-outlined">local_fire_department</span>
            <span>
              <strong>{streak.current_days}</strong> day streak
            </span>
          </div>
        )}
      </header>

      <section className="start-panel">
        <div className="start-copy">
          <h2>Ready for a 20-minute conversation?</h2>
          <p>
            Join the voice room, press the mic and speak. The assistant replies out loud and always
            asks you something back.
          </p>
          <button
            type="button"
            className="btn btn-primary start-cta"
            onClick={() => navigate("/app/practice")}
          >
            <span className="material-symbols-outlined">mic</span>
            {hasPractised ? "Start a new session" : "Start your first session"}
          </button>
        </div>
        <div className="start-visual" aria-hidden="true">
          <div className="start-ring" />
          <div className="start-avatar">AI</div>
        </div>
      </section>

      {error && (
        <p className="form-alert home-alert" role="alert">
          <span className="material-symbols-outlined">error</span>
          <span>{error}</span>
          <button type="button" className="alert-retry" onClick={load}>
            Retry
          </button>
        </p>
      )}

      {loading ? (
        <div className="home-loading" role="status">
          <span className="spinner spinner-light" />
          <span>Loading your progress…</span>
        </div>
      ) : (
        <>
          <section className="stat-grid">
            <StatTile
              icon="forum"
              label="Sessions"
              value={totals?.sessions ?? 0}
              hint={`${totals?.completed_sessions ?? 0} completed`}
            />
            <StatTile
              icon="schedule"
              label="Practice time"
              value={Math.round(totals?.practice_minutes ?? 0)}
              unit="min"
              hint={`${totals?.exchanges ?? 0} exchanges`}
            />
            <StatTile
              icon="record_voice_over"
              label="Words spoken"
              value={(totals?.words_spoken ?? 0).toLocaleString()}
              hint={`${totals?.vocabulary_size ?? 0} unique words`}
              accent="var(--ai-color)"
            />
            <StatTile
              icon="trending_up"
              label="Fluency score"
              value={quality?.fluency_score ?? 0}
              unit="/100"
              hint={`${quality?.avg_words_per_turn ?? 0} words per turn`}
              accent="var(--ai-color)"
            />
          </section>

          <section className="home-recent">
            <header className="home-recent-head">
              <h2>Recent sessions</h2>
              {hasPractised && (
                <Link to="/app/reports" className="home-link">
                  Full report
                  <span className="material-symbols-outlined">chevron_right</span>
                </Link>
              )}
            </header>

            {sessions.length === 0 ? (
              <div className="home-empty">
                <span className="material-symbols-outlined">mic_off</span>
                <p>You have not practised yet. Your first session will show up here.</p>
              </div>
            ) : (
              <ul className="session-list">
                {sessions.slice(0, 5).map((session) => (
                  <li key={session.id}>
                    <Link to={`/app/reports?session=${session.id}`} className="session-row">
                      <span className={`session-dot ${session.status}`} />
                      <span className="session-main">
                        <span className="session-date">{formatDate(session.started_at)}</span>
                        <span className="session-meta">
                          {session.exchanges} exchange{session.exchanges === 1 ? "" : "s"} ·{" "}
                          {session.words_spoken} words
                        </span>
                      </span>
                      <span className="session-duration">
                        {formatDuration(session.duration_seconds)}
                      </span>
                      <span className="material-symbols-outlined session-chevron">
                        chevron_right
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
