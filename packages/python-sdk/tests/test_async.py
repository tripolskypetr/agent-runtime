"""The async client and functions against a mocked transport: results, concurrency, error mapping."""
from __future__ import annotations

import asyncio
import json
import threading
import time
import unittest

from agent_runtime_client import AgentRuntimeError, AsyncAgentRuntimeClient, create_async_client, generate_object_async, generate_text_async, inference_async, text_async
from test_client import FORMAT, MESSAGES, Recorder, failure, ok


class AsyncClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_generate_object_runs_off_the_event_loop(self):
        loop_thread = threading.get_ident()
        seen = []

        def transport(method, url, headers, body, timeout):
            seen.append(threading.get_ident())
            return ok({"direction": "long"})

        async with AsyncAgentRuntimeClient("http://mock", transport=transport) as client:
            self.assertEqual(await client.generate_object(MESSAGES, FORMAT), {"direction": "long"})
        self.assertNotEqual(seen, [loop_thread])

    async def test_calls_overlap(self):
        def slow(method, url, headers, body, timeout):
            time.sleep(0.3)
            return ok({"direction": "long"})

        client = create_async_client("http://mock", transport=slow)
        started = time.monotonic()
        results = await asyncio.gather(*(client.generate_object(MESSAGES, FORMAT) for _ in range(4)))
        self.assertEqual(results, [{"direction": "long"}] * 4)
        self.assertLess(time.monotonic() - started, 0.9, "four 0.3 s requests should run concurrently")

    async def test_retry_logic_is_shared_with_the_sync_client(self):
        transport = Recorder(ok({"direction": "short"}), ok({"direction": "long"}))
        self.assertEqual(await generate_object_async(MESSAGES, FORMAT, base_url="http://mock", transport=transport), {"direction": "long"})
        self.assertEqual(len(transport.calls), 2)
        transport = Recorder(ok({"direction": "short"}), ok({"direction": "short"}))
        response = await inference_async(MESSAGES, FORMAT, base_url="http://mock", max_attempts=2, transport=transport)
        self.assertEqual((response["status"], response["error"]["code"], len(response["error"]["details"])), ("error", "schema_mismatch", 2))

    async def test_errors(self):
        client = create_async_client("http://mock", transport=Recorder(failure("provider_error"), failure("provider_error")))
        response = await client.text(MESSAGES)
        self.assertEqual(response["error"]["code"], "provider_error")
        with self.assertRaises(AgentRuntimeError) as raised:
            await client.generate_text(MESSAGES)
        self.assertEqual((raised.exception.code, raised.exception.status, raised.exception.inference_id), ("provider_error", 500, "inf-9"))
        self.assertEqual((await text_async(MESSAGES, base_url="http://mock", transport=Recorder(failure("timeout"))))["error"]["code"], "timeout")
        self.assertEqual(await generate_text_async(MESSAGES, base_url="http://mock", transport=Recorder((200, {}, json.dumps({"id": "t", "status": "success", "text": "hi", "model": "m", "attempts": 1, "turns": 1, "durationMs": 1}).encode()))), "hi")

    async def test_admin_methods(self):
        record = {"id": "i1", "attachments": [{"id": "a1", "inferenceId": "i1", "kind": "file", "name": "x.csv", "mime": "text/csv", "size": 3, "sha256": "h"}]}
        transport = Recorder(
            (200, {}, b'{"status": "ok"}'),
            (200, {}, b'{"total": 0, "items": []}'),
            (200, {}, json.dumps(record).encode()),
            (200, {}, json.dumps(record).encode()),
            (200, {}, b"a,b"),
            (200, {}, b'{"ok": true}'),
        )
        client = AsyncAgentRuntimeClient("http://mock", headers={"x-token": "t"}, transport=transport)
        self.assertEqual((await client.health())["status"], "ok")
        self.assertEqual((await client.list_inferences(limit=2, q="x"))["total"], 0)
        self.assertEqual((await client.get_inference("i1"))["id"], "i1")
        self.assertEqual((await client.get_attachment("i1", "a1"))["data"], b"a,b")
        self.assertEqual(await client.delete_inference("i1"), {"ok": True})
        self.assertEqual(transport.calls[1]["url"], "http://mock/api/v1/inferences?limit=2&q=x")
        self.assertTrue(all(call["headers"]["x-token"] == "t" for call in transport.calls))
        self.assertEqual(client.base_url, "http://mock")
        self.assertIs(client.sync.transport, transport)


if __name__ == "__main__":
    unittest.main()
