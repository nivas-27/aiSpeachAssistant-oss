from fastapi import Header, HTTPException, status

from app.core.database import users
from app.core.security import decode_access_token
from app.core.soft_delete import live
from app.models.db_models import to_object_id

CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise CREDENTIALS_ERROR

    payload = decode_access_token(authorization.split(" ", 1)[1].strip())
    if not payload:
        raise CREDENTIALS_ERROR

    user_id = to_object_id(payload.get("sub", ""))
    if user_id is None:
        raise CREDENTIALS_ERROR

    user = users().find_one(live({"_id": user_id}))
    if user is None:
        raise CREDENTIALS_ERROR

    return user
