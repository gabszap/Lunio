"""Adversarial HTTP fixtures; all addresses and payloads are local."""
import concurrent.futures
import http.server as http_server
import threading
import unittest
from unittest import mock

from mkv_extractor import http
from mkv_extractor.errors import HttpRangeError


class TestStrictRanges(unittest.TestCase):
    def setUp(self):
        owner = self
        self.calls = []
        self.headers = []
        self.version = '"v1"'
        self.blob = bytes(range(256)) * 4

        class Handler(http_server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                owner.calls.append(self.path)
                owner.headers.append(dict(self.headers))
                requested = [tuple(map(int, r.split("-"))) for r in self.headers["Range"][6:].split(",")]
                start, end = requested[0]
                total = len(owner.blob)
                if self.path == "/ignored":
                    self.send_response(200)
                    body = b"ignored"
                elif self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", owner.base + "/ok")
                    body = b""
                else:
                    self.send_response(206)
                    self.send_header("ETag", owner.version)
                    if self.path.startswith("/multipart") and len(requested) > 1:
                        if self.path == "/multipart-missing":
                            requested = requested[:1]
                        if self.path == "/multipart-duplicate":
                            requested += requested[:1]
                        self.send_header("Content-Type", "multipart/byteranges; boundary=range-test")
                        body = b"".join(
                            f"--range-test\r\nContent-Range: bytes {a}-{b}/{total}\r\n\r\n".encode()
                            + owner.blob[a:b+1] + b"\r\n" for a, b in requested
                        ) + b"--range-test--\r\n"
                    else:
                        returned_start = start + 1 if self.path == "/wrong-offset" else start
                        returned_total = total + 1 if self.path == "/wrong-total" else total
                        self.send_header("Content-Range", f"bytes {returned_start}-{end}/{returned_total}")
                        body = owner.blob[start:end+1]
                        if self.path == "/short":
                            body = body[:-1]
                        if self.path == "/long":
                            body += b"x"
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http_server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(http.close_connections)

    def test_single_range_rejects_ignored_offsets_and_body_sizes(self):
        for mode in ("ignored", "wrong-offset", "short", "long"):
            with self.subTest(mode=mode), self.assertRaises(HttpRangeError):
                http.read_range(self.base + "/" + mode, 2, 6, timeout=2)

    def test_resolution_requires_exact_one_byte_response(self):
        for mode in ("ignored", "wrong-offset", "short", "long"):
            with self.subTest(mode=mode), self.assertRaises(HttpRangeError):
                http.resolve_url(self.base + "/" + mode, timeout=2)

    def test_ignored_range_is_rejected_without_consuming_body(self):
        response = mock.MagicMock()
        response.status = 200
        response.read.side_effect = AssertionError("invalid body consumed")
        conn = mock.Mock()
        conn.getresponse.return_value = response
        with mock.patch.object(http, "_connection_for", return_value=conn), self.assertRaises(HttpRangeError):
            http.read_range(self.base + "/ignored", 0, 0, timeout=2)

    def test_incomplete_or_duplicate_multipart_is_an_error_not_fallback(self):
        for mode in ("multipart-missing", "multipart-duplicate"):
            self.calls.clear()
            with self.subTest(mode=mode), self.assertRaises(HttpRangeError):
                http.read_ranges(self.base + "/" + mode, [(0, 0), (5, 7)], timeout=2)
            self.assertEqual(len(self.calls), 1)

    def test_capability_probe_validates_parts(self):
        with self.assertRaises(HttpRangeError):
            http.supports_multirange(self.base + "/multipart-missing", timeout=2)

    def test_operation_session_checks_versions_totals_and_sends_if_match(self):
        with http.RangeSession() as session:
            http.resolve_url(self.base + "/ok", timeout=2)
            self.assertEqual(http.read_range(self.base + "/ok", 10, 15), self.blob[10:16])
            self.assertEqual(self.headers[-1].get("If-Match"), '"v1"')
            self.version = '"v2"'
            with self.assertRaises(HttpRangeError):
                http.read_range(self.base + "/ok", 20, 25)
            self.assertGreater(session.requests, 0)
            self.assertGreater(session.bytes_received, 0)

    def test_changed_total_fails_in_same_operation(self):
        with http.RangeSession():
            http.resolve_url(self.base + "/ok")
            with self.assertRaises(HttpRangeError):
                http.read_range(self.base + "/wrong-total", 0, 1)

    def test_concurrent_sessions_do_not_share_connections(self):
        def extract(_):
            with http.RangeSession():
                return [http.read_range(self.base + "/ok", n, n + 4) for n in range(10)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            for result in pool.map(extract, range(3)):
                self.assertEqual(result, [self.blob[n:n+5] for n in range(10)])

    def test_tls_verifies_certificates_by_default(self):
        import ssl
        ctx = http.get_ssl_context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)

    def test_windows_default_ssl_context_skips_ca_store_and_respects_env(self):
        import os
        import ssl
        import sys

        stores_read = []

        def fake_enum(store):
            stores_read.append(store)
            return []

        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SSL_CERT_FILE", None)
            os.environ.pop("SSL_CERT_DIR", None)
            with (
                mock.patch.object(sys, "platform", "win32"),
                mock.patch.object(ssl, "enum_certificates", side_effect=fake_enum, create=True),
                mock.patch.object(ssl.SSLContext, "load_verify_locations"),
                mock.patch.object(ssl.SSLContext, "load_default_certs"),
                mock.patch.object(ssl.SSLContext, "set_default_verify_paths"),
            ):
                with http.RangeSession():
                    ctx = http.get_ssl_context()
                    self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
                    self.assertTrue(ctx.check_hostname)
        self.assertEqual(stores_read, ["ROOT"])

        sentinel = object()
        with (
            mock.patch.dict(os.environ, {"SSL_CERT_FILE": "/tmp/custom-ca.pem"}, clear=False),
            mock.patch.object(sys, "platform", "win32"),
            mock.patch.object(ssl, "create_default_context", return_value=sentinel) as create_default,
        ):
            with http.RangeSession():
                self.assertIs(http.get_ssl_context(), sentinel)
            create_default.assert_called_once_with()

    def test_redirect_tls_error_reports_final_host_and_verify_reason_without_token(self):
        from email.message import Message
        import io
        import ssl
        import urllib.error
        import urllib.response

        tls_err = ssl.SSLCertVerificationError(1, "certificate has expired")
        tls_err.verify_message = "certificate has expired"

        def fake_do_open(handler_self, http_class, request):
            if "origin.test" in request.full_url:
                headers = Message()
                headers["Location"] = "https://cdn.test/dld/SEGREDO123/video.mkv"
                resp = urllib.response.addinfourl(io.BytesIO(b""), headers, request.full_url, code=302)
                resp.msg = "Found"
                return resp
            raise urllib.error.URLError(tls_err)

        with mock.patch.object(http._PolicyHTTPSHandler, "do_open", fake_do_open):
            with self.assertRaises(HttpRangeError) as ctx:
                http.open_http("https://origin.test/resolve/TOKEN999", {"Range": "bytes=0-0"}, timeout=2)

        err = ctx.exception
        self.assertEqual(err.fallback_reason, "tls_verification_error")
        self.assertIn("https://cdn.test/…", str(err))
        self.assertNotIn("origin.test", str(err))
        self.assertNotIn("TOKEN999", str(err))
        self.assertNotIn("SEGREDO123", str(err))
        self.assertIn("SSLCertVerificationError", str(err))
        self.assertIn("certificate has expired", str(err))

    def test_url_error_reports_transport_cause_without_token(self):
        import urllib.error

        def fake_do_open(handler_self, http_class, request):
            raise urllib.error.URLError(TimeoutError("timed out"))

        with mock.patch.object(http._PolicyHTTPSHandler, "do_open", fake_do_open):
            with self.assertRaises(HttpRangeError) as ctx:
                http.open_http("https://cdn.test/dld/SEGREDO123", {"Range": "bytes=0-0"}, timeout=2)

        err = ctx.exception
        self.assertEqual(err.fallback_reason, "http_transport_error")
        self.assertIn("https://cdn.test/…", str(err))
        self.assertIn("URLError (TimeoutError)", str(err))
        self.assertNotIn("SEGREDO123", str(err))

    def test_public_only_blocks_loopback_and_does_not_reuse_local_policy(self):
        with http.RangeSession(public_only=True), self.assertRaises(HttpRangeError):
            http.resolve_url(self.base + "/ok")
        with http.RangeSession():
            self.assertEqual(http.resolve_url(self.base + "/ok")[1], len(self.blob))
        with http.RangeSession(public_only=True, allowed_origins={self.base}):
            self.assertEqual(http.resolve_url(self.base + "/redirect")[1], len(self.blob))

    def test_non_http_schemes_and_credentials_are_rejected(self):
        for url in ("file:///etc/passwd", "ftp://localhost/file", "http://user:secret@127.0.0.1/"):
            with self.subTest(url=url), self.assertRaises(HttpRangeError):
                http.read_range(url, 0, 0, timeout=0.2)

    def test_redirect_does_not_consume_an_unbounded_body(self):
        from email.message import Message
        response = mock.Mock()
        response.read.side_effect = AssertionError("redirect body consumed")
        request = http.urllib.request.Request(self.base + "/redirect", headers={"Range": "bytes=0-0"})
        request.timeout = 2
        handler = http._PolicyRedirectHandler()
        handler.parent = mock.Mock()
        headers = Message()
        headers["Location"] = self.base + "/ok"
        handler.http_error_302(request, response, 302, "Moved", headers)

    def test_optional_coalescing_preserves_each_requested_slice_and_budget(self):
        with http.RangeSession(coalesce_gap_bytes=4, coalesce_extra_bytes=4) as session:
            result = http.read_ranges(self.base + "/ok", [(0, 1), (4, 5)])
            self.assertEqual(result, {(0, 1): self.blob[0:2], (4, 5): self.blob[4:6]})
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(session.bytes_received, 6)
            self.assertEqual(session.coalesced_extra_bytes, 2)

    def test_ipv6_literal_without_explicit_port_keeps_host_and_default_port(self):
        import socket

        def dial(address, *args, **kwargs):
            self.assertEqual(address, ("::1", 80))
            return socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2)

        with mock.patch.object(http, "_dial", side_effect=dial):
            self.assertEqual(http.read_range("http://[::1]/ok", 0, 2), self.blob[:3])
