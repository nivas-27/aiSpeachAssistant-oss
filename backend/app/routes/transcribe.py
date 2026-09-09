import asyncio
import json
import time
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.database import practice_sessions
from app.core.deps import get_current_user
from app.core.soft_delete import live
from app.models.db_models import new_turn
from app.models.transcribe_models import SessionResponse
from app.services import analytics_service
from app.services.conversation_memory_service import conversation_memory_service
from app.services.gemini_chat_service import stream_chat_with_gemini
from app.services.openAi_TTS_service import generate_audio_openai
from app.services.whisper_openAi_service import transcribe_audio
from app.utils.file_utils import save_upload_file


router = APIRouter()


@router.get("/session")
async def create_session() -> SessionResponse:
    """Legacy anonymous session endpoint, kept so the old MVP client still runs.

    Authenticated clients should use POST /sessions instead, which persists the
    session against the user and unlocks the reports page.
    """
    session_id = uuid.uuid4().hex
    conversation_memory_service.ensure_session(session_id)
    print(f"[{datetime.now().isoformat()}] /session created (legacy) | session_id={session_id}")
    return SessionResponse(session_id=session_id)


def push_turn(session_id: str, turn: dict) -> None:
    """Append one turn to its session document.

    $push is atomic server-side, so concurrent writes cannot lose a turn the way
    a read-modify-write of the array would.
    """
    practice_sessions().update_one(live({"_id": session_id}), {"$push": {"turns": turn}})


def _rehydrate_memory(session_id: str) -> None:
    """Rebuild in-memory chat context from the database.

    The LLM context lives in process memory, so a server restart mid-session
    would otherwise drop the conversation. Turns are durable, so replay them.
    """
    conversation_memory_service.ensure_session(session_id)
    if conversation_memory_service.get_full_history(session_id):
        return

    session = practice_sessions().find_one(live({"_id": session_id}), {"turns": 1})
    for turn in (session or {}).get("turns", []):
        content = turn.get("content", "")
        if turn.get("role") == "user":
            conversation_memory_service.add_user_message(session_id, content)
        else:
            conversation_memory_service.add_assistant_message(session_id, content)


# The very first fragment decides how long the room stays silent after you stop
# talking, because nothing can be spoken until it comes back from the synthesiser.
# A long opening sentence costs seconds, so the first one may break at a natural
# clause instead. Later sentences are left whole - the pipeline is already ahead
# by then, and chopping them up would sound clipped.
# Nothing can be spoken until the first fragment comes back from the synthesiser,
# so the sooner that fragment exists the sooner the room stops being silent.
# While the reply is still being generated we do not wait for a full sentence:
# as soon as a natural pause has arrived with enough words behind it, that clause
# is sent to be spoken. Later fragments wait for real sentence ends, because by
# then synthesis is running ahead of playback anyway.
EARLY_FLUSH_MIN_CHARS = 22
EARLY_FLUSH_MARKERS = (", ", "; ", " - ", ": ")


def _take_early_clause(buffer: str) -> tuple[str | None, str]:
    """Peel off an opening clause if one is already complete.

    Returns (clause_or_None, remaining_buffer).
    """
    # A finished sentence is handled by the normal path; do not pre-empt it.
    for terminator in (".", "!", "?"):
        if terminator in buffer:
            return None, buffer

    for marker in EARLY_FLUSH_MARKERS:
        cut = buffer.find(marker)
        if cut >= EARLY_FLUSH_MIN_CHARS:
            return buffer[: cut + 1].strip(), buffer[cut + len(marker) :].lstrip()

    return None, buffer


FIRST_SEGMENT_SPLIT_ABOVE = 45   # only bother if the sentence is genuinely long
FIRST_HEAD_MIN_CHARS = 8         # "Hi Nivas," is a natural chunk; "So," is not
FIRST_TAIL_MIN_CHARS = 18        # do not leave a stub behind


def _split_first_segment(segment: str) -> list[str]:
    """Break a long opening sentence at its first natural pause."""
    if len(segment) <= FIRST_SEGMENT_SPLIT_ABOVE:
        return [segment]

    for marker in (", ", "; ", " - ", ": "):
        cut = segment.find(marker)
        if cut >= FIRST_HEAD_MIN_CHARS and len(segment) - cut > FIRST_TAIL_MIN_CHARS:
            head = segment[: cut + 1].strip()
            tail = segment[cut + len(marker) :].strip()
            if head and tail:
                return [head, tail]

    return [segment]


