import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from app.core.config import (
    SOURCE_LANGUAGE,
    TARGET_LANGUAGE,
    TTS_LANGUAGE,
    WHISPER_MODEL,
    LOG_PREFIX_HINDI_FINAL,
    LOG_PREFIX_ENGLISH_TRANSLATION,
    LOG_PREFIX_ENGLISH_TTS,
)
from app.modules.asr.whisper_asr import Transcript, transcribe_16k_mono_f32
from app.modules.audio.preprocess import Wav16kMono, ensure_16k_mono
from app.modules.translation.marianmt import translate as marian_translate
from app.modules.tts.tts import TtsAudio, synthesize

logger = logging.getLogger("talkbridge.pipeline")


@dataclass(frozen=True)
class PipelineResult:
    transcription: str
    translation: str
    tts: TtsAudio


async def audio_wav_to_translation_and_tts(
    wav_bytes: bytes,
    *,
    source_lang: Optional[str] = SOURCE_LANGUAGE,
    target_lang: str = TARGET_LANGUAGE,
    whisper_model: str = WHISPER_MODEL,
    tts_lang: str = TTS_LANGUAGE,
) -> PipelineResult:
    """End-to-end pipeline for Hindi to English translation."""

    logger.info("audio_received bytes=%s", len(wav_bytes))

    # Convert to 16kHz mono
    wav16: Wav16kMono = await asyncio.to_thread(ensure_16k_mono, wav_bytes)

    # Transcribe Hindi speech
    transcript: Transcript = await asyncio.to_thread(
        transcribe_16k_mono_f32,
        wav16.pcm_f32,
        model_name=whisper_model,
        language=source_lang,  # Force Hindi
    )
    logger.info(f"{LOG_PREFIX_HINDI_FINAL} chars=%s", len(transcript.text))

    # Translate Hindi to English
    try:
        translated = await asyncio.to_thread(
            marian_translate,
            transcript.text,
            src_lang=source_lang or ("en" if target_lang == "hi" else "hi"),
            tgt_lang=target_lang,  # English
        )
        logger.info(f"{LOG_PREFIX_ENGLISH_TRANSLATION} chars=%s", len(translated))
    except Exception as e:
        logger.error(f"Translation failed: {e}")
        translated = transcript.text  # Fallback to original text if translation fails

    # Generate English speech
    try:
        tts_audio = await asyncio.to_thread(synthesize, translated, lang=tts_lang)
        logger.info(f"{LOG_PREFIX_ENGLISH_TTS} bytes=%s mime=%s", len(tts_audio.data), tts_audio.mime)
    except Exception as e:
        logger.error(f"TTS generation failed: {e}")
        # Return empty audio on failure
        tts_audio = TtsAudio(data=b"", mime="audio/wav")

    return PipelineResult(transcription=transcript.text, translation=translated, tts=tts_audio)

