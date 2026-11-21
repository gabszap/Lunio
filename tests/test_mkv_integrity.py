import unittest
from unittest import mock

from mkv_extractor import ebml, matroska
from mkv_extractor.errors import RemoteMkvError
from tests.test_mkv_srt import el, uint


class TestContainerBoundaries(unittest.TestCase):
    def test_child_may_not_escape_parent(self):
        data = el(0xEC, b"payload")
        with self.assertRaises(RemoteMkvError):
            list(ebml.iter_elements(data, 0, len(data) - 1))

    def test_tracks_inside_payload_are_not_top_level_tracks(self):
        fake = el(0x1654AE6B, el(0xAE, uint(0xD7, 9) + uint(0x83, 17)))
        head = el(0x18538067, el(0xEC, fake))
        with self.assertRaises(RemoteMkvError):
            matroska.find_tracks(head)

    def test_fake_segment_in_payload_is_not_document_segment(self):
        with self.assertRaises(RemoteMkvError):
            matroska.find_segment(el(0xEC, el(0x18538067, b"")))

    def test_block_offset_outside_cluster_is_rejected_before_http(self):
        cues = [{"cluster_position": 0, "relative_position": 100, "time": 0}]
        header = {0: {"header_size": 12, "size": 20, "unknown_size": False}}
        with mock.patch.object(matroska, "read_ranges", side_effect=AssertionError("out-of-bounds HTTP read")), self.assertRaises(RemoteMkvError):
            matroska.fetch_and_parse_blocks("http://test/", 0, cues, header, 1000, expected_track=1)

    def test_unknown_size_is_not_accepted_for_leaf(self):
        with self.assertRaises(RemoteMkvError):
            ebml.read_element(b"\xec\xffpayload")

    def test_invalid_timecode_scale_is_rejected(self):
        head = el(0x18538067, el(0x1549A966, uint(0x2AD7B1, 0)))
        with self.assertRaises(RemoteMkvError):
            matroska.get_timecode_scale(head)

    def test_cues_signature_inside_void_is_not_accepted_as_index(self):
        blob = el(0x18538067, el(0xEC, el(0x1C53BB6B, b"")))
        start, _ = matroska.find_segment(blob)
        with mock.patch.object(matroska, "read_range", side_effect=lambda url, a, b, **kw: blob[a:b+1]), self.assertRaises(RemoteMkvError):
            matroska.discover_cues("http://test/", len(blob), start, blob)


class TestCoverage(unittest.TestCase):
    def test_statistics_must_target_track_and_match_writer_and_frame_count(self):
        info = {"writing_app": "mkvmerge", "duration_ms": 10000}
        tags = {7: {"_STATISTICS_WRITING_APP": "mkvmerge", "NUMBER_OF_FRAMES": "2", "DURATION": "00:00:09.500000000"}}
        track = {"track_uid": 7}
        self.assertEqual(matroska.cue_coverage(info, tags, track, 2), "verified")
        self.assertEqual(matroska.cue_coverage(info, tags, track, 1), "incomplete")
        self.assertEqual(matroska.cue_coverage(info, tags, {"track_uid": 8}, 2), "unverified")
        self.assertEqual(matroska.cue_coverage({**info, "writing_app": "other"}, tags, track, 2), "unverified")
        self.assertEqual(matroska.cue_coverage(info, tags, track, 3), "invalid")


class TestBlockFrames(unittest.TestCase):
    def test_all_lacing_modes_return_exact_frames(self):
        for flags, payload, expected in [
            (0, b"abc", [b"abc"]),
            (4, b"\x02abcdef", [b"ab", b"cd", b"ef"]),
            (2, b"\x02\x01\x02abcdef", [b"a", b"bc", b"def"]),
            (6, b"\x02\x81\xc0abcdef", [b"a", b"bc", b"def"]),
        ]:
            with self.subTest(flags=flags):
                block = matroska.parse_block_element(el(0xA3, b"\x81\x00\x00" + bytes([flags]) + payload))
                self.assertEqual(block["frames"], expected)

    def test_compressed_frames_and_header_stripping_are_decoded(self):
        import zlib
        import bz2
        data = "Olá legenda".encode()
        for algorithm, payload, settings in [(0, zlib.compress(data), b""), (1, bz2.compress(data), b""), (3, data[4:], data[:4])]:
            with self.subTest(algorithm=algorithm):
                track = {"encodings": [{"order": 0, "scope": 1, "type": 0, "algorithm": algorithm, "settings": settings}]}
                self.assertEqual(matroska.decode_track_data(payload, track), data)

    def test_unsupported_compression_and_malformed_lacing_fail_explicitly(self):
        with self.assertRaises(RemoteMkvError):
            matroska.decode_track_data(b"data", {"encodings": [{"order": 0, "scope": 1, "type": 0, "algorithm": 2, "settings": b""}]})
        with self.assertRaises(RemoteMkvError):
            matroska.parse_block_element(el(0xA3, b"\x81\x00\x00\x04\x02abcde"))
