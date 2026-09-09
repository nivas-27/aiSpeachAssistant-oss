import { useEffect, useState } from "react";

import { fetchMethodology } from "../apiCalls/endpoints";
import "./MethodologyPanel.css";

/**
 * Explains where every figure on the report comes from. The content is served
 * by the backend, from the same module that computes the numbers, so the
 * explanation cannot drift away from the implementation.
 */
export default function MethodologyPanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || data) return undefined;

    let cancelled = false;
    fetchMethodology()
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message || "Could not load the calculation notes.");
      });

    return () => {
      cancelled = true;
    };
  }, [open, data]);

  return (
    <section className={`methodology ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="methodology-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="methodology-body"
      >
        <span className="material-symbols-outlined methodology-icon">function</span>
        <span className="methodology-heading">
          <span className="methodology-title">How this report is calculated</span>
          <span className="methodology-sub">
            Every figure, and the exact formula behind it
          </span>
        </span>
        <span className="material-symbols-outlined methodology-caret">expand_more</span>
      </button>

      <div id="methodology-body" className="methodology-body" hidden={!open}>
        {error && (
          <p className="form-alert" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </p>
        )}

        {!data && !error && (
          <div className="methodology-loading">
            <span className="spinner spinner-light" />
            <span>Loading…</span>
          </div>
        )}

        {data && (
          <>
            <p className="methodology-principle">{data.principle}</p>

            <dl className="methodology-list">
              {data.metrics.map((metric) => (
                <div key={metric.name} className="methodology-item">
                  <dt>{metric.name}</dt>
                  <dd>
                    <code className="methodology-formula">{metric.formula}</code>
                    <p>{metric.detail}</p>
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
