import edge_tts
import os
import uuid

OUTPUT_DIR = "tts-outputs"

async def generate_audio_edge(text, file_path=None):
    if file_path is None:
        file_path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4().hex}.mp3")

    communicate = edge_tts.Communicate(
        text=text,
        voice="en-IN-NeerjaNeural"
    )

    await communicate.save(file_path)

    return file_path