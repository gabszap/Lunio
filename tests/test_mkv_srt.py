"""Synthetic MKVs exercise the real EBML parser and Range extraction path."""
import contextlib
import io
import json
import os
import struct
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from mkv_extractor import extractor, matroska, http as http_module
from mkv_extractor.errors import CodecNotSupportedError, RemoteMkvError
from mkv_extractor.subtitles import select_subtitle_track, select_all_subtitle_tracks


def el(eid, payload):
    return eid.to_bytes((eid.bit_length() + 7) // 8, "big") + b"\x01" + len(payload).to_bytes(7, "big") + payload


def uint(eid, value):
    return el(eid, value.to_bytes(4, "big"))


ASS_HEADER = b"[Script Info]\nTitle: Test\n[V4+ Styles]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"


def fixture(codec="S_TEXT/UTF8", samples=None, scale=1_000_000, prefix=b"", private=None, extra_codec=None, padding_size=2 * 1024 * 1024, track_name=None, cue_offset=0, statistics_frames=None, cue_relative_position=None):
    # Actual block starts are 900 and 2500; Cues must match their Blocks.
    if samples is None:
        samples = [(1000, -100, 700, 99, "Olá, mundo!\nSegunda linha"),
                   (2000, 500, None, None, "Fim")]
    track = uint(0xD7, 7) + uint(0x83, 17) + el(0x86, codec.encode()) + el(0x22B59C, b"por")
    if statistics_frames is not None:
        track += uint(0x73C5, 7)
    if track_name:
        track += el(0x536E, track_name.encode())
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
    tags = b""
    if statistics_frames is not None:
        info = el(0x1549A966, uint(0x2AD7B1, scale) + el(0x5741, b"fixture-writer") + el(0x4489, struct.pack(">d", 10_000_000_000 / scale)))
        values = {"_STATISTICS_WRITING_APP": "fixture-writer", "NUMBER_OF_FRAMES": str(statistics_frames), "DURATION": "00:00:10.000000000"}
        tags = el(0x1254C367, el(0x7373, el(0x63C0, uint(0x63C5, 7)) + b"".join(el(0x67C8, el(0x45A3, k.encode()) + el(0x4487, v.encode())) for k, v in values.items())))
    clusters = b""
    points = b""
    # Put Clusters beyond the initial scan so tests prove direct Range access.
    padding = el(0xEC, b"x" * padding_size)
    for index, (cluster_time, relative, duration, cue_duration, text) in enumerate(samples):
        cluster_prefix = prefix + uint(0xE7, cluster_time)
        payload = b"\x87" + relative.to_bytes(2, "big", signed=True) + b"\x00" + text.encode("utf-8")
        block = el(0xA3, payload) if duration is None else el(0xA0, el(0xA1, payload) + uint(0x9B, duration))
        position = len(info + tracks + tags + padding + clusters)
        extra_block = b""
        if extra_codec:
            text8 = "Forçada" if extra_codec == "S_TEXT/UTF8" else "0,0,Default,,0,0,0,,Forçada"
            extra_block = el(0xA0, el(0xA1, b"\x88\x00\x00\x00" + text8.encode()) + uint(0x9B, 1000))
        clusters += el(0x1F43B675, cluster_prefix + block + extra_block)
        cue = uint(0xF7, 7) + uint(0xF1, position) + uint(0xF0, len(cluster_prefix) if cue_relative_position is None else cue_relative_position)
        if cue_duration is not None:
            cue += uint(0xB2, cue_duration)
        points += el(0xBB, uint(0xB3, max(0, cluster_time + relative + cue_offset)) + el(0xB7, cue))
        if extra_codec:
            cue8 = uint(0xF7, 8) + uint(0xF1, position) + uint(0xF0, len(cluster_prefix + block))
            points += el(0xBB, uint(0xB3, cluster_time) + el(0xB7, cue8))
    return el(0x18538067, info + tracks + tags + padding + clusters + el(0x1C53BB6B, points))


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
                self.assertIn("Dialogue: 0,0:00:01.00,0:00:01.50", result["content"])

    def test_cue_timestamp_must_match_real_block(self):
        with self.assertRaises(RemoteMkvError):
            self.extract(fixture(cue_offset=200))

    def test_inferred_duration_is_reported_and_configurable(self):
        result = self.extract(fixture(), fallback_duration_ms=1200)
        self.assertIn("00:00:02,500 --> 00:00:03,700", result["content"])
        self.assertEqual(result["inferred_events"], 1)
        self.assertEqual(result["duration_sources"], {"block_duration": 1, "fallback_estimate": 1})

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
            with self.subTest(flags=flags), self.remote(fixture()), mock.patch("sys.argv", ["mkv_extractor", "http://test/m.mkv", "--stdout", *flags]), contextlib.redirect_stdout(io.StringIO()) as stdout:
                extractor.main()
            self.assertTrue(stdout.getvalue().startswith("1\r\n00:00:00,900 --> 00:00:01,600"))

    def run_cli(self, url, flags=(), codec="S_TEXT/UTF8", filename=None, resolved=None, extra_codec=None):
        blob = fixture(codec, samples=None if codec == "S_TEXT/UTF8" else [(1000, 0, 1000, None, "0,0,Default,,0,0,0,,Teste")],
                       private=None if codec == "S_TEXT/UTF8" else ASS_HEADER, extra_codec=extra_codec)

        def resolve(url, **kwargs):
            if filename and "metadata" in kwargs:
                kwargs["metadata"]["filename"] = filename
            return resolved or url, len(blob)

        with self.remote(blob), mock.patch.object(extractor, "resolve_url", side_effect=resolve), \
             mock.patch("sys.argv", ["mkv_extractor", url, *flags]), contextlib.redirect_stdout(io.StringIO()) as stdout:
            extractor.main()
        return stdout.getvalue()

    @contextlib.contextmanager
    def working_directory(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                yield Path(tmp)
            finally:
                os.chdir(previous)

    def test_cli_defaults_to_media_filename_and_codec_extension(self):
        for codec, extension in (("S_TEXT/UTF8", "srt"), ("S_TEXT/ASS", "ass"), ("S_TEXT/SSA", "ass")):
            with self.subTest(codec=codec), self.working_directory() as folder:
                self.run_cli("http://test/Series.S01E01%20-%20Ol%C3%A1.mkv?token=secret", codec=codec)
                path = folder / f"Series.S01E01 - Olá.{extension}"
                self.assertTrue(path.is_file())
                self.assertGreater(path.stat().st_size, 0)

    def test_cli_uses_server_filename_then_final_or_original_mkv_url(self):
        cases = [
            ({"filename": "Download.S01E01.mkv", "resolved": "http://cdn/opaque?token=secret"}, "Download.S01E01.srt"),
            ({"resolved": "http://cdn/Final%20Episode.mkv?token=secret"}, "Final Episode.srt"),
            ({"resolved": "http://cdn/opaque?token=secret"}, "Original.srt"),
        ]
        for kwargs, expected in cases:
            with self.subTest(kwargs=kwargs), self.working_directory():
                self.run_cli("http://source/Original.mkv", **kwargs)
                self.assertTrue(Path(expected).is_file())

    def test_cli_filename_follows_lunio_path_and_query_rules(self):
        cases = [
            ("http://test/Episode.S01E01.mkv/0/2", "Episode.S01E01.srt"),
            ("http://test/playback/0/1?torrent_name=Foo.S01E02.1080p.mkv&name=Other", "Foo.S01E02.1080p.srt"),
            ("http://test/playback/0/1?torrent_name=Foo.S01E02.1080p", "Foo.S01E02.1080p.srt"),
            ("http://test/playback/1?filename=Meu.Filme.2020.mp4", "Meu.Filme.2020.srt"),
            ("http://test/playback/1?name=Link%20Click", "Link Click.srt"),
            ("http://test/Epis%25C3%25B3dio%252001.mkv", "Episódio 01.srt"),
        ]
        for url, expected in cases:
            with self.subTest(url=url), self.working_directory():
                self.run_cli(url, resolved="http://cdn/opaque")
                self.assertTrue(Path(expected).is_file())

    def test_cli_auto_output_sanitizes_server_names_and_has_safe_fallback(self):
        cases = [("../folder\\Episode:01?.mkv", "Episode_01_.srt"), ("CON.mkv", "_CON.srt"), (None, "legenda.srt")]
        for filename, expected in cases:
            with self.subTest(filename=filename), self.working_directory() as folder:
                self.run_cli("http://test/opaque?token=secret", filename=filename)
                self.assertEqual([p.name for p in folder.iterdir()], [expected])

    def test_cli_json_without_output_saves_file_and_preserves_existing_download(self):
        with self.working_directory():
            Path("Episode.srt").write_text("keep me", encoding="utf-8")
            result = json.loads(self.run_cli("http://test/Episode.mkv", ["--json"]))
            self.assertEqual(result["output_file"], "Episode (1).srt")
            self.assertTrue(Path(result["output_file"]).is_file())
            self.assertEqual(Path("Episode.srt").read_text(encoding="utf-8"), "keep me")

    def test_cli_stdout_does_not_save_and_explicit_output_overrides_default(self):
        with self.working_directory() as folder:
            content = self.run_cli("http://test/Original.mkv", ["--stdout"])
            self.assertTrue(content.startswith("1\r\n"))
            self.assertEqual(list(folder.iterdir()), [])
            self.run_cli("http://test/Original.mkv", ["-o", "chosen"])
            self.assertEqual([p.name for p in folder.iterdir()], ["chosen.srt"])

    def test_cli_auto_output_handles_both_and_all_mixed_codecs(self):
        for flag, expected in [("--both", ["Series.E01.srt", "Series.E01.forced.ass"]),
                               ("--all", ["Series.E01_track7_por.srt", "Series.E01_track8_por.ass"])]:
            with self.subTest(flag=flag), self.working_directory():
                result = json.loads(self.run_cli("http://test/Series.E01.mkv", [flag, "--json"], extra_codec="S_TEXT/ASS"))
                self.assertEqual([r["output_file"] for r in result], expected)
                self.assertTrue(all(Path(name).is_file() for name in expected))

    def test_api_without_output_still_returns_content_without_writing(self):
        with self.working_directory() as folder:
            result = self.extract(fixture())
            self.assertNotIn("output_file", result)
            self.assertEqual(list(folder.iterdir()), [])

    def test_missing_statistics_is_explicitly_unverified_and_strict_refuses(self):
        result = self.extract(fixture())
        self.assertEqual(result["coverage"], "unverified")
        self.assertEqual(result["strategy"], "best_effort")
        self.assertFalse(result["complete_verified"])
        with self.assertRaises(RemoteMkvError):
            self.extract(fixture(), strict=True)

    def test_statistics_read_from_real_tags_enable_strict_and_detect_missing_frames(self):
        result = self.extract(fixture(statistics_frames=2), strict=True)
        self.assertEqual(result["coverage"], "verified")
        self.assertTrue(result["complete_verified"])
        with self.assertRaises(RemoteMkvError):
            self.extract(fixture(statistics_frames=3))

    def test_strict_rejects_cue_to_fake_block_inside_void_payload(self):
        fake = el(0xA3, b"\x87\x00\x00\x00FAKE SUBTITLE")
        blob = fixture(samples=[(1000, 0, 1000, None, "REAL SUBTITLE")], prefix=el(0xEC, fake), statistics_frames=1, cue_relative_position=9)
        with self.assertRaises(RemoteMkvError):
            self.extract(blob, strict=True)

    def test_auto_all_tracks_cannot_create_directories_from_track_names(self):
        with self.working_directory() as folder, self.remote(fixture(extra_codec="S_TEXT/ASS", track_name="Portuguese/../other-track")):
            result = extractor.extract_remote_subtitle("http://test/Episode.mkv", all_tracks=True, auto_output=True)
            paths = [Path(r["output_file"]) for r in result]
            self.assertTrue(all(p.parent == Path(".") for p in paths))
            self.assertEqual(len(list(folder.iterdir())), 2)
            self.assertTrue(all(p.is_file() for p in paths))

    def test_explicit_all_output_sanitizes_track_names_inside_selected_directory(self):
        with self.working_directory() as folder, self.remote(fixture(extra_codec="S_TEXT/ASS", track_name="Portuguese/../other-track")):
            out = folder / "selected" / "Episode.srt"
            result = extractor.extract_remote_subtitle("http://test/Episode.mkv", all_tracks=True, output_path=out)
            self.assertTrue(all(Path(r["output_file"]).parent == out.parent for r in result))
            self.assertEqual(len(list(out.parent.iterdir())), 2)

    def test_long_all_output_keeps_track_identity_before_truncation(self):
        with self.working_directory() as folder:
            result = self.extract(fixture(extra_codec="S_TEXT/UTF8"), all_tracks=True, output_path=folder / ("a" * 240 + ".srt"))
            names = [Path(r["output_file"]).name for r in result]
            self.assertNotEqual(names[0], names[1])
            self.assertIn("_track7_", names[0])
            self.assertIn("_track8_", names[1])
            self.assertEqual(len(list(folder.iterdir())), 2)

    def test_failure_to_publish_preserves_previous_output_and_removes_temporary(self):
        with self.working_directory() as folder:
            path = folder / "episode.srt"
            path.write_text("previous valid subtitle", encoding="utf-8")
            with mock.patch("os.replace", side_effect=OSError("disk failure")), self.assertRaises(OSError):
                self.extract(fixture(), output_path=path)
            self.assertEqual(path.read_text(encoding="utf-8"), "previous valid subtitle")
            self.assertEqual(list(folder.iterdir()), [path])

    def test_all_reuses_each_cluster_header_once(self):
        blob = fixture(extra_codec="S_TEXT/ASS")
        self.extract(blob, all_tracks=True)
        cluster_ranges = [r for r in self.ranges if r[1] - r[0] == 63 and blob[r[0]:r[0]+4] == b"\x1f\x43\xb6\x75"]
        self.assertEqual(len(cluster_ranges), 2)
        self.assertEqual(len(set(cluster_ranges)), 2)

    def test_concurrent_auto_downloads_reserve_distinct_output_files(self):
        from concurrent.futures import ThreadPoolExecutor
        import threading

        barrier = threading.Barrier(2, timeout=10)
        local = threading.local()
        original_link = os.link

        def synchronized_link(source, destination, *args, **kwargs):
            if not getattr(local, "arrived", False):
                local.arrived = True
                barrier.wait()
            return original_link(source, destination, *args, **kwargs)

        with self.working_directory() as folder, self.remote(fixture()), mock.patch("os.link", synchronized_link):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: extractor.extract_remote_subtitle("http://test/Episode.mkv", auto_output=True), range(2)))
            self.assertEqual({r["output_file"] for r in results}, {"m.srt", "m (1).srt"})
            self.assertEqual(len(list(folder.iterdir())), 2)

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


