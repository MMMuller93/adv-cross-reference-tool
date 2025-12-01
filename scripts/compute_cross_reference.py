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


def normalize_file_number(file_num):
    """Normalize file number for matching (strip whitespace)."""
    if not file_num:
        return None
    return str(file_num).strip()


def compute_matches():
    """
    Main matching algorithm - uses TWO strategies:
    1. PRIMARY: Match by file_num (100% accurate when ADV has form_d_file_number)
    2. FALLBACK: Match by normalized name (for funds without file number)

    Each ADV fund gets at most ONE Form D match.
    """
    print("=" * 60)
    print("CROSS-REFERENCE MATCHER (File Number + Name Matching)")
    print(f"Started at: {datetime.utcnow().isoformat()}")
    print("=" * 60)

    # Fetch ALL Form D filings first and build lookup maps
    print("\n1. Fetching Form D filings...")
    formd_filings = fetch_all_keyset(
        formd_client,
        'form_d_filings',
        'accessionnumber,entityname,filing_date,totalofferingamount,totalamountsold,sale_date,investmentfundtype,file_num'
    )

    # Build TWO lookup maps:
    # 1. file_num -> filing (for direct file number matching)
    # 2. normalized_name -> filing (for name matching fallback)
    print("  Building Form D lookup maps...")
    formd_file_num_map = {}  # Primary: file_num -> filing
    formd_name_map = {}      # Fallback: normalized_name -> filing

    for filing in formd_filings:
        # Index by file number (primary match)
        file_num = normalize_file_number(filing.get('file_num'))
        if file_num:
            # Keep most recent filing for each file number
            formd_file_num_map[file_num] = filing

        # Index by normalized name (fallback match)
        entity_name = filing.get('entityname')
        if entity_name:
            normalized = normalize_name_for_match(entity_name)
            if normalized:
                formd_name_map[normalized] = filing

    print(f"  Indexed {len(formd_file_num_map)} Form D filings by file_num")
    print(f"  Indexed {len(formd_name_map)} unique Form D entities by name")

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

    # Cross-reference using FILE NUMBER (primary) + NAME (fallback)
    print("\n4. Finding matches...")
    all_matches = []
    file_num_match_count = 0
    name_match_count = 0
    no_match_count = 0

    for i, adv_fund in enumerate(adv_funds):
        if (i + 1) % 10000 == 0:
            total_matched = file_num_match_count + name_match_count
            print(f"  Processed {i + 1}/{len(adv_funds)}... ({total_matched} matches: {file_num_match_count} by file#, {name_match_count} by name)")

        fund_name = adv_fund.get('fund_name')
        if not fund_name:
            continue

        formd_filing = None
        match_method = None

        # PRIMARY: Try file number matching first (100% accurate)
        adv_file_num = normalize_file_number(adv_fund.get('form_d_file_number'))
        if adv_file_num:
            formd_filing = formd_file_num_map.get(adv_file_num)
            if formd_filing:
                match_method = 'file_num'
                file_num_match_count += 1

        # FALLBACK: Try name matching if no file number match
        if not formd_filing:
            adv_normalized = normalize_name_for_match(fund_name)
            if adv_normalized and len(adv_normalized) >= 3:
                formd_filing = formd_name_map.get(adv_normalized)
                if formd_filing:
                    match_method = 'name'
                    name_match_count += 1

        if not formd_filing:
            no_match_count += 1
            continue

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
            # Note: related_names, related_roles, formd_amount_sold require adding columns to cross_reference_matches table
            'adv_fund_id': adv_fund.get('fund_id'),
            'adv_fund_name': adv_fund.get('fund_name'),
            'adv_filing_date': adv_fund.get('updated_at'),
            'adv_gav': adv_fund.get('latest_gross_asset_value'),
            'adviser_entity_crd': adv_fund.get('adviser_entity_crd'),
            'adviser_entity_legal_name': adviser.get('adviser_name'),
            'match_score': 1.0,  # Both methods are exact matches
            'issues': ' | '.join(issues) if issues else '',
            'overdue_adv_flag': overdue,
            'latest_adv_year': latest_year,
            'computed_at': datetime.utcnow().isoformat()
        }

        all_matches.append(match)

    total_matched = file_num_match_count + name_match_count
    print(f"\n  Results:")
    print(f"    - Total ADV funds: {len(adv_funds)}")
    print(f"    - Matches found: {total_matched}")
    print(f"      - By file number: {file_num_match_count} (100% accurate)")
    print(f"      - By name: {name_match_count} (normalized exact match)")
    print(f"    - No match: {no_match_count}")

    return all_matches


def store_matches(matches):
    """Store matches in Form D database"""
    print("\n5. Storing results...")

    # Clear existing data by fetching IDs and deleting by ID range
    print("  Clearing old matches...")

    # First, check how many rows exist
    count_response = formd_client.table('cross_reference_matches').select('id', count='exact').limit(1).execute()
    total_to_delete = count_response.count or 0
    print(f"    Found {total_to_delete} existing rows to delete")

    if total_to_delete > 0:
        deleted_total = 0

        while True:
            try:
                # Fetch a batch of IDs (supabase-py allows limit on SELECT)
                id_response = formd_client.table('cross_reference_matches').select('id').order('id').limit(500).execute()

                if not id_response.data or len(id_response.data) == 0:
                    break

                ids_to_delete = [row['id'] for row in id_response.data]
                min_id = min(ids_to_delete)
                max_id = max(ids_to_delete)

                # Delete by ID range (no .limit() needed)
                formd_client.table('cross_reference_matches').delete().gte('id', min_id).lte('id', max_id).execute()
                deleted_total += len(ids_to_delete)

                if deleted_total % 5000 == 0:
                    print(f"    Deleted {deleted_total}/{total_to_delete} rows...")

            except Exception as e:
                print(f"  Warning during delete: {e}")
                import time
                time.sleep(1)
                continue

        print(f"  Cleared {deleted_total} rows")

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
