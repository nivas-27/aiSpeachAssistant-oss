from pydantic import BaseModel


class ChatReply(BaseModel):
    reply: str
    suggestion: str | None = None

    def to_response_dict(self) -> dict:
        return self.model_dump(exclude_none=True)
