"""
API principal e CLI do Remote Subtitle Extractor para Matroska (MKV).
"""

import argparse
import json
import os
import re
from collections import Counter
import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from .errors import (
    CuesNotFoundError,
    MatroskaStructureError,
    NoRelativePositionError,
    PreferFfmpegError,
    RemoteMkvError,
    CueCoverageError,
)
from .ebml import read_element_header
from .output import publish_subtitle
from .http import measure_rtt, read_range, resolve_url, supports_multirange, range_operation
from .matroska import (
    ATTACHMENTS_ID,
    discover_cues,
    discover_seekhead,
    fetch_and_parse_blocks,
    fetch_cluster_headers,
    find_segment,
    find_tracks,
    get_timecode_scale,
    get_track_cues,
    parse_attachments,
    parse_cues,
    read_statistics,
    cue_coverage,
    decode_track_data,
)
from .subtitles import (
    build_ass,
    build_srt,
    ms_to_ass_time,
    parse_ass_sample,
    select_all_subtitle_tracks,
    select_subtitle_pair,
    select_subtitle_track,
    subtitle_format,
    resolve_event_durations,
)

HEAD_SCAN_SIZE = 1024 * 1024
DEFAULT_BATCH_SIZE = 50


def _download_stem(url: str, final_url: str, filename: str | None) -> str:
    """Escolhe um nome de mídia sem aproveitar tokens ou caminhos fornecidos pelo servidor."""
    if not filename:
        for candidate in (final_url, url):
            parsed_url = urlsplit(candidate)
            # Mesmas fontes usadas por extractCleanTitleFromUrl no Lunio:
            # último segmento com extensão de vídeo, depois parâmetros de nome.
            for part in reversed(parsed_url.path.split("/")):
                name = unquote(part)
                if "%" in name:
                    name = unquote(name)
                if re.search(r"\.(mkv|mp4|avi|webm|mov|m4v|ts)$", name, re.I):
                    filename = name
                    break
            if not filename:
                query = parse_qs(parsed_url.query)
                for key in ("torrent_name", "filename", "name"):
                    value = next(iter(query.get(key, [])), "").strip()
                    if value:
                        filename = value
                        break
            if filename:
                break
    name = (filename or "legenda").replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"\.(mkv|mp4|avi|webm|mov|m4v|ts)$", "", name, flags=re.I)
    return _safe_download_stem(name)


def _safe_download_stem(name: str, max_bytes: int = 180) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", name).strip(" .") or "legenda"
    if re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.I):
        name = "_" + name
    # Mantém espaço para extensão e sufixos de faixa no limite comum de 255 bytes.
    while len(name.encode("utf-8")) > max_bytes:
        name = name[:-1]
    return name


def _available_output_path(path: str | Path) -> Path:
    """Downloads automáticos repetidos preservam arquivos existentes."""
    original = Path(path)
    candidate = original
    index = 1
    while candidate.exists() or candidate.is_symlink():
        candidate = original.with_name(f"{original.stem} ({index}){original.suffix}")
        index += 1
    return candidate


def _output_path(output_path: str | Path, fmt: str) -> Path:
    """Preserva caminhos explícitos compatíveis; completa somente os sem extensão."""
    path = Path(output_path)
    if not path.suffix:
        return path.with_suffix(f".{fmt}")
    if path.suffix.lower() != f".{fmt}":
        raise MatroskaStructureError(f"A faixa é {fmt.upper()}; use uma saída .{fmt} em vez de '{path.suffix}'.")
    return path

# Quanto o FFmpeg lê do CDN por segundo (medido: ~935 MB em ~19 s na VPS) e quanto a conta do extrator pode passar disso
# antes de valer mais a pena ler o arquivo inteiro. É o valor padrão: o servidor passa o medido (`--ffmpeg-mbps`).
FFMPEG_THROUGHPUT_BYTES_PER_S = 40_000_000
PREFER_FFMPEG_RATIO = 1.3


