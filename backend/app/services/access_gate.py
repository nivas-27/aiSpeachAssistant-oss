"""Optional login allowlist: when ALLOWED_LOGIN_EMAILS is set, only those emails may sign in.

Others can still create an account, but it stays locked and the admin is emailed
so they can be approached and, if agreed, added to the allowlist. When the
setting is empty there is no restriction.
"""

from fastapi import HTTPException, status

from app.core.config import settings
from app.services.mailer import send_email

LOCKED_MESSAGE = (
    "Your account is created but not approved yet. "
    "Access is limited, so please contact the owner to get approved."
)


def is_allowed(email: str) -> bool:
    allowed = settings.allowed_login_emails
    return not allowed or email.strip().lower() in allowed


def require_allowed(email: str, code: int = status.HTTP_403_FORBIDDEN) -> None:
    """Raise unless this email is on the allowlist."""
    if not is_allowed(email):
        raise HTTPException(status_code=code, detail=LOCKED_MESSAGE)


def notify_new_account(email: str, full_name: str | None) -> bool:
    """Tell the admin someone signed up and is waiting for approval."""
    body = (
        f"A new account was created on {settings.APP_NAME}.\n\n"
        f"Name:  {full_name or '-'}\n"
        f"Email: {email}\n\n"
        "They cannot log in until you approve them. To let them in, add their email "
        "to ALLOWED_LOGIN_EMAILS in the backend .env and restart the backend."
    )
    recipient = settings.ADMIN_NOTIFY_EMAIL
    if not recipient:
        print(f"[new-signup] no ADMIN_NOTIFY_EMAIL / ALERT_EMAIL_TO set; signup by {email} not announced", flush=True)
        return False
    return send_email(recipient, f"New signup waiting for approval: {email}", body, context="new-signup")
