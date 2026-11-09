import { authHeaders, BASE_URL, readApiError } from "./client";
import { BACKEND_ENDPOINTS } from "./backendEndpoints";

const getTranscribe = async (payload) => {
  const response = await fetch(`${BASE_URL}${BACKEND_ENDPOINTS.TRANSCRIBE}`, {
    method: "POST",
    // No Content-Type here on purpose: the browser sets the multipart boundary.
    headers: { ...authHeaders() },
    body: payload,
  });

  return response;
};

const streamTranscribe = async (payload, onEvent) => {
  const response = await getTranscribe(payload);

  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch {
      detail = null;
    }
    const error = new Error(
      readApiError(detail, `Transcribe request failed (${response.status})`)
    );
    error.status = response.status;
    throw error;
  }

  if (!response.body) {
    throw new Error("Streaming response body is not available.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      await onEvent(JSON.parse(trimmed));
    }

    if (done) {
      break;
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    await onEvent(JSON.parse(trailing));
  }
};

export { getTranscribe, streamTranscribe };
