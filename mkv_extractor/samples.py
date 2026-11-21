"""Frames laced e ContentEncodings; não executa nenhuma leitura HTTP."""
import bz2
import zlib

from .ebml import iter_elements, read_uint, read_vint
from .errors import MatroskaStructureError, UnsupportedFeatureError

MAX_SAMPLE_BYTES = 8 * 1024 * 1024


def split_frames(payload, flags):
    mode = (flags >> 1) & 3
    if mode == 0:
        return [payload]
    if not payload:
        raise MatroskaStructureError("Cabeçalho de lacing truncado.")
    count, pos = payload[0] + 1, 1
    if count < 2:
        raise MatroskaStructureError("Lacing exige pelo menos dois frames.")
    sizes = []
    if mode == 2:
        if (len(payload) - pos) % count:
            raise MatroskaStructureError("Fixed lacing com frames de tamanhos diferentes.")
        sizes = [(len(payload) - pos) // count] * (count - 1)
    elif mode == 1:
        for _ in range(count - 1):
            size = 0
            while True:
                if pos >= len(payload):
                    raise MatroskaStructureError("Xiph lacing truncado.")
                value = payload[pos]
                pos += 1
                size += value
                if value != 255:
                    break
            sizes.append(size)
    else:
        size, width = read_vint(payload, pos)
        pos += width
        sizes.append(size)
        for _ in range(count - 2):
            delta, width = read_vint(payload, pos)
            pos += width
            sizes.append(sizes[-1] + delta - ((1 << (width * 7 - 1)) - 1))
    sizes.append(len(payload) - pos - sum(sizes))
    if any(size <= 0 for size in sizes):
        raise MatroskaStructureError("Tamanhos de frames laced inválidos.")
    frames = []
    for size in sizes:
        frames.append(payload[pos:pos + size])
        pos += size
    return frames


def parse_encodings(data, parent):
    encodings = []
    for element in iter_elements(data, parent["content_start"], parent["content_end"]):
        if element["id"] != 0x6240:
            continue
        if len(encodings) >= 8:
            raise UnsupportedFeatureError("unsupported_compression", "Muitas camadas de ContentEncoding.")
        encoding = {"order": 0, "scope": 1, "type": 0, "algorithm": 0, "settings": b""}
        for child in iter_elements(data, element["content_start"], element["content_end"]):
            key = {0x5031: "order", 0x5032: "scope", 0x5033: "type"}.get(child["id"])
            if key:
                encoding[key] = read_uint(data, child)
            elif child["id"] == 0x5034:
                for comp in iter_elements(data, child["content_start"], child["content_end"]):
                    if comp["id"] == 0x4254:
                        encoding["algorithm"] = read_uint(data, comp)
                    elif comp["id"] == 0x4255:
                        encoding["settings"] = data[comp["content_start"]:comp["content_end"]]
            elif child["id"] == 0x5035:
                encoding["type"] = 1
        encodings.append(encoding)
    if len({e["order"] for e in encodings}) != len(encodings):
        raise MatroskaStructureError("ContentEncodingOrder duplicado.")
    return encodings


def decode_track_data(payload, track, scope=1, max_bytes=MAX_SAMPLE_BYTES):
    for encoding in sorted(track.get("encodings", []), key=lambda e: e["order"], reverse=True):
        if encoding["scope"] & 4 or not 0 < encoding["scope"] <= 3:
            raise UnsupportedFeatureError("unsupported_compression", "ContentEncodingScope não suportado.")
        if not encoding["scope"] & scope:
            continue
        if encoding["type"] != 0 or encoding["algorithm"] not in (0, 1, 3):
            raise UnsupportedFeatureError("unsupported_compression", "Compressão ou criptografia não suportada.")
        try:
            if encoding["algorithm"] == 3:
                payload = encoding["settings"] + payload
            else:
                decoder = zlib.decompressobj() if encoding["algorithm"] == 0 else bz2.BZ2Decompressor()
                payload = decoder.decompress(payload, max_bytes + 1)
                if not decoder.eof or decoder.unused_data:
                    raise MatroskaStructureError("Sample comprimido truncado, excedente ou muito grande.")
        except (zlib.error, OSError, EOFError, ValueError) as exc:
            raise MatroskaStructureError("Sample comprimido inválido.") from exc
        if len(payload) > max_bytes:
            raise MatroskaStructureError("Sample descomprimido excede o limite.")
    if len(payload) > max_bytes:
        raise MatroskaStructureError("Sample excede o limite.")
    return payload
