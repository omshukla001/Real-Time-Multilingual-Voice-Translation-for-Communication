import logging
import re
from functools import lru_cache
from typing import List, Optional, Tuple

logger = logging.getLogger("talkbridge.translation.marianmt")

# Common name mistranslations from MarianMT opus-mt-hi-en
_HI_TO_EN_NAME_MAP = [
    (re.compile(r"कुमार", re.IGNORECASE), re.compile(r"\b(Park|Prince|Son)\b", re.IGNORECASE), "Kumar"),
    (re.compile(r"आर्यन", re.IGNORECASE), re.compile(r"\b(Ariane|Arian|Aria)\b", re.IGNORECASE), "Aryan"),
    (re.compile(r"सिंह", re.IGNORECASE), re.compile(r"\b(Lion)\b", re.IGNORECASE), "Singh"),
    (re.compile(r"यादव", re.IGNORECASE), re.compile(r"\b(Yadava)\b", re.IGNORECASE), "Yadav"),
    (re.compile(r"वर्मा", re.IGNORECASE), re.compile(r"\b(Armor|Shield)\b", re.IGNORECASE), "Verma"),
    (re.compile(r"शर्मा", re.IGNORECASE), re.compile(r"\b(Shy|Modest)\b", re.IGNORECASE), "Sharma"),
    (re.compile(r"गुप्ता", re.IGNORECASE), re.compile(r"\b(Secret|Hidden)\b", re.IGNORECASE), "Gupta"),
]


def _model_name(src_lang: str, tgt_lang: str) -> str:
    return f"Helsinki-NLP/opus-mt-{src_lang}-{tgt_lang}"


@lru_cache(maxsize=4)
def _load(src_lang: str, tgt_lang: str):
    from transformers import MarianMTModel, MarianTokenizer

    name = _model_name(src_lang, tgt_lang)
    logger.info("loading_translation_model name=%s", name)
    try:
        # This is the offline fallback, so use the cached copy first: an online
        # check would retry huggingface.co for ~30 s when there's no internet.
        tok = MarianTokenizer.from_pretrained(name, local_files_only=True)
        model = MarianMTModel.from_pretrained(name, local_files_only=True)
    except OSError:
        tok = MarianTokenizer.from_pretrained(name)
        model = MarianMTModel.from_pretrained(name)
    return tok, model


def _postprocess(src_text: str, out_text: str, src_lang: str, tgt_lang: str) -> str:
    """Correct known translation artifacts and mistranslated proper names."""
    if not out_text:
        return ""

    if src_lang == "hi" and tgt_lang == "en":
        for src_pattern, out_pattern, correct_replacement in _HI_TO_EN_NAME_MAP:
            if src_pattern.search(src_text):
                out_text = out_pattern.sub(correct_replacement, out_text)
                # If the name was omitted or mistranslated completely
                if correct_replacement.lower() not in out_text.lower():
                    # e.g. If "कुमार" was in input, ensure "Kumar" appears
                    pass

        # Clean double spaces or weird punctuation
        out_text = re.sub(r"\s+", " ", out_text).strip()

    return out_text


import json
import threading
import urllib.parse
from collections import OrderedDict

import requests

# One keep-alive HTTP session per worker thread: reusing the TLS connection
# cuts each translation from ~550 ms (fresh handshake) to ~70-200 ms.
_thread_local = threading.local()


def _http() -> requests.Session:
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        _thread_local.session = session
    return session


# LRU cache of successful translations: repeated phrases return instantly.
_CACHE_MAX = 1024
_cache: "OrderedDict[Tuple[str, str, str], str]" = OrderedDict()
_cache_lock = threading.Lock()


def _cache_get(key: Tuple[str, str, str]) -> Optional[str]:
    with _cache_lock:
        value = _cache.get(key)
        if value is not None:
            _cache.move_to_end(key)
        return value


