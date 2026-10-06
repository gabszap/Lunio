"""
API principal e CLI do Remote Subtitle Extractor para Matroska (MKV).
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .errors import (
    MatroskaStructureError,
    NoRelativePositionError,
    RemoteMkvError,
)
from .http import read_range, resolve_url
from .matroska import (
    discover_cues,
    fetch_and_parse_blocks,
    fetch_cluster_headers,
    find_segment,
    find_tracks,
    get_timecode_scale,
    get_track_cues,
    parse_cues,
)
from .subtitles import (
    build_ass,
    ms_to_ass_time,
    parse_ass_sample,
    select_all_subtitle_tracks,
    select_subtitle_pair,
    select_subtitle_track,
)

HEAD_SCAN_SIZE = 1024 * 1024
DEFAULT_BATCH_SIZE = 50


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
) -> dict[str, Any]:
    """
    Extrai e reconstrói o arquivo ASS de uma faixa específica usando as Cues já indexadas.
    """
    codec_private = selected.get("codec_private")
    if not codec_private:
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

    cluster_headers = fetch_cluster_headers(
        final_url,
        segment_data_start,
        track_cues,
        total_size,
        batch_size=batch_size,
        timeout=timeout,
        verbose=verbose,
    )

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
    )

    events = []
    for item in block_results:
        cue = item["cue"]
        block = item["block"]
        parsed = parse_ass_sample(block["payload"])

        start_ms = (cue["time"] * scale) // 1_000_000
        duration_units = cue.get("duration")
        if duration_units is None:
            duration_units = block.get("block_duration")

        if duration_units is None:
            duration_ms = 3500
        else:
            duration_ms = (duration_units * scale) // 1_000_000

        end_ms = start_ms + duration_ms

        events.append({
            **parsed,
            "start": ms_to_ass_time(start_ms),
            "end": ms_to_ass_time(end_ms),
            "cue_index": item["cue_index"],
            "start_ms": start_ms,
        })

    events.sort(key=lambda ev: (ev["read_order"], ev["cue_index"]))
    ass_text = build_ass(codec_private, events)

    out_file_str: str | None = None
    if output_path:
        out_p = Path(output_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        with out_p.open("w", encoding="utf-8", newline="") as f:
            f.write(ass_text)
        out_file_str = str(out_p)

    res: dict[str, Any] = {
        "format": "ass",
        "track_number": selected["track_number"],
        "language": selected.get("language") or "und",
        "name": selected.get("name") or "",
        "forced": selected.get("flag_forced") == 1 or "forced" in (selected.get("name") or "").lower(),
        "default": selected.get("flag_default") == 1,
        "codec_private": codec_private,
        "content": ass_text,
        "events": len(events),
    }
    if out_file_str:
        res["output_file"] = out_file_str
    return res


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
) -> dict[str, Any] | list[dict[str, Any]]:
    """
    Extrai legendas ASS embutidas em MKV remoto via HTTP Range sem transferir o vídeo.

    Suporta:
    - Faixa única (padrão)
    - Ambas as faixas do idioma (completa + forced) via both=True
    - Todas as faixas do arquivo via all_tracks=True
    """
    final_url, total_size = resolve_url(url, timeout=timeout, verbose=verbose)

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

    for sel in selected_tracks:
        track_output: str | Path | None = None
        if output_path:
            out_str = str(output_path)
            if len(selected_tracks) == 1:
                track_output = out_str
            elif both:
                is_forced = sel.get("flag_forced") == 1 or "forced" in (sel.get("name") or "").lower()
                if is_forced:
                    if out_str.lower().endswith(".ass"):
                        track_output = out_str[:-4] + ".forced.ass"
                    else:
                        track_output = f"{out_str}_forced.ass"
                else:
                    track_output = out_str
            else:  # all_tracks
                base = out_str[:-4] if out_str.lower().endswith(".ass") else out_str
                tag = (sel.get("name") or sel.get("language") or "sub").strip().replace(" ", "_").lower()
                track_output = f"{base}_track{sel['track_number']}_{tag}.ass"

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
        )
        results.append(res)

    if both or all_tracks:
        return results
    return results[0]


def main():
    parser = argparse.ArgumentParser(
        description="Remote Subtitle Extractor: extração ultrarrápida de legendas ASS via HTTP Range."
    )
    parser.add_argument("url", help="URL remota do arquivo MKV")
    parser.add_argument("-o", "--output", help="Caminho do arquivo .ass de saída")
    parser.add_argument("--language", default="por", help="Idioma preferido (ex: por, eng, spa)")
    parser.add_argument("--prefer", default="brazilian", help="Texto de preferência no título da faixa")
    parser.add_argument("--forced", action="store_true", help="Priorizar faixa forçada (sinais/placas)")
    parser.add_argument("--both", action="store_true", help="Extrair tanto a legenda completa quanto a forçada (forced/placas) em uma única execução")
    parser.add_argument("--all", action="store_true", dest="all_tracks", help="Extrair todas as faixas de legendas ASS do arquivo")
    parser.add_argument("--track", type=int, default=None, help="Número exato da faixa a extrair (opcional)")
    parser.add_argument("--stream-index", type=int, default=None, help="Índice global do stream como o FFmpeg numera (0:N)")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Tamanho do lote multi-range")
    parser.add_argument("--timeout", type=int, default=60, help="Timeout HTTP em segundos")
    parser.add_argument("--json", action="store_true", help="Imprimir metadados como JSON")
    parser.add_argument("-v", "--verbose", action="store_true", help="Logs detalhados")

    args = parser.parse_args()

    try:
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
            verbose=args.verbose,
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

    except RemoteMkvError as r_err:
        sys.stderr.write(f"[RemoteMkvError] {type(r_err).__name__}: {r_err}\n")
        sys.exit(2)
    except Exception as exc:
        sys.stderr.write(f"[FatalError] {type(exc).__name__}: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
