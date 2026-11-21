"""
Parser de estruturas do container Matroska (MKV):
Segment, Info, Tracks, SeekHead, Cues, Clusters, BlockGroup e SimpleBlock.
"""

from typing import Any
import math
import re
import struct
from datetime import datetime, timedelta, timezone
from .ebml import (
    iter_elements,
    read_element,
    read_element_header,
    read_string,
    read_uint,
    read_vint,
    find_all_valid_elements,
)
from .errors import (
    CuesNotFoundError,
    MatroskaStructureError,
    NoRelativePositionError,
)
from .http import read_range, read_ranges, _state
from .samples import split_frames, decode_track_data, parse_encodings

# ============================================================
# MATROSKA ELEMENT IDS
# ============================================================
SEGMENT_ID = 0x18538067

SEEKHEAD_ID = 0x114D9B74
SEEK_ID = 0x4DBB
SEEK_ID_ID = 0x53AB
SEEK_POSITION_ID = 0x53AC

INFO_ID = 0x1549A966
TIMECODE_SCALE_ID = 0x2AD7B1

TRACKS_ID = 0x1654AE6B
TRACK_ENTRY_ID = 0xAE

TRACK_NUMBER_ID = 0xD7
TRACK_UID_ID = 0x73C5
TRACK_TYPE_ID = 0x83
NAME_ID = 0x536E
LANGUAGE_ID = 0x22B59C
CODEC_ID = 0x86
CODEC_PRIVATE_ID = 0x63A2

FLAG_DEFAULT_ID = 0x88
FLAG_FORCED_ID = 0x55AA

CUES_ID = 0x1C53BB6B
CUE_POINT_ID = 0xBB
CUE_TIME_ID = 0xB3
CUE_TRACK_POSITIONS_ID = 0xB7
CUE_TRACK_ID = 0xF7
CUE_CLUSTER_POSITION_ID = 0xF1
CUE_RELATIVE_POSITION_ID = 0xF0
CUE_DURATION_ID = 0xB2

ATTACHMENTS_ID = 0x1941A469
ATTACHED_FILE_ID = 0x61A7
FILE_NAME_ID = 0x466E
FILE_DATA_ID = 0x465C

CLUSTER_ID = 0x1F43B675
CLUSTER_TIMESTAMP_ID = 0xE7
BLOCK_GROUP_ID = 0xA0
BLOCK_ID = 0xA1
SIMPLE_BLOCK_ID = 0xA3
BLOCK_DURATION_ID = 0x9B

RANGE_HEADER_SIZE = 64
MAX_CUES_BYTES = 64 * 1024 * 1024
MAX_BLOCK_BYTES = 8 * 1024 * 1024
MAX_CUE_ENTRIES = 1_000_000
TAGS_ID = 0x1254C367


def find_segment(head: bytes) -> tuple[int, dict[str, Any]]:
    """Localiza o elemento Segment no início do arquivo. Retorna (segment_data_start, header)."""
    pos = 0
    while pos < len(head):
        header = read_element_header(head, pos)
        if header["id"] == SEGMENT_ID:
            break
        if header["unknown_size"]:
            raise MatroskaStructureError("Elemento top-level de tamanho desconhecido inválido.")
        pos += header["header_size"] + header["size"]
    else:
        raise MatroskaStructureError("Elemento Segment não encontrado no cabeçalho MKV.")

    header = read_element_header(head, pos)
    segment_data_start = pos + header["header_size"]

    return segment_data_start, {
        **header,
        "start": pos,
        "content_start": segment_data_start,
    }


def segment_children(head: bytes):
    """Somente filhos diretos completos; nunca procura IDs dentro de payloads."""
    pos, segment = find_segment(head)
    segment_end = len(head) if segment["unknown_size"] else pos + segment["size"]
    end = min(len(head), segment_end)
    while pos < end:
        header = read_element_header(head, pos)
        if header["unknown_size"]:
            if header["id"] != CLUSTER_ID:
                raise MatroskaStructureError("Tamanho desconhecido inválido em filho do Segment.")
            break
        child_end = pos + header["header_size"] + header["size"]
        if child_end > segment_end:
            raise MatroskaStructureError("Filho ultrapassa o Segment.")
        if child_end > end:
            break
        yield read_element(head, pos)
        pos = child_end


