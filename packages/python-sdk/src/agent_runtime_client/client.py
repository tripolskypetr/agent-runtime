"""Typed client for agent-runtime over the standard library."""
from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from .errors import AgentRuntimeError, is_inference_failure, is_invalid_format
from .models import (
    Attachment,
    FormatModel,
    Health,
    InferenceFailure,
    InferenceRecord,
    InferenceResponse,
    ListInferencesResponse,
    RequestFile,
    RequestMessage,
    TextResponse,
)
from .validation import validate_tool_arguments

DEFAULT_BASE_URL = "http://localhost:10050"
"""Default server address; the ``AGENT_RUNTIME_URL`` environment variable overrides it."""

DEFAULT_MAX_ATTEMPTS = 3
"""Inferences ``generate_object`` / ``inference`` run before giving up on an answer the client-side validator rejects."""

Transport = Callable[[str, str, Dict[str, str], Optional[bytes], Optional[float]], Tuple[int, Dict[str, str], bytes]]
"""``transport(method, url, headers, body, timeout) -> (status, headers, body)``; the default uses ``urllib``."""

_UNSET: Any = object()


def resolve_base_url(base_url: Optional[str] = None) -> str:
    return base_url or os.environ.get("AGENT_RUNTIME_URL") or DEFAULT_BASE_URL


