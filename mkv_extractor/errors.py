"""
Exceções padronizadas para o extractor remoto de Matroska (MKV).
"""

class RemoteMkvError(Exception):
    """Exceção base para todos os erros do mkv_extractor."""
    fallback_reason = "extraction_failed"


class CueCoverageError(RemoteMkvError):
    def __init__(self, coverage):
        super().__init__(f"Cobertura dos Cues: {coverage}.")
        self.fallback_reason = f"cues_{coverage}"


class UnsupportedFeatureError(RemoteMkvError):
    def __init__(self, reason, message):
        super().__init__(message)
        self.fallback_reason = reason


class HttpRangeError(RemoteMkvError):
    """Erro em requisições HTTP Range ou status inesperado do servidor."""
    fallback_reason = "http_range_invalid"

    def __init__(self, message: str, status: int | None = None, retry_after: int | None = None, reason: str | None = None):
        super().__init__(message)
        if reason:
            self.fallback_reason = reason
        # Status HTTP quando o servidor respondeu (429 = limite de requisições do CDN) e o Retry-After em segundos
        self.status = status
        self.retry_after = retry_after


class UrlBlockedError(HttpRangeError):
    fallback_reason = "url_blocked"


class PreferFfmpegError(RemoteMkvError):
    """O CDN não aceita vários ranges numa requisição e a conta de requisições sai mais cara que ler o arquivo todo."""
    fallback_reason = "multipart_unavailable_too_slow"


class EbmlParseError(RemoteMkvError):
    """Erro durante leitura ou decodificação de elementos EBML."""
    fallback_reason = "invalid_ebml"


class MatroskaStructureError(RemoteMkvError):
    """Erro estrutural no container Matroska (ex: Segment ausente ou corrompido)."""
    fallback_reason = "invalid_structure"


class TrackNotFoundError(RemoteMkvError):
    """Faixa de legenda solicitada não foi encontrada no container."""
    fallback_reason = "track_not_found"


class CuesNotFoundError(RemoteMkvError):
    """Índice Cues não encontrado nem no SeekHead nem no scan do final do arquivo."""
    fallback_reason = "cues_missing"


class NoRelativePositionError(RemoteMkvError):
    """Cues da faixa não possuem CueRelativePosition para acesso direto ao bloco."""
    fallback_reason = "cues_no_relative_position"


class CodecNotSupportedError(RemoteMkvError):
    """Codec de legenda não suportado para extração de texto (ex: PGS/VobSub bitmap)."""
    fallback_reason = "unsupported_codec"
