"""Records the outcome of every model call, and shouts when credits run out.

Three jobs:

1. Persist one `llm_events` document per call - success or failure - with the
   usage metadata the provider returned (token counts, model, finish reason).
2. Classify failures, so a spent quota is distinguishable from a slow network.
3. Email the operator once when a provider reports it is out of credit, with a
   cooldown so a broken key cannot generate thousands of emails.

Nothing here may raise into a caller. A telemetry failure must never break a
practice session, so every entry point swallows its own errors.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.config import settings
from app.core.database import llm_events
from app.core.soft_delete import live
from app.models.db_models import new_llm_event
from app.services.mailer import send_email

# Failure kinds, ordered roughly by how urgently a human needs to know.
QUOTA_EXHAUSTED = "quota_exhausted"
RATE_LIMITED = "rate_limited"
AUTH_FAILED = "auth_failed"
BAD_RESPONSE = "bad_response"
SERVER_ERROR = "server_error"
TIMEOUT = "timeout"
UNKNOWN = "unknown"

# Telling "out of credit" apart from "slow down" is the whole game here, and it
# is not obvious: Gemini returns RESOURCE_EXHAUSTED with the identical sentence
# ("check your plan and billing details") for a per-minute burst AND for a spent
# daily allowance. The only reliable discriminator is the quotaId it names, so
# the transient markers are tested FIRST and win. Getting this backwards would
# email the operator on every burst limit.
_TRANSIENT_PHRASES = (
    "perminute",
    "per minute",
    "requestsperminute",
    "rate limit",
    "ratelimit",
    "too many requests",
    "please retry",
    "try again in",
)

_QUOTA_PHRASES = (
    "insufficient_quota",
    "perday",
    "per day",
    "requestsperday",
    "credit balance",
    "out of credits",
    "exceeded your current quota",
    "quota exceeded",
    "resource_exhausted",
    "billing hard limit",
)

_AUTH_PHRASES = (
    "invalid api key",
    "incorrect api key",
    "unauthorized",
    "api key not valid",
    "permission denied",
    "api_key_invalid",
)


def _status_of(error: Exception) -> int | None:
    for attribute in ("status_code", "code", "http_status"):
        value = getattr(error, attribute, None)
        if isinstance(value, int):
            return value
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def classify_error(error: Exception) -> str:
    """Work out what kind of failure this was, from the type, status and text."""
    text = f"{type(error).__name__} {error}".lower()
    status = _status_of(error)

    # Auth first: a rejected key is unambiguous and needs a human either way.
    if status in (401, 403) or any(phrase in text for phrase in _AUTH_PHRASES):
        return AUTH_FAILED

    # Transient before quota - see the note above the phrase lists.
    if any(phrase in text for phrase in _TRANSIENT_PHRASES):
        return RATE_LIMITED
    if any(phrase in text for phrase in _QUOTA_PHRASES):
        return QUOTA_EXHAUSTED
    if status == 429:
        return RATE_LIMITED

    if "timeout" in text or "timed out" in text:
        return TIMEOUT
    if status is not None and status >= 500:
        return SERVER_ERROR
    return UNKNOWN


def extract_usage(response: Any) -> dict[str, Any]:
    """Pull token counts off a provider response, whatever shape it arrives in.

    Gemini exposes `usage_metadata`, OpenAI exposes `usage`, and both change
    field names between versions - so read defensively and keep what is there.
    """
    usage: dict[str, Any] = {}
    if response is None:
        return usage

    source = (
        getattr(response, "usage_metadata", None)
        or getattr(response, "usage", None)
        or (response if isinstance(response, dict) else None)
    )
    if source is None:
        return usage

    def read(name: str):
        if isinstance(source, dict):
            return source.get(name)
        return getattr(source, name, None)

    mapping = {
        "prompt_tokens": ("prompt_token_count", "prompt_tokens", "input_tokens"),
        "output_tokens": ("candidates_token_count", "completion_tokens", "output_tokens"),
        "total_tokens": ("total_token_count", "total_tokens"),
        "cached_tokens": ("cached_content_token_count", "cached_tokens"),
    }

    for key, candidates in mapping.items():
        for name in candidates:
            value = read(name)
            if isinstance(value, int):
                usage[key] = value
                break

    if "total_tokens" not in usage and {"prompt_tokens", "output_tokens"} <= usage.keys():
        usage["total_tokens"] = usage["prompt_tokens"] + usage["output_tokens"]

    return usage


def record(
    *,
    provider: str,
    operation: str,
    model: str | None = None,
    ok: bool = True,
    kind: str | None = None,
    message: str | None = None,
    usage: dict[str, Any] | None = None,
    latency_ms: int | None = None,
    session_id: str | None = None,
    user_id: Any = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Write one telemetry row. Silent on failure - never breaks a session."""
    try:
        llm_events().insert_one(
            new_llm_event(
                provider=provider,
                operation=operation,
                model=model,
                ok=ok,
                kind=kind,
                message=(message or "")[:600] or None,
                usage=usage or {},
                latency_ms=latency_ms,
                session_id=session_id,
                user_id=user_id,
                extra=extra or {},
            )
        )
    except Exception as exc:  # pragma: no cover - telemetry must stay silent
        print(
            f"[{datetime.now().isoformat()}] llm telemetry write failed | "
            f"type={type(exc).__name__} | message={str(exc)[:160]}",
            flush=True,
        )


