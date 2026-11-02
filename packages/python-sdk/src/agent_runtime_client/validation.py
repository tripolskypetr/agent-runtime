"""Answer validator, a port of the one shared by the agent-runtime server and agent-runtime-sdk.

The source of truth is ``src/validation/validateToolArguments.ts`` in the agent-runtime
repository (the same file byte for byte in ``packages/node-sdk``). This module mirrors its
logic and its messages so that a Python client rejects exactly what the server rejects:
JSON Schema draft 2020-12 with ``type`` as string or list (incl. ``"null"``), ``enum``/``const``
of any JSON value, ``oneOf``/``anyOf``/``allOf``/``not``, ``if``/``then``/``else``, local ``$ref``
(JSON pointer into the root, e.g. ``#/$defs/predicate``), ``additionalProperties``,
``patternProperties``, ``propertyNames``, ``dependentRequired``/``dependentSchemas``,
``minProperties``/``maxProperties``, ``items``/``prefixItems``/``contains``/``uniqueItems``,
``minItems``/``maxItems``, ``minLength``/``maxLength``/``pattern``, ``minimum``/``maximum``/
``exclusiveMinimum``/``exclusiveMaximum``/``multipleOf``. Unknown keywords and ``format`` are
ignored, so it is never stricter than the server's ajv check. No dependencies.

One error is reported, as a dotted path from the root ``answer``::

    signal.direction: must be exactly "long"
    claims[0].id: must match pattern ^c[0-9]{1,2}$

``pattern`` uses Python's ``re``; a pattern it cannot compile (``\\p{L}`` classes, for example)
is skipped unless the optional ``regex`` package is installed (``pip install agent-runtime-client[unicode]``).
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Pattern
from urllib.parse import unquote

try:  # the optional `regex` package understands JavaScript-style \p{...} classes
    import regex as _regex  # type: ignore
except ImportError:  # pragma: no cover
    _regex = None

ROOT_PATH = "answer"

_UNDEFINED = object()
"""Stands in for JavaScript's ``undefined`` where ``None`` would mean JSON ``null``."""


@dataclass
class ValidationResult:
    success: bool
    data: Any = None
    error: Optional[str] = None


def type_of(value: Any) -> str:
    """JSON type name of a value, as the error messages report it."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _js(value: Any) -> Any:
    """Shapes a value the way JSON.stringify prints it: integral floats without ".0", non-finite numbers as null."""
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value) if value.is_integer() else value
    if isinstance(value, list):
        return [_js(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _js(item) for key, item in value.items()}
    return value


def _show(value: Any) -> str:
    return json.dumps(_js(value), separators=(",", ":"), ensure_ascii=False)


def _num(value: Any) -> str:
    """A number in a message, printed as JavaScript prints it."""
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return str(int(value))
    return str(value)


def _join(path: str, key: str) -> str:
    return key if path == ROOT_PATH else f"{path}.{key}"


def _at(path: str, index: int) -> str:
    return f"{path}[{index}]"


def _head(error: str) -> str:
    index = error.find(":")
    return error[:index] if index >= 0 else error[:-1]


_TYPE_MISMATCH = re.compile(
    r": must be (?:[a-z]+(?: with required [^,]+(?:, [^,]+)*| of [a-z ]+)?)(?: or [a-z]+(?: with required [^,]+(?:, [^,]+)*| of [a-z ]+)?)*, got [a-z]+$"
)


def _is_type_mismatch(error: str) -> bool:
    return _TYPE_MISMATCH.search(error) is not None


def _rank_of(error: str) -> int:
    """Rank of a branch error of a oneOf/anyOf, higher is more specific: deeper path first; on equal
    depth a branch that matched the value's type but failed inside it beats a branch that did not."""
    depth = len(re.findall(r"[.\[]", _head(error)))
    return depth * 2 + (0 if _is_type_mismatch(error) else 1)


def _branch_error(errors: List[str], path: str) -> str:
    """One message for a failed oneOf/anyOf at ``path``: the deepest branch error when some branch
    matched the value's shape, otherwise the alternatives merged into one line."""
    prefix = f"{path}: "
    content = [error for error in errors if not (_is_type_mismatch(error) and _head(error) == path)]
    pool = content if content else errors
    at_root = all(_head(error) == path for error in pool)
    if not at_root:
        best = pool[0] if pool else "does not match the schema"
        for error in pool:
            if _rank_of(error) > _rank_of(best):
                best = error
        return best
    messages: List[str] = []
    for error in pool:
        message = error[len(prefix):]
        if message not in messages:
            messages.append(message)
    types: List[str] = []
    values: List[str] = []
    others: List[str] = []
    got = ""
    for message in messages:
        type_match = re.fullmatch(r"must be (.+), got ([a-z]+)", message)
        exact = re.fullmatch(r"must be exactly (.+)", message)
        one_of = re.fullmatch(r"must be one of \[(.+)\]", message)
        if type_match:
            for name in type_match.group(1).split(" or "):
                if name not in types:
                    types.append(name)
            got = type_match.group(2)
        elif exact:
            values.append(exact.group(1))
        elif one_of:
            values.append(one_of.group(1))
        else:
            others.append(message)
    parts: List[str] = []
    if types:
        parts.append(f"must be {' or '.join(types)}, got {got}")
    if values:
        parts.append(f"must be one of [{','.join(values)}]")
    parts.extend(others)
    return f"{path}: {'; or '.join(parts)}"


