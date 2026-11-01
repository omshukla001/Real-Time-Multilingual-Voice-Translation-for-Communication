import base64
import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.modules.tts.tts import synthesize
from app.pipeline.service import audio_wav_to_translation_and_tts
from app.pipeline.streaming import encode_events, handle_stream_message, store

logger = logging.getLogger("talkbridge.router.pipeline")

router = APIRouter(tags=["pipeline"])


class TtsRequest(BaseModel):
    text: str = Field(..., min_length=1)
    lang: str = Field(default="en", min_length=2, max_length=8)
    prefer: str = Field(default="gtts")


class TranslateTextRequest(BaseModel):
    text: str = Field(..., min_length=1)
    src_lang: str = Field(default="en")
    tgt_lang: str = Field(default="hi")
    tts: bool = Field(default=True)
    gemini_api_key: Optional[str] = Field(default=None)


class TranslateTextResponse(BaseModel):
    original: str
    translated: str
    tts_mime: Optional[str] = None
    tts_b64: Optional[str] = None


class TranslateResponse(BaseModel):
    transcription: str
    translation: str
    tts_mime: str
    tts_b64: str


@router.post("/tts-output")
async def tts_output(req: TtsRequest) -> Response:
    audio = await asyncio.to_thread(synthesize, req.text, lang=req.lang, prefer=req.prefer)
    return Response(content=audio.data, media_type=audio.mime)


@router.post("/translate-text", response_model=TranslateTextResponse)
async def translate_text(req: TranslateTextRequest) -> TranslateTextResponse:
    """Translate text from src_lang to tgt_lang and return translated text + synthesized TTS audio."""
    from app.modules.translation.marianmt import translate as marian_translate

    src = req.src_lang
    tgt = req.tgt_lang
    if src == tgt:
        translated = req.text
    else:
        try:
            translated = await asyncio.to_thread(
                marian_translate,
                req.text,
                src_lang=src,
                tgt_lang=tgt,
                api_key=req.gemini_api_key,
            )
        except Exception as e:
            logger.exception("translate_text_endpoint_failed src=%s tgt=%s", src, tgt)
            translated = req.text

    tts_b64 = None
    tts_mime = None
    if req.tts and translated:
        try:
            audio = await asyncio.to_thread(synthesize, translated, lang=tgt)
            tts_mime = audio.mime
            tts_b64 = base64.b64encode(audio.data).decode("ascii")
        except Exception as e:
            logger.exception("translate_text_tts_failed")

    return TranslateTextResponse(
        original=req.text,
        translated=translated,
        tts_mime=tts_mime,
        tts_b64=tts_b64,
    )


@router.post("/translate-audio", response_model=TranslateResponse)
async def translate_audio(
    file: UploadFile = File(...),
    source_lang: Optional[str] = Form(default=None),
    target_lang: str = Form(default="en"),
    whisper_model: str = Form(default="base"),
    tts_lang: str = Form(default="en"),
) -> TranslateResponse:
    """Standalone audio->ASR->translate->TTS.

    MVP expects WAV input. (Streaming integration happens via /stream-audio.)
    """
    wav_bytes = await file.read()
    try:
        result = await audio_wav_to_translation_and_tts(
            wav_bytes,
            source_lang=source_lang,
            target_lang=target_lang,
            whisper_model=whisper_model,
            tts_lang=tts_lang,
        )
    except Exception as e:
        logger.exception("translate_audio_failed filename=%s", file.filename)
        # Most common MVP failure: non-WAV uploads or missing ML deps/models.
        raise HTTPException(
            status_code=400,
            detail=f"translate-audio failed. Ensure you uploaded a WAV file. Error: {type(e).__name__}: {e}",
        ) from e
    return TranslateResponse(
        transcription=result.transcription,
        translation=result.translation,
        tts_mime=result.tts.mime,
        tts_b64=base64.b64encode(result.tts.data).decode("ascii"),
    )


@router.websocket("/stream-audio/{session_id}")
async def stream_audio(ws: WebSocket, session_id: str) -> None:
    """Streaming endpoint (MVP).

    Client sends JSON messages:
      {
        "pcm16_b64": "...",
        "sample_rate": 16000,
        "source_lang": "hi",
        "target_lang": "en",
        "whisper_model": "tiny",
        "tts_lang": "en"
      }

    Server responds with staged events:
      - audio_chunk_received
      - segment_finalized (silence-based)
      - partial_transcript
      - final_transcript
      - translation_complete
      - tts_audio_ready
    """
    await ws.accept()
    logger.info("stream_session_connected session=%s", session_id)
    session = await store.get(session_id)

    async def send_heavy_events(ev_list: list[dict]) -> None:
        """Send heavy-stage events from background tasks without blocking the main loop."""
        try:
            for payload in encode_events(ev_list):
                await ws.send_text(payload)
        except Exception:
            pass

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"event": "error", "error": "invalid_json"}))
                continue
            if msg.get("asr_only"):
                # Speech-to-text only (the /call UI translates on each listener's
                # device): same source/target skips translation, no TTS language skips TTS.
                target_lang = msg.get("source_lang") or "en"
                tts_lang = ""
            else:
                target_lang = msg.get("target_lang") or "en"
                tts_lang = msg.get("tts_lang") or target_lang
            events = await handle_stream_message(
                session,
                msg,
                source_lang=msg.get("source_lang"),
                target_lang=target_lang,
                whisper_model=msg.get("whisper_model") or "base",
                tts_lang=tts_lang,
                heavy_event_consumer=send_heavy_events,
            )
            for payload in encode_events(events):
                await ws.send_text(payload)
    except WebSocketDisconnect:
        logger.info("stream_session_disconnected session=%s", session_id)
    except Exception:
        logger.exception("stream_session_error session=%s", session_id)
    finally:
        await store.delete(session_id)


class ClientLog(BaseModel):
    client: str = Field(default="", max_length=64)
    line: str = Field(..., max_length=2000)


@router.post("/client-log")
async def client_log(entry: ClientLog) -> dict:
    """Browser log lines (speech/mic errors etc.) so phone problems show up in the server log."""
    logger.info("client_log client=%s %s", entry.client, entry.line)
    return {"ok": True}


@router.get("/system-status")
async def system_status() -> dict:
    """Lightweight system status endpoint for demos."""
    stats = await store.stats()
    return {"ok": True, **stats}

