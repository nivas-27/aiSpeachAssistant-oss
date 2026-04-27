from pydantic import BaseModel

from app.models.chat_models import ChatReply


class TranscribeResponse(BaseModel):
    transcription: str
    chat_response: ChatReply
    audio_file: str


class SessionResponse(BaseModel):
    session_id: str


class ErrorResponse(BaseModel):
    status: str
    message: str