def _deep_equal(a: Any, b: Any) -> bool:
    kind = type_of(a)
    if kind != type_of(b):
        return False
    if kind == "null":
        return True
    if kind == "array":
        return len(a) == len(b) and all(_deep_equal(x, y) for x, y in zip(a, b))
    if kind == "object":
        return len(a) == len(b) and all(key in b and _deep_equal(a[key], b[key]) for key in a)
    return a == b


def _matches_type(value: Any, name: str) -> bool:
    if name == "string":
        return isinstance(value, str)
    if name == "number":
        return _is_number(value) and math.isfinite(value)
    if name == "integer":
        return _is_number(value) and math.isfinite(value) and float(value).is_integer()
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    if name == "array":
        return isinstance(value, list)
    if name == "object":
        return isinstance(value, dict)
    return True  # unknown type name: do not reject, the server decides


def _describe_type(name: str, node: Dict[str, Any]) -> str:
    """``object`` alone says nothing about the shape: name its required properties; for arrays the item type."""
    required = node.get("required")
    if name == "object" and isinstance(required, list) and required:
        return "object with required " + ", ".join(_show(key) for key in required)
    items = node.get("items")
    if name == "array" and isinstance(items, dict) and items.get("type") is not None:
        item_type = items["type"]
        return "array of " + (" or ".join(item_type) if isinstance(item_type, list) else str(item_type))
    return name


_regex_cache: Dict[str, Optional[Pattern[str]]] = {}


def _to_regexp(pattern: str) -> Optional[Pattern[str]]:
    if pattern in _regex_cache:
        return _regex_cache[pattern]
    compiled: Optional[Pattern[str]] = None
    try:
        compiled = re.compile(pattern)
    except re.error:
        if _regex is not None:
            try:
                compiled = _regex.compile(pattern)
            except Exception:  # pragma: no cover
                compiled = None
    _regex_cache[pattern] = compiled
    return compiled


def resolve_ref(root: Any, ref: str) -> Any:
    """Resolves a local JSON pointer reference (``#/$defs/name``, ``#/properties/x``) against the root schema.
    Returns the sentinel ``_UNDEFINED`` when the reference does not resolve."""
    if not ref.startswith("#"):
        return _UNDEFINED
    segments = [unquote(segment).replace("~1", "/").replace("~0", "~") for segment in ref[1:].split("/") if segment]
    node: Any = root
    for segment in segments:
        if isinstance(node, dict):
            node = node.get(segment, _UNDEFINED)
        elif isinstance(node, list) and segment.isdigit() and int(segment) < len(node):
            node = node[int(segment)]
        else:
            return _UNDEFINED
        if node is _UNDEFINED:
            return _UNDEFINED
    return node


