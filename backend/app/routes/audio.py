from fastapi import APIRouter
from fastapi.responses import FileResponse
import os

router = APIRouter()
AUDIO_DIR = "tts-outputs"

@router.get("/audio/{filename}")
def get_audio(filename: str):
    if os.path.basename(filename) != filename or "\\" in filename:
        return {"error": "file not found"}
    file_path = os.path.join(AUDIO_DIR, filename)
    print(f"Received request for audio file: {filename} | resolved path: {file_path}")

    if not os.path.exists(file_path):
        return {"error": "file not found"}

    return FileResponse(
        path=file_path,
        media_type="audio/mpeg",
        filename=filename
    )