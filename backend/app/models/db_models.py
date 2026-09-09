"""Document shapes and helpers for the MongoDB collections.

Mongo is schemaless, so these builders keep every write in one known shape and
give the rest of the app a single place to read field names from.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId

from app.core.soft_delete import new_fields


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: datetime | None) -> datetime | None:
    """Mongo can hand back naive datetimes depending on the driver settings."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def to_object_id(value: str) -> ObjectId | None:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


# ─── users ──────────────────────────────────────────────────────────────────

def new_user(email: str, full_name: str, password_hash: str) -> dict[str, Any]:
    now = utcnow()
    return {
        "email": email,
        "full_name": full_name,
        "password_hash": password_hash,
        "email_verified": True,  # only verified signups reach this collection
        "created_at": now,
        "last_login_at": now,
        # Streak counters are maintained at session start, not recomputed from
        # the whole session history on every dashboard load.
        "practice": {"last_practice_date": None, "current_streak": 0, "longest_streak": 0},
        **new_fields(),
    }


def user_public(document: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(document["_id"]),
        "full_name": document["full_name"],
        "email": document["email"],
        "created_at": as_utc(document.get("created_at")) or utcnow(),
    }


# ─── practice_sessions ──────────────────────────────────────────────────────

def new_session(session_id: str, user_id: ObjectId) -> dict[str, Any]:
    return {
        "_id": session_id,
        "user_id": user_id,
        "started_at": utcnow(),
        "ended_at": None,
        "duration_seconds": 0,
        "status": "active",
        # Turns are embedded, not a separate collection: they are only ever read
        # with their session, and the 20-minute cap bounds the array at a few
        # dozen small subdocuments - nowhere near the 16MB document limit.
        "turns": [],
        **new_fields(),
    }


# ─── embedded turns ────────────────────────────────────────────────────────

def new_turn(
    role: str,
    content: str,
    word_count: int,
    stt_ms: int | None = None,
    llm_ms: int | None = None,
    tts_ms: int | None = None,
) -> dict[str, Any]:
    """One turn, shaped to live inside practice_sessions.turns."""
    return {
        "role": role,
        "content": content,
        "word_count": word_count,
        "created_at": utcnow(),
        "stt_ms": stt_ms,
        "llm_ms": llm_ms,
        "tts_ms": tts_ms,
    }


# ─── streak counters ───────────────────────────────────────────────────────

def advance_streak(user: dict, today: date | None = None) -> dict:
    """Return the user practice counters advanced to today. O(1).

    Called once when a session starts. Days are UTC, matching how session
    timestamps are stored.
    """
    today = today or datetime.now(timezone.utc).date()
    practice = user.get("practice") or {}

    stored = practice.get("last_practice_date")
    last_date = date.fromisoformat(stored) if stored else None
    current = int(practice.get("current_streak", 0) or 0)
    longest = int(practice.get("longest_streak", 0) or 0)

    if last_date == today:
        current = max(current, 1)  # already counted today
    elif last_date is not None and (today - last_date).days == 1:
        current += 1
    else:
        current = 1  # first ever session, or the streak was broken

    return {
        "last_practice_date": today.isoformat(),
        "current_streak": current,
        "longest_streak": max(longest, current),
    }


def read_streak(user: dict, today: date | None = None) -> dict:
    """Read the counters, expiring a streak that has gone stale.

    A stored counter cannot decay on its own, so the lapse is applied here at
    read time - still O(1), with no scan of the session history.
    """
    today = today or datetime.now(timezone.utc).date()
    practice = user.get("practice") or {}

    stored = practice.get("last_practice_date")
    longest = int(practice.get("longest_streak", 0) or 0)

    if not stored:
        return {"current_days": 0, "longest_days": longest}

    last_date = date.fromisoformat(stored)
    lapsed = (today - last_date).days > 1
    current = 0 if lapsed else int(practice.get("current_streak", 0) or 0)

    return {"current_days": current, "longest_days": longest}


# ─── llm_events ────────────────────────────────────────────────────────────

def new_llm_event(
    provider: str,
    operation: str,
    model: str | None,
    ok: bool,
    kind: str | None,
    message: str | None,
    usage: dict[str, Any],
    latency_ms: int | None,
    session_id: str | None,
    user_id: Any,
    extra: dict[str, Any],
) -> dict[str, Any]:
    """One model call: what was asked, what came back, what it cost."""
    return {
        "provider": provider,       # openai | gemini
        "operation": operation,     # stt | chat | tts | alert
        "model": model,
        "ok": ok,
        "kind": kind,               # failure class, None when ok
        "message": message,         # provider error text, truncated
        "usage": usage,             # token counts as reported
        "latency_ms": latency_ms,
        "session_id": session_id,
        "user_id": user_id,
        "extra": extra,
        "created_at": utcnow(),
        **new_fields(),
    }
