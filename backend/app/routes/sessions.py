import uuid
from datetime import datetime, timezone

from fastapi import Query

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.config import settings
from app.core.database import practice_sessions, users
from app.core.deps import get_current_user
from app.core.soft_delete import live
from app.models.db_models import advance_streak, as_utc, new_session
from app.services import analytics_service
from app.services.openAi_TTS_service import generate_audio_openai
from app.services.conversation_memory_service import conversation_memory_service

router = APIRouter(prefix="/sessions", tags=["sessions"])


def load_session_or_404(session_id: str, user: dict) -> dict:
    session = practice_sessions().find_one(live({"_id": session_id, "user_id": user["_id"]}))
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session


@router.post("", status_code=status.HTTP_201_CREATED)
def create_session(current_user: dict = Depends(get_current_user)) -> dict:
    session_id = uuid.uuid4().hex
    document = new_session(session_id, current_user["_id"])
    practice_sessions().insert_one(document)

    # The streak moves forward here, once per session, instead of being derived
    # from a scan of every past session each time the dashboard is opened.
    users().update_one(
        live({"_id": current_user["_id"]}),
        {"$set": {"practice": advance_streak(current_user)}},
    )

    conversation_memory_service.ensure_session(session_id)

    return {
        "session_id": session_id,
        "started_at": document["started_at"].isoformat(),
        "duration_limit_seconds": settings.SESSION_DURATION_SECONDS,
    }


def _farewell_line(summary: dict, first_name: str | None) -> str:
    """A short spoken sign-off that reflects how the session actually went."""
    who = f" {first_name}" if first_name else ""
    exchanges = summary.get("exchanges", 0)

    if not exchanges:
        return f"Thanks for stopping by{who}. Come back when you are ready to talk."

    minutes = max(1, round(summary.get("duration_seconds", 0) / 60))
    return (
        f"That is our time{who}. You spoke for about {minutes} "
        f"minute{'' if minutes == 1 else 's'} across {exchanges} "
        f"exchange{'' if exchanges == 1 else 's'} today. Really good session. "
        "Your report is ready whenever you want to look at it. See you next time!"
    )


@router.post("/{session_id}/end")
async def end_session(
    session_id: str,
    spoken: bool = Query(default=False, description="Also return a spoken sign-off"),
    current_user: dict = Depends(get_current_user),
) -> dict:
    session = load_session_or_404(session_id, current_user)

    if session.get("status") != "completed":
        ended_at = datetime.now(timezone.utc)
        started = as_utc(session.get("started_at")) or ended_at
        elapsed = int((ended_at - started).total_seconds())

        practice_sessions().update_one(
            live({"_id": session_id}),
            {
                "$set": {
                    "ended_at": ended_at,
                    # Never bank more than the allotted session length.
                    "duration_seconds": max(0, min(elapsed, settings.SESSION_DURATION_SECONDS)),
                    "status": "completed",
                }
            },
        )
        session = practice_sessions().find_one(live({"_id": session_id}))

    summary = analytics_service.session_summary(session)
    response: dict = {"summary": summary}

    if spoken:
        # A session that just stops feels abrupt. Sign off out loud, the same
        # way the assistant has been talking all along.
        text = _farewell_line(summary, (current_user.get("full_name") or "").split(" ")[0])
        response["farewell"] = {"text": text, "audio_file": None}
        try:
            response["farewell"]["audio_file"] = await generate_audio_openai(
                text, session_id=session_id, user_id=current_user["_id"]
            )
        except Exception as exc:
            # No voice is a small loss; failing the whole request is not.
            print(
                f"[{datetime.now(timezone.utc).isoformat()}] farewell tts failed | "
                f"type={type(exc).__name__} | message={str(exc)[:200]}"
            )

    return response


@router.get("")
def list_sessions(current_user: dict = Depends(get_current_user)) -> dict:
    return {"sessions": analytics_service.build_sessions_list(current_user["_id"], 20)}
