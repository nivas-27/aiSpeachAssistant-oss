from openai import OpenAI
import json

from dotenv import load_dotenv
import os

load_dotenv()

client = OpenAI(
    api_key=os.getenv("OPENAI_API_KEY"),
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
{"corrected":"...","suggestion":"...","reply":"..."}
"""

def safe_parse(text):
    try:
        return json.loads(text)
    except:
        start = text.find("{")
        end = text.rfind("}") + 1
        return json.loads(text[start:end])

def chat_with_gpt(user_input: str):
    response = client.chat.completions.create(
        model="Qwen3.5",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_input}
        ],
        max_tokens=150,
        temperature=0.3
    )
    msg = response.choices[0].message
    content = msg.content if isinstance(msg.content, str) else None

    if not content or not content.strip():
        # Return fallback instead of crashing
        return {
            "corrected": user_input,
            "suggestion": user_input,
            "reply": "I could not generate a response right now. Can you try again?"
        }

    parsed = safe_parse(content.strip())
    return {
        "corrected": parsed.get("corrected", user_input),
        "suggestion": parsed.get("suggestion", user_input),
        "reply": parsed.get("reply", "Can you say that again?")
    }