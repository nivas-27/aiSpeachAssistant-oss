import { useState, useRef } from "react";
import "./audioRecorder.css";
import { getTranscribe } from "../apiCalls/transcribe";
import { BACKEND_ENDPOINTS } from "../apiCalls/backendEndpoints";

function AudioRecorder() {
  const [recording, setRecording] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);

  const startRecording = async () => {
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
    formData.append("file", blob, "recording.webm");

    try {
      const response = await getTranscribe(formData);

      if (!response.ok) {
        throw new Error(`Transcribe request failed: ${response.status}`);
      }

      const data = await response.json();
      const audioFilename = getAudioFilename(data.audio_file);
      const audioUrl = audioFilename
        ? `${import.meta.env.BACKEND_URL}/${BACKEND_ENDPOINTS.AUDIO}/${encodeURIComponent(audioFilename)}`
        : "";

      const userText = data.transcription || "";
      const botReply = data.chat_response?.reply || "";
      const corrected = data.chat_response?.corrected || "";
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
          corrected,
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

  return (
    <div className="recorder-wrap">
      <div className="chat-list">
        {messages.length === 0 ? (
          <p className="empty-chat">Record and stop to start the conversation.</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`chat-row ${message.side}`}>
              <div className="chat-bubble">
                <div className="chat-role">{message.role}</div>
                <div>{message.text}</div>
                {message.corrected ? (
                  <div className="chat-extra">Corrected: {message.corrected}</div>
                ) : null}
                {message.suggestion ? (
                  <div className="chat-extra">Suggestion: {message.suggestion}</div>
                ) : null}
                {message.audioUrl ? (
                  <audio controls src={message.audioUrl} className="chat-audio" />
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="controls">
        <button onClick={startRecording} disabled={recording || isLoading}>
          Start
        </button>
        <button onClick={stopRecording} disabled={!recording || isLoading}>
          Stop
        </button>
      </div>

      <audio ref={audioRef} hidden />
    </div>
  );
}

export default AudioRecorder;