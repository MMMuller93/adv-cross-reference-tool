#!/usr/bin/env python3
"""
Cross-Reference Matcher - Pre-computes ADV/Form D matches
Runs weekly via GitHub Actions to refresh the cross_reference_matches table

Uses environment variables for credentials (set in GitHub Secrets):
- ADV_URL, ADV_KEY: ADV Supabase database
- FORMD_URL, FORMD_KEY: Form D Supabase database
"""

import os
import re
from datetime import datetime
from supabase import create_client

# Load from environment variables (GitHub Secrets)
ADV_URL = os.environ.get('ADV_URL', 'https://ezuqwwffjgfzymqxsctq.supabase.co')
ADV_KEY = os.environ.get('ADV_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE')

FORMD_URL = os.environ.get('FORMD_URL', 'https://ltdalxkhbbhmkimmogyq.supabase.co')
FORMD_KEY = os.environ.get('FORMD_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc')

adv_client = create_client(ADV_URL, ADV_KEY)
formd_client = create_client(FORMD_URL, FORMD_KEY)


def normalize_name(name):
    """Normalize fund name for matching"""
    if not name:
        return ''

    normalized = str(name).upper()

    replacements = [
        ', LLC', ' LLC', ', LP', ' LP', ', L.P.', ' L.P.',
        ', L.L.C.', ' L.L.C.', ' INC', ' INC.', ', INC', ', INC.',
        ' FUND', ' A SERIES OF', ', A SERIES OF'
    ]

    for r in replacements:
        normalized = normalized.replace(r, ' ')

    return re.sub(r'\s+', ' ', normalized).strip()


def edit_distance(s1, s2):
    """Calculate Levenshtein edit distance"""
    if len(s1) > len(s2):
        s1, s2 = s2, s1

    distances = range(len(s1) + 1)
    for i2, c2 in enumerate(s2):
        distances_ = [i2+1]
        for i1, c1 in enumerate(s1):
            if c1 == c2:
                distances_.append(distances[i1])
            else:
                distances_.append(1 + min((distances[i1], distances[i1 + 1], distances_[-1])))
        distances = distances_
    return distances[-1]


def similarity(s1, s2):
    """Calculate similarity score between two strings"""
    longer = s1 if len(s1) > len(s2) else s2
    shorter = s2 if len(s1) > len(s2) else s1

    if len(longer) == 0:
        return 1.0

    return (len(longer) - edit_distance(longer, shorter)) / len(longer)


def fetch_all_paginated(client, table, select='*', batch_size=1000):
    """Fetch all records from a table with pagination"""
    print(f"Fetching {table}...")
    all_data = []
    offset = 0

    while True:
        response = client.table(table).select(select).range(offset, offset + batch_size - 1).execute()

        if not response.data:
            break

        all_data.extend(response.data)
        offset += batch_size

        print(f"  Loaded {len(all_data)} records...")

        if len(response.data) < batch_size:
            break

    print(f"  Total: {len(all_data)} records")
    return all_data


def check_discrepancies(adv_fund, formd_filing):
    """Check for discrepancies between ADV and Form D"""
    issues = []

    # Fund type mismatch
    adv_type = (adv_fund.get('fund_type') or '').upper()
    formd_type = (formd_filing.get('investmentfundtype') or '').upper()

    if adv_type and formd_type:
        if (('PRIVATE EQUITY' in adv_type and 'VENTURE' in formd_type) or
            ('VENTURE' in adv_type and 'PRIVATE EQUITY' in formd_type)):
            issues.append('Fund type mismatch: PE vs VC')

        if (('HEDGE' in adv_type and 'HEDGE' not in formd_type) or
            ('HEDGE' not in adv_type and 'HEDGE' in formd_type)):
            issues.append('Hedge fund classification mismatch')

    return issues