def record_failure(
    *,
    provider: str,
    operation: str,
    error: Exception,
    model: str | None = None,
    latency_ms: int | None = None,
    session_id: str | None = None,
    user_id: Any = None,
) -> str:
    """Record a failed call and, if credits are gone, alert the operator."""
    kind = classify_error(error)

    record(
        provider=provider,
        operation=operation,
        model=model,
        ok=False,
        kind=kind,
        message=str(error),
        latency_ms=latency_ms,
        session_id=session_id,
        user_id=user_id,
    )

    if kind in (QUOTA_EXHAUSTED, AUTH_FAILED):
        alert_operator(provider=provider, operation=operation, kind=kind, detail=str(error), model=model)

    return kind


def _recently_alerted(provider: str, kind: str) -> bool:
    since = datetime.now(timezone.utc) - timedelta(minutes=settings.LLM_ALERT_COOLDOWN_MINUTES)
    try:
        return llm_events().count_documents(
            live({
                "operation": "alert",
                "provider": provider,
                "kind": kind,
                "created_at": {"$gte": since},
            }),
            limit=1,
        ) > 0
    except Exception:
        # If the check itself fails, do not send - better a missed alert than
        # an unthrottled loop of them.
        return True


def alert_operator(
    *, provider: str, operation: str, kind: str, detail: str, model: str | None = None
) -> bool:
    """Email the operator that a provider has stopped serving requests."""
    recipient = settings.ALERT_EMAIL_TO
    if not recipient:
        print(
            f"[{datetime.now().isoformat()}] LLM ALERT ({kind}) for {provider} "
            f"but no SMTP_USER / ALERT_EMAIL_TO is set to notify",
            flush=True,
        )
        return False

    if _recently_alerted(provider, kind):
        return False

    headline = (
        f"{provider} has run out of credit"
        if kind == QUOTA_EXHAUSTED
        else f"{provider} rejected the API key"
    )

    subject = f"[Fluently] {headline}"
    body = (
        f"{headline}.\n\n"
        f"Provider : {provider}\n"
        f"Operation: {operation}\n"
        f"Model    : {model or 'n/a'}\n"
        f"Detected : {datetime.now(timezone.utc).isoformat()}\n\n"
        f"Provider said:\n{detail[:900]}\n\n"
        + (
            "Practice sessions will keep running, but replies will fall back to a "
            "canned message until this is topped up.\n"
            if kind == QUOTA_EXHAUSTED
            else "Requests to this provider are being refused until the key is fixed.\n"
        )
        + f"\nYou will not be emailed about this again for "
        f"{settings.LLM_ALERT_COOLDOWN_MINUTES} minutes.\n"
    )

    delivered = send_email(recipient, subject, body, context=f"llm-alert:{provider}")

    # Record the attempt either way - that is what throttles the next one.
    record(
        provider=provider,
        operation="alert",
        model=model,
        ok=delivered,
        kind=kind,
        message=detail,
        extra={"recipient": recipient, "delivered": delivered},
    )

    print(
        f"[{datetime.now().isoformat()}] LLM ALERT sent={delivered} | "
        f"provider={provider} | kind={kind} | to={recipient}",
        flush=True,
    )
    return delivered
