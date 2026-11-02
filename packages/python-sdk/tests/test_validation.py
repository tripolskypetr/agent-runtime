"""Validator parity with the server: the cases of demo/schema.test.ts with the same expected messages."""
from __future__ import annotations

import copy
import json
import re
import unittest
from pathlib import Path

from agent_runtime_client import assert_answer, validate_answer, validate_tool_arguments, validate_value

FIXTURES = Path(__file__).resolve().parents[3] / "demo" / "fixtures"


def load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def kw(schema):
    return {"type": "object", "required": ["v"], "properties": {"v": schema}}


@unittest.skipUnless(FIXTURES.exists(), "demo/fixtures of the agent-runtime repository are not available")
class AgentSchemasTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agent1 = load("agent1.schema.json")
        cls.agent2 = load("agent2.schema.json")
        cls.agent3 = load("agent3.schema.json")
        cls.fixture_a = load("agent1.fixture-a.json")
        cls.fixture_b = load("agent1.fixture-b.json")
        cls.fixture_c = load("agent1.fixture-c.json")
        cls.good_signal = {
            "direction": "long",
            "asset": "BTC",
            "based_on_claim_ids": ["c2"],
            "entry": {"feature": "last_price", "op": "gt", "value": 82500},
            "invalidation": {"feature": "last_price", "op": "lt", "value": 80684},
            "hard_stop": {"mode": "atr_multiple", "value": 2},
            "max_holding_periods": 6,
            "ttl_hours": 24,
            "confidence": "medium",
            "rationale": "Уровень $82 500 назван в статье ключевым для краткосрочных сценариев.",
        }

    def with_signal(self, signal, verdict="forecast_expressible"):
        return {**self.fixture_b, "verdict": verdict, "signal": signal}

    def reject(self, schema, value, expected):
        result = validate_tool_arguments(value, schema)
        self.assertFalse(result.success, f"expected a rejection, got success for {json.dumps(value)[:120]}")
        self.assertRegex(result.error or "", expected)

    def test_fixtures_valid(self):
        for fixture in (self.fixture_a, self.fixture_b, self.fixture_c):
            result = validate_tool_arguments(fixture, self.agent1)
            self.assertTrue(result.success, result.error)

    def test_valid_signal_accepted(self):
        result = validate_tool_arguments(self.with_signal(self.good_signal), self.agent1)
        self.assertTrue(result.success, result.error)

    def test_keyword_messages(self):
        a1, s = self.agent1, self.good_signal
        self.reject(a1, self.with_signal({**s, "direction": "short"}), r'^Invalid arguments: signal\.direction: must be exactly "long"$')
        self.reject(a1, {**self.fixture_a, "extra": 1}, r'answer: has unexpected property "extra"')
        self.reject(a1, {**self.fixture_a, "claims": [{**self.fixture_a["claims"][0], "id": "claim-1"}]}, r"claims\[0\]\.id: must match pattern")
        self.reject(a1, self.with_signal({**s, "rationale": "short"}), r"^Invalid arguments: signal\.rationale: must NOT have fewer than 20 characters$")
        self.reject(a1, self.with_signal({**s, "based_on_claim_ids": ["c1", "c2", "c3", "c4", "c5"]}), r"^Invalid arguments: signal\.based_on_claim_ids: must NOT have more than 4 items$")
        self.reject(a1, {**self.fixture_a, "article": {**self.fixture_a["article"], "published_at": 5}}, r"article\.published_at: must be string or null")
        self.reject(
            a1,
            self.with_signal("none"),
            r'^Invalid arguments: signal: must be null or object with required "direction", "asset", "based_on_claim_ids", "entry", "invalidation", "hard_stop", "max_holding_periods", "ttl_hours", "confidence", "rationale", got string$',
        )
        self.reject(a1, self.with_signal({**s, "entry": {"feature": "last_price", "op": "gt", "value": "84900"}}), r'^Invalid arguments: signal\.entry\.value: must be number or object with required "feature", got string$')
        self.reject(a1, self.with_signal({**s, "based_on_claim_ids": "c1"}), r"^Invalid arguments: signal\.based_on_claim_ids: must be array of string, got string$")
        self.reject(a1, self.with_signal({**s, "hard_stop": {"value": 2}}), r'^Invalid arguments: signal\.hard_stop: is missing required property "mode"$')
        without_rationale = {key: value for key, value in s.items() if key != "rationale"}
        self.reject(a1, self.with_signal(without_rationale), r'^Invalid arguments: signal: is missing required property "rationale"$')
        self.reject(a1, self.with_signal({**s, "ttl_hours": "24"}), r"^Invalid arguments: signal\.ttl_hours: must be number, got string$")
        self.reject(a1, self.with_signal(s, "summary_only"), r'^Invalid arguments: signal: must be null, got object \(rule: when verdict is one of \["summary_only","forecast_not_expressible"\]\)$')
        self.reject(a1, self.with_signal(None, "forecast_expressible"), r'^Invalid arguments: signal: must be object, got null \(rule: when verdict is "forecast_expressible"\)$')
        self.reject(a1, self.with_signal({**s, "entry": {"feature": "rsi_14", "op": "gt", "value": 1}}), r'^Invalid arguments: signal\.entry\.feature: must be one of \["last_price"')
        self.reject(a1, self.with_signal({**s, "hard_stop": {"mode": "percent", "value": 0}}), r"^Invalid arguments: signal\.hard_stop\.value: must be > 0$")

    def test_nullable(self):
        self.assertTrue(validate_tool_arguments({**self.fixture_a, "article": {**self.fixture_a["article"], "published_at": "null"}}, self.agent1).success)
        self.assertTrue(validate_tool_arguments({**self.fixture_a, "article": {**self.fixture_a["article"], "published_at": None}}, self.agent1).success)

    def test_agent2_and_agent3_conditionals(self):
        self.reject(
            self.agent2,
            {"schema_version": "1.0.0", "evaluated_at": "x", "signal_id": "s", "precondition_checks": {"bars_available": 1, "minutes_since_window_end": 0, "no_open_position": True, "signal_not_expired": True, "features_sane": True}, "entry_predicate_echo": {"value": True, "leaf_results": []}, "decision": {"action": "hold_flat", "veto_reason": "bored", "notes": ""}},
            r"decision\.veto_reason: must be one of",
        )
        position = {"signal_id": "s", "opened_at": "x", "entry_price": 1, "last_price": 1, "unrealized_pct": 0, "periods_held": 0, "max_holding_periods": 1, "exchange_stop_order_id": None}
        checks = {"hard_stop_hit": True, "time_stop_hit": False, "invalidation_result": False, "entry_condition_still_true": False, "leaf_results": []}
        self.reject(
            self.agent3,
            {"schema_version": "1.0.0", "evaluated_at": "x", "position": position, "exit_checks": checks, "decision": {"action": "close", "reason": "none", "notes": ""}},
            r'^Invalid arguments: decision\.reason: must be one of \["hard_stop","time_stop","invalidation"\] \(rule: when decision\.action is "close"\)$',
        )
        self.reject(
            self.agent3,
            {"schema_version": "1.0.0", "evaluated_at": "x", "position": position, "exit_checks": checks, "decision": {"action": "hold", "reason": "none", "notes": ""}},
            r'^Invalid arguments: decision\.action: must be exactly "close" \(rule: when \(exit_checks\.hard_stop_hit is true or exit_checks\.time_stop_hit is true or exit_checks\.invalidation_result is true\)\)$',
        )

    def test_recursive_predicate(self):
        deep = {"all": [{"feature": "last_price", "op": "gt", "value": 82500}, {"any": [{"not": {"feature": "ret_60m_pct", "op": "lt", "value": {"feature": "atr_14_pct"}}}, {"feature": "volume_ratio_60_180", "op": "gte", "value": 1.5}]}]}
        result = validate_tool_arguments(self.with_signal({**self.good_signal, "entry": deep}), self.agent1)
        self.assertTrue(result.success, result.error)
        self.reject(self.agent1, self.with_signal({**self.good_signal, "entry": {"all": [{"any": [{"not": {"feature": "last_price", "op": "equals", "value": 1}}]}]}}), r"^Invalid arguments: signal\.entry\.all\[0\]\.any\[0\]\.not\.op: must be one of")

    def test_one_problem_per_call(self):
        broken = {**self.fixture_a, "verdict": "nope", "claims": [{**self.fixture_a["claims"][0], "id": "bad", "kind": "x"}], "extra": 1, "more": 2}
        result = validate_tool_arguments(broken, self.agent1)
        self.assertFalse(result.success)
        self.assertNotIn("; ", result.error or "")

    def test_typed_helpers(self):
        self.assertTrue(validate_answer(self.fixture_c, self.agent1).success)
        self.assertIs(assert_answer(self.fixture_c, self.agent1), self.fixture_c)
        with self.assertRaisesRegex(ValueError, r"verdict: must be one of"):
            assert_answer({**self.fixture_c, "verdict": "x"}, self.agent1)
        tampered = copy.deepcopy(self.fixture_c)
        tampered["signal"]["direction"] = "short"
        self.assertRegex(validate_answer(tampered, self.agent1).error or "", r'signal\.direction: must be exactly "long"')