def estimate_costs(
    total_size: int,
    track_cues: list[dict[str, Any]],
    rtt_s: float,
    ffmpeg_bytes_per_s: float = FFMPEG_THROUGHPUT_BYTES_PER_S,
    *, multipart: bool = False, batch_size: int = DEFAULT_BATCH_SIZE, estimated_bytes: int = 0,
) -> tuple[int, float, float]:
    """(requisições, segundos do extrator, segundos do FFmpeg). Sem multi-range: cluster + cabeçalho do bloco + bloco."""
    clusters = len({c["cluster_position"] for c in track_cues if c.get("cluster_position") is not None})
    requests = clusters + 2 * len(track_cues)
    if multipart:
        requests = (clusters + batch_size - 1) // batch_size + 2 * ((len(track_cues) + batch_size - 1) // batch_size)
    return requests, requests * rtt_s + estimated_bytes / ffmpeg_bytes_per_s, total_size / ffmpeg_bytes_per_s


def check_extractor_is_worth_it(
    final_url: str,
    total_size: int,
    track_cues: list[dict[str, Any]],
    timeout: int,
    verbose: bool,
    ffmpeg_bytes_per_s: float = FFMPEG_THROUGHPUT_BYTES_PER_S,
    *, batch_size: int = DEFAULT_BATCH_SIZE, measure_multipart: bool = False,
) -> None:
    """
    Sem multi-range, cada bloco de legenda custa idas e voltas sequenciais. Num arquivo com centenas de blocos
    (ex.: release da Netflix) isso passa dos 60 s, enquanto o FFmpeg lê o arquivo todo em ~20 s. Quando a conta
    do extrator sai bem pior, avisa antes de gastar o tempo.
    """
    multipart = supports_multirange(final_url, timeout=timeout)
    if multipart and not measure_multipart:
        return
    rtt = measure_rtt(final_url, timeout=timeout)
    estimated_bytes = len(track_cues) * 1088 + len({c["cluster_position"] for c in track_cues}) * 64
    requests, est_extractor, est_ffmpeg = estimate_costs(total_size, track_cues, rtt, ffmpeg_bytes_per_s, multipart=multipart, batch_size=batch_size, estimated_bytes=estimated_bytes)
    if verbose:
        print(
            f"[Custo] {requests} requisições x {rtt * 1000:.0f} ms = ~{est_extractor:.0f} s no extrator; "
            f"FFmpeg ~{est_ffmpeg:.0f} s ({ffmpeg_bytes_per_s / 1_000_000:.0f} MB/s)"
        )
    if est_extractor > est_ffmpeg * PREFER_FFMPEG_RATIO:
        prefer = PreferFfmpegError(
            f"custo Range estimado: ~{requests} requisições (~{est_extractor:.0f} s) contra ~{est_ffmpeg:.0f} s do FFmpeg"
        )
        # O servidor usa o tamanho para medir a velocidade real do FFmpeg que vai ler o arquivo todo
        prefer.total_size = total_size
        raise prefer


