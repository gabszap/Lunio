"""
Parser de estruturas do container Matroska (MKV):
Segment, Info, Tracks, SeekHead, Cues, Clusters, BlockGroup e SimpleBlock.
"""

from typing import Any
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
from .http import read_range, read_ranges

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

CLUSTER_ID = 0x1F43B675
BLOCK_GROUP_ID = 0xA0
BLOCK_ID = 0xA1
SIMPLE_BLOCK_ID = 0xA3
BLOCK_DURATION_ID = 0x9B

RANGE_HEADER_SIZE = 64


def find_segment(head: bytes) -> tuple[int, dict[str, Any]]:
    """Localiza o elemento Segment no início do arquivo. Retorna (segment_data_start, header)."""
    raw = SEGMENT_ID.to_bytes(4, "big")
    pos = head.find(raw)
    if pos == -1:
        raise MatroskaStructureError("Elemento Segment não encontrado no cabeçalho MKV.")

    header = read_element_header(head, pos)
    segment_data_start = pos + header["header_size"]

    return segment_data_start, {
        **header,
        "start": pos,
        "content_start": segment_data_start,
    }


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
    candidates = find_all_valid_elements(head, SEEKHEAD_ID)
    for candidate in candidates:
        try:
            seeks = parse_seekhead(head, candidate)
            if seeks:
                return candidate, seeks
        except Exception:
            continue
    return None, {}


def get_timecode_scale(head: bytes) -> int:
    """Extrai o TimecodeScale do segmento Info (padrão Matroska: 1.000.000 ns = 1 ms)."""
    candidates = find_all_valid_elements(head, INFO_ID)
    for info in candidates:
        try:
            for child in iter_elements(head, info["content_start"], info["content_end"]):
                if child["id"] == TIMECODE_SCALE_ID:
                    return read_uint(head, child)
        except Exception:
            continue
    return 1_000_000


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
        elif eid == CODEC_ID:
            info["codec_id"] = read_string(data, element)
        elif eid == CODEC_PRIVATE_ID:
            info["codec_private"] = data[element["content_start"]:element["content_end"]]
        elif eid == FLAG_DEFAULT_ID:
            info["flag_default"] = read_uint(data, element)
        elif eid == FLAG_FORCED_ID:
            info["flag_forced"] = read_uint(data, element)

    return info


def find_tracks(head: bytes) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Localiza o elemento Tracks e retorna a lista de faixas presentes no MKV."""
    candidates = find_all_valid_elements(head, TRACKS_ID)
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
    url: str,
    total_size: int,
    segment_data_start: int,
    head: bytes,
    timeout: int = 60,
    verbose: bool = False,
) -> bytes:
    """
    Localiza e baixa o elemento Cues do MKV.
    Prioridade 1: Offset apontado pelo SeekHead.
    Prioridade 2 (Fallback): Varredura reversa dos últimos 4 MiB do arquivo.
    """
    seekhead, seeks = discover_seekhead(head)
    if seekhead:
        cues_relative = seeks.get(CUES_ID)
        if cues_relative is not None:
            cues_absolute = segment_data_start + cues_relative
            if verbose:
                print(f"[Cues] Localizado via SeekHead no offset absoluto {cues_absolute:,}")

            header_data = read_range(
                url,
                cues_absolute,
                min(cues_absolute + 63, total_size - 1),
                timeout=timeout,
                verbose=verbose,
            )
            header = read_element_header(header_data, 0)
            if header["id"] == CUES_ID:
                total = header["header_size"] + header["size"]
                cues_data = read_range(
                    url,
                    cues_absolute,
                    cues_absolute + total - 1,
                    timeout=timeout,
                    verbose=verbose,
                )
                return cues_data

    # Fallback: scan do final do arquivo
    if verbose:
        print("[Cues] SeekHead não apontou para Cues; executando scan do final do arquivo...")

    tail_size = min(4 * 1024 * 1024, total_size)
    tail_start = total_size - tail_size
    tail = read_range(url, tail_start, total_size - 1, timeout=timeout, verbose=verbose)

    raw = CUES_ID.to_bytes(4, "big")
    search_end = len(tail)
    cues_element = None

    while search_end > 0:
        pos = tail.rfind(raw, 0, search_end)
        if pos == -1:
            break
        try:
            candidate = read_element(tail, pos)
            if candidate["id"] == CUES_ID:
                cues_element = candidate
                break
        except Exception:
            pass
        search_end = pos

    if not cues_element:
        raise CuesNotFoundError("Elemento Cues não pôde ser localizado nem por SeekHead nem por varredura do final.")

    total = cues_element["header_size"] + cues_element["size"]
    cues_absolute = tail_start + cues_element["start"]

    return read_range(url, cues_absolute, cues_absolute + total - 1, timeout=timeout, verbose=False)


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

    return headers


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

    payload = block_data[pos:block["content_end"]]

    return {
        "track_number": track_number,
        "relative_timecode": relative_timecode,
        "flags": flags,
        "payload": payload,
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

        located.append({
            "cue_index": index,
            "cue": cue,
            "cluster_absolute": cluster_absolute,
            "block_absolute": block_absolute,
        })

    results = []
    total_batches = (len(located) + batch_size - 1) // batch_size

    for batch_index in range(total_batches):
        batch = located[batch_index * batch_size:(batch_index + 1) * batch_size]

        # 1. Busca os cabeçalhos dos blocos para determinar o tamanho exato de cada um
        header_ranges = []
        for item in batch:
            start = item["block_absolute"]
            end = min(start + RANGE_HEADER_SIZE - 1, total_size - 1)
            header_ranges.append((start, end))

        header_parts = read_ranges(url, header_ranges, timeout=timeout, verbose=verbose)

        # 2. Monta as faixas com o tamanho exato de cada bloco
        full_ranges = []
        block_headers = {}
        for item in batch:
            start = item["block_absolute"]
            end = min(start + RANGE_HEADER_SIZE - 1, total_size - 1)
            header = read_element_header(header_parts[(start, end)], 0)
            total = header["header_size"] + header["size"]
            full_end = start + total - 1
            if full_end >= total_size:
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
