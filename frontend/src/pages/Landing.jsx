import { Link } from "react-router-dom";

import "./Landing.css";

const FEATURES = [
  {
    icon: "graphic_eq",
    title: "Speak, don't type",
    body: "Talk to the assistant out loud and hear it answer back. Every session is a real spoken conversation, not a chat window.",
  },
  {
    icon: "bolt",
    title: "Replies while you wait",
    body: "The answer is spoken sentence by sentence as it is generated, so the conversation keeps the rhythm of a real one.",
  },
  {
    icon: "psychology",
    title: "It always asks back",
    body: "The assistant ends every reply with one relevant follow-up question, so you are never left staring at silence.",
  },
  {
    icon: "monitoring",
    title: "Progress you can see",
    body: "Words per turn, vocabulary range and filler-word rate are measured from your own transcripts, session after session.",
  },
];

const STEPS = [
  { n: "01", title: "Create your account", body: "Takes a few seconds. No card, no setup." },
  { n: "02", title: "Join a 20-minute room", body: "Press the mic, speak naturally, and listen to the reply." },
  { n: "03", title: "Read your report", body: "See what improved and which habits to drop next time." },
];

const METRICS = [
  { value: "20", unit: "min", label: "Focused practice per session" },
  { value: "3", unit: "signals", label: "Fluency, range and filler rate" },
  { value: "100%", unit: "", label: "Measured from your own speech" },
];

export default function Landing() {
  return (
    <div className="landing">
      <div className="glow landing-glow-1" />
      <div className="glow landing-glow-2" />

      <header className="landing-nav">
        <div className="landing-brand">
          <span className="landing-brand-dot" />
          <span className="landing-brand-name">Fluently</span>
        </div>
        <div className="landing-nav-actions">
          <Link to="/login" className="btn btn-quiet">
            Sign in
          </Link>
          <Link to="/signup" className="btn btn-primary">
            Get started
          </Link>
        </div>
      </header>

      <main>
        <section className="hero">
          <span className="hero-badge">
            <span className="hero-badge-dot" />
            Speech-to-speech English practice
          </span>

          <h1 className="hero-title">
            Practise English by <em>actually speaking it</em>.
          </h1>

          <p className="hero-sub">
            Fluently is a voice room with an AI partner that listens, replies out loud, and keeps
            the conversation going. Twenty minutes at a time — then it shows you exactly how you
            sounded.
          </p>

          <div className="hero-actions">
            <Link to="/signup" className="btn btn-primary hero-cta">
              <span className="material-symbols-outlined">mic</span>
              Start practising free
            </Link>
            <Link to="/login" className="btn btn-ghost hero-cta">
              I already have an account
            </Link>
          </div>

          <ul className="hero-metrics">
            {METRICS.map((metric) => (
              <li key={metric.label}>
                <span className="hero-metric-value">
                  {metric.value}
                  {metric.unit && <i>{metric.unit}</i>}
                </span>
                <span className="hero-metric-label">{metric.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-section">
          <h2 className="section-title">Built around speaking, not reading</h2>
          <div className="feature-grid">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="feature-card">
                <span className="material-symbols-outlined feature-icon">{feature.icon}</span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section">
          <h2 className="section-title">How a session works</h2>
          <ol className="step-row">
            {STEPS.map((step) => (
              <li key={step.n} className="step-card">
                <span className="step-number">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="cta-band">
          <h2>Your next conversation is 20 minutes long.</h2>
          <p>Create an account and start the first one now.</p>
          <Link to="/signup" className="btn btn-primary hero-cta">
            <span className="material-symbols-outlined">arrow_forward</span>
            Create your account
          </Link>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Fluently — AI speech practice</span>
        <span>Needs a microphone and a modern browser</span>
      </footer>
    </div>
  );
}
