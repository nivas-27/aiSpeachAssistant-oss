"""Backfill users.practice from existing session history.

Idempotent - recomputes from sessions every time, so it is also the repair tool
if a stored counter is ever suspected of having drifted.

    .\\venv\\Scripts\\python.exe scripts\\backfill_streaks.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import get_db, ping  # noqa: E402
from app.models.db_models import as_utc  # noqa: E402
from app.services.analytics_service import _streaks  # noqa: E402


def main() -> int:
    ok, message = ping()
    print(f"MongoDB: {message}")
    if not ok:
        return 1

    db = get_db()
    users = db["users"]
    sessions = db["practice_sessions"]

    updated = 0
    for user in users.find({}, {"email": 1}):
        days = [
            as_utc(s["started_at"]).date()
            for s in sessions.find({"user_id": user["_id"]}, {"started_at": 1})
            if s.get("started_at")
        ]

        current, longest = _streaks(days)
        last = max(days).isoformat() if days else None

        users.update_one(
            {"_id": user["_id"]},
            {
                "$set": {
                    "practice": {
                        "last_practice_date": last,
                        "current_streak": current,
                        "longest_streak": longest,
                    }
                }
            },
        )
        updated += 1
        print(
            f"  {user.get('email', user['_id'])}: {len(days)} session day(s) -> "
            f"current {current}, longest {longest}, last {last}"
        )

    print(f"\nBackfilled {updated} user(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
