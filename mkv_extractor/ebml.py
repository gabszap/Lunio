"""
Parser EBML (Extensible Binary Meta Language) genérico.
Totalmente desacoplado de codecs e lógica de legendas.
"""

from typing import Any, Generator
from .errors import EbmlParseError


def read_id(data: bytes, pos: int) -> tuple[int, int]:
    """Lê um ID de elemento EBML a partir de pos. Retorna (element_id, width_in_bytes)."""
    if pos >= len(data):
        raise EbmlParseError("Fim de dados inesperado ao tentar ler EBML ID.")

    first = data[pos]
    mask = 0x80
    width = 1

    while width <= 4 and not (first & mask):
        mask >>= 1
        width += 1

    if width > 4:
        raise EbmlParseError(f"EBML ID inválido ou largura excessiva (>4) no offset {pos}.")

    if pos + width > len(data):
        raise EbmlParseError(f"Dados insuficientes para ler EBML ID completo no offset {pos}.")

    value = 0
    for i in range(width):
        value = (value << 8) | data[pos + i]

    return value, width


def read_vint(data: bytes, pos: int) -> tuple[int, int]:
    """Lê um inteiro de tamanho variável (VINT) EBML a partir de pos. Retorna (value, width_in_bytes)."""
    if pos >= len(data):
        raise EbmlParseError("Fim de dados inesperado ao tentar ler VINT.")

    first = data[pos]
    mask = 0x80
    width = 1

    while width <= 8 and not (first & mask):
        mask >>= 1
        width += 1

    if width > 8:
        raise EbmlParseError(f"VINT com largura inválida (>8) no offset {pos}.")

    if pos + width > len(data):
        raise EbmlParseError(f"Dados insuficientes para ler VINT completo no offset {pos}.")

    value = first & (mask - 1)
    for i in range(1, width):
        value = (value << 8) | data[pos + i]

    return value, width


def read_element_header(data: bytes, pos: int = 0) -> dict[str, Any]:
    """
    Decodifica o cabeçalho de um elemento EBML (ID + Size).
    Retorna metadados do cabeçalho.
    """
    element_id, id_len = read_id(data, pos)
    size, size_len = read_vint(data, pos + id_len)

    # Identifica tamanho indefinido (ex: Segment de live streams ou sem tamanho pré-definido)
    unknown_size = size == ((1 << (7 * size_len)) - 1)

    return {
        "id": element_id,
        "size": size,
        "id_len": id_len,
        "size_len": size_len,
        "header_size": id_len + size_len,
        "unknown_size": unknown_size,
    }


def read_element(data: bytes, pos: int = 0) -> dict[str, Any]:
    """
    Lê os limites de um elemento EBML completo a partir de pos.
    """
    header = read_element_header(data, pos)
    content_start = pos + header["header_size"]

    if header["unknown_size"]:
        content_end = len(data)
    else:
        content_end = content_start + header["size"]

    if content_end > len(data):
        raise EbmlParseError(
            f"Elemento 0x{header['id']:X} se estende além do buffer disponível: {content_end} > {len(data)}"
        )

    return {
        **header,
        "start": pos,
        "content_start": content_start,
        "content_end": content_end,
    }


def iter_elements(data: bytes, start: int, end: int) -> Generator[dict[str, Any], None, None]:
    """
    Itera sobre elementos irmãos em uma região [start, end].
    """
    pos = start
    while pos < end:
        element = read_element(data, pos)
        yield element

        if element["content_end"] <= pos:
            raise EbmlParseError(f"Parser EBML estagnou no offset {pos}.")

        pos = element["content_end"]


def read_uint(data: bytes, element: dict[str, Any]) -> int:
    """Decodifica o conteúdo do elemento como inteiro sem sinal (big-endian)."""
    return int.from_bytes(data[element["content_start"]:element["content_end"]], "big")


def read_string(data: bytes, element: dict[str, Any]) -> str:
    """Decodifica o conteúdo do elemento como string UTF-8."""
    return data[element["content_start"]:element["content_end"]].decode("utf-8", errors="replace")


def find_all_valid_elements(data: bytes, target_id: int) -> list[dict[str, Any]]:
    """
    Varre o buffer procurando todas as ocorrências válidas de um determinado ID EBML.
    """
    results = []
    raw = target_id.to_bytes((target_id.bit_length() + 7) // 8, "big")
    search_from = 0

    while True:
        pos = data.find(raw, search_from)
        if pos == -1:
            break

        try:
            element = read_element(data, pos)
            results.append(element)
        except (ValueError, EbmlParseError):
            pass

        search_from = pos + 1

    return results
