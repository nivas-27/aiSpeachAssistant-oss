import os
import uuid
from openai import AsyncOpenAI

OUTPUT_DIR = "tts-outputs"

client = AsyncOpenAI(
    api_key=os.getenv("OPENAI_API_SECRET")
)

async def generate_audio_openai(text, file_path=None):
    if file_path is None:
        file_path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4().hex}.mp3")

    # Ensure output directory exists
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Create speech
    response = await client.audio.speech.create(
        model="gpt-4o-mini-tts",
        voice="coral",  # you can change voice
        input=text,
        instructions="Speak in a clear and natural Indian English accent."
    )

    # Save file
    audio_bytes = response.read()
    with open(file_path, "wb") as f:
        f.write(audio_bytes)

    return file_path