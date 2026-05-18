// ============================================================================
// N-PORT private-company pages — Company / Fund / Admin triage.
// Styled to match existing app.js (Tailwind, Chart.js, gray-50 surfaces,
// slate accents). Loaded only when window.location.pathname matches one of:
//   /company/:slug
//   /fund/:cik
//   /fund/:cik/:series_id
//   /admin/unresolved
// app.js boot intercepts and renders <NportRouter /> in those cases.
// ============================================================================

const { useState: useStateN, useEffect: useEffectN, useMemo: useMemoN, useRef: useRefN, useCallback: useCallbackN } = React;

// ---------------------------------------------------------------------------
// Route matcher — exposed for app.js boot dispatch.
// ---------------------------------------------------------------------------
window.matchNportRoute = function (pathname) {
  if (!pathname) pathname = window.location.pathname;
  let m;
  if (pathname === '/' || pathname === '') {
    return { kind: 'dashboard' };
  }
  if ((m = pathname.match(/^\/company\/([^/]+)\/?$/))) {
    return { kind: 'company', slug: decodeURIComponent(m[1]) };
  }
  if ((m = pathname.match(/^\/fund\/(\d+)\/([^/]+)\/?$/))) {
    return { kind: 'fund', cik: m[1], series_id: m[2] };
  }
  if ((m = pathname.match(/^\/fund\/(\d+)\/?$/))) {
    return { kind: 'fund', cik: m[1], series_id: null };
  }
  if (pathname.match(/^\/admin\/unresolved\/?$/)) {
    return { kind: 'admin' };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Mock mode detection — ?mock=1 or window.NPORT_FORCE_MOCK = true.
// ---------------------------------------------------------------------------
const isMockMode = () => {
  if (window.NPORT_FORCE_MOCK === true) return true;
  const params = new URLSearchParams(window.location.search);
  return params.get('mock') === '1';
};

// ---------------------------------------------------------------------------
// fetchNport — uniform fetch helper. In mock mode returns fixture payload.
// Always resolves to { ok: bool, data: any|null, error: string|null }.
// ---------------------------------------------------------------------------
async function fetchNport(url, options) {
  if (isMockMode() && window.NPORT_MOCKS) {
    const data = window.NPORT_MOCKS.respond(url);
    if (data !== null) {
      // mimic small network delay so UI loading states are exercised
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, data, error: null };
    }
    return { ok: false, data: null, error: `Mock not found for ${url}` };
  }
  try {
    const res = await fetch(url, options || { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, error: null };
  } catch (err) {
    return { ok: false, data: null, error: err.message || String(err) };
  }
}

const nportAdminHeaders = () => {
  const token = window.localStorage ? window.localStorage.getItem('nportAdminToken') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'x-admin-token': token } : {}),
  };
};

// ---------------------------------------------------------------------------
// Formatting helpers (kept local — app.js doesn't expose its helpers).
// ---------------------------------------------------------------------------
const fmtUsd = (n) => {
  if (n === null || n === undefined) return '—';
  if (typeof n === 'string' && n.toLowerCase() === 'indefinite') return 'Indefinite';
  const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/[$,]/g, ''));
  if (!isFinite(num) || num === 0) return num === 0 ? '$0' : '—';
  if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9)  return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6)  return `$${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3)  return `$${(num / 1e3).toFixed(0)}K`;
  return `$${num.toFixed(0)}`;
};

const fmtUsdPerShare = (n) => {
  if (n === null || n === undefined) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtPct = (n, withSign) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = withSign && n >= 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(1)}%`;
};

const fmtInt = (n) => {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
};

const fmtDecimal = (n, digits = 2) => {
  if (n === null || n === undefined || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
};

const fmtDate = (d) => {
  if (!d) return '—';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [year, month, day] = d.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const splitWebsiteList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitWebsiteList);
  return String(value)
    .split(/[;,]\s*/)
    .map((v) => v.trim())
    .filter(Boolean);
};

const adviserWebsite = (adviser) => {
  if (!adviser) return null;
  const blocked = /(instagram|facebook|linkedin|twitter|x\.com|youtube|reddit|tiktok|discord)\./i;
  const options = [
    ...splitWebsiteList(adviser.primary_website),
    ...splitWebsiteList(adviser.other_websites),
  ];
  return options.find((url) => !blocked.test(url)) || options[0] || null;
};

const ensureUrl = (url) => {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
};

const titleCaseSector = (s) => {
  if (!s) return '—';
  return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' / ');
};

const companyDisplayName = (company) => {
  if (!company) return '—';
  return String(company.display_name || company.slug || '—').replace(/^\|+/, '').trim() || company.slug || '—';
};

