"""Derives learner-progress metrics from stored practice transcripts.

Everything here is computed from real turn data - no placeholder numbers.
"""

import re
from collections import Counter
from datetime import date, datetime, timedelta

from bson import ObjectId

from app.core.database import practice_sessions
from app.core.soft_delete import live
from app.models.db_models import as_utc, read_streak

WORD_RE = re.compile(r"[a-zA-Z']+")

# Multi-word fillers are matched first so "you know" is not counted as "know".
PHRASE_FILLERS = ("you know", "i mean", "sort of", "kind of")
WORD_FILLERS = frozenset(
    {"um", "uh", "erm", "hmm", "like", "actually", "basically", "literally", "yeah"}
)

# Very common words carry little signal about vocabulary range.
STOPWORDS = frozenset(
    """a an the and or but if then than that this these those i you he she it we they me him her
    us them my your his its our their is am are was were be been being do does did done have has
    had having will would shall should can could may might must to of in on at by for with about
    as from into over after before not no yes so very just really too also there here what when
    where who whom which how why all any some more most other own same now""".split()
)


def _words(text: str) -> list[str]:
    return WORD_RE.findall((text or "").lower())


def count_words(text: str) -> int:
    return len(_words(text))


def _count_fillers(text: str) -> int:
    lowered = (text or "").lower()
    total = 0
    for phrase in PHRASE_FILLERS:
        total += lowered.count(phrase)
        lowered = lowered.replace(phrase, " ")
    total += sum(1 for word in _words(lowered) if word in WORD_FILLERS)
    return total


def _round(value: float, digits: int = 1) -> float:
    return round(float(value), digits)


def _streaks(day_list: list[date]) -> tuple[int, int]:
    """Return (current_streak, longest_streak) in days."""
    if not day_list:
        return 0, 0

    unique_days = sorted(set(day_list))
    longest = current_run = 1
    for previous, current in zip(unique_days, unique_days[1:]):
        if (current - previous).days == 1:
            current_run += 1
            longest = max(longest, current_run)
        else:
            current_run = 1

    today = datetime.utcnow().date()
    last_day = unique_days[-1]
    if (today - last_day).days > 1:
        return 0, longest

    # Walk backwards from the most recent practice day.
    streak = 1
    day_set = set(unique_days)
    cursor = last_day
    while (cursor - timedelta(days=1)) in day_set:
        cursor -= timedelta(days=1)
        streak += 1

    return streak, longest


def _fluency_score(
    avg_words_per_turn: float, diversity: float, filler_rate: float, has_speech: bool = True
) -> int:
    """A transparent 0-100 blend of three measured signals.

    - length:    8 words/turn is weak, 25+ is strong
    - diversity: unique-word ratio across everything the learner said
    - fluency:   fewer fillers per 100 words scores higher

    With no recorded speech there is nothing to score. Without this guard the
    filler term would score a perfect 1.0 (no words, therefore no fillers) and
    hand a brand-new account 25/100 for having said nothing.
    """
    if not has_speech:
        return 0

    length_score = max(0.0, min(1.0, (avg_words_per_turn - 4) / 21))
    diversity_score = max(0.0, min(1.0, diversity / 0.55))
    filler_score = max(0.0, min(1.0, 1 - (filler_rate / 12)))

    blended = length_score * 0.4 + diversity_score * 0.35 + filler_score * 0.25
    return int(round(blended * 100))


def _load_sessions(user_id: ObjectId, limit: int | None = None) -> list[dict]:
    """Sessions for a user, newest first, with their turns already embedded.

    One query, no join: turns live inside the session document, so the whole
    report reads from a single index scan on user_id + started_at.
    """
    cursor = practice_sessions().find(live({"user_id": user_id})).sort("started_at", -1)
    if limit:
        cursor = cursor.limit(limit)
    return list(cursor)


def _split_turns(session: dict) -> tuple[list[dict], list[dict]]:
    session_turns = session.get("turns", [])
    user_turns = [t for t in session_turns if t.get("role") == "user"]
    assistant_turns = [t for t in session_turns if t.get("role") == "assistant"]
    return user_turns, assistant_turns


def _avg(values: list) -> int:
    clean = [value for value in values if value]
    return int(sum(clean) / len(clean)) if clean else 0


def session_summary(session: dict) -> dict:
    user_turns, assistant_turns = _split_turns(session)

    words = sum(t.get("word_count", 0) for t in user_turns)
    fillers = sum(_count_fillers(t.get("content", "")) for t in user_turns)
    vocabulary = {w for t in user_turns for w in _words(t.get("content", ""))}
    latencies = [t.get("llm_ms") for t in assistant_turns if t.get("llm_ms")]

    started_at = as_utc(session.get("started_at"))
    ended_at = as_utc(session.get("ended_at"))

    return {
        "id": session["_id"],
        "started_at": started_at.isoformat() if started_at else None,
        "ended_at": ended_at.isoformat() if ended_at else None,
        "status": session.get("status", "active"),
        "duration_seconds": session.get("duration_seconds", 0),
        "exchanges": len(user_turns),
        "words_spoken": words,
        "unique_words": len(vocabulary),
        "avg_words_per_turn": _round(words / len(user_turns)) if user_turns else 0.0,
        "filler_count": fillers,
        "filler_rate": _round((fillers / words) * 100) if words else 0.0,
        "avg_reply_ms": int(sum(latencies) / len(latencies)) if latencies else 0,
    }


