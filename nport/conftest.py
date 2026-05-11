"""Pytest bootstrap for the nport subtree.

Ensures the parent of ``nport/`` is on ``sys.path`` so absolute imports
like ``from nport.scraper.config import ...`` resolve in development
without requiring ``pip install -e .`` first.
"""
from __future__ import annotations

import sys
from pathlib import Path

_NPORT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _NPORT_DIR.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