const median = (values) => {
  const nums = values.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

const seriesLetterRank = (letters) => {
  const value = String(letters || '').toUpperCase();
  if (!/^[A-Z]+$/.test(value)) return 999;
  return Array.from(value).reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
};

const securityClassSortValue = (label) => {
  const text = String(label || '').trim();
  const normalized = text.toUpperCase();
  if (!normalized || /^(UNSPECIFIED|UNKNOWN|N\/A|NA|-|—)$/.test(normalized)) return 100000;
  if (/\b(COMMON|ORDINARY)\b/.test(normalized)) return -100;

  const match = normalized.match(/\b(SERIES|SER|CLASS|CL)\s+([A-Z]+)(?:[-\s]?(\d+))?/);
  if (match) {
    const prefix = match[1];
    const roundRank = seriesLetterRank(match[2]);
    const suffixRank = match[3] ? Number(match[3]) / 100 : 0;
    const prefixOffset = /^(CLASS|CL)$/.test(prefix) ? 0.2 : 0;
    return roundRank * 10 + suffixRank + prefixOffset;
  }

  return 90000;
};

const compareSecurityClassesNatural = (a, b) => {
  const aLabel = typeof a === 'string' ? a : a.share_class;
  const bLabel = typeof b === 'string' ? b : b.share_class;
  const delta = securityClassSortValue(aLabel) - securityClassSortValue(bLabel);
  if (delta !== 0) return delta;
  return String(aLabel || '').localeCompare(String(bLabel || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

const secFilingUrl = (cik, accession) => {
  if (!cik || !accession) return null;
  const cikTrimmed = String(cik).replace(/^0+/, '') || '0';
  const accessionNoDashes = String(accession).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikTrimmed}/${accessionNoDashes}/${accession}-index.html`;
};

const securityTypeLabel = (assetCat) => {
  const labels = {
    EC: 'Equity',
    EP: 'Preferred equity',
    LON: 'Loan / credit',
    DBT: 'Debt',
    DE: 'Derivative',
  };
  return labels[assetCat] || assetCat || '—';
};

const unitLabel = (unit, otherUnitDesc) => {
  const labels = {
    NS: 'shares',
    PA: 'principal',
    OU: otherUnitDesc || 'other units',
  };
  return labels[unit] || unit || '—';
};

const yesNo = (value) => {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return '—';
};

const currentMark = (holding) => {
  const value = Number(holding.value_usd ?? holding.currency_value_usd);
  const balance = Number(holding.balance);
  if (!Number.isFinite(value) || !Number.isFinite(balance) || balance === 0) return null;
  return value / balance;
};

const rowPeriodDate = (row) => row && (row.report_period_date || row.report_period_end || null);

const compareValues = (a, b, type = 'text') => {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;
  if (type === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) && !Number.isFinite(nb)) return 0;
    if (!Number.isFinite(na)) return 1;
    if (!Number.isFinite(nb)) return -1;
    return na - nb;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

const sortRows = (rows, sort, accessors) => {
  const spec = accessors[sort.key];
  if (!spec) return rows;
  return [...rows].sort((a, b) => {
    const base = compareValues(spec.value(a), spec.value(b), spec.type);
    return sort.dir === 'asc' ? base : -base;
  });
};

const toggleSort = (setSort, key, defaults = {}) => {
  setSort((prev) => {
    if (prev.key === key) {
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    }
    return { key, dir: defaults[key] || 'asc' };
  });
};

const csvEscape = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const downloadCsv = (filename, rows, columns) => {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => csvEscape(c.value(row))).join(',')).join('\n');
  const blob = new Blob([`${header}\n${body}\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

async function fetchAllCompanyPositions(slug) {
  const all = [];
  const pageSize = 1000;
  for (let page = 1; page <= 50; page += 1) {
    const r = await fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/positions?page=${page}&pageSize=${pageSize}`);
    if (!r.ok || !r.data) throw new Error(r.error || 'Unable to export positions');
    const batch = r.data.positions || [];
    all.push(...batch);
    const total = Number(r.data.total || 0);
    if (batch.length < pageSize || (total && all.length >= total)) break;
  }
  return all;
}

const companyPositionCsvColumns = (companySlug) => [
  { label: 'company_slug', value: () => companySlug },
  { label: 'company_name', value: (r) => r.company_name || r.display_name || '' },
  { label: 'registrant_name', value: (r) => r.registrant_name },
  { label: 'registrant_cik', value: (r) => r.registrant_cik },
  { label: 'series_name', value: (r) => r.series_name },
  { label: 'series_id', value: (r) => r.series_id },
  { label: 'portfolio_snapshot_date', value: (r) => r.report_period_date },
  { label: 'fiscal_year_end', value: (r) => r.report_period_end },
  { label: 'first_seen_report_date', value: (r) => r.first_seen_report_date },
  { label: 'reported_value_usd', value: (r) => r.value_usd ?? r.currency_value_usd },
  { label: 'pct_of_nav', value: (r) => r.pct_of_nav },
  { label: 'balance', value: (r) => r.balance },
  { label: 'unit', value: (r) => unitLabel(r.unit, r.other_unit_desc) },
  { label: 'current_mark_per_unit', value: (r) => currentMark(r) },
  { label: 'share_class', value: (r) => r.share_class || r.share_class_normalized },
  { label: 'asset_category', value: (r) => securityTypeLabel(r.asset_cat) },
  { label: 'payoff_profile', value: (r) => r.payoff_profile },
  { label: 'issuer_type', value: (r) => r.issuer_type },
  { label: 'restricted_security', value: (r) => yesNo(r.is_restricted_security) },
  { label: 'fair_value_level', value: (r) => r.fair_value_level },
  { label: 'raw_issuer_name', value: (r) => r.raw_issuer_name || r.issuer_name },
  { label: 'raw_issuer_title', value: (r) => r.raw_issuer_title || r.issuer_title },
  { label: 'accession_number', value: (r) => r.accession_number },
  { label: 'sec_filing_url', value: (r) => secFilingUrl(r.registrant_cik, r.accession_number) },
];

// ---------------------------------------------------------------------------
// Tiny inline icons (same SVG-only style as app.js)
// ---------------------------------------------------------------------------
const Svg = ({ children, className = 'w-4 h-4' }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>{children}</svg>
);
const IconArrowLeft  = (p) => <Svg {...p}><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></Svg>;
const IconExternal   = (p) => <Svg {...p}><path d="M7 7h10v10"/><path d="M7 17 17 7"/></Svg>;
const IconTrendUp    = (p) => <Svg {...p}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></Svg>;
const IconTrendDown  = (p) => <Svg {...p}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></Svg>;
const IconCheck      = (p) => <Svg {...p}><polyline points="20 6 9 17 4 12"/></Svg>;
const IconPlus       = (p) => <Svg {...p}><path d="M5 12h14"/><path d="M12 5v14"/></Svg>;
const IconX          = (p) => <Svg {...p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Svg>;
const IconAlert      = (p) => <Svg {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></Svg>;
const IconBuilding   = (p) => <Svg {...p}><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></Svg>;
const IconDownload   = (p) => <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></Svg>;
const IconChevronUp  = (p) => <Svg {...p}><path d="m18 15-6-6-6 6"/></Svg>;
const IconChevronDown = (p) => <Svg {...p}><path d="m6 9 6 6 6-6"/></Svg>;
const IconSearch     = (p) => <Svg {...p}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></Svg>;

// ---------------------------------------------------------------------------
// Shared chrome — top header bar (logo + back button + mock indicator)
// ---------------------------------------------------------------------------
const PageChrome = ({ children, breadcrumb }) => {
  const goHome = (e) => { e.preventDefault(); window.location.href = '/'; };
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" onClick={goHome} className="flex items-center gap-2 text-sm font-semibold text-gray-900 tracking-tight">
              <IconBuilding className="w-4 h-4 text-slate-600" />
              Private Funds Radar
            </a>
            {breadcrumb && (
              <span className="text-xs text-gray-400 ml-2">/ {breadcrumb}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isMockMode() && (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                mock data
              </span>
            )}
            <a href="/" onClick={goHome} className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1.5">
              <IconArrowLeft className="w-3.5 h-3.5" /> Dashboard
            </a>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
};

const SectionCard = ({ title, subtitle, right, children }) => (
  <section className="bg-white rounded-2xl ring-1 ring-gray-200 mb-6 overflow-hidden">
    <header className="px-6 py-4 border-b border-gray-100 flex items-start justify-between">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 tracking-tight">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </header>
    <div className="px-6 py-5">{children}</div>
  </section>
);

const SortableHeader = ({ label, sortKey, sort, onSort, align = 'left', className = '' }) => {
  const active = sort && sort.key === sortKey;
  const Icon = active && sort.dir === 'asc' ? IconChevronUp : IconChevronDown;
  return (
    <th className={`${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded px-1 py-1 -mx-1 hover:bg-gray-100 ${align === 'right' ? 'justify-end' : ''} ${active ? 'text-gray-900' : 'text-gray-400'}`}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <span>{label}</span>
        <Icon className={`w-3 h-3 ${active ? 'opacity-100' : 'opacity-35'}`} />
      </button>
    </th>
  );
};

const Spinner = ({ label }) => (
  <div className="py-12 flex flex-col items-center justify-center text-center">
    <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-200 border-t-slate-600 mb-3"></div>
    <p className="text-xs text-gray-500">{label || 'Loading...'}</p>
  </div>
);

const ErrorState = ({ message }) => (
  <div className="py-12 text-center">
    <IconAlert className="w-8 h-8 text-amber-500 mx-auto mb-3" />
    <p className="text-sm font-medium text-gray-900">Unable to load this page</p>
    <p className="text-xs text-gray-500 mt-1">{message}</p>
    <p className="text-[11px] text-gray-400 mt-3">Tip: add <code className="px-1 rounded bg-gray-100">?mock=1</code> to the URL to view with mock data.</p>
  </div>
);

// ---------------------------------------------------------------------------
// Dashboard — /
// ---------------------------------------------------------------------------
const DashboardPage = () => {
  const [loading, setLoading] = useStateN(true);
  const [error, setError] = useStateN(null);
  const [companies, setCompanies] = useStateN([]);
  const [query, setQuery] = useStateN('');

  useEffectN(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      const r = await fetchNport('/api/nport/companies?pageSize=1000&includeStats=true');
      if (cancelled) return;
      if (!r.ok || !r.data) {
        setError(r.error || 'Failed to load companies');
        setLoading(false);
        return;
      }
      setCompanies(r.data.companies || []);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const q = query.trim().toLowerCase();
  const rankCompanyForQuery = (c) => {
    const base = Number(c.search_rank_score || 0);
    if (!q) return base;
    const name = String(companyDisplayName(c)).toLowerCase();
    const slug = String(c.slug || '').toLowerCase();
    const domain = String(c.primary_domain || '').toLowerCase();
    let boost = 0;
    if (name === q || slug === q) boost += 10000;
    if (name.startsWith(q) || slug.startsWith(q)) boost += 5000;
    if (domain.startsWith(q)) boost += 2000;
    if (name.includes(q) || slug.includes(q) || domain.includes(q)) boost += 500;
    return base + boost;
  };

  const searchResults = companies
    .filter((c) => {
      if (!q) return true;
      return [c.display_name, c.slug, c.sector, c.primary_domain]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => rankCompanyForQuery(b) - rankCompanyForQuery(a) || companyDisplayName(a).localeCompare(companyDisplayName(b)))
    .slice(0, 80);
  const focusSlugs = [
    'spacex',
    'openai',
    'anthropic',
    'databricks',
    'stripe',
    'bytedance',
    'anduril-industries',
    'canva',
    'xai',
    'perplexity-ai',
    'mistral-ai',
    'safe-superintelligence',
  ];
  const focusCompanies = focusSlugs
    .map((slug) => companies.find((c) => c.slug === slug))
    .filter(Boolean)
    .sort((a, b) => Number(b.nport_latest_value_usd || 0) - Number(a.nport_latest_value_usd || 0));

  if (loading) {
    return <PageChrome breadcrumb="n-port"><Spinner label="Loading N-PORT companies..." /></PageChrome>;
  }
  if (error) {
    return <PageChrome breadcrumb="n-port"><ErrorState message={error} /></PageChrome>;
  }

  return (
    <PageChrome breadcrumb="n-port">
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 mb-6 p-6">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">N-PORT private-company holdings</h1>
            <p className="text-sm text-gray-600 mt-1 max-w-3xl">
              Search registered funds and ETFs that disclose positions in private companies. Open a company to inspect fund holders, security classes, marks, and SEC source filings.
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] uppercase tracking-wider text-gray-400">Companies seeded</div>
            <div className="text-lg font-semibold text-gray-900 tabular-nums">{fmtInt(companies.length)}</div>
          </div>
        </div>
        <div className="mt-6 relative">
          <IconSearch className="w-4 h-4 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search company, domain, or sector..."
            className="w-full rounded-xl border border-gray-200 bg-gray-50 pl-10 pr-4 py-3 text-sm outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
          />
        </div>
      </div>

      {focusCompanies.length > 0 && !q && (
        <section className="mb-6">
          <div className="flex items-end justify-between gap-4 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">High-signal companies</h2>
              <p className="text-xs text-gray-500">A short watchlist for the names most likely to matter in N-PORT private-company analysis.</p>
            </div>
            <div className="text-xs text-gray-500">Search above for the full seeded universe.</div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {focusCompanies.map((c) => (
            <a key={c.slug} href={`/company/${c.slug}`} className="bg-white rounded-2xl ring-1 ring-gray-200 p-5 hover:ring-slate-300 hover:shadow-sm transition">
              <div className="text-sm font-semibold text-gray-900">{companyDisplayName(c)}</div>
              <div className="text-xs text-gray-500 mt-1">{titleCaseSector(c.sector)}</div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Stat label="N-PORT exposure" value={fmtUsd(c.nport_latest_value_usd)} />
                <Stat label="Fund holders" value={fmtInt(c.nport_latest_holder_count)} />
              </div>
              <div className="mt-3 text-[11px] text-gray-500">Latest snapshot {fmtDate(c.nport_latest_period_date)}</div>
            </a>
          ))}
          </div>
        </section>
      )}

      <SectionCard title={q ? 'Search results' : 'Company search'} subtitle={q ? `${fmtInt(searchResults.length)} shown` : `${fmtInt(companies.length)} seeded companies available`}>
        {!q ? (
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-5 py-8 text-center">
            <p className="text-sm font-medium text-gray-900">Search by company, sector, domain, or alias.</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {['SpaceX', 'OpenAI', 'Databricks', 'Stripe'].map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => setQuery(term)}
                  className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-gray-300 hover:text-gray-900"
                >
                  {term}
                </button>
              ))}
            </div>
          </div>
        ) : searchResults.length === 0 ? (
          <p className="text-sm text-gray-500">No companies match this search.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <tr>
                  <th className="text-left py-2 pr-3">Company</th>
                  <th className="text-left pr-3">Sector</th>
                  <th className="text-right pr-3">N-PORT exposure</th>
                  <th className="text-right pr-3">Fund holders</th>
                  <th className="text-left pr-3">Latest snapshot</th>
                  <th className="text-right pr-3">Known valuation</th>
                  <th className="text-right">Open</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map((c) => (
                  <tr key={c.slug} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2.5 pr-3">
                      <a href={`/company/${c.slug}`} className="font-medium text-gray-900 hover:underline">{companyDisplayName(c)}</a>
                      <div className="text-[11px] text-gray-500">{c.primary_domain || c.slug}</div>
                    </td>
                    <td className="py-2.5 pr-3 text-gray-700">{titleCaseSector(c.sector)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-gray-900">{fmtUsd(c.nport_latest_value_usd)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-gray-700">{fmtInt(c.nport_latest_holder_count)}</td>
                    <td className="py-2.5 pr-3 text-gray-700">{fmtDate(c.nport_latest_period_date)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-gray-900">{fmtUsd(c.latest_known_valuation_usd)}</td>
                    <td className="py-2.5 text-right">
                      <a href={`/company/${c.slug}`} className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1">view company <IconExternal className="w-3 h-3" /></a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </PageChrome>
  );
};

// ---------------------------------------------------------------------------
// Charts — value-over-time (single line) and markup history (multi-line).
// Mirrors the Chart.js wrapper style used in app.js HistoricalChart.
// ---------------------------------------------------------------------------
const TimeSeriesChart = ({ points, label = 'Value', color = '#4F46E5' }) => {
  const ref = useRefN(null);
  const inst = useRefN(null);

  useEffectN(() => {
    if (!ref.current || !points || points.length === 0) return;
    if (inst.current) inst.current.destroy();
    const ctx = ref.current.getContext('2d');
    const vals = points.map(p => p.value_usd);
    const positive = vals.length >= 2 ? vals[vals.length - 1] >= vals[0] : true;
    const line = positive ? '#10b981' : '#ef4444';

    inst.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map(p => p.period),
        datasets: [{
          label,
          data: vals,
          borderColor: line,
          backgroundColor: (c) => {
            const chart = c.chart;
            const { ctx: cx, chartArea } = chart;
            if (!chartArea) return null;
            const g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            g.addColorStop(0.05, positive ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)');
            g.addColorStop(0.95, positive ? 'rgba(16,185,129,0)'    : 'rgba(239,68,68,0)');
            return g;
          },
          borderWidth: 2,
          fill: true,
          tension: 0.25,
          pointRadius: 3,
          pointHoverRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'white', borderColor: '#e5e7eb', borderWidth: 1,
            titleColor: '#111827', bodyColor: '#111827', padding: 10,
            callbacks: { label: (c) => `${label}: ${fmtUsd(c.parsed.y)}` }
          }
        },
        scales: {
          x: { grid: { color: '#f1f5f9' }, ticks: { color: '#6b7280', font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { color: '#6b7280', font: { size: 11 }, callback: (v) => fmtUsd(v) } }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });
    return () => { if (inst.current) inst.current.destroy(); };
  }, [points, label, color]);

  if (!points || points.length === 0) {
    return <div className="h-64 flex items-center justify-center text-sm text-gray-500">No time-series data yet</div>;
  }
  return <div className="h-64 relative"><canvas ref={ref}></canvas></div>;
};

const MarkupHistoryChart = ({ series }) => {
  const ref = useRefN(null);
  const inst = useRefN(null);
  const palette = ['#4F46E5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

  useEffectN(() => {
    if (!ref.current || !series || series.length === 0) return;
    if (inst.current) inst.current.destroy();

    // Build the union of x-axis labels across all share classes.
    const allPeriods = Array.from(new Set(series.flatMap(s => s.points.map(p => p.period)))).sort();
    const datasets = series.map((s, i) => ({
      label: s.share_class,
      data: allPeriods.map(p => {
        const pt = s.points.find(x => x.period === p);
        return pt ? pt.per_share : null;
      }),
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + '20',
      borderWidth: 2,
      tension: 0.25,
      spanGaps: true,
      pointRadius: 3,
      pointHoverRadius: 5
    }));

    const ctx = ref.current.getContext('2d');
    inst.current = new Chart(ctx, {
      type: 'line',
      data: { labels: allPeriods, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, color: '#374151', usePointStyle: true, boxWidth: 6 } },
          tooltip: {
            backgroundColor: 'white', borderColor: '#e5e7eb', borderWidth: 1,
            titleColor: '#111827', bodyColor: '#111827', padding: 10,
            callbacks: { label: (c) => `${c.dataset.label}: ${fmtUsdPerShare(c.parsed.y)}` }
          }
        },
        scales: {
          x: { grid: { color: '#f1f5f9' }, ticks: { color: '#6b7280', font: { size: 11 } } },
          y: {
            grid: { color: '#f1f5f9' },
            ticks: { color: '#6b7280', font: { size: 11 }, callback: (v) => `$${v.toFixed(0)}` }
          }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });
    return () => { if (inst.current) inst.current.destroy(); };
  }, [series]);

  if (!series || series.length === 0) {
    return <div className="h-64 flex items-center justify-center text-sm text-gray-500">No markup history yet</div>;
  }
  return <div className="h-72 relative"><canvas ref={ref}></canvas></div>;
};

// ---------------------------------------------------------------------------
// Company Page  —  /company/:slug
// ---------------------------------------------------------------------------
const CompanyPage = ({ slug }) => {
  const [loading, setLoading] = useStateN(true);
  const [error, setError] = useStateN(null);
  const [main, setMain] = useStateN(null);          // /companies/:slug
  const [timeseries, setTimeseries] = useStateN(null); // /timeseries
  const [holdersPayload, setHoldersPayload] = useStateN(null); // /holders
  const [markupsPayload, setMarkupsPayload] = useStateN(null); // /markups
  const [cross, setCross] = useStateN(null);          // /cross
  const [expandedHoldings, setExpandedHoldings] = useStateN({});
  const [holderSort, setHolderSort] = useStateN({ key: 'value', dir: 'desc' });
  const [exportingPositions, setExportingPositions] = useStateN(false);
  const [exportError, setExportError] = useStateN(null);

  useEffectN(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      const [a, b, c, d, e] = await Promise.all([
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}`),
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/timeseries`),
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/holders`),
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/markups`),
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/cross`)
      ]);
      if (cancelled) return;
      if (!a.ok || !a.data) { setError(a.error || 'Company not found'); setLoading(false); return; }
      setMain(a.data);
      setTimeseries(b.ok ? b.data : null);
      setHoldersPayload(c.ok ? c.data : null);
      setMarkupsPayload(d.ok ? d.data : null);
      setCross(e.ok ? e.data : null);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [slug]);

  if (loading) {
    return <PageChrome breadcrumb={`company / ${slug}`}><Spinner label="Loading company profile..." /></PageChrome>;
  }
  if (error || !main) {
    return <PageChrome breadcrumb={`company / ${slug}`}><ErrorState message={error || 'Company not found'} /></PageChrome>;
  }

  const company = main.company;
  const holderRows = ((holdersPayload && holdersPayload.holders) || []).map((h) => ({
    ...h,
    value_usd: h.value_usd ?? h.total_value_usd ?? h.currency_value_usd,
    share_class: h.share_class ?? h.share_class_normalized,
  }));
  const topHolders = main.top_holders || holderRows;
  const marksByClass = new Map();
  for (const h of topHolders) {
    const shareClass = h.share_class || h.share_class_normalized || 'Unspecified';
    const value = Number(h.value_usd || h.currency_value_usd);
    const balance = Number(h.balance);
    if (!Number.isFinite(value) || !Number.isFinite(balance) || balance === 0) continue;
    const row = marksByClass.get(shareClass) || { prices: [], holders: 0, total_balance: 0 };
    row.prices.push(value / balance);
    row.holders += 1;
    row.total_balance += balance;
    marksByClass.set(shareClass, row);
  }
  const computedLatestMarks = {
    report_period_end: (holdersPayload && holdersPayload.period_date) || null,
    classes: Array.from(marksByClass.entries()).map(([share_class, row]) => ({
      share_class,
      median_per_share: median(row.prices),
      holders: row.holders,
      total_balance: row.total_balance,
    })).sort(compareSecurityClassesNatural),
  };
  const latestMarksSource = main.latest_marks && main.latest_marks.classes && main.latest_marks.classes.length > 0
    ? main.latest_marks
    : computedLatestMarks;
  const latestMarks = {
    ...latestMarksSource,
    classes: [...(latestMarksSource.classes || [])].sort(compareSecurityClassesNatural),
  };
  const markups = (markupsPayload && markupsPayload.markups) || main.markups || [];
  const history = (markupsPayload && markupsPayload.history) || [];
  const tsPoints = ((timeseries && (timeseries.points || timeseries.series)) || []).map((p) => ({
    ...p,
    period: p.period || p.report_period_date || p.report_period_end,
    value_usd: p.value_usd ?? p.total_value_usd,
  }));
  const crossFormDFilings = (cross && (cross.form_d_filings || cross.formDFilings)) || [];
  const crossRelatedAdvisers = (cross && (cross.related_advisers || cross.relatedAdvisers)) || [];
  const disclosedValue = company.total_disclosed_usd ?? topHolders.reduce((sum, h) => sum + (Number(h.value_usd) || 0), 0);
  const distinctFilers = company.distinct_filers ?? new Set(topHolders.map((h) => h.registrant_id || h.registrant_cik || h.registrant_name)).size;
  const latestSnapshotDate = (holdersPayload && holdersPayload.period_date) || (topHolders[0] && topHolders[0].report_period_date);
  const toggleHolding = (key) => setExpandedHoldings((prev) => ({ ...prev, [key]: !prev[key] }));
  const holderSortAccessors = {
    fund: { type: 'text', value: (h) => h.registrant_name || '' },
    snapshot: { type: 'text', value: (h) => h.report_period_date || '' },
    firstSeen: { type: 'text', value: (h) => h.first_seen_report_date || '' },
    value: { type: 'number', value: (h) => h.value_usd ?? h.currency_value_usd },
    nav: { type: 'number', value: (h) => h.pct_of_nav },
    balance: { type: 'number', value: (h) => h.balance },
    security: { type: 'text', value: (h) => `${h.share_class || h.share_class_normalized || ''} ${securityTypeLabel(h.asset_cat)}` },
    mark: { type: 'number', value: (h) => currentMark(h) },
  };
  const holderSortDefaults = {
    fund: 'asc',
    snapshot: 'desc',
    firstSeen: 'asc',
    value: 'desc',
    nav: 'desc',
    balance: 'desc',
    security: 'asc',
    mark: 'desc',
  };
  const sortedHolders = sortRows(topHolders, holderSort, holderSortAccessors);
  const setHolderSortKey = (key) => toggleSort(setHolderSort, key, holderSortDefaults);

  const exportCurrentHolders = () => {
    setExportError(null);
    downloadCsv(
      `${slug}-current-holders-${latestSnapshotDate || 'latest'}.csv`,
      sortedHolders,
      companyPositionCsvColumns(slug)
    );
  };

  const exportAllPositions = async () => {
    setExportError(null);
    setExportingPositions(true);
    try {
      const rows = await fetchAllCompanyPositions(slug);
      downloadCsv(`${slug}-all-nport-positions.csv`, rows, companyPositionCsvColumns(slug));
    } catch (err) {
      setExportError(err.message || String(err));
    } finally {
      setExportingPositions(false);
    }
  };

  return (
    <PageChrome breadcrumb={`company / ${slug}`}>
      {/* Header */}
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 mb-6 p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight text-gray-900">{companyDisplayName(company)}</h1>
              {company.primary_domain && (
                <a href={`https://${company.primary_domain}`} target="_blank" rel="noreferrer"
                   className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1">
                  {company.primary_domain} <IconExternal className="w-3 h-3" />
                </a>
              )}
              {company.lifecycle_status && company.lifecycle_status !== 'private' && (
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{company.lifecycle_status}</span>
              )}
            </div>
            {company.description && (
              <p className="text-sm text-gray-600 mt-1.5 max-w-2xl">{company.description}</p>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] uppercase tracking-wider text-gray-400">Most recent round</div>
            <div className="text-sm font-semibold text-gray-900">{company.most_recent_round || '—'}</div>
            <div className="text-[11px] text-gray-500">{fmtDate(company.most_recent_round_date)}</div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat label="Disclosed N-PORT exposure" value={fmtUsd(disclosedValue)} hint={latestSnapshotDate ? `as of ${fmtDate(latestSnapshotDate)}` : 'latest period'} />
          <Stat label="Distinct fund-family holders" value={fmtInt(distinctFilers)} />
          <Stat label="Last known valuation" value={fmtUsd(company.latest_known_valuation_usd)} />
          <Stat label="Total funding to date" value={fmtUsd(company.total_funding_usd)} />
          <Stat label="Sector" value={titleCaseSector(company.sector)} />
        </div>
      </div>

      {/* Latest marks + QoQ deltas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <SectionCard title="Latest valuation by security class"
          subtitle={`Portfolio snapshot ${fmtDate(latestMarks.report_period_end)} — median reported value per share/unit`}>
          {latestMarks.classes.length === 0 ? (
            <p className="text-sm text-gray-500">No recent marks.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-gray-400">
                <tr><th className="text-left py-2">Security class</th><th className="text-right">Median value / share</th><th className="text-right">Holders</th><th className="text-right">Total shares / units</th></tr>
              </thead>
              <tbody>
                {latestMarks.classes.map((c) => (
                  <tr key={c.share_class} className="border-t border-gray-100">
                    <td className="py-2.5 font-medium text-gray-900">{c.share_class}</td>
                    <td className="py-2.5 text-right tabular-nums text-gray-900">{fmtUsdPerShare(c.median_per_share)}</td>
                    <td className="py-2.5 text-right tabular-nums text-gray-700">{fmtInt(c.holders)}</td>
                    <td className="py-2.5 text-right tabular-nums text-gray-700">{fmtInt(c.total_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard title="Quarterly valuation changes" subtitle="Per-share change vs. prior public filing period">
          {markups.length === 0 ? (
            <p className="text-sm text-gray-500">No deltas this period.</p>
          ) : (
            <ul className="space-y-3">
              {markups.map((d, i) => {
                const positive = (d.pct_change || 0) >= 0;
                const isNew = d.kind === 'new' || d.pct_change === null;
                const isRepricing = d.kind === 'repricing_event';
                return (
                  <li key={i} className="flex items-start justify-between gap-4 py-2 border-b border-gray-100 last:border-b-0">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {d.share_class}{' '}
                        {isNew && <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">new</span>}
                        {isRepricing && <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">repricing event</span>}
                      </div>
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        {fmtUsdPerShare(d.prev_per_share)} → <span className="font-semibold text-gray-700">{fmtUsdPerShare(d.curr_per_share)}</span>
                        <span className="ml-2">• {fmtInt(d.holders_moving)} holders</span>
                      </div>
                      {d.note && <div className="text-[11px] text-rose-600 mt-0.5">{d.note}</div>}
                    </div>
                    <div className={`text-sm font-semibold inline-flex items-center gap-1 ${positive ? 'text-emerald-600' : 'text-rose-600'} ${isNew ? 'opacity-0' : ''}`}>
                      {positive ? <IconTrendUp className="w-4 h-4" /> : <IconTrendDown className="w-4 h-4" />}
                      {fmtPct(d.pct_change, true)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* Current holders table */}
      <SectionCard
        title="Current holders"
        subtitle={`Latest available filing per fund/security through ${fmtDate(latestSnapshotDate)} — first seen is the earliest public N-PORT snapshot`}
        right={
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={exportCurrentHolders}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-gray-200 hover:bg-gray-50">
              <IconDownload className="w-3.5 h-3.5" /> Current CSV
            </button>
            <button type="button" onClick={exportAllPositions} disabled={exportingPositions}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-900 disabled:opacity-60">
              <IconDownload className="w-3.5 h-3.5" /> {exportingPositions ? 'Exporting...' : 'All positions CSV'}
            </button>
          </div>
        }
      >
        {exportError && (
          <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-100">
            Export failed: {exportError}
          </div>
        )}
        {topHolders.length === 0 ? (
          <p className="text-sm text-gray-500">No holders reported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <tr>
                  <SortableHeader label="Fund family" sortKey="fund" sort={holderSort} onSort={setHolderSortKey} className="py-2 pr-3" />
                  <SortableHeader label="Portfolio snapshot" sortKey="snapshot" sort={holderSort} onSort={setHolderSortKey} className="pr-3" />
                  <SortableHeader label="First seen" sortKey="firstSeen" sort={holderSort} onSort={setHolderSortKey} className="pr-3" />
                  <SortableHeader label="Reported value" sortKey="value" sort={holderSort} onSort={setHolderSortKey} align="right" className="pr-3" />
                  <SortableHeader label="% of NAV" sortKey="nav" sort={holderSort} onSort={setHolderSortKey} align="right" className="pr-3" />
                  <SortableHeader label="Shares / units" sortKey="balance" sort={holderSort} onSort={setHolderSortKey} align="right" className="pr-3" />
                  <SortableHeader label="Security" sortKey="security" sort={holderSort} onSort={setHolderSortKey} className="pr-3" />
                  <SortableHeader label="Mark / unit" sortKey="mark" sort={holderSort} onSort={setHolderSortKey} align="right" className="pr-3" />
                  <th className="text-right">Links</th>
                </tr>
              </thead>
              <tbody>
                {sortedHolders.map((h, i) => {
                  const key = `${h.accession_number || i}-${h.holding_id_internal || h.share_class || i}`;
                  const cik = stripCikLeadingZeros(h.registrant_cik);
                  const fundUrl = h.series_id
                    ? `/fund/${cik}/${h.series_id}${isMockMode() ? '?mock=1' : ''}`
                    : `/fund/${cik}?company=${encodeURIComponent(slug)}${isMockMode() ? '&mock=1' : ''}`;
                  const filingUrl = secFilingUrl(h.registrant_cik, h.accession_number);
                  const isExpanded = !!expandedHoldings[key];
                  const mark = currentMark(h);
                  return (
                    <React.Fragment key={key}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-2.5 pr-3">
                          <a href={fundUrl} className="font-medium text-gray-900 hover:underline">{h.registrant_name}</a>
                          <div className="text-[11px] text-gray-500">
                            {h.series_name || 'Fund family'}{h.series_id ? <span className="ml-1 font-mono">{h.series_id}</span> : null}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-gray-700">{fmtDate(h.report_period_date)}</td>
                        <td className="py-2.5 pr-3 text-gray-700">{fmtDate(h.first_seen_report_date)}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-gray-900">{fmtUsd(h.value_usd)}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-gray-700">{h.pct_of_nav != null ? fmtPct(h.pct_of_nav, false) : '—'}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-gray-700">{fmtDecimal(h.balance, 0)}</td>
                        <td className="py-2.5 pr-3 text-gray-700">
                          <div>{h.share_class || '—'}</div>
                          <div className="text-[11px] text-gray-500">{securityTypeLabel(h.asset_cat)}</div>
                          <NportFacts holding={h} />
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums font-medium text-gray-900">{mark ? fmtUsdPerShare(mark) : '—'}</td>
                        <td className="py-2.5 text-right">
                          <div className="flex items-center justify-end gap-3">
                            {filingUrl && (
                              <a href={filingUrl} target="_blank" rel="noreferrer" className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1">SEC <IconExternal className="w-3 h-3" /></a>
                            )}
                            <button type="button" onClick={() => toggleHolding(key)} className="text-xs text-slate-600 hover:text-slate-800">
                              {isExpanded ? 'hide' : 'details'}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-slate-50/70 border-b border-gray-100">
                          <td colSpan="9" className="px-4 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                              <Detail label="Raw security name" value={h.raw_issuer_name} />
                              <Detail label="Raw security title" value={h.raw_issuer_title} className="md:col-span-2" />
                              <Detail label="SEC accession" value={h.accession_number} mono />
                              <Detail label="First public N-PORT appearance" value={fmtDate(h.first_seen_report_date)} />
                              <Detail label="First-seen accession" value={h.first_seen_accession_number} mono />
                              <Detail label="Fund net assets" value={fmtUsd(h.net_assets_usd)} />
                              <Detail label="Fund total assets" value={fmtUsd(h.total_assets_usd)} />
                              <Detail label="N-PORT filed" value={fmtDate(h.filing_date)} />
                              <Detail label="Source batch" value={h.source_bulk_quarter || 'daily filing'} />
                              <Detail label="Fund type" value={h.fund_type && h.fund_type !== 'unknown' ? h.fund_type.replace(/_/g, ' ') : 'Not classified'} />
                              <Detail label="Exposure type" value={h.exposure_type || 'direct'} />
                              <Detail label="Restricted security" value={yesNo(h.is_restricted_security)} />
                              <Detail label="Fair value level" value={h.fair_value_level ? `Level ${h.fair_value_level}` : null} />
                              <Detail label="Payoff profile" value={h.payoff_profile} />
                              <Detail label="Balance unit" value={unitLabel(h.unit, h.other_unit_desc)} />
                              <Detail label="Issuer type" value={h.issuer_type} />
                              <Detail label="Investment country" value={h.investment_country} />
                              <Detail label="Issuer LEI" value={h.issuer_lei} mono />
                              <Detail label="Issuer CUSIP" value={h.issuer_cusip} mono />
                              <Detail label="Other asset" value={h.other_asset} />
                              <Detail label="Derivative category" value={h.derivative_cat} />
                              <Detail label="Resolution source" value={h.resolution_source} />
                              <Detail label="Fiscal year-end" value={fmtDate(h.report_period_end)} />
                              <Detail label="Internal holding ID" value={h.holding_id_internal} mono />
                              <Detail label="SEC holding ID" value={h.holding_id} mono />
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Time-series + markup-history charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        <SectionCard title="Holdings time series" subtitle="Total disclosed N-PORT $ across all holders per quarter">
          <TimeSeriesChart points={tsPoints} label="Disclosed $" />
        </SectionCard>
        <SectionCard title="Security-class valuation history" subtitle="Implied reported value per share/unit by class">
          <MarkupHistoryChart series={history} />
        </SectionCard>
      </div>

      {/* Cross-source view */}
      <SectionCard title="Cross-source view"
        subtitle="Form D filings + ADV-registered advisers + N-PORT consolidated">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Form D filings mentioning {companyDisplayName(company)}</h3>
            {crossFormDFilings.length === 0 ? (
              <p className="text-sm text-gray-500">No Form D filings on record.</p>
            ) : (
              <ul className="space-y-2">
                {crossFormDFilings.map((f) => (
                  <li key={f.accession} className="text-xs text-gray-700 flex items-start justify-between gap-3 py-2 border-b border-gray-50 last:border-b-0">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{f.entityname}</div>
                      <div className="text-[11px] text-gray-500">via {f.series_master_llc || '—'} • {fmtDate(f.filing_date)}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="tabular-nums font-semibold">{fmtUsd(f.totalofferingamount)}</div>
                      <div className="text-[10px] text-gray-400 font-mono">{f.accession}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">ADV-registered advisers holding {companyDisplayName(company)}</h3>
            {crossRelatedAdvisers.length === 0 ? (
              <p className="text-sm text-gray-500">No related ADV records.</p>
            ) : (
              <ul className="space-y-2">
                {crossRelatedAdvisers.map((a) => (
                  <li key={a.crd} className="text-xs text-gray-700 flex items-start justify-between gap-3 py-2 border-b border-gray-50 last:border-b-0">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{a.adviser_name}</div>
                      <div className="text-[11px] text-gray-500">CRD <a className="text-slate-600 hover:text-slate-800 underline-offset-2 hover:underline" href={`/?adviser=${a.crd}`}>{a.crd}</a> • {fmtInt(a.fund_count)} funds</div>
                    </div>
                    <div className="text-right shrink-0 tabular-nums font-semibold">{fmtUsd(a.total_aum)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SectionCard>
    </PageChrome>
  );
};

const Stat = ({ label, value, hint }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-gray-400">{label}</div>
    <div className="text-base font-semibold text-gray-900 tabular-nums mt-0.5">{value}</div>
    {hint && <div className="text-[10px] text-gray-400">{hint}</div>}
  </div>
);

const Detail = ({ label, value, mono, className = '' }) => (
  <div className={className}>
    <div className="text-[10px] uppercase tracking-wider text-gray-400">{label}</div>
    <div className={`mt-0.5 text-gray-800 break-words ${mono ? 'font-mono text-[11px]' : ''}`}>{value || '—'}</div>
  </div>
);

const FactPill = ({ label, value }) => (
  <span className="inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 text-slate-700 ring-1 ring-slate-200">
    <span className="text-[9px] uppercase tracking-wider text-slate-400">{label}</span>
    <span className="font-medium tabular-nums">{value || '—'}</span>
  </span>
);

const NportFacts = ({ holding }) => {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] leading-5">
      <FactPill label="Restricted" value={yesNo(holding.is_restricted_security)} />
      <FactPill label="FV" value={holding.fair_value_level ? `L${holding.fair_value_level}` : '—'} />
      <FactPill label="Asset" value={securityTypeLabel(holding.asset_cat)} />
      <FactPill label="Payoff" value={holding.payoff_profile || '—'} />
      <FactPill label="Units" value={unitLabel(holding.unit, holding.other_unit_desc)} />
      <FactPill label="Issuer" value={holding.issuer_type || '—'} />
    </div>
  );
};

const stripCikLeadingZeros = (cik) => {
  if (!cik) return '';
  return String(cik).replace(/^0+/, '') || '0';
};

// ---------------------------------------------------------------------------
// Fund Page — /fund/:cik/:series_id
// ---------------------------------------------------------------------------
const FundPage = ({ cik, seriesId }) => {
  const [loading, setLoading] = useStateN(true);
  const [error, setError] = useStateN(null);
  const [data, setData] = useStateN(null);
  const [positionSort, setPositionSort] = useStateN({ key: 'value', dir: 'desc' });

  useEffectN(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      const companyFilter = new URLSearchParams(window.location.search).get('company');
      const r = seriesId
        ? await fetchNport(`/api/nport/funds/${cik}/${seriesId}`)
        : await fetchNport(`/api/nport/funds/${cik}`);
      const [positionsR, managersR, adviserR] = await Promise.all([
        seriesId
          ? fetchNport(`/api/nport/funds/${cik}/${seriesId}/positions?pageSize=1000`)
          : fetchNport(`/api/nport/funds/${cik}/positions?pageSize=1000${companyFilter ? `&company=${encodeURIComponent(companyFilter)}` : ''}`),
        seriesId ? fetchNport(`/api/nport/funds/${cik}/${seriesId}/managers`) : Promise.resolve({ ok: true, data: { managers: [] } }),
        seriesId ? fetchNport(`/api/nport/funds/${cik}/${seriesId}/adviser`) : fetchNport(`/api/nport/funds/${cik}/adviser`),
      ]);
      if (cancelled) return;
      if (!r.ok || !r.data) { setError(r.error || 'Fund not found'); setLoading(false); return; }
      setData({
        overview: r.data,
        positions: positionsR.ok ? (positionsR.data.positions || []) : [],
        managers: managersR.ok ? (managersR.data.managers || []) : [],
        adviser: adviserR.ok ? adviserR.data : null,
        companyFilter,
      });
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [cik, seriesId]);

  if (loading) {
    return <PageChrome breadcrumb={`fund / ${cik} / ${seriesId}`}><Spinner label="Loading fund details..." /></PageChrome>;
  }
  if (error || !data) {
    return <PageChrome breadcrumb={`fund / ${cik} / ${seriesId}`}><ErrorState message={error || 'Fund not found'} /></PageChrome>;
  }

  const series = seriesId ? (data.overview.series || null) : null;
  const filer = data.overview.filer || null;
  const positions = data.positions || [];
  const qoq = data.qoq_changes || [];
  const managers = data.managers || [];
  const adviserPayload = data.adviser || {};
  const adviserRecord = adviserPayload.adviser || adviserPayload.adv_adviser || null;
  const ncenLink = adviserPayload.ncen_link || adviserPayload.ncen || null;
  const adviserName = (adviserRecord && (adviserRecord.adviser_name || adviserRecord.adviser_entity_legal_name)) ||
    (ncenLink && (ncenLink.adviser_name || ncenLink.investment_adviser_name));
  const website = adviserWebsite(adviserRecord);
  const latestPositionDate = positions[0] && (positions[0].report_period_date || positions[0].report_period_end);
  const latestPositions = latestPositionDate ? positions.filter((p) => (p.report_period_date || p.report_period_end) === latestPositionDate) : positions;
  const privateExposureUsd = latestPositions.reduce((sum, p) => sum + (Number(p.currency_value_usd || p.value_usd) || 0), 0);
  const navValues = latestPositions.map((p) => Number(p.net_assets_usd)).filter((n) => Number.isFinite(n) && n > 0);
  const latestNav = navValues.length > 0 ? Math.max(...navValues) : null;
  const exposurePct = latestNav ? (privateExposureUsd / latestNav) * 100 : null;
  const pageTitle = series ? (series.series_name || seriesId) : (filer && filer.name) || `CIK ${cik}`;
  const registrantName = series ? series.registrant_name : (filer && filer.name);
  const positionSortAccessors = {
    company: { type: 'text', value: (p) => p.company_name || p.company_slug || '' },
    security: { type: 'text', value: (p) => `${p.share_class || p.share_class_normalized || ''} ${securityTypeLabel(p.asset_cat)}` },
    value: { type: 'number', value: (p) => p.value_usd ?? p.currency_value_usd },
    nav: { type: 'number', value: (p) => p.pct_of_nav },
    snapshot: { type: 'text', value: (p) => rowPeriodDate(p) || '' },
  };
  const positionSortDefaults = {
    company: 'asc',
    security: 'asc',
    value: 'desc',
    nav: 'desc',
    snapshot: 'desc',
  };
  const sortedPositions = sortRows(positions, positionSort, positionSortAccessors);
  const setPositionSortKey = (key) => toggleSort(setPositionSort, key, positionSortDefaults);

  return (
    <PageChrome breadcrumb={`fund / ${pageTitle}`}>
      {/* Header */}
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 mb-6 p-6">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">{pageTitle}</h1>
            <p className="text-sm text-gray-500 mt-1">
              <span className="font-mono text-xs">CIK {String(cik).padStart(10, '0')}</span>
              {series && <><span className="mx-2">·</span><span className="font-mono text-xs">Series {series.series_id || seriesId}</span></>}
              {registrantName && <><span className="mx-2">·</span>{registrantName}</>}
            </p>
            <p className="text-sm text-gray-700 mt-2">
              Adviser: <span className="font-medium">{adviserName || 'Not linked yet'}</span>
              {adviserPayload && adviserPayload.adviser_crd && adviserRecord && adviserRecord.form_adv_url && (
                <a href={adviserRecord.form_adv_url} target="_blank" rel="noreferrer" className="ml-2 text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1 underline-offset-2 hover:underline">
                  CRD {adviserPayload.adviser_crd}
                  <IconExternal className="w-3 h-3" />
                </a>
              )}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Fund NAV" value={fmtUsd(latestNav)} hint={fmtDate(latestPositionDate)} />
            <Stat label="Private-company exposure" value={fmtUsd(privateExposureUsd)} />
            <Stat label="% of NAV" value={exposurePct != null ? fmtPct(exposurePct, false) : '—'} />
          </div>
        </div>
      </div>

      {/* Adviser and contact */}
      <SectionCard title="Adviser and contacts" subtitle="N-CEN adviser link enriched with Form ADV firm data">
        {!adviserName ? (
          <p className="text-sm text-gray-500">{adviserPayload.note || 'No adviser link has been resolved yet.'}</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-400">Investment adviser</div>
              <div className="text-sm font-semibold text-gray-900 mt-1">{adviserName}</div>
              <div className="text-xs text-gray-500 mt-1">
                {adviserPayload.adviser_crd ? `CRD ${adviserPayload.adviser_crd}` : 'CRD not available'}
                {ncenLink && ncenLink.filing_date ? ` · N-CEN ${fmtDate(ncenLink.filing_date)}` : ''}
              </div>
              <div className="flex flex-wrap gap-3 mt-3">
                {adviserRecord && adviserRecord.form_adv_url && (
                  <a href={adviserRecord.form_adv_url} target="_blank" rel="noreferrer" className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1">
                    Form ADV <IconExternal className="w-3 h-3" />
                  </a>
                )}
                {website && (
                  <a href={ensureUrl(website)} target="_blank" rel="noreferrer" className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1">
                    Website <IconExternal className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Stat label="ADV firm AUM" value={fmtUsd(adviserRecord && (adviserRecord.total_aum || adviserRecord.aum_2026))} />
              <Stat label="Phone" value={(adviserRecord && adviserRecord.phone_number) || '—'} />
              <Stat label="Registration" value={(adviserRecord && adviserRecord.registration_type) || '—'} />
              <Stat label="Source" value={adviserPayload.ncen_source === 'fund_ncen_adviser_links' ? (ncenLink && ncenLink.series_id ? 'N-CEN series' : 'N-CEN registrant') : 'N-CEN filing'} />
            </div>
            <div className="text-sm">
              <div className="text-[11px] uppercase tracking-wider text-gray-400">Firm contacts</div>
              <div className="mt-2 space-y-2">
                <div>
                  <div className="text-xs text-gray-500">Regulatory contact</div>
                  <div className="text-gray-900">{(adviserRecord && adviserRecord.regulatory_contact_name) || '—'}</div>
                  {adviserRecord && adviserRecord.regulatory_contact_email && (
                    <a className="text-xs text-slate-600 hover:text-slate-800" href={`mailto:${adviserRecord.regulatory_contact_email}`}>{adviserRecord.regulatory_contact_email}</a>
                  )}
                </div>
                <div>
                  <div className="text-xs text-gray-500">Chief compliance officer</div>
                  <div className="text-gray-900">{(adviserRecord && adviserRecord.cco_name) || '—'}</div>
                  {adviserRecord && adviserRecord.cco_email && (
                    <a className="text-xs text-slate-600 hover:text-slate-800" href={`mailto:${adviserRecord.cco_email}`}>{adviserRecord.cco_email}</a>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Portfolio Managers */}
      <SectionCard title="Portfolio managers" subtitle="From the most recent N-1A / 485BPOS filing">
        {managers.length === 0 ? (
          <p className="text-sm text-gray-500">No managers on record yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-gray-400">
              <tr><th className="text-left py-2">Name</th><th className="text-left">Role</th><th className="text-left">Tenure since</th><th className="text-left">Status</th></tr>
            </thead>
            <tbody>
              {managers.map((m, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-2.5 font-medium text-gray-900">{m.pm_name}</td>
                  <td className="py-2.5 text-gray-700">{m.pm_role}</td>
                  <td className="py-2.5 text-gray-700">{fmtDate(m.pm_managing_since)}</td>
                  <td className="py-2.5">
                    {m.retirement_date ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">Retiring {fmtDate(m.retirement_date)}</span>
                    ) : m.is_currently_active ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">Active</span>
                    ) : (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Past</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* Private-company exposure table */}
      <SectionCard title="Private-company holdings" subtitle={`${fmtInt(positions.length)} reported positions${data.companyFilter ? ` matching ${data.companyFilter}` : ''}`}>
        {positions.length === 0 ? (
          <p className="text-sm text-gray-500">No private positions reported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <tr>
                  <SortableHeader label="Company" sortKey="company" sort={positionSort} onSort={setPositionSortKey} className="py-2 pr-3" />
                  <SortableHeader label="Security" sortKey="security" sort={positionSort} onSort={setPositionSortKey} className="pr-3" />
                  <SortableHeader label="Reported value" sortKey="value" sort={positionSort} onSort={setPositionSortKey} align="right" className="pr-3" />
                  <SortableHeader label="% of NAV" sortKey="nav" sort={positionSort} onSort={setPositionSortKey} align="right" className="pr-3" />
                  <SortableHeader label="Snapshot" sortKey="snapshot" sort={positionSort} onSort={setPositionSortKey} className="pr-3" />
                  <th className="text-right">Links</th>
                </tr>
              </thead>
              <tbody>
                {sortedPositions.map((p, i) => {
                  const filingUrl = secFilingUrl(p.registrant_cik, p.accession_number);
                  return (
                    <tr key={`${p.accession_number || i}-${p.holding_id_internal || i}`} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-2.5 pr-3">
                        {p.company_slug ? (
                          <a href={`/company/${p.company_slug}${isMockMode() ? '?mock=1' : ''}`} className="font-medium text-gray-900 hover:underline">{p.company_name}</a>
                        ) : <span className="font-medium text-gray-900">{p.company_name || '—'}</span>}
                        <div className="text-[11px] text-gray-500">{p.raw_issuer_name || p.issuer_name || '—'}</div>
                      </td>
                      <td className="py-2.5 pr-3 text-gray-700">
                        <div>{p.share_class || p.share_class_normalized || '—'}</div>
                        <div className="text-[11px] text-gray-500">{securityTypeLabel(p.asset_cat)}</div>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-gray-900">{fmtUsd(p.value_usd ?? p.currency_value_usd)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-gray-700">{p.pct_of_nav != null ? fmtPct(p.pct_of_nav, false) : '—'}</td>
                      <td className="py-2.5 pr-3 text-gray-700">{fmtDate(p.report_period_date || p.report_period_end)}</td>
                      <td className="py-2.5 text-right">
                        {filingUrl ? (
                          <a href={filingUrl} target="_blank" rel="noreferrer" className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1">
                            SEC filing <IconExternal className="w-3 h-3" />
                          </a>
                        ) : <span className="text-xs text-gray-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* QoQ changes */}
      <SectionCard title="Q-over-Q changes" subtitle="New, exited, marked-up, or marked-down positions since prior period">
        {qoq.length === 0 ? (
          <p className="text-sm text-gray-500">No quarter-over-quarter changes.</p>
        ) : (
          <ul className="space-y-2">
            {qoq.map((c, i) => {
              const positive = (c.pct_change || 0) >= 0;
              const badge =
                c.change_kind === 'new'        ? { txt: 'NEW',       cls: 'bg-indigo-50 text-indigo-700' } :
                c.change_kind === 'exited'     ? { txt: 'EXITED',    cls: 'bg-rose-50 text-rose-700' } :
                c.change_kind === 'repricing'  ? { txt: 'REPRICING', cls: 'bg-amber-50 text-amber-700' } :
                c.change_kind === 'markdown'   ? { txt: 'MARKDOWN',  cls: 'bg-rose-50 text-rose-700' } :
                                                 { txt: 'MARKUP',    cls: 'bg-emerald-50 text-emerald-700' };
              return (
                <li key={i} className="flex items-start justify-between gap-3 py-2 border-b border-gray-50 last:border-b-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                      {c.company_slug ? (
                        <a href={`/company/${c.company_slug}${isMockMode() ? '?mock=1' : ''}`} className="hover:underline">
                          {c.company_slug.charAt(0).toUpperCase() + c.company_slug.slice(1)}
                        </a>
                      ) : '—'}
                      {c.share_class && <span className="text-[11px] text-gray-500">{c.share_class}</span>}
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.txt}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {c.prev_value_usd != null && <>{fmtUsd(c.prev_value_usd)} → </>}
                      <span className="font-semibold text-gray-700">{fmtUsd(c.curr_value_usd)}</span>
                      {c.note && <span className="ml-2 italic">{c.note}</span>}
                    </div>
                  </div>
                  <div className={`text-sm font-semibold inline-flex items-center gap-1 ${positive ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {c.pct_change != null && (positive ? <IconTrendUp className="w-4 h-4" /> : <IconTrendDown className="w-4 h-4" />)}
                    {fmtPct(c.pct_change, true)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </PageChrome>
  );
};

// ---------------------------------------------------------------------------
// Admin triage page — /admin/unresolved
// ---------------------------------------------------------------------------
const AdminUnresolvedPage = () => {
  const [loading, setLoading] = useStateN(true);
  const [error, setError] = useStateN(null);
  const [groups, setGroups] = useStateN([]);
  const [directory, setDirectory] = useStateN([]);
  const [resolved, setResolved] = useStateN({}); // { normalized_name: { action, target_slug?, new_name? } }

  useEffectN(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const r = await fetchNport('/api/nport/admin/unresolved', { headers: nportAdminHeaders() });
      if (cancelled) return;
      if (!r.ok || !r.data) { setError(r.error || 'Failed to load triage queue'); setLoading(false); return; }
      setGroups(r.data.unresolved || []);
      setDirectory(r.data.company_directory || []);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const handleMatch = async (group, slug) => {
    // In mock mode just record the decision locally.
    setResolved((prev) => ({ ...prev, [group.normalized_name]: { action: 'matched', target_slug: slug } }));
    if (!isMockMode()) {
      await fetchNport('/api/nport/admin/aliases', {
        method: 'POST',
        headers: nportAdminHeaders(),
        body: JSON.stringify({ rawName: group.normalized_name, canonicalSlug: slug, patternType: 'exact_normalized' })
      });
    }
  };

  const handleCreate = async (group, newName) => {
    const cleanName = (newName || '').trim();
    if (!cleanName) return;
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    setResolved((prev) => ({ ...prev, [group.normalized_name]: { action: 'created', target_slug: slug, new_name: cleanName } }));
    if (!isMockMode()) {
      await fetchNport('/api/nport/admin/aliases', {
        method: 'POST',
        headers: nportAdminHeaders(),
        body: JSON.stringify({ rawName: group.normalized_name, newCompanyName: cleanName, patternType: 'exact_normalized' })
      });
    }
  };

  const handleJunk = async (group, reason) => {
    setResolved((prev) => ({ ...prev, [group.normalized_name]: { action: reason } }));
    if (!isMockMode()) {
      await fetchNport('/api/nport/admin/aliases', {
        method: 'POST',
        headers: nportAdminHeaders(),
        body: JSON.stringify({ normalized_name: group.normalized_name, mark_as: reason })
      });
    }
  };

  if (loading) {
    return <PageChrome breadcrumb="admin / unresolved"><Spinner label="Loading unresolved holdings..." /></PageChrome>;
  }
  if (error) {
    return <PageChrome breadcrumb="admin / unresolved"><ErrorState message={error} /></PageChrome>;
  }

  return (
    <PageChrome breadcrumb="admin / unresolved">
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 mb-6 p-6">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Unresolved holdings</h1>
        <p className="text-sm text-gray-600 mt-1">
          {fmtInt(groups.length)} normalized issuer name{groups.length === 1 ? '' : 's'} need triage. Match to an existing company,
          create a new company, or mark as junk / SPV / sanctioned.
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-12 text-center">
          <IconCheck className="w-8 h-8 text-emerald-500 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-900">No unresolved holdings in the queue.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {groups.map((g) => {
            const decision = resolved[g.normalized_name];
            return (
              <li key={g.normalized_name} className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
                <header className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 font-mono">{g.normalized_name}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {fmtInt(g.filer_count)} filers · {fmtUsd(g.total_value_usd)} total value · {fmtInt(g.total_balance)} units
                      {g.suggested_action && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">suggested: {g.suggested_action}</span>
                      )}
                    </p>
                  </div>
                  {decision && (
                    <span className="text-[11px] px-2 py-1 rounded bg-emerald-50 text-emerald-700 inline-flex items-center gap-1.5">
                      <IconCheck className="w-3 h-3" />
                      {decision.action === 'matched' ? `Matched → ${decision.target_slug}`
                       : decision.action === 'created' ? `Created → ${decision.target_slug}`
                       : `Marked as ${decision.action}`}
                    </span>
                  )}
                </header>

                {/* Sample rows */}
                <div className="px-6 py-3 border-b border-gray-100">
                  <table className="w-full text-xs">
                    <thead className="text-[10px] uppercase tracking-wider text-gray-400">
                      <tr><th className="text-left py-1">Issuer name (raw)</th><th className="text-left">Title</th><th className="text-left">Registrant</th><th className="text-right">Value</th></tr>
                    </thead>
                    <tbody>
                      {g.sample_rows.map((r) => (
                        <tr key={r.accession_number} className="border-t border-gray-50">
                          <td className="py-1.5 text-gray-700 font-mono">{r.issuer_name}</td>
                          <td className="py-1.5 text-gray-600">{r.issuer_title || '—'}</td>
                          <td className="py-1.5 text-gray-600">{r.registrant_name}</td>
                          <td className="py-1.5 text-right tabular-nums text-gray-700">{fmtUsd(r.value_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {g.candidates && g.candidates.length > 0 && (
                  <div className="px-6 py-3 border-b border-gray-100 bg-slate-50/60">
                    <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">Suggested matches</div>
                    <div className="flex flex-wrap gap-2">
                      {g.candidates.map((candidate) => (
                        <button
                          key={candidate.company_slug}
                          onClick={() => handleMatch(g, candidate.company_slug)}
                          className="text-left rounded-lg bg-white ring-1 ring-gray-200 px-3 py-2 hover:ring-slate-400 hover:bg-slate-50 transition">
                          <div className="text-xs font-semibold text-gray-900">{candidate.display_name}</div>
                          <div className="text-[10px] text-gray-500">
                            score {candidate.score} · {candidate.reason}
                            {candidate.matched_pattern ? ` · ${candidate.matched_pattern}` : ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                {!decision && (
                  <TriageActions
                    group={g}
                    directory={directory}
                    candidates={g.candidates || []}
                    onMatch={(slug) => handleMatch(g, slug)}
                    onCreate={(name) => handleCreate(g, name)}
                    onJunk={(reason) => handleJunk(g, reason)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PageChrome>
  );
};

const TriageActions = ({ group, directory, candidates, onMatch, onCreate, onJunk }) => {
  const [mode, setMode] = useStateN('idle'); // 'idle' | 'matching' | 'creating'
  const [search, setSearch] = useStateN('');
  const [newName, setNewName] = useStateN('');

  const filtered = useMemoN(() => {
    if (!search && candidates && candidates.length > 0) {
      return candidates.map((candidate) => ({
        slug: candidate.company_slug,
        display_name: candidate.display_name,
        sector: candidate.sector,
        primary_domain: candidate.primary_domain,
        candidate_reason: `${candidate.score} · ${candidate.reason}`,
      }));
    }
    if (!search) return directory.slice(0, 6);
    const q = search.toLowerCase();
    return directory
      .filter(c => String(c.display_name || '').toLowerCase().includes(q) || String(c.slug || '').includes(q))
      .slice(0, 8);
  }, [directory, search]);

  if (mode === 'matching') {
    return (
      <div className="px-6 py-4 bg-gray-50">
        <div className="flex items-center gap-2 mb-3">
          <input
            type="search"
            placeholder="Search companies..."
            className="flex-1 text-sm px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:outline-none focus:ring-2 focus:ring-slate-400"
            value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
          />
          <button onClick={() => setMode('idle')} className="text-xs text-gray-500 hover:text-gray-700">cancel</button>
        </div>
        <ul className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {filtered.map((c) => (
            <li key={c.slug}>
              <button
                onClick={() => onMatch(c.slug)}
                className="w-full text-left px-3 py-2 rounded-lg bg-white ring-1 ring-gray-200 hover:ring-slate-400 hover:bg-slate-50 transition-colors">
                <div className="text-sm font-medium text-gray-900">{c.display_name}</div>
                <div className="text-[10px] text-gray-500 font-mono">{c.candidate_reason || c.slug}</div>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="col-span-full text-xs text-gray-500 py-2">No matches. Try creating a new company.</li>
          )}
        </ul>
      </div>
    );
  }

  if (mode === 'creating') {
    return (
      <div className="px-6 py-4 bg-gray-50 flex items-center gap-2">
        <input
          type="text"
          placeholder={`New company name (e.g. ${group.normalized_name.toLowerCase().replace(/\binc\b|\bllc\b|\bcorp\b/gi, '').trim() || 'Acme Inc'})`}
          className="flex-1 text-sm px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:outline-none focus:ring-2 focus:ring-slate-400"
          value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus
        />
        <button onClick={() => { if (newName.trim()) onCreate(newName); }}
          disabled={!newName.trim()}
          className="text-xs font-medium px-3 py-2 rounded-lg bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50">
          Create
        </button>
        <button onClick={() => setMode('idle')} className="text-xs text-gray-500 hover:text-gray-700">cancel</button>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 flex flex-wrap gap-2">
      <button onClick={() => setMode('matching')}
        className="text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-700 text-white hover:bg-slate-800 inline-flex items-center gap-1.5">
        <IconCheck className="w-3.5 h-3.5" /> Match to existing
      </button>
      <button onClick={() => setMode('creating')}
        className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white ring-1 ring-gray-200 hover:bg-gray-50 inline-flex items-center gap-1.5">
        <IconPlus className="w-3.5 h-3.5" /> Create new
      </button>
      <button onClick={() => onJunk('junk')}
        className="text-xs px-3 py-1.5 rounded-lg ring-1 ring-gray-200 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5">
        <IconX className="w-3.5 h-3.5" /> Junk
      </button>
      <button onClick={() => onJunk('spv')}
        className="text-xs px-3 py-1.5 rounded-lg ring-1 ring-gray-200 text-gray-600 hover:bg-gray-50">
        Mark SPV
      </button>
      <button onClick={() => onJunk('sanctioned')}
        className="text-xs px-3 py-1.5 rounded-lg ring-1 ring-rose-200 text-rose-700 hover:bg-rose-50">
        Sanctioned
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Top-level NportRouter — picks the page based on URL.
// ---------------------------------------------------------------------------
window.NportRouter = function NportRouter() {
  const route = window.matchNportRoute(window.location.pathname);
  if (!route) return null;
  if (route.kind === 'dashboard') return <DashboardPage />;
  if (route.kind === 'company') return <CompanyPage slug={route.slug} />;
  if (route.kind === 'fund')    return <FundPage cik={route.cik} seriesId={route.series_id} />;
  if (route.kind === 'admin')   return <AdminUnresolvedPage />;
  return null;
};

window.mountNportRouter = function mountNportRouter() {
  const route = window.matchNportRoute && window.matchNportRoute(window.location.pathname);
  const rootEl = document.getElementById('root');
  if (!route || !rootEl || rootEl.dataset.nportMounted === '1') return;
  rootEl.dataset.nportMounted = '1';
  const root = ReactDOM.createRoot(rootEl);
  root.render(React.createElement(window.NportRouter, { route }));
};

window.mountNportRouter();