class KeywordsTest(unittest.TestCase):
    """Keywords beyond the agent schemas; expected results as in demo/schema.test.ts."""

    CASES = [
        ("anyOf number|string", kw({"anyOf": [{"type": "number"}, {"type": "string"}]}), {"v": "x"}, True),
        ("anyOf none match", kw({"anyOf": [{"type": "number"}, {"type": "string"}]}), {"v": True}, False),
        ("oneOf of consts", kw({"oneOf": [{"const": "a"}, {"const": "b"}]}), {"v": "c"}, False),
        ("not", kw({"not": {"const": "no"}}), {"v": "no"}, False),
        ("if/else", kw({"type": "object", "properties": {"a": {"type": "integer"}}, "if": {"properties": {"a": {"const": 1}}, "required": ["a"]}, "then": {"required": ["b"]}, "else": {"required": ["c"]}}), {"v": {"a": 2, "c": 1}}, True),
        ("if/else fails", kw({"type": "object", "properties": {"a": {"type": "integer"}}, "if": {"properties": {"a": {"const": 1}}, "required": ["a"]}, "then": {"required": ["b"]}, "else": {"required": ["c"]}}), {"v": {"a": 2}}, False),
        ("pattern unicode", kw({"type": "string", "pattern": r"^\p{L}+$"}), {"v": "Привет"}, True),
        ("pattern ascii rejects", kw({"type": "string", "pattern": "^[a-z]+$"}), {"v": "abc1"}, False),
        ("minimum", kw({"type": "number", "minimum": 1}), {"v": 0.5}, False),
        ("multipleOf", kw({"type": "number", "multipleOf": 0.5}), {"v": 2.5}, True),
        ("multipleOf fails", kw({"type": "integer", "multipleOf": 3}), {"v": 10}, False),
        ("uniqueItems", kw({"type": "array", "uniqueItems": True, "items": {"type": "object"}}), {"v": [{"a": 1}, {"a": 1}]}, False),
        ("prefixItems + items false", kw({"type": "array", "prefixItems": [{"type": "string"}, {"type": "number"}], "items": False}), {"v": ["a", 1, 2]}, False),
        ("prefixItems ok", kw({"type": "array", "prefixItems": [{"type": "string"}, {"type": "number"}], "items": False}), {"v": ["a", 1]}, True),
        ("contains minContains", kw({"type": "array", "contains": {"type": "number"}, "minContains": 2}), {"v": [1, "a"]}, False),
        ("patternProperties allowed", kw({"type": "object", "patternProperties": {"^x_": {"type": "number"}}, "additionalProperties": False}), {"v": {"x_1": 1}}, True),
        ("patternProperties value type", kw({"type": "object", "patternProperties": {"^x_": {"type": "number"}}, "additionalProperties": False}), {"v": {"x_1": "s"}}, False),
        ("additionalProperties schema", kw({"type": "object", "additionalProperties": {"type": "boolean"}}), {"v": {"any": 1}}, False),
        ("propertyNames", kw({"type": "object", "propertyNames": {"pattern": "^[a-z]+$"}}), {"v": {"Bad": 1}}, False),
        ("dependentRequired", kw({"type": "object", "dependentRequired": {"a": ["b"]}}), {"v": {"a": 1}}, False),
        ("dependentSchemas", kw({"type": "object", "dependentSchemas": {"a": {"required": ["b"]}}}), {"v": {"a": 1, "b": 2}}, True),
        ("minProperties", kw({"type": "object", "minProperties": 2}), {"v": {"a": 1}}, False),
        ("type array with null", kw({"type": ["integer", "null"]}), {"v": None}, True),
        ("integer rejects 1.5", kw({"type": ["integer", "null"]}), {"v": 1.5}, False),
        ("integer accepts 2.0", kw({"type": "integer"}), {"v": 2.0}, True),
        ("boolean is not a number", kw({"type": "number"}), {"v": True}, False),
        ("enum of objects", kw({"enum": [{"a": 1}, [1, 2]]}), {"v": [1, 2]}, True),
        ("enum: 1 is not true", kw({"enum": [True]}), {"v": 1}, False),
        ("const object", kw({"const": {"a": [1, {"b": None}]}}), {"v": {"a": [1, {"b": None}]}}, True),
        ("const object differs", kw({"const": {"a": [1, {"b": None}]}}), {"v": {"a": [1, {"b": 0}]}}, False),
        ("$ref to properties pointer", {"type": "object", "required": ["v", "w"], "properties": {"v": {"type": "string", "enum": ["a"]}, "w": {"$ref": "#/properties/v"}}}, {"v": "a", "w": "b"}, False),
        ("$ref with sibling keywords", kw({"$ref": "#/properties/v/$defs/s", "maxLength": 2, "$defs": {"s": {"type": "string"}}}), {"v": "abc"}, False),
        ("minLength counts code points", kw({"type": "string", "minLength": 2}), {"v": "😀😀"}, True),
        ("format ignored", kw({"type": "string", "format": "date-time"}), {"v": "2026-10-30T10:00:00Z"}, True),
    ]

    def test_cases(self):
        for name, schema, value, expected in self.CASES:
            with self.subTest(name):
                result = validate_tool_arguments(value, schema)
                self.assertEqual(result.success, expected, result.error)

    def test_messages(self):
        schema = kw({"type": "object", "properties": {"a": {"type": "integer"}}, "if": {"properties": {"a": {"const": 1}}, "required": ["a"]}, "then": {"required": ["b"]}, "else": {"required": ["c"]}})
        self.assertRegex(validate_tool_arguments({"v": {"a": 2}}, schema).error or "", r'v: is missing required property "c" \(rule: unless v\.a is 1\)$')
        self.assertEqual(validate_tool_arguments({"v": "c"}, kw({"oneOf": [{"const": "a"}, {"const": "b"}]})).error, 'Invalid arguments: v: must be one of ["a","b"]')
        self.assertEqual(validate_tool_arguments({"v": True}, kw({"anyOf": [{"type": "number"}, {"type": "string"}]})).error, "Invalid arguments: v: must be number or string, got boolean")
        self.assertEqual(validate_tool_arguments({"v": 2.5}, kw({"type": "number", "maximum": 2.0})).error, "Invalid arguments: v: must be <= 2")
        self.assertEqual(validate_tool_arguments({"v": [1, 1]}, kw({"type": "array", "uniqueItems": True})).error, "Invalid arguments: v: must NOT have duplicate items (items 0 and 1 are identical)")
        self.assertEqual(validate_tool_arguments({"v": {"Bad": 1}}, kw({"type": "object", "propertyNames": {"pattern": "^[a-z]+$"}})).error, 'Invalid arguments: v: property name "Bad" is not allowed (must match pattern ^[a-z]+$)')
        self.assertEqual(validate_tool_arguments({"v": {"a": 1}}, kw({"type": "object", "dependentRequired": {"a": ["b", "c"]}})).error, 'Invalid arguments: v: must have "b", "c" when "a" is present')
        self.assertIn("unresolvable $ref", validate_value({"v": 1}, {"type": "object", "properties": {"v": {"$ref": "#/$defs/nope"}}}, "answer") or "")

    def test_root_shapes(self):
        self.assertEqual(validate_tool_arguments(None, kw({"type": "string"})).error, "Tool call has empty arguments")
        self.assertTrue(validate_tool_arguments(None, {"type": "object", "properties": {}}).success)
        self.assertEqual(validate_tool_arguments([1], kw({"type": "string"})).error, "Invalid arguments: expected object, got array")
        self.assertEqual(validate_tool_arguments({}, kw({"type": "string"})).error, 'Invalid arguments: answer: is missing required property "v"')
        self.assertEqual(validate_tool_arguments({}, {"type": "object", "required": ["a", "b"], "properties": {}}).error, 'Invalid arguments: answer: is missing required properties "a", "b"')


if __name__ == "__main__":
    unittest.main()
