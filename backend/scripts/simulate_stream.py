import argparse
import asyncio

from app.pipeline.streaming import simulate_audio_stream


async def main() -> None:
    p = argparse.ArgumentParser(description="TalkBridge AI - simulate streaming from a WAV file")
    p.add_argument("wav_path", type=str, help="Path to input WAV file (any sr/ch; will be converted to 16k mono)")
    p.add_argument("--source-lang", type=str, default=None, help="Whisper language code, e.g. en, hi, fr")
    p.add_argument("--target-lang", type=str, default="es", help="MarianMT target language code, e.g. es")
    p.add_argument("--whisper-model", type=str, default="tiny", help="Whisper model name, e.g. tiny/base/small")
    p.add_argument("--tts-lang", type=str, default="es", help="TTS language code")
    args = p.parse_args()

    await simulate_audio_stream(
        args.wav_path,
        source_lang=args.source_lang,
        target_lang=args.target_lang,
        whisper_model=args.whisper_model,
        tts_lang=args.tts_lang,
    )


if __name__ == "__main__":
    asyncio.run(main())

