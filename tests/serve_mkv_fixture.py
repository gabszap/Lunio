"""Local HTTP fixture for subprocess integration tests; no external network."""
import http.server
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_mkv_srt import fixture, ASS_HEADER

codec = sys.argv[1] if len(sys.argv) > 1 else "S_TEXT/ASS"
samples = [(1000, 0, 1500, 1500, "0,0,Default,,0,0,0,,Olá integração!")] if codec != "S_TEXT/UTF8" else None
blob = fixture(codec, samples=samples, private=ASS_HEADER if codec != "S_TEXT/UTF8" else None, padding_size=6 * 1024 * 1024, statistics_frames=len(samples) if samples else 2)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        ranges = self.headers.get("Range", "")
        if not ranges.startswith("bytes="):
            self.send_error(400)
            return
        start, end = map(int, ranges[6:].split(",")[0].split("-"))
        self.send_response(206)
        self.send_header("Content-Type", "video/x-matroska")
        self.send_header("Content-Range", f"bytes {start}-{end}/{len(blob)}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.wfile.write(blob[start:end + 1])

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}/fixture.mkv"}), flush=True)
    server.serve_forever()