def _extract_single_track_data(
    final_url: str,
    total_size: int,
    segment_data_start: int,
    scale: int,
    cues: list[dict[str, Any]],
    selected: dict[str, Any],
    batch_size: int = DEFAULT_BATCH_SIZE,
    timeout: int = 60,
    output_path: str | Path | None = None,
    verbose: bool = False,
    ffmpeg_bytes_per_s: float = FFMPEG_THROUGHPUT_BYTES_PER_S,
    unique_output: bool = False,
    statistics=None,
    strict: bool = False,
    fallback_duration_ms: int | None = 3500,
    cluster_cache=None,
    measure_multipart_cost: bool = False,
    verify_block_boundaries: bool = False,
) -> dict[str, Any]:
    """
    Extrai e reconstrói ASS ou SRT usando as Cues já indexadas.
    """
    codec_private = selected.get("codec_private")
    if codec_private:
        codec_private = decode_track_data(codec_private, selected, scope=2)
    fmt = subtitle_format(selected)
    out_p = _output_path(output_path, fmt) if output_path else None
    if fmt == "ass" and not codec_private:
        raise MatroskaStructureError(f"A faixa ASS #{selected['track_number']} não possui CodecPrivate.")

    track_cues = get_track_cues(cues, selected["track_number"])
    if not track_cues:
        raise MatroskaStructureError(
            f"A faixa #{selected['track_number']} ({selected.get('name')}) não possui entradas de índice (Cues)."
        )

    missing_relative = sum(1 for c in track_cues if c.get("relative_position") is None)
    if missing_relative > 0:
        raise NoRelativePositionError(
            f"A faixa #{selected['track_number']} possui {missing_relative} Cues sem CueRelativePosition."
        )

    check_extractor_is_worth_it(final_url, total_size, track_cues, timeout, verbose, ffmpeg_bytes_per_s, batch_size=batch_size, measure_multipart=measure_multipart_cost)

    cluster_headers = cluster_cache if cluster_cache is not None else {}
    missing_clusters = [cue for cue in track_cues if cue["cluster_position"] not in cluster_headers]
    cluster_headers.update(fetch_cluster_headers(
        final_url,
        segment_data_start,
        missing_clusters,
        total_size,
        batch_size=batch_size,
        timeout=timeout,
        verbose=verbose,
        with_timecodes=True,
    ))

    block_results = fetch_and_parse_blocks(
        final_url,
        segment_data_start,
        track_cues,
        cluster_headers,
        total_size,
        expected_track=selected["track_number"],
        batch_size=batch_size,
        timeout=timeout,
        verbose=verbose,
        verify_block_boundaries=verify_block_boundaries,
    )

    events = []
    seen_blocks = set()
    for item in block_results:
        cue, block = item["cue"], item["block"]
        identity = (cue["cluster_position"], cue["relative_position"])
        if identity in seen_blocks:
            raise MatroskaStructureError("Cues duplicados para o mesmo bloco.")
        seen_blocks.add(identity)
        cluster_time = cluster_headers[cue["cluster_position"]]["timecode"]
        absolute = cluster_time + block["relative_timecode"]
        if absolute != cue["time"]:
            raise MatroskaStructureError("CueTime diverge do timestamp absoluto do bloco.")
        duration = block.get("block_duration")
        source = "block_duration"
        if duration is None:
            duration = cue.get("duration")
            source = "cue_duration"
        frames = block["frames"]
        if len(frames) > 1 and selected.get("flag_lacing") == 0:
            raise MatroskaStructureError("Lacing proibido pela faixa.")
        frame_duration_ns = selected.get("default_duration_ns")
        if len(frames) > 1 and not frame_duration_ns:
            if duration is None:
                from .errors import UnsupportedFeatureError
                raise UnsupportedFeatureError("unsupported_lacing", "Frames laced sem tempo por frame.")
            frame_duration_ns = duration * scale // len(frames)
        for frame_index, frame in enumerate(frames):
            payload = decode_track_data(frame, selected)
            parsed = parse_ass_sample(payload) if fmt == "ass" else {"text": payload.decode("utf-8", errors="replace").rstrip("\x00")}
            start_ns = absolute * scale + frame_index * (frame_duration_ns or 0)
            duration_ns = duration * scale // len(frames) if duration is not None else frame_duration_ns
            events.append({
                **parsed,
                "start_ms": max(0, start_ns // 1_000_000),
                "duration_ms": duration_ns // 1_000_000 if duration_ns is not None else None,
                "duration_source": source if duration is not None else "default_duration" if duration_ns is not None else None,
                "cue_index": item["cue_index"] * 256 + frame_index,
            })
    resolve_event_durations(events, fallback_duration_ms)
    for event in events:
        event["start"] = ms_to_ass_time(event["start_ms"])
        event["end"] = ms_to_ass_time(event["start_ms"] + event["duration_ms"])

    if fmt == "srt":
        subtitle_text = build_srt(events)
    else:
        events.sort(key=lambda ev: (ev["read_order"], ev["cue_index"]))
        subtitle_text = build_ass(codec_private, events)

    coverage = cue_coverage(*(statistics or ({}, {})), selected, len(events))
    if coverage in ("incomplete", "invalid") or (strict and coverage != "verified"):
        raise CueCoverageError(coverage)

    out_file_str: str | None = None
    if out_p is not None:
        out_p = publish_subtitle(out_p, subtitle_text, unique=unique_output)
        out_file_str = str(out_p)

    res: dict[str, Any] = {
        "format": fmt,
        "strategy": "cue_direct" if coverage == "verified" else "best_effort",
        "coverage": coverage,
        "complete_verified": coverage == "verified",
        "warnings": [] if coverage == "verified" else ["cues_unverified"],
        "duration_sources": dict(Counter(event["duration_source"] for event in events)),
        "inferred_events": sum(event["duration_source"] in ("next_start", "fallback_estimate") for event in events),
        "track_number": selected["track_number"],
        "language": selected.get("language") or "und",
        "name": selected.get("name") or "",
        "forced": selected.get("flag_forced") == 1 or "forced" in (selected.get("name") or "").lower(),
        "default": selected.get("flag_default") == 1,
        "codec_private": codec_private,
        "content": subtitle_text,
        "events": len(events),
    }
    if out_file_str:
        res["output_file"] = out_file_str
    return res


@range_operation
def extract_remote_subtitle(
    url: str,
    language: str = "por",
    prefer: str = "brazilian",
    forced: bool = False,
    both: bool = False,
    all_tracks: bool = False,
    track_number: int | None = None,
    stream_index: int | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    timeout: int = 60,
    output_path: str | Path | None = None,
    verbose: bool = False,
    ffmpeg_bytes_per_s: float = FFMPEG_THROUGHPUT_BYTES_PER_S,
    auto_output: bool = False,
    strict: bool = False,
    fallback_duration_ms: int | None = 3500,
    public_only: bool = False,
    allowed_origins=(),
    coalesce_gap_bytes: int = 0,
    coalesce_extra_bytes: int = 65536,
    measure_multipart_cost: bool = False,
    max_boundary_headers: int = 4096,
    verify_block_boundaries: bool = False,
) -> dict[str, Any] | list[dict[str, Any]]:
    """
    Extrai legendas ASS/SSA e SRT de MKV remoto via HTTP Range sem transferir o vídeo.

    Suporta:
    - Faixa única (padrão)
    - Ambas as faixas do idioma (completa + forced) via both=True
    - Todas as faixas do arquivo via all_tracks=True
    - Nome do MKV na pasta atual via auto_output=True (padrão da CLI)
    """
    if batch_size <= 0 or coalesce_gap_bytes < 0 or coalesce_extra_bytes < 0 or max_boundary_headers <= 0 or (fallback_duration_ms is not None and fallback_duration_ms <= 0):
        raise MatroskaStructureError("batch_size e fallback_duration_ms devem ser positivos.")
    metadata: dict[str, str] = {}
    resolve_options = {"metadata": metadata} if auto_output and not output_path else {}
    final_url, total_size = resolve_url(url, timeout=timeout, verbose=verbose, **resolve_options)
    automatic_name = _download_stem(url, final_url, metadata.get("filename")) if auto_output and not output_path else None

    # 1. Leitura do cabeçalho inicial (1 MiB)
    head = read_range(
        final_url,
        0,
        min(HEAD_SCAN_SIZE, total_size) - 1,
        timeout=timeout,
        verbose=verbose,
    )

    segment_data_start, _ = find_segment(head)
    scale = get_timecode_scale(head)
    _, tracks = find_tracks(head)
    statistics = read_statistics(final_url, total_size, segment_data_start, head, timeout=timeout)

    # 2. Localização e análise de Cues (feita apenas 1 vez por mídia)
    cues_data = discover_cues(
        final_url,
        total_size,
        segment_data_start,
        head,
        timeout=timeout,
        verbose=verbose,
    )
    cues = parse_cues(cues_data)

    # 3. Determinação de quais faixas serão extraídas
    if all_tracks:
        selected_tracks = select_all_subtitle_tracks(tracks)
    elif both:
        selected_tracks = select_subtitle_pair(tracks, language=language, prefer=prefer)
    else:
        selected_tracks = [
            select_subtitle_track(
                tracks,
                language=language,
                prefer=prefer,
                forced=forced,
                track_number=track_number,
                stream_index=stream_index,
            )
        ]

    results: list[dict[str, Any]] = []
    cluster_cache = {}

    for sel in selected_tracks:
        track_output: str | Path | None = None
        if output_path or automatic_name:
            fmt = subtitle_format(sel)
            out_str = str(output_path) if output_path else f"{automatic_name}.{fmt}"
            out = Path(out_str)
            base = str(out.with_suffix("")) if out.suffix.lower() in (".ass", ".srt") else out_str
            if len(selected_tracks) == 1:
                track_output = out_str
            elif both and not all_tracks:
                is_forced = sel.get("flag_forced") == 1 or "forced" in (sel.get("name") or "").lower()
                if is_forced:
                    track_output = f"{base}.forced.{fmt}"
                else:
                    track_output = out_str
            else:  # all_tracks
                tag = (sel.get("name") or sel.get("language") or "sub").strip().replace(" ", "_").lower()
                base_path = Path(base)
                suffix = f"_track{sel['track_number']}_{_safe_download_stem(tag, max_bytes=80)}"
                filename = _safe_download_stem(base_path.name, max_bytes=240 - len(suffix.encode("utf-8"))) + suffix
                track_output = base_path.parent / f"{filename}.{fmt}"
            if automatic_name:
                stem = str(track_output).removesuffix(f".{fmt}")
                track_output = f"{_safe_download_stem(stem, max_bytes=240)}.{fmt}"

        res = _extract_single_track_data(
            final_url=final_url,
            total_size=total_size,
            segment_data_start=segment_data_start,
            scale=scale,
            cues=cues,
            selected=sel,
            batch_size=batch_size,
            timeout=timeout,
            output_path=track_output,
            verbose=verbose,
            ffmpeg_bytes_per_s=ffmpeg_bytes_per_s,
            unique_output=automatic_name is not None,
            statistics=statistics,
            strict=strict,
            fallback_duration_ms=fallback_duration_ms,
            cluster_cache=cluster_cache,
            measure_multipart_cost=measure_multipart_cost,
            verify_block_boundaries=verify_block_boundaries,
        )
        results.append(res)

    if both or all_tracks:
        return results
    return results[0]


def cue_times_seconds(cues: list[dict[str, Any]], track_number: int, scale: int) -> list[float]:
    """Instantes (em segundos, sem repetição e em ordem) dos pontos de Cue da faixa: onde há keyframe de vídeo."""
    times = {round(c["time"] * scale / 1_000_000_000, 3) for c in get_track_cues(cues, track_number)}
    return sorted(times)


# Teto do bloco Attachments lido de uma vez (as fontes de um release com fonte CJK passam de 40 MB)
MAX_ATTACHMENTS_BYTES = 256 * 1024 * 1024


@range_operation
def extract_attachments(url: str, out_dir: str, timeout: int = 60, verbose: bool = False, public_only: bool = False, allowed_origins=()) -> list[dict[str, Any]]:
    """
    Lê só o bloco Attachments do MKV remoto (o SeekHead aponta onde ele está, em geral nos primeiros KB) e grava cada
    anexo em <out_dir>/a<ordem>.bin. Uma requisição, em vez de o FFmpeg percorrer o arquivo inteiro atrás das fontes.
    Devolve [{ordinal, filename, size}]; o servidor decide o nome final e a extensão.
    """
    final_url, total_size = resolve_url(url, timeout=timeout, verbose=verbose)
    head = read_range(final_url, 0, min(HEAD_SCAN_SIZE, total_size) - 1, timeout=timeout, verbose=verbose)

    segment_data_start, _ = find_segment(head)
    _, seeks = discover_seekhead(head)
    if ATTACHMENTS_ID not in seeks:
        raise MatroskaStructureError("O SeekHead não aponta para Attachments.")

    start = segment_data_start + seeks[ATTACHMENTS_ID]
    if start >= total_size:
        raise MatroskaStructureError("Posição de Attachments fora do arquivo.")
    if start + 16 <= len(head):
        header = read_element_header(head, start)
    else:
        header = read_element_header(read_range(final_url, start, min(start + 15, total_size - 1), timeout=timeout), 0)
    if header["id"] != ATTACHMENTS_ID or header["unknown_size"]:
        raise MatroskaStructureError("Elemento Attachments inválido na posição indicada pelo SeekHead.")

    size = header["header_size"] + header["size"]
    if size > MAX_ATTACHMENTS_BYTES or start + size > total_size:
        raise MatroskaStructureError(f"Attachments com tamanho inesperado ({size:,} bytes).")

    data = head[start:start + size] if start + size <= len(head) else read_range(
        final_url, start, start + size - 1, timeout=timeout, verbose=verbose
    )
    files = parse_attachments(data)

    os.makedirs(out_dir, exist_ok=True)
    result = []
    for ordinal, item in enumerate(files):
        # O nome vem do arquivo (dado de terceiros): nunca vira caminho; o disco recebe só a ordem
        with open(os.path.join(out_dir, f"a{ordinal}.bin"), "wb") as fh:
            fh.write(item["data"])
        result.append({"ordinal": ordinal, "filename": item["filename"], "size": len(item["data"])})
    if verbose:
        print(f"[Attachments] {len(result)} anexo(s), {size:,} bytes")
    return result


@range_operation
def extract_video_keyframes(url: str, timeout: int = 60, verbose: bool = False, public_only: bool = False, allowed_origins=()) -> dict[str, Any]:
    """
    Lê só o cabeçalho e os Cues do MKV remoto e devolve onde estão os keyframes da primeira faixa de vídeo.
    É a base do HLS compartilhado: os segmentos precisam começar em keyframes para o vídeo ser copiado sem recodificar.
    """
    final_url, total_size = resolve_url(url, timeout=timeout, verbose=verbose)
    head = read_range(final_url, 0, min(HEAD_SCAN_SIZE, total_size) - 1, timeout=timeout, verbose=verbose)

    segment_data_start, _ = find_segment(head)
    scale = get_timecode_scale(head)
    _, tracks = find_tracks(head)

    video = next((t for t in tracks if t.get("track_type") == 1), None)
    if video is None:
        raise MatroskaStructureError("O arquivo não tem faixa de vídeo.")

    cues_data = discover_cues(final_url, total_size, segment_data_start, head, timeout=timeout, verbose=verbose)
    cues = parse_cues(cues_data)
    times = cue_times_seconds(cues, video["track_number"], scale)
    if not times:
        raise CuesNotFoundError("Os Cues não têm entradas para a faixa de vídeo.")

    return {
        "video_track": video["track_number"],
        "video_codec": video.get("codec_id"),
        "timecode_scale": scale,
        "keyframes": times,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Remote Subtitle Extractor: extração ultrarrápida de legendas ASS/SSA e SRT via HTTP Range."
    )
    parser.add_argument("url", help="URL remota do arquivo MKV")
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument("-o", "--output", help="Caminho de saída (padrão: nome do MKV na pasta atual; extensão conforme o codec)")
    output_group.add_argument("--stdout", action="store_true", help="Imprimir a legenda no terminal em vez de salvar um arquivo")
    parser.add_argument("--language", default="por", help="Idioma preferido (ex: por, eng, spa)")
    parser.add_argument("--prefer", default="brazilian", help="Texto de preferência no título da faixa")
    parser.add_argument("--forced", action="store_true", help="Priorizar faixa forçada (sinais/placas)")
    parser.add_argument("--both", action="store_true", help="Extrair tanto a legenda completa quanto a forçada (forced/placas) em uma única execução")
    parser.add_argument("--all", action="store_true", dest="all_tracks", help="Extrair todas as faixas de legendas ASS/SSA e SRT do arquivo")
    parser.add_argument("--track", type=int, default=None, help="Número exato da faixa a extrair (opcional)")
    parser.add_argument("--stream-index", type=int, default=None, help="Índice global do stream como o FFmpeg numera (0:N)")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Tamanho do lote multi-range")
    parser.add_argument("--timeout", type=int, default=60, help="Timeout HTTP em segundos")
    parser.add_argument("--ffmpeg-mbps", type=float, default=None, help="Velocidade (MB/s) com que o FFmpeg lê este CDN, para decidir entre extrator e FFmpeg (padrão: 40)")
    parser.add_argument("--attachments", metavar="DIR", help="Em vez de legenda, gravar os anexos (fontes) do MKV em DIR e imprimir (JSON) a lista")
    parser.add_argument("--keyframes", action="store_true", help="Em vez de legenda, imprimir (JSON) os keyframes do vídeo lidos dos Cues")
    parser.add_argument("--json", action="store_true", help="Imprimir metadados como JSON")
    parser.add_argument("--strict", action="store_true", help="Exigir cobertura dos Cues comprovada por estatísticas confiáveis")
    parser.add_argument("--public-only", action="store_true", help="Bloquear destinos privados e redirects para redes internas")
    parser.add_argument("--allow-origin", action="append", default=[], help="Origem interna explicitamente autorizada em modo --public-only")
    parser.add_argument("--coalesce-gap-bytes", type=int, default=0, help="Coalescer ranges separados por até N bytes (padrão: desabilitado)")
    parser.add_argument("--coalesce-extra-bytes", type=int, default=65536, help="Limite total de bytes extras transferidos por coalescência")
    parser.add_argument("--measure-multipart-cost", action="store_true", help="Medir RTT e comparar custo mesmo quando multipart está disponível")
    parser.add_argument("--verify-block-boundaries", action="store_true", help="Comprovar posições de blocos caminhando pelos filhos do Cluster (faz muitas requisições Range extras)")
    parser.add_argument("--max-boundary-headers", type=int, default=4096, help="Limite de leituras extras ao usar --verify-block-boundaries")
    parser.add_argument("--fallback-duration-ms", type=int, default=3500, help="Estimativa de duração do último evento quando ausente (padrão: 3500 ms)")
    parser.add_argument("--no-duration-estimates", action="store_true", help="Recusar último evento sem duração em vez de estimar")
    parser.add_argument("-v", "--verbose", action="store_true", help="Logs detalhados")

    args = parser.parse_args()

    try:
        if args.attachments:
            print(json.dumps(extract_attachments(args.url, args.attachments, timeout=args.timeout, verbose=args.verbose, public_only=args.public_only, allowed_origins=args.allow_origin), ensure_ascii=False))
            return

        if args.keyframes:
            print(json.dumps(extract_video_keyframes(args.url, timeout=args.timeout, verbose=args.verbose, public_only=args.public_only, allowed_origins=args.allow_origin)))
            return

        result = extract_remote_subtitle(
            args.url,
            language=args.language,
            prefer=args.prefer,
            forced=args.forced,
            both=args.both,
            all_tracks=args.all_tracks,
            track_number=args.track,
            stream_index=args.stream_index,
            batch_size=args.batch_size,
            timeout=args.timeout,
            output_path=args.output,
            auto_output=not args.stdout and args.output is None,
            strict=args.strict,
            fallback_duration_ms=None if args.no_duration_estimates else args.fallback_duration_ms,
            public_only=args.public_only,
            allowed_origins=args.allow_origin,
            coalesce_gap_bytes=args.coalesce_gap_bytes,
            coalesce_extra_bytes=args.coalesce_extra_bytes,
            measure_multipart_cost=args.measure_multipart_cost,
            max_boundary_headers=args.max_boundary_headers,
            verify_block_boundaries=args.verify_block_boundaries,
            verbose=args.verbose,
            ffmpeg_bytes_per_s=(args.ffmpeg_mbps * 1_000_000 if args.ffmpeg_mbps and args.ffmpeg_mbps > 0 else FFMPEG_THROUGHPUT_BYTES_PER_S),
        )

        if args.json:
            if isinstance(result, list):
                out_list = []
                for item in result:
                    out_meta = {k: v for k, v in item.items() if k not in ("codec_private", "content")}
                    out_meta["content_length"] = len(item["content"])
                    out_list.append(out_meta)
                print(json.dumps(out_list, indent=2, ensure_ascii=False))
            else:
                out_meta = {k: v for k, v in result.items() if k not in ("codec_private", "content")}
                out_meta["content_length"] = len(result["content"])
                print(json.dumps(out_meta, indent=2, ensure_ascii=False))
        else:
            items = result if isinstance(result, list) else [result]
            for r in items:
                dest = r.get("output_file")
                if not dest:
                    print(r["content"])
                else:
                    tag_forced = " [Forced]" if r.get("forced") else " [Completo]"
                    print(
                        f"✅ Legenda #{r['track_number']} ({r['language']} - {r['name']}){tag_forced} "
                        f"extraída com sucesso! ({r['events']} eventos -> {dest})"
                    )

    except PreferFfmpegError as prefer:
        sys.stderr.write(f"[PreferFfmpeg] {prefer}\n")
        sys.stderr.write(f"[FallbackReason] {prefer.fallback_reason}\n")
        total_size = getattr(prefer, "total_size", None)
        if total_size:
            sys.stderr.write(f"[TotalSize] {total_size}\n")
        sys.exit(4)
    except RemoteMkvError as r_err:
        sys.stderr.write(f"[RemoteMkvError] {type(r_err).__name__}: {r_err}\n")
        sys.stderr.write(f"[FallbackReason] {r_err.fallback_reason}\n")
        status = getattr(r_err, "status", None)
        if status:
            # Linha estável para o servidor decidir: 429 = esperar, não insistir
            retry = getattr(r_err, "retry_after", None)
            sys.stderr.write(f"[HttpStatus] {status}" + (f" retry-after={retry}" if retry else "") + "\n")
        sys.exit(2)
    except Exception as exc:
        sys.stderr.write(f"[FatalError] {type(exc).__name__}: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
