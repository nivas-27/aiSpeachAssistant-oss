from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from app.core.config import settings
from app.core.database import close_client, init_db
from app.routes.analytics import router as analytics_router
from app.routes.audio import router as audio_router
from app.routes.auth import router as auth_router
from app.routes.sessions import router as sessions_router
from app.routes.transcribe import router as transcribe_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    ok, message = init_db()
    if ok:
        print(f"[startup] MongoDB {message} -> {settings.MONGODB_URI}/{settings.MONGODB_DB}")
    else:
        # Do not crash: the API should still boot so the failure is visible in
        # the response instead of an unexplained refused connection.
        print(f"[startup] WARNING: {message}")

    if settings.jwt_secret_is_ephemeral:
        print(
            "[startup] WARNING: JWT_SECRET is not set, so a random one was generated. "
            "Every restart will invalidate existing logins. Set JWT_SECRET in .env."
        )

    if not settings.smtp_configured:
        print(
            "[startup] NOTE: SMTP is not configured, so verification codes are "
            "printed to this console instead of being emailed."
        )

    yield
    close_client()


app = FastAPI(title=settings.APP_NAME, version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # later restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(sessions_router)
app.include_router(analytics_router)
app.include_router(transcribe_router)
app.include_router(audio_router)


@app.get("/")
async def root():
    return {"message": "Welcome to the AI Speech Assistant API!", "version": "1.1.0"}


@app.get("/health")
async def health():
    from app.core.database import ping

    ok, message = ping()
    return {"status": "ok" if ok else "degraded", "database": message}
