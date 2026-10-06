"""
Cliente HTTP especializado em Range Requests e multipart/byteranges.
"""

import re
import ssl
import urllib.parse
import urllib.request
from email import policy
from email.parser import BytesParser

from .errors import HttpRangeError


def get_ssl_context() -> ssl.SSLContext:
    """Cria contexto SSL permissivo para CDNs e resolvers com certificados intermediários."""
    return ssl._create_unverified_context()


def open_http(url: str, headers: dict, timeout: int = 60):
    """Executa requisição HTTP utilizando urllib."""
    request = urllib.request.Request(url, headers=headers)
    try:
        return urllib.request.urlopen(
            request,
            timeout=timeout,
            context=get_ssl_context(),
        )
    except Exception as exc:
        raise HttpRangeError(f"Falha de conexão HTTP com {url}: {exc}") from exc


def resolve_url(url: str, timeout: int = 60, verbose: bool = False) -> tuple[str, int]:
    """
    Resolve redirecionamentos (Torrentio -> TorBox / RealDebrid CDN)
    e determina o tamanho total do arquivo via Range: bytes=0-0.
    """
    headers = {
        "Range": "bytes=0-0",
        "User-Agent": "Lunio-Remote-MKV/1.0",
        "Accept": "*/*",
    }

    try:
        with open_http(url, headers, timeout=timeout) as response:
            final_url = response.geturl()
            content_range = response.headers.get("Content-Range")
            response.read()

            if verbose:
                netloc = urllib.parse.urlparse(final_url).netloc
                print(f"[HTTP] Status: {response.status} | Final host: {netloc} | Content-Range: {content_range}")

    except Exception as exc:
        raise HttpRangeError(f"Erro ao resolver URL '{url}': {exc}") from exc

    if not content_range:
        raise HttpRangeError(f"Servidor não retornou o header Content-Range ao acessar {url}")

    match = re.search(r"/(\d+)$", content_range.strip())
    if not match:
        raise HttpRangeError(f"Formato de Content-Range inválido retornado pelo servidor: '{content_range}'")

    total_size = int(match.group(1))
    return final_url, total_size


def read_range(url: str, start: int, end: int, timeout: int = 60, verbose: bool = False) -> bytes:
    """Lê um range específico de bytes (start a end inclusive) via HTTP 206."""
    headers = {
        "Range": f"bytes={start}-{end}",
        "User-Agent": "Lunio-Remote-MKV/1.0",
        "Accept": "*/*",
    }

    with open_http(url, headers, timeout=timeout) as response:
        if response.status not in (200, 206):
            raise HttpRangeError(f"Servidor retornou HTTP {response.status} ao solicitar range {start}-{end}")
        data = response.read()

        if verbose:
            print(f"[HTTP Range] {start:,}-{end:,} ({len(data):,} bytes)")

        return data


def _parse_content_range(value: str) -> tuple[int, int, int | None]:
    match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", value.strip(), re.IGNORECASE)
    if not match:
        raise HttpRangeError(f"Content-Range inválido no multipart: '{value}'")
    start = int(match.group(1))
    end = int(match.group(2))
    total = None if match.group(3) == "*" else int(match.group(3))
    return start, end, total


def _parse_multipart_ranges(content_type: str, body: bytes) -> dict[tuple[int, int], bytes]:
    synthetic = (
        b"MIME-Version: 1.0\r\n"
        + b"Content-Type: "
        + content_type.encode("ascii", errors="strict")
        + b"\r\n\r\n"
        + body
    )

    message = BytesParser(policy=policy.default).parsebytes(synthetic)
    if not message.is_multipart():
        raise HttpRangeError("Resposta não é do tipo multipart/byteranges.")

    parts = {}
    for part in message.iter_parts():
        content_range = part.get("Content-Range")
        if not content_range:
            continue
        start, end, _ = _parse_content_range(content_range)
        payload = part.get_payload(decode=True)
        if payload is None:
            raise HttpRangeError(f"Parte multipart sem payload para range {start}-{end}")

        expected = end - start + 1
        if len(payload) != expected:
            raise HttpRangeError(
                f"Tamanho inconsistente em multipart: range {start}-{end}, esperado {expected}, obtido {len(payload)}"
            )
        parts[(start, end)] = payload

    return parts


def read_ranges(
    url: str,
    ranges: list[tuple[int, int]],
    timeout: int = 60,
    verbose: bool = False,
) -> dict[tuple[int, int], bytes]:
    """
    Solicita múltiplos ranges em uma única requisição HTTP via multipart/byteranges.
    Caso a CDN / servidor não suporte multipart, executa fallback automático para requisições individuais.
    """
    unique_ranges = list(dict.fromkeys(ranges))
    if not unique_ranges:
        return {}

    if len(unique_ranges) == 1:
        start, end = unique_ranges[0]
        return {(start, end): read_range(url, start, end, timeout=timeout, verbose=verbose)}

    range_header = "bytes=" + ",".join(f"{start}-{end}" for start, end in unique_ranges)
    headers = {
        "Range": range_header,
        "User-Agent": "Lunio-Remote-MKV/1.0",
        "Accept": "*/*",
    }

    try:
        with open_http(url, headers, timeout=timeout) as response:
            body = response.read()
            content_type = response.headers.get("Content-Type") or ""

            if response.status == 206 and "multipart/byteranges" in content_type.lower():
                parts = _parse_multipart_ranges(content_type, body)
                missing = [r for r in unique_ranges if r not in parts]
                if not missing:
                    if verbose:
                        print(f"[HTTP Multi-Range] {len(unique_ranges)} ranges recebidos via multipart ({len(body):,} bytes)")
                    return parts
    except Exception as exc:
        if verbose:
            print(f"[HTTP Multi-Range] Falha no multipart ({exc}), alternando para requisições individuais...")

    # Fallback transparente para servidores sem suporte a multipart
    result = {}
    for start, end in unique_ranges:
        result[(start, end)] = read_range(url, start, end, timeout=timeout, verbose=False)

    return result
