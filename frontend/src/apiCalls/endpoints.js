import { apiFetch } from "./client";

/* ─── Auth ──────────────────────────────────────────────────────────────── */

/** Step 1 of signup. Issues a code; no account exists yet. */
export const requestSignupOtp = (payload) =>
  apiFetch("/auth/signup", { method: "POST", body: payload, auth: false });

/** Step 2 of signup. A correct code creates the account and returns a token. */
export const verifySignupOtp = (email, code) =>
  apiFetch("/auth/signup/verify", { method: "POST", body: { email, code }, auth: false });

export const resendSignupOtp = (email) =>
  apiFetch("/auth/signup/resend", { method: "POST", body: { email }, auth: false });

export const loginRequest = (payload) =>
  apiFetch("/auth/login", { method: "POST", body: payload, auth: false });

export const forgotPassword = (email) =>
  apiFetch("/auth/forgot-password", { method: "POST", body: { email }, auth: false });

export const resetPassword = (email, code, password) =>
  apiFetch("/auth/reset-password", {
    method: "POST",
    body: { email, code, password },
    auth: false,
  });

export const fetchMe = () => apiFetch("/auth/me");

/* ─── Practice sessions ─────────────────────────────────────────────────── */

export const createPracticeSession = () => apiFetch("/sessions", { method: "POST" });

export const endPracticeSession = (sessionId, { spoken = false } = {}) =>
  apiFetch(`/sessions/${sessionId}/end${spoken ? "?spoken=true" : ""}`, { method: "POST" });

export const listSessions = () => apiFetch("/sessions");

/* ─── Analytics ─────────────────────────────────────────────────────────── */

export const fetchOverview = () => apiFetch("/analytics/overview");

export const fetchReport = () => apiFetch("/analytics/report");

export const fetchMethodology = () => apiFetch("/analytics/methodology");

export const fetchSessionDetail = (sessionId) => apiFetch(`/analytics/sessions/${sessionId}`);
