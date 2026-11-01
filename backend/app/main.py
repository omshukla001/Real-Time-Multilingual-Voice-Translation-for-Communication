import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.logging import configure_logging
from app.modules.asr.whisper_asr import warmup_high_accuracy_asr, warmup_whisper
from app.modules.translation.marianmt import warmup_translation
from app.modules.tts.tts import warmup_tts
from app.routers.pipeline import router as pipeline_router
from app.routers.signaling import router as signaling_router

configure_logging()
logger = logging.getLogger("talkbridge")

app = FastAPI(title="TalkBridge AI Backend", version="0.1.0")

# Frontend is often served from file:// or a different port.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

import os
from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app.include_router(signaling_router)
app.include_router(pipeline_router)


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


# `run_app.py --lan` serves HTTPS with a certificate from a local CA. Phones
# (iPhones especially, whose Safari won't open secure WebSockets to an
# untrusted certificate) install this CA once to trust the connection.
_LAN_CA_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "certs", "ca.crt")


@app.get("/talkbridge-ca.crt")
async def lan_ca_certificate():
    if not os.path.isfile(_LAN_CA_PATH):
        raise HTTPException(status_code=404, detail="No local CA yet; start the app with `python run_app.py --lan`.")
    return FileResponse(_LAN_CA_PATH, media_type="application/x-x509-ca-cert", filename="talkbridge-ca.crt")


@app.on_event("startup")
async def on_startup() -> None:
    # Warm up TTS and both hi<->en translation models in the background so the
    # first real phone-call segment doesn't stall on a cold download.
    async def _warm():
        await asyncio.to_thread(warmup_whisper, ["tiny.en"])
        await asyncio.to_thread(warmup_high_accuracy_asr)
        await asyncio.to_thread(warmup_tts)
        await asyncio.to_thread(warmup_translation, [("hi", "en"), ("en", "hi")])

    asyncio.create_task(_warm())


# Serve the frontend statically. Mount last so API routes (/health, /ws/...,
# /stream-audio/..., /tts-output, /translate-audio, /system-status) take
# precedence over the catch-all static mount at "/".
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

