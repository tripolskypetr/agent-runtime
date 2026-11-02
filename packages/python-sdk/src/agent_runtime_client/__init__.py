"""Python client for agent-runtime: generate_object() / generate_text() over the REST API, plus the admin API.

Import name ``agent_runtime_client``, distribution ``agent-runtime-client``. Zero dependencies, Python 3.9+.
"""
from .client import DEFAULT_BASE_URL, DEFAULT_MAX_ATTEMPTS, AgentRuntimeClient, Transport, create_client, resolve_base_url, urllib_transport
from .errors import AgentRuntimeError, is_inference_failure, is_invalid_format
from .functions import generate_object, generate_text, inference, text
from .helpers import encode_file, encode_image, user_message
from .models import (
    Attachment,
    AttachmentKind,
    AttachmentMeta,
    FormatModel,
    Health,
    InferenceError,
    InferenceErrorCode,
    InferenceFailure,
    InferenceMode,
    InferenceRecord,
    InferenceResponse,
    InferenceStatus,
    InferenceSuccess,
    InferenceSummary,
    ListInferencesResponse,
    RequestFile,
    RequestMessage,
    RequestRole,
    RunInfo,
    StoredRequest,
    TextResponse,
    TextSuccess,
)
from .validation import ValidationResult, assert_answer, resolve_ref, type_of, validate_answer, validate_tool_arguments, validate_value

__version__ = "0.1.0"

__all__ = [
    "AgentRuntimeClient",
    "AgentRuntimeError",
    "Attachment",
    "AttachmentKind",
    "AttachmentMeta",
    "DEFAULT_BASE_URL",
    "DEFAULT_MAX_ATTEMPTS",
    "FormatModel",
    "Health",
    "InferenceError",
    "InferenceErrorCode",
    "InferenceFailure",
    "InferenceMode",
    "InferenceRecord",
    "InferenceResponse",
    "InferenceStatus",
    "InferenceSuccess",
    "InferenceSummary",
    "ListInferencesResponse",
    "RequestFile",
    "RequestMessage",
    "RequestRole",
    "RunInfo",
    "StoredRequest",
    "TextResponse",
    "TextSuccess",
    "Transport",
    "ValidationResult",
    "assert_answer",
    "create_client",
    "encode_file",
    "encode_image",
    "generate_object",
    "generate_text",
    "inference",
    "is_inference_failure",
    "is_invalid_format",
    "resolve_base_url",
    "resolve_ref",
    "text",
    "type_of",
    "urllib_transport",
    "user_message",
    "validate_answer",
    "validate_tool_arguments",
    "validate_value",
]