def urllib_transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: Optional[float]) -> Tuple[int, Dict[str, str], bytes]:
    """Default transport. ``timeout=None`` waits as long as the server takes: an inference can run for minutes."""
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, {key.lower(): value for key, value in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {key.lower(): value for key, value in error.headers.items()}, error.read()


class AgentRuntimeClient:
    """Client for agent-runtime.

    Every method raises :class:`AgentRuntimeError` on transport or HTTP errors. ``inference()`` and
    ``text()`` return the typed failure instead of raising when the agent itself failed (HTTP 500
    with an InferenceFailure body); ``generate_object()`` and ``generate_text()`` raise for it.
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
        """
        :param base_url: server address, default ``AGENT_RUNTIME_URL`` or ``http://localhost:10050``.
        :param headers: headers added to every request, e.g. a reverse-proxy token.
        :param timeout: seconds to wait for a response; ``None`` (default) waits as long as the inference takes.
        :param validate_answer: check every successful answer against ``format`` with the server's validator and
            run the inference again when it does not match (default True).
        :param max_attempts: inferences to run before failing with ``schema_mismatch`` when the client-side
            validation keeps rejecting (default 3).
        :param transport: replacement for the HTTP layer, mostly for tests; see :data:`Transport`.
        """
        self.base_url = resolve_base_url(base_url).rstrip("/")
        self.headers = dict(headers or {})
        self.timeout = timeout
        self.validate_answer = validate_answer
        self.max_attempts = max(1, int(max_attempts))
        self.transport = transport or urllib_transport

    # ----------------------------------------------------------- inference

    def inference(
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
        """POST /api/v1/inference. Returns the full response, success or failure; ``status`` discriminates.

        With ``validate_answer`` (default) a successful answer is checked against ``format`` locally; a
        mismatch runs the inference again, up to ``max_attempts`` times in total, and then returns a
        failure with code ``schema_mismatch`` whose ``details`` list every rejected attempt.
        """
        body = _body(messages, files, model, instructions, format)
        details: List[str] = []
        attempts = turns = duration_ms = 0
        last: Optional[Dict[str, Any]] = None
        for _ in range(self.max_attempts):
            response = self._run_agent("/api/v1/inference", body, headers, timeout)
            last = response
            attempts += int(response.get("attempts") or 0)
            turns += int(response.get("turns") or 0)
            duration_ms += int(response.get("durationMs") or 0)
            if response.get("status") != "success" or not self.validate_answer:
                return response  # type: ignore[return-value]
            result = validate_tool_arguments(response.get("data"), format)
            if result.success:
                return response  # type: ignore[return-value]
            details.append(f"inference {response.get('id')}: {result.error}")
        assert last is not None
        last_reason = details[-1].split(": ", 1)[1] if details else ""
        failure: InferenceFailure = {
            "id": last.get("id", ""),
            "model": last.get("model", ""),
            "attempts": attempts,
            "turns": turns,
            "durationMs": duration_ms,
            "status": "error",
            "error": {
                "code": "schema_mismatch",
                "message": f"Answer rejected by the client-side validator in {self.max_attempts} inference(s): {last_reason}",
                "details": details,
            },
        }
        return failure

    def generate_object(
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
        """The json-inference ``generateObject`` equivalent: returns the answer matching ``format``,
        raises :class:`AgentRuntimeError` when the agent failed."""
        response = self.inference(messages, format, files=files, model=model, instructions=instructions, headers=headers, timeout=timeout)
        if response["status"] == "error":
            error = response["error"]
            raise AgentRuntimeError(f"{error['code']}: {error['message']}", 500, response, response)
        return response["data"]

    def text(
        self,
        messages: List[RequestMessage],
        *,
        files: Optional[List[RequestFile]] = None,
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = _UNSET,
    ) -> TextResponse:
        """POST /api/v1/text. Returns the full response, success or failure."""
        return self._run_agent("/api/v1/text", _body(messages, files, model, instructions), headers, timeout)  # type: ignore[return-value]

    def generate_text(
        self,
        messages: List[RequestMessage],
        *,
        files: Optional[List[RequestFile]] = None,
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = _UNSET,
    ) -> str:
        """The json-inference ``generateText`` equivalent: returns the final message, raises when the agent failed."""
        response = self.text(messages, files=files, model=model, instructions=instructions, headers=headers, timeout=timeout)
        if response["status"] == "error":
            error = response["error"]
            raise AgentRuntimeError(f"{error['code']}: {error['message']}", 500, response, response)
        return response["text"]

    # --------------------------------------------------------------- admin

    def health(self) -> Health:
        return self._json("GET", "/api/v1/health")

    def list_inferences(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        status: Optional[str] = None,
        mode: Optional[str] = None,
        q: Optional[str] = None,
    ) -> ListInferencesResponse:
        """Lists inferences, newest first. ``q`` is a case-insensitive substring search over request, result, error, id and model."""
        query: Dict[str, str] = {}
        if limit is not None:
            query["limit"] = str(limit)
        if offset is not None:
            query["offset"] = str(offset)
        if status:
            query["status"] = status
        if mode:
            query["mode"] = mode
        if q:
            query["q"] = q
        suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
        return self._json("GET", f"/api/v1/inferences{suffix}")

    def get_inference(self, inference_id: str) -> InferenceRecord:
        """Request, transcript, result or error and attachment metadata of one run."""
        return self._json("GET", f"/api/v1/inferences/{urllib.parse.quote(inference_id, safe='')}")

    def delete_inference(self, inference_id: str) -> Dict[str, bool]:
        return self._json("DELETE", f"/api/v1/inferences/{urllib.parse.quote(inference_id, safe='')}")

    def get_attachment(self, inference_id: str, attachment_id: str) -> Attachment:
        """Downloads an attachment (request file, image, tool image or produced file) with its metadata."""
        record = self.get_inference(inference_id)
        meta = next((item for item in record["attachments"] if item["id"] == attachment_id), None)
        if meta is None:
            raise AgentRuntimeError(f"Attachment {attachment_id} not found in inference {inference_id}", 404, None)
        path = f"/api/v1/inferences/{urllib.parse.quote(inference_id, safe='')}/attachments/{urllib.parse.quote(attachment_id, safe='')}"
        status, _, payload = self._request("GET", path, None, None, _UNSET, accept="*/*")
        if status >= 400:
            raise AgentRuntimeError(f"HTTP {status} while downloading attachment", status, payload.decode("utf-8", "replace"))
        attachment: Attachment = {**meta, "data": payload}  # type: ignore[typeddict-item]
        return attachment

    # ------------------------------------------------------------ internals

    def _run_agent(self, path: str, body: Dict[str, Any], headers: Optional[Dict[str, str]], timeout: Optional[float]) -> Dict[str, Any]:
        status, _, raw = self._request("POST", path, body, headers, timeout)
        payload = _parse_body(raw)
        if status < 400:
            return payload
        if status == 500 and is_inference_failure(payload):
            return payload
        if is_invalid_format(payload):
            # 400: the schema itself was rejected before any inference ran
            raise AgentRuntimeError(f"{payload['error']['code']}: {payload['error']['message']}", status, payload, None, payload["error"]["code"])
        raise AgentRuntimeError(_describe(status, payload), status, payload)

    def _json(self, method: str, path: str) -> Any:
        status, _, raw = self._request(method, path, None, None, _UNSET)
        payload = _parse_body(raw)
        if status >= 400:
            raise AgentRuntimeError(_describe(status, payload), status, payload)
        return payload

    def _request(
        self,
        method: str,
        path: str,
        body: Any,
        headers: Optional[Dict[str, str]],
        timeout: Optional[float],
        accept: str = "application/json",
    ) -> Tuple[int, Dict[str, str], bytes]:
        merged = {"accept": accept, **self.headers, **(headers or {})}
        data: Optional[bytes] = None
        if body is not None:
            merged["content-type"] = "application/json"
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        url = f"{self.base_url}{path}"
        try:
            return self.transport(method, url, merged, data, self.timeout if timeout is _UNSET else timeout)
        except AgentRuntimeError:
            raise
        except (urllib.error.URLError, socket.timeout, OSError, ValueError) as error:
            reason = getattr(error, "reason", None) or error
            raise AgentRuntimeError(f"Request to {url} failed: {reason}", 0, None) from error


def _body(
    messages: List[RequestMessage],
    files: Optional[List[RequestFile]],
    model: Optional[str],
    instructions: Optional[str],
    format: Optional[FormatModel] = None,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {"messages": list(messages)}
    if files:
        body["files"] = list(files)
    if format is not None:
        body["format"] = format
    if model:
        body["model"] = model
    if instructions:
        body["instructions"] = instructions
    return body


def _parse_body(raw: bytes) -> Any:
    if not raw:
        return None
    text = raw.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def _describe(status: int, payload: Any) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("message"), str):
        return f"HTTP {status}: {payload['message']}"
    return f"HTTP {status}"


def create_client(base_url: Optional[str] = None, **options: Any) -> AgentRuntimeClient:
    return AgentRuntimeClient(base_url, **options)
