"""Standalone ``generate_object`` / ``generate_text`` functions in the json-inference style: each call creates a client."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from .client import AgentRuntimeClient, Transport
from .models import FormatModel, InferenceResponse, RequestFile, RequestMessage, TextResponse


def _client(base_url: Optional[str], headers: Optional[Dict[str, str]], timeout: Optional[float], validate_answer: bool, max_attempts: int, transport: Optional[Transport]) -> AgentRuntimeClient:
    return AgentRuntimeClient(base_url, headers=headers, timeout=timeout, validate_answer=validate_answer, max_attempts=max_attempts, transport=transport)


def generate_object(
    messages: List[RequestMessage],
    format: FormatModel,
    *,
    files: Optional[List[RequestFile]] = None,
    model: Optional[str] = None,
    instructions: Optional[str] = None,
    base_url: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = None,
    validate_answer: bool = True,
    max_attempts: int = 3,
    transport: Optional[Transport] = None,
) -> Dict[str, Any]:
    """Runs the agent on agent-runtime and returns the answer matching ``format``.

    ``base_url`` defaults to ``AGENT_RUNTIME_URL`` or ``http://localhost:10050``. Raises
    :class:`~agent_runtime_client.AgentRuntimeError` when the agent failed.

    >>> entry = generate_object(
    ...     [{"role": "user", "content": "..."}],
    ...     {"type": "object", "required": ["position"], "properties": {"position": {"type": "string", "enum": ["long", "short"]}}},
    ... )
    >>> entry["position"]
    'long'
    """
    return _client(base_url, headers, timeout, validate_answer, max_attempts, transport).generate_object(
        messages, format, files=files, model=model, instructions=instructions
    )


def inference(
    messages: List[RequestMessage],
    format: FormatModel,
    *,
    files: Optional[List[RequestFile]] = None,
    model: Optional[str] = None,
    instructions: Optional[str] = None,
    base_url: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = None,
    validate_answer: bool = True,
    max_attempts: int = 3,
    transport: Optional[Transport] = None,
) -> InferenceResponse:
    """Same request as :func:`generate_object`, but returns the full response (``status`` is ``"success"`` or ``"error"``) instead of raising."""
    return _client(base_url, headers, timeout, validate_answer, max_attempts, transport).inference(
        messages, format, files=files, model=model, instructions=instructions
    )


def generate_text(
    messages: List[RequestMessage],
    *,
    files: Optional[List[RequestFile]] = None,
    model: Optional[str] = None,
    instructions: Optional[str] = None,
    base_url: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = None,
    transport: Optional[Transport] = None,
) -> str:
    """Runs the agent and returns its final message as plain text. Raises :class:`~agent_runtime_client.AgentRuntimeError` when the agent failed."""
    return _client(base_url, headers, timeout, True, 1, transport).generate_text(messages, files=files, model=model, instructions=instructions)


def text(
    messages: List[RequestMessage],
    *,
    files: Optional[List[RequestFile]] = None,
    model: Optional[str] = None,
    instructions: Optional[str] = None,
    base_url: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = None,
    transport: Optional[Transport] = None,
) -> TextResponse:
    """Same request as :func:`generate_text`, but returns the full response instead of raising."""
    return _client(base_url, headers, timeout, True, 1, transport).text(messages, files=files, model=model, instructions=instructions)
