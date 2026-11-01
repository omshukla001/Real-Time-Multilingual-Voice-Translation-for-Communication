import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.signaling import signaling_manager

logger = logging.getLogger("talkbridge.router.signaling")

router = APIRouter(tags=["signaling"])


@router.websocket("/ws/signaling/{room_id}/{client_id}")
async def ws_signaling(ws: WebSocket, room_id: str, client_id: str) -> None:
    peer_id = await signaling_manager.connect(room_id=room_id, client_id=client_id, ws=ws)
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            msg.setdefault("from", client_id)
            await signaling_manager.forward(room_id=room_id, sender_id=client_id, message=msg)
    except WebSocketDisconnect:
        logger.info("ws_disconnect room=%s client=%s", room_id, client_id)
    except Exception:
        logger.exception("ws_error room=%s client=%s", room_id, client_id)
    finally:
        await signaling_manager.disconnect(room_id=room_id, client_id=client_id)

