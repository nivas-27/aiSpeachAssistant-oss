/* eslint-disable react-hooks/immutability */
/* eslint-disable no-unused-vars */
/* eslint-disable no-empty */
import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import "./MeetingRoom.css";
import { streamTranscribe } from "../apiCalls/transcribe";
import { BACKEND_ENDPOINTS } from "../apiCalls/backendEndpoints";
import { createPracticeSession, endPracticeSession } from "../apiCalls/endpoints";

// Fallback only. The real limit comes from the backend when a session starts,
// so the two cannot drift apart.
const MEETING_DURATION = 20 * 60;
const BAR_COUNT = 32;

// Voice activity detection. The mic stays open for the whole session and these
// thresholds decide when a sentence starts and ends, so nobody has to press a
// button between turns. Two thresholds (not one) give hysteresis, so a voice
// hovering near the cutoff does not flicker on and off.
const VAD = {
  START_RMS: 0.055,       // loud enough to be speech, not room tone
  STOP_RMS: 0.032,        // quieter than this counts as silence
  // People pause to breathe between sentences, not just within them. A 1.9s
  // window still clipped that breath and sent half a thought, so the wait now
  // clears a normal breath (roughly 0.5-1.5s) with room to spare. The cost is
  // paid back many times over by the smaller upload below.
  SILENCE_MS: 2400,
  // A brief opening ("So...") deserves even longer before we assume it is over.
  SHORT_UTTERANCE_MS: 2500,
  PATIENT_SILENCE_MS: 3000,
  // How much genuinely VOICED audio a clip must contain to be worth sending.
  // Measured only while above START_RMS, because room tone and breathing sit
  // above STOP_RMS and would otherwise keep a near-silent clip looking alive.
  MIN_VOICED_MS: 500,
  MIN_BLOB_BYTES: 3000,   // ~500ms at 32kbps; below this there is nothing to hear
  MAX_UTTERANCE_MS: 45000, // safety valve against an open mic in a noisy room
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatElapsed(total) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getAudioFilename(audioPath = "") {
  if (!audioPath) return "";
  return audioPath.split(/[/\\]/).pop() || "";
}

// ─── Unified Voice Visualizer ────────────────────────────────────────────────
// mode="mic"  → real Web Audio API (AnalyserNode on mic stream) for accuracy
// mode="audio" → animated sine-wave canvas — no AudioContext on the <audio>
//                element so the browser can autoplay it freely.

function VoiceVisualizer({ micStream, mode, isActive, color = "#c0fe71" }) {
  const canvasRef  = useRef(null);
  const animRef    = useRef(null);
  const stateRef   = useRef({ ctx: null, source: null });
  const timeRef    = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelAnimationFrame(animRef.current);

    if (!isActive) {
      drawIdle(canvas, color);
      return;
    }

    if (mode === "mic" && micStream) {
      // ── Real Web Audio analysis on the microphone stream ──────────────
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) { drawIdle(canvas, color); return; }

      const actx = new AudioContext();
      if (actx.state === "suspended") actx.resume().catch(() => {});
      stateRef.current.ctx = actx;

      const analyser = actx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.55;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -10;

      const src = actx.createMediaStreamSource(micStream);
      src.connect(analyser); // do NOT connect to destination — avoids echo
      stateRef.current.source = src;

      const bufLen = analyser.frequencyBinCount;
      const data   = new Uint8Array(bufLen);
      const freqPerBin = actx.sampleRate / analyser.fftSize;
      const lowBin  = Math.floor(80   / freqPerBin);
      const highBin = Math.min(Math.floor(4000 / freqPerBin), bufLen - 1);
      const binRange = highBin - lowBin;

      const frame = () => {
        animRef.current = requestAnimationFrame(frame);
        analyser.getByteFrequencyData(data);
        drawMicBars(canvas, data, lowBin, binRange, color);
      };
      frame();

      return () => {
        cancelAnimationFrame(animRef.current);
        try { src.disconnect(); } catch (_) {}
        actx.close().catch(() => {});
        stateRef.current.ctx = null;
        drawIdle(canvas, color);
      };

    } else if (mode === "audio") {
      // ── Animated sine-wave bars for AI playback ───────────────────────
      // No AudioContext on the <audio> element — keeps autoplay unrestricted.
      timeRef.current = 0;

      const frame = () => {
        animRef.current = requestAnimationFrame(frame);
        timeRef.current += 0.045;
        drawSineBars(canvas, timeRef.current, color);
      };
      frame();

      return () => {
        cancelAnimationFrame(animRef.current);
        drawIdle(canvas, color);
      };
    } else {
      drawIdle(canvas, color);
    }
  }, [isActive, micStream, mode, color]);

  // ── draw: idle flat line ─────────────────────────────────────────────────
  function drawIdle(canvas, col) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const barW = Math.max(3, Math.floor(width / (BAR_COUNT * 1.6)));
    const gap  = (width - barW * BAR_COUNT) / (BAR_COUNT + 1);
    for (let i = 0; i < BAR_COUNT; i++) {
      const x = gap + i * (barW + gap);
      ctx.fillStyle   = col;
      ctx.globalAlpha = 0.13;
      ctx.beginPath();
      ctx.roundRect(x, height / 2 - 2, barW, 4, 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ── draw: real mic frequency bars with RMS noise gate ───────────────────
  function drawMicBars(canvas, data, lowBin, binRange, col) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const barW = Math.max(3, Math.floor(width / (BAR_COUNT * 1.6)));
    const gap  = (width - barW * BAR_COUNT) / (BAR_COUNT + 1);

    // RMS across speech band → noise gate
    let rmsSum = 0;
    for (let i = lowBin; i <= lowBin + binRange; i++) rmsSum += (data[i] / 255) ** 2;
    const rms  = Math.sqrt(rmsSum / (binRange + 1));
    const gate = rms < 0.04 ? 0 : Math.min(1, (rms - 0.04) / 0.25);

    for (let i = 0; i < BAR_COUNT; i++) {
      const t      = i / (BAR_COUNT - 1);
      const binIdx = lowBin + Math.round(t * binRange);
      const raw    = data[Math.min(binIdx, data.length - 1)] / 255;
      const value  = Math.min(1, raw * gate * 1.8);
      const barH   = Math.max(3, value * height * 0.88);
      const x = gap + i * (barW + gap);
      const y = height / 2 - barH / 2;

      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0,   col);
      grad.addColorStop(0.6, col + "bb");
      grad.addColorStop(1,   col + "33");
      ctx.fillStyle   = grad;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, barW / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ── draw: animated sine-wave bars for AI speaking ───────────────────────
  function drawSineBars(canvas, t, col) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const barW = Math.max(3, Math.floor(width / (BAR_COUNT * 1.6)));
    const gap  = (width - barW * BAR_COUNT) / (BAR_COUNT + 1);

    for (let i = 0; i < BAR_COUNT; i++) {
      const phase = (i / BAR_COUNT) * Math.PI * 3.5;
      // Blend 3 sine frequencies for a natural speech-like envelope
      const raw = (
        Math.sin(t * 2.3 + phase) * 0.38 +
        Math.sin(t * 4.1 + phase * 1.4) * 0.28 +
        Math.sin(t * 1.1 + phase * 0.6) * 0.22 +
        (Math.random() - 0.5) * 0.12
      );
      const value = (Math.abs(raw) * 1.15);
      const barH  = Math.max(4, Math.min(1, value) * height * 0.82);
      const x = gap + i * (barW + gap);
      const y = height / 2 - barH / 2;

      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0,   col);
      grad.addColorStop(0.55, col + "cc");
      grad.addColorStop(1,   col + "33");
      ctx.fillStyle   = grad;
      ctx.globalAlpha = 0.88;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, barW / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return (
    <canvas
      ref={canvasRef}
      className="voice-canvas"
      width={320}
      height={56}
      aria-hidden="true"
    />
  );
}

// ─── Lobby Screen ─────────────────────────────────────────────────────────────

function LobbyScreen({ onJoin, userName }) {
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const handleJoin = async () => {
    setJoining(true);
    setJoinError("");
    try {
      await onJoin();
    } catch (error) {
      setJoinError(error.message || "Could not start the session. Please try again.");
      setJoining(false);
    }
  };

  return (
    <div className="lobby-shell">
      <div className="lobby-glow lobby-glow-1" />
      <div className="lobby-glow lobby-glow-2" />

      <div className="lobby-card">
        {/* AI Avatar */}
        <div className="lobby-icon-wrap">
          <div className="lobby-ai-ring" />
          <div className="lobby-ai-avatar">AI</div>
        </div>

        {/* Text */}
        <div className="lobby-text">
          <h1 className="lobby-title">AI Voice Meeting</h1>
          <p className="lobby-subtitle">
            Your AI assistant is ready · Session will last&nbsp;20&nbsp;minutes
          </p>
        </div>

        {/* Chips */}
        <div className="lobby-info-row">
          <div className="lobby-info-chip">
            <span className="material-symbols-outlined">schedule</span>
            <span>{timeStr}</span>
          </div>
          <div className="lobby-info-chip">
            <span className="material-symbols-outlined">timer</span>
            <span>20 min</span>
          </div>
          <div className="lobby-info-chip">
            <span className="material-symbols-outlined">people</span>
            <span>2 participants</span>
          </div>
        </div>

        {/* Participants */}
        <div className="lobby-participants">
          <div className="lobby-participant-chip">
            <div className="lp-avatar ai">AI</div>
            <span>Assistant</span>
            <span className="lp-status ready">Ready</span>
          </div>
          <div className="lobby-participant-chip">
            <div className="lp-avatar user">You</div>
            <span>{userName || "You"}</span>
            <span className="lp-status waiting">Waiting</span>
          </div>
        </div>

        {joinError && (
          <p className="form-alert" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{joinError}</span>
          </p>
        )}

        {/* Join button */}
        <button
          id="join-meeting-btn"
          className={`join-button ${joining ? "joining" : ""}`}
          onClick={handleJoin}
          disabled={joining}
        >
          {joining ? (
            <>
              <span className="lobby-spinner" />
              <span>Joining…</span>
            </>
          ) : (
            <>
              <span className="material-symbols-outlined">video_call</span>
              <span>Join Meeting</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Main Meeting Component ───────────────────────────────────────────────────

export default function MeetingRoom({ userName, onPhaseChange }) {
  const [phase, setPhase] = useState("lobby"); // lobby | meeting | ended
  const [recording, setRecording]     = useState(false);
  const [messages, setMessages]       = useState([]);
  const [isLoading, setIsLoading]     = useState(false);
  const [isBusy, setIsBusy]           = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(MEETING_DURATION);
  const [micStream, setMicStream]     = useState(null);
  const [summary, setSummary]         = useState(null);
  const [turnError, setTurnError]     = useState("");
  const [isMuted, setIsMuted]         = useState(false);
  const [micReady, setMicReady]       = useState(false);
  // Time is up, but the last exchange is still allowed to finish.
  const [timeUp, setTimeUp]           = useState(false);
  // "leaving" | "timeup" | null - which confirmation is on screen.
  const [confirming, setConfirming]   = useState(null);
  const [closing, setClosing]         = useState(false);
  const [farewell, setFarewell]       = useState(null);

  // The session id lives in a ref, not state. MediaRecorder callbacks are
  // registered once and would capture a stale copy of a state value, which is
  // exactly how a live session used to report itself as "no longer active".
  // Nothing renders the id, so a ref is both correct and simpler.
  const sessionIdRef = useRef(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef   = useRef([]);
  const audioRef         = useRef(null);
  const audioQueueRef    = useRef([]);
  const audioPlayingRef  = useRef(false);
  const chatScrollRef    = useRef(null);
  const meetingTimerRef  = useRef(null);
  const startTimeRef     = useRef(null);
  const finalizeRef      = useRef(null);

  // One microphone stream for the entire session, opened once on join.
  const micStreamRef     = useRef(null);
  const vadRef           = useRef(null);
  // Read inside the animation loop, so the loop never has to be torn down and
  // rebuilt just because a piece of React state changed.
  const listenGateRef    = useRef(false);
  const timeUpRef        = useRef(false);
  const durationRef      = useRef(MEETING_DURATION);
  const sendUtteranceRef = useRef(true);
  const sendAudioRef     = useRef(null);

  // Let the page around us know whether to show the app chrome. Only a live
  // meeting takes over the whole screen; the lobby and summary keep the nav.
  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);

  // ── Scroll to bottom ─────────────────────────────────────────────────────

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Meeting countdown timer ───────────────────────────────────────────────

  const startMeetingTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    meetingTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const left = durationRef.current - elapsed;
      if (left <= 0) {
        setSecondsLeft(0);
        clearInterval(meetingTimerRef.current);
        // Do not cut anyone off. Mark the time as up and let the exchange in
        // flight finish; an effect closes the session once things go quiet.
        setTimeUp(true);
      } else {
        setSecondsLeft(left);
      }
    }, 1000);
  }, []);

  const stopMeetingTimer = useCallback(() => {
    if (meetingTimerRef.current) clearInterval(meetingTimerRef.current);
  }, []);

  const playNextQueuedAudio = useCallback(async () => {
    if (audioPlayingRef.current || !audioRef.current) return;

    const next = audioQueueRef.current.shift();
    if (!next) {
      setIsAiSpeaking(false);
      return;
    }

    audioPlayingRef.current = true;
    setIsAiSpeaking(true);

    // Reveal the words as they are spoken, not before. Gemini returns its whole
    // reply in one burst, so printing it on arrival dumped the full answer on
    // screen a second and a half before the voice caught up - which is why the
    // audio never felt like it was streaming. Text now follows the voice.
    if (next.text && next.messageId) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === next.messageId
            ? { ...msg, text: `${msg.text ? `${msg.text} ` : ""}${next.text}`.trim() }
            : msg
        )
      );
    }

    audioRef.current.src = next.url;
    audioRef.current.load();
    audioRef.current.onended = () => {
      audioPlayingRef.current = false;
      playNextQueuedAudio().catch((error) => {
        console.error("Error continuing queued audio playback:", error);
        setIsAiSpeaking(false);
      });
    };

    try {
      await audioRef.current.play();
    } catch (error) {
      audioPlayingRef.current = false;
      setIsAiSpeaking(false);
      console.error("Autoplay blocked:", error);
    }
  }, []);

  const enqueueAudioSegment = useCallback(async (entry) => {
    if (!entry?.url) return;
    audioQueueRef.current.push(entry);
    if (!audioPlayingRef.current) {
      await playNextQueuedAudio();
    }
  }, [playNextQueuedAudio]);

  // ── Live listening (voice activity detection) ────────────────────────────
  // The mic opens once on join and stays open. A small analyser watches the
  // signal level and decides where each sentence starts and stops, so the
  // conversation flows without anyone pressing a button between turns.

  const acquireMic = useCallback(async () => {
    if (micStreamRef.current) return micStreamRef.current;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot record audio.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // stop the assistant voice retriggering the mic
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,          // speech is mono; stereo doubles the upload
      },
    });

    micStreamRef.current = stream;
    setMicStream(stream);
    setMicReady(true);
    return stream;
  }, []);

  const releaseMic = useCallback(() => {
    const vad = vadRef.current;
    if (vad) {
      clearInterval(vad.timer);
      try { vad.source.disconnect(); } catch (_) {}
      vad.ctx.close().catch(() => {});
      vadRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      sendUtteranceRef.current = false;
      try { mediaRecorderRef.current.stop(); } catch (_) {}
    }
    mediaRecorderRef.current = null;

    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    setMicStream(null);
    setMicReady(false);
    setRecording(false);
  }, []);

  const beginUtterance = useCallback(() => {
    const stream = micStreamRef.current;
    if (!stream || mediaRecorderRef.current?.state === "recording") return;

    // The browser default was encoding speech at near-music quality, producing
    // ~900KB per turn. Opus at 32kbps mono is what voice codecs are built for,
    // lands around 60KB, and uploads roughly fifteen times faster - which is
    // where most of the wait before a reply was actually going.
    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 32000,
      });
    } catch {
      recorder = new MediaRecorder(stream); // older browser: take what it gives
    }
    mediaRecorderRef.current = recorder;
    audioChunksRef.current = [];
    sendUtteranceRef.current = true;

    recorder.ondataavailable = (event) => {
      if (event.data?.size) audioChunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];
      // The stream is NOT stopped here - it stays open for the next sentence.
      if (!sendUtteranceRef.current || !chunks.length) return;

      const blob = new Blob(chunks, { type: "audio/webm" });
      if (blob.size < VAD.MIN_BLOB_BYTES) return; // too small to hold speech
      sendAudioRef.current?.(blob);
    };

    recorder.start();
    setRecording(true);
  }, []);

  const endUtterance = useCallback((send) => {
    sendUtteranceRef.current = send;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      try { recorder.stop(); } catch (_) {}
    }
    setRecording(false);
  }, []);

  // Listening is open only when the floor is genuinely the user's: in a live
  // meeting, not muted, and with nothing being transcribed, generated or spoken.
  const canListen =
    phase === "meeting" && micReady && !isMuted && !isBusy && !isLoading && !isAiSpeaking;

  // The time-up dialog must never strand a session open if nobody is watching,
  // so it counts itself down and closes on its own.
  const [autoCloseIn, setAutoCloseIn] = useState(20);

  useEffect(() => {
    if (confirming !== "timeup") {
      setAutoCloseIn(20);
      return undefined;
    }
    if (autoCloseIn <= 0) {
      finalizeRef.current?.();
      return undefined;
    }
    const tick = setTimeout(() => setAutoCloseIn((n) => n - 1), 1000);
    return () => clearTimeout(tick);
  }, [confirming, autoCloseIn]);

  // Idle means: not hearing anyone, nothing in flight, nobody speaking.
  const isIdle = !recording && !isLoading && !isBusy && !isAiSpeaking;

  useEffect(() => {
    timeUpRef.current = timeUp;
  }, [timeUp]);

  // The wind-down: once the clock runs out we wait for the exchange in flight
  // to land - the last sentence gets transcribed, answered and spoken - and
  // only then does the session close.
  useEffect(() => {
    if (phase !== "meeting" || !timeUp || !isIdle || closing) return undefined;
    if (confirming) return undefined;
    const settle = setTimeout(() => setConfirming("timeup"), 900);
    return () => clearTimeout(settle);
  }, [phase, timeUp, isIdle, closing, confirming]);

  useEffect(() => {
    listenGateRef.current = canListen;
    // If the floor was taken away mid-sentence, drop the partial recording.
    if (!canListen && mediaRecorderRef.current?.state === "recording") {
      endUtterance(false);
    }
  }, [canListen, endUtterance]);

  useEffect(() => {
    if (phase !== "meeting" || !micStream) return undefined;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return undefined;

    const ctx = new AudioContextCtor();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;

    const source = ctx.createMediaStreamSource(micStream);
    source.connect(analyser); // never to the destination - that would echo

    const samples = new Uint8Array(analyser.fftSize);
    const state = {
      speaking: false, speechStart: 0, lastVoice: 0, voicedMs: 0, lastTick: 0,
      timer: 0, ctx, source,
    };
    vadRef.current = state;

    // Driven by a timer, not requestAnimationFrame: rAF is paused entirely
    // while the tab is hidden, which would freeze listening mid-sentence and
    // leave a recording that never ends. 50ms is far finer than the 1100ms
    // silence window and costs a fraction of a 60fps loop.
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const deviation = (samples[i] - 128) / 128;
        sum += deviation * deviation;
      }
      const rms = Math.sqrt(sum / samples.length);
      const now = performance.now();

      if (!listenGateRef.current) {
        state.speaking = false;
        return;
      }

      if (!state.speaking) {
        if (timeUpRef.current) return; // the bell has rung: no new turns
        if (rms > VAD.START_RMS) {
          state.speaking = true;
          state.speechStart = now;
          state.lastVoice = now;
          state.voicedMs = 0;
          state.lastTick = now;
          beginUtterance();
        }
        return;
      }

      // Count only the time actually spent above the speech threshold.
      const sinceLastTick = state.lastTick ? now - state.lastTick : 0;
      state.lastTick = now;
      if (rms > VAD.START_RMS) state.voicedMs += sinceLastTick;

      if (rms > VAD.STOP_RMS) state.lastVoice = now;

      const silentFor = now - state.lastVoice;
      const totalFor = now - state.speechStart;
      const spokenFor = totalFor - silentFor;

      // Give a short opening more room before deciding the turn has ended.
      const silenceNeeded =
        spokenFor < VAD.SHORT_UTTERANCE_MS ? VAD.PATIENT_SILENCE_MS : VAD.SILENCE_MS;

      if (silentFor >= silenceNeeded) {
        state.speaking = false;
        // Send only if the clip actually contains speech. Judging by elapsed
        // time alone shipped 3-4 second clips of room tone that transcribed to
        // nothing and came back 422.
        endUtterance(state.voicedMs >= VAD.MIN_VOICED_MS);
      } else if (totalFor >= VAD.MAX_UTTERANCE_MS) {
        state.speaking = false;
        endUtterance(true);
      }
    };

    state.timer = setInterval(tick, 50);

    return () => {
      clearInterval(state.timer);
      try { source.disconnect(); } catch (_) {}
      ctx.close().catch(() => {});
      vadRef.current = null;
    };
  }, [phase, micStream, beginUtterance, endUtterance]);

  // ── Join / End meeting ───────────────────────────────────────────────────

  const handleJoin = useCallback(async () => {
    // Create the session first: without a persisted id there is nothing to
    // attach turns to, and the reports page would have no record of this run.
    // Unlock audio playback while the click gesture is still fresh. There is no
    // per-turn button any more, so this is the only user gesture we ever get -
    // without it the browser would block the assistant voice from autoplaying.
    if (audioRef.current) {
      audioRef.current.muted = true;
      audioRef.current.play().catch(() => {});
      requestAnimationFrame(() => {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.muted = false;
        }
      });
    }

    await acquireMic();

    const session = await createPracticeSession();
    sessionIdRef.current = session.session_id;
    // The backend owns the session length; mirror it rather than guessing.
    durationRef.current = session.duration_limit_seconds || MEETING_DURATION;
    setMessages([]);
    setSummary(null);
    setTurnError("");
    setTimeUp(false);
    setSecondsLeft(durationRef.current);
    setPhase("meeting");
    startMeetingTimer();
  }, [startMeetingTimer, acquireMic]);

  const stopAllAudio = useCallback(() => {
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    setIsAiSpeaking(false);
  }, []);

  /** Play one audio file and resolve when it finishes (or cannot play). */
  const playAndWait = useCallback(async (url) => {
    if (!url || !audioRef.current) return;

    const element = audioRef.current;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        element.onended = null;
        element.onerror = null;
        resolve();
      };
      element.onended = finish;
      element.onerror = finish;
      element.src = url;
      element.load();
      element.play().catch(finish);
      // Never hang the close on a stuck audio element.
      setTimeout(finish, 20000);
    });
  }, []);

  const handleEndMeeting = useCallback(async () => {
    stopMeetingTimer();
    releaseMic();
    stopAllAudio();
    setConfirming(null);
    setClosing(true);

    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) {
      setClosing(false);
      setPhase("ended");
      return;
    }

    try {
      const result = await endPracticeSession(activeSessionId, { spoken: true });
      setSummary(result.summary);

      if (result.farewell) {
        setFarewell(result.farewell);
        const file = getAudioFilename(result.farewell.audio_file);
        if (file) {
          // Say goodbye out loud before the summary replaces the room.
          await playAndWait(
            `${import.meta.env.VITE_BACKEND_URL}${BACKEND_ENDPOINTS.AUDIO}/${encodeURIComponent(file)}`
          );
        }
      }
    } catch (error) {
      // The session still exists server-side; only the summary is missing.
      console.error("Could not close the session:", error);
    } finally {
      setClosing(false);
      setPhase("ended");
    }
  }, [stopMeetingTimer, releaseMic, stopAllAudio, playAndWait]);

  useEffect(() => {
    finalizeRef.current = handleEndMeeting;
  }, [handleEndMeeting]);

  // ── Send audio ────────────────────────────────────────────────────────────

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
    setTurnError("");

    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) {
      setTurnError("This session is no longer active. Start a new one to keep practising.");
      setIsLoading(false);
      setIsBusy(false);
      return;
    }

    const formData = new FormData();
    formData.append("file", blob, "recording.webm");
    formData.append("session_id", activeSessionId);

    try {
      const ts = Date.now();
      const userMessageId = `${ts}-user`;
      const botMessageId = `${ts}-bot`;
      let insertedMessages = false;
      let fullReply = "";

      await streamTranscribe(formData, async (event) => {
        if (event.type === "transcription") {
          setIsLoading(false);
          if (!insertedMessages) {
            insertedMessages = true;
            setMessages((prev) => [
              ...prev,
              { id: userMessageId, side: "right", role: "Me", text: event.transcription || "" },
              { id: botMessageId, side: "left", role: "Assistant", text: "", audioSegments: [] },
            ]);
          }
          return;
        }

        if (event.type === "reply_chunk") {
          // Text is revealed by playback, not on arrival - see playNextQueuedAudio.
          setIsLoading(false);
          return;
        }

        if (event.type === "reply_done") {
          fullReply = event.reply || fullReply;
          return;
        }

        if (event.type === "audio_segment") {
          const audioFilename = getAudioFilename(event.audio_file);
          const audioUrl = audioFilename
            ? `${import.meta.env.VITE_BACKEND_URL}${BACKEND_ENDPOINTS.AUDIO}/${encodeURIComponent(audioFilename)}`
            : "";

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === botMessageId
                ? {
                    ...msg,
                    audioSegments: [
                      ...(msg.audioSegments || []),
                      { url: audioUrl, text: event.segment_text || "" },
                    ],
                  }
                : msg
            )
          );
          await enqueueAudioSegment({
            url: audioUrl,
            text: event.segment_text || "",
            messageId: botMessageId,
          });
          return;
        }

        if (event.type === "error") {
          throw new Error(event.message || "Streaming failed.");
        }

        if (event.type === "done") {
          fullReply = event.reply || fullReply;
          setIsBusy(false);

          // If playback was blocked or a clip failed, the reply would never
          // appear at all. Wait until the voice has genuinely finished - not a
          // fixed delay, which fired mid-playback and duplicated the text - and
          // only then fill in whatever was missed.
          const settleText = async () => {
            for (let i = 0; i < 40; i += 1) {
              if (!audioPlayingRef.current && audioQueueRef.current.length === 0) break;
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === botMessageId && (msg.text || "").length < fullReply.length
                  ? { ...msg, text: fullReply }
                  : msg
              )
            );
          };
          settleText();
        }
      });
    } catch (err) {
      console.error("Error sending audio:", err);
      // 422 = nothing intelligible in that clip. With an always-on mic this is
      // routine (a cough, a chair), so listening simply resumes in silence.
      if (err.status !== 422) {
        setTurnError(err.message || "That recording could not be processed. Please try again.");
      }
      setIsBusy(false);
    } finally {
      setIsLoading(false);
      setIsBusy(false);
    }
  };

  // The recorder callback is registered once per utterance and calls through
  // this ref, so it always reaches the current sendAudio.
  useEffect(() => {
    sendAudioRef.current = sendAudio;
  });

  // ── Derived state ─────────────────────────────────────────────────────────

  const timerUrgent  = secondsLeft <= 120;
  const timerWarning = secondsLeft <= 300 && secondsLeft > 120;
  const elapsed = Math.max(0, durationRef.current - secondsLeft);

  const statusLabel = timeUp && isIdle && phase === "meeting"
    ? "Wrapping up"
    : isLoading
    ? "Transcribing"
    : isBusy
    ? "Thinking"
    : isAiSpeaking
    ? "Assistant speaking"
    : recording
    ? "Hearing you"
    : isMuted
    ? "Mic muted"
    : micReady
    ? "Listening"
    : "Starting mic";

  const statusClass = isLoading || isBusy
    ? "processing"
    : isAiSpeaking
    ? "ai-speaking"
    : recording
    ? "recording"
    : isMuted
    ? "muted"
    : "ready";

  const windingDown = timeUp && phase === "meeting";
  const exchangeCount = Math.floor(messages.length / 2);

  const micHint = windingDown
    ? recording || isBusy || isLoading || isAiSpeaking
      ? "Time is up - finishing this last exchange."
      : "Wrapping up your session..."
    : isMuted
    ? "Mic is off. Tap to rejoin the conversation."
    : isAiSpeaking
    ? "Wait for the reply to finish, then just talk."
    : isBusy || isLoading
    ? "Working on your last sentence..."
    : recording
    ? "Go on - pause when you are done."
    : "Just start talking. It sends when you pause.";

  // Visualizer: active during mic recording OR AI playback
  // Show the real mic trace whenever the mic is open and unmuted, so there is
  // constant visible proof the room is listening - not just while it records.
  const vizActive = (micReady && !isMuted && !isAiSpeaking) || isAiSpeaking;
  const vizMode   = isAiSpeaking ? "audio" : "mic";
  const vizColor  = isAiSpeaking ? "#a78bfa" : "#c0fe71";

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => () => {
    stopMeetingTimer();
    releaseMic();
  }, [stopMeetingTimer, releaseMic]);

  // ─────────────────────────────────────────────────────────────────────────

  if (phase === "lobby") return <LobbyScreen onJoin={handleJoin} userName={userName} />;

  if (phase === "ended") {
    // Three different endings: a real session with speech, a real session with
    // none, and one where the summary could not be fetched. Never tell someone
    // they said nothing just because the summary request failed.
    const summaryKnown = Boolean(summary);
    const spoke = summaryKnown && summary.exchanges > 0;
    const minutes = summary ? Math.max(1, Math.round(summary.duration_seconds / 60)) : 0;

    return (
      <div className="meeting-ended-shell">
        <div className="ended-card">
          <span className="material-symbols-outlined ended-icon">check_circle</span>
          <h2>{spoke || !summaryKnown ? "Thanks for practising" : "Session ended"}</h2>
          <p>
            {spoke
              ? `You spoke for ${minutes} minute${minutes === 1 ? "" : "s"} and kept the ` +
                `conversation going across ${summary.exchanges} exchange` +
                `${summary.exchanges === 1 ? "" : "s"}. Every session builds the habit.`
              : summaryKnown
              ? "The session has ended. You did not record anything this time - have another go whenever you are ready."
              : "Your session is saved. Open your report to see how it went."}
          </p>

          {spoke && (
            <>
              <div className="ended-stats">
                <div>
                  <span>{summary.exchanges}</span>
                  <small>Exchanges</small>
                </div>
                <div>
                  <span>{summary.words_spoken}</span>
                  <small>Words</small>
                </div>
                <div>
                  <span>{summary.avg_words_per_turn}</span>
                  <small>Per turn</small>
                </div>
                <div>
                  <span>{summary.filler_rate}%</span>
                  <small>Fillers</small>
                </div>
              </div>

              <p className="ended-tip">
                <span className="material-symbols-outlined">tips_and_updates</span>
                <span>
                  {summary.filler_rate > 5
                    ? "Filler words crept in a fair bit. Try pausing silently instead of saying um."
                    : summary.avg_words_per_turn < 12
                    ? "Try stretching your answers a little longer next time - add a reason or an example."
                    : "Strong, full answers throughout. Keep this pace up."}
                </span>
              </p>
            </>
          )}

          <div className="ended-actions">
            <button
              className="join-button"
              onClick={() => {
                stopAllAudio();
                setPhase("lobby");
                setMessages([]);
                setSummary(null);
                setTimeUp(false);
                sessionIdRef.current = null;
                setSecondsLeft(durationRef.current);
              }}
            >
              <span className="material-symbols-outlined">refresh</span>
              Start new session
            </button>

            <Link to="/app/reports" className="ended-secondary">
              <span className="material-symbols-outlined">monitoring</span>
              View full report
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="meeting-shell">
      {/* Ambient */}
      <div className="aura aura-br" aria-hidden="true" />
      <div className="aura aura-tl" aria-hidden="true" />

      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="meeting-header">
        {/* Left — branding */}
        <div className="meeting-header-left">
          <div className="meeting-logo-dot" />
          <div className="meeting-title-group">
            <span className="meeting-title-text">AI Voice Meeting</span>
            <span className="meeting-subtitle-text">Live Session</span>
          </div>
        </div>

        {/* Center — status pill */}
        <div className="meeting-header-center">
          <div className={`session-status-pill ${statusClass}`}>
            <span className="session-status-dot" />
            <span>{statusLabel}</span>
          </div>
        </div>

        {/* Right — timer + end button */}
        <div className="meeting-header-right">
          <div className={`header-timer ${timerUrgent ? "urgent" : timerWarning ? "warning" : ""}`}>
            <span className="material-symbols-outlined header-timer-icon">timer</span>
            <div className="header-timer-text">
              <span className="header-timer-value">{formatTime(secondsLeft)}</span>
              <span className="header-timer-label">remaining</span>
            </div>
          </div>

          <button
            id="end-meeting-btn"
            className="end-meeting-btn"
            onClick={() => setConfirming("leaving")}
            aria-label="End meeting"
          >
            <span className="material-symbols-outlined">call_end</span>
            <span>End</span>
          </button>
        </div>
      </header>

      {/* ── Loading overlay ──────────────────────────────────────────── */}
      {isLoading && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card">
            <span className="loading-spinner" />
            <span className="loading-text">Processing…</span>
          </div>
        </div>
      )}

      {/* ── Confirm before closing, however the session got here ────── */}
      {confirming && (
        <div className="confirm-backdrop" role="presentation">
          <div
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <span className={`material-symbols-outlined confirm-icon ${confirming}`}>
              {confirming === "timeup" ? "hourglass_bottom" : "logout"}
            </span>

            <h2 id="confirm-title">
              {confirming === "timeup" ? "Time is up" : "End this session?"}
            </h2>

            <p>
              {confirming === "timeup"
                ? `${
                    durationRef.current >= 60
                      ? `Your ${Math.round(durationRef.current / 60)}-minute session has finished.`
                      : "Your session has finished."
                  } Close it now and your report will be ready.`
                : exchangeCount > 0
                ? `You have had ${exchangeCount} exchange${exchangeCount === 1 ? "" : "s"} so far.
                   Ending now saves everything to your report.`
                : "You have not spoken yet. Ending now records an empty session."}
            </p>

            <div className="confirm-actions">
              {confirming === "leaving" && (
                <button
                  type="button"
                  className="confirm-cancel"
                  onClick={() => setConfirming(null)}
                >
                  Keep practising
                </button>
              )}
              <button
                type="button"
                className="confirm-accept"
                onClick={handleEndMeeting}
                autoFocus
              >
                <span className="material-symbols-outlined">check</span>
                {confirming === "timeup" ? "Finish and see report" : "End session"}
              </button>
            </div>

            {confirming === "timeup" && (
              <p className="confirm-note">Closing automatically in {autoCloseIn}s</p>
            )}
          </div>
        </div>
      )}

      {/* ── Saying goodbye ──────────────────────────────────────────── */}
      {closing && (
        <div className="closing-overlay" role="status" aria-live="polite">
          <div className="closing-card">
            <span className="spinner spinner-light" />
            <span>{farewell ? "Wrapping up..." : "Saving your session..."}</span>
          </div>
        </div>
      )}

      {/* ── Wind-down notice ─────────────────────────────────────────── */}
      {windingDown && (
        <div className="wrapup-banner" role="status" aria-live="polite">
          <span className="material-symbols-outlined">hourglass_bottom</span>
          <span>
            {isIdle
              ? "Time is up. Wrapping up your session..."
              : "Time is up - finish your thought, we will wait."}
          </span>
        </div>
      )}

      {/* ── Turn-level error ─────────────────────────────────────────── */}
      {turnError && (
        <div className="meeting-error" role="alert">
          <span className="material-symbols-outlined">error</span>
          <span>{turnError}</span>
          <button type="button" onClick={() => setTurnError("")} aria-label="Dismiss">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}

      {/* ── Main ────────────────────────────────────────────────────── */}
      <main className="meeting-main">

        {/* Chat */}
        <div className="meeting-chat-viewport hide-scrollbar" ref={chatScrollRef}>
          <div className="message-stack">
            <div className="message-row left entrance-left">
              <div className="message-role-tag assistant-tag">AI</div>
              <div className="assistant-card">
                <p className="message-text">
                  Hello. I am listening. How can I assist you with your vocal session today?
                </p>
              </div>
            </div>

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`message-row ${msg.side === "right" ? "right entrance-right" : "left entrance-left"}`}
              >
                {msg.side === "right" ? (
                  <>
                    <div className="user-card">
                      <p className="message-text">{msg.text}</p>
                    </div>
                    <div className="message-role-tag user-tag">Me</div>
                  </>
                ) : (
                  <>
                    <div className="message-role-tag assistant-tag">AI</div>
                    <div className="assistant-card">
                      {msg.text && <p className="message-text">{msg.text}</p>}
                      {/* audio plays via the hidden <audio> element — no inline player */}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── Voice dock ───────────────────────────────────────────── */}
        <div className="voice-dock">

          {/* Single unified visualizer */}
          <div className={`viz-strip ${vizActive ? (recording ? "active-user" : "active-ai") : "idle"}`}>
            <VoiceVisualizer
              micStream={micStream}
              mode={vizMode}
              isActive={vizActive}
              color={vizColor}
            />
            {/* Speaker label overlay */}
            {vizActive && (
              <span className="viz-speaker-label">
                {isAiSpeaking ? "AI" : recording ? "You" : "Listening"}
              </span>
            )}
          </div>

          {/* Live controls - no press-to-talk, the mic is always listening */}
          <div className="dock-controls-row">
            <div className="dock-elapsed">
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>schedule</span>
              <span>{formatElapsed(elapsed)}</span>
            </div>

            <div className="live-control">
              <div
                className={`live-orb ${statusClass}`}
                role="status"
                aria-live="polite"
                aria-label={statusLabel}
              >
                <span className="live-orb-pulse" aria-hidden="true" />
                <span className="material-symbols-outlined live-orb-icon">
                  {isMuted
                    ? "mic_off"
                    : isAiSpeaking
                    ? "volume_up"
                    : isBusy || isLoading
                    ? "more_horiz"
                    : "mic"}
                </span>
              </div>

              <div className="live-copy">
                <span className="live-status">{statusLabel}</span>
                <span className="live-hint">{micHint}</span>
              </div>

              <button
                id="mute-toggle-btn"
                type="button"
                className={`mute-button ${isMuted ? "is-muted" : ""}`}
                onClick={() => setIsMuted((muted) => !muted)}
                aria-pressed={isMuted}
                aria-label={isMuted ? "Turn the microphone on" : "Turn the microphone off"}
              >
                <span className="material-symbols-outlined">
                  {isMuted ? "mic_off" : "mic"}
                </span>
                <span>{isMuted ? "Unmute" : "Mute"}</span>
              </button>
            </div>

            <div className="dock-elapsed">
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>forum</span>
              <span>{Math.floor(messages.length / 2)} exchanges</span>
            </div>
          </div>
        </div>
      </main>

      {/* Hidden audio */}
      <audio ref={audioRef} hidden />

      {/* A11y live region */}
      <div className="sr-only" aria-live="polite">
        {isLoading
          ? "Processing response"
          : isBusy
          ? "AI is responding"
          : recording
          ? "Recording in progress"
          : isAiSpeaking
          ? "AI is speaking"
          : "Ready to record"}
      </div>
    </div>
  );
}
