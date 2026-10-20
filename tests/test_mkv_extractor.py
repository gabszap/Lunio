"""
Testes automatizados para o pacote mkv_extractor.
Cobre EBML, Subtitles, seleção de tracks, formatação ASS e validação de consistência.
"""

import unittest
import os
import sys

# Adiciona o diretório raiz ao path para importação
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from mkv_extractor.ebml import read_vint, read_id, read_uint, read_string
from mkv_extractor.subtitles import (
    ms_to_ass_time,
    parse_ass_sample,
    select_all_subtitle_tracks,
    select_subtitle_pair,
    select_subtitle_track,
)
from mkv_extractor.errors import TrackNotFoundError, CodecNotSupportedError
from mkv_extractor.extractor import cue_times_seconds
from unittest import mock

from mkv_extractor import extractor as extractor_module
from mkv_extractor.errors import HttpRangeError, PreferFfmpegError
from mkv_extractor.http import close_connections, read_range, safe_url, supports_multirange


class TestEbml(unittest.TestCase):
    def test_read_vint_single_byte(self):
        # 0x81 -> comprimento 1 byte, valor 1
        data = bytes([0x81])
        val, length = read_vint(data, 0)
        self.assertEqual(val, 1)
        self.assertEqual(length, 1)

    def test_read_vint_two_bytes(self):
        # 0x40 0x02 -> comprimento 2 bytes, valor 2
        data = bytes([0x40, 0x02])
        val, length = read_vint(data, 0)
        self.assertEqual(val, 2)
        self.assertEqual(length, 2)

    def test_read_id(self):
        # Segment ID: 0x18 0x53 0x80 0x67
        data = bytes([0x18, 0x53, 0x80, 0x67])
        elem_id, length = read_id(data, 0)
        self.assertEqual(elem_id, 0x18538067)
        self.assertEqual(length, 4)

    def test_read_uint(self):
        # Elemento: ID (0x71) + Size (1 byte de tamanho 2 = 0x82) + 2 bytes de dados (0x01, 0x02 = 258)
        data = bytes([0x71, 0x82, 0x01, 0x02])
        elem = {"content_start": 2, "content_end": 4}
        self.assertEqual(read_uint(data, elem), 258)

    def test_read_string(self):
        raw_str = b"Brazilian"
        data = bytes([0x86, 0x80 | len(raw_str)]) + raw_str
        elem = {"content_start": 2, "content_end": 2 + len(raw_str)}
        self.assertEqual(read_string(data, elem), "Brazilian")


