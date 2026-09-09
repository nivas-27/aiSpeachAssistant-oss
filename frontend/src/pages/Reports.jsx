import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  ChartFrame,
  EmptyChart,
  RankedBars,
  ScoreGauge,
  StatTile,
  TimeBarChart,
  TrendLineChart,
} from "../components/charts/Charts";
import MethodologyPanel from "../components/MethodologyPanel";
import { fetchReport, fetchSessionDetail } from "../apiCalls/endpoints";
import "./Reports.css";

function formatDuration(seconds) {
  if (!seconds) return "0m";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function scoreBand(score) {
  if (score >= 80) return { label: "Strong", tone: "good" };
  if (score >= 60) return { label: "Developing", tone: "ok" };
  if (score >= 35) return { label: "Building", tone: "warn" };
  return { label: "Getting started", tone: "low" };
}

/** Accessible fallback for any chart: the same numbers as a table. */
function DataTable({ columns, rows }) {
  return (
    <div className="data-table-wrap hide-scrollbar">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key || index}>
              {columns.map((column) => (
                <td key={column.key}>{row[column.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ViewToggle({ isTable, onToggle }) {
  return (
    <button type="button" className="view-toggle" onClick={onToggle}>
      <span className="material-symbols-outlined">{isTable ? "bar_chart" : "table_rows"}</span>
      <span>{isTable ? "Chart" : "Table"}</span>
    </button>
  );
}

function SessionDrawer({ sessionId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");

  // The drawer is keyed on sessionId by its parent, so a different session
  // remounts this component with fresh state - no resetting inside the effect.
  useEffect(() => {
    let cancelled = false;

    fetchSessionDetail(sessionId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message || "Could not load this session.");
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const onKeyDown = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="drawer"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Session transcript"
      >
        <header className="drawer-head">
          <div>
            <h2>Session transcript</h2>
            {detail && (
              <p className="drawer-sub">
                {new Date(detail.summary.started_at).toLocaleString()} ·{" "}
                {formatDuration(detail.summary.duration_seconds)}
              </p>
            )}
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        {error && (
          <p className="form-alert" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </p>
        )}

        {!detail && !error && (
          <div className="drawer-loading">
            <span className="spinner spinner-light" />
            <span>Loading transcript…</span>
          </div>
        )}

        {detail && (
          <>
            <div className="drawer-stats">
              <div>
                <span>{detail.summary.exchanges}</span>
                <small>Exchanges</small>
              </div>
              <div>
                <span>{detail.summary.words_spoken}</span>
                <small>Words</small>
              </div>
              <div>
                <span>{detail.summary.avg_words_per_turn}</span>
                <small>Per turn</small>
              </div>
              <div>
                <span>{detail.summary.filler_rate}%</span>
                <small>Fillers</small>
              </div>
            </div>

            <div className="drawer-transcript hide-scrollbar">
              {detail.transcript.length === 0 ? (
                <p className="drawer-empty">This session has no recorded speech.</p>
              ) : (
                detail.transcript.map((turn, index) => (
                  <div key={index} className={`transcript-turn ${turn.role}`}>
                    <span className="transcript-role">{turn.role === "user" ? "You" : "AI"}</span>
                    <p>{turn.content}</p>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export default function Reports() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activityTable, setActivityTable] = useState(false);
  const [progressTable, setProgressTable] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();
  const openSession = searchParams.get("session");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReport(await fetchReport());
    } catch (loadError) {
      setError(loadError.message || "Could not load your report.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const closeDrawer = useCallback(() => {
    searchParams.delete("session");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  if (loading) {
    return (
      <div className="reports-loading" role="status">
        <span className="spinner spinner-light" />
        <span>Building your report…</span>
      </div>
    );
  }

  if (error) {
    return (
      <p className="form-alert" role="alert">
        <span className="material-symbols-outlined">error</span>
        <span>{error}</span>
        <button type="button" className="alert-retry" onClick={load}>
          Retry
        </button>
      </p>
    );
  }

  const { overview, activity, progress, vocabulary, sessions } = report;
  const { totals, quality, streak, latency } = overview;
  const hasData = totals.sessions > 0;
  const hasSpeech = totals.exchanges > 0;
  const band = scoreBand(quality.fluency_score);

  if (!hasData) {
    return (
      <div className="reports">
        <header className="reports-header">
          <h1>Reports &amp; analytics</h1>
          <p>Everything here is measured from your own recorded speech.</p>
        </header>
        <div className="reports-empty">
          <span className="material-symbols-outlined">monitoring</span>
          <h2>No sessions yet</h2>
          <p>
            Finish a practice session and this page will fill up with your fluency trend,
            vocabulary range and filler-word habits.
          </p>
        </div>
        <MethodologyPanel />
      </div>
    );
  }

  return (
    <div className="reports">
      <header className="reports-header">
        <div>
          <h1>Reports &amp; analytics</h1>
          <p>Measured from {totals.exchanges} recorded turns across {totals.sessions} session
            {totals.sessions === 1 ? "" : "s"}.</p>
        </div>
      </header>

      {/* ── Headline score ─────────────────────────────────────────────── */}
      <section className="score-panel">
        <ScoreGauge score={quality.fluency_score} caption="Fluency" />
        <div className="score-copy">
          <span className={`score-band ${band.tone}`}>{band.label}</span>
          <h2>
            You average {quality.avg_words_per_turn} words each time you speak.
          </h2>
          <p>
            The score blends three measured signals: how much you say per turn (40%), how varied
            your vocabulary is (35%), and how rarely you fall back on filler words (25%).
          </p>
          <ul className="score-breakdown">
            <li>
              <span className="material-symbols-outlined">chat_bubble</span>
              <strong>{quality.avg_words_per_turn}</strong> words per turn
            </li>
            <li>
              <span className="material-symbols-outlined">diversity_2</span>
              <strong>{quality.vocabulary_diversity}%</strong> unique-word ratio
            </li>
            <li>
              <span className="material-symbols-outlined">speaker_notes_off</span>
              <strong>{quality.filler_rate}%</strong> filler rate
            </li>
          </ul>
        </div>
      </section>

      <MethodologyPanel />

      {/* ── KPI tiles ──────────────────────────────────────────────────── */}
      <section className="stat-grid">
        <StatTile
          icon="schedule"
          label="Practice time"
          value={Math.round(totals.practice_minutes)}
          unit="min"
          hint={`${quality.avg_session_minutes} min average per session`}
        />
        <StatTile
          icon="record_voice_over"
          label="Words spoken"
          value={totals.words_spoken.toLocaleString()}
          hint={`${totals.vocabulary_size} unique words used`}
          accent="var(--ai-color)"
        />
        <StatTile
          icon="local_fire_department"
          label="Current streak"
          value={streak.current_days}
          unit={streak.current_days === 1 ? "day" : "days"}
          hint={`Longest: ${streak.longest_days} day${streak.longest_days === 1 ? "" : "s"}`}
          accent="var(--warn)"
        />
        <StatTile
          icon="bolt"
          label="Reply latency"
          value={(latency.avg_llm_ms / 1000).toFixed(1)}
          unit="s"
          hint={`Transcription ${(latency.avg_stt_ms / 1000).toFixed(1)}s · speech ${(
            latency.avg_tts_ms / 1000
          ).toFixed(1)}s`}
        />
      </section>

      {/* ── Activity ───────────────────────────────────────────────────── */}
      <ChartFrame
        title="Practice activity"
        subtitle="Minutes spoken per day over the last 30 days"
        actions={
          <ViewToggle isTable={activityTable} onToggle={() => setActivityTable((v) => !v)} />
        }
      >
        {activityTable ? (
          <DataTable
            columns={[
              { key: "date", label: "Date" },
              { key: "sessions", label: "Sessions" },
              { key: "minutes", label: "Minutes" },
              { key: "words", label: "Words" },
            ]}
            rows={activity
              .filter((day) => day.sessions > 0)
              .map((day) => ({ ...day, key: day.date }))}
          />
        ) : (
          <TimeBarChart data={activity} valueKey="minutes" label="practised" unit=" min" />
        )}
      </ChartFrame>

      {/* ── Trends ─────────────────────────────────────────────────────── */}
      <div className="chart-pair">
        <ChartFrame
          title="Fluency trend"
          subtitle="Average words per turn, session by session"
          actions={
            progress.length > 1 ? (
              <ViewToggle isTable={progressTable} onToggle={() => setProgressTable((v) => !v)} />
            ) : null
          }
        >
          {progress.length < 2 ? (
            <EmptyChart
              icon="show_chart"
              message="Finish one more session to see how your fluency is trending."
            />
          ) : progressTable ? (
            <DataTable
              columns={[
                { key: "date", label: "Date" },
                { key: "avg_words_per_turn", label: "Words / turn" },
                { key: "filler_rate", label: "Filler %" },
                { key: "unique_words", label: "Unique words" },
              ]}
              rows={progress.map((row) => ({ ...row, key: row.session_id }))}
            />
          ) : (
            <TrendLineChart
              data={progress}
              valueKey="avg_words_per_turn"
              label="words per turn"
              color="var(--series-1)"
            />
          )}
        </ChartFrame>

        <ChartFrame
          title="Filler-word rate"
          subtitle="Fillers per 100 words — lower is better"
        >
          {progress.length < 2 ? (
            <EmptyChart
              icon="speaker_notes_off"
              message="Two or more sessions are needed before a habit trend means anything."
            />
          ) : (
            <TrendLineChart
              data={progress}
              valueKey="filler_rate"
              label="% fillers"
              color="var(--series-2)"
            />
          )}
        </ChartFrame>
      </div>

      {/* ── Vocabulary ─────────────────────────────────────────────────── */}
      <div className="chart-pair">
        <ChartFrame
          title="Words you reach for most"
          subtitle="Excluding common connecting words"
          meta={`${totals.vocabulary_size} unique`}
        >
          {vocabulary.top_words.length === 0 ? (
            <EmptyChart icon="menu_book" message="Speak a little more to build a vocabulary profile." />
          ) : (
            <RankedBars items={vocabulary.top_words.slice(0, 10)} color="var(--series-1)" />
          )}
        </ChartFrame>

        <ChartFrame
          title="Filler habits"
          subtitle="The crutches worth dropping first"
          meta={hasSpeech ? `${quality.filler_count} total` : null}
        >
          {vocabulary.top_fillers.length === 0 ? (
            <EmptyChart
              icon="check_circle"
              message="No filler words detected yet — that is a good sign."
            />
          ) : (
            <RankedBars items={vocabulary.top_fillers} color="var(--series-2)" />
          )}
        </ChartFrame>
      </div>

      {/* ── Session history ────────────────────────────────────────────── */}
      <ChartFrame title="Session history" subtitle="Select a session to read its transcript">
        <div className="data-table-wrap hide-scrollbar">
          <table className="data-table sessions-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Length</th>
                <th scope="col">Exchanges</th>
                <th scope="col">Words</th>
                <th scope="col">Per turn</th>
                <th scope="col">Fillers</th>
                <th scope="col" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  className="session-table-row"
                  onClick={() => setSearchParams({ session: session.id })}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSearchParams({ session: session.id });
                    }
                  }}
                >
                  <td>{new Date(session.started_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}</td>
                  <td>{formatDuration(session.duration_seconds)}</td>
                  <td>{session.exchanges}</td>
                  <td>{session.words_spoken}</td>
                  <td>{session.avg_words_per_turn}</td>
                  <td>{session.filler_rate}%</td>
                  <td>
                    <span className="material-symbols-outlined table-chevron">chevron_right</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartFrame>

      {openSession && (
        <SessionDrawer key={openSession} sessionId={openSession} onClose={closeDrawer} />
      )}
    </div>
  );
}
