import logging

import webrtcvad

logger = logging.getLogger("talkbridge.audio.vad")


class VAD:
    """WebRTC VAD for 16kHz mono PCM16 frames.

    Notes:
    - input must be PCM16 little-endian bytes
    - frame size must be 10/20/30 ms (at 16kHz => 160/320/480 samples => 320/640/960 bytes)
    """

    def __init__(self, aggressiveness: int = 2) -> None:
        self._vad = webrtcvad.Vad(aggressiveness)

    def is_speech(self, frame_pcm16: bytes, sample_rate: int = 16000) -> bool:
        return self._vad.is_speech(frame_pcm16, sample_rate)

