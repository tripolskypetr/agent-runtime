"""Runtime test against a running agent-runtime. Opt in with BASE_URL, there is no default: a
server on the default port may be a production one with real history."""
from __future__ import annotations

import os
import unittest

from agent_runtime_client import AgentRuntimeError, create_client, encode_file, generate_object, generate_text

BASE_URL = os.environ.get("BASE_URL")


@unittest.skipUnless(BASE_URL, "set BASE_URL=http://host:port of a test agent-runtime to run")
class RuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_client(BASE_URL)
        cls.csv = "\n".join(["city,amount", "Berlin,120.5", "Paris,340.25", "Madrid,99", "Rome,210"])
        cls.csv_answer = None

    @classmethod
    def csv_run(cls):
        """One inference over sales.csv, shared by the tests that need a stored run (unittest runs them alphabetically)."""
        if cls.csv_answer is None:
            cls.csv_answer = cls.client.generate_object(
                [{"role": "user", "content": "sales.csv is in the working directory. Compute the total of amount, the number of data rows and the city with the largest amount. Use bash."}],
                {"type": "object", "required": ["total", "rows", "topCity"], "properties": {"total": {"type": "number"}, "rows": {"type": "integer"}, "topCity": {"type": "string", "enum": ["Berlin", "Paris", "Madrid", "Rome"]}}},
                files=[encode_file("sales.csv", cls.csv)],
            )
        return cls.csv_answer

    def test_health(self):
        self.assertEqual(self.client.health()["status"], "ok")

    def test_generate_object_with_a_file(self):
        answer = self.csv_run()
        self.assertAlmostEqual(answer["total"], 769.75, places=2)
        self.assertEqual((answer["rows"], answer["topCity"]), (4, "Paris"))

    def test_generate_text(self):
        self.assertRegex(generate_text([{"role": "user", "content": "Answer with exactly one word: what is the capital of France?"}], base_url=BASE_URL), r"(?i)paris")

    def test_typed_failure_and_raise(self):
        response = self.client.inference([{"role": "user", "content": "hi"}], {"type": "object", "required": ["hi"], "properties": {"hi": {"type": "string"}}}, model="model-that-does-not-exist:latest")
        self.assertEqual((response["status"], response["error"]["code"]), ("error", "provider_error"))
        with self.assertRaises(AgentRuntimeError) as raised:
            self.client.generate_text([{"role": "user", "content": "hi"}], model="model-that-does-not-exist:latest")
        self.assertEqual((raised.exception.code, raised.exception.status), ("provider_error", 500))
        self.assertTrue(raised.exception.inference_id)

    def test_invalid_format_and_bad_request(self):
        with self.assertRaises(AgentRuntimeError) as raised:
            generate_object([{"role": "user", "content": "hi"}], {"type": "object", "required": ["x"], "properties": {"x": {"$ref": "#/$defs/missing"}}}, base_url=BASE_URL)
        self.assertEqual((raised.exception.status, raised.exception.code), (400, "invalid_format"))
        with self.assertRaises(AgentRuntimeError) as bad:
            self.client.generate_text([])
        self.assertEqual((bad.exception.status, bad.exception.code), (400, None))

    def test_admin_api(self):
        self.csv_run()
        listed = self.client.list_inferences(limit=5, mode="object")
        self.assertGreaterEqual(listed["total"], 1)
        self.assertTrue(all(item["mode"] == "object" for item in listed["items"]))
        found = self.client.list_inferences(q="sales.csv", limit=5)
        self.assertGreaterEqual(found["total"], 1)
        record = self.client.get_inference(next(item["id"] for item in found["items"] if item["status"] == "success"))
        self.assertTrue(record["messages"])
        file_meta = next(item for item in record["attachments"] if item["kind"] == "file")
        attachment = self.client.get_attachment(record["id"], file_meta["id"])
        self.assertEqual(attachment["data"].decode("utf-8"), self.csv)
        self.assertEqual(attachment["size"], file_meta["size"])


if __name__ == "__main__":
    unittest.main()