def parse_seekhead(data: bytes, seekhead: dict[str, Any]) -> dict[int, int]:
    """Extrai todas as entradas de Seek do SeekHead, mapeando element_id -> position."""
    seeks = {}
    for seek in iter_elements(data, seekhead["content_start"], seekhead["content_end"]):
        if seek["id"] != SEEK_ID:
            continue

        seek_id = None
        seek_position = None

        for child in iter_elements(data, seek["content_start"], seek["content_end"]):
            if child["id"] == SEEK_ID_ID:
                seek_id = int.from_bytes(data[child["content_start"]:child["content_end"]], "big")
            elif child["id"] == SEEK_POSITION_ID:
                seek_position = read_uint(data, child)

        if seek_id is not None and seek_position is not None:
            seeks[seek_id] = seek_position

    return seeks


def discover_seekhead(head: bytes) -> tuple[dict[str, Any] | None, dict[int, int]]:
    """Localiza e analisa o elemento SeekHead principal no buffer inicial."""
    candidates = [c for c in segment_children(head) if c["id"] == SEEKHEAD_ID]
    for candidate in candidates:
        try:
            seeks = parse_seekhead(head, candidate)
            if seeks:
                return candidate, seeks
        except Exception:
            continue
    return None, {}


def parse_attachments(data: bytes) -> list[dict[str, Any]]:
    """Lê um elemento Attachments completo (cabeçalho incluso) e devolve [{filename, data}] na ordem do arquivo."""
    root = read_element(data, 0)
    if root["id"] != ATTACHMENTS_ID:
        raise MatroskaStructureError("O trecho lido não é o elemento Attachments.")

    files: list[dict[str, Any]] = []
    for attached in iter_elements(data, root["content_start"], root["content_end"]):
        if attached["id"] != ATTACHED_FILE_ID:
            continue
        name = ""
        blob = b""
        for child in iter_elements(data, attached["content_start"], attached["content_end"]):
            if child["id"] == FILE_NAME_ID:
                name = read_string(data, child)
            elif child["id"] == FILE_DATA_ID:
                blob = data[child["content_start"]:child["content_end"]]
        files.append({"filename": name, "data": blob})
    return files


def get_timecode_scale(head: bytes) -> int:
    """Extrai o TimecodeScale do segmento Info (padrão Matroska: 1.000.000 ns = 1 ms)."""
    candidates = [c for c in segment_children(head) if c["id"] == INFO_ID]
    for info in candidates:
        for child in iter_elements(head, info["content_start"], info["content_end"]):
            if child["id"] == TIMECODE_SCALE_ID:
                scale = read_uint(head, child)
                if scale <= 0:
                    raise MatroskaStructureError("TimecodeScale inválido.")
                return scale
    return 1_000_000


