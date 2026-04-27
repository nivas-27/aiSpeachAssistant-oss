import { BACKEND_ENDPOINTS } from "./backendEndpoints";

const getSession = async () => {
  const response = await fetch(
    `${import.meta.env.VITE_BACKEND_URL}${BACKEND_ENDPOINTS.SESSION}`
  );
  return response;
};

const getTranscribe = async (payload) => {
  const response = await fetch(
    `${import.meta.env.VITE_BACKEND_URL}${BACKEND_ENDPOINTS.TRANSCRIBE}`,
    {
      method: "POST",
      body: payload,
    }
  );

  return response;
};

export { getSession, getTranscribe };