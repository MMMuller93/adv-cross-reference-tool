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
# Use 'or' to handle empty strings from GitHub Actions when secrets aren't configured
ADV_URL = os.environ.get('ADV_URL') or 'https://ezuqwwffjgfzymqxsctq.supabase.co'
ADV_KEY = os.environ.get('ADV_KEY') or 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE'

FORMD_URL = os.environ.get('FORMD_URL') or 'https://ltdalxkhbbhmkimmogyq.supabase.co'
FORMD_KEY = os.environ.get('FORMD_KEY') or 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'

adv_client = create_client(ADV_URL, ADV_KEY)
formd_client = create_client(FORMD_URL, FORMD_KEY)


def normalize_name_for_match(name):
    """
    Normalize fund name for EXACT matching.

    DESIGN DECISIONS (2024-11-30):
    -----------------------------
    Goal: Match ADV fund names to Form D entity names despite minor formatting differences.

    What we normalize:
    1. Case: "Tiger Fund" == "TIGER FUND" (uppercase everything)
    2. Punctuation: Remove commas, periods, quotes, parens, hyphens, slashes
       - "FUND, L.P." → "FUND L P"
    3. Whitespace: Collapse multiple spaces → single space
    4. Entity suffixes: Remove trailing LLC, LP, L P, L L C, INC, LTD, etc.
       - "TIGER FUND LP" → "TIGER FUND"
       - "TIGER FUND L P" → "TIGER FUND" (handles "L.P." → "L P" after punctuation removal)

    TRADE-OFFS & POTENTIAL ISSUES:
    - Removing suffixes could cause false positives if two funds differ only by suffix
      e.g., "ABC FUND LP" and "ABC FUND LLC" would both normalize to "ABC FUND"
      Decision: Accept this risk - rare in practice, and missing matches is worse
    - We don't handle abbreviations: "INTL" vs "INTERNATIONAL", "MGMT" vs "MANAGEMENT"
      Decision: Too risky for false positives, revisit if match rate is still low
    - We don't handle word reordering: "Fund ABC" vs "ABC Fund"
      Decision: Would require fuzzy matching, not doing that

    VALIDATION:
    - 50,479 ADV funds have form_d_file_number (claim to have filed Form D)
    - Target: Match as close to 50k as possible
    - If match count is much lower, revisit normalization rules

    TO REVISIT IF ISSUES ARISE:
    - If false positives: Make suffix removal more conservative
    - If low match rate: Add more suffix variations, consider file number matching
    """
    if not name:
        return ''

    # 1. Uppercase
    normalized = str(name).upper()

    # 2. Remove ALL punctuation FIRST (before suffix removal)
    # This handles cases like "FUND,L.P." where there's no space
    normalized = re.sub(r'[,.\'"()\-/]', ' ', normalized)

    # 3. Collapse whitespace
    normalized = re.sub(r'\s+', ' ', normalized).strip()

    # 4. Remove suffix WORDS at the end (handles "L P" from "L.P.", "L L C" from "L.L.C.")
    # Process multiple times to handle compound suffixes
    suffix_words = ['LLC', 'LP', 'L P', 'L L C', 'INC', 'LTD', 'CO', 'CORP', 'CORPORATION', 'COMPANY', 'LIMITED']
    changed = True
    while changed:
        changed = False
        for suffix in suffix_words:
            if normalized.endswith(' ' + suffix):
                normalized = normalized[:-len(suffix)-1].strip()
                changed = True
                break

    return normalized


# Note: edit_distance and similarity functions removed - using exact matching instead


