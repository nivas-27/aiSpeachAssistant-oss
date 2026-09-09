from openai import OpenAI
import os
import time

from app.services import llm_telemetry

MODEL = "gpt-4o-mini-transcribe"

# Initialize client (make sure OPENAI_API_KEY is set in env)
client = OpenAI(api_key=os.getenv("OPENAI_API_SECRET"))


def transcribe_audio(file_path: str, session_id: str | None = None, user_id=None):
    started = time.perf_counter()
    try:
        with open(file_path, "rb") as audio_file:
            result = client.audio.transcriptions.create(
                model=MODEL,
                file=audio_file,
            )
    except Exception as exc:
        llm_telemetry.record_failure(
            provider="openai",
            operation="stt",
            model=MODEL,
            error=exc,
            latency_ms=int((time.perf_counter() - started) * 1000),
            session_id=session_id,
            user_id=user_id,
        )
        print(f"[OpenAI STT Error] {exc}")
        return None

    latency_ms = int((time.perf_counter() - started) * 1000)
    text = (result.text or "").strip()

    # Fewer than three words is almost always noise rather than a sentence.
    too_short = len(text.split()) < 3

    llm_telemetry.record(
        provider="openai",
        operation="stt",
        model=MODEL,
        ok=not too_short,
        kind=llm_telemetry.BAD_RESPONSE if too_short else None,
        message="transcript too short to use" if too_short else None,
        usage=llm_telemetry.extract_usage(result),
        latency_ms=latency_ms,
        session_id=session_id,
        user_id=user_id,
        extra={"characters": len(text), "words": len(text.split())},
    )

    return None if too_short else text