def build_overview(user: dict) -> dict:
    user_id = user["_id"]
    sessions = _load_sessions(user_id)

    all_user_turns = [t for s in sessions for t in s.get("turns", []) if t.get("role") == "user"]
    all_assistant_turns = [
        t for s in sessions for t in s.get("turns", []) if t.get("role") == "assistant"
    ]

    total_words = sum(t.get("word_count", 0) for t in all_user_turns)
    all_words = [w for t in all_user_turns for w in _words(t.get("content", ""))]
    unique_words = set(all_words)
    total_fillers = sum(_count_fillers(t.get("content", "")) for t in all_user_turns)

    avg_words_per_turn = (total_words / len(all_user_turns)) if all_user_turns else 0.0
    diversity = (len(unique_words) / len(all_words)) if all_words else 0.0
    filler_rate = (total_fillers / total_words * 100) if total_words else 0.0

    total_seconds = sum(s.get("duration_seconds", 0) for s in sessions)
    completed = [s for s in sessions if s.get("status") == "completed"]

    return {
        "totals": {
            "sessions": len(sessions),
            "completed_sessions": len(completed),
            "practice_seconds": total_seconds,
            "practice_minutes": _round(total_seconds / 60),
            "exchanges": len(all_user_turns),
            "words_spoken": total_words,
            "vocabulary_size": len(unique_words),
        },
        "quality": {
            "avg_words_per_turn": _round(avg_words_per_turn),
            "vocabulary_diversity": _round(diversity * 100),
            "filler_count": total_fillers,
            "filler_rate": _round(filler_rate),
            "fluency_score": _fluency_score(
                avg_words_per_turn, diversity, filler_rate, has_speech=bool(total_words)
            ),
            "avg_session_minutes": _round(total_seconds / 60 / len(sessions)) if sessions else 0.0,
        },
        "streak": read_streak(user),
        "latency": {
            "avg_stt_ms": _avg([t.get("stt_ms") for t in all_user_turns]),
            "avg_llm_ms": _avg([t.get("llm_ms") for t in all_assistant_turns]),
            "avg_tts_ms": _avg([t.get("tts_ms") for t in all_assistant_turns]),
        },
    }


def build_activity(user_id: ObjectId, days: int = 30) -> list[dict]:
    """Per-day activity for the last `days` days, including empty days."""
    sessions = _load_sessions(user_id)
    today = datetime.utcnow().date()
    window_start = today - timedelta(days=days - 1)

    buckets: dict = {
        window_start
        + timedelta(days=offset): {
            "date": (window_start + timedelta(days=offset)).isoformat(),
            "sessions": 0,
            "minutes": 0.0,
            "words": 0,
        }
        for offset in range(days)
    }

    for session in sessions:
        started_at = as_utc(session.get("started_at"))
        if started_at is None:
            continue

        day = started_at.date()
        if day not in buckets:
            continue

        bucket = buckets[day]
        bucket["sessions"] += 1
        bucket["minutes"] = _round(bucket["minutes"] + session.get("duration_seconds", 0) / 60)
        bucket["words"] += sum(
            t.get("word_count", 0) for t in session.get("turns", []) if t.get("role") == "user"
        )

    return [buckets[key] for key in sorted(buckets)]


def build_progress(user_id: ObjectId, limit: int = 12) -> list[dict]:
    """Per-session fluency signals, oldest first, so trends read left to right."""
    sessions = list(reversed(_load_sessions(user_id, limit=limit)))

    progress = []
    for index, session in enumerate(sessions, start=1):
        summary = session_summary(session)
        started_at = as_utc(session.get("started_at"))
        progress.append(
            {
                "label": f"S{index}",
                "session_id": session["_id"],
                "date": started_at.date().isoformat() if started_at else None,
                "avg_words_per_turn": summary["avg_words_per_turn"],
                "filler_rate": summary["filler_rate"],
                "words_spoken": summary["words_spoken"],
                "unique_words": summary["unique_words"],
            }
        )
    return progress


def build_vocabulary(user_id: ObjectId, limit: int = 15) -> dict:
    sessions = _load_sessions(user_id)
    user_turns = [t for s in sessions for t in s.get("turns", []) if t.get("role") == "user"]

    counter = Counter(
        word
        for turn in user_turns
        for word in _words(turn.get("content", ""))
        if word not in STOPWORDS and word not in WORD_FILLERS and len(word) > 2
    )

    filler_counter: Counter = Counter()
    for turn in user_turns:
        lowered = (turn.get("content") or "").lower()
        for phrase in PHRASE_FILLERS:
            found = lowered.count(phrase)
            if found:
                filler_counter[phrase] += found
                lowered = lowered.replace(phrase, " ")
        for word in _words(lowered):
            if word in WORD_FILLERS:
                filler_counter[word] += 1

    return {
        "top_words": [{"word": w, "count": c} for w, c in counter.most_common(limit)],
        "top_fillers": [{"word": w, "count": c} for w, c in filler_counter.most_common(8)],
    }


def build_sessions_list(user_id: ObjectId, limit: int = 20) -> list[dict]:
    return [session_summary(s) for s in _load_sessions(user_id, limit=limit)]
