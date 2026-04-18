from fastapi import FastAPI
from app.routes.transcribe import router as transcribe_router
from app.routes.audio import router as audio_router
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # later restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(transcribe_router)
app.include_router(audio_router)

@app.get("/")
async def root():
    return {"message": "Welcome to the AI Speech Assistant API!"}