import { useEffect, useRef, useState } from "react";
import "./audioRecorder.css";
import { getSession, streamTranscribe } from "../apiCalls/transcribe";
import { BACKEND_ENDPOINTS } from "../apiCalls/backendEndpoints";

const SESSION_ID_KEY = "aiSpeechAssistant_session_id";

function AudioRecorder() {
  const [recording, setRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);
  const audioQueueRef = useRef([]);
  const audioPlayingRef = useRef(false);
  const chatScrollRef = useRef(null);
  const timerRef = useRef(null);

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

  useEffect(() => {
    if (!recording) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    setCurrentSeconds(0);
    timerRef.current = setInterval(() => {
      setTotalSeconds((prev) => prev + 1);
      setCurrentSeconds((prev) => prev + 1);
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [recording]);

  const playNextQueuedAudio = async () => {
    if (audioPlayingRef.current || !audioRef.current) {
      return;
    }

    const nextAudioUrl = audioQueueRef.current.shift();
    if (!nextAudioUrl) {
      setIsAiSpeaking(false);
      return;
    }

    audioPlayingRef.current = true;
    setIsAiSpeaking(true);
    audioRef.current.src = nextAudioUrl;
    audioRef.current.onended = () => {
      audioPlayingRef.current = false;
      playNextQueuedAudio().catch((error) => {
        console.error("Error continuing queued audio playback:", error);
        setIsAiSpeaking(false);
      });
    };

    try {
      await audioRef.current.play();
    } catch (playError) {
      audioPlayingRef.current = false;
      setIsAiSpeaking(false);
      console.error("Audio autoplay blocked:", playError);
    }
  };

  const enqueueAudioSegment = async (audioUrl) => {
    if (!audioUrl) {
      return;
    }

    audioQueueRef.current.push(audioUrl);
    if (!audioPlayingRef.current) {
      await playNextQueuedAudio();
    }
  };

  const startRecording = async () => {
    try {
      // Check if navigator.mediaDevices is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          "Your browser does not support audio recording. Please use a modern browser (Chrome, Firefox, Safari, Edge)."
        );
      }

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
      alert(`Microphone Error: ${error.message || error}`);
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

  const formatDuration = (total) => {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };

  const sendAudio = async (blob) => {
    setIsLoading(true);
    setIsBusy(true);
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    setIsAiSpeaking(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    const formData = new FormData();
    let sessionId = localStorage.getItem(SESSION_ID_KEY);
    if (!sessionId) {
      try {
        sessionId = await fetchSessionId();
      } catch (error) {
        console.error("Error creating session:", error);
        setIsLoading(false);
        setIsBusy(false);
        return;
      }
    }

    formData.append("file", blob, "recording.webm");
    formData.append("session_id", sessionId);

    try {
      const timestamp = Date.now();
      const userMessageId = `${timestamp}-user`;
      const botMessageId = `${timestamp}-bot`;
      let insertedMessages = false;

      await streamTranscribe(formData, async (event) => {
        if (event.type === "transcription") {
          setIsLoading(false);
          if (!insertedMessages) {
            insertedMessages = true;
            setMessages((prev) => [
              ...prev,
              {
                id: userMessageId,
                side: "right",
                role: "Me",
                text: event.transcription || "",
              },
              {
                id: botMessageId,
                side: "left",
                role: "Assistant",
                text: "",
                audioSegments: [],
              },
            ]);
          }
          return;
        }

        if (event.type === "reply_chunk") {
          setIsLoading(false);
          setMessages((prev) =>
            prev.map((message) =>
              message.id === botMessageId
                ? { ...message, text: event.reply || `${message.text || ""}${event.delta || ""}` }
                : message
            )
          );
          return;
        }

        if (event.type === "reply_done") {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === botMessageId
                ? { ...message, text: event.reply || message.text }
                : message
            )
          );
          return;
        }

        if (event.type === "audio_segment") {
          const audioFilename = getAudioFilename(event.audio_file);
          const audioUrl = audioFilename
            ? `${import.meta.env.VITE_BACKEND_URL}${BACKEND_ENDPOINTS.AUDIO}/${encodeURIComponent(audioFilename)}`
            : "";

          setMessages((prev) =>
            prev.map((message) =>
              message.id === botMessageId
                ? {
                    ...message,
                    audioSegments: [...(message.audioSegments || []), { url: audioUrl, text: event.segment_text || "" }],
                  }
                : message
            )
          );
          await enqueueAudioSegment(audioUrl);
          return;
        }

        if (event.type === "error") {
          throw new Error(event.message || "Streaming failed.");
        }

        if (event.type === "done") {
          setIsBusy(false);
        }
      });
    } catch (error) {
      console.error("Error sending audio:", error);
      setIsBusy(false);
    } finally {
      setIsLoading(false);
      setIsBusy(false);
    }
  };

  const statusLabel = isLoading ? "Processing" : isBusy ? "Responding" : isAiSpeaking ? "AI Speaking" : recording ? "Recording" : "Ready";
  const sessionTime = formatDuration(recording ? currentSeconds : totalSeconds);

  return (
    <div className="recorder-shell">
      {isLoading ? (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card">
            <span className="loading-spinner" aria-hidden="true" />
            <span className="loading-text">Processing...</span>
          </div>
        </div>
      ) : null}
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

                    {message.audioSegments?.length ? (
                      <div className="audio-block">
                        {message.audioSegments.map((segment, index) => (
                          <audio key={`${message.id}-segment-${index}`} controls src={segment.url} className="chat-audio" />
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="record-dock">
          <div className={`visualizer ${recording ? "is-active" : ""}`} aria-hidden="true">
            <span className="viz-bar bar-1" />
            <span className="viz-bar bar-2" />
            <span className="viz-bar bar-3" />
            <span className="viz-bar bar-4" />
            <span className="viz-bar bar-5" />
            <span className="viz-bar bar-6" />
            <span className="viz-bar bar-7" />
          </div>

          <div className="dock-controls">
            <button
              type="button"
              className={`record-button ${recording ? "is-recording" : ""}`}
              onClick={recording ? stopRecording : startRecording}
              disabled={isBusy || isAiSpeaking}
            >
              <span className="record-ping" aria-hidden="true" />
              <span className="material-symbols-outlined record-icon">mic</span>
              <span className="record-label">{recording ? "Recording" : "Start Session"}</span>
            </button>

            {/* <button type="button" className="icon-button" disabled={isLoading} aria-label="Settings">
              <span className="material-symbols-outlined">settings</span>
            </button> */}
          </div>

          <div className="dock-meta">
            <div className="meta-group">
              <span>{recording ? "Recording" : "Session"}</span>
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
