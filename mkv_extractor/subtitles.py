"""
Seleção de faixas e reconstrução de legendas no formato Advanced SubStation Alpha (ASS).
"""

from typing import Any
from .errors import CodecNotSupportedError, TrackNotFoundError


def ms_to_ass_time(ms: int | float) -> str:
    """
    Converte milissegundos para o formato de tempo ASS padrão (H:MM:SS.cc).
    """
    total_ms = max(0, int(ms))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)

    centiseconds = milliseconds // 10
    if centiseconds >= 100:
        centiseconds = 0
        seconds += 1
    if seconds >= 60:
        seconds = 0
        minutes += 1
    if minutes >= 60:
        minutes = 0
        hours += 1

    return f"{hours}:{minutes:02d}:{seconds:02d}.{centiseconds:02d}"


def parse_ass_sample(payload: bytes) -> dict[str, Any]:
    """
    Decodifica o payload de um sample ASS armazenado no bloco Matroska.
    Padrão Matroska ASS: 9 campos separados por vírgula:
    ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    """
    text = payload.decode("utf-8", errors="replace").rstrip("\x00")
    fields = text.split(",", 8)

    if len(fields) != 9:
        raise ValueError(f"Payload ASS inválido: esperado 9 campos, recebido {len(fields)}: {text[:100]!r}")

    read_order_raw, layer, style, name, margin_l, margin_r, margin_v, effect, sub_text = fields

    try:
        read_order = int(read_order_raw)
    except ValueError:
        read_order = 2**63 - 1

    return {
        "read_order": read_order,
        "layer": layer,
        "style": style,
        "name": name,
        "margin_l": margin_l,
        "margin_r": margin_r,
        "margin_v": margin_v,
        "effect": effect,
        "text": sub_text,
    }


def select_subtitle_track(
    tracks: list[dict[str, Any]],
    language: str = "por",
    prefer: str = "brazilian",
    forced: bool = False,
    track_number: int | None = None,
    stream_index: int | None = None,
) -> dict[str, Any]:
    """
    Seleciona a melhor faixa de legenda ASS disponível com base nos critérios especificados,
    ou seleciona a faixa de número exato se track_number for fornecido.

    stream_index é o índice global do stream como o FFmpeg numera (ordem das TrackEntry, base 0).
    Ele NÃO é o TrackNumber do Matroska (que costuma ser index + 1); misturar os dois extraía a faixa vizinha.
    """
    subtitle_tracks = [t for t in tracks if t.get("track_type") == 17]

    if not subtitle_tracks:
        raise TrackNotFoundError("Nenhuma faixa de legenda encontrada no arquivo MKV.")

    if stream_index is not None:
        if 0 <= stream_index < len(tracks) and tracks[stream_index] in subtitle_tracks:
            return tracks[stream_index]
        raise TrackNotFoundError(f"O stream #{stream_index} não é uma faixa de legenda neste MKV.")

    # Se uma track específica foi explicitamente solicitada por índice:
    if track_number is not None:
        target = next((t for t in subtitle_tracks if t.get("track_number") == track_number), None)
        # Se não achou pelo track_number direto, tenta pelo índice global na lista de streams (índice FFmpeg)
        if not target:
            target = next((t for idx, t in enumerate(tracks) if idx == track_number and t in subtitle_tracks), None)
        # Ou pelo índice ordinal relativo entre as legendas (ex: 0 = 1ª legenda)
        if not target and 0 <= track_number < len(subtitle_tracks):
            target = subtitle_tracks[track_number]

        if not target:
            raise TrackNotFoundError(f"Faixa de legenda #{track_number} não encontrada entre as faixas disponíveis.")
        codec = (target.get("codec_id") or "").upper()
        if codec != "S_TEXT/ASS":
            raise CodecNotSupportedError(f"Faixa #{track_number} possui codec '{codec}', esperado 'S_TEXT/ASS'.")
        return target

    ass_tracks = [t for t in subtitle_tracks if t.get("codec_id") == "S_TEXT/ASS"]
    if not ass_tracks:
        raise CodecNotSupportedError("Nenhuma faixa de legenda em formato texto ASS (S_TEXT/ASS) encontrada.")

    requested_lang = (language or "").lower()
    prefer_str = (prefer or "").lower()

    def score_track(track: dict[str, Any]) -> int:
        lang = (track.get("language") or "").lower()
        name = (track.get("name") or "").lower()
        is_forced = track.get("flag_forced") == 1 or "forced" in name
        is_default = track.get("flag_default") == 1

        score = 0

        # Correspondência de idioma
        if lang == requested_lang:
            score += 200
        elif requested_lang in ("por", "pt", "pt-br") and lang in ("por", "pt", "pt-br"):
            score += 180
        elif requested_lang in ("spa", "es") and lang in ("spa", "es"):
            score += 180
        elif requested_lang in ("eng", "en") and lang in ("eng", "en"):
            score += 180
        elif requested_lang and requested_lang in lang:
            score += 100

        # Preferência dialetal / regional (ex: brazilian)
        if prefer_str and prefer_str in name:
            score += 150

        # Lógica de faixas forçadas vs completas
        if forced:
            if is_forced:
                score += 300
            else:
                score -= 100
        else:
            if is_forced:
                score -= 500  # Penaliza fortemente faixas forçadas quando o usuário quer diálogos completos
            else:
                score += 100

        # Bônus de faixa padrão marcada no container
        if is_default:
            score += 20

        return score

    return max(ass_tracks, key=score_track)


