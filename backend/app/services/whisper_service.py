import whisper
import torch

# Load model on GPU if available
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

model = whisper.load_model("medium").to(DEVICE)


def transcribe_audio(file_path: str):
    try:
        result = model.transcribe(
            file_path,
            language="en",
            task="transcribe",
            fp16=torch.cuda.is_available()  # use fast FP16 on GPU
        )

        text = result.get("text", "").strip()

        # Basic validation (avoid garbage output)
        if len(text.split()) < 3:
            return None

        return text

    except Exception as e:
        print(f"[Whisper Error] {e}")
        return None