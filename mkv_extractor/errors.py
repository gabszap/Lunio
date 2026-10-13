"""
Exceções padronizadas para o extractor remoto de Matroska (MKV).
"""

class RemoteMkvError(Exception):
    """Exceção base para todos os erros do mkv_extractor."""
    pass


class HttpRangeError(RemoteMkvError):
    """Erro em requisições HTTP Range ou status inesperado do servidor."""

    def __init__(self, message: str, status: int | None = None, retry_after: int | None = None):
        super().__init__(message)
        # Status HTTP quando o servidor respondeu (429 = limite de requisições do CDN) e o Retry-After em segundos
        self.status = status
        self.retry_after = retry_after


class EbmlParseError(RemoteMkvError):
    """Erro durante leitura ou decodificação de elementos EBML."""
    pass


class MatroskaStructureError(RemoteMkvError):
    """Erro estrutural no container Matroska (ex: Segment ausente ou corrompido)."""
    pass


class TrackNotFoundError(RemoteMkvError):
    """Faixa de legenda solicitada não foi encontrada no container."""
    pass


class CuesNotFoundError(RemoteMkvError):
    """Índice Cues não encontrado nem no SeekHead nem no scan do final do arquivo."""
    pass


class NoRelativePositionError(RemoteMkvError):
    """Cues da faixa não possuem CueRelativePosition para acesso direto ao bloco."""
    pass


class CodecNotSupportedError(RemoteMkvError):
    """Codec de legenda não suportado para extração de texto (ex: PGS/VobSub bitmap)."""
    pass
