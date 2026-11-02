"""Shapes of the agent-runtime API, as TypedDicts over the JSON the server sends and receives."""
from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional, Union

if sys.version_info >= (3, 8):
    from typing import Literal, TypedDict
else:  # pragma: no cover
    from typing_extensions import Literal, TypedDict

RequestRole = Literal["user", "assistant", "system"]
InferenceErrorCode = Literal["invalid_format", "schema_mismatch", "empty_answer", "max_turns", "timeout", "provider_error", "internal_error"]
InferenceStatus = Literal["running", "success", "error"]
InferenceMode = Literal["object", "text"]
AttachmentKind = Literal["file", "image", "tool_image", "output"]

FormatModel = Dict[str, Any]
"""A JSON Schema (draft 2020-12) whose top level is an object with ``required`` and ``properties``."""


class RequestMessage(TypedDict, total=False):
    """One message of the conversation; the shape of a wwwroot.jsonl record message."""

    role: RequestRole
    content: str
    images: List[str]
    """Base64 images (raw or data: URL). Shown to the model in user messages and stored in the history; not written to the workspace."""


class RequestFile(TypedDict):
    """A file written into the agent workspace before the run starts."""

    name: str
    content: str


class InferenceError(TypedDict):
    code: InferenceErrorCode
    message: str
    details: List[str]


class RunInfo(TypedDict):
    id: str
    model: str
    attempts: int
    turns: int
    durationMs: int


class InferenceSuccess(RunInfo):
    status: Literal["success"]
    data: Any


class TextSuccess(RunInfo):
    status: Literal["success"]
    text: str


class InferenceFailure(RunInfo):
    status: Literal["error"]
    error: InferenceError


InferenceResponse = Union[InferenceSuccess, InferenceFailure]
TextResponse = Union[TextSuccess, InferenceFailure]


class AttachmentMeta(TypedDict):
    id: str
    inferenceId: str
    kind: AttachmentKind
    name: str
    mime: str
    size: int
    sha256: str


class Attachment(AttachmentMeta):
    data: bytes


class InferenceSummary(TypedDict):
    id: str
    mode: InferenceMode
    status: InferenceStatus
    model: str
    createdAt: str
    finishedAt: Optional[str]
    durationMs: Optional[int]
    attempts: int
    turns: int
    errorCode: Optional[str]
    errorMessage: Optional[str]
    messageCount: int
    fileCount: int


class StoredRequest(TypedDict, total=False):
    """Request as stored by the server: image and file payloads replaced by attachment ids."""

    messages: List[Dict[str, Any]]
    files: List[Dict[str, Any]]
    format: FormatModel
    model: str
    instructions: str


class InferenceRecord(InferenceSummary):
    request: StoredRequest
    messages: List[Any]
    result: Any
    error: Optional[InferenceError]
    attachments: List[AttachmentMeta]


class ListInferencesResponse(TypedDict):
    total: int
    items: List[InferenceSummary]


class Health(TypedDict):
    status: str
    model: str
    host: str
    vision: bool
    running: bool
    queued: int
    uptimeSeconds: int
