"""Errors raised by the client."""
from __future__ import annotations

from typing import Any, Dict, List, Optional


class AgentRuntimeError(Exception):
    """Raised for any transport or HTTP failure.

    When the server answered with an InferenceFailure body (HTTP 500 from
    /inference or /text) the typed failure is in ``failure`` and ``code`` is the
    server's InferenceErrorCode. ``status`` is 0 for network failures.
    """

    def __init__(self, message: str, status: int, body: Any, failure: Optional[Dict[str, Any]] = None, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.failure = failure
        self._explicit_code = code

    @property
    def code(self) -> Optional[str]:
        """InferenceErrorCode when the server returned a typed failure or rejected the schema (``invalid_format``), otherwise None."""
        if self._explicit_code is not None:
            return self._explicit_code
        if self.failure is not None:
            return self.failure.get("error", {}).get("code")
        return None

    @property
    def details(self) -> List[str]:
        """Per-attempt details when the server returned a typed failure."""
        if self.failure is None:
            return []
        return list(self.failure.get("error", {}).get("details") or [])

    @property
    def inference_id(self) -> Optional[str]:
        """Inference id (present for typed failures) for looking the run up in the admin UI."""
        return self.failure.get("id") if self.failure is not None else None


def is_inference_failure(value: Any) -> bool:
    """True for a server body of the shape ``{"status": "error", "error": {"code": ...}}``."""
    return isinstance(value, dict) and value.get("status") == "error" and isinstance((value.get("error") or {}).get("code"), str)


def is_invalid_format(value: Any) -> bool:
    """True for the 400 body returned when ``format`` is not a valid JSON Schema."""
    return is_inference_failure(value) and value["error"]["code"] == "invalid_format"
