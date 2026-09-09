"""Fold the standalone `turns` collection into practice_sessions.turns.

Idempotent: sessions that already carry an embedded array are skipped, so it is
safe to run more than once. Run from the backend directory:

    .\\venv\\Scripts\\python.exe scripts\\migrate_embed_turns.py [--drop]

Pass --drop to remove the old collection once the counts line up.
"""

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import get_db, ping  # noqa: E402

TURN_FIELDS = ("role", "content", "word_count", "created_at", "stt_ms", "llm_ms", "tts_ms")


def main() -> int:
    ok, message = ping()
    print(f"MongoDB: {message}")
    if not ok:
        return 1

    db = get_db()
    sessions = db["practice_sessions"]

    if "turns" not in db.list_collection_names():
        print("No `turns` collection found - nothing to migrate.")
        return 0

    legacy = db["turns"]
    total = legacy.count_documents({})
    print(f"Legacy turn documents: {total}")

    grouped = defaultdict(list)
    for turn in legacy.find().sort("created_at", 1):
        grouped[turn["session_id"]].append({key: turn.get(key) for key in TURN_FIELDS})

    migrated = skipped = orphaned = 0

    for session_id, turns in grouped.items():
        session = sessions.find_one({"_id": session_id}, {"turns": 1})

        if session is None:
            orphaned += len(turns)
            print(f"  ! {session_id[:12]} - no such session, {len(turns)} turn(s) left behind")
            continue

        if session.get("turns"):
            skipped += len(turns)
            continue

        sessions.update_one({"_id": session_id}, {"$set": {"turns": turns}})
        migrated += len(turns)
        print(f"  + {session_id[:12]} <- {len(turns)} turn(s)")

    # Any session that never had turns still needs the field to exist.
    backfilled = sessions.update_many(
        {"turns": {"$exists": False}}, {"$set": {"turns": []}}
    ).modified_count

    print(
        f"\nMigrated {migrated}, already embedded {skipped}, "
        f"orphaned {orphaned}, empty sessions backfilled {backfilled}"
    )

    embedded_total = sum(
        len(s.get("turns", [])) for s in sessions.find({}, {"turns": 1})
    )
    print(f"Turns now embedded across all sessions: {embedded_total}")

    if "--drop" in sys.argv:
        if embedded_total + orphaned < total:
            print("Refusing to drop: embedded count is lower than the legacy count.")
            return 1
        legacy.drop()
        print("Dropped the legacy `turns` collection.")
    else:
        print("\nLegacy collection kept. Re-run with --drop once you are happy.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
