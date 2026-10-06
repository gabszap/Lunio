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


if __name__ == "__main__":
    unittest.main()
