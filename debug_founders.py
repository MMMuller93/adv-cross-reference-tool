#!/usr/bin/env python3
from supabase import create_client

FORMD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0ZGFseGtoYmJobWtpbW1vZ3lxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk1OTg3NTMsImV4cCI6MjA3NTE3NDc1M30.TS9uNMRqPKcthHCSMKAcFfhFEP-7Q6XbDHQNujBDOtc'
formd_client = create_client('https://ltdalxkhbbhmkimmogyq.supabase.co', FORMD_KEY)

ADV_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6dXF3d2ZmamdmenltcXhzY3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjY0NDAsImV4cCI6MjA3ODkwMjQ0MH0.RGMhIb7yMXmOQpysiPgazxJzflGKNCdzRZ8XBgPDCAE'
adv_client = create_client('https://ezuqwwffjgfzymqxsctq.supabase.co', ADV_KEY)

# Check if there's a "FOUNDERS FUND LLC" adviser
print("=== Advisers with 'Founders Fund' in name ===")
advisers = adv_client.table('advisers_enriched').select('crd,adviser_name').ilike('adviser_name', '%founders fund%').execute()
for a in advisers.data[:10]:
    print(f"  CRD {a['crd']}: {a['adviser_name']}")

# Check what Form D entities contain "Founders Fund"
print("\n=== Form D entities with 'Founders Fund' ===")
formd = formd_client.table('form_d_filings').select('entityname,file_num,totalofferingamount').ilike('entityname', '%Founders Fund%').limit(20).execute()
for r in formd.data:
    print(f"  {r['entityname'][:60]} | file: {r.get('file_num','-')} | ${r.get('totalofferingamount','?')}")

# Check cross_reference_matches for 'founders' - what adv_fund_name and adviser_entity_crd are linked
print("\n=== Cross reference matches with 'founders' - checking adviser CRD ===")
matches = formd_client.table('cross_reference_matches').select('adv_fund_name,formd_entity_name,adviser_entity_crd,adviser_entity_legal_name').ilike('adv_fund_name', '%founders%').limit(30).execute()
for m in matches.data[:30]:
    print(f"ADV: {m['adv_fund_name'][:50]}")
    print(f"  -> Form D: {m['formd_entity_name'][:50] if m.get('formd_entity_name') else 'None'}")
    print(f"  -> Adviser: CRD {m.get('adviser_entity_crd')} - {m.get('adviser_entity_legal_name','?')[:40]}")
    print()