def build_ass(codec_private: bytes, events: list[dict[str, Any]]) -> str:
    """
    Reconstrói o documento .ass final combinando o CodecPrivate (estilos e metadados)
    com as linhas de eventos de diálogo geradas.
    """
    header = codec_private.decode("utf-8-sig", errors="replace")
    header = header.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")

    if "[Events]" not in header:
        header += "\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"

    lines = [header, ""]

    for event in events:
        lines.append(
            f"Dialogue: {event['layer']},{event['start']},{event['end']},"
            f"{event['style']},{event['name']},{event['margin_l']},"
            f"{event['margin_r']},{event['margin_v']},{event['effect']},"
            f"{event['text']}"
        )

    return "\r\n".join(lines) + "\r\n"


def select_subtitle_pair(
    tracks: list[dict[str, Any]],
    language: str = "por",
    prefer: str = "brazilian",
) -> list[dict[str, Any]]:
    """
    Seleciona tanto a faixa completa quanto a faixa forçada (se existente) para o idioma especificado.
    Retorna [track_full, track_forced] ou [track_full] caso não haja faixa forçada distinta.
    """
    results = []
    try:
        track_full = select_subtitle_track(tracks, language=language, prefer=prefer, forced=False)
        results.append(track_full)
    except (TrackNotFoundError, CodecNotSupportedError):
        pass

    try:
        track_forced = select_subtitle_track(tracks, language=language, prefer=prefer, forced=True)
        is_actually_forced = track_forced.get("flag_forced") == 1 or "forced" in (track_forced.get("name") or "").lower()
        if is_actually_forced:
            if not results or track_forced.get("track_number") != results[0].get("track_number"):
                results.append(track_forced)
    except (TrackNotFoundError, CodecNotSupportedError):
        pass

    if not results:
        raise TrackNotFoundError(f"Nenhuma faixa de legenda encontrada para o idioma '{language}'.")

    return results


def select_all_subtitle_tracks(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Retorna todas as faixas de legenda no formato ASS encontradas no container Matroska.
    """
    ass_tracks = [
        t for t in tracks
        if t.get("track_type") == 17 and (t.get("codec_id") or "").upper() == "S_TEXT/ASS"
    ]
    if not ass_tracks:
        raise CodecNotSupportedError("Nenhuma faixa de legenda ASS encontrada no container.")
    return ass_tracks