class TestSubtitles(unittest.TestCase):
    def test_ms_to_ass_time(self):
        # 0 ms -> 0:00:00.00
        self.assertEqual(ms_to_ass_time(0), "0:00:00.00")
        # 1050 ms -> 0:00:01.05
        self.assertEqual(ms_to_ass_time(1050), "0:00:01.05")
        # 65430 ms -> 0:01:05.43
        self.assertEqual(ms_to_ass_time(65430), "0:01:05.43")
        # 3661230 ms -> 1:01:01.23
        self.assertEqual(ms_to_ass_time(3661230), "1:01:01.23")

    def test_parse_ass_sample_with_readorder(self):
        # Sample format: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
        payload = b"12,0,Default,,0,0,0,,Hello world!"
        sample = parse_ass_sample(payload)
        self.assertEqual(sample["read_order"], 12)
        self.assertEqual(sample["layer"], "0")
        self.assertEqual(sample["style"], "Default")
        self.assertEqual(sample["text"], "Hello world!")

    def test_parse_ass_sample_invalid(self):
        payload = b"Invalido sem virgulas"
        with self.assertRaises(ValueError):
            parse_ass_sample(payload)

    def test_select_subtitle_track_normal_vs_forced(self):
        tracks = [
            {
                "track_number": 2,
                "track_type": 1,  # Video
                "codec_id": "V_MPEG4/ISO/AVC",
            },
            {
                "track_number": 21,
                "track_type": 17,  # Subtitle
                "codec_id": "S_TEXT/ASS",
                "language": "por",
                "name": "Brazilian (Forced)",
                "flag_forced": 1,
                "flag_default": 0,
            },
            {
                "track_number": 22,
                "track_type": 17,  # Subtitle
                "codec_id": "S_TEXT/ASS",
                "language": "por",
                "name": "Brazilian",
                "flag_forced": 0,
                "flag_default": 0,
            },
            {
                "track_number": 23,
                "track_type": 17,
                "codec_id": "S_TEXT/ASS",
                "language": "eng",
                "name": "English",
                "flag_forced": 0,
                "flag_default": 1,
            },
        ]

        # 1. Pedindo português normal (não forced) -> Deve escolher track 22
        sel_normal = select_subtitle_track(tracks, language="por", forced=False, prefer="brazilian")
        self.assertEqual(sel_normal["track_number"], 22)

        # 2. Pedindo português forced -> Deve escolher track 21
        sel_forced = select_subtitle_track(tracks, language="por", forced=True, prefer="brazilian")
        self.assertEqual(sel_forced["track_number"], 21)

        # 3. Pedindo inglês -> Deve escolher track 23
        sel_eng = select_subtitle_track(tracks, language="eng", forced=False)
        self.assertEqual(sel_eng["track_number"], 23)

        # 4. Pedindo track explícita número 21
        sel_explicit = select_subtitle_track(tracks, track_number=21)
        self.assertEqual(sel_explicit["track_number"], 21)

    def test_select_subtitle_pair(self):
        tracks = [
            {"track_number": 1, "track_type": 1, "codec_id": "V_MPEG4/ISO/AVC"},
            {"track_number": 21, "track_type": 17, "codec_id": "S_TEXT/ASS", "language": "por", "name": "Brazilian (Forced)", "flag_forced": 1},
            {"track_number": 22, "track_type": 17, "codec_id": "S_TEXT/ASS", "language": "por", "name": "Brazilian", "flag_forced": 0},
            {"track_number": 23, "track_type": 17, "codec_id": "S_TEXT/ASS", "language": "eng", "name": "English", "flag_forced": 0},
        ]
        pair = select_subtitle_pair(tracks, language="por", prefer="brazilian")
        self.assertEqual(len(pair), 2)
        self.assertEqual(pair[0]["track_number"], 22)  # Completa
        self.assertEqual(pair[1]["track_number"], 21)  # Forçada

    def test_select_all_subtitle_tracks(self):
        tracks = [
            {"track_number": 1, "track_type": 1, "codec_id": "V_MPEG4/ISO/AVC"},
            {"track_number": 21, "track_type": 17, "codec_id": "S_TEXT/ASS", "language": "por", "name": "Brazilian (Forced)", "flag_forced": 1},
            {"track_number": 22, "track_type": 17, "codec_id": "S_TEXT/ASS", "language": "por", "name": "Brazilian", "flag_forced": 0},
            {"track_number": 23, "track_type": 17, "codec_id": "S_TEXT/ASS", "language": "eng", "name": "English", "flag_forced": 0},
        ]
        all_subs = select_all_subtitle_tracks(tracks)
        self.assertEqual(len(all_subs), 3)
        self.assertEqual([t["track_number"] for t in all_subs], [21, 22, 23])

    def test_select_subtitle_track_not_found(self):
        tracks = [
            {
                "track_number": 1,
                "track_type": 1,
                "codec_id": "V_MPEG4/ISO/AVC",
            }
        ]
        with self.assertRaises(TrackNotFoundError):
            select_subtitle_track(tracks, language="por")