def validate_value(value: Any, schema: Any, path: str, root: Any = _UNDEFINED) -> Optional[str]:
    """Validates ``value`` against ``schema``; returns the first problem as ``path: message`` or None.
    ``root`` is the schema that ``$ref``s are resolved against (defaults to ``schema``)."""
    if root is _UNDEFINED:
        root = schema
    if schema is True or schema is _UNDEFINED or schema is None:
        return None
    if schema is False:
        return f"{path}: is not allowed"
    if not isinstance(schema, dict):
        return None
    node = schema

    ref = node.get("$ref")
    if isinstance(ref, str):
        target = resolve_ref(root, ref)
        if target is _UNDEFINED:
            return f"{path}: schema error, unresolvable $ref {ref}"
        error = validate_value(value, target, path, root)
        if error:
            return error

    if node.get("type") is not None:
        types = node["type"] if isinstance(node["type"], list) else [node["type"]]
        if not any(_matches_type(value, name) for name in types):
            return f"{path}: must be {' or '.join(_describe_type(name, node) for name in types)}, got {type_of(value)}"
    if "const" in node and not _deep_equal(value, node["const"]):
        return f"{path}: must be exactly {_show(node['const'])}"
    enum = node.get("enum")
    if isinstance(enum, list) and not any(_deep_equal(value, item) for item in enum):
        return f"{path}: must be one of {_show(enum)}"

    if isinstance(value, str):
        min_length = node.get("minLength")
        if _is_number(min_length) and len(value) < min_length:
            return f"{path}: must NOT have fewer than {_num(min_length)} characters"
        max_length = node.get("maxLength")
        if _is_number(max_length) and len(value) > max_length:
            return f"{path}: must NOT have more than {_num(max_length)} characters"
        pattern = node.get("pattern")
        if isinstance(pattern, str):
            compiled = _to_regexp(pattern)
            if compiled is not None and compiled.search(value) is None:
                return f"{path}: must match pattern {pattern}"

    if _is_number(value):
        minimum = node.get("minimum")
        if _is_number(minimum) and value < minimum:
            return f"{path}: must be >= {_num(minimum)}"
        maximum = node.get("maximum")
        if _is_number(maximum) and value > maximum:
            return f"{path}: must be <= {_num(maximum)}"
        exclusive_minimum = node.get("exclusiveMinimum")
        if _is_number(exclusive_minimum) and value <= exclusive_minimum:
            return f"{path}: must be > {_num(exclusive_minimum)}"
        exclusive_maximum = node.get("exclusiveMaximum")
        if _is_number(exclusive_maximum) and value >= exclusive_maximum:
            return f"{path}: must be < {_num(exclusive_maximum)}"
        multiple_of = node.get("multipleOf")
        if _is_number(multiple_of) and multiple_of > 0:
            ratio = value / multiple_of
            if not math.isfinite(ratio) or ratio != math.trunc(ratio):
                return f"{path}: must be multiple of {_num(multiple_of)}"

    if isinstance(value, list):
        min_items = node.get("minItems")
        if _is_number(min_items) and len(value) < min_items:
            return f"{path}: must NOT have fewer than {_num(min_items)} items"
        max_items = node.get("maxItems")
        if _is_number(max_items) and len(value) > max_items:
            return f"{path}: must NOT have more than {_num(max_items)} items"
        if node.get("uniqueItems") is True:
            for i in range(len(value)):
                for j in range(i + 1, len(value)):
                    if _deep_equal(value[i], value[j]):
                        return f"{path}: must NOT have duplicate items (items {i} and {j} are identical)"
        prefix = node.get("prefixItems") if isinstance(node.get("prefixItems"), list) else []
        for i in range(min(len(prefix), len(value))):
            error = validate_value(value[i], prefix[i], _at(path, i), root)
            if error:
                return error
        if "items" in node:
            for i in range(len(prefix), len(value)):
                error = validate_value(value[i], node["items"], _at(path, i), root)
                if error:
                    return error
        if "contains" in node:
            matches = sum(1 for item in value if validate_value(item, node["contains"], path, root) is None)
            min_contains = node.get("minContains") if _is_number(node.get("minContains")) else 1
            if matches < min_contains:
                return f"{path}: must contain at least {_num(min_contains)} valid item(s)"
            max_contains = node.get("maxContains")
            if _is_number(max_contains) and matches > max_contains:
                return f"{path}: must contain at most {_num(max_contains)} valid item(s)"

    if isinstance(value, dict):
        required = node.get("required")
        if isinstance(required, list):
            missing = [key for key in required if key not in value]
            if len(missing) == 1:
                return f"{path}: is missing required property {_show(missing[0])}"
            if len(missing) > 1:
                return f"{path}: is missing required properties {', '.join(_show(key) for key in missing)}"
        min_properties = node.get("minProperties")
        if _is_number(min_properties) and len(value) < min_properties:
            return f"{path}: must NOT have fewer than {_num(min_properties)} properties"
        max_properties = node.get("maxProperties")
        if _is_number(max_properties) and len(value) > max_properties:
            return f"{path}: must NOT have more than {_num(max_properties)} properties"
        properties = node.get("properties") if isinstance(node.get("properties"), dict) else {}
        patterns = []
        if isinstance(node.get("patternProperties"), dict):
            for pattern, sub in node["patternProperties"].items():
                compiled = _to_regexp(pattern)
                if compiled is not None:
                    patterns.append((compiled, sub))
        for key, item in value.items():
            covered = False
            if key in properties:
                covered = True
                error = validate_value(item, properties[key], _join(path, key), root)
                if error:
                    return error
            for compiled, sub in patterns:
                if compiled.search(key) is None:
                    continue
                covered = True
                error = validate_value(item, sub, _join(path, key), root)
                if error:
                    return error
            if not covered and "additionalProperties" in node:
                if node["additionalProperties"] is False:
                    return f"{path}: has unexpected property {_show(key)}"
                error = validate_value(item, node["additionalProperties"], _join(path, key), root)
                if error:
                    return error
            if "propertyNames" in node:
                error = validate_value(key, node["propertyNames"], _join(path, key), root)
                if error:
                    return f"{path}: property name {_show(key)} is not allowed ({error[error.find(':') + 2:]})"
        if isinstance(node.get("dependentRequired"), dict):
            for key, deps in node["dependentRequired"].items():
                if key not in value:
                    continue
                missing = [dep for dep in (deps or []) if dep not in value]
                if missing:
                    return f"{path}: must have {', '.join(_show(dep) for dep in missing)} when {_show(key)} is present"
        if isinstance(node.get("dependentSchemas"), dict):
            for key, sub in node["dependentSchemas"].items():
                if key not in value:
                    continue
                error = validate_value(value, sub, path, root)
                if error:
                    return error

    if isinstance(node.get("allOf"), list):
        for sub in node["allOf"]:
            error = validate_value(value, sub, path, root)
            if error:
                return error
    if isinstance(node.get("anyOf"), list):
        errors = [validate_value(value, sub, path, root) for sub in node["anyOf"]]
        if not any(error is None for error in errors):
            return _branch_error([error for error in errors if error is not None], path)
    if isinstance(node.get("oneOf"), list):
        errors = [validate_value(value, sub, path, root) for sub in node["oneOf"]]
        passed = sum(1 for error in errors if error is None)
        if passed == 0:
            return _branch_error([error for error in errors if error is not None], path)
        if passed > 1:
            return f"{path}: must match exactly one of the allowed shapes, matched {passed}"
    if "not" in node and validate_value(value, node["not"], path, root) is None:
        return f"{path}: must NOT match the forbidden shape"
    if "if" in node:
        holds = validate_value(value, node["if"], path, root) is None
        branch_key = "then" if holds else "else"
        if branch_key in node:
            error = validate_value(value, node[branch_key], path, root)
            # a then/else violation only makes sense together with its condition
            if error:
                return f"{error} (rule: {'when' if holds else 'unless'} {_describe_condition(node['if'], path)})"
    return None


