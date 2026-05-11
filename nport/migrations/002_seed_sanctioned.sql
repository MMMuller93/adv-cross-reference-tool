-- =============================================================================
-- Seed: sanctioned_securities
-- =============================================================================
-- Per §3.2 of PLAN_NPORT_HOLDINGS.md:
--   "Russian sanctioned securities pollute rankings — Sberbank, Lukoil, Polyus,
--    Norilsk Nickel, Gazprom, Novatek, Evraz, etc. score high on filer count
--    (15-30 filers each) but are at zero book value since 2022.
--    Add an explicit exclusion list for sanctioned securities — they're noise."
--
-- Patterns are matched case-insensitively against normalized issuer names
-- (uppercase, entity suffixes stripped). Storing patterns in UPPERCASE per
-- existing project convention (see normalize_name_for_match in CLAUDE.md).
--
-- Sources:
--   - OFAC SDN list (Russia / Ukraine-related sanctions, Directive 1/2/3/4)
--   - U.S. Treasury Executive Orders 14024, 14066, 14068, 14071
--   - PLAN_NPORT_HOLDINGS.md §3.2 explicit call-outs
--
-- Run with:
--   psql "$DATABASE_URL" -f migrations/nport/002_seed_sanctioned.sql
-- =============================================================================

INSERT INTO sanctioned_securities (pattern, reason) VALUES
  -- Russian state-owned & sanctioned (explicit call-outs from §3.2)
  ('SBERBANK',                    'OFAC Russia 2022 — Executive Order 14024 (state-owned bank)'),
  ('LUKOIL',                      'OFAC Russia 2022 — Executive Order 14071 (oil & gas)'),
  ('POLYUS',                      'OFAC Russia 2022 — gold mining'),
  ('NORILSK NICKEL',              'OFAC Russia 2022 — metals & mining'),
  ('GAZPROM',                     'OFAC Russia 2022 — Directive 3 (state-owned gas)'),
  ('NOVATEK',                     'OFAC Russia 2022 — Directive 4 (LNG / gas)'),
  ('EVRAZ',                       'OFAC Russia 2022 — steel'),
  ('NOVOLIPETSK STEEL',           'OFAC Russia 2022 — steel (NLMK)'),
  ('TATNEFT',                     'OFAC Russia 2022 — oil & gas'),
  ('SURGUTNEFTEGAS',              'OFAC Russia 2022 — oil & gas'),
  ('ROSNEFT',                     'OFAC Russia 2022 — Directive 2 (state-owned oil)'),
  ('MAGNIT',                      'OFAC Russia 2022 — retail (sanctioned-adjacent)'),

  -- Additional OFAC SDN-pattern Russian state-owned / sanctioned entities
  ('VTB BANK',                    'OFAC Russia 2022 — Executive Order 14024 (state-owned bank)'),
  ('GAZPROMBANK',                 'OFAC Russia 2022 — state-owned bank'),
  ('SOVCOMBANK',                  'OFAC Russia 2022 — sanctioned bank'),
  ('ALFA-BANK',                   'OFAC Russia 2022 — sanctioned bank'),
  ('ROSSELKHOZBANK',              'OFAC Russia 2022 — Russian Agricultural Bank'),
  ('OTKRITIE',                    'OFAC Russia 2022 — sanctioned bank'),
  ('MOSCOW EXCHANGE',             'OFAC Russia 2022 — MOEX, sanctioned market infrastructure'),
  ('AEROFLOT',                    'OFAC Russia 2022 — state-owned airline'),
  ('ROSTEC',                      'OFAC Russia 2022 — state defense conglomerate'),
  ('ROSATOM',                     'OFAC Russia 2022 — state nuclear corporation'),
  ('TRANSNEFT',                   'OFAC Russia 2022 — state-owned pipeline'),
  ('SEVERSTAL',                   'OFAC Russia 2022 — steel'),
  ('MECHEL',                      'OFAC Russia 2022 — metals & mining'),
  ('PHOSAGRO',                    'OFAC Russia 2022 — fertilizers'),
  ('ALROSA',                      'OFAC Russia 2022 — state-owned diamond producer'),
  ('UC RUSAL',                    'OFAC Russia 2022 — aluminum'),
  ('MOBILE TELESYSTEMS',          'OFAC Russia 2022 — MTS, telecom'),
  ('YANDEX',                      'OFAC Russia 2022 — sanctioned-adjacent / Russian tech');

-- Verification:
--   SELECT count(*) FROM sanctioned_securities;
--   -- expect 30 rows
