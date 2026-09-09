"""One place that knows how to send an email.

Extracted from otp_service so passcodes and operational alerts share the same
SMTP settings and the same fallback behaviour: if no mail server is configured,
or delivery fails, the message is printed to the backend console rather than
raising into the caller.
"""

import smtplib
from datetime import datetime
from email.message import EmailMessage

from app.core.config import settings


def send_email(to: str, subject: str, body: str, *, context: str = "email") -> bool:
    """Deliver a plain-text email. Returns True only if SMTP accepted it.

    Never raises: a broken mailbox must not take down a practice session.
    """
    if not settings.smtp_configured:
        print(
            f"\n{'=' * 62}\n"
            f"  [{context}] SMTP not configured - message not sent\n"
            f"  To: {to}\n  Subject: {subject}\n\n{body}\n"
            f"{'=' * 62}\n",
            flush=True,
        )
        return False

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.SMTP_FROM
    message["To"] = to
    message.set_content(body)

    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as smtp:
            if settings.SMTP_STARTTLS:
                smtp.starttls()
            if settings.SMTP_USER and settings.SMTP_PASSWORD:
                smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.send_message(message)
        return True
    except Exception as exc:
        print(
            f"[{datetime.now().isoformat()}] SMTP send failed | context={context} | "
            f"to={to} | type={type(exc).__name__} | message={str(exc)[:200]}",
            flush=True,
        )
        return False