def read_statistics(url, total_size, segment_data_start, head, timeout=60):
    """Lê somente Info e Tags apontado pelo SeekHead; estatísticas são opcionais."""
    info = {}
    tags = {}
    children = list(segment_children(head))
    for element in children:
        if element["id"] != INFO_ID:
            continue
        for child in iter_elements(head, element["content_start"], element["content_end"]):
            raw = head[child["content_start"]:child["content_end"]]
            if child["id"] == 0x5741:
                info["writing_app"] = read_string(head, child)
            elif child["id"] == 0x4461 and len(raw) == 8:
                info["date_ns"] = int.from_bytes(raw, "big", signed=True)
            elif child["id"] == 0x4489 and len(raw) in (4, 8):
                duration = struct.unpack(">f" if len(raw) == 4 else ">d", raw)[0]
                if math.isfinite(duration) and duration > 0:
                    info["duration_ms"] = duration * get_timecode_scale(head) / 1_000_000
    data = next((head[e["start"]:e["content_end"]] for e in children if e["id"] == TAGS_ID), None)
    if data is None:
        _, seeks = discover_seekhead(head)
        if TAGS_ID not in seeks:
            return info, tags
        pos = segment_data_start + seeks[TAGS_ID]
        if not segment_data_start <= pos < total_size:
            raise MatroskaStructureError("Tags aponta para fora do arquivo.")
        header = read_element_header(read_range(url, pos, min(pos + 11, total_size - 1), timeout=timeout))
        size = header["header_size"] + header["size"]
        if header["id"] != TAGS_ID or header["unknown_size"] or size > 4 * 1024 * 1024 or pos + size > total_size:
            raise MatroskaStructureError("Tags inválido ou excede o limite.")
        data = read_range(url, pos, pos + size - 1, timeout=timeout)
    root = read_element(data)
    for tag in iter_elements(data, root["content_start"], root["content_end"]):
        if tag["id"] != 0x7373:
            continue
        targets, values = [], {}
        for child in iter_elements(data, tag["content_start"], tag["content_end"]):
            if child["id"] == 0x63C0:
                targets.extend(read_uint(data, t) for t in iter_elements(data, child["content_start"], child["content_end"]) if t["id"] == 0x63C5)
            elif child["id"] == 0x67C8:
                fields = {v["id"]: read_string(data, v) for v in iter_elements(data, child["content_start"], child["content_end"]) if v["id"] in (0x45A3, 0x4487)}
                if 0x45A3 in fields and 0x4487 in fields:
                    values[fields[0x45A3]] = fields[0x4487]
        if len(targets) == 1:
            uid = targets[0]
            if uid in tags:
                tags[uid] = {}  # Tags ambíguos não viram prova de cobertura.
            else:
                tags[uid] = values
    return info, tags


def cue_coverage(info, tags, track, frame_count):
    stats = tags.get(track.get("track_uid"), {})
    if not info.get("writing_app") or stats.get("_STATISTICS_WRITING_APP") != info["writing_app"]:
        return "unverified"
    duration = re.fullmatch(r"(\d+):(\d{2}):(\d{2})(?:\.(\d{1,9}))?", stats.get("DURATION", ""))
    count = stats.get("NUMBER_OF_FRAMES", "")
    if not count.isdigit() or int(count) <= 0 or duration is None:
        return "unverified"
    h, m, s = map(int, duration.group(1, 2, 3))
    duration_ms = (h * 3600 + m * 60 + s) * 1000 + int((duration.group(4) or "").ljust(9, "0")) / 1_000_000
    if m >= 60 or s >= 60 or duration_ms <= 0 or not info.get("duration_ms") or duration_ms > info["duration_ms"] + 1000:
        return "unverified"
    if "date_ns" in info and stats.get("_STATISTICS_WRITING_DATE_UTC"):
        try:
            written = datetime.fromisoformat(stats["_STATISTICS_WRITING_DATE_UTC"].replace(" UTC", "+00:00").replace("Z", "+00:00")).replace(tzinfo=timezone.utc)
            original = datetime(2001, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=info["date_ns"] / 1000)
            if abs((written - original).total_seconds()) > 1:
                return "unverified"
        except (ValueError, OverflowError):
            return "unverified"
    expected = int(count)
    return "incomplete" if frame_count < expected else "invalid" if frame_count > expected else "verified"


def parse_track_entry(data: bytes, start: int, end: int) -> dict[str, Any]:
    """Interpreta um elemento TrackEntry com todas as propriedades da faixa."""
    info: dict[str, Any] = {
        "track_number": None,
        "track_uid": None,
        "track_type": None,
        "name": None,
        "language": None,
        "codec_id": None,
        "codec_private": None,
        "flag_default": 1,
        "flag_forced": 0,
    }

    for element in iter_elements(data, start, end):
        eid = element["id"]
        if eid == TRACK_NUMBER_ID:
            info["track_number"] = read_uint(data, element)
        elif eid == TRACK_UID_ID:
            info["track_uid"] = read_uint(data, element)
        elif eid == TRACK_TYPE_ID:
            info["track_type"] = read_uint(data, element)
        elif eid == NAME_ID:
            info["name"] = read_string(data, element)
        elif eid == LANGUAGE_ID:
            info["language"] = read_string(data, element)
        elif eid == 0x22B59D:
            info["language_bcp47"] = read_string(data, element)
        elif eid == CODEC_ID:
            info["codec_id"] = read_string(data, element)
        elif eid == CODEC_PRIVATE_ID:
            info["codec_private"] = data[element["content_start"]:element["content_end"]]
        elif eid == FLAG_DEFAULT_ID:
            info["flag_default"] = read_uint(data, element)
        elif eid == FLAG_FORCED_ID:
            info["flag_forced"] = read_uint(data, element)
        elif eid == 0x23E383:
            info["default_duration_ns"] = read_uint(data, element)
        elif eid == 0x9C:
            info["flag_lacing"] = read_uint(data, element)
        elif eid == 0x6D80:
            info["encodings"] = parse_encodings(data, element)

    if info.get("language_bcp47"):
        info["language"] = info["language_bcp47"]
    return info


