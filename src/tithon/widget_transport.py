"""Bounded classic-comm frames; outbound actions are never executable replay."""

import base64
import json

MAX_WIDGET_JSON = 256 * 1024
MAX_WIDGET_BUFFERS = 4 * 1024 * 1024
MAX_WIDGET_PENDING = 64
WIDGET_REQUEST_TTL = 60


def request_content(request: dict) -> tuple[dict, list[bytes]]:
    """Validate only comm_msg data, with no client-controlled kernel headers."""
    if not isinstance(request.get("request_id"), str) or not 1 <= len(request["request_id"]) <= 128:
        raise ValueError("Invalid widget request ID")
    if not isinstance(request.get("comm_id"), str) or not 1 <= len(request["comm_id"]) <= 256:
        raise ValueError("Invalid widget model ID")
    data = request.get("data")
    if not isinstance(data, dict) or data.get("method") not in (
        "update",
        "request_state",
        "custom",
    ):
        raise ValueError("Unsupported widget message")
    if len(json.dumps(data, allow_nan=False).encode()) > MAX_WIDGET_JSON:
        raise ValueError("Widget message is too large")
    if data["method"] == "update" and not isinstance(data.get("state"), dict):
        raise ValueError("Widget update state must be an object")
    encoded = request.get("buffers", [])
    if not isinstance(encoded, list) or len(encoded) > 64:
        raise ValueError("Invalid widget buffers")
    buffers = []
    size = 0
    for value in encoded:
        if not isinstance(value, str) or len(value) > MAX_WIDGET_BUFFERS * 4 // 3 + 4:
            raise ValueError("Widget buffer is too large")
        buffer = base64.b64decode(value, validate=True)
        size += len(buffer)
        if size > MAX_WIDGET_BUFFERS:
            raise ValueError("Widget buffers are too large")
        buffers.append(buffer)
    return {"comm_id": request["comm_id"], "data": data}, buffers


def raw_message(message: dict) -> dict:
    """Keep headers/metadata and exact binary bytes in a JSON-safe journal frame."""
    frame = {
        key: message.get(key, {}) for key in ("header", "parent_header", "metadata", "content")
    }
    frame["buffers"] = [
        base64.b64encode(bytes(b)).decode("ascii") for b in message.get("buffers", [])
    ]
    return json.loads(json.dumps(frame, default=str))
