import io
import logging
from dataclasses import dataclass

import numpy as np
import resampy
import soundfile as sf

logger = logging.getLogger("talkbridge.audio.preprocess")


@dataclass(frozen=True)
class Wav16kMono:
    pcm_f32: np.ndarray  # shape: (n,)
    sample_rate: int = 16000


def decode_wav_bytes(wav_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode WAV bytes to float32 mono array (may be multi-channel)."""
    with sf.SoundFile(io.BytesIO(wav_bytes)) as f:
        sr = int(f.samplerate)
        audio = f.read(dtype="float32", always_2d=True)  # (n, ch)
    return audio, sr


def to_mono(audio_2d: np.ndarray) -> np.ndarray:
    if audio_2d.ndim != 2:
        raise ValueError("Expected (n, ch) array")
    if audio_2d.shape[1] == 1:
        return audio_2d[:, 0]
    return np.mean(audio_2d, axis=1)


def ensure_16k_mono(wav_bytes: bytes) -> Wav16kMono:
    """Convert WAV bytes to mono 16kHz float32 PCM."""
    audio_2d, sr = decode_wav_bytes(wav_bytes)
    mono = to_mono(audio_2d)
    if sr != 16000:
        logger.info("resampling %s -> 16000", sr)
        mono = resampy.resample(mono, sr, 16000)
    mono = np.clip(mono, -1.0, 1.0).astype("float32")
    return Wav16kMono(pcm_f32=mono, sample_rate=16000)


def float32_to_pcm16_bytes(x: np.ndarray) -> bytes:
    x = np.clip(x, -1.0, 1.0)
    pcm16 = (x * 32767.0).astype(np.int16)
    return pcm16.tobytes()


def pcm16le_bytes_to_float32(pcm16le: bytes) -> np.ndarray:
    """Convert PCM16 little-endian bytes to float32 in [-1, 1]."""
    if len(pcm16le) % 2 != 0:
        pcm16le = pcm16le[:-1]
    x = np.frombuffer(pcm16le, dtype=np.int16).astype(np.float32)
    return (x / 32767.0).clip(-1.0, 1.0)

