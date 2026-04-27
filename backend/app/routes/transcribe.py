from fastapi import APIRouter, UploadFile, File, Form
from app.models.transcribe_models import ErrorResponse, TranscribeResponse, SessionResponse
from app.services.whisper_service import transcribe_audio
from app.services.gemini_chat_service import chat_with_gemini
from app.services.edge_tts_service import generate_audio_edge
from app.utils.file_utils import save_upload_file
from app.services.conversation_memory_service import conversation_memory_service
from datetime import datetime
import time
import uuid


router = APIRouter()

@router.get("/session")
async def create_session() -> SessionResponse:
    session_id = uuid.uuid4().hex
    conversation_memory_service.ensure_session(session_id)
    print(f"[{datetime.now().isoformat()}] /session created | session_id={session_id}")
    return SessionResponse(session_id=session_id)

@router.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    session_id: str | None = Form(None),
) -> TranscribeResponse | ErrorResponse:
    if not session_id:
        return ErrorResponse(status="error", message="session_id is required")

    if not conversation_memory_service.has_session(session_id):
        return ErrorResponse(status="error", message="session_id not found")

    request_start = time.perf_counter()
    print(
        f"[{datetime.now().isoformat()}] /transcribe started | filename={file.filename} "
        f"| content_type={file.content_type} | session_id={session_id}"
    )

    file_content = await file.read()
    file_path = save_upload_file(file_content, extension=".webm")

    step_start = time.perf_counter()
    transcription = transcribe_audio(file_path)
    print(f"[{datetime.now().isoformat()}] whisper done | text_len={len(transcription or '')} | took_ms={(time.perf_counter() - step_start) * 1000:.2f}")

    print(f"[{datetime.now().isoformat()}] gemini input | transcription_preview={str(transcription)[:80]}")
    step_start = time.perf_counter()
    chat_response = chat_with_gemini(transcription, session_id=session_id)
    print(
        f"[{datetime.now().isoformat()}] gemini done | response_type={type(chat_response).__name__} "
        f"| took_ms={(time.perf_counter() - step_start) * 1000:.2f}"
    )

    reply_text = chat_response.get("reply")
    print(f"[{datetime.now().isoformat()}] tts input | reply_type={type(reply_text).__name__} | reply_preview={str(reply_text)[:80]}")

    step_start = time.perf_counter()
    audio_file_path = await generate_audio_edge(reply_text)
    print(f"[{datetime.now().isoformat()}] edge tts done | audio_file={audio_file_path} | took_ms={(time.perf_counter() - step_start) * 1000:.2f}")

    print(f"[{datetime.now().isoformat()}] /transcribe finished | total_ms={(time.perf_counter() - request_start) * 1000:.2f}")
    return TranscribeResponse(
        transcription=transcription,
        chat_response=chat_response,
        audio_file=audio_file_path,
    )