def find_tracks(head: bytes) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Localiza o elemento Tracks e retorna a lista de faixas presentes no MKV."""
    candidates = [c for c in segment_children(head) if c["id"] == TRACKS_ID]
    for candidate in candidates:
        try:
            entries = []
            for element in iter_elements(head, candidate["content_start"], candidate["content_end"]):
                if element["id"] == TRACK_ENTRY_ID:
                    entries.append(parse_track_entry(head, element["content_start"], element["content_end"]))
            if entries:
                return candidate, entries
        except Exception:
            continue

    raise MatroskaStructureError("Elemento Tracks não encontrado no cabeçalho do arquivo.")


def discover_cues(
    url: str, total_size: int, segment_data_start: int, head: bytes,
    timeout: int = 60, verbose: bool = False,
    max_cues_bytes: int = MAX_CUES_BYTES, max_probe_headers: int = 512,
) -> bytes:
    """SeekHead primeiro; fallback limitado a cabecalhos top-level, sem ler video."""
    _, seeks = discover_seekhead(head)
    _, segment = find_segment(head)
    segment_end = total_size if segment["unknown_size"] else segment_data_start + segment["size"]
    if segment_end > total_size:
        raise MatroskaStructureError("Segment ultrapassa o arquivo.")

    def header_at(pos):
        if not segment_data_start <= pos < segment_end:
            raise MatroskaStructureError("Offset de metadados fora do Segment.")
        end = min(pos + 12, segment_end)
        raw = head[pos:end] if end <= len(head) else read_range(url, pos, end - 1, timeout=timeout, verbose=verbose)
        header = read_element_header(raw, 0)
        size = header["header_size"] + header["size"]
        if not header["unknown_size"] and pos + size > segment_end:
            raise MatroskaStructureError("Metadados ultrapassam o Segment.")
        return header, size

    def fetch(pos, header, size):
        if header["id"] != CUES_ID or header["unknown_size"] or size > max_cues_bytes:
            raise MatroskaStructureError("Cues invalido ou maior que o limite configurado.")
        if pos + size <= len(head):
            return head[pos:pos + size]
        return read_range(url, pos, pos + size - 1, timeout=timeout, verbose=verbose)

    if CUES_ID in seeks:
        pos = segment_data_start + seeks[CUES_ID]
        header, size = header_at(pos)
        return fetch(pos, header, size)

    pos = segment_data_start
    for _ in range(max_probe_headers):
        if pos >= segment_end:
            break
        header, size = header_at(pos)
        if header["id"] == CUES_ID:
            return fetch(pos, header, size)
        if header["unknown_size"]:
            raise CuesNotFoundError("Cues nao localizado: Cluster desconhecido impede salto seguro.")
        pos += size
    raise CuesNotFoundError("Cues nao localizado dentro do orcamento de cabecalhos top-level.")


def parse_cue_track_positions(data: bytes, start: int, end: int) -> dict[str, Any]:
    """Analisa o bloco CueTrackPositions de um CuePoint."""
    result: dict[str, Any] = {
        "track": None,
        "cluster_position": None,
        "relative_position": None,
        "duration": None,
    }

    for element in iter_elements(data, start, end):
        eid = element["id"]
        if eid == CUE_TRACK_ID:
            result["track"] = read_uint(data, element)
        elif eid == CUE_CLUSTER_POSITION_ID:
            result["cluster_position"] = read_uint(data, element)
        elif eid == CUE_RELATIVE_POSITION_ID:
            result["relative_position"] = read_uint(data, element)
        elif eid == CUE_DURATION_ID:
            result["duration"] = read_uint(data, element)

    return result


def parse_cues(data: bytes) -> list[dict[str, Any]]:
    """Decodifica todo o bloco de Cues em uma lista de CuePoints estruturados."""
    root = read_element(data, 0)
    if root["id"] != CUES_ID:
        raise MatroskaStructureError("Buffer fornecido não inicia com o ID Cues.")

    points = []
    for element in iter_elements(data, root["content_start"], root["content_end"]):
        if element["id"] != CUE_POINT_ID:
            continue

        cue_time = None
        positions = []

        for child in iter_elements(data, element["content_start"], element["content_end"]):
            if child["id"] == CUE_TIME_ID:
                cue_time = read_uint(data, child)
            elif child["id"] == CUE_TRACK_POSITIONS_ID:
                positions.append(parse_cue_track_positions(data, child["content_start"], child["content_end"]))

        if cue_time is not None:
            if len(points) >= MAX_CUE_ENTRIES:
                raise MatroskaStructureError("Quantidade de Cues excede o limite configurado.")
            points.append({
                "time": cue_time,
                "positions": positions,
            })

    return points


def get_track_cues(cues: list[dict[str, Any]], track_number: int) -> list[dict[str, Any]]:
    """Filtra todos os CuePoints pertencentes exclusivamente à track selecionada."""
    result = []
    for cue in cues:
        for position in cue["positions"]:
            if position["track"] == track_number:
                result.append({
                    "time": cue["time"],
                    **position,
                })

    result.sort(key=lambda x: x["time"])
    return result


def fetch_cluster_headers(
    url: str,
    segment_data_start: int,
    cues: list[dict[str, Any]],
    total_size: int,
    batch_size: int = 50,
    timeout: int = 60,
    verbose: bool = False,
    with_timecodes: bool = False,
) -> dict[int, dict[str, Any]]:
    """
    Busca os cabeçalhos de todos os Clusters referenciados pelos Cues da track.
    Usa requisições multipart/byteranges em lotes.
    """
    cluster_positions = []
    for cue in cues:
        pos = cue["cluster_position"]
        if pos is not None:
            cluster_positions.append(pos)

    unique_positions = list(dict.fromkeys(cluster_positions))
    headers = {}
    total_batches = (len(unique_positions) + batch_size - 1) // batch_size

    for batch_index in range(total_batches):
        batch = unique_positions[batch_index * batch_size:(batch_index + 1) * batch_size]
        ranges = []
        for relative in batch:
            absolute = segment_data_start + relative
            end = min(absolute + RANGE_HEADER_SIZE - 1, total_size - 1)
            ranges.append((absolute, end))

        parts = read_ranges(url, ranges, timeout=timeout, verbose=verbose)
        for relative in batch:
            absolute = segment_data_start + relative
            end = min(absolute + RANGE_HEADER_SIZE - 1, total_size - 1)
            data = parts[(absolute, end)]
            header = read_element_header(data, 0)
            if header["id"] != CLUSTER_ID:
                raise MatroskaStructureError(
                    f"Cue aponta para elemento não-Cluster: offset={absolute:,}, id=0x{header['id']:X}"
                )
            headers[relative] = header
            header["windows"] = {absolute: data}
            if with_timecodes:
                header["timecode"] = _read_cluster_timecode(
                    url, absolute, header, data, total_size, timeout, verbose
                )

    return headers


def _read_cluster_timecode(
    url: str, absolute: int, header: dict[str, Any], initial: bytes,
    total_size: int, timeout: int, verbose: bool,
) -> int:
    """Lê Timestamp sem baixar filhos grandes (Void, vídeo etc.) do Cluster."""
    end = total_size if header["unknown_size"] else absolute + header["header_size"] + header["size"]
    if end > total_size:
        raise MatroskaStructureError("Cluster ultrapassa o final do arquivo.")
    pos = absolute + header["header_size"]
    window_start, window = absolute, initial
    while pos < end:
        local = pos - window_start
        if local < 0 or local + min(12, end - pos) > len(window):
            window_start = pos
            window = read_range(url, pos, min(pos + RANGE_HEADER_SIZE, end) - 1, timeout=timeout, verbose=verbose)
            header.setdefault("windows", {})[pos] = window
            local = 0
        child = read_element_header(window, local)
        child_start = pos + child["header_size"]
        child_end = child_start + child["size"]
        if child["unknown_size"] or child_end > end:
            raise MatroskaStructureError("Filho de Cluster inválido ao procurar Timestamp.")
        if child["id"] == CLUSTER_TIMESTAMP_ID:
            if not 1 <= child["size"] <= 8:
                raise MatroskaStructureError("Timestamp de Cluster inválido.")
            offset = child_start - window_start
            raw = window[offset:offset + child["size"]]
            if len(raw) != child["size"]:
                raw = read_range(url, child_start, child_end - 1, timeout=timeout, verbose=verbose)
            return int.from_bytes(raw, "big")
        pos = child_end
    raise MatroskaStructureError("Cluster sem Timestamp.")


def parse_block_element(block_data: bytes) -> dict[str, Any]:
    """
    Decodifica um elemento BlockGroup ou SimpleBlock, retornando track_number, timecode e payload.
    """
    root = read_element(block_data, 0)
    block_group_duration = None

    if root["id"] == BLOCK_GROUP_ID:
        block = None
        for child in iter_elements(block_data, root["content_start"], root["content_end"]):
            if child["id"] == BLOCK_ID:
                block = child
            elif child["id"] == BLOCK_DURATION_ID:
                block_group_duration = read_uint(block_data, child)

        if block is None:
            raise MatroskaStructureError("Elemento BlockGroup não contém um filho Block.")
    elif root["id"] == SIMPLE_BLOCK_ID:
        block = root
    else:
        raise MatroskaStructureError(f"Elemento inesperado para bloco de mídia: 0x{root['id']:X}")

    pos = block["content_start"]
    track_number, track_len = read_vint(block_data, pos)
    pos += track_len

    if pos + 3 > block["content_end"]:
        raise MatroskaStructureError("Elemento Block truncado.")

    relative_timecode = int.from_bytes(block_data[pos:pos + 2], "big", signed=True)
    pos += 2
    flags = block_data[pos]
    pos += 1
    if flags & (0x70 if root["id"] == SIMPLE_BLOCK_ID else 0xF1):
        raise MatroskaStructureError("Flags reservadas no Block.")

    payload = block_data[pos:block["content_end"]]

    return {
        "track_number": track_number,
        "relative_timecode": relative_timecode,
        "flags": flags,
        "payload": payload,
        "frames": split_frames(payload, flags),
        "block_duration": block_group_duration,
    }


def fetch_and_parse_blocks(
    url: str,
    segment_data_start: int,
    cues: list[dict[str, Any]],
    cluster_headers: dict[int, dict[str, Any]],
    total_size: int,
    expected_track: int,
    batch_size: int = 50,
    timeout: int = 60,
    verbose: bool = False,
    verify_block_boundaries: bool = False,
) -> list[dict[str, Any]]:
    """
    Para cada Cue da track, calcula o offset direto do bloco e busca os payloads em lote.
    """
    located = []
    for index, cue in enumerate(cues):
        cluster_pos = cue["cluster_position"]
        relative_pos = cue["relative_position"]
        if cluster_pos is None or relative_pos is None:
            raise NoRelativePositionError(
                f"Cue #{index} não possui CueClusterPosition ou CueRelativePosition para acesso direto."
            )

        cluster_absolute = segment_data_start + cluster_pos
        cluster_header = cluster_headers[cluster_pos]
        block_absolute = cluster_absolute + cluster_header["header_size"] + relative_pos
        cluster_end = total_size if cluster_header["unknown_size"] else cluster_absolute + cluster_header["header_size"] + cluster_header["size"]
        if cluster_absolute < segment_data_start or cluster_end > total_size or relative_pos < 0 or not cluster_absolute + cluster_header["header_size"] <= block_absolute < cluster_end:
            raise MatroskaStructureError("Cue aponta para fora dos limites do Cluster/arquivo.")

        located.append({
            "cue_index": index,
            "cue": cue,
            "cluster_absolute": cluster_absolute,
            "block_absolute": block_absolute,
            "cluster_end": cluster_end,
        })

    if verify_block_boundaries:
        _validate_block_boundaries(url, located, cluster_headers, timeout)
    results = []
    total_batches = (len(located) + batch_size - 1) // batch_size

    for batch_index in range(total_batches):
        batch = located[batch_index * batch_size:(batch_index + 1) * batch_size]

        # 1. Busca os cabeçalhos dos blocos para determinar o tamanho exato de cada um
        header_ranges = []
        for item in batch:
            start = item["block_absolute"]
            end = min(start + RANGE_HEADER_SIZE - 1, item["cluster_end"] - 1)
            header_ranges.append((start, end))

        header_parts = read_ranges(url, header_ranges, timeout=timeout, verbose=verbose)

        # 2. Monta as faixas com o tamanho exato de cada bloco
        full_ranges = []
        block_headers = {}
        for item in batch:
            start = item["block_absolute"]
            end = min(start + RANGE_HEADER_SIZE - 1, item["cluster_end"] - 1)
            header = read_element_header(header_parts[(start, end)], 0)
            total = header["header_size"] + header["size"]
            if header["unknown_size"] or total > MAX_BLOCK_BYTES:
                raise MatroskaStructureError("Bloco inválido ou excede o limite configurado.")
            full_end = start + total - 1
            if full_end >= item["cluster_end"]:
                raise MatroskaStructureError(f"Block ultrapassa o final do arquivo: {full_end:,} >= {total_size:,}")

            block_headers[start] = header
            full_ranges.append((start, full_end))

        # 3. Busca os blocos completos via HTTP Multi-range
        full_parts = read_ranges(url, full_ranges, timeout=timeout, verbose=verbose)

        for item in batch:
            start = item["block_absolute"]
            header = block_headers[start]
            total = header["header_size"] + header["size"]
            end = start + total - 1
            block_data = full_parts[(start, end)]

            parsed = parse_block_element(block_data)
            if parsed["track_number"] != expected_track:
                raise MatroskaStructureError(
                    f"Bloco no offset {start:,} pertence à faixa {parsed['track_number']}, esperado {expected_track}."
                )

            results.append({
                **item,
                "block": parsed,
            })

    return results


def _validate_block_boundaries(url, located, headers, timeout):
    """Prova a posição de filhos do Cluster, saltando seus payloads sem baixá-los."""
    for item in sorted(located, key=lambda entry: entry["block_absolute"]):
        header = headers[item["cue"]["cluster_position"]]
        target = item["block_absolute"]
        boundaries = header.setdefault("child_boundaries", set())
        if target in boundaries:
            continue
        cursor = header.get("child_cursor", item["cluster_absolute"] + header["header_size"])
        windows = header.get("windows", {})
        while cursor < target:
            raw = next((data[cursor-start:] for start, data in windows.items() if start <= cursor and cursor + min(12, item["cluster_end"] - cursor) <= start + len(data)), None)
            if raw is None:
                state = _state()
                if state.boundary_probes >= state.max_boundary_headers:
                    from .errors import UnsupportedFeatureError
                    raise UnsupportedFeatureError("boundary_budget_exceeded", "Orçamento de cabeçalhos para validar limites excedido.")
                state.boundary_probes += 1
                raw = read_range(url, cursor, min(cursor + 63, item["cluster_end"] - 1), timeout=timeout)
                windows[cursor] = raw
            child = read_element_header(raw)
            child_end = cursor + child["header_size"] + child["size"]
            if child["unknown_size"] or child_end > item["cluster_end"]:
                raise MatroskaStructureError("Filho inválido nos limites do Cluster.")
            boundaries.add(cursor)
            cursor = child_end
        if cursor != target:
            raise MatroskaStructureError("Cue aponta para bytes dentro de um payload, não para um filho do Cluster.")
        boundaries.add(target)
        header["child_cursor"] = cursor
