"""N-PORT private-company holdings subsystem.

A standalone subtree that ingests SEC Form N-PORT filings, resolves
issuer rows to canonical private-company entities, enriches with N-CSR /
N-CEN / N-1A data, computes quarter-over-quarter deltas, and exposes an
HTTP API for the frontend at ``nport/frontend/``.

This package is intentionally self-contained: it never imports from the
top-level PrivateFundsRadar codebase, and the main PFR ``server.js`` does
not import from here. Integration is a separate decision.

See ``nport/PLAN.md`` for the full design spec.
"""