def compute_matches():
    """Main matching algorithm"""
    print("=" * 60)
    print("CROSS-REFERENCE MATCHER")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 60)

    # Fetch ADV data
    print("\n1. Fetching ADV funds...")
    adv_funds = fetch_all_paginated(adv_client, 'funds_enriched')

    print("\n2. Fetching advisers...")
    advisers = fetch_all_paginated(
        adv_client,
        'advisers_enriched',
        'crd, adviser_name, primary_website, type, total_aum, aum_2025'
    )

    # Create adviser lookup
    adviser_map = {adv['crd']: adv for adv in advisers if adv.get('crd')}
    print(f"  Indexed {len(adviser_map)} advisers")

    # Cross-reference
    print("\n3. Finding matches...")
    all_matches = []
    processed = 0

    for adv_fund in adv_funds:
        processed += 1
        if processed % 5000 == 0:
            print(f"  Processed {processed}/{len(adv_funds)}... ({len(all_matches)} matches)")

        adv_norm = normalize_name(adv_fund.get('fund_name'))
        if not adv_norm or len(adv_norm) < 3:
            continue

        # Query Form D for similar names
        search_term = adv_norm[:10] if len(adv_norm) >= 10 else adv_norm

        try:
            response = formd_client.table('form_d_filings').select('*').ilike(
                'entityname', f'%{search_term}%'
            ).limit(5).execute()

            if not response.data:
                continue

            for formd_filing in response.data:
                formd_norm = normalize_name(formd_filing.get('entityname'))
                sim = similarity(adv_norm, formd_norm)

                if sim < 0.85:
                    continue

                issues = check_discrepancies(adv_fund, formd_filing)
                adviser = adviser_map.get(adv_fund.get('adviser_entity_crd'), {})

                # Check if ADV is overdue (no filing in 2+ years)
                latest_year = None
                for year in range(2025, 2010, -1):
                    if adv_fund.get(f'gav_{year}'):
                        latest_year = year
                        break
                overdue = latest_year and latest_year < 2024

                match = {
                    'formd_accession': formd_filing.get('accessionnumber'),
                    'formd_entity_name': formd_filing.get('entityname'),
                    'formd_filing_date': formd_filing.get('filing_date'),
                    'formd_offering_amount': formd_filing.get('totalofferingamount'),
                    'adv_fund_id': adv_fund.get('fund_id'),
                    'adv_fund_name': adv_fund.get('fund_name'),
                    'adv_filing_date': adv_fund.get('updated_at'),
                    'adv_gav': adv_fund.get('latest_gross_asset_value'),
                    'adviser_entity_crd': adv_fund.get('adviser_entity_crd'),
                    'adviser_entity_legal_name': adviser.get('adviser_name'),
                    'match_score': round(sim, 3),
                    'issues': ' | '.join(issues) if issues else '',
                    'overdue_adv_flag': overdue,
                    'latest_adv_year': latest_year,
                    'computed_at': datetime.utcnow().isoformat()
                }

                all_matches.append(match)

        except Exception as e:
            if processed % 5000 == 0:
                print(f"  Error: {e}")
            continue

    print(f"\n  Found {len(all_matches)} total matches")
    return all_matches


def store_matches(matches):
    """Store matches in Form D database"""
    print("\n4. Storing results...")

    # Clear existing (delete in batches to avoid timeout)
    print("  Clearing old matches...")
    try:
        formd_client.table('cross_reference_matches').delete().neq('id', 0).execute()
    except Exception as e:
        print(f"  Warning clearing table: {e}")

    # Insert in batches
    batch_size = 500
    for i in range(0, len(matches), batch_size):
        batch = matches[i:i+batch_size]
        try:
            formd_client.table('cross_reference_matches').insert(batch).execute()
            print(f"  Inserted batch {i//batch_size + 1} ({len(batch)} records)")
        except Exception as e:
            print(f"  Error inserting batch: {e}")

    print(f"\n  Stored {len(matches)} matches")


if __name__ == '__main__':
    try:
        matches = compute_matches()
        store_matches(matches)
        print("\n" + "=" * 60)
        print("SUCCESS!")
        print(f"Completed at: {datetime.utcnow().isoformat()}")
        print("=" * 60)
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        exit(1)
