"""Client behaviour against a mocked transport: retries, error mapping, request shapes. No server needed."""
from __future__ import annotations

import json
import unittest
import urllib.error

from agent_runtime_client import AgentRuntimeClient, AgentRuntimeError, create_client, encode_file, generate_object, generate_text, inference, user_message

FORMAT = {"type": "object", "required": ["direction"], "properties": {"direction": {"const": "long"}}}
MESSAGES = [{"role": "user", "content": "x"}]


def ok(data, inference_id="inf-1"):
    body = {"id": inference_id, "status": "success", "data": data, "model": "mock", "attempts": 1, "turns": 1, "durationMs": 10}
    return 200, {"content-type": "application/json"}, json.dumps(body).encode()


def failure(code, status=500, inference_id="inf-9"):
    body = {"id": inference_id, "status": "error", "error": {"code": code, "message": f"{code} happened", "details": ["attempt 1: x"]}, "model": "mock", "attempts": 1, "turns": 1, "durationMs": 5}
    return status, {"content-type": "application/json"}, json.dumps(body).encode()


class Recorder:
    """A transport that records every call and replays scripted responses."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": json.loads(body) if body else None, "timeout": timeout})
        response = self.responses.pop(0)
        return response(self.calls[-1]) if callable(response) else response


class RetryTest(unittest.TestCase):
    def test_second_inference_accepted_after_client_side_rejection(self):
        transport = Recorder(ok({"direction": "short"}), ok({"direction": "long"}))
        client = create_client("http://mock", transport=transport)
        self.assertEqual(client.generate_object(MESSAGES, FORMAT), {"direction": "long"})
        self.assertEqual(len(transport.calls), 2)

    def test_retry_exhausted_returns_schema_mismatch(self):
        transport = Recorder(ok({"direction": "short"}, "a"), ok({"direction": "short"}, "b"))
        client = create_client("http://mock", max_attempts=2, transport=transport)
        response = client.inference(MESSAGES, FORMAT)
        self.assertEqual(response["status"], "error")
        self.assertEqual(response["error"]["code"], "schema_mismatch")
        self.assertEqual(response["error"]["details"], ['inference a: Invalid arguments: direction: must be exactly "long"', 'inference b: Invalid arguments: direction: must be exactly "long"'])
        self.assertEqual(response["error"]["message"], 'Answer rejected by the client-side validator in 2 inference(s): Invalid arguments: direction: must be exactly "long"')
        self.assertEqual((response["attempts"], response["turns"], response["durationMs"], response["id"]), (2, 2, 20, "b"))

    def test_retry_exhausted_raises(self):
        transport = Recorder(ok({"direction": "short"}), ok({"direction": "short"}))
        client = create_client("http://mock", max_attempts=2, transport=transport)
        with self.assertRaises(AgentRuntimeError) as raised:
            client.generate_object(MESSAGES, FORMAT)
        self.assertEqual(raised.exception.code, "schema_mismatch")
        self.assertEqual(len(raised.exception.details), 2)
        self.assertEqual(raised.exception.status, 500)

    def test_validation_off_returns_answer_as_is(self):
        transport = Recorder(ok({"direction": "short"}))
        self.assertEqual(create_client("http://mock", validate_answer=False, transport=transport).generate_object(MESSAGES, FORMAT), {"direction": "short"})
        self.assertEqual(len(transport.calls), 1)

    def test_standalone_function_passes_config_through(self):
        transport = Recorder(ok({"direction": "long"}))
        self.assertEqual(generate_object(MESSAGES, FORMAT, base_url="http://mock", max_attempts=1, transport=transport), {"direction": "long"})
        self.assertEqual(transport.calls[0]["url"], "http://mock/api/v1/inference")


class ErrorsTest(unittest.TestCase):
    def test_typed_failure_is_returned_by_inference_and_raised_by_generate(self):
        client = create_client("http://mock", transport=Recorder(failure("provider_error"), failure("provider_error")))
        response = client.inference(MESSAGES, FORMAT)
        self.assertEqual((response["status"], response["error"]["code"]), ("error", "provider_error"))
        with self.assertRaises(AgentRuntimeError) as raised:
            client.generate_text(MESSAGES)
        error = raised.exception
        self.assertEqual((error.code, error.status, error.inference_id, error.details), ("provider_error", 500, "inf-9", ["attempt 1: x"]))
        self.assertEqual(str(error), "provider_error: provider_error happened")

    def test_invalid_format_raises_with_400(self):
        body = {"status": "error", "error": {"code": "invalid_format", "message": "Invalid format schema: can't resolve reference", "details": []}}
        transport = Recorder((400, {}, json.dumps(body).encode()))
        with self.assertRaises(AgentRuntimeError) as raised:
            inference(MESSAGES, FORMAT, base_url="http://mock", transport=transport)
        self.assertEqual((raised.exception.status, raised.exception.code, raised.exception.inference_id), (400, "invalid_format", None))

    def test_plain_http_error(self):
        transport = Recorder((400, {}, json.dumps({"statusCode": 400, "error": "Bad Request", "message": "body/messages must NOT have fewer than 1 items"}).encode()))
        with self.assertRaises(AgentRuntimeError) as raised:
            generate_text([], base_url="http://mock", transport=transport)
        self.assertEqual(str(raised.exception), "HTTP 400: body/messages must NOT have fewer than 1 items")
        self.assertIsNone(raised.exception.code)

    def test_network_failure_has_status_0(self):
        def broken(method, url, headers, body, timeout):
            raise urllib.error.URLError("connection refused")

        with self.assertRaises(AgentRuntimeError) as raised:
            create_client("http://mock", transport=broken).health()
        self.assertEqual(raised.exception.status, 0)
        self.assertIn("connection refused", str(raised.exception))


class RequestShapeTest(unittest.TestCase):
    def test_body_headers_and_timeout(self):
        transport = Recorder(ok({"direction": "long"}))
        client = AgentRuntimeClient("http://mock/", headers={"x-token": "t"}, timeout=12.5, transport=transport)
        client.generate_object(MESSAGES, FORMAT, files=[encode_file("a.txt", "hi")], model="m", instructions="be brief", headers={"x-run": "1"})
        call = transport.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "http://mock/api/v1/inference")
        self.assertEqual(call["body"], {"messages": MESSAGES, "files": [{"name": "a.txt", "content": "aGk="}], "format": FORMAT, "model": "m", "instructions": "be brief"})
        self.assertEqual(call["headers"], {"accept": "application/json", "x-token": "t", "x-run": "1", "content-type": "application/json"})
        self.assertEqual(call["timeout"], 12.5)

    def test_optional_fields_are_omitted_and_timeout_overridden(self):
        transport = Recorder(ok({"direction": "long"}))
        create_client("http://mock", transport=transport).text([user_message("hi", [b"\x89PNG"])], timeout=None)
        call = transport.calls[0]
        self.assertEqual(call["url"], "http://mock/api/v1/text")
        self.assertEqual(call["body"], {"messages": [{"role": "user", "content": "hi", "images": ["iVBORw=="]}]})
        self.assertIsNone(call["timeout"])

    def test_list_query(self):
        transport = Recorder((200, {}, b'{"total": 0, "items": []}'))
        create_client("http://mock", transport=transport).list_inferences(limit=5, offset=10, status="error", mode="text", q="Привет 100%")
        self.assertEqual(transport.calls[0]["url"], "http://mock/api/v1/inferences?limit=5&offset=10&status=error&mode=text&q=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82+100%25")
        self.assertEqual(transport.calls[0]["method"], "GET")

    def test_get_attachment(self):
        record = {"id": "i1", "attachments": [{"id": "a1", "inferenceId": "i1", "kind": "file", "name": "x.csv", "mime": "text/csv", "size": 3, "sha256": "h"}]}
        transport = Recorder((200, {}, json.dumps(record).encode()), (200, {"content-type": "text/csv"}, b"a,b"))
        attachment = create_client("http://mock", transport=transport).get_attachment("i1", "a1")
        self.assertEqual(attachment["data"], b"a,b")
        self.assertEqual(attachment["name"], "x.csv")
        self.assertEqual(transport.calls[1]["url"], "http://mock/api/v1/inferences/i1/attachments/a1")
        self.assertEqual(transport.calls[1]["headers"]["accept"], "*/*")

    def test_get_attachment_unknown_id(self):
        transport = Recorder((200, {}, json.dumps({"id": "i1", "attachments": []}).encode()))
        with self.assertRaises(AgentRuntimeError) as raised:
            create_client("http://mock", transport=transport).get_attachment("i1", "nope")
        self.assertEqual(raised.exception.status, 404)

    def test_delete(self):
        transport = Recorder((200, {}, b'{"ok": true}'))
        self.assertEqual(create_client("http://mock", transport=transport).delete_inference("i 1"), {"ok": True})
        self.assertEqual(transport.calls[0]["url"], "http://mock/api/v1/inferences/i%201")
        self.assertEqual(transport.calls[0]["method"], "DELETE")


if __name__ == "__main__":
    unittest.main()