def fetch_all_keyset(client, table, select='*', batch_size=100, id_column='id'):
    """
    Fetch all records using KEYSET pagination (not OFFSET).

    KEYSET pagination is O(1) regardless of position - no slowdown on large offsets.
    Uses: WHERE {id_column} > last_id ORDER BY {id_column} LIMIT batch_size

    Much more reliable than OFFSET pagination for large tables.
    """
    import time
    print(f"Fetching {table} (keyset pagination on {id_column})...")
    all_data = []
    last_id = 0
    retries = 0
    max_retries = 5

    # Ensure id_column is in select for keyset pagination
    if select != '*' and id_column not in select:
        select = id_column + ',' + select

    while True:
        try:
            response = (client.table(table)
                .select(select)
                .gt(id_column, last_id)
                .order(id_column)
                .limit(batch_size)
                .execute())

            if not response.data:
                break

            all_data.extend(response.data)
            last_id = response.data[-1][id_column]  # Track last ID for next query
            retries = 0  # Reset retries on success

            if len(all_data) % 10000 == 0:
                print(f"  Loaded {len(all_data)} records...")

            if len(response.data) < batch_size:
                break

        except Exception as e:
            retries += 1
            if retries > max_retries:
                print(f"  Failed after {max_retries} retries at {id_column}>{last_id}: {e}")
                print(f"  Stopping fetch - manual intervention may be needed")
                break
            # Exponential backoff: 2, 4, 8, 16, 32 seconds
            wait_time = 2 ** retries
            print(f"  Retry {retries}/{max_retries} at {id_column}>{last_id}, waiting {wait_time}s...")
            time.sleep(wait_time)

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
    """
    Main matching algorithm - uses EXACT matching (case-insensitive, punctuation-normalized).
    Each ADV fund gets at most ONE Form D match.
    """
    print("=" * 60)
    print("CROSS-REFERENCE MATCHER (Exact Matching)")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 60)

    # Fetch ALL Form D filings first and build lookup map
    print("\n1. Fetching Form D filings...")
    formd_filings = fetch_all_keyset(
        formd_client,
        'form_d_filings',
        'accessionnumber,entityname,filing_date,totalofferingamount,investmentfundtype'
    )

    # Build lookup map: normalized_name -> filing (keep most recent if duplicates)
    print("  Building Form D lookup map...")
    formd_map = {}
    for filing in formd_filings:
        entity_name = filing.get('entityname')
        if not entity_name:
            continue
        normalized = normalize_name_for_match(entity_name)
        if not normalized:
            continue
        # Keep the filing (if duplicate normalized names, later entries overwrite - typically more recent)
        formd_map[normalized] = filing

    print(f"  Indexed {len(formd_map)} unique Form D entities")

    # Fetch ADV data (use reference_id for keyset pagination since no 'id' column)
    print("\n2. Fetching ADV funds...")
    adv_funds = fetch_all_keyset(adv_client, 'funds_enriched', id_column='reference_id')

    print("\n3. Fetching advisers...")
    advisers = fetch_all_keyset(
        adv_client,
        'advisers_enriched',
        'crd, adviser_name, primary_website, type, total_aum, aum_2025',
        id_column='crd'
    )

    # Create adviser lookup
    adviser_map = {adv['crd']: adv for adv in advisers if adv.get('crd')}
    print(f"  Indexed {len(adviser_map)} advisers")

    # Cross-reference using EXACT matching
    print("\n4. Finding exact matches...")
    all_matches = []
    matched_count = 0
    no_match_count = 0

    for i, adv_fund in enumerate(adv_funds):
        if (i + 1) % 10000 == 0:
            print(f"  Processed {i + 1}/{len(adv_funds)}... ({matched_count} matches)")

        fund_name = adv_fund.get('fund_name')
        if not fund_name:
            continue

        # Normalize ADV fund name
        adv_normalized = normalize_name_for_match(fund_name)
        if not adv_normalized or len(adv_normalized) < 3:
            continue

        # EXACT lookup in Form D map
        formd_filing = formd_map.get(adv_normalized)

        if not formd_filing:
            no_match_count += 1
            continue

        matched_count += 1

        # Check for discrepancies
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
            'match_score': 1.0,  # Exact match
            'issues': ' | '.join(issues) if issues else '',
            'overdue_adv_flag': overdue,
            'latest_adv_year': latest_year,
            'computed_at': datetime.utcnow().isoformat()
        }

        all_matches.append(match)

    print(f"\n  Results:")
    print(f"    - Total ADV funds: {len(adv_funds)}")
    print(f"    - Exact matches found: {matched_count}")
    print(f"    - No match: {no_match_count}")

    return all_matches


def store_matches(matches):
    """Store matches in Form D database"""
    print("\n5. Storing results...")

    # Clear existing data in batches to avoid timeout
    print("  Clearing old matches (in batches)...")
    deleted_total = 0
    while True:
        try:
            # Delete a batch of rows
            response = formd_client.table('cross_reference_matches').delete().neq('id', 0).limit(5000).execute()
            if not response.data:
                break
            deleted_count = len(response.data)
            deleted_total += deleted_count
            print(f"    Deleted {deleted_total} rows...")
            if deleted_count < 5000:
                break
        except Exception as e:
            print(f"  Warning during delete: {e}")
            break

    print(f"  Cleared {deleted_total} old matches")

    # Insert new matches in batches
    print(f"  Inserting {len(matches)} new matches...")
    batch_size = 500
    for i in range(0, len(matches), batch_size):
        batch = matches[i:i+batch_size]
        try:
            formd_client.table('cross_reference_matches').insert(batch).execute()
            if (i // batch_size + 1) % 10 == 0:
                print(f"    Inserted {i + len(batch)}/{len(matches)} records...")
        except Exception as e:
            print(f"  Error inserting batch {i//batch_size + 1}: {e}")

    print(f"\n  Done! Stored {len(matches)} matches")


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
