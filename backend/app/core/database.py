"""MongoDB connection and collection handles.

The whole app talks to Mongo through the accessors below, so the connection
string lives in exactly one place: MONGODB_URI in .env.
"""

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import PyMongoError, ServerSelectionTimeoutError

from app.core.config import settings
from app.core.soft_delete import LIVE_INDEX_FILTER

_client: MongoClient | None = None


def get_client() -> MongoClient:
    global _client
    if _client is None:
        _client = MongoClient(
            settings.MONGODB_URI,
            serverSelectionTimeoutMS=settings.MONGODB_TIMEOUT_MS,
            tz_aware=True,
        )
    return _client


def get_db():
    return get_client()[settings.MONGODB_DB]


# ─── Collection accessors ───────────────────────────────────────────────────

def users():
    return get_db()["users"]


def practice_sessions():
    return get_db()["practice_sessions"]


def pending_signups():
    """Signups awaiting email verification - never real accounts yet."""
    return get_db()["pending_signups"]


def password_resets():
    return get_db()["password_resets"]


def llm_events():
    """One row per model call - usage, failures and operator alerts."""
    return get_db()["llm_events"]


# ─── Startup ────────────────────────────────────────────────────────────────

def ping() -> tuple[bool, str]:
    """Check the server is reachable. Returns (ok, message)."""
    try:
        get_client().admin.command("ping")
        return True, "connected"
    except ServerSelectionTimeoutError:
        return False, (
            f"Cannot reach MongoDB at {settings.MONGODB_URI}. "
            "Is the mongod server running?"
        )
    except PyMongoError as exc:
        return False, f"MongoDB error: {exc}"


def init_db() -> tuple[bool, str]:
    """Create indexes. Safe to call repeatedly - Mongo ignores duplicates."""
    ok, message = ping()
    if not ok:
        return ok, message

    # Unique only among live records, so a retired row never blocks a new one.
    users().create_index(
        [("email", ASCENDING)],
        unique=True,
        partialFilterExpression=LIVE_INDEX_FILTER,
        name="uniq_live_email",
    )

    practice_sessions().create_index(
        [("user_id", ASCENDING), ("started_at", DESCENDING)], name="user_recent"
    )

    # No TTL indexes here on purpose. A TTL index physically removes documents,
    # which would defeat the soft-delete rule. Expiry is enforced in code, and an
    # expired record is retired rather than erased.
    pending_signups().create_index(
        [("email", ASCENDING)],
        unique=True,
        partialFilterExpression=LIVE_INDEX_FILTER,
        name="uniq_live_pending_email",
    )
    password_resets().create_index(
        [("email", ASCENDING)],
        unique=True,
        partialFilterExpression=LIVE_INDEX_FILTER,
        name="uniq_live_reset_email",
    )

    llm_events().create_index([("created_at", DESCENDING)], name="recent")
    llm_events().create_index(
        [("provider", ASCENDING), ("kind", ASCENDING), ("created_at", DESCENDING)],
        name="provider_kind_recent",
    )
    llm_events().create_index([("session_id", ASCENDING)], name="by_session")

    return True, "connected"


def close_client() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None
