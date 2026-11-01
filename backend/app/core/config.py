"""Application configuration and constants."""

# Language configuration
SOURCE_LANGUAGE = "hi"  # Hindi
TARGET_LANGUAGE = "en"  # English
TTS_LANGUAGE = "en"     # English for TTS output

# ASR Configuration
WHISPER_MODEL = "base"  # Base model for better accuracy with Hindi

# Translation Configuration
TRANSLATION_SOURCE_LANG = "hi"  # Force Hindi as source for translation
TRANSLATION_TARGET_LANG = "en"  # Force English as target for translation

# Logging prefixes
LOG_PREFIX_HINDI_PARTIAL = "hindi_partial_transcript"
LOG_PREFIX_HINDI_FINAL = "hindi_final_transcript"
LOG_PREFIX_ENGLISH_TRANSLATION = "english_translation_ready"
LOG_PREFIX_ENGLISH_TTS = "english_tts_audio_ready"
