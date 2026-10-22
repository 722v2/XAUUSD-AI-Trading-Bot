import io
import json
import unittest
from unittest.mock import patch
from urllib.error import URLError

from mt5_bridge import outbound_agent as relay


class OutboundRelayTests(unittest.TestCase):
    def test_normalize_server_url_strips_proxy_suffix_and_query(self):
        self.assertEqual(
            relay.normalize_server_url(
                "https://example.onrender.com/api/mt5/relay/proxy?unused=1#fragment"
            ),
            "https://example.onrender.com",
        )

    def test_normalize_server_url_rejects_http_and_credentials(self):
        self.assertEqual(relay.normalize_server_url("http://example.com"), "")
        self.assertEqual(relay.normalize_server_url("https://user:pass@example.com"), "")

    def test_headers_use_custom_user_agent_and_bridge_token(self):
        with patch.object(relay, "TOKEN", "test-secret"):
            headers = relay._session_headers()
        self.assertEqual(headers["X-Bridge-Token"], "test-secret")
        self.assertIn("XAUUSD-MT5-Relay", headers["User-Agent"])
        self.assertEqual(headers["Connection"], "close")

    def test_transport_error_exposes_safe_reason(self):
        with patch.object(relay, "urlopen", side_effect=URLError("certificate verify failed")):
            with patch("sys.stderr", new_callable=io.StringIO):
                status, body = relay.request("https://example.onrender.com/api/mt5/relay/poll")
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "RELAY_TRANSPORT_ERROR")
        self.assertIn("certificate verify failed", body["message"])

    def test_json_response_must_be_object(self):
        self.assertEqual(relay._decode_response(b'{"job": null}'), {"job": None})
        self.assertEqual(relay._decode_response(b'[1,2]'), {"error": "INVALID_JSON_SHAPE"})

    def test_valid_job_rejects_absolute_url_and_accepts_local_path(self):
        self.assertTrue(relay.valid_job({"id": "job-1", "path": "/market/quote"}))
        self.assertFalse(relay.valid_job({"id": "job-1", "path": "https://evil.example"}))
        self.assertFalse(relay.valid_job({"id": "job-1", "path": "//evil.example"}))


if __name__ == "__main__":
    unittest.main()
