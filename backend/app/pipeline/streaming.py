import asyncio
import base64
import json
import logging
import os
import time
from dataclasses import dataclass, field
from collections import OrderedDict
from typing import Awaitable, Callable, Dict, List, Optional, Tuple

from app.modules.audio.preprocess import pcm16le_bytes_to_float32
from app.modules.audio.vad import VAD
from app.modules.asr.whisper_asr import transcribe_16k_mono_f32
from app.modules.translation.marianmt import translate as marian_translate
from app.modules.tts.tts import synthesize

logger = logging.getLogger("talkbridge.pipeline.streaming")


# Demo/production tuning
DEMO_MODE = os.getenv("TALKBRIDGE_DEMO_MODE", "0") == "1"

FRAME_MS = 30
SAMPLE_RATE = 16000
SAMPLES_PER_FRAME = int(SAMPLE_RATE * (FRAME_MS / 1000.0))  # 480
BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2  # PCM16 => 960 bytes

# Keep heavy tasks serialized by default for Windows stability.
# Users can opt in to higher concurrency via env after validating their host.
MAX_CONCURRENT_HEAVY_TASKS = int(os.getenv("TALKBRIDGE_MAX_CONCURRENT_HEAVY_TASKS", "1"))
HEAVY_TASK_TIMEOUT_S = float(os.getenv("TALKBRIDGE_HEAVY_TASK_TIMEOUT_S", "8"))
_heavy_semaphore = asyncio.Semaphore(MAX_CONCURRENT_HEAVY_TASKS)

FINALIZE_SILENCE_MS = int(os.getenv("TALKBRIDGE_FINALIZE_SILENCE_MS", "700"))
MAX_SEGMENT_MS = int(os.getenv("TALKBRIDGE_MAX_SEGMENT_MS", "8000"))
# Segments allowed to wait for ASR per session. Queuing (rather than dropping)
# means speech is never silently lost; beyond this the caller is too far ahead.
MAX_PENDING_SEGMENTS = int(os.getenv("TALKBRIDGE_MAX_PENDING_SEGMENTS", "3"))

# Bounded LRU cache to avoid re-translating identical phrases. Keyed by the
# language pair too, so switching target language mid-call can't return a
# translation in the old language.
_TRANSLATION_CACHE_MAX = 512
_translation_cache: "OrderedDict[Tuple[str, str, str], str]" = OrderedDict()


@dataclass
class StreamSession:
    session_id: str
    vad: VAD = field(default_factory=lambda: VAD(aggressiveness=1 if DEMO_MODE else 2))
    remainder: bytearray = field(default_factory=bytearray)
    speech_buf: bytearray = field(default_factory=bytearray)
    silence_ms: int = 0
    last_activity_ts: float = field(default_factory=time.time)
    context: list[str] = field(default_factory=list)  # simple memory (last N stable texts)
    pending_segments: int = 0  # backpressure indicator
    last_final_transcript: str = ""
    last_translation: str = ""
    last_emit_ts: float = 0.0
    tts_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class StreamSessionStore:
    def __init__(self) -> None:
        self._sessions: Dict[str, StreamSession] = {}
        self._lock = asyncio.Lock()

    async def get(self, session_id: str) -> StreamSession:
        async with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                s = StreamSession(session_id=session_id)
                self._sessions[session_id] = s
            return s

    async def delete(self, session_id: str) -> None:
        async with self._lock:
            self._sessions.pop(session_id, None)

    async def count(self) -> int:
        async with self._lock:
            return len(self._sessions)

    async def stats(self) -> dict:
        async with self._lock:
            return {
                "active_sessions": len(self._sessions),
                "demo_mode": DEMO_MODE,
                "max_concurrent_heavy_tasks": MAX_CONCURRENT_HEAVY_TASKS,
            }


store = StreamSessionStore()


def _split_frames(session: StreamSession, chunk: bytes) -> list[bytes]:
    session.remainder.extend(chunk)
    frames: list[bytes] = []
    while len(session.remainder) >= BYTES_PER_FRAME:
        frame = bytes(session.remainder[:BYTES_PER_FRAME])
        del session.remainder[:BYTES_PER_FRAME]
        frames.append(frame)
    return frames


