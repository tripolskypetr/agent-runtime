"""Request helpers: base64 encoding of files and images."""
from __future__ import annotations

import base64
from typing import List, Optional, Union

from .models import RequestFile, RequestMessage


def _to_base64(data: Union[bytes, bytearray, memoryview, str]) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    return base64.b64encode(raw).decode("ascii")


def encode_file(name: str, data: Union[bytes, bytearray, memoryview, str]) -> RequestFile:
    """Builds a request file from raw bytes or a UTF-8 string."""
    return {"name": name, "content": _to_base64(data)}


def encode_image(data: Union[bytes, bytearray, memoryview]) -> str:
    """Encodes image bytes (jpeg, png, gif, webp, bmp) as the base64 string expected in ``messages[].images``."""
    return _to_base64(data)


def user_message(content: str, images: Optional[List[Union[bytes, bytearray, memoryview]]] = None) -> RequestMessage:
    """Shorthand for a user message with optional image attachments."""
    message: RequestMessage = {"role": "user", "content": content}
    if images:
        message["images"] = [encode_image(image) for image in images]
    return message
