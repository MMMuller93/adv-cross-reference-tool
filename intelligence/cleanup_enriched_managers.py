"""One-shot cleanup: apply enrichment_validator to existing enriched_managers
rows, NULL out fields that fail validation.

Run after deploying enrichment_validator.py. The original enrichment_engine_v2
sometimes returns wrong data even when its own AI validation flags a
mismatch (Codex 2026-05-20 finding); this script retroactively cleans
those values out of the live table so the UI stops showing them.

CLI:
  python intelligence/cleanup_enriched_managers.py                  # dry-run
  python intelligence/cleanup_enriched_managers.py --execute        # writes
  python intelligence/cleanup_enriched_managers.py --execute --source intel_company_advisers
  python intelligence/cleanup_enriched_managers.py --crd 108281     # one firm
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from materialize_holders import create_formd_client, load_credentials
from enrichment_validator import validate_enrichment


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--execute', action='store_true', help='Apply UPDATEs')
    p.add_argument('--source', help='Only rows with enrichment_source=this')
    p.add_argument('--crd', help='Only this CRD')
    args = p.parse_args(argv)

    load_credentials()
    formd = create_formd_client()

    q = formd.table('enriched_managers').select(
        'id,series_master_llc,linked_crd,website_url,linkedin_company_url,'
        'twitter_handle,primary_contact_email,team_members,confidence_score,'
        'enrichment_source'
    )
    if args.source:
        q = q.eq('enrichment_source', args.source)
    if args.crd:
        q = q.eq('linked_crd', args.crd)
    rows = q.execute().data or []
    print(f'Loaded {len(rows)} rows.')

    nulled_field_count = 0
    rows_updated = 0
    for row in rows:
        firm = row.get('series_master_llc') or ''
        payload = {
            'website_url': row.get('website_url'),
            'linkedin_company_url': row.get('linkedin_company_url'),
            'twitter_handle': row.get('twitter_handle'),
            'primary_contact_email': row.get('primary_contact_email'),
            'team_members': row.get('team_members'),
        }
        cleaned, audit = validate_enrichment(firm, payload)

        diff = {}
        for k in payload:
            if payload[k] != cleaned.get(k):
                diff[k] = (payload[k], cleaned.get(k))
        if not diff:
            continue

        print(f'\n{firm} (CRD {row.get("linked_crd")} id={row.get("id")}):')
        for field, val, reason in audit:
            print(f'  ! {field}={val!r} -> {reason}')

        # Apply update
        if args.execute:
            update = {k: v for k, v in cleaned.items() if k in diff}
            formd.table('enriched_managers').update(update).eq('id', row['id']).execute()
            rows_updated += 1
        nulled_field_count += sum(1 for k, v in diff.items() if v[1] is None and v[0] is not None)

    print(f'\nFields nulled across all rows: {nulled_field_count}')
    print(f'Rows updated: {rows_updated} ({"--execute" if args.execute else "DRY RUN"})')


if __name__ == '__main__':
    raise SystemExit(main())
