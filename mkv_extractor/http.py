"""
Cliente HTTP especializado em Range Requests e multipart/byteranges.
"""

import http.client
import ipaddress
import os
import socket
import sys
from contextvars import ContextVar
from functools import wraps
import re
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
from email import policy
from email.parser import BytesParser
from email.message import Message
from email.utils import collapse_rfc2231_value

from .errors import HttpRangeError, UrlBlockedError


def _default_ssl_context() -> ssl.SSLContext:
    """Cria contexto TLS verificado, evitando o store CA expirado do Windows."""
    if sys.platform != "win32" or os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR"):
        return ssl.create_default_context()

    # No Windows, load_default_certs() carrega os stores "CA" e "ROOT". O store "CA" acumula
    # intermediários cross-signed expirados (ex.: ISRG Root X2 vencido em 2025), que o OpenSSL
    # prioriza sobre a cadeia válida enviada pelo servidor. Carregar apenas "ROOT" (e certifi
    # quando disponível) mantém a verificação estrita sem envenenar o trust store.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_REQUIRED
    context.check_hostname = True
    loaded = False
    if hasattr(ssl, "enum_certificates"):
        certs = bytearray()
        try:
            for cert, encoding, trust in ssl.enum_certificates("ROOT"):
                if encoding == "x509_asn" and (trust is True or ssl.Purpose.SERVER_AUTH.oid in trust):
                    certs.extend(cert)
        except PermissionError:
            pass
        if certs:
            context.load_verify_locations(cadata=bytes(certs))
            loaded = True
    try:
        import certifi
    except ImportError:
        certifi = None
    if certifi is not None:
        context.load_verify_locations(cafile=certifi.where())
        loaded = True
    if loaded:
        context.set_default_verify_paths()
    else:
        context.load_default_certs(ssl.Purpose.SERVER_AUTH)
    return context


def get_ssl_context() -> ssl.SSLContext:
    """Valida HTTPS com as CAs do sistema ou um contexto fornecido pela operação."""
    session = _active_session.get()
    if session and session.ssl_context:
        return session.ssl_context
    if session is not None:
        if session._default_ssl_context is None:
            session._default_ssl_context = _default_ssl_context()
        return session._default_ssl_context
    return _default_ssl_context()


_active_session: ContextVar = ContextVar("mkv_range_session", default=None)
_thread_state = threading.local()


class RangeSession:
    """Recursos, validadores e métricas pertencem a uma operação, não ao host global."""
    def __init__(self, *, ssl_context=None, verify_version=True, public_only=False, allowed_origins=(), coalesce_gap_bytes=0, coalesce_extra_bytes=65536, max_boundary_headers=4096):
        self.ssl_context = ssl_context
        self._default_ssl_context = None
        self.verify_version = verify_version
        self.public_only = public_only
        self.allowed_origins = {origin.rstrip("/") for origin in allowed_origins}
        self.connections = {}
        self.unsupported_multipart = set()
        self.multipart_capabilities = {}
        self.coalesce_gap_bytes = coalesce_gap_bytes
        self.coalesce_extra_bytes = coalesce_extra_bytes
        self.coalesced_extra_bytes = 0
        self.max_boundary_headers = max_boundary_headers
        self.boundary_probes = 0
        self.total = None
        self.etag = None
        self.last_modified = None
        self.requests = 0
        self.bytes_received = 0

    def __enter__(self):
        self.token = _active_session.set(self)
        return self

    def __exit__(self, *exc):
        self.close()
        _active_session.reset(self.token)

    def close(self):
        for conn in list(self.connections.values()):
            conn.close()
        self.connections.clear()


def _state():
    active = _active_session.get()
    if active is not None:
        return active
    if not hasattr(_thread_state, "session"):
        _thread_state.session = RangeSession(verify_version=False)
    return _thread_state.session


