import { useEffect, useRef, useState } from "react";
import "./audioRecorder.css";
import { getSession, getTranscribe } from "../apiCalls/transcribe";
import { BACKEND_ENDPOINTS } from "../apiCalls/backendEndpoints";

const SESSION_ID_KEY = "aiSpeechAssistant_session_id";

function AudioRecorder() {
  const [recording, setRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);
  const chatScrollRef = useRef(null);

  const fetchSessionId = async () => {
    const cached = localStorage.getItem(SESSION_ID_KEY);
    if (cached) {
      return cached;
    }

    const response = await getSession();
    if (!response.ok) {
      throw new Error(`Session request failed: ${response.status}`);
    }

    const data = await response.json();
    const sessionId = data.session_id;
    if (!sessionId) {
      throw new Error("Session response missing session_id");
    }

    localStorage.setItem(SESSION_ID_KEY, sessionId);
    return sessionId;
  };

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    fetchSessionId().catch((error) => {
      console.error("Error creating session:", error);
    });
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        sendAudio(audioBlob);
      };

      mediaRecorder.start();
      setRecording(true);
    } catch (error) {
      console.error("Unable to access microphone:", error);
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current) {
      return;
    }

    mediaRecorderRef.current.stop();
    setRecording(false);
  };

  const getAudioFilename = (audioPath = "") => {
    if (!audioPath) {
      return "";
    }

    return audioPath.split(/[/\\]/).pop() || "";
  };

  const sendAudio = async (blob) => {
    setIsLoading(true);
    const formData = new FormData();
    let sessionId = localStorage.getItem(SESSION_ID_KEY);
    if (!sessionId) {
      try {
        sessionId = await fetchSessionId();
      } catch (error) {
        console.error("Error creating session:", error);
        setIsLoading(false);
        return;
      }
    }

    formData.append("file", blob, "recording.webm");
    formData.append("session_id", sessionId);

    try {
      const response = await getTranscribe(formData);

      if (!response.ok) {
        throw new Error(`Transcribe request failed: ${response.status}`);
      }

      const data = await response.json();
      const audioFilename = getAudioFilename(data.audio_file);
      const audioUrl = audioFilename
        ? `${import.meta.env.VITE_BACKEND_URL}${BACKEND_ENDPOINTS.AUDIO}/${encodeURIComponent(audioFilename)}`
        : "";

      const userText = data.transcription || "";
      const botReply = data.chat_response?.reply || "";
      const suggestion = data.chat_response?.suggestion || "";

      const timestamp = Date.now();
      setMessages((prev) => [
        ...prev,
        {
          id: `${timestamp}-user`,
          side: "right",
          role: "Me",
          text: userText,
        },
        {
          id: `${timestamp}-bot`,
          side: "left",
          role: "Assistant",
          text: botReply,
          suggestion,
          audioUrl,
        },
      ]);

      if (audioUrl && audioRef.current) {
        audioRef.current.src = audioUrl;
        try {
          await audioRef.current.play();
        } catch (playError) {
          console.error("Audio autoplay blocked:", playError);
        }
      }
    } catch (error) {
      console.error("Error sending audio:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const statusLabel = isLoading ? "Processing" : recording ? "Recording" : "Ready";
  const sessionTime = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="recorder-shell">
      <main className="recorder-main">
        <div className="chat-viewport hide-scrollbar" ref={chatScrollRef}>
          <div className="message-stack">
            <div className="message-row left entrance-left">
              <div className="assistant-card">
                <p className="message-text">
                  Hello. I am listening. How can I assist you with your vocal session today?
                </p>
              </div>
            </div>

            {messages.map((message) => (
              <div
                key={message.id}
                className={`message-row ${message.side === "right" ? "right entrance-right" : "left entrance-left"}`}
              >
                {message.side === "right" ? (
                  <div className="user-card">
                    <p className="message-text">{message.text}</p>
                  </div>
                ) : (
                  <div className="assistant-card">
                    {message.text ? <p className="message-text">{message.text}</p> : null}

                    {message.suggestion ? (
                      <div className="split-block split-border">
                        <span className="meta-label">Suggestion</span>
                        <p className="message-subtext">{message.suggestion}</p>
                      </div>
                    ) : null}

                    {message.audioUrl ? (
                      <div className="audio-block">
                        <audio controls src={message.audioUrl} className="chat-audio" />
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="record-dock">
          <div className="visualizer" aria-hidden="true">
            <span className="viz-bar bar-1" />
            <span className="viz-bar bar-2" />
            <span className="viz-bar bar-3" />
            <span className="viz-bar bar-4" />
            <span className="viz-bar bar-5" />
            <span className="viz-bar bar-6" />
            <span className="viz-bar bar-7" />
          </div>

          <div className="dock-controls">
            <button type="button" className="icon-button" disabled={isLoading} aria-label="History">
              <span className="material-symbols-outlined">history</span>
            </button>

            <button
              type="button"
              className={`record-button ${recording ? "is-recording" : ""}`}
              onClick={recording ? stopRecording : startRecording}
              disabled={isLoading}
            >
              <span className="record-ping" aria-hidden="true" />
              <span className="material-symbols-outlined record-icon">mic</span>
              <span className="record-label">{recording ? "Recording" : "Start Session"}</span>
            </button>

            <button type="button" className="icon-button" disabled={isLoading} aria-label="Settings">
              <span className="material-symbols-outlined">settings</span>
            </button>
          </div>

          <div className="dock-meta">
            <div className="meta-group">
              <span>Session</span>
              <span className="meta-value">{sessionTime}</span>
            </div>
            <div className="meta-group">
              <span>Status</span>
              <span className="meta-value accent">{statusLabel}</span>
            </div>
          </div>
        </div>
      </main>

      <div className="aura aura-br" aria-hidden="true" />
      <div className="aura aura-tl" aria-hidden="true" />
      <div className="aura aura-noise" aria-hidden="true" />

      <div className="sr-only" aria-live="polite">
        {isLoading ? "Processing response" : recording ? "Recording in progress" : "Recorder is ready"}
      </div>

      <audio ref={audioRef} hidden />
    </div>
  );
}

export default AudioRecorder;