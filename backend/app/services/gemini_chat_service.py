import json
import os
import time
from datetime import datetime

from dotenv import load_dotenv
from google import genai

from app.models.chat_models import ChatReply
from app.services import llm_telemetry
from app.services.conversation_memory_service import conversation_memory_service

load_dotenv()

SYSTEM_PROMPT = """
You are an English learning assistant.

TASK:
- Read the user's sentence
- Give a short, natural reply
- ALWAYS include exactly ONE follow-up question

STRICT RULES:
- The reply MUST end with a question mark (?)
- The reply MUST contain exactly ONE question
- The reply must be 1-2 sentences maximum
- The question must be relevant to the user's input

OUTPUT RULES:
- Return ONLY valid JSON
- No extra text
- No explanation

FORMAT:
{"reply":"...?"}
"""

STREAMING_SYSTEM_PROMPT = """
You are an English learning assistant.

TASK:
- Read the user's sentence
- Give a short, natural reply
- ALWAYS include exactly ONE follow-up question

STRICT RULES:
- Return plain text only
- The reply MUST end with a question mark (?)
- The reply MUST contain exactly ONE question
- The reply must be 1-2 sentences maximum
- The question must be relevant to the user's input
- Do not use JSON
- Do not use markdown
"""

FALLBACK_MESSAGE = "Sorry, I couldn't respond right now. Can you try again?"


class GeminiChatService:
    def __init__(self):
        self.client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        # Both previous fallbacks (gemini-2.0-flash, gemini-1.5-flash-latest)
        # were retired and returned 404, which made the fallback chain dead:
        # any failure of the primary model went straight to the canned reply.
        # These three are all live and confirmed against the ListModels API.
        self.model_names = [
            "gemini-2.5-flash-lite",
            "gemini-flash-lite-latest",
            "gemini-2.5-flash",
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
        reply_text = self._ensure_follow_up_question(reply_text)
        reply = ChatReply(reply=reply_text)
        conversation_memory_service.add_assistant_message(session_id, reply.reply)
        return reply

    def stream_chat(self, user_input: str, session_id: str):
        conversation_memory_service.add_user_message(session_id, user_input)
        messages = self._build_messages(session_id)

        reply_chunks: list[str] = []
        streamed_reply = ""

        for model_name in self.model_names:
            started = time.perf_counter()
            usage: dict = {}
            try:
                stream = self.client.models.generate_content_stream(
                    model=model_name,
                    contents=self._build_contents(messages, stream_mode=True),
                    config={
                        "system_instruction": STREAMING_SYSTEM_PROMPT.strip(),
                        "temperature": 0,
                        "max_output_tokens": 256,
                    },
                )
            except Exception as exc:
                print(
                    f"[{datetime.now().isoformat()}] gemini stream setup error | "
                    f"model={model_name} | type={type(exc).__name__} | message={str(exc)[:300]}"
                )
                llm_telemetry.record_failure(
                    provider="gemini",
                    operation="chat",
                    model=model_name,
                    error=exc,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    session_id=session_id,
                )
                continue

            try:
                for chunk in stream:
                    # Usage arrives on the final chunks; keep the latest seen.
                    chunk_usage = llm_telemetry.extract_usage(chunk)
                    if chunk_usage:
                        usage = chunk_usage

                    text = getattr(chunk, "text", None)
                    if not isinstance(text, str) or not text:
                        continue

                    reply_chunks.append(text)
                    streamed_reply += text
                    yield {"type": "reply_chunk", "delta": text, "reply": streamed_reply}
            except Exception as exc:
                print(
                    f"[{datetime.now().isoformat()}] gemini stream read error | "
                    f"model={model_name} | type={type(exc).__name__} | message={str(exc)[:300]}"
                )
                llm_telemetry.record_failure(
                    provider="gemini",
                    operation="chat",
                    model=model_name,
                    error=exc,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    session_id=session_id,
                )
                reply_chunks = []
                streamed_reply = ""
                continue

            if reply_chunks:
                llm_telemetry.record(
                    provider="gemini",
                    operation="chat",
                    model=model_name,
                    ok=True,
                    usage=usage,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    session_id=session_id,
                    extra={"streamed": True, "reply_characters": len(streamed_reply)},
                )
                break

            # The call succeeded but produced nothing usable - a bad response.
            llm_telemetry.record(
                provider="gemini",
                operation="chat",
                model=model_name,
                ok=False,
                kind=llm_telemetry.BAD_RESPONSE,
                message="stream returned no text",
                usage=usage,
                latency_ms=int((time.perf_counter() - started) * 1000),
                session_id=session_id,
                extra={"streamed": True},
            )

        if reply_chunks:
            reply_text = self._ensure_follow_up_question("".join(reply_chunks).strip())
        else:
            print(f"[{datetime.now().isoformat()}] gemini stream fallback | reason=empty_stream_output")
            llm_telemetry.record(
                provider="gemini",
                operation="chat",
                ok=False,
                kind=llm_telemetry.BAD_RESPONSE,
                message="every model failed, falling back to the canned reply",
                session_id=session_id,
                extra={"fallback": True},
            )
            raw_output = self._call_gemini(messages)
            parsed = self._parse_with_retry(raw_output, messages)

            if parsed is None:
                reply_text = FALLBACK_MESSAGE
            else:
                reply_text = str(parsed.get("reply", "Can you say that again?")).strip() or "Can you say that again?"
                reply_text = self._ensure_follow_up_question(reply_text)

            yield {"type": "reply_chunk", "delta": reply_text, "reply": reply_text}

        reply = ChatReply(reply=reply_text)
        conversation_memory_service.add_assistant_message(session_id, reply.reply)
        yield {"type": "reply_done", "reply": reply.reply}

    def _build_messages(self, session_id: str) -> list[dict[str, str]]:
        context = conversation_memory_service.get_recent_context(session_id)
        return [{"role": item.role, "content": item.content} for item in context]

    def _build_contents(self, messages: list[dict[str, str]], stream_mode: bool = False) -> list[dict]:
        contents = []
        for msg in messages:
            role = "model" if msg["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})

        reinforce_text = (
            "Always continue the conversation in plain text and ask exactly one relevant follow-up question."
            if stream_mode
            else "Always continue the conversation and ask exactly one relevant follow-up question."
        )
        contents.insert(0, {
            "role": "user",
            "parts": [{"text": reinforce_text}],
        })

        return contents

    def _ensure_follow_up_question(self, reply: str) -> str:
        reply = reply.strip()

        if "?" not in reply:
            reply += " Can you tell me more about that?"

        parts = reply.split("?")
        if len(parts) > 2:
            reply = parts[0] + "?"

        return reply

    def _call_gemini(self, messages: list[dict[str, str]]) -> str:
        contents = self._build_contents(messages)

        for model_name in self.model_names:
            started = time.perf_counter()
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
                llm_telemetry.record_failure(
                    provider="gemini",
                    operation="chat",
                    model=model_name,
                    error=exc,
                    latency_ms=int((time.perf_counter() - started) * 1000),
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
                llm_telemetry.record(
                    provider="gemini",
                    operation="chat",
                    model=model_name,
                    ok=True,
                    usage=llm_telemetry.extract_usage(response),
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    extra={"streamed": False, "finish_reason": str(finish_reason)},
                )
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


def stream_chat_with_gemini(user_input: str, session_id: str):
    return gemini_chat_service.stream_chat(user_input=user_input, session_id=session_id)
