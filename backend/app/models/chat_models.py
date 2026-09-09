from pydantic import BaseModel


class ChatReply(BaseModel):
    reply: str

    def to_response_dict(self) -> dict:
        return self.model_dump(exclude_none=True)
