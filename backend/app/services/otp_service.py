"""One-time passcode generation, delivery and verification.

Codes are stored only as bcrypt hashes, so a database dump never reveals a live
passcode. Delivery goes over SMTP when configured; otherwise the code is printed
to the server console so local development still works.
"""

import secrets
from datetime import datetime, timedelta, timezone

import bcrypt

from app.core.config import settings
from app.services.mailer import send_email


def generate_code() -> str:
    upper = 10 ** settings.OTP_LENGTH
    return str(secrets.randbelow(upper)).zfill(settings.OTP_LENGTH)


def hash_code(code: str) -> str:
    return bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_code(code: str, code_hash: str) -> bool:
    try:
        return bcrypt.checkpw(code.encode("utf-8"), code_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=settings.OTP_TTL_MINUTES)


def _render(purpose: str, code: str, name: str | None) -> tuple[str, str]:
    greeting = f"Hi {name}," if name else "Hi,"

    if purpose == "signup":
        subject = f"{code} is your Fluently verification code"
        body = (
            f"{greeting}\n\n"
            f"Your Fluently verification code is: {code}\n\n"
            f"It expires in {settings.OTP_TTL_MINUTES} minutes. "
            "If you did not try to create an account, you can ignore this email.\n"
        )
    else:
        subject = f"{code} is your Fluently password reset code"
        body = (
            f"{greeting}\n\n"
            f"Your Fluently password reset code is: {code}\n\n"
            f"It expires in {settings.OTP_TTL_MINUTES} minutes. "
            "If you did not ask to reset your password, ignore this email and "
            "your password will stay unchanged.\n"
        )

    return subject, body


def send_code(email: str, code: str, purpose: str, name: str | None = None) -> bool:
    """Deliver a passcode. Returns True when it went out over SMTP."""
    subject, body = _render(purpose, code, name)

    delivered = send_email(email, subject, body, context=f"otp:{purpose}")

    if not delivered:
        # Make the code visible to whoever runs the backend, so local work and
        # a temporary mail outage both stay unblocked.
        print(
            f"  OTP ({purpose}) for {email}: {code} "
            f"(expires in {settings.OTP_TTL_MINUTES} minutes)",
            flush=True,
        )

    return delivered


def seconds_until_resend(last_sent_at: datetime | None) -> int:
    """How long the caller must wait before another code can be sent."""
    if last_sent_at is None:
        return 0

    if last_sent_at.tzinfo is None:
        last_sent_at = last_sent_at.replace(tzinfo=timezone.utc)

    elapsed = (datetime.now(timezone.utc) - last_sent_at).total_seconds()
    remaining = settings.OTP_RESEND_SECONDS - int(elapsed)
    return max(0, remaining)