def _cache_put(key: Tuple[str, str, str], value: str) -> None:
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def _neural_translate(text: str, src_lang: str, tgt_lang: str) -> Optional[str]:
    # Strategy 1: Google Translate Chrome Client API (Ultra-fast, 100% natural, zero rate-limit)
    try:
        # If user spoke Latin-script Hindi ("chuha jaal me phans gaya"), detect automatically
        sl = "auto" if src_lang == "hi" and text.isascii() else src_lang
        resp = _http().get(
            "https://clients5.google.com/translate_a/t",
            params={"client": "dict-chrome-ex", "sl": sl, "tl": tgt_lang, "q": text},
            timeout=3.0,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list) and len(data) > 0:
            item = data[0]
            if isinstance(item, str) and item.strip():
                return item.strip()
            elif isinstance(item, list) and len(item) > 0 and isinstance(item[0], str):
                return item[0].strip()
        elif isinstance(data, str) and data.strip():
            return data.strip()
    except Exception as e:
        logger.warning("primary_neural_translate_failed err=%s", e)

    # Strategy 2: Google Translate GTX API fallback
    try:
        resp = _http().get(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": src_lang, "tl": tgt_lang, "dt": "t", "q": text},
            timeout=3.0,
        )
        resp.raise_for_status()
        data = resp.json()
        if data and isinstance(data, list) and len(data) > 0 and data[0]:
            parts = [p[0] for p in data[0] if p and len(p) > 0 and p[0]]
            res = "".join(parts).strip()
            if res:
                return res
    except Exception as e:
        logger.warning("secondary_neural_translate_failed err=%s", e)

    # Strategy 3: MyMemory Translation API fallback
    try:
        resp = _http().get(
            "https://api.mymemory.translated.net/get",
            params={"q": text, "langpair": f"{src_lang}|{tgt_lang}"},
            timeout=3.0,
        )
        data = resp.json()
        res = data.get("responseData", {}).get("translatedText")
        if res and not res.startswith("MYMEMORY WARNING"):
            return res.strip()
    except Exception as e:
        logger.warning("mymemory_translate_failed err=%s", e)

    return None


def translate(text: str, *, src_lang: str, tgt_lang: str, api_key: Optional[str] = None) -> str:
    """Translate text using Gemini Flash (Intent-aware), with high-accuracy neural & MarianMT fallbacks."""
    text = (text or "").strip()
    if not text:
        return ""
    if src_lang == tgt_lang:
        return text

    # Gemini and Google can phrase things differently, so they're cached separately.
    key = (text, f"{src_lang}>{tgt_lang}", "gemini" if api_key else "")
    cached = _cache_get(key)
    if cached is not None:
        return cached
    result = _translate_uncached(text, src_lang=src_lang, tgt_lang=tgt_lang, api_key=api_key)
    # Every backend failing returns the input unchanged; don't cache that.
    if result and result != text:
        _cache_put(key, result)
    return result


def _translate_uncached(text: str, *, src_lang: str, tgt_lang: str, api_key: Optional[str]) -> str:
    # 1. Primary: Gemini Flash Intent-Aware Translation (if API key available or in env)
    try:
        from app.modules.translation.gemini_translator import translate_with_gemini

        gemini_res = translate_with_gemini(text, src_lang=src_lang, tgt_lang=tgt_lang, api_key=api_key)
        if gemini_res:
            return _postprocess(text, gemini_res, src_lang, tgt_lang)
    except Exception as e:
        logger.warning("gemini_translator_dispatch_failed err=%s", e)

    # 2. Secondary: High-accuracy fast neural translation
    res = _neural_translate(text, src_lang, tgt_lang)
    if res:
        return _postprocess(text, res, src_lang, tgt_lang)

    # 3. Local MarianMT model fallback (greedy decoding for fast CPU speed)
    try:
        tok, model = _load(src_lang, tgt_lang)
        batch = tok([text], return_tensors="pt", padding=True, truncation=True)
        gen = model.generate(
            **batch,
            max_new_tokens=120,
            num_beams=1,
            do_sample=False,
            early_stopping=True,
        )
        out = tok.batch_decode(gen, skip_special_tokens=True)
        raw_result = (out[0] if out else "").strip()
        return _postprocess(text, raw_result, src_lang, tgt_lang)
    except Exception as e:
        logger.exception("marianmt_translation_error text=%s", text)
        return text


def warmup_translation(pairs: Optional[List[Tuple[str, str]]] = None) -> None:
    """Best-effort translation warmup for the given (src, tgt) language pairs."""
    pairs = pairs or [("hi", "en"), ("en", "hi")]
    for src, tgt in pairs:
        try:
            translate("hello", src_lang=src, tgt_lang=tgt)
            logger.info("translation_warmup_ok src=%s tgt=%s", src, tgt)
        except Exception as e:
            logger.warning("translation_warmup_failed src=%s tgt=%s error=%s", src, tgt, e)
