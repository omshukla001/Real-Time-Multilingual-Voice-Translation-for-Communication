import asyncio
import concurrent.futures
import io
import logging
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock
from typing import Literal, Optional, Tuple

logger = logging.getLogger("talkbridge.tts")

AudioMime = Literal["audio/mpeg", "audio/wav"]


@dataclass(frozen=True)
class TtsAudio:
    mime: AudioMime
    data: bytes


_TTS_CACHE_MAX = 128
_tts_cache: "OrderedDict[Tuple[str, str, str], TtsAudio]" = OrderedDict()
_tts_cache_lock = Lock()


def _cache_get(key: Tuple[str, str, str]) -> Optional[TtsAudio]:
    with _tts_cache_lock:
        audio = _tts_cache.get(key)
        if audio is not None:
            _tts_cache.move_to_end(key)
        return audio


def _cache_put(key: Tuple[str, str, str], audio: TtsAudio) -> None:
    with _tts_cache_lock:
        _tts_cache[key] = audio
        _tts_cache.move_to_end(key)
        while len(_tts_cache) > _TTS_CACHE_MAX:
            _tts_cache.popitem(last=False)


def _synthesize_edge_tts(text: str, lang: str = "en") -> Optional[TtsAudio]:
    """Synthesize ultra-natural studio-quality neural voice using Edge-TTS."""
    import edge_tts

    voice_map = {
        "kn": "kn-IN-SapnaNeural",    # Peaceful, crystal-clear female Kannada voice
        "hi": "hi-IN-SwaraNeural",    # Gentle, peaceful female Hindi voice
        "en": "en-IN-NeerjaNeural",   # Soft, natural female English voice
    }
    voice = voice_map.get(lang, "en-IN-NeerjaNeural")

    async def _run():
        communicate = edge_tts.Communicate(text, voice, rate="-4%")
        audio_data = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]
        return audio_data

    try:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                res = pool.submit(lambda: asyncio.run(_run())).result(timeout=4.5)
        else:
            res = asyncio.run(_run())

        if res and len(res) > 200:
            return TtsAudio(mime="audio/mpeg", data=res)
    except Exception as e:
        logger.warning("edge_tts_failed err=%s", e)

    return None


def _synthesize_gtts(text: str, lang: str = "en") -> Optional[TtsAudio]:
    try:
        from gtts import gTTS

        mp3 = io.BytesIO()
        tld = "co.in" if lang == "en" else "com"
        gTTS(text=text, lang=lang, tld=tld).write_to_fp(mp3)
        data = mp3.getvalue()
        if data:
            return TtsAudio(mime="audio/mpeg", data=data)
    except Exception as e:
        logger.warning("gtts_failed err=%s", e)
    return None


def _synthesize_http_google(text: str, lang: str = "en") -> TtsAudio:
    import urllib.parse
    import urllib.request

    try:
        encoded = urllib.parse.quote(text[:200])
        url = f"https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl={lang}&q={encoded}"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
        )
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            data = resp.read()
            if data and len(data) > 100:
                return TtsAudio(mime="audio/mpeg", data=data)
    except Exception as e:
        logger.warning("http_google_tts_failed error=%s", e)

    return TtsAudio(mime="audio/wav", data=b"")


def synthesize(text: str, *, lang: str = "en", prefer: str = "edge") -> TtsAudio:
    """Generate pleasant, natural voice audio for text with multi-tier fallback."""
    text = (text or "").strip()
    if not text:
        return TtsAudio(mime="audio/wav", data=b"")

    cacheable = len(text) <= 200
    key = (text, lang, prefer)
    if cacheable:
        cached = _cache_get(key)
        if cached is not None:
            return cached

    # 1. Edge-TTS Natural Neural Studio Voice
    audio = _synthesize_edge_tts(text, lang=lang)

    # 2. gTTS Fallback
    if not audio or not audio.data:
        audio = _synthesize_gtts(text, lang=lang)

    # 3. HTTP Google TTS Fallback
    if not audio or not audio.data:
        audio = _synthesize_http_google(text, lang=lang)

    if cacheable and audio and audio.data:
        _cache_put(key, audio)

    return audio or TtsAudio(mime="audio/wav", data=b"")


def warmup_tts(lang: str = "en") -> None:
    try:
        _ = synthesize("warmup", lang=lang)
        logger.info("tts_warmup_completed")
    except Exception as e:
        logger.warning("tts_warmup_failed error=%s", e)