def _describe_condition(schema: Any, path: str) -> str:
    """Human-readable form of an ``if`` schema: ``verdict is "summary_only"``, ``a.b is one of [...]``, ``(x is true or y is true)``."""
    if schema is True:
        return "always"
    if schema is False:
        return "never"
    if not isinstance(schema, dict):
        return "the condition holds"
    parts: List[str] = []
    if "const" in schema:
        parts.append(f"{path} is {_show(schema['const'])}")
    if isinstance(schema.get("enum"), list):
        parts.append(f"{path} is one of {_show(schema['enum'])}")
    if schema.get("type") is not None and "const" not in schema and not isinstance(schema.get("enum"), list):
        type_name = schema["type"]
        parts.append(f"{path} is {' or '.join(type_name) if isinstance(type_name, list) else type_name}")
    if isinstance(schema.get("properties"), dict):
        for key, sub in schema["properties"].items():
            parts.append(_describe_condition(sub, _join(path, key)))
    if isinstance(schema.get("allOf"), list):
        parts.extend(_describe_condition(sub, path) for sub in schema["allOf"])
    if isinstance(schema.get("anyOf"), list):
        parts.append("(" + " or ".join(_describe_condition(sub, path) for sub in schema["anyOf"]) + ")")
    if isinstance(schema.get("oneOf"), list):
        parts.append("(exactly one of: " + ", ".join(_describe_condition(sub, path) for sub in schema["oneOf"]) + ")")
    if "not" in schema:
        parts.append(f"not ({_describe_condition(schema['not'], path)})")
    if isinstance(schema.get("$ref"), str):
        parts.append(f"{path} matches {schema['$ref']}")
    return " and ".join(parts) if parts else f"{path} matches {_show(schema)[:120]}"


def validate_tool_arguments(parsed_arguments: Any, schema: Dict[str, Any]) -> ValidationResult:
    """Validates an answer (the ``provide_answer`` arguments) against the ``format`` schema."""
    if parsed_arguments is None:
        if isinstance(schema, dict) and schema.get("required"):
            return ValidationResult(False, error="Tool call has empty arguments")
        return ValidationResult(True, data={})
    if not isinstance(parsed_arguments, dict):
        return ValidationResult(False, error=f"Invalid arguments: expected object, got {type_of(parsed_arguments)}")
    error = validate_value(parsed_arguments, schema, ROOT_PATH, schema)
    if error:
        return ValidationResult(False, error=f"Invalid arguments: {error}")
    return ValidationResult(True, data=parsed_arguments)


def validate_answer(value: Any, format: Dict[str, Any]) -> ValidationResult:
    """Checks an answer (from the server, a cache on disk, anywhere) against its schema."""
    return validate_tool_arguments(value, format)


def assert_answer(value: Any, format: Dict[str, Any]) -> Dict[str, Any]:
    """Raises ``ValueError`` when the answer does not match the schema; returns it otherwise."""
    result = validate_answer(value, format)
    if not result.success:
        raise ValueError(result.error or "Invalid answer")
    return result.data