def _feed_frames_and_maybe_finalize(session: StreamSession, frames: list[bytes]) -> Optional[bytes]:
    """Return finalized speech segment PCM16 bytes when we detect a silence gap."""
    finalized: Optional[bytes] = None
    for frame in frames:
        is_speech = session.vad.is_speech(frame, SAMPLE_RATE)
        if is_speech:
            session.speech_buf.extend(frame)
            session.silence_ms = 0
            session.last_activity_ts = time.time()
        else:
            # Only count silence once we've started collecting speech.
            if session.speech_buf:
                session.silence_ms += FRAME_MS
                # Finalize after a natural pause. Hindi/Kannada are verb-final,
                # so cutting on short mid-sentence pauses strands the verb in the
                # next segment and wrecks translation. If the speaker runs on
                # without any pause, force-finalize so the listener isn't left hanging.
                speech_ms = (len(session.speech_buf) / 2) / SAMPLE_RATE * 1000
                if session.silence_ms >= FINALIZE_SILENCE_MS or speech_ms >= MAX_SEGMENT_MS:
                    finalized = bytes(session.speech_buf)
                    session.speech_buf.clear()
                    session.silence_ms = 0
                    break
    return finalized


def _pcm16_segment_to_events(
    pcm16: bytes,
    *,
    source_lang: Optional[str],
    target_lang: str,
    whisper_model: str,
    tts_lang: str,
) -> list[dict]:
    """Synchronous heavy work; run in a worker thread.

    Emits:
      - partial_transcript
      - final_transcript
      - translation_complete

    TTS runs separately (see _tts_event) so subtitles aren't held back ~1 s
    waiting for synthesized audio.
    """
    try:
        audio_f32 = pcm16le_bytes_to_float32(pcm16)
        # Filter out silent or very quiet frames / background noise
        rms = float((audio_f32 ** 2).mean() ** 0.5) if len(audio_f32) > 0 else 0.0
        if rms < 0.018 or len(pcm16) < (SAMPLE_RATE * 0.4 * 2):
            return [{"event": "segment_skipped_too_short"}]

        transcript = transcribe_16k_mono_f32(audio_f32, model_name=whisper_model, language=source_lang).text
    except Exception as e:
        # If ASR fails, skip this segment but keep the stream alive.
        logger.exception("asr_failed segment_bytes=%s error=%s", len(pcm16), e)
        return [{"event": "asr_failed", "error": f"{type(e).__name__}: {e}"}]

    transcript = (transcript or "").strip()
    # Empty or single punctuation after ASR hallucination filter
    if not transcript or len(transcript) < 2 or transcript in {".", ",", "!", "?", "..."}:
        return [{"event": "segment_skipped_hallucination"}]

    src = source_lang or ("en" if target_lang == "hi" else "hi")

    if src == target_lang:
        translation = transcript
    else:
        cache_key = (src, target_lang, transcript)

        def _safe_translate() -> str:
            cached = _translation_cache.get(cache_key)
            if cached is not None:
                _translation_cache.move_to_end(cache_key)
                return cached

            last_exc: Optional[Exception] = None
            for attempt in range(2):
                try:
                    translated = marian_translate(transcript, src_lang=src, tgt_lang=target_lang)
                    # translate() returns the input unchanged when every backend fails.
                    if translated and translated != transcript:
                        _translation_cache[cache_key] = translated
                        while len(_translation_cache) > _TRANSLATION_CACHE_MAX:
                            _translation_cache.popitem(last=False)
                        return translated
                except Exception as exc:
                    last_exc = exc
                    logger.exception(
                        "translation_failed attempt=%s src=%s tgt=%s", attempt + 1, src, target_lang
                    )
            logger.warning(
                "translation_gave_up src=%s tgt=%s using_fallback_original_text error=%s",
                src,
                target_lang,
                last_exc,
            )
            # Don't cache the fallback: a transient network error shouldn't
            # leave this phrase untranslated for the rest of the session.
            return transcript

        translation = _safe_translate()

    return [
        {"event": "partial_transcript", "text": transcript},
        {"event": "final_transcript", "text": transcript},
        {"event": "translation_complete", "text": translation},
    ]