def range_operation(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        if _active_session.get() is not None:
            return function(*args, **kwargs)
        with RangeSession(public_only=kwargs.get("public_only", False), allowed_origins=kwargs.get("allowed_origins", ()), coalesce_gap_bytes=kwargs.get("coalesce_gap_bytes", 0), coalesce_extra_bytes=kwargs.get("coalesce_extra_bytes", 65536), max_boundary_headers=kwargs.get("max_boundary_headers", 4096)) as session:
            result = function(*args, **kwargs)
            items = result if isinstance(result, list) else [result]
            for item in items:
                if isinstance(item, dict):
                    item["http_metrics"] = {"requests": session.requests, "bytes_received": session.bytes_received, "coalesced_extra_bytes": session.coalesced_extra_bytes, "boundary_probes": session.boundary_probes}
            return result
    return wrapped


def _headers(range_value):
    headers = {"Range": range_value, "User-Agent": "Lunio-Remote-MKV/1.0", "Accept": "*/*", "Accept-Encoding": "identity"}
    state = _state()
    if state.etag:
        headers["If-Match"] = state.etag
    elif state.last_modified:
        headers["If-Unmodified-Since"] = state.last_modified
    return headers


def _validate_url(url):
    try:
        parts = urllib.parse.urlsplit(url)
        parts.port
    except ValueError as exc:
        raise UrlBlockedError("URL ou porta inválida.") from exc
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise UrlBlockedError("URL inválida, com credenciais ou esquema não permitido.")
    return parts


def _dial(address, timeout, source_address=None, *, public_only=False):
    host, port = address
    choices = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if public_only:
        for _, _, _, _, target in choices:
            ip = ipaddress.ip_address(target[0].split("%", 1)[0])
            mapped = getattr(ip, "ipv4_mapped", None)
            if not (mapped or ip).is_global or (ip.version == 6 and ip in ipaddress.ip_network("64:ff9b::/96")):
                raise UrlBlockedError("Destino de rede interna não autorizado.")
    error = None
    for family, kind, protocol, _, target in choices:
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(target)  # IP já validado; não resolver DNS novamente.
            return sock
        except OSError as exc:
            error = exc
            sock.close()
    raise error or OSError("Nenhum endereço disponível")


def _new_connection(parts, timeout, **kwargs):
    state = _state()
    public = state.public_only and f"{parts.scheme}://{parts.netloc}" not in state.allowed_origins
    if parts.scheme == "https":
        conn = http.client.HTTPSConnection(parts.hostname, port=parts.port or 443, timeout=timeout, context=get_ssl_context(), **kwargs)
    else:
        conn = http.client.HTTPConnection(parts.hostname, port=parts.port or 80, timeout=timeout, **kwargs)
    conn._create_connection = lambda address, delay, source_address=None: _dial(address, delay, source_address, public_only=public)
    return conn


class _PolicyHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, current_url=None):
        super().__init__()
        self._current_url = current_url

    def http_open(self, request):
        _state().requests += 1
        if self._current_url is not None:
            self._current_url[0] = request.full_url
        parts = _validate_url(request.full_url)
        return self.do_open(lambda host, timeout, **kw: _new_connection(parts, timeout, **kw), request)


class _PolicyHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, current_url=None):
        super().__init__()
        self._current_url = current_url

    def https_open(self, request):
        _state().requests += 1
        if self._current_url is not None:
            self._current_url[0] = request.full_url
        parts = _validate_url(request.full_url)
        return self.do_open(lambda host, timeout, **kw: _new_connection(parts, timeout, **kw), request)


class _PolicyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        _validate_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)

    def http_error_302(self, request, fp, code, msg, headers):
        target = headers.get("location") or headers.get("uri")
        if not target:
            return None
        target = urllib.parse.urljoin(request.full_url, target.replace(" ", "%20"))
        new_request = self.redirect_request(request, fp, code, msg, headers, target)
        if new_request is None:
            return None
        depth = getattr(request, "_mkv_redirect_depth", 0)
        if depth >= 10:
            fp.close()
            raise HttpRangeError("Limite de redirecionamentos excedido.")
        new_request._mkv_redirect_depth = depth + 1
        fp.close()  # Não consumir corpos arbitrários de redirects.
        return self.parent.open(new_request, timeout=request.timeout)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _check_version(headers, total=None):
    state = _state()
    if not state.verify_version:
        return
    if total is not None:
        if total <= 0 or (state.total is not None and total != state.total):
            raise HttpRangeError("O tamanho da origem mudou durante a extração.")
        state.total = total
    etag = headers.get("ETag")
    modified = headers.get("Last-Modified")
    if state.etag and etag and state.etag != etag:
        raise HttpRangeError("O ETag da origem mudou durante a extração.")
    if not state.etag and state.last_modified and modified and modified != state.last_modified:
        raise HttpRangeError("A origem foi modificada durante a extração.")
    if etag and not etag.startswith("W/"):
        state.etag = etag
    if modified:
        state.last_modified = modified


def _partial_headers(response, url):
    if response.status != 206:
        raise HttpRangeError(f"HTTP {response.status} de {safe_url(url)}; Range exige 206.", status=response.status, retry_after=_retry_after_seconds(response.headers))
    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
        raise HttpRangeError("Resposta Range com Content-Encoding incompatível.")


def _read_bounded(response, limit):
    length = response.headers.get("Content-Length")
    if length is not None and (not length.isdigit() or int(length) > limit):
        raise HttpRangeError("Content-Length excede o limite da resposta Range.")
    try:
        data = response.read(limit + 1)
    except (http.client.HTTPException, OSError) as exc:
        raise HttpRangeError("Corpo Range truncado ou conexão interrompida.", reason="http_transport_error") from exc
    _state().bytes_received += len(data)
    if len(data) > limit:
        raise HttpRangeError("Corpo Range maior que o limite solicitado.")
    return data


