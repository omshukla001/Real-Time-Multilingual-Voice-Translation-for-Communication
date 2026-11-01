import argparse
import base64
import json
from pathlib import Path

from app.core.logging import configure_logging
from app.pipeline.service import audio_wav_to_translation_and_tts


async def main() -> None:
    configure_logging()

    p = argparse.ArgumentParser(description="TalkBridge AI - standalone WAV -> ASR -> translate -> TTS")
    p.add_argument("wav_path", type=str, help="Input WAV path (any sr/ch; will be converted to 16k mono)")
    p.add_argument("--source-lang", type=str, default=None, help="Whisper language code, e.g. en, hi, fr")
    p.add_argument("--target-lang", type=str, default="es", help="MarianMT target language code, e.g. es")
    p.add_argument("--whisper-model", type=str, default="tiny", help="Whisper model name, e.g. tiny/base/small")
    p.add_argument("--tts-lang", type=str, default="es", help="TTS language code")
    p.add_argument("--out-audio", type=str, default="out_tts.audio", help="Output audio file path")
    p.add_argument("--out-json", type=str, default="out_result.json", help="Output json path")
    args = p.parse_args()

    wav_bytes = Path(args.wav_path).read_bytes()
    result = await audio_wav_to_translation_and_tts(
        wav_bytes,
        source_lang=args.source_lang,
        target_lang=args.target_lang,
        whisper_model=args.whisper_model,
        tts_lang=args.tts_lang,
    )

    Path(args.out_audio).write_bytes(result.tts.data)
    Path(args.out_json).write_text(
        json.dumps(
            {
                "transcription": result.transcription,
                "translation": result.translation,
                "tts_mime": result.tts.mime,
                "tts_b64": base64.b64encode(result.tts.data).decode("ascii"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    print("transcription:", result.transcription)
    print("translation:", result.translation)
    print("tts:", args.out_audio, f"({result.tts.mime}, {len(result.tts.data)} bytes)")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())

