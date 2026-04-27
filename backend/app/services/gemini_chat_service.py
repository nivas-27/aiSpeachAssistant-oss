import json
import os
from datetime import datetime

from dotenv import load_dotenv
from google import genai

from app.models.chat_models import ChatReply
from app.services.conversation_memory_service import conversation_memory_service

load_dotenv()

SYSTEM_PROMPT = """
You are an English learning assistant.

TASK:
- Read the user's sentence
- Give a simple, natural reply
- Ask one simple follow-up question
- If the sentence is incorrect, include a corrected sentence in "suggestion"
- If the sentence is already correct, do not include "suggestion"

OUTPUT RULES:
- Return ONLY valid JSON
- No extra text
- No explanation
- If incorrect: {"reply":"...","suggestion":"..."}
- If correct: {"reply":"..."}
"""

FALLBACK_MESSAGE = "Sorry, I couldn't respond right now. Can you try again?"


class GeminiChatService:
    def __init__(self):
        self.client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        self.model_names = [
            "gemini-2.5-flash-lite",
            "gemini-2.0-flash",
            "gemini-1.5-flash-latest",
        ]

    def chat(self, user_input: str, session_id: str) -> ChatReply:
        conversation_memory_service.add_user_message(session_id, user_input)
        messages = self._build_messages(session_id)

        raw_output = self._call_gemini(messages)
        parsed = self._parse_with_retry(raw_output, messages)

        if parsed is None:
            print(f"[{datetime.now().isoformat()}] gemini fallback used | reason=parse_or_empty_failure")
            reply = ChatReply(reply=FALLBACK_MESSAGE)
            conversation_memory_service.add_assistant_message(session_id, reply.reply)
            return reply

        reply_text = str(parsed.get("reply", "Can you say that again?")).strip() or "Can you say that again?"
        suggestion_text = parsed.get("suggestion")

        if isinstance(suggestion_text, str):
            suggestion_text = suggestion_text.strip()
            if not suggestion_text:
                suggestion_text = None
        else:
            suggestion_text = None

        if suggestion_text and suggestion_text == user_input.strip():
            suggestion_text = None

        reply = ChatReply(reply=reply_text, suggestion=suggestion_text)
        conversation_memory_service.add_assistant_message(session_id, reply.reply)
        return reply

    def _build_messages(self, session_id: str) -> list[dict[str, str]]:
        context = conversation_memory_service.get_recent_context(session_id)
        return [{"role": item.role, "content": item.content} for item in context]

    def _call_gemini(self, messages: list[dict[str, str]]) -> str:
        contents = []
        for msg in messages:
            role = "model" if msg["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})

        for model_name in self.model_names:
            try:
                response = self.client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config={
                        "system_instruction": SYSTEM_PROMPT.strip(),
                        "response_mime_type": "application/json",
                        "temperature": 0,
                        "max_output_tokens": 256,
                    },
                )
            except Exception as exc:
                print(
                    f"[{datetime.now().isoformat()}] gemini api error | "
                    f"model={model_name} | type={type(exc).__name__} | message={str(exc)[:300]}"
                )
                continue

            text = getattr(response, "text", None)
            candidates = getattr(response, "candidates", None)
            finish_reason = None
            if candidates:
                first_candidate = candidates[0]
                finish_reason = getattr(first_candidate, "finish_reason", None)

            print(
                f"[{datetime.now().isoformat()}] gemini raw response | "
                f"model={model_name} | text_type={type(text).__name__} | finish_reason={finish_reason} | "
                f"text_len={len(text) if isinstance(text, str) else 0} | "
                f"text_preview={str(text)[:300]}"
            )

            if isinstance(text, str) and text.strip():
                return text

            print(f"[{datetime.now().isoformat()}] gemini response missing text field | model={model_name}")

        return ""

    def _parse_with_retry(self, raw_output: str, messages: list[dict[str, str]]) -> dict | None:
        if raw_output:
            try:
                return self._safe_parse(raw_output)
            except ValueError as exc:
                print(
                    f"[{datetime.now().isoformat()}] gemini parse failed (first attempt) | "
                    f"error={exc} | raw_preview={raw_output[:300]}"
                )
        else:
            print(f"[{datetime.now().isoformat()}] gemini first attempt returned empty output")

        retry_output = self._call_gemini(messages)
        if retry_output:
            try:
                return self._safe_parse(retry_output)
            except ValueError as exc:
                print(
                    f"[{datetime.now().isoformat()}] gemini parse failed (retry) | "
                    f"error={exc} | raw_preview={retry_output[:300]}"
                )
                return None

        print(f"[{datetime.now().isoformat()}] gemini retry returned empty output")

        return None

    def _safe_parse(self, text: str) -> dict:
        text = (text or "").strip()
        if not text:
            raise ValueError("Empty model response")

        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        decoder = json.JSONDecoder()
        for index, char in enumerate(text):
            if char != "{":
                continue
            try:
                parsed, _ = decoder.raw_decode(text[index:])
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                continue

        raise ValueError("No valid JSON object found in model response")


gemini_chat_service = GeminiChatService()


def chat_with_gemini(user_input: str, session_id: str) -> dict:
    reply = gemini_chat_service.chat(user_input=user_input, session_id=session_id)
    return reply.to_response_dict()
