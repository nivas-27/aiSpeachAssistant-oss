from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pymongo.errors import DuplicateKeyError

from app.core.config import settings
from app.core.database import password_resets, pending_signups, users
from app.core.deps import get_current_user
from app.core.security import create_access_token, hash_password, verify_password
from app.models.auth_models import (
    AuthResponse,
    ForgotPasswordRequest,
    LoginRequest,
    OtpChallengeResponse,
    ResendOtpRequest,
    ResetPasswordRequest,
    SignupRequest,
    SimpleMessage,
    UserPublic,
    VerifyOtpRequest,
)
from app.core.soft_delete import live, new_fields, soft_delete_one
from app.models.db_models import as_utc, new_user, user_public, utcnow
from app.services import otp_service

router = APIRouter(prefix="/auth", tags=["auth"])


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _challenge(email: str, code: str, delivered: bool, message: str) -> OtpChallengeResponse:
    return OtpChallengeResponse(
        email=email,
        expires_in_minutes=settings.OTP_TTL_MINUTES,
        resend_in_seconds=settings.OTP_RESEND_SECONDS,
        delivered_by_email=delivered,
        message=message,
        dev_code=code if settings.expose_otp_in_response else None,
    )


def _auth_response(user: dict) -> AuthResponse:
    public = user_public(user)
    return AuthResponse(
        access_token=create_access_token(public["id"], public["email"]),
        user=UserPublic(**public),
    )


def _guard_resend(record: dict | None) -> None:
    """Rate-limit code requests so the endpoint cannot be used to spam email."""
    if not record:
        return

    wait = otp_service.seconds_until_resend(as_utc(record.get("last_sent_at")))
    if wait > 0:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Please wait {wait} seconds before requesting another code",
        )


# ═══ Signup: request a code, then verify it ═════════════════════════════════

@router.post("/signup", response_model=OtpChallengeResponse, status_code=status.HTTP_202_ACCEPTED)
def signup(payload: SignupRequest) -> OtpChallengeResponse:
    """Step 1. Holds the details in `pending_signups` - no account yet."""
    email = _normalize_email(payload.email)

    if users().find_one(live({"email": email})):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        )

    _guard_resend(pending_signups().find_one(live({"email": email})))

    code = otp_service.generate_code()
    now = utcnow()

    pending_signups().update_one(
        live({"email": email}),
        {
            "$set": {
                **new_fields(),
                "email": email,
                "full_name": payload.full_name,
                "password_hash": hash_password(payload.password),
                "code_hash": otp_service.hash_code(code),
                "attempts": 0,
                "last_sent_at": now,
                "created_at": now,
                "expires_at": otp_service.expiry(),
            }
        },
        upsert=True,
    )

    delivered = otp_service.send_code(email, code, "signup", payload.full_name)
    return _challenge(
        email,
        code,
        delivered,
        f"We sent a {settings.OTP_LENGTH}-digit code to {email}."
        if delivered
        else "Email delivery is not configured, so the code is in the backend console.",
    )


@router.post("/signup/verify", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def verify_signup(payload: VerifyOtpRequest) -> AuthResponse:
    """Step 2. A correct code turns the pending signup into a real account."""
    email = _normalize_email(payload.email)
    pending = pending_signups().find_one(live({"email": email}))

    if pending is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No pending signup for this email. Please start again.",
        )

    expires_at = as_utc(pending.get("expires_at"))
    if expires_at and expires_at < datetime.now(timezone.utc):
        soft_delete_one(pending_signups(), {"email": email})
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="That code has expired. Please request a new one.",
        )

    if pending.get("attempts", 0) >= settings.OTP_MAX_ATTEMPTS:
        soft_delete_one(pending_signups(), {"email": email})
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many incorrect codes. Please start again.",
        )

    if not otp_service.verify_code(payload.code.strip(), pending["code_hash"]):
        pending_signups().update_one(live({"email": email}), {"$inc": {"attempts": 1}})
        remaining = settings.OTP_MAX_ATTEMPTS - pending.get("attempts", 0) - 1
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"That code is not correct. {max(0, remaining)} attempts left.",
        )

    document = new_user(email, pending["full_name"], pending["password_hash"])

    try:
        result = users().insert_one(document)
    except DuplicateKeyError:
        # Someone completed signup for this email between the two steps.
        soft_delete_one(pending_signups(), {"email": email})
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        )

    soft_delete_one(pending_signups(), {"email": email})
    document["_id"] = result.inserted_id
    return _auth_response(document)


