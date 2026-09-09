"""Soft-delete convention for every collection in this database.

Nothing is ever physically removed. A record is retired by setting
`deleted: true` (with a `deleted_at` timestamp) and every read filters it out.

Two rules keep this honest:

1. Every document is created with `deleted: False` - written explicitly, not
   left absent - so partial indexes can key on it.
2. Every read goes through `live()`, which excludes retired records.

Uniqueness needs care under this scheme: a retired signup for an address must
not block a fresh one. The unique indexes are therefore *partial*, covering
only documents where `deleted` is `False`. MongoDB does not accept `$ne` inside
a partialFilterExpression, which is exactly why rule 1 exists.
"""

from datetime import datetime, timezone
from typing import Any

# Reads tolerate a missing field so a document written before this convention
# existed is still treated as live rather than silently vanishing.
NOT_DELETED = {"$ne": True}

# Indexes must use an exact match; `$ne` is not allowed in a partial filter.
LIVE_INDEX_FILTER = {"deleted": False}


def live(query: dict[str, Any] | None = None) -> dict[str, Any]:
    """Add the not-deleted condition to a query."""
    return {**(query or {}), "deleted": NOT_DELETED}


def new_fields() -> dict[str, Any]:
    """The soft-delete fields every new document carries."""
    return {"deleted": False, "deleted_at": None}


def deletion_update() -> dict[str, Any]:
    """The update that retires a document."""
    return {"$set": {"deleted": True, "deleted_at": datetime.now(timezone.utc)}}


def soft_delete_one(collection, query: dict[str, Any]):
    """Retire a single live document. Never removes anything."""
    return collection.update_one(live(query), deletion_update())


def soft_delete_many(collection, query: dict[str, Any]):
    """Retire every live document matching the query."""
    return collection.update_many(live(query), deletion_update())
