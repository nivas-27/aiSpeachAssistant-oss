from fastapi import APIRouter, UploadFile, File
from app.services.whisper_service import transcribe_audio
from app.services.gpt_chat_service import chat_with_gpt
from app.services.edge_tts_service import generate_audio_edge
from app.utils.file_utils import save_upload_file, save_output_file
from datetime import datetime
import time


router = APIRouter()

@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    request_start = time.perf_counter()
    print(f"[{datetime.now().isoformat()}] /transcribe started | filename={file.filename} | content_type={file.content_type}")

    step_start = time.perf_counter()
    file_content = await file.read()
    print(f"[{datetime.now().isoformat()}] file.read complete | bytes={len(file_content)} | took_ms={(time.perf_counter() - step_start) * 1000:.2f}")

    step_start = time.perf_counter()
    file_path = save_upload_file(file_content, extension=".webm")
    print(f"[{datetime.now().isoformat()}] upload saved | path={file_path} | took_ms={(time.perf_counter() - step_start) * 1000:.2f}")

    step_start = time.perf_counter()
    transcription = transcribe_audio(file_path)
    print(f"[{datetime.now().isoformat()}] whisper done | text_len={len(transcription or '')} | took_ms={(time.perf_counter() - step_start) * 1000:.2f}")

    step_start = time.perf_counter()
    chat_response = chat_with_gpt(transcription)
    print(
        f"[{datetime.now().isoformat()}] gpt done | response_type={type(chat_response).__name__} "
        f"| keys={list(chat_response.keys()) if isinstance(chat_response, dict) else None} "
        f"| took_ms={(time.perf_counter() - step_start) * 1000:.2f}"
    )

    reply_text = chat_response.get("reply")
    print(f"[{datetime.now().isoformat()}] tts input | reply_type={type(reply_text).__name__} | reply_preview={str(reply_text)[:80]}")

    step_start = time.perf_counter()
    audio_file_path = await generate_audio_edge(reply_text)
    print(f"[{datetime.now().isoformat()}] edge tts done | audio_file={audio_file_path} | took_ms={(time.perf_counter() - step_start) * 1000:.2f}")

    print(f"[{datetime.now().isoformat()}] /transcribe finished | total_ms={(time.perf_counter() - request_start) * 1000:.2f}")
    return {"transcription": transcription, "chat_response": chat_response, "audio_file": audio_file_path }
