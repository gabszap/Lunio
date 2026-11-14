"""Publicação atômica de legendas, com ou sem substituição do destino."""
import os
from pathlib import Path
import tempfile


def publish_subtitle(path, content, unique=False):
    requested = Path(path)
    requested.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".mkv-sub-", suffix=".tmp", dir=requested.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if not unique:
            os.replace(temporary, requested)
            return requested
        candidate, index = requested, 0
        while True:
            try:
                # Link publica o arquivo completo sem substituir outro destino,
                # inclusive quando duas operações concorrem pelo mesmo nome.
                os.link(temporary, candidate)
                return candidate
            except FileExistsError:
                index += 1
                candidate = requested.with_name(f"{requested.stem} ({index}){requested.suffix}")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