class TestDownloadFilename(unittest.TestCase):
    def test_resolution_reuses_range_response_for_content_disposition(self):
        for header, expected in [
            ('attachment; filename="Episode.S01E01.mkv"', "Episode.S01E01.mkv"),
            ("attachment; filename*=UTF-8''Epis%C3%B3dio%2001.mkv", "Episódio 01.mkv"),
            ('attachment; filename="fallback.mkv"; filename*=UTF-8\'\'Epis%C3%B3dio%2001.mkv', "Episódio 01.mkv"),
        ]:
            with self.subTest(header=header):
                response = mock.MagicMock()
                response.__enter__.return_value = response
                response.geturl.return_value = "http://cdn/opaque"
                response.headers = {"Content-Range": "bytes 0-0/1000", "Content-Disposition": header}
                response.status = 206
                response.read.return_value = b"x"
                metadata = {}
                with mock.patch.object(http_module, "open_http", return_value=response):
                    result = http_module.resolve_url("http://source/redirect", metadata=metadata)
                self.assertEqual(result, ("http://cdn/opaque", 1000))
                self.assertEqual(metadata["filename"], expected)


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
                    self.send_header("Content-Disposition", "attachment; filename*=UTF-8''Epis%C3%B3dio%2001.mkv")
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
                    previous = Path.cwd()
                    with tempfile.TemporaryDirectory() as tmp:
                        try:
                            os.chdir(tmp)
                            # Keep the HTTP requests real while making the FFmpeg cost comparison deterministic.
                            with mock.patch.object(extractor, "measure_rtt", return_value=0.001):
                                result = extractor.extract_remote_subtitle(
                                    f"http://127.0.0.1:{server.server_port}/m.mkv", timeout=5, auto_output=True
                                )
                            self.assertEqual(result["output_file"], "Episódio 01.srt")
                            self.assertEqual(Path(result["output_file"]).read_bytes(), result["content"].encode("utf-8"))
                        finally:
                            os.chdir(previous)
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
