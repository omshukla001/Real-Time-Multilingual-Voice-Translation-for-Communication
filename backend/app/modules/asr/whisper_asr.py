import logging
import math
import os
import platform
import sys
from threading import Lock
from dataclasses import dataclass
from functools import lru_cache
from typing import List, Optional

import numpy as np

logger = logging.getLogger("talkbridge.asr.whisper")
_ASR_INFER_LOCK = Lock()

# Hindi/Kannada need a large multilingual model: on a 40-clip Hindi phone-call
# benchmark, `base` scored ~52% CER while large-v3-turbo scored ~6-9%.
# Languages in this set are routed to the high-accuracy engine below.
_HIGH_ACCURACY_LANGS = {"hi", "kn"}

# Apple Silicon: large-v3-turbo on the GPU via MLX (~0.8 s per phone segment on M4).
MLX_MODEL_REPO = os.getenv("TALKBRIDGE_MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
# Other platforms: openai-whisper checkpoint used for the same languages.
HIGH_ACCURACY_WHISPER_MODEL = os.getenv("TALKBRIDGE_HI_WHISPER_MODEL", "turbo")
# The encoder normally runs on a padded 30 s window regardless of clip length;
# trimming it to the clip + this much padding is ~3x faster with a small
# accuracy cost (mostly spelling variants). Set TALKBRIDGE_ASR_FULL_WINDOW=1
# to always use the full window for maximum accuracy.
_MLX_WINDOW_PAD_S = 3.0
_MLX_FULL_WINDOW = os.getenv("TALKBRIDGE_ASR_FULL_WINDOW", "0") == "1"

_INITIAL_PROMPTS = {
    "hi": "यह एक फ़ोन कॉल पर आम बातचीत है।",
    "kn": "ಇದು ಫೋನ್ ಕರೆಯಲ್ಲಿನ ಸಾಮಾನ್ಯ ಸಂಭಾಷಣೆ.",
    "en": "This is a casual phone conversation.",
}


@dataclass(frozen=True)
class Transcript:
    text: str


@lru_cache(maxsize=4)
def _load_model(model_name: str):
    import whisper  # local import (heavy)

    logger.info("loading_whisper_model name=%s", model_name)
    return whisper.load_model(model_name)


@lru_cache(maxsize=1)
def _mlx_available() -> bool:
    if os.getenv("TALKBRIDGE_DISABLE_MLX", "0") == "1":
        return False
    if sys.platform != "darwin" or platform.machine() != "arm64":
        return False
    try:
        import mlx_whisper  # noqa: F401

        return True
    except Exception as e:
        logger.info("mlx_whisper_unavailable error=%s", e)
        return False


def _use_high_accuracy(base_name: str, language: Optional[str]) -> bool:
    # Explicit larger model requests (small/medium/large) are respected.
    return language in _HIGH_ACCURACY_LANGS and base_name in {"tiny", "base"}


def _pick_model(base_name: str, language: Optional[str]) -> str:
    # `tiny.en` / `base.en` are ~1.5x faster than their multilingual peers
    # when we know the source is English.
    if language == "en" and base_name in {"tiny", "base", "small"} and not base_name.endswith(".en"):
        return f"{base_name}.en"
    if _use_high_accuracy(base_name, language):
        return HIGH_ACCURACY_WHISPER_MODEL
    return base_name


# Whisper on near-silent or very short audio tends to emit these canned
# strings regardless of what was said. Filtering them before translation
# stops fake "thank you" / "शुक्रिया" bubbles from polluting the transcript.
_HALLUCINATION_PHRASES = {
    "en": {
        "thanks for watching.", "thanks for watching!", "(music)", "[music]",
        "(silence)", "[silence]", "subscribe.", "see you next time."
    },
    "hi": {
        "देखने के लिए धन्यवाद।", "देखने के लिए धन्यवाद", "सब्सक्राइब करें।", "सब्सक्राइब करें",
        "कृपया सब्सक्राइब करें।", "चैनल को सब्सक्राइब करें।", "(संगीत)", "[संगीत]",
    },
}


def _is_phrase_loop(words: List[str]) -> bool:
    if len(words) < 6:
        return False
    for n in range(1, 5):
        for start in range(len(words) - 3 * n + 1):
            phrase = words[start:start + n]
            reps = 1
            while words[start + reps * n:start + (reps + 1) * n] == phrase:
                reps += 1
            if reps >= 3 and reps * n >= 0.5 * len(words):
                return True
    return False


def _clean_transcript(text: str, language: Optional[str]) -> str:
    """Strip Whisper hallucinations and stuck-token repeats."""
    t = (text or "").strip()
    if not t:
        return ""

    lang = (language or "").lower()
    norm = t.lower().strip().strip('"\'“”‘’')
    if norm in _HALLUCINATION_PHRASES.get(lang, set()):
        return ""
    # On silence Whisper sometimes echoes the initial prompt back verbatim.
    prompt = _INITIAL_PROMPTS.get(lang)
    if prompt:
        # Clipped audio can also yield a fragment of the prompt
        # ("यह एक बातचीत है"): every word drawn from the prompt.
        prompt_words = {w.strip(".,!?।") for w in prompt.lower().split()}
        out_words = [w.strip(".,!?।") for w in norm.split()]
        if out_words and all(w in prompt_words for w in out_words):
            return ""

    words = t.split()
    # "you you you", "the the the" — stuck-token loops.
    if len(words) >= 3 and len({w.lower().strip(".,!?।") for w in words[:4]}) == 1:
        return ""
    # Phrase loops like "अजय को अजय को अजय को ..." — Whisper's classic failure
    # on clipped audio. Reject when one 1-4 word phrase, repeated back-to-back
    # 3+ times, makes up most of the output.
    if _is_phrase_loop([w.lower().strip(".,!?।") for w in words]):
        return ""
    # Single punctuation.
    if len(t) <= 1 and t in {".", ",", "!", "?", "-", "—", "–", "…", "।"}:
        return ""
    # Reject repeated same-character gibberish like "aaaaaa".
    if len(t) >= 8:
        compact = "".join(ch for ch in t if ch.isalpha() or ("ऀ" <= ch <= "ॿ"))
        if compact:
            uniq = len(set(compact))
            if uniq <= 2 and (len(compact) / max(uniq, 1)) >= 4:
                return ""

    return t


@lru_cache(maxsize=1)
def _mlx_model():
    import mlx.core as mx
    from mlx_whisper.transcribe import ModelHolder

    logger.info("loading_mlx_whisper_model repo=%s", MLX_MODEL_REPO)
    path = MLX_MODEL_REPO
    if not os.path.isdir(path):
        from huggingface_hub import snapshot_download

        try:
            # Cached copy first, so startup doesn't stall retrying when offline.
            path = snapshot_download(MLX_MODEL_REPO, local_files_only=True)
        except Exception:
            path = MLX_MODEL_REPO
    return ModelHolder.get_model(path, mx.float16)


@lru_cache(maxsize=8)
def _mlx_prompt_tokens(language: str) -> Optional[tuple]:
    from mlx_whisper.tokenizer import get_tokenizer

    prompt = _INITIAL_PROMPTS.get(language)
    if not prompt:
        return None
    model = _mlx_model()
    tok = get_tokenizer(model.is_multilingual, num_languages=model.num_languages, language=language, task="transcribe")
    return tuple(tok.encode(" " + prompt))


def _transcribe_mlx(audio_f32: np.ndarray, language: str) -> str:
    """large-v3-turbo on the Apple GPU, encoding only the clip (+padding)."""
    import mlx.core as mx
    import mlx.nn as nn
    from mlx_whisper.audio import N_FRAMES, log_mel_spectrogram, pad_or_trim
    from mlx_whisper.decoding import DecodingOptions, DecodingTask

    class _PreEncodedTask(DecodingTask):
        # The stock task re-runs the encoder unless features are exactly 30 s.
        def _get_audio_features(self, mel):
            return mel

    model = _mlx_model()
    frames = N_FRAMES
    if not _MLX_FULL_WINDOW:
        seconds = audio_f32.size / 16000 + _MLX_WINDOW_PAD_S
        frames = min(N_FRAMES, int(math.ceil(seconds / 2.0) * 2 * 100))
    mel = log_mel_spectrogram(mx.array(audio_f32), n_mels=model.dims.n_mels)
    mel = pad_or_trim(mel, frames, axis=-2).astype(mx.float16)[None]

    enc = model.encoder
    x = nn.gelu(enc.conv1(mel))
    x = nn.gelu(enc.conv2(x))
    x = x + enc._positional_embedding[: x.shape[1]]
    for block in enc.blocks:
        x, _, _ = block(x)
    features = enc.ln_post(x)

    prompt = _mlx_prompt_tokens(language)
    result = None
    # Same temperature-fallback rule as Whisper's transcribe(), capped for latency.
    for temperature in (0.0, 0.2, 0.4):
        options = DecodingOptions(
            language=language,
            temperature=temperature,
            without_timestamps=True,
            fp16=True,
            prompt=list(prompt) if prompt else None,
        )
        result = _PreEncodedTask(model, options).run(features)[0]
        if result.compression_ratio <= 2.4 and result.avg_logprob >= -1.0:
            break
    if result.no_speech_prob > 0.6 and result.avg_logprob < -1.0:
        return ""
    return result.text


def transcribe_16k_mono_f32(
    audio_f32: np.ndarray,
    *,
    model_name: str = "tiny",
    language: Optional[str] = None,
) -> Transcript:
    """Transcribe 16kHz mono float32 audio with Whisper.

    This is a synchronous, CPU-heavy call (run in a thread from async code).
    """
    if audio_f32.ndim != 1:
        raise ValueError("audio_f32 must be mono 1D array")
    if audio_f32.size == 0:
        return Transcript(text="")

    # Defensive sanitization: streaming buffers can occasionally carry NaN/Inf
    # or near-silent noise that destabilizes Whisper decoding on CPU.
    audio_f32 = np.nan_to_num(audio_f32.astype(np.float32, copy=False), nan=0.0, posinf=0.0, neginf=0.0)
    rms = float(np.sqrt(np.mean(np.square(audio_f32)))) if audio_f32.size else 0.0
    if rms < 0.003:
        return Transcript(text="")
    # Whisper is more stable with at least ~1 second context.
    if audio_f32.size < 16000:
        audio_f32 = np.pad(audio_f32, (0, 16000 - audio_f32.size), mode="constant")

    if _use_high_accuracy(model_name, language) and _mlx_available():
        try:
            with _ASR_INFER_LOCK:
                text = _transcribe_mlx(audio_f32, language)
            return Transcript(text=_clean_transcript(text, language))
        except Exception:
            logger.exception("mlx_asr_failed falling_back=openai-whisper")

    model = _load_model(_pick_model(model_name, language))
    # Nudge Whisper toward the caller's language when we know it. The prompt
    # is short enough to add no measurable latency.
    initial_prompt = _INITIAL_PROMPTS.get(language or "")

    # Greedy decoding (no beam search) cuts decode time roughly in half with
    # negligible quality impact on short phone-call segments.
    # Whisper/Torch model objects are not reliably thread-safe on Windows CPU.
    # Serializing decode calls avoids native crashes under two-way live calls.
    with _ASR_INFER_LOCK:
        try:
            result = model.transcribe(
                audio_f32,
                fp16=False,
                language=language,
                beam_size=1,
                best_of=1,
                without_timestamps=True,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                logprob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                initial_prompt=initial_prompt,
            )
        except RuntimeError as e:
            # Work around occasional empty-token decode edge cases in Whisper+Torch.
            if "cannot reshape tensor of 0 elements" not in str(e):
                raise
            logger.warning("whisper_retry_after_empty_decode model=%s", model_name)
            padded = np.pad(audio_f32, (0, 16000), mode="constant")
            result = model.transcribe(
                padded,
                fp16=False,
                language=language,
                beam_size=1,
                best_of=1,
                without_timestamps=True,
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                logprob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                initial_prompt=initial_prompt,
            )
    text = _clean_transcript(result.get("text") or "", language)
    return Transcript(text=text)


def warmup_whisper(models: Optional[List[str]] = None) -> None:
    """Preload Whisper weights so the first segment doesn't pay the load cost."""
    models = models or ["tiny", "tiny.en"]
    for m in models:
        try:
            _load_model(m)
            logger.info("whisper_warmup_ok model=%s", m)
        except Exception as e:
            logger.warning("whisper_warmup_failed model=%s error=%s", m, e)


def warmup_high_accuracy_asr() -> None:
    """Load the Hindi/Kannada engine and run one decode to compile GPU kernels."""
    try:
        if _mlx_available():
            tone = 0.1 * np.sin(2 * np.pi * 220 * np.arange(16000, dtype=np.float32) / 16000)
            with _ASR_INFER_LOCK:
                _transcribe_mlx(tone.astype(np.float32), "hi")
            logger.info("asr_warmup_ok engine=mlx model=%s", MLX_MODEL_REPO)
        else:
            _load_model(HIGH_ACCURACY_WHISPER_MODEL)
            logger.info("asr_warmup_ok engine=openai-whisper model=%s", HIGH_ACCURACY_WHISPER_MODEL)
    except Exception as e:
        logger.warning("asr_warmup_failed error=%s", e)