def _single_response(response, start, end, url):
    _partial_headers(response, url)
    got_start, got_end, total = _parse_content_range(response.headers.get("Content-Range", ""))
    if (got_start, got_end) != (start, end) or total is None or not 0 <= start <= end < total:
        raise HttpRangeError("Content-Range não corresponde ao intervalo solicitado.")
    _check_version(response.headers, total)
    expected = end - start + 1
    data = _read_bounded(response, expected)
    if len(data) != expected:
        raise HttpRangeError("Corpo Range truncado.")
    return data


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


def _transport_error(url: str, exc: BaseException) -> HttpRangeError:
    """Formata falhas de transporte/TLS preservando o motivo seguro sem expor tokens ou caminhos."""
    cause = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(cause, ssl.SSLCertVerificationError):
        detail = getattr(cause, "verify_message", None) or getattr(cause, "reason", None)
        suffix = f"{type(cause).__name__} ({detail})" if detail else type(cause).__name__
        return HttpRangeError(f"Falha de conexão HTTP com {safe_url(url)}: {suffix}", reason="tls_verification_error")
    if isinstance(exc, urllib.error.URLError):
        label = f"URLError ({type(cause).__name__})" if isinstance(cause, BaseException) else "URLError"
        return HttpRangeError(f"Falha de conexão HTTP com {safe_url(url)}: {label}", reason="http_transport_error")
    return HttpRangeError(f"Falha de conexão HTTP com {safe_url(url)}: {type(exc).__name__}", reason="http_transport_error")


def open_http(url: str, headers: dict, timeout: int = 60):
    """Executa requisição HTTP utilizando urllib."""
    _validate_url(url)
    request = urllib.request.Request(url, headers=headers)
    current = [url]
    try:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _PolicyHTTPHandler(current),
            _PolicyHTTPSHandler(current),
            _PolicyRedirectHandler(),
        )
        return opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        # O servidor respondeu com erro: o status importa (429 = esperar, não insistir)
        raise HttpRangeError(
            f"HTTP {exc.code} de {safe_url(current[0])}",
            status=exc.code,
            retry_after=_retry_after_seconds(exc.headers),
        ) from exc
    except HttpRangeError:
        raise
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, HttpRangeError):
            raise exc.reason
        raise _transport_error(current[0], exc) from exc
    except Exception as exc:
        raise _transport_error(current[0], exc) from exc


def resolve_url(url: str, timeout: int = 60, verbose: bool = False, metadata: dict[str, str] | None = None) -> tuple[str, int]:
    """
    Resolve redirecionamentos (Torrentio -> TorBox / RealDebrid CDN)
    e determina o tamanho total do arquivo via Range: bytes=0-0.
    """
    headers = _headers("bytes=0-0")

    try:
        with open_http(url, headers, timeout=timeout) as response:
            final_url = response.geturl()
            content_range = response.headers.get("Content-Range")
            if metadata is not None:
                disposition = Message()
                disposition["Content-Disposition"] = response.headers.get("Content-Disposition", "")
                filename = disposition.get_filename()
                for key, value in disposition.get_params(header="Content-Disposition", unquote=True) or []:
                    if key == "filename" and isinstance(value, tuple):
                        filename = collapse_rfc2231_value(value)
                        break
                if filename:
                    metadata["filename"] = filename
            _single_response(response, 0, 0, final_url)

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
# Servidores que respondem a um pedido de vários ranges só com o primeiro (o TorBox faz isso): não vale tentar de novo


def _connection_for(parts: urllib.parse.ParseResult, timeout: int) -> http.client.HTTPConnection:
    key = (parts.scheme, parts.netloc)
    conn = _state().connections.get(key)
    if conn is None:
        conn = _new_connection(parts, timeout)
        _state().connections[key] = conn
    conn.timeout = timeout
    if conn.sock:
        conn.sock.settimeout(timeout)
    return conn


