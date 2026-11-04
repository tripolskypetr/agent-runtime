"""Asynchronous client: the synchronous one run in a worker thread through ``asyncio.to_thread``.

The HTTP request itself stays blocking ``urllib``; what ``await`` buys is that the event loop
keeps running while an inference takes its minutes. Two limits follow from that design:
every call in flight occupies a thread of the default executor, and cancelling the task does
not abort the request, the thread finishes it in the background and the server keeps running
the inference.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from .client import DEFAULT_MAX_ATTEMPTS, _UNSET, AgentRuntimeClient, Transport
from .models import (
    Attachment,
    FormatModel,
    Health,
    InferenceRecord,
    InferenceResponse,
    ListInferencesResponse,
    RequestFile,
    RequestMessage,
    TextResponse,
)


class AsyncAgentRuntimeClient:
    """``async`` twin of :class:`AgentRuntimeClient` with the same methods and arguments.

    Every method awaits the synchronous call in a worker thread. The error model is the same:
    :class:`AgentRuntimeError` for transport and HTTP failures, a typed failure from
    ``inference()`` / ``text()`` and an exception from ``generate_object()`` / ``generate_text()``
    when the agent itself failed.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        validate_answer: bool = True,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        transport: Optional[Transport] = None,
    ) -> None:
        self.sync = AgentRuntimeClient(base_url, headers=headers, timeout=timeout, validate_answer=validate_answer, max_attempts=max_attempts, transport=transport)
        """The underlying synchronous client; ``base_url``, ``headers`` and the other options live there."""

    @property
    def base_url(self) -> str:
        return self.sync.base_url

    async def __aenter__(self) -> "AsyncAgentRuntimeClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    # ----------------------------------------------------------- inference

    async def inference(
        self,
        messages: List[RequestMessage],
        format: FormatModel,
        *,
        files: Optional[List[RequestFile]] = None,
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = _UNSET,
    ) -> InferenceResponse:
        """POST /api/v1/inference with client-side validation and retries; see :meth:`AgentRuntimeClient.inference`."""
        return await asyncio.to_thread(self.sync.inference, messages, format, files=files, model=model, instructions=instructions, headers=headers, timeout=timeout)

    async def generate_object(
        self,
        messages: List[RequestMessage],
        format: FormatModel,
        *,
        files: Optional[List[RequestFile]] = None,
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = _UNSET,
    ) -> Dict[str, Any]:
        """Returns the answer matching ``format``, raises :class:`AgentRuntimeError` when the agent failed."""
        return await asyncio.to_thread(self.sync.generate_object, messages, format, files=files, model=model, instructions=instructions, headers=headers, timeout=timeout)

    async def text(
        self,
        messages: List[RequestMessage],
        *,
        files: Optional[List[RequestFile]] = None,
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = _UNSET,
    ) -> TextResponse:
        """POST /api/v1/text; the full response, success or failure."""
        return await asyncio.to_thread(self.sync.text, messages, files=files, model=model, instructions=instructions, headers=headers, timeout=timeout)

    async def generate_text(
        self,
        messages: List[RequestMessage],
        *,
        files: Optional[List[RequestFile]] = None,
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = _UNSET,
    ) -> str:
        """Returns the agent's final message, raises :class:`AgentRuntimeError` when the agent failed."""
        return await asyncio.to_thread(self.sync.generate_text, messages, files=files, model=model, instructions=instructions, headers=headers, timeout=timeout)

    # --------------------------------------------------------------- admin

    async def health(self) -> Health:
        return await asyncio.to_thread(self.sync.health)

    async def list_inferences(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        status: Optional[str] = None,
        mode: Optional[str] = None,
        q: Optional[str] = None,
    ) -> ListInferencesResponse:
        return await asyncio.to_thread(self.sync.list_inferences, limit=limit, offset=offset, status=status, mode=mode, q=q)

    async def get_inference(self, inference_id: str) -> InferenceRecord:
        return await asyncio.to_thread(self.sync.get_inference, inference_id)

    async def delete_inference(self, inference_id: str) -> Dict[str, bool]:
        return await asyncio.to_thread(self.sync.delete_inference, inference_id)

    async def get_attachment(self, inference_id: str, attachment_id: str) -> Attachment:
        return await asyncio.to_thread(self.sync.get_attachment, inference_id, attachment_id)


def create_async_client(base_url: Optional[str] = None, **options: Any) -> AsyncAgentRuntimeClient:
    return AsyncAgentRuntimeClient(base_url, **options)
