// ============================================================================
// N-PORT mock fixtures — testable UI without a live backend.
// Exposed as window.NPORT_MOCKS. Shape matches API contract in
// PLAN_NPORT_HOLDINGS.md §7.1. Real distribution data drawn from §3.2.
// Mock mode triggered by ?mock=1 on the URL.
// ============================================================================
(function () {
  'use strict';

  // ---- Companies index -----------------------------------------------------
  // Keyed by slug. Each company also has positions / holders / timeseries /
  // markups / cross arrays addressable by the same slug.
  const companies = {
    anthropic: {
      slug: 'anthropic',
      display_name: 'Anthropic',
      primary_domain: 'anthropic.com',
      sector: 'ai_ml',
      description: 'AI safety company; builder of the Claude family of language models.',
      founded_year: 2021,
      hq_country: 'US',
      hq_state: 'CA',
      most_recent_round: 'Series F',
      most_recent_round_date: '2026-01-15',
      latest_known_valuation_usd: 183_000_000_000,
      total_funding_usd: 19_500_000_000,
      total_disclosed_usd: 1_690_000_000,
      distinct_filers: 52,
      nport_latest_value_usd: 1_690_000_000,
      nport_latest_holder_count: 52,
      nport_latest_period_date: '2025-12-31',
      search_rank_score: 256.2,
      lifecycle_status: 'private'
    },
    openai: {
      slug: 'openai',
      display_name: 'OpenAI',
      primary_domain: 'openai.com',
      sector: 'ai_ml',
      description: 'OpenAI Group PBC — frontier AI lab; ChatGPT, GPT-5.',
      founded_year: 2015,
      hq_country: 'US',
      hq_state: 'CA',
      most_recent_round: 'Tender 2026',
      most_recent_round_date: '2026-02-01',
      latest_known_valuation_usd: 500_000_000_000,
      total_funding_usd: 22_000_000_000,
      total_disclosed_usd: 814_400_000,
      distinct_filers: 36,
      nport_latest_value_usd: 814_400_000,
      nport_latest_holder_count: 36,
      nport_latest_period_date: '2025-12-31',
      search_rank_score: 232.7,
      lifecycle_status: 'private'
    },
    spacex: {
      slug: 'spacex',
      display_name: 'SpaceX',
      primary_domain: 'spacex.com',
      sector: 'space_defense',
      description: 'Space Exploration Technologies Corp. Launch services & Starlink.',
      founded_year: 2002,
      hq_country: 'US',
      hq_state: 'TX',
      most_recent_round: 'Tender Q1 2026',
      most_recent_round_date: '2026-03-01',
      latest_known_valuation_usd: 400_000_000_000,
      total_funding_usd: 11_000_000_000,
      total_disclosed_usd: 20_160_000_000,
      distinct_filers: 43,
      nport_latest_value_usd: 20_160_000_000,
      nport_latest_holder_count: 43,
      nport_latest_period_date: '2025-12-31',
      search_rank_score: 296.9,
      lifecycle_status: 'private'
    }
  };

  // ---- Latest marks by share class (median across holders) ---------------
  const latestMarks = {
    anthropic: {
      report_period_end: '2025-12-31',
      classes: [
        { share_class: 'Series E',  median_per_share: 231.50, holders: 8,  total_balance: 612_438 },
        { share_class: 'Series F',  median_per_share: 233.40, holders: 22, total_balance: 1_846_271 },
        { share_class: 'Series G',  median_per_share: 260.10, holders: 12, total_balance: 944_120 }
      ]
    },
    openai: {
      report_period_end: '2025-12-31',
      classes: [
        { share_class: 'Class A',           median_per_share: 76.20,  holders: 18, total_balance: 5_412_882 },
        { share_class: 'Series Tender 2024',median_per_share: 86.05,  holders: 11, total_balance: 2_103_550 },
        { share_class: 'Series Tender 2026',median_per_share: 102.40, holders: 7,  total_balance: 814_400 }
      ]
    },
    spacex: {
      report_period_end: '2025-12-31',
      classes: [
        { share_class: 'Common',     median_per_share: 421.00,  holders: 14, total_balance: 22_904_104 },
        { share_class: 'Series J',   median_per_share: 188.30,  holders: 22, total_balance: 18_421_005 },
        { share_class: 'Preferred',  median_per_share: 4210.00, holders: 7,  total_balance: 2_840_188 }
      ]
    }
  };

  // ---- QoQ markup deltas ---------------------------------------------------
  const markups = {
    anthropic: [
      { share_class: 'Series F', prev_per_share: 207.85, curr_per_share: 233.40, pct_change: 12.3, holders_moving: 22, event_date: '2025-12-31', kind: 'markup' },
      { share_class: 'Series G', prev_per_share: null,   curr_per_share: 260.10, pct_change: null, holders_moving: 12, event_date: '2025-12-31', kind: 'new' }
    ],
    openai: [
      { share_class: 'Class A',            prev_per_share: 72.10, curr_per_share: 76.20,  pct_change: 5.7,  holders_moving: 18, event_date: '2025-12-31', kind: 'markup' },
      { share_class: 'Series Tender 2026', prev_per_share: null,  curr_per_share: 102.40, pct_change: null, holders_moving: 7,  event_date: '2025-12-31', kind: 'new' }
    ],
    spacex: [
      { share_class: 'Common',    prev_per_share: 212.00,  curr_per_share: 421.00,  pct_change: 98.6, holders_moving: 14, event_date: '2025-12-31', kind: 'repricing_event', note: 'Coordinated 2× repricing across every holder' },
      { share_class: 'Preferred', prev_per_share: 2120.00, curr_per_share: 4210.00, pct_change: 98.6, holders_moving: 7,  event_date: '2025-12-31', kind: 'repricing_event', note: 'Coordinated 2× repricing across every holder' }
    ]
  };

  // ---- Top holders (current period) ---------------------------------------
  const topHolders = {
    anthropic: [
      { registrant_name: 'Fidelity Contrafund',                   registrant_cik: '0000024238', series_id: 'S000004007', share_class: 'Series E/F', value_usd: 187_000_000, balance: 802_482, pm_name: 'William Danoff' },
      { registrant_name: 'T. Rowe Price Global Technology Fund',  registrant_cik: '0000852254', series_id: 'S000007143', share_class: 'Series F-1', value_usd:  89_000_000, balance: 381_491, pm_name: 'Dom Rizzo' },
      { registrant_name: 'Baron Partners Fund',                   registrant_cik: '0000810902', series_id: 'S000010108', share_class: 'Series F',   value_usd:  62_000_000, balance: 265_650, pm_name: 'Ron Baron' },
      { registrant_name: 'BlackRock Innovation & Growth Trust',   registrant_cik: '0001814719', series_id: 'S000071420', share_class: 'Series E',   value_usd:  44_500_000, balance: 192_268, pm_name: 'Tony Kim' },
      { registrant_name: 'Morgan Stanley Insight Fund',           registrant_cik: '0000741375', series_id: 'S000010888', share_class: 'Series E',   value_usd:  33_900_000, balance: 146_393, pm_name: 'Dennis Lynch' },
      { registrant_name: 'Destiny Tech100 Inc',                   registrant_cik: '0001952520', series_id: null,         share_class: 'Series E',   value_usd:  21_400_000, balance:  92_440, pm_name: 'Sohail Prasad' },
      { registrant_name: 'ARK Venture Fund',                      registrant_cik: '0001924868', series_id: 'S000076430', share_class: 'Series C-1', value_usd:  14_000_000, balance:  60_466, pm_name: 'Cathie Wood' },
      { registrant_name: 'The Private Shares Fund',               registrant_cik: '0001505928', series_id: 'S000044130', share_class: 'Series E',   value_usd:  11_200_000, balance:  48_380, pm_name: 'Christian Munafo' }
    ],
    openai: [
      { registrant_name: 'Fidelity Blue Chip Growth Fund',  registrant_cik: '0000024238', series_id: 'S000004008', share_class: 'Class A',            value_usd: 142_000_000, balance: 1_863_517, pm_name: 'Sonu Kalra' },
      { registrant_name: 'T. Rowe Price Blue Chip Growth',  registrant_cik: '0000852254', series_id: 'S000007144', share_class: 'Class A',            value_usd:  76_000_000, balance:   997_375, pm_name: 'Paul Greene' },
      { registrant_name: 'Baron Opportunity Fund',          registrant_cik: '0000810902', series_id: 'S000010109', share_class: 'Series Tender 2024', value_usd:  58_400_000, balance:   678_675, pm_name: 'Michael Lippert' },
      { registrant_name: 'Coatue Innovation Fund',          registrant_cik: '0001902817', series_id: 'S000074810', share_class: 'Class A',            value_usd:  41_200_000, balance:   540_682, pm_name: 'Philippe Laffont' },
      { registrant_name: 'Destiny Tech100 Inc',             registrant_cik: '0001952520', series_id: null,         share_class: 'Class A',            value_usd:  29_800_000, balance:   391_076, pm_name: 'Sohail Prasad' },
      { registrant_name: 'ARK Venture Fund',                registrant_cik: '0001924868', series_id: 'S000076430', share_class: 'Class A',            value_usd:  18_400_000, balance:   241_469, pm_name: 'Cathie Wood' }
    ],
    spacex: [
      { registrant_name: 'Fidelity Contrafund',                  registrant_cik: '0000024238', series_id: 'S000004007', share_class: 'Common',    value_usd: 4_120_000_000, balance: 9_786_223, pm_name: 'William Danoff' },
      { registrant_name: 'Baron Partners Fund',                  registrant_cik: '0000810902', series_id: 'S000010108', share_class: 'Series J',  value_usd: 1_980_000_000, balance: 10_519_383, pm_name: 'Ron Baron' },
      { registrant_name: 'T. Rowe Price Global Technology Fund', registrant_cik: '0000852254', series_id: 'S000007143', share_class: 'Common',    value_usd: 1_150_000_000, balance: 2_731_592, pm_name: 'Dom Rizzo' },
      { registrant_name: 'Coatue Innovation Fund',               registrant_cik: '0001902817', series_id: 'S000074810', share_class: 'Common',    value_usd:   880_000_000, balance: 2_090_261, pm_name: 'Philippe Laffont' },
      { registrant_name: 'The Private Shares Fund',              registrant_cik: '0001505928', series_id: 'S000044130', share_class: 'Common',    value_usd:   720_000_000, balance: 1_710_213, pm_name: 'Christian Munafo' },
      { registrant_name: 'Destiny Tech100 Inc',                  registrant_cik: '0001952520', series_id: null,         share_class: 'Common',    value_usd:   412_000_000, balance: 978_622, pm_name: 'Sohail Prasad' }
    ]
  };

  // ---- Time series (total disclosed USD, by quarter) ----------------------
  // Period end dates in chronological order.
  const timeseries = {
    anthropic: [
      { period: '2024-03-31', value_usd:   210_000_000, holders: 8  },
      { period: '2024-06-30', value_usd:   312_000_000, holders: 12 },
      { period: '2024-09-30', value_usd:   480_000_000, holders: 18 },
      { period: '2024-12-31', value_usd:   790_000_000, holders: 27 },
      { period: '2025-03-31', value_usd: 1_050_000_000, holders: 34 },
      { period: '2025-06-30', value_usd: 1_280_000_000, holders: 42 },
      { period: '2025-09-30', value_usd: 1_470_000_000, holders: 48 },
      { period: '2025-12-31', value_usd: 1_690_000_000, holders: 52 }
    ],
    openai: [
      { period: '2024-03-31', value_usd:  120_000_000, holders: 6 },
      { period: '2024-06-30', value_usd:  198_000_000, holders: 9 },
      { period: '2024-09-30', value_usd:  321_000_000, holders: 14 },
      { period: '2024-12-31', value_usd:  468_000_000, holders: 19 },
      { period: '2025-03-31', value_usd:  570_000_000, holders: 24 },
      { period: '2025-06-30', value_usd:  661_000_000, holders: 29 },
      { period: '2025-09-30', value_usd:  742_000_000, holders: 33 },
      { period: '2025-12-31', value_usd:  814_400_000, holders: 36 }
    ],
    spacex: [
      { period: '2024-03-31', value_usd:  5_800_000_000, holders: 28 },
      { period: '2024-06-30', value_usd:  6_700_000_000, holders: 31 },
      { period: '2024-09-30', value_usd:  8_120_000_000, holders: 34 },
      { period: '2024-12-31', value_usd:  9_440_000_000, holders: 36 },
      { period: '2025-03-31', value_usd: 11_120_000_000, holders: 39 },
      { period: '2025-06-30', value_usd: 12_410_000_000, holders: 41 },
      { period: '2025-09-30', value_usd: 13_880_000_000, holders: 42 },
      { period: '2025-12-31', value_usd: 20_160_000_000, holders: 43 }  // 2x repricing event
    ]
  };

  // ---- All-tranches markup history (implied $/share over time) ------------
  const markupHistory = {
    anthropic: [
      { share_class: 'Series E', points: [
        { period: '2024-03-31', per_share: 142.10 },
        { period: '2024-09-30', per_share: 168.40 },
        { period: '2025-03-31', per_share: 192.00 },
        { period: '2025-09-30', per_share: 210.85 },
        { period: '2025-12-31', per_share: 231.50 }
      ]},
      { share_class: 'Series F', points: [
        { period: '2024-09-30', per_share: 180.00 },
        { period: '2025-03-31', per_share: 195.40 },
        { period: '2025-09-30', per_share: 207.85 },
        { period: '2025-12-31', per_share: 233.40 }
      ]},
      { share_class: 'Series G', points: [
        { period: '2025-12-31', per_share: 260.10 }
      ]}
    ],
    openai: [
      { share_class: 'Class A', points: [
        { period: '2024-03-31', per_share: 41.20 },
        { period: '2024-09-30', per_share: 55.10 },
        { period: '2025-03-31', per_share: 64.70 },
        { period: '2025-09-30', per_share: 72.10 },
        { period: '2025-12-31', per_share: 76.20 }
      ]},
      { share_class: 'Series Tender 2024', points: [
        { period: '2024-12-31', per_share: 71.20 },
        { period: '2025-06-30', per_share: 78.40 },
        { period: '2025-12-31', per_share: 86.05 }
      ]},
      { share_class: 'Series Tender 2026', points: [
        { period: '2025-12-31', per_share: 102.40 }
      ]}
    ],
    spacex: [
      { share_class: 'Common', points: [
        { period: '2024-03-31', per_share: 155.00 },
        { period: '2024-09-30', per_share: 188.00 },
        { period: '2025-03-31', per_share: 198.00 },
        { period: '2025-09-30', per_share: 212.00 },
        { period: '2025-12-31', per_share: 421.00 }
      ]},
      { share_class: 'Series J', points: [
        { period: '2024-09-30', per_share: 130.00 },
        { period: '2025-03-31', per_share: 162.40 },
        { period: '2025-12-31', per_share: 188.30 }
      ]}
    ]
  };

  // ---- Cross-source view (Form D + ADV + N-PORT consolidated) -------------
  const crossSource = {
    anthropic: {
      form_d_filings: [
        { accession: '0001234567-25-000019', entityname: 'Anthropic Series F SPV LLC',  series_master_llc: 'Series F SPV Group LLC', filing_date: '2025-11-04', totalofferingamount: 250_000_000 },
        { accession: '0001234567-25-000010', entityname: 'Anthropic Co-Invest 2025 LP', series_master_llc: 'Co-Invest 2025 GP LLC',  filing_date: '2025-07-22', totalofferingamount: 120_000_000 },
        { accession: '0001234567-24-000088', entityname: 'Anthropic Series E SPV LP',   series_master_llc: 'Spark Capital',          filing_date: '2024-08-18', totalofferingamount: 180_000_000 }
      ],
      related_advisers: [
        { crd: '108281', adviser_name: 'Fidelity Management & Research Co',       total_aum: 4_900_000_000_000, fund_count: 287 },
        { crd: '105769', adviser_name: 'T. Rowe Price Associates',                total_aum: 1_640_000_000_000, fund_count: 162 },
        { crd: '109032', adviser_name: 'BAMCO Inc (Baron Capital)',               total_aum:    44_000_000_000, fund_count:  22 },
        { crd: '111835', adviser_name: 'BlackRock Advisors LLC',                  total_aum: 9_400_000_000_000, fund_count: 401 }
      ]
    },
    openai: {
      form_d_filings: [
        { accession: '0001345678-26-000004', entityname: 'OpenAI Tender 2026 SPV LP',  series_master_llc: 'Forge Co-Invest Master LLC', filing_date: '2026-02-12', totalofferingamount: 480_000_000 },
        { accession: '0001345678-25-000077', entityname: 'OpenAI Strategic SPV LLC',   series_master_llc: 'Strategic SPV Group LLC',    filing_date: '2025-04-29', totalofferingamount: 240_000_000 }
      ],
      related_advisers: [
        { crd: '108281', adviser_name: 'Fidelity Management & Research Co', total_aum: 4_900_000_000_000, fund_count: 287 },
        { crd: '109032', adviser_name: 'BAMCO Inc (Baron Capital)',         total_aum:    44_000_000_000, fund_count:  22 }
      ]
    },
    spacex: {
      form_d_filings: [
        { accession: '0001456789-26-000001', entityname: 'SpaceX Common Tender Q1 2026 LP', series_master_llc: 'Tender Q1 2026 GP LLC', filing_date: '2026-03-04', totalofferingamount: 1_200_000_000 },
        { accession: '0001456789-25-000162', entityname: 'SpaceX Series J SPV LP',          series_master_llc: 'Founders Fund VIII GP', filing_date: '2025-10-11', totalofferingamount:   750_000_000 },
        { accession: '0001456789-24-000133', entityname: 'SpaceX Common SPV 2024 LLC',      series_master_llc: 'Common SPV 2024 GP LLC',filing_date: '2024-09-17', totalofferingamount:   500_000_000 }
      ],
      related_advisers: [
        { crd: '108281', adviser_name: 'Fidelity Management & Research Co', total_aum: 4_900_000_000_000, fund_count: 287 },
        { crd: '109032', adviser_name: 'BAMCO Inc (Baron Capital)',         total_aum:    44_000_000_000, fund_count:  22 },
        { crd: '105769', adviser_name: 'T. Rowe Price Associates',          total_aum: 1_640_000_000_000, fund_count: 162 }
      ]
    }
  };

  // ---- Fund pages — keyed by `${cik}:${series_id}` ------------------------
  const funds = {
    '24238:S000004007': {
      cik: '0000024238',
      series_id: 'S000004007',
      registrant_name: 'Fidelity Concord Street Trust',
      series_name: 'Fidelity Contrafund',
      adviser_name: 'Fidelity Management & Research Co',
      adviser_crd: '108281',
      fund_type: 'open_end',
      is_variable_insurance: false,
      latest_period_end: '2025-12-31',
      total_nav_usd: 156_400_000_000,
      private_exposure_usd: 1_710_000_000,
      private_exposure_pct: 1.09,
      managers: [
        { pm_name: 'William Danoff',  pm_role: 'Lead Co-PM',     pm_managing_since: '2012-01-01', retirement_date: '2026-12-31', is_currently_active: true },
        { pm_name: 'Matthew Drukker', pm_role: 'Co-PM',          pm_managing_since: '2025-01-01', retirement_date: null,         is_currently_active: true },
        { pm_name: 'Nidhi Gupta',     pm_role: 'Co-PM',          pm_managing_since: '2025-01-01', retirement_date: null,         is_currently_active: true }
      ],
      positions: [
        { company_slug: 'anthropic',  company_name: 'Anthropic PBC',                   share_class: 'Series E/F', value_usd: 187_000_000, acquisition_cost_usd: 7_400_000,  pct_of_nav: 0.119 },
        { company_slug: 'openai',     company_name: 'OpenAI Group PBC',                share_class: 'Class A',    value_usd:  76_000_000, acquisition_cost_usd: 11_200_000, pct_of_nav: 0.049 },
        { company_slug: 'stripe',     company_name: 'Stripe Inc',                       share_class: 'Series J',   value_usd:  58_000_000, acquisition_cost_usd: 14_900_000, pct_of_nav: 0.037 },
        { company_slug: 'databricks', company_name: 'Databricks Inc',                   share_class: 'Series K',   value_usd:  43_000_000, acquisition_cost_usd: 16_200_000, pct_of_nav: 0.027 },
        { company_slug: 'spacex',     company_name: 'Space Exploration Technologies',   share_class: 'Common',     value_usd:  32_000_000, acquisition_cost_usd:  9_750_000, pct_of_nav: 0.020 },
        { company_slug: 'epicgames',  company_name: 'Epic Games Inc',                   share_class: 'Common',     value_usd:  21_000_000, acquisition_cost_usd: 10_400_000, pct_of_nav: 0.013 },
        { company_slug: 'canva',      company_name: 'Canva Australia Holdings Pty Ltd', share_class: 'Series A-3', value_usd:  18_500_000, acquisition_cost_usd:  8_900_000, pct_of_nav: 0.012 }
      ],
      qoq_changes: [
        { company_slug: 'anthropic',  share_class: 'Series F', change_kind: 'markup',  pct_change: 12.3, prev_value_usd: 166_500_000, curr_value_usd: 187_000_000, note: 'no share change' },
        { company_slug: 'openai',     share_class: 'Class A',  change_kind: 'new',     pct_change: null, prev_value_usd: null,         curr_value_usd:  76_000_000, note: 'NEW position entered Q1 2026' },
        { company_slug: 'stripe',     share_class: 'Series J', change_kind: 'markup',  pct_change:  5.7, prev_value_usd:  54_870_000, curr_value_usd:  58_000_000, note: '' },
        { company_slug: 'klarna',     share_class: 'Series F', change_kind: 'exited',  pct_change: null, prev_value_usd:  12_200_000, curr_value_usd: 0,           note: 'Exited Q4 2025' }
      ]
    },
    '810902:S000010108': {
      cik: '0000810902',
      series_id: 'S000010108',
      registrant_name: 'Baron Funds Inc',
      series_name: 'Baron Partners Fund',
      adviser_name: 'BAMCO Inc',
      adviser_crd: '109032',
      fund_type: 'open_end',
      is_variable_insurance: false,
      latest_period_end: '2025-12-31',
      total_nav_usd: 9_800_000_000,
      private_exposure_usd: 2_180_000_000,
      private_exposure_pct: 22.2,
      managers: [
        { pm_name: 'Ron Baron',     pm_role: 'Lead PM', pm_managing_since: '1992-01-01', retirement_date: null, is_currently_active: true },
        { pm_name: 'Michael Baron', pm_role: 'Co-PM',   pm_managing_since: '2018-01-01', retirement_date: null, is_currently_active: true }
      ],
      positions: [
        { company_slug: 'spacex',     company_name: 'Space Exploration Technologies', share_class: 'Series J', value_usd: 1_980_000_000, acquisition_cost_usd: 220_000_000, pct_of_nav: 20.20 },
        { company_slug: 'anthropic',  company_name: 'Anthropic PBC',                  share_class: 'Series F', value_usd:    62_000_000, acquisition_cost_usd:  31_400_000, pct_of_nav:  0.63 },
        { company_slug: 'databricks', company_name: 'Databricks Inc',                  share_class: 'Series J', value_usd:    48_000_000, acquisition_cost_usd:  20_100_000, pct_of_nav:  0.49 }
      ],
      qoq_changes: [
        { company_slug: 'spacex',    share_class: 'Common',   change_kind: 'repricing', pct_change: 98.6, prev_value_usd: 996_000_000, curr_value_usd: 1_980_000_000, note: 'Coordinated 2× repricing across all holders' },
        { company_slug: 'anthropic', share_class: 'Series F', change_kind: 'markup',    pct_change: 12.3, prev_value_usd:  55_200_000, curr_value_usd:    62_000_000, note: '' }
      ]
    }
  };

  // ---- Admin triage — unresolved holdings grouped by normalized name -----
  const adminUnresolved = [
    {
      normalized_name: 'CEREBRAS SYSTEMS INC',
      filer_count: 14,
      total_balance: 4_812_902,
      total_value_usd: 218_400_000,
      sample_rows: [
        { accession_number: '0001234567-25-001012', issuer_name: 'CEREBRAS SYSTEMS INC',      issuer_title: 'Series F-1 Preferred',  registrant_name: 'Fidelity Blue Chip Growth',  value_usd:  82_400_000 },
        { accession_number: '0001234567-25-001013', issuer_name: 'Cerebras Systems, Inc.',    issuer_title: 'Series F Preferred',    registrant_name: 'T. Rowe Global Tech',         value_usd:  47_900_000 },
        { accession_number: '0001234567-25-001014', issuer_name: 'CEREBRAS SYS',              issuer_title: 'Common Stock',          registrant_name: 'Coatue Innovation Fund',      value_usd:  29_100_000 }
      ],
      candidates: [
        { company_slug: 'cerebras', display_name: 'Cerebras Systems', score: 92, reason: 'Exact compact-name match' }
      ]
    },
    {
      normalized_name: 'MISTRAL AI',
      filer_count: 9,
      total_balance:   712_881,
      total_value_usd: 84_600_000,
      sample_rows: [
        { accession_number: '0001234567-25-002001', issuer_name: 'MISTRAL AI SAS',     issuer_title: 'Series B',  registrant_name: 'Fidelity Contrafund', value_usd: 42_100_000 },
        { accession_number: '0001234567-25-002002', issuer_name: 'Mistral AI',         issuer_title: 'Series B',  registrant_name: 'Coatue Innovation',   value_usd: 22_400_000 }
      ],
      candidates: [
        { company_slug: 'mistral-ai', display_name: 'Mistral AI', score: 100, reason: 'Exact company-name match' }
      ]
    },
    {
      normalized_name: 'GROK INC',
      filer_count: 6,
      total_balance:   118_402,
      total_value_usd: 11_200_000,
      sample_rows: [
        { accession_number: '0001234567-25-003001', issuer_name: 'GROK INC',     issuer_title: 'Common', registrant_name: 'ARK Venture Fund', value_usd: 4_300_000 },
        { accession_number: '0001234567-25-003002', issuer_name: 'Grok Inc.',    issuer_title: 'Common', registrant_name: 'Destiny Tech100',  value_usd: 3_800_000 }
      ]
    },
    {
      normalized_name: 'PERPLEXITY AI INC',
      filer_count: 11,
      total_balance:   441_088,
      total_value_usd: 38_700_000,
      sample_rows: [
        { accession_number: '0001234567-25-004001', issuer_name: 'PERPLEXITY AI INC', issuer_title: 'Series D', registrant_name: 'Fidelity Blue Chip',    value_usd: 18_400_000 },
        { accession_number: '0001234567-25-004002', issuer_name: 'Perplexity AI',     issuer_title: 'Series D', registrant_name: 'Coatue Innovation',     value_usd:  9_900_000 }
      ]
    },
    {
      normalized_name: 'SBERBANK',
      filer_count: 22,
      total_balance:   3_109_402,
      total_value_usd: 0,
      sample_rows: [
        { accession_number: '0001234567-25-005001', issuer_name: 'SBERBANK ROSSII PAO', issuer_title: 'ADR', registrant_name: 'Generic Emerging Markets Fund', value_usd: 0 }
      ],
      suggested_action: 'sanctioned'
    }
  ];

  // ---- A small directory of existing companies for the alias picker ------
  const companyDirectory = [
    { slug: 'anthropic',   display_name: 'Anthropic' },
    { slug: 'openai',      display_name: 'OpenAI' },
    { slug: 'spacex',      display_name: 'SpaceX' },
    { slug: 'databricks',  display_name: 'Databricks' },
    { slug: 'canva',       display_name: 'Canva' },
    { slug: 'cerebras',    display_name: 'Cerebras Systems' },
    { slug: 'mistral-ai',  display_name: 'Mistral AI' },
    { slug: 'xai',         display_name: 'xAI' },
    { slug: 'stripe',      display_name: 'Stripe' },
    { slug: 'epicgames',   display_name: 'Epic Games' },
    { slug: 'anduril',     display_name: 'Anduril' },
    { slug: 'oura',        display_name: 'Oura Health' }
  ];

  // ---- Route → payload mapper ---------------------------------------------
  // Returns a function `respond(url)` that takes a URL fragment matching the
  // §7.1 contract and returns the fixture payload. Returns null when no mock
  // matches so caller can fall back to a real fetch.
  function respond(url) {
    if (!url || typeof url !== 'string') return null;
    const u = url.split('?')[0];

    // /api/nport/companies/:slug/cross
    let m = u.match(/^\/api\/nport\/companies\/([^/]+)\/cross$/);
    if (m) {
      const slug = m[1];
      const company = companies[slug];
      if (!company) return null;
      return {
        company,
        nport_positions: topHolders[slug] || [],
        form_d_filings: (crossSource[slug] || {}).form_d_filings || [],
        related_advisers: (crossSource[slug] || {}).related_advisers || []
      };
    }

    // /api/nport/companies/:slug/positions
    m = u.match(/^\/api\/nport\/companies\/([^/]+)\/positions$/);
    if (m) return { positions: topHolders[m[1]] || [] };

    // /api/nport/companies/:slug/holders
    m = u.match(/^\/api\/nport\/companies\/([^/]+)\/holders$/);
    if (m) return { holders: topHolders[m[1]] || [] };

    // /api/nport/companies/:slug/timeseries
    m = u.match(/^\/api\/nport\/companies\/([^/]+)\/timeseries$/);
    if (m) return { points: timeseries[m[1]] || [] };

    // /api/nport/companies/:slug/markups
    m = u.match(/^\/api\/nport\/companies\/([^/]+)\/markups$/);
    if (m) return { markups: markups[m[1]] || [], history: markupHistory[m[1]] || [] };

    // /api/nport/companies/:slug    (single)
    m = u.match(/^\/api\/nport\/companies\/([^/]+)$/);
    if (m) {
      const slug = m[1];
      const company = companies[slug];
      if (!company) return null;
      return {
        company,
        latest_marks: latestMarks[slug] || { report_period_end: null, classes: [] },
        markups: markups[slug] || [],
        top_holders: topHolders[slug] || []
      };
    }

    // /api/nport/companies   (list)
    if (u === '/api/nport/companies') {
      return { companies: Object.values(companies) };
    }

    // /api/nport/funds/:cik/:series_id/managers
    m = u.match(/^\/api\/nport\/funds\/([^/]+)\/([^/]+)\/managers$/);
    if (m) {
      const key = m[1] + ':' + m[2];
      const f = funds[key];
      return f ? { managers: f.managers } : null;
    }

    // /api/nport/funds/:cik/:series_id/positions
    m = u.match(/^\/api\/nport\/funds\/([^/]+)\/([^/]+)\/positions$/);
    if (m) {
      const key = m[1] + ':' + m[2];
      const f = funds[key];
      return f ? { positions: f.positions, qoq_changes: f.qoq_changes } : null;
    }

    // /api/nport/funds/:cik/:series_id/adviser
    m = u.match(/^\/api\/nport\/funds\/([^/]+)\/([^/]+)\/adviser$/);
    if (m) {
      const key = m[1] + ':' + m[2];
      const f = funds[key];
      return f ? { adviser_name: f.adviser_name, adviser_crd: f.adviser_crd } : null;
    }

    // /api/nport/funds/:cik/:series_id   (single)
    m = u.match(/^\/api\/nport\/funds\/([^/]+)\/([^/]+)$/);
    if (m) {
      const key = m[1] + ':' + m[2];
      return funds[key] || null;
    }

    // /api/nport/admin/unresolved
    if (u === '/api/nport/admin/unresolved') {
      return { unresolved: adminUnresolved, company_directory: companyDirectory };
    }

    return null;
  }

  window.NPORT_MOCKS = {
    companies,
    latestMarks,
    markups,
    topHolders,
    timeseries,
    markupHistory,
    crossSource,
    funds,
    adminUnresolved,
    companyDirectory,
    respond
  };
})();
