import os
import time
import uuid
from openai import AsyncOpenAI

from app.services import llm_telemetry

MODEL = "gpt-4o-mini-tts"

OUTPUT_DIR = "tts-outputs"

client = AsyncOpenAI(
    api_key=os.getenv("OPENAI_API_SECRET")
)

async def generate_audio_openai(text, file_path=None, session_id=None, user_id=None):
    """Stream TTS audio directly into a file for the active STS flow."""
    if file_path is None:
        file_path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4().hex}.mp3")

    # Ensure output directory exists
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    started = time.perf_counter()

    # Stream the generated audio directly to disk instead of buffering it fully in memory.
    try:
        async with client.audio.speech.with_streaming_response.create(
            model=MODEL,
            voice="coral",  # you can change voice
            input=text,
            instructions="Speak in a clear and natural Indian English accent."
        ) as response:
            await response.stream_to_file(file_path)
    except Exception as exc:
        llm_telemetry.record_failure(
            provider="openai",
            operation="tts",
            model=MODEL,
            error=exc,
            latency_ms=int((time.perf_counter() - started) * 1000),
            session_id=session_id,
            user_id=user_id,
        )
        raise

    llm_telemetry.record(
        provider="openai",
        operation="tts",
        model=MODEL,
        ok=True,
        latency_ms=int((time.perf_counter() - started) * 1000),
        session_id=session_id,
        user_id=user_id,
        # TTS is billed by characters, not tokens, so that is what is worth keeping.
        extra={"characters": len(text or ""), "voice": "coral"},
    )

    return file_path