def _drop_connection(parts: urllib.parse.ParseResult) -> None:
    conn = _state().connections.pop((parts.scheme, parts.netloc), None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


def close_connections() -> None:
    """Fecha as conexões persistentes (fim da extração e testes)."""
    _state().close()


def _fetch_range(url: str, start: int, end: int, timeout: int) -> bytes | None:
    """
    Pede um range numa conexão persistente. Devolve None quando a resposta não dá para tratar aqui (redirecionamento):
    quem chamou cai no caminho antigo, uma requisição por range via urllib.
    """
    parts = _validate_url(url)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    headers = _headers(f"bytes={start}-{end}")

    last_exc: Exception | None = None
    for _attempt in (1, 2):  # a 2a é para quando o servidor fechou a conexão ociosa
        conn = _connection_for(parts, timeout)
        try:
            conn.request("GET", path, headers=headers)
            _state().requests += 1
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                _drop_connection(parts)
                return None
            data = _single_response(response, start, end, url)
        except HttpRangeError:
            _drop_connection(parts)
            raise
        except ssl.SSLCertVerificationError as exc:
            _drop_connection(parts)
            raise _transport_error(url, exc) from exc
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

    if last_exc is not None:
        raise _transport_error(url, last_exc) from last_exc
    raise HttpRangeError(f"Falha de conexão HTTP com {safe_url(url)}: desconhecida", reason="http_transport_error")


def supports_multirange(url: str, timeout: int = 30) -> bool:
    """O servidor devolve multipart/byteranges quando pedimos dois ranges? (O TorBox responde só o primeiro.)"""
    if url in _state().multipart_capabilities:
        return _state().multipart_capabilities[url]
    return _multipart_request(url, [(0, 0), (2, 2)], timeout) is not None


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
        headers = _headers(f"bytes={start}-{end}")
        with open_http(url, headers, timeout=timeout) as response:
            data = _single_response(response, start, end, url)

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


def _parse_multipart_ranges(content_type: str, body: bytes, expected_ranges=None) -> dict[tuple[int, int], bytes]:
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
    multipart_total = None
    for part in message.iter_parts():
        content_range = part.get("Content-Range")
        if not content_range:
            raise HttpRangeError("Parte multipart sem Content-Range.")
        start, end, total = _parse_content_range(content_range)
        if total is None or not 0 <= start <= end < total:
            raise HttpRangeError("Content-Range multipart inválido.")
        if multipart_total is not None and total != multipart_total:
            raise HttpRangeError("Totais divergentes nas partes multipart.")
        multipart_total = total
        _check_version({}, total)
        if (start, end) in parts:
            raise HttpRangeError("Parte multipart duplicada.")
        payload = part.get_payload(decode=True)
        if payload is None:
            raise HttpRangeError(f"Parte multipart sem payload para range {start}-{end}")

        expected = end - start + 1
        if len(payload) != expected:
            raise HttpRangeError(
                f"Tamanho inconsistente em multipart: range {start}-{end}, esperado {expected}, obtido {len(payload)}"
            )
        parts[(start, end)] = payload

    if expected_ranges is not None and set(parts) != set(expected_ranges):
        raise HttpRangeError("Multipart incompleto ou contém partes não solicitadas.")
    return parts


def _multipart_request(url, ranges, timeout):
    headers = _headers("bytes=" + ",".join(f"{a}-{b}" for a, b in ranges))
    with open_http(url, headers, timeout=timeout) as response:
        _partial_headers(response, url)
        content_type = response.headers.get("Content-Type", "")
        if "multipart/byteranges" not in content_type.lower():
            # Um 206 correto só para o primeiro range demonstra ausência de multipart.
            _single_response(response, *ranges[0], url)
            _state().unsupported_multipart.add(url)
            _state().multipart_capabilities[url] = False
            return None
        _check_version(response.headers)
        limit = sum(b - a + 1 for a, b in ranges) + len(ranges) * 4096 + 1024
        body = _read_bounded(response, limit)
        parts = _parse_multipart_ranges(content_type, body, ranges)
        _state().multipart_capabilities[url] = True
        return parts


def _read_ranges_exact(
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

    if url not in _state().unsupported_multipart:
        parts = _multipart_request(url, unique_ranges, timeout)
        if parts is not None:
            return parts

    # Fallback transparente para servidores sem suporte a multipart
    result = {}
    for start, end in unique_ranges:
        result[(start, end)] = read_range(url, start, end, timeout=timeout, verbose=False)

    return result


def read_ranges(url, ranges, timeout=60, verbose=False):
    """Coalescência opcional, com limite total de bytes extras por operação."""
    state = _state()
    requested = list(dict.fromkeys(ranges))
    if not state.coalesce_gap_bytes or not requested:
        return _read_ranges_exact(url, requested, timeout=timeout, verbose=verbose)
    merged = []
    remaining = state.coalesce_extra_bytes - state.coalesced_extra_bytes
    for start, end in sorted(requested):
        if start < 0 or end < start:
            raise HttpRangeError("Intervalo solicitado inválido.")
        if merged:
            gap = max(0, start - merged[-1][1] - 1)
            if gap <= state.coalesce_gap_bytes and gap <= remaining:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
                remaining -= gap
                state.coalesced_extra_bytes += gap
                continue
        merged.append((start, end))
    parts = _read_ranges_exact(url, merged, timeout=timeout, verbose=verbose)
    result = {}
    for start, end in requested:
        for a, b in merged:
            if a <= start <= end <= b:
                result[(start, end)] = parts[(a, b)][start-a:end-a+1]
                break
    return result
