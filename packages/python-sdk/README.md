# agent-runtime-client

> Python client for [agent-runtime](https://github.com/tripolskypetr/agent-runtime) over the standard library. `generate_object()` returns an answer validated against your JSON Schema, `generate_text()` a plain text one, and the admin API gives you the transcripts.

agent-runtime is a REST harness for a [pi](https://github.com/earendil-works/pi)-based agent on Ollama: it runs the agent with `bash`, `read_file` and `provide_answer` tools in an isolated workspace and returns an answer that matches a JSON schema. This package is the Python counterpart of [agent-runtime-sdk](https://www.npmjs.com/package/agent-runtime-sdk) for Node.js: the same `generate_object()` / `generate_text()` pair, the same error model, the same admin API.

## Features

- `generate_object()`: the answer as a `dict`, validated on the client with a port of the server's own validator; a mismatch runs the inference again
- `generate_text()`: plain text answers from the same agent
- `inference()` / `text()`: the full typed response (`status` is `"success"` or `"error"`) without raising
- `generate_object_async()`, `generate_text_async()` and `AsyncAgentRuntimeClient` for `asyncio` code
- `AgentRuntimeError` with the server's error code, per-attempt details and inference id
- Admin API: list and search inferences, read transcripts, download attachments, delete runs
- Zero dependencies, Python 3.9+, `urllib` underneath; the HTTP layer is replaceable for tests
- `format` is a full JSON Schema (draft 2020-12), enforced server-side by ajv

## Installation

```bash
pip install agent-runtime-client
```

Run the server first (see the [agent-runtime README](https://github.com/tripolskypetr/agent-runtime#quick-start-docker)):

```bash
docker run -p 10050:10050 -e OLLAMA_API_KEY=... tripolskypetr/agent-runtime
```

## Quick start

```python
from agent_runtime_client import encode_file, generate_object

report = generate_object(
    [{"role": "user", "content": "sales.csv is in your working directory. Total the amount column and name the top city."}],
    {
        "type": "object",
        "required": ["total", "topCity"],
        "properties": {
            "total": {"type": "number", "description": "Sum of the amount column"},
            "topCity": {"type": "string", "enum": ["Berlin", "Paris"], "description": "City with the largest amount"},
            "note": {"type": "string", "description": "Optional remark"},
        },
    },
    files=[encode_file("sales.csv", "city,amount\nBerlin,120.5\nParis,340.25")],
)

report["total"]    # 460.75
report["topCity"]  # "Paris"
report.get("note") # None unless the model filled it
```

The standalone functions create a client per call. Without `base_url` they talk to `AGENT_RUNTIME_URL` or `http://localhost:10050`:

```python
from agent_runtime_client import generate_text

summary = generate_text(
    [{"role": "user", "content": "Summarise notes.txt"}],
    files=[encode_file("notes.txt", notes)],
    base_url="http://agent-runtime:10050",
    headers={"x-token": "…"},
    timeout=600,
)
```

Keyword arguments: `files`, `model`, `instructions`, `base_url`, `headers`, `timeout` (seconds, `None` waits as long as the inference takes), `validate_answer`, `max_attempts`, `transport`.

For many calls against one server, or for the admin API, keep a client:

```python
from agent_runtime_client import create_client

client = create_client("http://localhost:10050")
report = client.generate_object(messages, format)
```

## Async

Every function and client method has an `async` twin with the same arguments: `generate_object_async`, `generate_text_async`, `inference_async`, `text_async` and `AsyncAgentRuntimeClient`.

```python
import asyncio

from agent_runtime_client import AsyncAgentRuntimeClient, generate_text_async

async def main():
    async with AsyncAgentRuntimeClient("http://localhost:10050") as client:
        health, summary = await asyncio.gather(
            client.health(),
            generate_text_async([{"role": "user", "content": "Summarise notes.txt"}], files=[encode_file("notes.txt", notes)]),
        )

asyncio.run(main())
```

The request itself is still the blocking `urllib` call, awaited in a worker thread through `asyncio.to_thread`; the event loop keeps running while an inference takes its minutes. Two limits follow: each call in flight occupies a thread of the default executor, and cancelling the task does not abort the request, the thread finishes it in the background and the server keeps running the inference. `AsyncAgentRuntimeClient.sync` is the underlying synchronous client.

## Images

Images go into `messages[].images` as base64; the server shows them to the model in user messages and stores them in the history. They are not written to the workspace: to process a picture with bash or `read_file`, pass it in `files`.

```python
from agent_runtime_client import generate_object, user_message

answer = generate_object(
    [user_message("Describe the chart", [open("chart.png", "rb").read()])],
    {"type": "object", "required": ["trend"], "properties": {"trend": {"type": "string", "enum": ["up", "down", "flat"]}}},
)
```

Records of a `wwwroot.jsonl` file (`{"role", "content", "images"}`) can be passed as `messages` directly.

## Client-side validation and retries

The package ships a port of the server's answer validator ([validation.py](https://github.com/tripolskypetr/agent-runtime/blob/master/packages/python-sdk/src/agent_runtime_client/validation.py): a dependency-free JSON Schema checker with the same messages as the TypeScript original; its tests pin them against the shared fixtures). The client runs it on every successful answer, and when the answer does not match `format` it runs the inference again, up to `max_attempts` (3) times in total, then fails with `schema_mismatch` and one detail line per rejected inference. This should never trigger against a current server, which validates with the same logic; it is the client's guarantee that the value you get really matches the schema.

```python
client = create_client(validate_answer=True, max_attempts=3)  # defaults
generate_object(messages, format, validate_answer=False)      # trust the server, no retries
```

The validator is also exported for answers that come from somewhere else, e.g. a cache on disk after a schema change:

```python
from agent_runtime_client import assert_answer, validate_answer

result = validate_answer(json.loads(cached), Agent1Format)
if result.success:
    result.data["verdict"]
else:
    print(result.error)  # 'Invalid arguments: signal.direction: must be exactly "long"'

answer = assert_answer(json.loads(cached), Agent1Format)  # raises ValueError instead
```

Supported keywords: `type` (string or list, `null` included), `enum`, `const`, `oneOf` / `anyOf` / `allOf` / `not`, `if` / `then` / `else`, local `$ref`, `properties` / `required` / `additionalProperties` / `patternProperties` / `propertyNames` / `dependentRequired` / `dependentSchemas` / `minProperties` / `maxProperties`, `items` / `prefixItems` / `contains` / `uniqueItems` / `minItems` / `maxItems`, `minLength` / `maxLength` / `pattern`, `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `multipleOf`. `format` and unknown keywords are ignored, so the client is never stricter than the server. `pattern` is matched with Python's `re`; a pattern it cannot compile, such as `\p{L}` classes, is skipped unless the optional `regex` package is installed: `pip install agent-runtime-client[unicode]`.

## Responses and errors

`generate_object()` and `generate_text()` raise `AgentRuntimeError` when the agent fails. `inference()` and `text()` return the typed response instead:

```python
from agent_runtime_client import inference

response = inference(messages, format)
if response["status"] == "success":
    response["data"]            # the answer
    response["turns"]           # model calls
else:
    response["error"]["code"]    # "schema_mismatch" | "empty_answer" | "max_turns" | "timeout" | "provider_error" | "internal_error"
    response["error"]["details"] # one line per failed attempt
    response["id"]               # look the transcript up in the admin UI
```

```python
from agent_runtime_client import AgentRuntimeError, generate_object

try:
    generate_object(messages, format)
except AgentRuntimeError as error:
    error.status        # HTTP status, 0 for network failures
    error.code          # InferenceErrorCode ("invalid_format" for a rejected schema) or None for other HTTP errors
    error.details       # per-attempt details
    error.inference_id  # id of the stored run
```

The server rejects a schema that does not compile (a `$ref` to a missing `$defs` entry) with HTTP 400 and `error.code = "invalid_format"`; no inference is recorded.

## Admin API

```python
listed = client.list_inferences(status="error", mode="object", limit=20)
found = client.list_inferences(q="Hilda")                       # case-insensitive substring search
record = client.get_inference(listed["items"][0]["id"])          # request, transcript, result/error, attachments
file = client.get_attachment(record["id"], record["attachments"][0]["id"])  # {...meta, "data": bytes}
client.delete_inference(record["id"])
client.health()
```

## Long inferences

An inference can run for minutes. The default `timeout` is `None`, so the client waits as long as the server takes; set `timeout` in seconds to bound a call. The HTTP layer is a plain function and can be replaced, for a `requests` session or a mock in tests:

```python
def transport(method, url, headers, body, timeout):
    response = session.request(method, url, headers=headers, data=body, timeout=timeout)
    return response.status_code, dict(response.headers), response.content

client = create_client(transport=transport)
```

## API

Standalone functions (create the client internally):

| Function | Returns |
|----------|---------|
| `generate_object(messages, format, **kw)` | `dict` |
| `generate_text(messages, **kw)` | `str` |
| `inference(messages, format, **kw)` | `InferenceResponse` |
| `text(messages, **kw)` | `TextResponse` |
| `generate_object_async`, `generate_text_async`, `inference_async`, `text_async` | the same, awaitable |

Client:

| Method | Returns |
|--------|---------|
| `create_client(base_url=None, **options)` / `AgentRuntimeClient(...)` | options: `headers`, `timeout`, `validate_answer` (True), `max_attempts` (3), `transport` |
| `create_async_client(...)` / `AsyncAgentRuntimeClient(...)` | the same methods as coroutines, usable as `async with` |
| `generate_object(messages, format, *, files, model, instructions, headers, timeout)` | `dict` |
| `generate_text(messages, *, ...)` | `str` |
| `inference(...)` / `text(...)` | typed response |
| `health()` | `Health` |
| `list_inferences(*, limit, offset, status, mode, q)` | `{"total", "items"}` |
| `get_inference(id)` | `InferenceRecord` |
| `get_attachment(id, attachment_id)` | `Attachment` with `data: bytes` |
| `delete_inference(id)` | `{"ok": bool}` |
| `validate_answer(value, format)`, `assert_answer(value, format)` | client-side validation |
| `validate_tool_arguments(value, format)`, `validate_value(value, schema, path)` | the raw validator |
| `encode_file(name, bytes_or_str)`, `encode_image(bytes)`, `user_message(text, images=None)` | request helpers |

The response shapes are `TypedDict`s in `agent_runtime_client.models`.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install build twine
.venv/bin/python -m unittest discover -s tests -v                              # validator and client, no server
BASE_URL=http://localhost:10151 .venv/bin/python -m unittest tests.test_runtime -v  # against a test server
.venv/bin/python -m build && .venv/bin/twine check dist/*
```

## License

MIT