def _extract_complete_segments(buffer: str, flush_all: bool = False) -> tuple[list[str], str]:
    completed: list[str] = []
    working = buffer

    while True:
        sentence_end = -1
        for punctuation in (".", "!", "?"):
            index = working.find(punctuation)
            if index != -1 and (sentence_end == -1 or index < sentence_end):
                sentence_end = index

        if sentence_end == -1:
            break

        segment = working[: sentence_end + 1].strip()
        working = working[sentence_end + 1 :].lstrip()

        if segment:
            completed.append(segment)

    if flush_all and working.strip():
        completed.append(working.strip())
        working = ""

    return completed, working


@router.post("/transcribe", response_model=None)
async def transcribe(
    file: UploadFile = File(...),
    session_id: str | None = Form(None),
    current_user: dict = Depends(get_current_user),
):
    # Active STS flow: speech -> text -> text -> speech
    if not session_id:
        return JSONResponse(
            status_code=400, content={"status": "error", "message": "session_id is required"}
        )

    practice_session = practice_sessions().find_one(
        live({"_id": session_id, "user_id": current_user["_id"]})
    )
    if practice_session is None:
        return JSONResponse(
            status_code=404, content={"status": "error", "message": "session_id not found"}
        )
    if practice_session.get("status") == "completed":
        return JSONResponse(
            status_code=409, content={"status": "error", "message": "This session has ended"}
        )

    _rehydrate_memory(session_id)

    request_start = time.perf_counter()
    print(
        f"[{datetime.now().isoformat()}] /transcribe started | filename={file.filename} "
        f"| content_type={file.content_type} | session_id={session_id} | user_id={current_user['_id']}"
    )

    file_content = await file.read()
    file_path = save_upload_file(file_content, extension=".webm")

    step_start = time.perf_counter()
    transcription = await asyncio.to_thread(
        transcribe_audio, file_path, session_id, current_user["_id"]
    )
    stt_ms = int((time.perf_counter() - step_start) * 1000)
    print(
        f"[{datetime.now().isoformat()}] whisper done | text_len={len(transcription or '')} "
        f"| took_ms={stt_ms}"
    )

    if not transcription:
        return JSONResponse(
            status_code=422,
            content={
                "status": "error",
                "message": "Could not transcribe audio. Try a clearer recording with at least a few words.",
            },
        )

    # Persist the learner turn. pymongo blocks, so it runs in a worker thread,
    # and the reply does not wait on it - the round trip to Atlas overlaps with
    # transcription handoff instead of sitting in front of it. It is awaited
    # before the assistant turn is written, which keeps the array in order.
    user_turn_write = asyncio.create_task(asyncio.to_thread(
        push_turn,
        session_id,
        new_turn(
            role="user",
            content=transcription,
            word_count=analytics_service.count_words(transcription),
            stt_ms=stt_ms,
        ),
    ))

    def encode_event(payload: dict) -> bytes:
        return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")

    tts_total_ms = 0

    async def synthesize_segment(segment_text: str, segment_index: int):
        nonlocal tts_total_ms
        step_start = time.perf_counter()
        audio_file_path = await generate_audio_openai(
            segment_text, session_id=session_id, user_id=current_user["_id"]
        )
        took_ms = int((time.perf_counter() - step_start) * 1000)
        tts_total_ms += took_ms
        print(
            f"[{datetime.now().isoformat()}] openai tts segment done | "
            f"segment_index={segment_index} | text_len={len(segment_text)} | audio_file={audio_file_path} "
            f"| took_ms={took_ms}"
        )
        return {
            "type": "audio_segment",
            "segment_index": segment_index,
            "segment_text": segment_text,
            "audio_file": audio_file_path,
        }

    async def event_stream():
        yield encode_event({"type": "transcription", "transcription": transcription})

        print(f"[{datetime.now().isoformat()}] gemini stream input | transcription_preview={str(transcription)[:80]}")
        gemini_start = time.perf_counter()
        reply_text = ""
        sentence_buffer = ""
        segment_index = 0
        llm_ms = 0

        # Sentences are synthesised concurrently. Previously each sentence was
        # awaited inline, which blocked the stream: a short Gemini reply arrives
        # in one chunk, so the whole transcript rendered and only then did the
        # voice start, one 2-3s sentence at a time. Now sentence 2 is already
        # being synthesised while sentence 1 is still being spoken.
        pending_audio: list = []

        def queue_segment(text: str) -> None:
            nonlocal segment_index
            # Only the opening sentence is eligible for an early break.
            pieces = _split_first_segment(text) if segment_index == 0 else [text]
            for piece in pieces:
                segment_index += 1
                pending_audio.append(
                    asyncio.create_task(synthesize_segment(piece, segment_index))
                )

        async def emit_ready():
            """Emit finished segments in order, never waiting on a later one."""
            while pending_audio and pending_audio[0].done():
                task = pending_audio.pop(0)
                try:
                    yield encode_event(task.result())
                except Exception as exc:
                    print(
                        f"[{datetime.now().isoformat()}] tts segment failed | "
                        f"type={type(exc).__name__} | message={str(exc)[:200]}"
                    )

        async def emit_remaining():
            """Flush whatever is still synthesising, keeping sentence order."""
            while pending_audio:
                task = pending_audio.pop(0)
                try:
                    yield encode_event(await task)
                except Exception as exc:
                    print(
                        f"[{datetime.now().isoformat()}] tts segment failed | "
                        f"type={type(exc).__name__} | message={str(exc)[:200]}"
                    )

        try:
            for event in stream_chat_with_gemini(transcription, session_id=session_id):
                event_type = event.get("type")

                if event_type == "reply_chunk":
                    delta = event.get("delta", "")
                    if delta:
                        sentence_buffer += delta

                    yield encode_event(event)

                    ready_segments, sentence_buffer = _extract_complete_segments(sentence_buffer)

                    # Before the first fragment exists, an opening clause is
                    # enough to start speaking - do not wait for the full stop.
                    if not ready_segments and segment_index == 0:
                        clause, sentence_buffer = _take_early_clause(sentence_buffer)
                        if clause:
                            ready_segments = [clause]

                    for segment_text in ready_segments:
                        queue_segment(segment_text)
                    async for ready in emit_ready():
                        yield ready
                    continue

                if event_type == "reply_done":
                    reply_text = event.get("reply", "")
                    llm_ms = int((time.perf_counter() - gemini_start) * 1000)
                    print(
                        f"[{datetime.now().isoformat()}] gemini stream done | "
                        f"reply_len={len(reply_text)} | took_ms={llm_ms}"
                    )
                    yield encode_event(event)

                    ready_segments, sentence_buffer = _extract_complete_segments(
                        sentence_buffer, flush_all=True
                    )
                    for segment_text in ready_segments:
                        queue_segment(segment_text)
                    async for ready in emit_remaining():
                        yield ready
                    continue

                yield encode_event(event)
        except Exception as exc:
            print(
                f"[{datetime.now().isoformat()}] gemini stream route error | "
                f"type={type(exc).__name__} | message={str(exc)[:300]}"
            )
            yield encode_event({"type": "error", "message": "Could not generate a response right now."})
            return

        async for ready in emit_remaining():
            yield ready

        if not reply_text:
            yield encode_event({"type": "error", "message": "Could not generate a response right now."})
            return

        try:
            # Make sure the learner turn landed first, so the array stays in order.
            await user_turn_write
            await asyncio.to_thread(
                push_turn,
                session_id,
                new_turn(
                    role="assistant",
                    content=reply_text,
                    word_count=analytics_service.count_words(reply_text),
                    llm_ms=llm_ms,
                    tts_ms=tts_total_ms or None,
                ),
            )
        except Exception as exc:
            print(
                f"[{datetime.now().isoformat()}] assistant turn persist failed | "
                f"type={type(exc).__name__} | message={str(exc)[:200]}"
            )

        print(
            f"[{datetime.now().isoformat()}] /transcribe finished | "
            f"segment_count={segment_index} | total_ms={(time.perf_counter() - request_start) * 1000:.2f}"
        )
        yield encode_event({"type": "done", "reply": reply_text, "segment_count": segment_index})

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
