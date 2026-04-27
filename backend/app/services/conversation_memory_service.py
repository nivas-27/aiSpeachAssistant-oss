from datetime import datetime

from app.models.conversation_models import ConversationSession, MessageTurn


class ConversationMemoryService:
    def __init__(self, context_turns: int = 6):
        self._sessions: dict[str, ConversationSession] = {}
        self._context_turns = context_turns

    def ensure_session(self, session_id: str) -> ConversationSession:
        return self._get_or_create_session(session_id)

    def has_session(self, session_id: str) -> bool:
        return session_id in self._sessions

    def add_user_message(self, session_id: str, content: str) -> None:
        session = self._get_existing_session(session_id)
        session.history.append(MessageTurn(role="user", content=content))

    def add_assistant_message(self, session_id: str, content: str) -> None:
        session = self._get_existing_session(session_id)
        session.history.append(MessageTurn(role="assistant", content=content))

    def get_recent_context(self, session_id: str) -> list[MessageTurn]:
        session = self._get_existing_session(session_id)
        return session.history[-self._context_turns :]

    def get_full_history(self, session_id: str) -> list[MessageTurn]:
        session = self._get_existing_session(session_id)
        return session.history

    def _get_existing_session(self, session_id: str) -> ConversationSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise ValueError("Session not found")
        return session

    def _get_or_create_session(self, session_id: str) -> ConversationSession:
        today = datetime.utcnow().date().isoformat()
        session = self._sessions.get(session_id)

        if session is None:
            session = ConversationSession(session_id=session_id, session_date=today)
            self._sessions[session_id] = session
            return session

        if session.session_date != today:
            session.session_date = today

        return session


conversation_memory_service = ConversationMemoryService(context_turns=6)
