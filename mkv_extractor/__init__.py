"""
mkv_extractor: Extrator remoto ultrarrápido de legendas Matroska (MKV) via HTTP Range.
"""

from .errors import (
    CodecNotSupportedError,
    CuesNotFoundError,
    EbmlParseError,
    HttpRangeError,
    MatroskaStructureError,
    NoRelativePositionError,
    RemoteMkvError,
    TrackNotFoundError,
)
from .extractor import extract_remote_subtitle
from .subtitles import select_subtitle_track

__all__ = [
    "extract_remote_subtitle",
    "select_subtitle_track",
    "RemoteMkvError",
    "HttpRangeError",
    "EbmlParseError",
    "MatroskaStructureError",
    "TrackNotFoundError",
    "CuesNotFoundError",
    "NoRelativePositionError",
    "CodecNotSupportedError",
]
