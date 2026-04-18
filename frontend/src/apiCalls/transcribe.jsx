import { BACKEND_ENDPOINTS } from "./backendEndpoints";

const getTranscribe = async (payload) => {
    const response = await fetch(`${import.meta.env.BACKEND_URL}${BACKEND_ENDPOINTS.TRANSCRIBE}`, {
        method: "POST",
        body: payload,
      });
    
    return response;
}

export { getTranscribe }