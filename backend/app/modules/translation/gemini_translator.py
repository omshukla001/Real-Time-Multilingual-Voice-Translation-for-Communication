import json
import logging
import os
import urllib.parse
import urllib.request
from typing import Optional

logger = logging.getLogger("talkbridge.translation.gemini")

# gemini-1.5-flash has been retired; override via env if needed.
_GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

_LANGUAGE_NAMES = {
    "en": "English",
    "hi": "Hindi",
    "kn": "Kannada",
}

_SYSTEM_PROMPT = """You are an ultra-fast live simultaneous voice interpreter translating between English, Hindi, and Kannada.
Rules:
1. Translate accurately from {src_lang} to {tgt_lang}.
2. Detect the speaker's true intent, context, and conversation topic.
3. Automatically heal colloquial slangs (Hinglish/Kanglish), broken grammar, and ambiguous homophones (e.g. 'bail' in farming/field context means ox/bull, not vine/court bail).
4. If translating to Kannada, provide natural spoken Kannada.
5. Output ONLY the translated text without extra explanation, notes, quotes, or markdown."""


def translate_with_gemini(
    text: str,
    *,
    src_lang: str,
    tgt_lang: str,
    api_key: Optional[str] = None,
    timeout: float = 3.5,
) -> Optional[str]:
    """Translate text using Gemini Flash for high-accuracy intent & slang understanding."""
    key = (api_key or os.environ.get("GEMINI_API_KEY", "")).strip()
    if not key:
        return None

    text = (text or "").strip()
    if not text:
        return ""
    if src_lang == tgt_lang:
        return text

    src_name = _LANGUAGE_NAMES.get(src_lang, src_lang)
    tgt_name = _LANGUAGE_NAMES.get(tgt_lang, tgt_lang)
    system_instruction = _SYSTEM_PROMPT.format(src_lang=src_name, tgt_lang=tgt_name)

    prompt = f"Translate the following spoken message from {src_name} to {tgt_name}:\n\"{text}\""

    # 1. Try via Gemini Flash REST API (ultra-fast, ~250ms)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{_GEMINI_MODEL}:generateContent"
    payload = {
        "systemInstruction": {
            "parts": [{"text": system_instruction}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}]
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 400,
            # Disable "thinking" so short live translations stay fast.
            "thinkingConfig": {"thinkingBudget": 0},
            "topP": 0.95,
        }
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            candidates = data.get("candidates", [])
            if candidates and "content" in candidates[0]:
                parts = candidates[0]["content"].get("parts", [])
                if parts and "text" in parts[0]:
                    result = parts[0]["text"].strip()
                    result = result.strip('"\'“”‘’`').strip()
                    if result:
                        logger.info("gemini_translation_success src=%s tgt=%s out=%s", src_lang, tgt_lang, result)
                        return result
    except Exception as e:
        logger.warning("gemini_translation_failed err=%s, falling back to neural", e)

    # 2. Try SDK fallback if REST failed
    try:
        import google.generativeai as genai

        genai.configure(api_key=key)
        model = genai.GenerativeModel(
            model_name=_GEMINI_MODEL,
            system_instruction=system_instruction,
            generation_config={"temperature": 0.1, "max_output_tokens": 150},
        )
        resp = model.generate_content(prompt)
        if resp and resp.text:
            result = resp.text.strip().strip('"\'“”‘’`').strip()
            if result:
                return result
    except Exception as e:
        logger.warning("gemini_sdk_fallback_failed err=%s", e)

    return None
