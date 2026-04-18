import os
import uuid

UPLOAD_DIR = "uploads"
OUTPUT_DIR = "tts-outputs"

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

def save_upload_file(file, extension=".wav"):
    filename = f"{uuid.uuid4()}{extension}"
    file_path = os.path.join(UPLOAD_DIR, filename)

    with open(file_path, "wb") as buffer:
        buffer.write(file)

    return file_path

def save_output_file(file, extension=".mp3"):
    filename = f"{uuid.uuid4()}{extension}"
    file_path = os.path.join(OUTPUT_DIR, filename)

    with open(file_path, "wb") as buffer:
        buffer.write(file)

    return file_path