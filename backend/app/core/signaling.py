import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import WebSocket

logger = logging.getLogger("talkbridge.signaling")


@dataclass
class Room:
    room_id: str
    clients: Dict[str, WebSocket] = field(default_factory=dict)


class SignalingManager:
    """Small in-memory signaling hub.

    Not persistent (dev MVP). Keeps rooms and forwards signaling messages between peers.
    """

    def __init__(self) -> None:
        self._rooms: Dict[str, Room] = {}
        self._lock = asyncio.Lock()

    async def connect(self, room_id: str, client_id: str, ws: WebSocket) -> Optional[str]:
        await ws.accept()
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                room = Room(room_id=room_id)
                self._rooms[room_id] = room

            room.clients[client_id] = ws
            peer_id = next((cid for cid in room.clients.keys() if cid != client_id), None)

        logger.info("client_connected room=%s client=%s peer=%s", room_id, client_id, peer_id)
        await self._notify_peer_joined(room_id=room_id, joined_client_id=client_id)
        return peer_id

    async def disconnect(self, room_id: str, client_id: str) -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return
            room.clients.pop(client_id, None)
            is_empty = len(room.clients) == 0
            if is_empty:
                self._rooms.pop(room_id, None)

        logger.info("client_disconnected room=%s client=%s", room_id, client_id)
        await self._broadcast(
            room_id,
            {
                "type": "peer-left",
                "from": client_id,
                "to": None,
                "data": {"peer_id": client_id},
            },
            exclude_client_id=client_id,
        )

    async def forward(self, room_id: str, sender_id: str, message: dict) -> None:
        """Forward message to either 'to' peer or broadcast to others."""
        to_id = message.get("to")
        if to_id:
            await self._send_to(room_id, to_id, message)
            return
        await self._broadcast(room_id, message, exclude_client_id=sender_id)

    async def _notify_peer_joined(self, room_id: str, joined_client_id: str) -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return
            # Notify each client who their peer is (first other client).
            for cid, ws in list(room.clients.items()):
                peer_id = next((x for x in room.clients.keys() if x != cid), None)
                payload = {
                    "type": "peer-joined",
                    "from": joined_client_id,
                    "to": cid,
                    "data": {"peer_id": peer_id},
                }
                try:
                    await ws.send_text(json.dumps(payload))
                except Exception:
                    logger.exception("notify_failed room=%s to=%s", room_id, cid)

    async def _send_to(self, room_id: str, client_id: str, payload: dict) -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            ws = room.clients.get(client_id) if room else None
        if not ws:
            return
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            logger.exception("send_failed room=%s to=%s", room_id, client_id)

    async def _broadcast(self, room_id: str, payload: dict, exclude_client_id: Optional[str] = None) -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            targets = (
                [(cid, ws) for cid, ws in room.clients.items() if cid != exclude_client_id] if room else []
            )
        for cid, ws in targets:
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                logger.exception("broadcast_failed room=%s to=%s", room_id, cid)


signaling_manager = SignalingManager()

