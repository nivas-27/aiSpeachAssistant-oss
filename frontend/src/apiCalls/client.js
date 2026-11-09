const BASE_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8110";
const TOKEN_KEY = "aiSpeech_token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked - session stays in memory only */
  }
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Turns FastAPI's several error shapes into one readable sentence. */
export function readApiError(payload, fallback) {
  const detail = payload?.detail;

  if (typeof detail === "string") return detail;

  // Pydantic validation errors arrive as a list of {loc, msg}
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0];
    const message = (first?.msg || "").replace(/^Value error,\s*/i, "");
    return message || fallback;
  }

  if (typeof payload?.message === "string") return payload.message;
  return fallback;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch(path, { method = "GET", body, auth = true, signal } = {}) {
  const headers = { ...(auth ? authHeaders() : {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is the backend running?", 0);
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(
      readApiError(payload, `Request failed (${response.status})`),
      response.status
    );
  }

  return payload;
}

export { BASE_URL, TOKEN_KEY };
