from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.database import practice_sessions
from app.core.deps import get_current_user
from app.core.soft_delete import live
from app.models.db_models import as_utc
from app.services import analytics_service

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview")
def overview(current_user: dict = Depends(get_current_user)) -> dict:
    return analytics_service.build_overview(current_user)


@router.get("/activity")
def activity(
    days: int = Query(default=30, ge=7, le=180),
    current_user: dict = Depends(get_current_user),
) -> dict:
    return {"days": days, "activity": analytics_service.build_activity(current_user["_id"], days)}


@router.get("/progress")
def progress(
    limit: int = Query(default=12, ge=3, le=50),
    current_user: dict = Depends(get_current_user),
) -> dict:
    return {"progress": analytics_service.build_progress(current_user["_id"], limit)}


@router.get("/vocabulary")
def vocabulary(current_user: dict = Depends(get_current_user)) -> dict:
    return analytics_service.build_vocabulary(current_user["_id"])


@router.get("/methodology")
def methodology() -> dict:
    """How every figure on the report is derived.

    Served from the backend so the explanation and the implementation can never
    drift apart in different repos - this mirrors analytics_service.py.
    """
    return {
        "principle": (
            "Every number is computed from the words you actually spoke. "
            "Only your turns are measured - what the assistant says is never counted."
        ),
        "metrics": [
            {
                "name": "Words spoken",
                "formula": "sum of the word count of every turn you spoke",
                "detail": "A word is any run of letters (apostrophes included), lowercased.",
            },
            {
                "name": "Words per turn",
                "formula": "words spoken / number of your turns",
                "detail": "The clearest single signal of speaking confidence.",
            },
            {
                "name": "Vocabulary diversity",
                "formula": "unique words / total words, as a percentage",
                "detail": (
                    "Also called the type-token ratio. It naturally falls as you speak "
                    "more, so compare it between sessions of similar length."
                ),
            },
            {
                "name": "Filler rate",
                "formula": "fillers / words spoken x 100",
                "detail": (
                    "Counts um, uh, erm, hmm, like, actually, basically, literally, yeah, "
                    "plus the phrases you know, i mean, sort of, kind of. Phrases are "
                    "matched first so you know is not also counted as know."
                ),
            },
            {
                "name": "Fluency score",
                "formula": "40% turn length + 35% vocabulary diversity + 25% filler restraint",
                "detail": (
                    "Turn length scores 0 at 4 words and full marks at 25+. Diversity scores "
                    "full marks at a 55% unique-word ratio. Filler restraint scores full marks "
                    "at 0 fillers and 0 at 12 per 100 words. With no recorded speech the score "
                    "is 0, not a default."
                ),
            },
            {
                "name": "Practice time",
                "formula": "sum of session durations, capped at the session limit",
                "detail": "Measured from joining the room to ending it, not from speaking time.",
            },
            {
                "name": "Streak",
                "formula": "consecutive calendar days with at least one session",
                "detail": "Resets when a day passes with no session at all.",
            },
            {
                "name": "Reply latency",
                "formula": "mean of the measured per-turn timings",
                "detail": (
                    "Transcription, model reply and speech synthesis are timed separately "
                    "on every turn. This is system speed, not a measure of your speaking."
                ),
            },
        ],
    }


@router.get("/report")
def full_report(current_user: dict = Depends(get_current_user)) -> dict:
    """Everything the reports page needs, in one round trip."""
    user_id = current_user["_id"]
    return {
        "overview": analytics_service.build_overview(current_user),
        "activity": analytics_service.build_activity(user_id, 30),
        "progress": analytics_service.build_progress(user_id, 12),
        "vocabulary": analytics_service.build_vocabulary(user_id),
        "sessions": analytics_service.build_sessions_list(user_id, 20),
    }


@router.get("/sessions/{session_id}")
def session_detail(session_id: str, current_user: dict = Depends(get_current_user)) -> dict:
    session = practice_sessions().find_one(
        live({"_id": session_id, "user_id": current_user["_id"]})
    )
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    session_turns = session.get("turns", [])

    return {
        "summary": analytics_service.session_summary(session),
        "transcript": [
            {
                "role": turn.get("role"),
                "content": turn.get("content", ""),
                "word_count": turn.get("word_count", 0),
                "created_at": (as_utc(turn.get("created_at")).isoformat()
                               if turn.get("created_at") else None),
            }
            for turn in session_turns
        ],
    }