class TestExtractedFiles(unittest.TestCase):
    def test_ep1_extracted_ass(self):
        ass_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ep1_modular.ass"))
        if not os.path.exists(ass_path):
            self.skipTest("ep1_modular.ass não encontrado localmente")
        with open(ass_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        dialogues = [line for line in lines if line.startswith("Dialogue:")]
        self.assertEqual(len(dialogues), 482, f"Esperado 482 eventos no EP1, obteve {len(dialogues)}")

    def test_ep2_extracted_ass(self):
        ass_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ep2_modular.ass"))
        if not os.path.exists(ass_path):
            self.skipTest("ep2_modular.ass não encontrado localmente")
        with open(ass_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        dialogues = [line for line in lines if line.startswith("Dialogue:")]
        self.assertEqual(len(dialogues), 400, f"Esperado 400 eventos no EP2, obteve {len(dialogues)}")



class TestKeyframeCues(unittest.TestCase):
    def _cue(self, time, track):
        return {"time": time, "positions": [{"track": track, "cluster_position": 0, "relative_position": 0, "duration": None}]}

    def test_cue_times_use_timecode_scale_and_only_the_video_track(self):
        cues = [self._cue(0, 1), self._cue(4000, 1), self._cue(4000, 2), self._cue(9500, 1), self._cue(2000, 2)]
        # escala padrão do Matroska: 1 ms por unidade
        self.assertEqual(cue_times_seconds(cues, 1, 1_000_000), [0.0, 4.0, 9.5])
        self.assertEqual(cue_times_seconds(cues, 2, 1_000_000), [2.0, 4.0])

    def test_cue_times_with_other_scale(self):
        cues = [self._cue(10, 1), self._cue(20, 1)]
        # 100 ms por unidade
        self.assertEqual(cue_times_seconds(cues, 1, 100_000_000), [1.0, 2.0])

    def test_cue_times_sorted_and_deduplicated(self):
        cues = [self._cue(9000, 1), self._cue(1000, 1), self._cue(1000, 1)]
        self.assertEqual(cue_times_seconds(cues, 1, 1_000_000), [1.0, 9.0])

    def test_no_cues_for_track(self):
        self.assertEqual(cue_times_seconds([self._cue(1000, 2)], 1, 1_000_000), [])


class TestHttpErrors(unittest.TestCase):
    """O CDN do TorBox responde 429 quando há conexões demais: o erro precisa carregar o status e não a URL (token)."""

    def _serve(self, status, retry_after=None):
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(status)
                if retry_after:
                    self.send_header("Retry-After", str(retry_after))
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/dld/abc?token=SEGREDO123"

    def test_429_carries_status_and_retry_after_without_the_token(self):
        url = self._serve(429, retry_after=7)
        with self.assertRaises(HttpRangeError) as ctx:
            read_range(url, 0, 10, timeout=5)
        err = ctx.exception
        self.assertEqual(err.status, 429)
        self.assertEqual(err.retry_after, 7)
        self.assertNotIn("SEGREDO123", str(err))
        self.assertNotIn("/dld/abc", str(err))

    def test_429_without_retry_after(self):
        url = self._serve(429)
        with self.assertRaises(HttpRangeError) as ctx:
            read_range(url, 0, 10, timeout=5)
        self.assertEqual(ctx.exception.status, 429)
        self.assertIsNone(ctx.exception.retry_after)

    def test_connection_failure_has_no_status_and_no_token(self):
        with self.assertRaises(HttpRangeError) as ctx:
            read_range("http://127.0.0.1:9/dld/abc?token=SEGREDO123", 0, 10, timeout=2)
        self.assertIsNone(ctx.exception.status)
        self.assertNotIn("SEGREDO123", str(ctx.exception))

    def test_safe_url_keeps_only_the_host(self):
        self.assertEqual(safe_url("https://cdn.test/dld/abc?token=x"), "https://cdn.test/…")


class _SingleRangeServer:
    """Servidor que, como o CDN do TorBox, devolve só o primeiro range quando vêm vários, e conta as conexões abertas."""

    def __init__(self, testcase):
        import http.server
        import socketserver
        import threading

        outer = self
        self.connections = 0
        self.requests = 0

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                outer.requests += 1
                first = self.headers.get("Range", "bytes=0-0").replace("bytes=", "").split(",")[0]
                start, end = (int(x) for x in first.split("-"))
                body = bytes(range(256)) * ((end - start) // 256 + 1)
                body = body[: end - start + 1]
                self.send_response(206)
                self.send_header("Content-Type", "video/x-matroska")
                self.send_header("Content-Range", f"bytes {start}-{end}/100000")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

            def get_request(self):
                request = super().get_request()
                outer.connections += 1
                return request

        self.server = Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        testcase.addCleanup(self.server.shutdown)
        testcase.addCleanup(close_connections)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/dld/abc?token=SEGREDO123"


class TestKeepAliveAndCost(unittest.TestCase):
    def test_many_ranges_reuse_one_connection(self):
        srv = _SingleRangeServer(self)
        for i in range(8):
            data = read_range(srv.url, i * 10, i * 10 + 9, timeout=5)
            self.assertEqual(len(data), 10)
        self.assertEqual(srv.requests, 8)
        self.assertEqual(srv.connections, 1)

    def test_detects_server_without_multirange(self):
        srv = _SingleRangeServer(self)
        self.assertFalse(supports_multirange(srv.url, timeout=5))

    def _cues(self, n):
        return [{"cluster_position": i * 1000, "relative_position": 5, "time": i} for i in range(n)]

    def test_estimate_costs_counts_cluster_header_plus_two_requests_per_cue(self):
        requests, est_extractor, est_ffmpeg = extractor_module.estimate_costs(935_568_536, self._cues(362), 0.2)
        self.assertEqual(requests, 362 + 2 * 362)
        self.assertAlmostEqual(est_extractor, requests * 0.2)
        self.assertAlmostEqual(est_ffmpeg, 935_568_536 / extractor_module.FFMPEG_THROUGHPUT_BYTES_PER_S)

    def test_estimate_costs_uses_the_ffmpeg_speed_it_is_given(self):
        _, _, est_slow = extractor_module.estimate_costs(800_000_000, self._cues(10), 0.2, 10_000_000)
        _, _, est_fast = extractor_module.estimate_costs(800_000_000, self._cues(10), 0.2, 80_000_000)
        self.assertAlmostEqual(est_slow, 80.0)
        self.assertAlmostEqual(est_fast, 10.0)

    def test_a_slower_ffmpeg_makes_the_extractor_worth_it_and_a_faster_one_does_not(self):
        with mock.patch.object(extractor_module, "supports_multirange", return_value=False),              mock.patch.object(extractor_module, "measure_rtt", return_value=0.2):
            # ~1086 requisições x 0,2 s = ~217 s no extrator; o FFmpeg lendo 935 MB a 3 MB/s levaria ~312 s: o extrator compensa
            extractor_module.check_extractor_is_worth_it("http://x/", 935_568_536, self._cues(362), 5, False, 3_000_000)
            # a 40 MB/s (o padrão) ele leva ~23 s: melhor o FFmpeg
            with self.assertRaises(PreferFfmpegError):
                extractor_module.check_extractor_is_worth_it("http://x/", 935_568_536, self._cues(362), 5, False, 40_000_000)

    def test_prefer_ffmpeg_error_carries_the_file_size_for_the_server_to_measure(self):
        with mock.patch.object(extractor_module, "supports_multirange", return_value=False),              mock.patch.object(extractor_module, "measure_rtt", return_value=0.2):
            with self.assertRaises(PreferFfmpegError) as ctx:
                extractor_module.check_extractor_is_worth_it("http://x/", 935_568_536, self._cues(362), 5, False)
            self.assertEqual(ctx.exception.total_size, 935_568_536)

    def test_prefers_ffmpeg_when_many_cues_and_no_multirange(self):
        with mock.patch.object(extractor_module, "supports_multirange", return_value=False),              mock.patch.object(extractor_module, "measure_rtt", return_value=0.2):
            with self.assertRaises(PreferFfmpegError):
                extractor_module.check_extractor_is_worth_it("http://x/", 935_568_536, self._cues(362), 5, False)

    def test_keeps_extractor_for_huge_files_or_few_cues(self):
        with mock.patch.object(extractor_module, "supports_multirange", return_value=False),              mock.patch.object(extractor_module, "measure_rtt", return_value=0.2):
            # remux de 40 GB: ler tudo leva ~1000 s, as ~870 requisições ~175 s
            extractor_module.check_extractor_is_worth_it("http://x/", 40_000_000_000, self._cues(362), 5, False)
            # poucos blocos
            extractor_module.check_extractor_is_worth_it("http://x/", 935_568_536, self._cues(10), 5, False)

    def test_never_prefers_ffmpeg_when_server_supports_multirange(self):
        with mock.patch.object(extractor_module, "supports_multirange", return_value=True),              mock.patch.object(extractor_module, "measure_rtt", side_effect=AssertionError("nao deveria medir")):
            extractor_module.check_extractor_is_worth_it("http://x/", 935_568_536, self._cues(5000), 5, False)


class TestAttachments(unittest.TestCase):
    """Fontes anexadas: o bloco Attachments é lido por Range a partir da posição do SeekHead."""

    @staticmethod
    def _el(element_id: int, payload: bytes) -> bytes:
        id_bytes = element_id.to_bytes((element_id.bit_length() + 7) // 8, "big")
        return id_bytes + b"\x01" + len(payload).to_bytes(7, "big") + payload

    def _mkv(self, files, with_seek=True):
        el = self._el
        attached = b"".join(el(0x61A7, el(0x466E, name.encode()) + el(0x465C, data)) for name, data in files)
        attachments = el(0x1941A469, attached)

        def seekhead(position):
            entry = el(0x4DBB, el(0x53AB, (0x1941A469).to_bytes(4, "big")) + el(0x53AC, position.to_bytes(4, "big")))
            return el(0x114D9B74, entry)

        seek_len = len(seekhead(0))
        info = el(0x1549A966, b"\x00" * 8)
        position = seek_len + len(info)
        body = (seekhead(position) if with_seek else el(0x114D9B74, b"")) + info + attachments
        segment = el(0x18538067, body)
        return el(0x1A45DFA3, b"\x00" * 4) + segment

    def _extract(self, blob, out_dir):
        def fake_read_range(url, start, end, timeout=60, verbose=False):
            return blob[start:end + 1]

        with mock.patch.object(extractor_module, "resolve_url", return_value=("http://cdn/x.mkv", len(blob))), \
             mock.patch.object(extractor_module, "read_range", side_effect=fake_read_range):
            return extractor_module.extract_attachments("http://x/", out_dir, timeout=5)

    def test_reads_files_in_order_and_writes_only_ordinal_names(self):
        import tempfile

        files = [("..\\evil/arial.ttf", b"AAAA" * 10), ("fonte.otf", b"OTTO" + b"\x01" * 50)]
        with tempfile.TemporaryDirectory() as tmp:
            result = self._extract(self._mkv(files), tmp)
            self.assertEqual([r["filename"] for r in result], [f[0] for f in files])
            self.assertEqual([r["size"] for r in result], [40, 54])
            self.assertEqual(sorted(os.listdir(tmp)), ["a0.bin", "a1.bin"])
            with open(os.path.join(tmp, "a1.bin"), "rb") as fh:
                self.assertEqual(fh.read(), files[1][1])

    def test_without_seekhead_entry_raises_so_server_falls_back_to_ffmpeg(self):
        import tempfile
        from mkv_extractor.errors import MatroskaStructureError

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(MatroskaStructureError):
                self._extract(self._mkv([("a.ttf", b"x" * 10)], with_seek=False), tmp)
            self.assertEqual(os.listdir(tmp), [])


if __name__ == "__main__":
    unittest.main()
