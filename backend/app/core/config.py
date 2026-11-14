import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent.parent


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    """Application settings resolved from the environment."""

    APP_NAME: str = "Fluently - AI Speech Practice"

    # Auth
    JWT_SECRET: str = os.getenv("JWT_SECRET") or secrets.token_urlsafe(48)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_DAYS: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_DAYS", "7"))

    # MongoDB
    MONGODB_URI: str = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    MONGODB_DB: str = os.getenv("MONGODB_DB", "fluently")
    # Fail fast with a readable error instead of hanging when mongod is down.
    MONGODB_TIMEOUT_MS: int = int(os.getenv("MONGODB_TIMEOUT_MS", "4000"))

    # Practice session rules
    SESSION_DURATION_SECONDS: int = int(os.getenv("SESSION_DURATION_SECONDS", "1200"))

    # One-time passcodes
    OTP_LENGTH: int = int(os.getenv("OTP_LENGTH", "6"))
    OTP_TTL_MINUTES: int = int(os.getenv("OTP_TTL_MINUTES", "10"))
    OTP_MAX_ATTEMPTS: int = int(os.getenv("OTP_MAX_ATTEMPTS", "5"))
    OTP_RESEND_SECONDS: int = int(os.getenv("OTP_RESEND_SECONDS", "60"))

    # SMTP - when unset, codes are printed to the server console instead
    SMTP_HOST: str | None = os.getenv("SMTP_HOST") or None
    SMTP_PORT: int = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USER: str | None = os.getenv("SMTP_USER") or None
    SMTP_PASSWORD: str | None = os.getenv("SMTP_PASSWORD") or None
    SMTP_FROM: str = os.getenv("SMTP_FROM", "Fluently <no-reply@fluently.local>")
    SMTP_STARTTLS: bool = _as_bool(os.getenv("SMTP_STARTTLS"), True)

    # Operational alerts (spent credit, rejected key) go here. Defaults to the
    # SMTP account itself, so configuring mail is enough to start getting them.
    ALERT_EMAIL_TO: str | None = os.getenv("ALERT_EMAIL_TO") or os.getenv("SMTP_USER") or None
    LLM_ALERT_COOLDOWN_MINUTES: int = int(os.getenv("LLM_ALERT_COOLDOWN_MINUTES", "180"))

    # Optional: when set, only these emails (comma-separated) may log in. Empty = open.
    ALLOWED_LOGIN_EMAILS_RAW: str = os.getenv("ALLOWED_LOGIN_EMAILS", "")
    ADMIN_NOTIFY_EMAIL: str | None = os.getenv("ADMIN_NOTIFY_EMAIL") or ALERT_EMAIL_TO

    @property
    def allowed_login_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.ALLOWED_LOGIN_EMAILS_RAW.split(",") if e.strip()}

    @property
    def smtp_configured(self) -> bool:
        return bool(self.SMTP_HOST)

    @property
    def expose_otp_in_response(self) -> bool:
        """Return the code in the API response so local testing is possible.

        Only ever true when no SMTP server is configured - i.e. there is no way
        to actually deliver the code. Configure SMTP and this turns itself off.
        """
        if self.smtp_configured:
            return False
        return _as_bool(os.getenv("OTP_DEV_ECHO"), True)

    @property
    def jwt_secret_is_ephemeral(self) -> bool:
        return os.getenv("JWT_SECRET") is None


settings = Settings()
