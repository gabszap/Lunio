"""
Cliente HTTP especializado em Range Requests e multipart/byteranges.
"""

import http.client
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from email import policy
from email.parser import BytesParser

from .errors import HttpRangeError


def get_ssl_context() -> ssl.SSLContext:
    """Cria contexto SSL permissivo para CDNs e resolvers com certificados intermediários."""
    return ssl._create_unverified_context()


def safe_url(url: str) -> str:
    """Só o host: a URL do CDN/Torrentio carrega o token no caminho ou na query e não pode ir para mensagens de erro."""
    try:
        parts = urllib.parse.urlparse(url)
        return f"{parts.scheme}://{parts.netloc}/…" if parts.netloc else "(url)"
    except Exception:
        return "(url)"


def _retry_after_seconds(headers) -> int | None:
    value = headers.get("Retry-After") if headers else None
    return int(value) if value and value.strip().isdigit() else None


def open_http(url: str, headers: dict, timeout: int = 60):
    """Executa requisição HTTP utilizando urllib."""
    request = urllib.request.Request(url, headers=headers)
    try:
        return urllib.request.urlopen(
            request,
            timeout=timeout,
            context=get_ssl_context(),
        )
    except urllib.error.HTTPError as exc:
        # O servidor respondeu com erro: o status importa (429 = esperar, não insistir)
        raise HttpRangeError(
            f"HTTP {exc.code} de {safe_url(url)}",
            status=exc.code,
            retry_after=_retry_after_seconds(exc.headers),
        ) from exc
    except Exception as exc:
        raise HttpRangeError(f"Falha de conexão HTTP com {safe_url(url)}: {type(exc).__name__}") from exc


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

    except HttpRangeError:
        raise
    except Exception as exc:
        raise HttpRangeError(f"Erro ao resolver URL '{safe_url(url)}': {type(exc).__name__}") from exc

    if not content_range:
        raise HttpRangeError(f"Servidor não retornou o header Content-Range ao acessar {safe_url(url)}")

    match = re.search(r"/(\d+)$", content_range.strip())
    if not match:
        raise HttpRangeError(f"Formato de Content-Range inválido retornado pelo servidor: '{content_range}'")

    total_size = int(match.group(1))
    return final_url, total_size


# Uma conexão persistente por host. Cada range abrindo conexão nova pagava DNS+TCP+TLS (~3 idas e voltas) e, num
# arquivo com centenas de blocos de legenda, estourava o tempo; reaproveitando a conexão cada range custa 1 ida e volta.
_connections: dict[tuple[str, str], http.client.HTTPConnection] = {}
# Servidores que respondem a um pedido de vários ranges só com o primeiro (o TorBox faz isso): não vale tentar de novo
_multirange_unsupported: set[str] = set()


def _connection_for(parts: urllib.parse.ParseResult, timeout: int) -> http.client.HTTPConnection:
    key = (parts.scheme, parts.netloc)
    conn = _connections.get(key)
    if conn is None:
        if parts.scheme == "https":
            conn = http.client.HTTPSConnection(parts.netloc, timeout=timeout, context=get_ssl_context())
        else:
            conn = http.client.HTTPConnection(parts.netloc, timeout=timeout)
        _connections[key] = conn
    return conn


def _drop_connection(parts: urllib.parse.ParseResult) -> None:
    conn = _connections.pop((parts.scheme, parts.netloc), None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


def close_connections() -> None:
    """Fecha as conexões persistentes (fim da extração e testes)."""
    for key in list(_connections):
        conn = _connections.pop(key)
        try:
            conn.close()
        except Exception:
            pass


def _fetch_range(url: str, start: int, end: int, timeout: int) -> bytes | None:
    """
    Pede um range numa conexão persistente. Devolve None quando a resposta não dá para tratar aqui (redirecionamento):
    quem chamou cai no caminho antigo, uma requisição por range via urllib.
    """
    parts = urllib.parse.urlparse(url)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    headers = {
        "Range": f"bytes={start}-{end}",
        "User-Agent": "Lunio-Remote-MKV/1.0",
        "Accept": "*/*",
        "Connection": "keep-alive",
    }

    last_exc: Exception | None = None
    for _attempt in (1, 2):  # a 2a é para quando o servidor fechou a conexão ociosa
        conn = _connection_for(parts, timeout)
        try:
            conn.request("GET", path, headers=headers)
            response = conn.getresponse()
            data = response.read()
        except (http.client.HTTPException, OSError) as exc:
            last_exc = exc
            _drop_connection(parts)
            continue

        if response.status in (301, 302, 303, 307, 308):
            _drop_connection(parts)
            return None
        if response.status not in (200, 206):
            retry = _retry_after_seconds(response.headers)
            if response.getheader("Connection", "").lower() == "close":
                _drop_connection(parts)
            raise HttpRangeError(
                f"HTTP {response.status} de {safe_url(url)} ao solicitar range {start}-{end}",
                status=response.status,
                retry_after=retry,
            )
        if response.getheader("Connection", "").lower() == "close":
            _drop_connection(parts)
        return data

    raise HttpRangeError(
        f"Falha de conexão HTTP com {safe_url(url)}: {type(last_exc).__name__ if last_exc else 'desconhecida'}"
    )


def supports_multirange(url: str, timeout: int = 30) -> bool:
    """O servidor devolve multipart/byteranges quando pedimos dois ranges? (O TorBox responde só o primeiro.)"""
    host = urllib.parse.urlparse(url).netloc
    if host in _multirange_unsupported:
        return False
    headers = {"Range": "bytes=0-0,2-2", "User-Agent": "Lunio-Remote-MKV/1.0", "Accept": "*/*"}
    try:
        with open_http(url, headers, timeout=timeout) as response:
            response.read()
            if response.status == 206 and "multipart/byteranges" in (response.headers.get("Content-Type") or "").lower():
                return True
    except HttpRangeError as exc:
        if exc.status == 429:
            raise
    _multirange_unsupported.add(host)
    return False


def measure_rtt(url: str, timeout: int = 30) -> float:
    """Tempo de um range de 1 byte numa conexão já aberta (a segunda requisição não paga DNS+TCP+TLS)."""
    import time

    read_range(url, 0, 0, timeout=timeout)
    started = time.monotonic()
    read_range(url, 1, 1, timeout=timeout)
    return time.monotonic() - started


def read_range(url: str, start: int, end: int, timeout: int = 60, verbose: bool = False) -> bytes:
    """Lê um range específico de bytes (start a end inclusive) via HTTP 206."""
    data = _fetch_range(url, start, end, timeout)
    if data is None:
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

    host = urllib.parse.urlparse(url).netloc
    if host not in _multirange_unsupported:
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
                else:
                    # Respondeu só o primeiro range, sem multipart: não pergunta de novo nos próximos lotes
                    _multirange_unsupported.add(host)
        except HttpRangeError as exc:
            if exc.status == 429:
                raise
            if verbose:
                print(f"[HTTP Multi-Range] Falha no multipart ({exc}), alternando para requisições individuais...")
        except Exception as exc:
            if verbose:
                print(f"[HTTP Multi-Range] Falha no multipart ({exc}), alternando para requisições individuais...")

    # Fallback transparente para servidores sem suporte a multipart
    result = {}
    for start, end in unique_ranges:
        result[(start, end)] = read_range(url, start, end, timeout=timeout, verbose=False)

    return result
