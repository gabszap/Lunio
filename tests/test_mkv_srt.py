"""Synthetic MKVs exercise the real EBML parser and Range extraction path."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from mkv_extractor import extractor, matroska
from mkv_extractor.errors import CodecNotSupportedError, RemoteMkvError
from mkv_extractor.subtitles import select_subtitle_track, select_all_subtitle_tracks


def el(eid, payload):
    return eid.to_bytes((eid.bit_length() + 7) // 8, "big") + b"\x01" + len(payload).to_bytes(7, "big") + payload


def uint(eid, value):
    return el(eid, value.to_bytes(4, "big"))


ASS_HEADER = b"[Script Info]\nTitle: Test\n[V4+ Styles]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"


def fixture(codec="S_TEXT/UTF8", samples=None, scale=1_000_000, prefix=b"", private=None, extra_codec=None, padding_size=2 * 1024 * 1024):
    # Actual block starts are 900 and 2500; CueTime deliberately differs.
    if samples is None:
        samples = [(1000, -100, 700, 99, "Olá, mundo!\nSegunda linha"),
                   (2000, 500, None, None, "Fim")]
    track = uint(0xD7, 7) + uint(0x83, 17) + el(0x86, codec.encode()) + el(0x22B59C, b"por")
    if private is not None:
        track += el(0x63A2, private)
    entries = el(0xAE, track)
    if extra_codec:
        extra = uint(0xD7, 8) + uint(0x83, 17) + el(0x86, extra_codec.encode()) + el(0x22B59C, b"por") + uint(0x55AA, 1)
        if extra_codec != "S_TEXT/UTF8":
            extra += el(0x63A2, ASS_HEADER)
        entries += el(0xAE, extra)
    tracks = el(0x1654AE6B, entries)
    info = el(0x1549A966, uint(0x2AD7B1, scale))
    clusters = b""
    points = b""
    # Put Clusters beyond the initial scan so tests prove direct Range access.
    padding = el(0xEC, b"x" * padding_size)
    for index, (cluster_time, relative, duration, cue_duration, text) in enumerate(samples):
        cluster_prefix = prefix + uint(0xE7, cluster_time)
        payload = b"\x87" + relative.to_bytes(2, "big", signed=True) + b"\x00" + text.encode("utf-8")
        block = el(0xA3, payload) if duration is None else el(0xA0, el(0xA1, payload) + uint(0x9B, duration))
        position = len(info + tracks + padding + clusters)
        extra_block = b""
        if extra_codec:
            text8 = "Forçada" if extra_codec == "S_TEXT/UTF8" else "0,0,Default,,0,0,0,,Forçada"
            extra_block = el(0xA0, el(0xA1, b"\x88\x00\x00\x00" + text8.encode()) + uint(0x9B, 1000))
        clusters += el(0x1F43B675, cluster_prefix + block + extra_block)
        cue = uint(0xF7, 7) + uint(0xF1, position) + uint(0xF0, len(cluster_prefix))
        if cue_duration is not None:
            cue += uint(0xB2, cue_duration)
        points += el(0xBB, uint(0xB3, 123 + index * 1000) + el(0xB7, cue))
        if extra_codec:
            cue8 = uint(0xF7, 8) + uint(0xF1, position) + uint(0xF0, len(cluster_prefix + block))
            points += el(0xBB, uint(0xB3, 123 + index * 1000) + el(0xB7, cue8))
    return el(0x18538067, info + tracks + padding + clusters + el(0x1C53BB6B, points))


class TestNativeSubtitles(unittest.TestCase):
    @contextlib.contextmanager
    def remote(self, blob):
        self.ranges = []

        def read(url, start, end, **kwargs):
            self.assertGreaterEqual(start, 0)
            self.assertLess(end, len(blob))
            self.ranges.append((start, end))
            return blob[start:end + 1]

        def reads(url, ranges, **kwargs):
            return {r: read(url, *r) for r in ranges}

        with mock.patch.object(extractor, "resolve_url", return_value=("http://test/m.mkv", len(blob))), \
             mock.patch.object(extractor, "read_range", side_effect=read), \
             mock.patch.object(matroska, "read_range", side_effect=read), \
             mock.patch.object(matroska, "read_ranges", side_effect=reads), \
             mock.patch.object(extractor, "supports_multirange", return_value=True):
            yield

    def extract(self, blob, **kwargs):
        with self.remote(blob):
            return extractor.extract_remote_subtitle("http://test/m.mkv", **kwargs)

    def test_srt_without_private_uses_cluster_block_time_and_block_duration(self):
        result = self.extract(fixture())
        self.assertEqual(result["format"], "srt")
        self.assertEqual(result["events"], 2)
        self.assertEqual(result["content"], "1\r\n00:00:00,900 --> 00:00:01,600\r\nOlá, mundo!\r\nSegunda linha\r\n\r\n2\r\n00:00:02,500 --> 00:00:06,000\r\nFim\r\n\r\n")
        self.assertTrue(all(end - start + 1 <= 4 * 1024 * 1024 for start, end in self.ranges))

    def test_missing_duration_uses_next_distinct_start_then_fallback(self):
        samples = [(3000, 0, None, None, "Última"), (1000, 0, None, None, "Primeira"), (1000, 0, None, None, "Simultânea")]
        result = self.extract(fixture(samples=samples, scale=2_000_000))
        self.assertEqual(result["content"], "1\r\n00:00:02,000 --> 00:00:06,000\r\nPrimeira\r\n\r\n2\r\n00:00:02,000 --> 00:00:06,000\r\nSimultânea\r\n\r\n3\r\n00:00:06,000 --> 00:00:09,500\r\nÚltima\r\n\r\n")

    def test_cue_duration_without_block_duration_and_hour_timestamp(self):
        result = self.extract(fixture(samples=[(3_661_123, 0, None, 456, "Teste")]))
        self.assertIn("01:01:01,123 --> 01:01:01,579", result["content"])

    def test_cluster_timestamp_after_large_void_does_not_fetch_void_payload(self):
        result = self.extract(fixture(prefix=el(0xEC, b"v" * 8192)))
        self.assertIn("00:00:00,900", result["content"])
        # Other than the existing head/tail scans, each requested span is a small header or subtitle.
        self.assertTrue(all(b - a < 1024 for a, b in self.ranges if a > 1024 * 1024))

    def test_ass_and_ssa_keep_header_readorder_and_ass_extension(self):
        for codec in ("S_TEXT/ASS", "S_TEXT/SSA"):
            with self.subTest(codec=codec), tempfile.TemporaryDirectory() as tmp:
                samples = [(1000, 0, 500, 800, "2,0,Default,,0,0,0,,Segundo"), (2000, 0, 500, 800, "1,0,Default,,0,0,0,,Primeiro")]
                result = self.extract(fixture(codec, samples, private=ASS_HEADER), output_path=Path(tmp) / "subtitle")
                self.assertEqual(result["format"], "ass")
                self.assertTrue(result["output_file"].endswith(".ass"))
                self.assertTrue(result["content"].startswith("[Script Info]"))
                self.assertLess(result["content"].index("Primeiro"), result["content"].index("Segundo"))
                self.assertIn("Dialogue: 0,0:00:00.12,0:00:00.92", result["content"])

    def test_ass_still_requires_private(self):
        with self.assertRaises(RemoteMkvError):
            self.extract(fixture("S_TEXT/ASS"))

    def test_output_extension_and_exact_explicit_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("chosen.srt", "chosen.SRT", "no_suffix"):
                result = self.extract(fixture(), output_path=Path(tmp) / name)
                expected = Path(tmp) / (name if "." in name else name + ".srt")
                self.assertEqual(Path(result["output_file"]), expected)
                self.assertEqual(expected.read_bytes(), result["content"].encode("utf-8"))
            for codec, private, name in (("S_TEXT/UTF8", None, "wrong.ass"), ("S_TEXT/ASS", ASS_HEADER, "wrong.srt")):
                path = Path(tmp) / name
                path.write_text("keep me", encoding="utf-8")
                with self.assertRaises(RemoteMkvError):
                    self.extract(fixture(codec, private=private), output_path=path)
                self.assertEqual(path.read_text(encoding="utf-8"), "keep me")

    def test_cli_stream_index_json_and_output(self):
        with tempfile.TemporaryDirectory() as tmp, self.remote(fixture()):
            out = Path(tmp) / "sub.srt"
            with mock.patch("sys.argv", ["mkv_extractor", "http://test/m.mkv", "--stream-index", "0", "--json", "-o", str(out)]), contextlib.redirect_stdout(io.StringIO()) as stdout:
                extractor.main()
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["format"], "srt")
            self.assertEqual(result["output_file"], str(out))
            self.assertEqual(result["events"], 2)

    def test_mixed_all_tracks_and_both_use_each_codec_extension(self):
        for mode, names in [("all_tracks", ["subs_track7_por.srt", "subs_track8_por.ass"]),
                            ("both", ["subs.srt", "subs.forced.ass"])]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                result = self.extract(fixture(extra_codec="S_TEXT/ASS"), output_path=Path(tmp) / "subs.srt", **{mode: True})
                self.assertEqual([Path(r["output_file"]).name for r in result], names)
                self.assertEqual([r["format"] for r in result], ["srt", "ass"])
                self.assertTrue((Path(tmp) / names[0]).read_text(encoding="utf-8").startswith("1\n"))
                self.assertTrue((Path(tmp) / names[1]).read_text(encoding="utf-8").startswith("[Script Info]"))

    def test_srt_only_track_and_stream_selectors_and_stdout(self):
        for flags in (["--track", "7"], ["--stream-index", "0"], ["--language", "por", "--prefer", "brazilian"]):
            with self.subTest(flags=flags), self.remote(fixture()), mock.patch("sys.argv", ["mkv_extractor", "http://test/m.mkv", *flags]), contextlib.redirect_stdout(io.StringIO()) as stdout:
                extractor.main()
            self.assertTrue(stdout.getvalue().startswith("1\r\n00:00:00,900 --> 00:00:01,600"))

    def test_all_takes_precedence_over_both_for_selection_and_output_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.extract(fixture(extra_codec="S_TEXT/UTF8"), output_path=Path(tmp) / "subs.srt", all_tracks=True, both=True)
            self.assertEqual([Path(r["output_file"]).name for r in result], ["subs_track7_por.srt", "subs_track8_por.srt"])
            self.assertEqual(len(list(Path(tmp).glob("*.srt"))), 2)


class TestMixedSelection(unittest.TestCase):
    def setUp(self):
        self.tracks = [{"track_number": 1, "track_type": 1},
                       {"track_number": 7, "track_type": 17, "codec_id": "S_TEXT/ASS", "language": "eng"},
                       {"track_number": 12, "track_type": 17, "codec_id": "S_TEXT/UTF8", "language": "por", "name": "Brazilian"},
                       {"track_number": 15, "track_type": 17, "codec_id": "S_TEXT/SSA", "language": "por", "name": "Forced", "flag_forced": 1},
                       {"track_number": 20, "track_type": 17, "codec_id": "S_HDMV/PGS"}]

    def test_language_prefer_forced_and_explicit_selectors(self):
        for kwargs, number in [({}, 12), ({"language": "eng", "prefer": ""}, 7), ({"forced": True}, 15), ({"track_number": 12}, 12), ({"stream_index": 2}, 12), ({"track_number": 15}, 15)]:
            with self.subTest(kwargs=kwargs):
                self.assertEqual(select_subtitle_track(self.tracks, **kwargs)["track_number"], number)
        self.assertEqual([t["track_number"] for t in select_all_subtitle_tracks(self.tracks)], [7, 12, 15])

    def test_explicit_bitmap_codec_is_rejected(self):
        for kwargs in ({"track_number": 20}, {"stream_index": 4}):
            with self.subTest(kwargs=kwargs), self.assertRaises(CodecNotSupportedError):
                select_subtitle_track(self.tracks, **kwargs)


class TestSrtOverHttp(unittest.TestCase):
    def test_real_single_and_multi_range_servers_extract_without_full_download(self):
        import http.server
        import threading
        from mkv_extractor.http import close_connections

        blob = fixture(padding_size=6 * 1024 * 1024)
        for multipart in (False, True):
            served = []

            class Handler(http.server.BaseHTTPRequestHandler):
                protocol_version = "HTTP/1.1"

                def do_GET(self):
                    header = self.headers.get("Range")
                    if not header or not header.startswith("bytes="):
                        self.send_error(400)
                        return
                    ranges = [tuple(map(int, r.split("-"))) for r in header[6:].split(",")]
                    if not multipart:
                        ranges = ranges[:1]
                    served.extend(ranges)
                    self.send_response(206)
                    if len(ranges) == 1:
                        start, end = ranges[0]
                        self.send_header("Content-Range", f"bytes {start}-{end}/{len(blob)}")
                        body = blob[start:end + 1]
                    else:
                        self.send_header("Content-Type", "multipart/byteranges; boundary=mkv-test")
                        body = b"".join(
                            f"--mkv-test\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes {start}-{end}/{len(blob)}\r\n\r\n".encode()
                            + blob[start:end + 1] + b"\r\n" for start, end in ranges
                        ) + b"--mkv-test--\r\n"
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *args):
                    pass

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with self.subTest(multipart=multipart):
                    result = extractor.extract_remote_subtitle(f"http://127.0.0.1:{server.server_port}/m.mkv", timeout=5)
                    self.assertEqual(result["format"], "srt")
                    self.assertEqual(result["events"], 2)
                    self.assertIn("00:00:00,900 --> 00:00:01,600", result["content"])
                    self.assertLess(sum(b - a + 1 for a, b in served), len(blob))
                    self.assertTrue(all(b - a + 1 < len(blob) for a, b in served))
            finally:
                close_connections()
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
