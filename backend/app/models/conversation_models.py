from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class MessageTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ConversationSession(BaseModel):
    session_id: str
    session_date: str
    history: list[MessageTurn] = Field(default_factory=list)
