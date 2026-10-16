"""Temporary paths that inherit ordinary workspace permissions."""

from __future__ import annotations

import os
import secrets
import tempfile
from pathlib import Path


_CREATE_ATTEMPTS = 32


def create_inherited_temp_dir(prefix: str, *, parent: str | os.PathLike[str] | None = None) -> Path:
    """Create a unique directory without ``tempfile``'s private ACL.

    ``tempfile.mkdtemp`` creates a private directory on Windows.  Some
    managed profiles and OneDrive/NFS mounts reject child creation in that
    directory, even for its creator.  An exclusive ordinary ``mkdir`` keeps
    collision safety while inheriting the parent directory permissions.
    """

    base = Path(parent) if parent is not None else Path(tempfile.gettempdir())
    base.mkdir(parents=True, exist_ok=True)
    for _ in range(_CREATE_ATTEMPTS):
        candidate = base / f"{prefix}{secrets.token_hex(16)}"
        try:
            candidate.mkdir()
        except FileExistsError:
            continue
        return candidate
    raise FileExistsError(f"Could not allocate a unique temporary directory under {base}")
