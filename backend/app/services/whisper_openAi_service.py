from openai import OpenAI
import os

# Initialize client (make sure OPENAI_API_KEY is set in env)
client = OpenAI(api_key=os.getenv("OPENAI_API_SECRET"))

def transcribe_audio(file_path: str):
    try:
        with open(file_path, "rb") as audio_file:
            result = client.audio.transcriptions.create(
                model="gpt-4o-mini-transcribe",  # recommended model
                file=audio_file
            )

        text = result.text.strip()

        # Basic validation (same as your old logic)
        if len(text.split()) < 3:
            return None

        return text

    except Exception as e:
        print(f"[OpenAI STT Error] {e}")
        return None