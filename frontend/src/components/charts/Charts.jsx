import { useMemo, useState } from "react";

import "./Charts.css";

/* Chart geometry is expressed in a fixed viewBox and scaled by CSS, so a
   tooltip's screen position is just its share of the viewBox width. */
const VB_W = 720;
const VB_H = 240;
const PAD = { top: 16, right: 14, bottom: 30, left: 42 };

const PLOT_W = VB_W - PAD.left - PAD.right;
const PLOT_H = VB_H - PAD.top - PAD.bottom;

/** Rounds the axis maximum up to a friendly number so ticks read cleanly. */
function niceMax(value) {
  if (!value || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function ticksFor(max, count = 4) {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

function formatTick(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/* ─── Shared chrome ──────────────────────────────────────────────────────── */

export function ChartFrame({ title, subtitle, meta, children, actions }) {
  return (
    <section className="chart-card">
      <header className="chart-head">
        <div>
          <h3 className="chart-title">{title}</h3>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
        {actions || (meta && <span className="chart-meta">{meta}</span>)}
      </header>
      {children}
    </section>
  );
}

export function EmptyChart({ icon = "insights", message }) {
  return (
    <div className="chart-empty">
      <span className="material-symbols-outlined">{icon}</span>
      <p>{message}</p>
    </div>
  );
}

function Tooltip({ x, align, children }) {
  return (
    <div
      className={`chart-tooltip ${align}`}
      style={{ left: `${(x / VB_W) * 100}%` }}
      role="tooltip"
    >
      {children}
    </div>
  );
}

function GridAndAxis({ max, tickCount = 4, formatY = formatTick }) {
  return (
    <g aria-hidden="true">
      {ticksFor(max, tickCount).map((tick) => {
        const y = PAD.top + PLOT_H - (tick / max) * PLOT_H;
        return (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={y}
              y2={y}
              className="chart-grid"
            />
            <text x={PAD.left - 9} y={y + 3.5} className="chart-axis-label" textAnchor="end">
              {formatY(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/* ─── Vertical bars over time ────────────────────────────────────────────── */

export function TimeBarChart({ data, valueKey, label, unit = "", color = "var(--series-1)" }) {
  const [hover, setHover] = useState(null);

  const max = useMemo(
    () => niceMax(Math.max(...data.map((d) => d[valueKey]), 0)),
    [data, valueKey]
  );

  const slot = PLOT_W / data.length;
  // 2px surface gap between adjacent bars, thin marks.
  const barW = Math.max(3, Math.min(18, slot - 2));

  return (
    <div className="chart-plot">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="chart-svg" role="img"
        aria-label={`${label} per day for the last ${data.length} days`}>
        <GridAndAxis max={max} />

        {data.map((point, index) => {
          const value = point[valueKey];
          const h = value > 0 ? Math.max(3, (value / max) * PLOT_H) : 0;
          const x = PAD.left + index * slot + (slot - barW) / 2;
          const y = PAD.top + PLOT_H - h;
          const isHovered = hover?.index === index;

          return (
            <g key={point.date}>
              {h > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={Math.min(4, barW / 2)}
                  fill={color}
                  opacity={hover && !isHovered ? 0.42 : 1}
                  className="chart-bar"
                />
              )}
              {/* Hit target spans the full slot height - easier than the mark. */}
              <rect
                x={PAD.left + index * slot}
                y={PAD.top}
                width={slot}
                height={PLOT_H}
                fill="transparent"
                onMouseEnter={() => setHover({ index, x: x + barW / 2 })}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}

        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
          className="chart-axis-line"
        />

        {data.map((point, index) =>
          index % 7 === 0 ? (
            <text
              key={`t-${point.date}`}
              x={PAD.left + index * slot + slot / 2}
              y={VB_H - 10}
              className="chart-axis-label"
              textAnchor="middle"
            >
              {new Date(`${point.date}T00:00:00`).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </text>
          ) : null
        )}
      </svg>

      {hover && (
        <Tooltip
          x={hover.x}
          align={hover.x > VB_W * 0.7 ? "end" : hover.x < VB_W * 0.3 ? "start" : "mid"}
        >
          <span className="tt-date">
            {new Date(`${data[hover.index].date}T00:00:00`).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </span>
          <span className="tt-value">
            <i className="tt-swatch" style={{ background: color }} />
            {data[hover.index][valueKey]}
            {unit} {label}
          </span>
          <span className="tt-sub">
            {data[hover.index].sessions} session
            {data[hover.index].sessions === 1 ? "" : "s"}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

/* ─── Line with crosshair ────────────────────────────────────────────────── */

export function TrendLineChart({ data, valueKey, label, unit = "", color = "var(--series-1)" }) {
  const [hover, setHover] = useState(null);

  const max = useMemo(
    () => niceMax(Math.max(...data.map((d) => d[valueKey]), 0)),
    [data, valueKey]
  );

  const stepX = data.length > 1 ? PLOT_W / (data.length - 1) : 0;
  const pointAt = (index) => ({
    x: PAD.left + (data.length > 1 ? index * stepX : PLOT_W / 2),
    y: PAD.top + PLOT_H - (data[index][valueKey] / max) * PLOT_H,
  });

  const points = data.map((_, index) => pointAt(index));
  const linePath = points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const areaPath = points.length
    ? `${linePath} L${points[points.length - 1].x},${PAD.top + PLOT_H} L${points[0].x},${
        PAD.top + PLOT_H
      } Z`
    : "";

  const gradientId = `grad-${valueKey}`;

  const handleMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relative = ((event.clientX - rect.left) / rect.width) * VB_W;
    const index = data.length > 1
      ? Math.round((relative - PAD.left) / stepX)
      : 0;
    const clamped = Math.max(0, Math.min(data.length - 1, index));
    setHover({ index, ...pointAt(clamped), realIndex: clamped });
  };

  return (
    <div className="chart-plot">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="chart-svg"
        role="img"
        aria-label={`${label} across your recent sessions`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        <GridAndAxis max={max} />

        {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
        <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"
          strokeLinejoin="round" />

        {points.map((p, index) => (
          <circle
            key={data[index].session_id || index}
            cx={p.x}
            cy={p.y}
            r={hover?.realIndex === index ? 5.5 : 4}
            fill={color}
            stroke="var(--surface-container)"
            strokeWidth="2"
          />
        ))}

        {hover && (
          <line
            x1={hover.x}
            x2={hover.x}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            className="chart-crosshair"
          />
        )}

        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
          className="chart-axis-line"
        />

        {data.map((point, index) => (
          <text
            key={`lbl-${point.session_id || index}`}
            x={points[index].x}
            y={VB_H - 10}
            className="chart-axis-label"
            textAnchor="middle"
          >
            {point.label}
          </text>
        ))}
      </svg>

      {hover && data[hover.realIndex] && (
        <Tooltip
          x={hover.x}
          align={hover.x > VB_W * 0.7 ? "end" : hover.x < VB_W * 0.3 ? "start" : "mid"}
        >
          <span className="tt-date">
            {new Date(`${data[hover.realIndex].date}T00:00:00`).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
          <span className="tt-value">
            <i className="tt-swatch" style={{ background: color }} />
            {data[hover.realIndex][valueKey]}
            {unit} {label}
          </span>
          <span className="tt-sub">{data[hover.realIndex].words_spoken} words spoken</span>
        </Tooltip>
      )}
    </div>
  );
}

/* ─── Ranked horizontal bars ─────────────────────────────────────────────── */

export function RankedBars({ items, labelKey = "word", valueKey = "count", color = "var(--series-1)" }) {
  const max = Math.max(...items.map((item) => item[valueKey]), 1);

  return (
    <ul className="ranked-list">
      {items.map((item) => (
        <li key={item[labelKey]} className="ranked-row">
          <span className="ranked-label" title={item[labelKey]}>
            {item[labelKey]}
          </span>
          <span className="ranked-track">
            <span
              className="ranked-fill"
              style={{
                width: `${Math.max(4, (item[valueKey] / max) * 100)}%`,
                background: color,
              }}
            />
          </span>
          <span className="ranked-value">{item[valueKey]}</span>
        </li>
      ))}
    </ul>
  );
}

/* ─── Stat tile & hero number ────────────────────────────────────────────── */

export function StatTile({ icon, label, value, unit, hint, accent = "var(--primary)" }) {
  return (
    <div className="stat-tile">
      <span className="stat-icon material-symbols-outlined" style={{ color: accent }}>
        {icon}
      </span>
      <div className="stat-body">
        <p className="stat-label">{label}</p>
        <p className="stat-value">
          {value}
          {unit && <span className="stat-unit">{unit}</span>}
        </p>
        {hint && <p className="stat-hint">{hint}</p>}
      </div>
    </div>
  );
}

export function ScoreGauge({ score, caption }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, score)) / 100) * circumference;

  return (
    <div className="gauge">
      <svg viewBox="0 0 140 140" className="gauge-svg" role="img"
        aria-label={`Fluency score ${score} out of 100`}>
        <circle cx="70" cy="70" r={radius} className="gauge-track" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          className="gauge-value"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 70 70)"
        />
      </svg>
      <div className="gauge-center">
        <span className="gauge-number">{score}</span>
        <span className="gauge-caption">{caption}</span>
      </div>
    </div>
  );
}
