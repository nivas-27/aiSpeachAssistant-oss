from openai import OpenAI
import json

from dotenv import load_dotenv
import os

load_dotenv()

print("Initializing OpenAI client with base_url:", "https://api.openadapter.in/v1")

client = OpenAI(
    api_key=os.getenv("OPENADAPTER_OPENAI_API_KEY"),
    base_url="https://api.openadapter.in/v1"
)

SYSTEM_PROMPT = """
You are an English speaking partner.

Rules:
- Keep replies simple and natural
- Always correct the user's sentence
- If the sentence is correct, keep it the same
- Provide a slightly better version (optional)
- Reply as a conversation partner (natural, friendly tone)
- Do NOT repeat the corrected sentence in the reply
- Always ask one simple follow-up question

STRICT OUTPUT RULES:
- Return ONLY valid JSON
- No markdown (no ```json)
- No explanations, no reasoning, no extra text
- Output must start with { and end with }

Format:
{"corrected":"...","reply":"..."}
"""


def _fallback_response(user_input: str):
    return {
        "corrected": user_input,
        "reply": "I could not generate a response right now. Can you try again?"
    }

def safe_parse(text: str):
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty model response")

    # Fast path: response is already a single valid JSON object.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Fallback: scan for the first decodable JSON object inside noisy output.
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[i:])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    raise ValueError("No valid JSON object found in model response")

def chat_with_gpt(user_input: str):
    response = client.chat.completions.create(
        model="Mistral-Small",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_input}
        ],
        max_tokens=220,
        temperature=0
    )

    print("Raw GPT response content:", response)
    print("Raw GPT response content (choices[0].message):", response.choices[0].message)
    msg = response.choices[0].message
    content = msg.content if isinstance(msg.content, str) else None

    if not content or not content.strip():
        return _fallback_response(user_input)

    try:
        parsed = safe_parse(content)
    except Exception as e:
        print("Failed to parse model JSON response:", e)
        print("Unparseable content:", content)
        return _fallback_response(user_input)

    return {
        "corrected": str(parsed.get("corrected", user_input)),
        "reply": str(parsed.get("reply", "Can you say that again?"))
    }
