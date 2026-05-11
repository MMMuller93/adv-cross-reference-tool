"""Pytest fixtures for the end-to-end N-PORT integration tests.

Spins up a private Postgres instance in a tempdir, applies the schema
migrations + a tiny manual seed (Anthropic, OpenAI, SpaceX, sanctioned
Russian companies), exposes a connection string + a psycopg connection
factory. Tears everything down at session end.

Tested on Postgres 17.9 (Homebrew). Skips the whole module if the
``initdb`` / ``postgres`` / ``pg_ctl`` binaries aren't on PATH.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Iterator

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
NPORT_DIR = REPO_ROOT / "nport"
MIGRATIONS_DIR = NPORT_DIR / "migrations"
SEED_LOADER_DIR = NPORT_DIR / "seed_loader"


def _have_postgres_binaries() -> bool:
    for b in ("initdb", "postgres", "pg_ctl", "psql"):
        if shutil.which(b) is None:
            return False
    return True


def _find_free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_pg(host: str, port: int, timeout_s: float = 20.0) -> None:
    """Poll until pg accepts TCP connections, or raise."""
    deadline = time.time() + timeout_s
    last_exc: Exception | None = None
    while time.time() < deadline:
        try:
            with closing(socket.create_connection((host, port), timeout=1.0)):
                return
        except OSError as exc:
            last_exc = exc
            time.sleep(0.2)
    raise RuntimeError(
        f"Postgres did not become ready on {host}:{port} within {timeout_s}s "
        f"(last error: {last_exc})"
    )


@pytest.fixture(scope="session")
def pg_dsn(tmp_path_factory) -> Iterator[str]:
    """Boot a private Postgres cluster for the session and yield a DSN.

    Returns ``postgresql://...`` connection string. Cleans up the data
    directory and stops the server in the finalizer.
    """
    if not _have_postgres_binaries():
        pytest.skip("Postgres tools (initdb/postgres/pg_ctl/psql) not on PATH")
    if os.environ.get("NPORT_E2E_SKIP") == "1":
        pytest.skip("NPORT_E2E_SKIP=1 — skipping integration test by request")

    base = tmp_path_factory.mktemp("nport-e2e")
    data_dir = base / "pgdata"
    log_file = base / "pg.log"
    # macOS Unix-socket paths cap at 103 bytes. Use a short, unique path
    # under /tmp so we stay well under the limit regardless of pytest's
    # tempdir depth.
    socket_dir = Path(f"/tmp/nport-e2e-{uuid.uuid4().hex[:8]}")
    socket_dir.mkdir(parents=True, exist_ok=True)
    port = _find_free_port()

    user = "nport"
    # initdb the cluster.
    pw_file = base / "pw"
    pw_file.write_text("nport-e2e-secret\n")
    subprocess.run(
        [
            "initdb",
            "-D",
            str(data_dir),
            "-U",
            user,
            "--auth=trust",
            "--encoding=UTF8",
            "--locale=C",
        ],
        check=True,
        capture_output=True,
    )

    # Start the server. Use the unix socket dir in tempdir so we don't
    # collide with any system-wide Postgres on the default port.
    # Setting LC_ALL=C avoids the macOS "postmaster became multithreaded"
    # error when locale resolution loads thread-spawning frameworks.
    pg_env = os.environ.copy()
    pg_env["LC_ALL"] = "C"
    pg_env["LANG"] = "C"
    pg_proc = subprocess.Popen(
        [
            "postgres",
            "-D",
            str(data_dir),
            "-p",
            str(port),
            "-k",
            str(socket_dir),
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            "fsync=off",
            "-c",
            "synchronous_commit=off",
            "-c",
            "full_page_writes=off",
        ],
        stdout=open(log_file, "wb"),
        stderr=subprocess.STDOUT,
        env=pg_env,
    )

    try:
        _wait_for_pg("127.0.0.1", port)

        # Create the target database.
        db_name = "nport_e2e"
        subprocess.run(
            [
                "psql",
                "-h",
                "127.0.0.1",
                "-p",
                str(port),
                "-U",
                user,
                "-d",
                "postgres",
                "-c",
                f"CREATE DATABASE {db_name}",
            ],
            check=True,
            capture_output=True,
        )

        dsn = f"postgresql://{user}@127.0.0.1:{port}/{db_name}"

        # Apply migrations.
        for sql_path in sorted(MIGRATIONS_DIR.glob("0*.sql")):
            subprocess.run(
                [
                    "psql",
                    "-h",
                    "127.0.0.1",
                    "-p",
                    str(port),
                    "-U",
                    user,
                    "-d",
                    db_name,
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-f",
                    str(sql_path),
                ],
                check=True,
                capture_output=True,
            )

        yield dsn
    finally:
        # Try a graceful shutdown via pg_ctl, then fall back to terminate.
        try:
            subprocess.run(
                ["pg_ctl", "-D", str(data_dir), "stop", "-m", "fast"],
                timeout=10,
                capture_output=True,
            )
        except Exception:
            pass
        if pg_proc.poll() is None:
            pg_proc.terminate()
            try:
                pg_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pg_proc.kill()
        # Best-effort cleanup of the short socket dir under /tmp.
        try:
            shutil.rmtree(socket_dir, ignore_errors=True)
        except Exception:
            pass


@pytest.fixture(scope="session")
def seeded_dsn(pg_dsn: str) -> str:
    """Apply the manual private-company + alias seed required by the e2e flow.

    Inserts Anthropic / OpenAI / SpaceX plus a small alias set, then
    seeds a handful of sanctioned Russian-issuer aliases. This stays
    tiny on purpose so failures are easy to read.
    """
    import psycopg

    with psycopg.connect(pg_dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            # Private companies
            cur.execute(
                """
                INSERT INTO private_companies
                    (slug, display_name, sector, is_sanctioned, is_acquired, lifecycle_status, seed_source)
                VALUES
                    ('anthropic', 'Anthropic',  'ai_ml',  false, false, 'private', 'manual'),
                    ('openai',    'OpenAI',     'ai_ml',  false, false, 'private', 'manual'),
                    ('spacex',    'SpaceX',     'space_defense', false, false, 'private', 'manual'),
                    ('sberbank',  'Sberbank',   'fintech', true,  false, 'private', 'manual'),
                    ('lukoil',    'Lukoil',     'energy',  true,  false, 'private', 'manual'),
                    ('rosneft',   'Rosneft',    'energy',  true,  false, 'private', 'manual')
                """
            )

            # Aliases — feed exactly what the resolver expects to find.
            cur.execute(
                """
                INSERT INTO private_company_aliases (company_id, pattern_type, pattern, exposure_type)
                SELECT id, 'exact_normalized', 'ANTHROPIC',          'direct' FROM private_companies WHERE slug='anthropic' UNION ALL
                SELECT id, 'exact_normalized', 'ANTHROPIC PBC',      'direct' FROM private_companies WHERE slug='anthropic' UNION ALL
                SELECT id, 'prefix',           'ANTHROPIC',          'direct' FROM private_companies WHERE slug='anthropic' UNION ALL
                SELECT id, 'exact_normalized', 'OPENAI',             'direct' FROM private_companies WHERE slug='openai' UNION ALL
                SELECT id, 'exact_normalized', 'OPENAI GLOBAL',      'direct' FROM private_companies WHERE slug='openai' UNION ALL
                SELECT id, 'exact_normalized', 'OPENAI OPCO',        'direct' FROM private_companies WHERE slug='openai' UNION ALL
                SELECT id, 'prefix',           'OPENAI',             'direct' FROM private_companies WHERE slug='openai' UNION ALL
                SELECT id, 'exact_normalized', 'SPACEX',             'direct' FROM private_companies WHERE slug='spacex' UNION ALL
                SELECT id, 'exact_normalized', 'SPACE EXPLORATION TECHNOLOGIES','direct' FROM private_companies WHERE slug='spacex' UNION ALL
                SELECT id, 'prefix',           'SPACEX',             'direct' FROM private_companies WHERE slug='spacex' UNION ALL
                SELECT id, 'prefix',           'SPACE EXPLORATION',  'direct' FROM private_companies WHERE slug='spacex' UNION ALL
                SELECT id, 'exact_normalized', 'SBERBANK',           'direct' FROM private_companies WHERE slug='sberbank' UNION ALL
                SELECT id, 'exact_normalized', 'LUKOIL',             'direct' FROM private_companies WHERE slug='lukoil' UNION ALL
                SELECT id, 'exact_normalized', 'ROSNEFT',            'direct' FROM private_companies WHERE slug='rosneft'
                """
            )
    return pg_dsn
