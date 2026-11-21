"""Optional reference against FFmpeg-generated real Matroska fixtures, offline."""
import http.server
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

from mkv_extractor import extractor


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg optional reference tool unavailable")
class TestFfmpegReference(unittest.TestCase):
    def test_native_srt_and_ass_match_reference_frames_and_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.srt"
            source.write_text("1\n00:00:01,250 --> 00:00:02,750\nOlá, referência!\n\n2\n00:00:04,000 --> 00:00:05,100\nSegundo evento\n\n", encoding="utf-8")
            for codec in ("srt", "ass"):
                media, reference = root / f"{codec}.mkv", root / f"reference.{codec}"
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(source), "-c:s", codec, str(media)], check=True, capture_output=True)
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(media), "-map", "0:s:0", "-c:s", "copy", str(reference)], check=True, capture_output=True)
                blob = media.read_bytes()

                class Handler(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        start, end = map(int, self.headers["Range"][6:].split(",")[0].split("-"))
                        self.send_response(206)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{len(blob)}")
                        self.send_header("Content-Length", str(end-start+1))
                        self.end_headers()
                        self.wfile.write(blob[start:end+1])

                    def log_message(self, *args):
                        pass

                server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                try:
                    # This test compares parser correctness, not cost advice for
                    # a tiny fixture whose sequential read would be cheaper.
                    with mock.patch.object(extractor, "check_extractor_is_worth_it", return_value=None):
                        result = extractor.extract_remote_subtitle(f"http://127.0.0.1:{server.server_port}/media.mkv")
                    self.assertEqual(result["events"], 2)
                    actual = result["content"].replace("\r\n", "\n").strip()
                    expected = reference.read_text(encoding="utf-8-sig").strip()
                    if codec == "srt":
                        self.assertEqual(actual, expected)
                    else:
                        actual_events = [line for line in actual.splitlines() if line.startswith("Dialogue:")]
                        expected_events = [line for line in expected.splitlines() if line.startswith("Dialogue:")]
                        self.assertEqual(actual_events, expected_events)
                        self.assertEqual(actual.split("[Events]")[0], expected.split("[Events]")[0])
                finally:
                    server.shutdown()
                    server.server_close()