@router.post("/signup/resend", response_model=OtpChallengeResponse)
def resend_signup_code(payload: ResendOtpRequest) -> OtpChallengeResponse:
    email = _normalize_email(payload.email)
    pending = pending_signups().find_one(live({"email": email}))

    if pending is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No pending signup for this email. Please start again.",
        )

    _guard_resend(pending)

    code = otp_service.generate_code()
    pending_signups().update_one(
        live({"email": email}),
        {
            "$set": {
                "code_hash": otp_service.hash_code(code),
                "attempts": 0,
                "last_sent_at": utcnow(),
                "expires_at": otp_service.expiry(),
            }
        },
    )

    delivered = otp_service.send_code(email, code, "signup", pending.get("full_name"))
    return _challenge(email, code, delivered, "We sent you a new code.")


# ═══ Login ══════════════════════════════════════════════════════════════════

@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest) -> AuthResponse:
    email = _normalize_email(payload.email)
    user = users().find_one(live({"email": email}))

    # Same message for unknown email and bad password - do not leak which failed.
    if user is None or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )

    users().update_one(live({"_id": user["_id"]}), {"$set": {"last_login_at": utcnow()}})
    return _auth_response(user)


# ═══ Forgot password ════════════════════════════════════════════════════════

@router.post("/forgot-password", response_model=OtpChallengeResponse)
def forgot_password(payload: ForgotPasswordRequest) -> OtpChallengeResponse:
    """Always reports success so the endpoint cannot enumerate accounts."""
    email = _normalize_email(payload.email)
    user = users().find_one(live({"email": email}))

    generic = "If an account exists for that email, a reset code is on its way."

    if user is None:
        return _challenge(email, "", False, generic)

    _guard_resend(password_resets().find_one(live({"email": email})))

    code = otp_service.generate_code()
    password_resets().update_one(
        live({"email": email}),
        {
            "$set": {
                **new_fields(),
                "email": email,
                "code_hash": otp_service.hash_code(code),
                "attempts": 0,
                "last_sent_at": utcnow(),
                "expires_at": otp_service.expiry(),
            }
        },
        upsert=True,
    )

    delivered = otp_service.send_code(email, code, "reset", user.get("full_name"))
    return _challenge(email, code, delivered, generic)


@router.post("/reset-password", response_model=SimpleMessage)
def reset_password(payload: ResetPasswordRequest) -> SimpleMessage:
    email = _normalize_email(payload.email)
    record = password_resets().find_one(live({"email": email}))

    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No reset request for this email. Please start again.",
        )

    expires_at = as_utc(record.get("expires_at"))
    if expires_at and expires_at < datetime.now(timezone.utc):
        soft_delete_one(password_resets(), {"email": email})
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="That code has expired. Please request a new one.",
        )

    if record.get("attempts", 0) >= settings.OTP_MAX_ATTEMPTS:
        soft_delete_one(password_resets(), {"email": email})
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many incorrect codes. Please start again.",
        )

    if not otp_service.verify_code(payload.code.strip(), record["code_hash"]):
        password_resets().update_one(live({"email": email}), {"$inc": {"attempts": 1}})
        remaining = settings.OTP_MAX_ATTEMPTS - record.get("attempts", 0) - 1
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"That code is not correct. {max(0, remaining)} attempts left.",
        )

    user = users().find_one(live({"email": email}))
    if user is None:
        soft_delete_one(password_resets(), {"email": email})
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")

    users().update_one(
        live({"_id": user["_id"]}),
        {"$set": {"password_hash": hash_password(payload.password), "password_changed_at": utcnow()}},
    )
    soft_delete_one(password_resets(), {"email": email})

    return SimpleMessage(message="Your password has been changed. You can sign in now.")


# ═══ Current user ═══════════════════════════════════════════════════════════

@router.get("/me", response_model=UserPublic)
def me(current_user: dict = Depends(get_current_user)) -> UserPublic:
    return UserPublic(**user_public(current_user))