def _tts_event(original: str, translation: str, tts_lang: str) -> dict:
    tts = synthesize(translation, lang=tts_lang)
    return {
        "event": "tts_audio_ready",
        # Carry the text so clients can pair audio with the right subtitle even
        # if a later segment's transcript arrives first.
        "original": original,
        "text": translation,
        "mime": tts.mime,
        "audio_b64": base64.b64encode(tts.data).decode("ascii"),
    }


async def _run_heavy_for_segment(
    session: StreamSession,
    pcm16: bytes,
    *,
    source_lang: Optional[str],
    target_lang: str,
    whisper_model: str,
    tts_lang: str,
    heavy_event_consumer: Optional[Callable[[List[dict]], Awaitable[None]]] = None,
) -> None:
    """Background task wrapper for ASR + translation + TTS with timeout & concurrency limiting."""
    try:
        async with _heavy_semaphore:
            try:
                heavy_events = await asyncio.wait_for(
                    asyncio.to_thread(
                        _pcm16_segment_to_events,
                        pcm16,
                        source_lang=source_lang,
                        target_lang=target_lang,
                        whisper_model=whisper_model,
                        tts_lang=tts_lang,
                    ),
                    timeout=HEAVY_TASK_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                logger.warning("heavy_task_timeout session=%s", session.session_id)
                heavy_events = [{"event": "segment_timeout"}]

        # Drop near-identical repeated emissions that often come from adjacent
        # overlapping VAD segments and create duplicate transcript bubbles.
        now = time.time()
        final_text = next((ev.get("text", "") for ev in heavy_events if ev.get("event") == "final_transcript"), "")
        translation_text = next(
            (ev.get("text", "") for ev in heavy_events if ev.get("event") == "translation_complete"), ""
        )
        if final_text and (
            (final_text == session.last_final_transcript and now - session.last_emit_ts < 8.0)
            or (translation_text and translation_text == session.last_translation and now - session.last_emit_ts < 8.0)
        ):
            heavy_events = [{"event": "segment_skipped_duplicate"}]
        elif final_text:
            session.last_final_transcript = final_text
            session.last_translation = translation_text or session.last_translation
            session.last_emit_ts = now

        # Simple context memory: store stabilized final transcripts.
        for ev in heavy_events:
            if ev.get("event") == "final_transcript" and ev.get("text"):
                session.context.append(ev["text"])
                session.context = session.context[-8:]
                ev["context"] = session.context

        if heavy_event_consumer and heavy_events:
            await heavy_event_consumer(heavy_events)

        # TTS is network-bound, so it runs outside the ASR semaphore; the
        # per-session lock (FIFO) keeps audio in the order it was spoken.
        if final_text and translation_text and tts_lang and heavy_events[0].get("event") != "segment_skipped_duplicate":
            async with session.tts_lock:
                try:
                    tts_ev = await asyncio.wait_for(
                        asyncio.to_thread(_tts_event, final_text, translation_text, tts_lang),
                        timeout=HEAVY_TASK_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    logger.warning("tts_timeout session=%s", session.session_id)
                    tts_ev = {"event": "tts_audio_ready", "original": final_text, "text": translation_text,
                              "mime": "audio/mpeg", "audio_b64": ""}
            if heavy_event_consumer:
                await heavy_event_consumer([tts_ev])
    except Exception:
        logger.exception("heavy_task_failed session=%s", session.session_id)
    finally:
        # Release backpressure counter
        session.pending_segments = max(0, session.pending_segments - 1)


async def handle_stream_message(
    session: StreamSession,
    msg: dict,
    *,
    source_lang: Optional[str],
    target_lang: str,
    whisper_model: str,
    tts_lang: str,
    heavy_event_consumer: Optional[Callable[[List[dict]], Awaitable[None]]] = None,
) -> list[dict]:
    """Process one incoming chunk message and return fast, non-blocking events.

    Heavy work (Whisper/translation/TTS) is scheduled in background tasks.
    """
    if msg.get("reset"):
        # Client paused capture (mute / translated audio playing): drop the
        # partial utterance instead of later transcribing a cut-off fragment.
        session.speech_buf.clear()
        session.remainder.clear()
        session.silence_ms = 0
        return [{"event": "stream_reset"}]

    pcm_b64 = msg.get("pcm16_b64") or ""
    chunk = base64.b64decode(pcm_b64) if pcm_b64 else b""

    events: list[dict] = []
    events.append({"event": "audio_chunk_received", "bytes": len(chunk)})
    logger.debug("audio_chunk_received session=%s bytes=%s", session.session_id, len(chunk))

    frames = _split_frames(session, chunk)
    finalized = _feed_frames_and_maybe_finalize(session, frames)
    if not finalized:
        return events

    duration_ms = int((len(finalized) / 2) / SAMPLE_RATE * 1000)
    events.append({"event": "segment_finalized", "bytes": len(finalized), "duration_ms": duration_ms})

    logger.info("segment_finalized session=%s segment_ms=%s", session.session_id, duration_ms)

    # Skip obvious noise blips (<180 ms) — Whisper on ultra-short clips usually returns
    # hallucinated phrases like "thank you" that poison the transcript.
    if duration_ms < 180:
        events.append({"event": "segment_skipped_too_short", "duration_ms": duration_ms})
        return events

    # Backpressure: queue a few segments (the semaphore keeps them in order),
    # but drop once the backlog would make output lag far behind the speaker.
    if session.pending_segments >= MAX_PENDING_SEGMENTS:
        logger.warning("backpressure_drop_segment session=%s pending=%s", session.session_id, session.pending_segments)
        events.append({"event": "segment_dropped_backpressure"})
        return events

    session.pending_segments += 1
    asyncio.create_task(
        _run_heavy_for_segment(
            session,
            finalized,
            source_lang=source_lang,
            target_lang=target_lang,
            whisper_model=whisper_model,
            tts_lang=tts_lang,
            heavy_event_consumer=heavy_event_consumer,
        )
    )

    return events


def encode_events(events: list[dict]) -> list[str]:
    return [json.dumps(e, ensure_ascii=False) for e in events]


async def simulate_audio_stream(
    wav_path: str,
    *,
    source_lang: Optional[str] = None,
    target_lang: str = "es",
    whisper_model: str = "tiny",
    tts_lang: str = "es",
) -> list[dict]:
    """Local testing helper: feed a WAV file through the streaming pipeline."""
    from pathlib import Path

    from app.core.logging import configure_logging
    from app.modules.audio.preprocess import ensure_16k_mono, float32_to_pcm16_bytes

    configure_logging()

    raw = Path(wav_path).read_bytes()
    wav16 = ensure_16k_mono(raw)
    pcm16 = float32_to_pcm16_bytes(wav16.pcm_f32)

    session = StreamSession(session_id=f"simulate-{int(time.time())}")
    idx = 0
    all_events: list[dict] = []

    # Send chunks of ~1–2 seconds into the same handle_stream_message function
    # used by the WebSocket endpoint.
    max_chunk_bytes = int(SAMPLE_RATE * 2 * 2)  # 2 seconds * 2 bytes/sample

    while idx < len(pcm16):
        chunk = pcm16[idx : idx + max_chunk_bytes]
        idx += len(chunk)
        msg = {
            "pcm16_b64": base64.b64encode(chunk).decode("ascii"),
            "source_lang": source_lang,
            "target_lang": target_lang,
            "whisper_model": whisper_model,
            "tts_lang": tts_lang,
        }
        events = await handle_stream_message(
            session,
            msg,
            source_lang=source_lang,
            target_lang=target_lang,
            whisper_model=whisper_model,
            tts_lang=tts_lang,
        )
        all_events.extend(events)
        for ev in events:
            logger.info("simulate_event %s", ev)

    return all_events

