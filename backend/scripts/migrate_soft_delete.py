"""Adopt the soft-delete convention across every collection.

Three jobs, all idempotent:

1. Backfill `deleted: false` / `deleted_at: null` on documents written before
   the convention existed. Without this they would be invisible to reads that
   filter on the flag.
2. Drop TTL indexes. A TTL index physically removes documents, which is exactly
   what soft delete exists to prevent. Expiry is enforced in application code.
3. Replace plain unique indexes with partial ones covering only live documents,
   so a retired record never blocks a new one for the same email.

    .\\venv\\Scripts\\python.exe scripts\\migrate_soft_delete.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import get_db, init_db, ping  # noqa: E402

COLLECTIONS = ("users", "practice_sessions", "pending_signups", "password_resets")


def main() -> int:
    ok, message = ping()
    print(f"MongoDB: {message}")
    if not ok:
        return 1

    db = get_db()
    existing = set(db.list_collection_names())

    print("\n1. Backfilling the soft-delete flag")
    for name in COLLECTIONS:
        if name not in existing:
            print(f"   {name}: not present, skipped")
            continue
        result = db[name].update_many(
            {"deleted": {"$exists": False}},
            {"$set": {"deleted": False, "deleted_at": None}},
        )
        total = db[name].count_documents({})
        live = db[name].count_documents({"deleted": {"$ne": True}})
        print(f"   {name}: marked {result.modified_count}, now {live} live of {total}")

    print("\n2. Dropping TTL indexes (they delete documents outright)")
    dropped = 0
    for name in COLLECTIONS:
        if name not in existing:
            continue
        for index_name, spec in db[name].index_information().items():
            if "expireAfterSeconds" in spec:
                db[name].drop_index(index_name)
                dropped += 1
                print(f"   {name}: dropped TTL index `{index_name}`")
    if not dropped:
        print("   none found")

    print("\n3. Replacing full unique indexes with live-only partial ones")
    stale = {
        "users": ["uniq_email"],
        "pending_signups": ["uniq_pending_email"],
        "password_resets": ["uniq_reset_email"],
    }
    for name, index_names in stale.items():
        if name not in existing:
            continue
        present = db[name].index_information()
        for index_name in index_names:
            if index_name in present:
                db[name].drop_index(index_name)
                print(f"   {name}: dropped `{index_name}`")

    ok, message = init_db()
    print(f"   rebuilt indexes: {message}")

    print("\nFinal index state:")
    for name in COLLECTIONS:
        if name not in existing:
            continue
        for index_name, spec in db[name].index_information().items():
            extra = ""
            if spec.get("unique"):
                extra += " unique"
            if "partialFilterExpression" in spec:
                extra += f" partial={spec['partialFilterExpression']}"
            if "expireAfterSeconds" in spec:
                extra += " TTL!"
            print(f"   {name}.{index_name}{extra}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
