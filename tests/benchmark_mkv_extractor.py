"""Offline benchmark: python tests/benchmark_mkv_extractor.py [output.json]."""
import http.server
import json
from pathlib import Path
import sys
import threading
import time
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_mkv_srt import fixture
from mkv_extractor import extractor
from mkv_extractor.http import RangeSession


def benchmark(blob, multipart, coalesce):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            ranges = [tuple(map(int, p.split("-"))) for p in self.headers["Range"][6:].split(",")]
            if not multipart:
                ranges = ranges[:1]
            self.send_response(206)
            if len(ranges) == 1:
                a, b = ranges[0]
                self.send_header("Content-Range", f"bytes {a}-{b}/{len(blob)}")
                body = blob[a:b+1]
            else:
                self.send_header("Content-Type", "multipart/byteranges; boundary=bench")
                body = b"".join(f"--bench\r\nContent-Range: bytes {a}-{b}/{len(blob)}\r\n\r\n".encode() + blob[a:b+1] + b"\r\n" for a, b in ranges) + b"--bench--\r\n"
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        started = time.perf_counter()
        with RangeSession(coalesce_gap_bytes=coalesce) as session, mock.patch.object(extractor, "check_extractor_is_worth_it", return_value=None):
            result = extractor.extract_remote_subtitle(f"http://127.0.0.1:{server.server_port}/bench.mkv", strict=True)
        return {"multipart": multipart, "coalesce_gap_bytes": coalesce, "seconds": round(time.perf_counter() - started, 4),
                "requests": session.requests, "bytes_received": session.bytes_received,
                "extra_bytes": session.coalesced_extra_bytes, "file_bytes": len(blob), "events": result["events"],
                "coverage": result["coverage"], "cost_heuristic": "disabled_for_transport_benchmark"}
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    results = []
    output = Path(sys.argv[1] if len(sys.argv) > 1 else ".cache/mkv-extractor-benchmark.json")
    for name, size, count in [("small", 2, 2), ("large_few", 64, 4), ("large_many", 64, 80)]:
        samples = [(1000 + i * 100, 0, 50, None, f"Evento {i+1}") for i in range(count)]
        blob = fixture(samples=samples, padding_size=size * 1024 * 1024, statistics_frames=count)
        for multipart in (False, True):
            print(f"Running {name}, multipart={multipart}", flush=True)
            row = {"profile": name, **benchmark(blob, multipart, 0)}
            results.append(row)
            print(json.dumps(row), flush=True)
        if name == "large_many":
            row = {"profile": name, **benchmark(blob, False, 512)}
            results.append(row)
            print(json.dumps(row), flush=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(results, indent=2), encoding="utf-8")
