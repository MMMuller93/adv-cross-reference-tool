// ============================================================================
// N-PORT private-company pages — Company / Fund / Admin triage.
// Styled to match existing app.js (Tailwind, Chart.js, gray-50 surfaces,
// slate accents). Loaded only when window.location.pathname matches one of:
//   /company/:slug
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
  if ((m = pathname.match(/^\/company\/([^/]+)\/?$/))) {
    return { kind: 'company', slug: decodeURIComponent(m[1]) };
  }
  if ((m = pathname.match(/^\/fund\/(\d+)\/([^/]+)\/?$/))) {
    return { kind: 'fund', cik: m[1], series_id: m[2] };
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

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const titleCaseSector = (s) => {
  if (!s) return '—';
  return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' / ');
};

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
  const [markupsPayload, setMarkupsPayload] = useStateN(null); // /markups
  const [cross, setCross] = useStateN(null);          // /cross

  useEffectN(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      const [a, b, c, d] = await Promise.all([
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}`),
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/timeseries`),
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/markups`),
        fetchNport(`/api/nport/companies/${encodeURIComponent(slug)}/cross`)
      ]);
      if (cancelled) return;
      if (!a.ok || !a.data) { setError(a.error || 'Company not found'); setLoading(false); return; }
      setMain(a.data);
      setTimeseries(b.ok ? b.data : null);
      setMarkupsPayload(c.ok ? c.data : null);
      setCross(d.ok ? d.data : null);
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
  const latestMarks = main.latest_marks || { report_period_end: null, classes: [] };
  const topHolders = main.top_holders || [];
  const markups = (markupsPayload && markupsPayload.markups) || main.markups || [];
  const history = (markupsPayload && markupsPayload.history) || [];
  const tsPoints = (timeseries && timeseries.points) || [];

  return (
    <PageChrome breadcrumb={`company / ${slug}`}>
      {/* Header */}
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 mb-6 p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight text-gray-900">{company.display_name}</h1>
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
          <Stat label="Disclosed N-PORT exposure" value={fmtUsd(company.total_disclosed_usd)} hint="latest period" />
          <Stat label="Distinct fund-family holders" value={fmtInt(company.distinct_filers)} />
          <Stat label="Last known valuation" value={fmtUsd(company.latest_known_valuation_usd)} />
          <Stat label="Total funding to date" value={fmtUsd(company.total_funding_usd)} />
          <Stat label="Sector" value={titleCaseSector(company.sector)} />
        </div>
      </div>

      {/* Latest marks + QoQ deltas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <SectionCard title="Latest marks by share class"
          subtitle={`Period ending ${fmtDate(latestMarks.report_period_end)} — median per share across holders`}>
          {latestMarks.classes.length === 0 ? (
            <p className="text-sm text-gray-500">No recent marks.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-gray-400">
                <tr><th className="text-left py-2">Share class</th><th className="text-right">Median / sh</th><th className="text-right">Holders</th><th className="text-right">Total shares</th></tr>
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

        <SectionCard title="Q-over-Q markup deltas" subtitle="Per-share change vs. prior public period">
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

      {/* Top holders table */}
      <SectionCard title="Top holders (current period)" subtitle={`Ranked by position value — ${fmtInt(topHolders.length)} shown`}>
        {topHolders.length === 0 ? (
          <p className="text-sm text-gray-500">No holders reported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <tr>
                  <th className="text-left py-2 pr-3">Registrant</th>
                  <th className="text-left pr-3">Series</th>
                  <th className="text-right pr-3">Position</th>
                  <th className="text-left pr-3">Share class</th>
                  <th className="text-left pr-3">PM</th>
                  <th className="text-right">Open</th>
                </tr>
              </thead>
              <tbody>
                {topHolders.map((h, i) => {
                  const fundUrl = h.series_id ? `/fund/${stripCikLeadingZeros(h.registrant_cik)}/${h.series_id}${isMockMode() ? '?mock=1' : ''}` : null;
                  return (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-2.5 pr-3 font-medium text-gray-900">{h.registrant_name}</td>
                      <td className="py-2.5 pr-3 text-[11px] font-mono text-gray-500">{h.series_id || '—'}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-gray-900">{fmtUsd(h.value_usd)}</td>
                      <td className="py-2.5 pr-3 text-gray-700">{h.share_class || '—'}</td>
                      <td className="py-2.5 pr-3 text-gray-700">{h.pm_name || '—'}</td>
                      <td className="py-2.5 text-right">
                        {fundUrl ? (
                          <a href={fundUrl} className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1">view fund <IconExternal className="w-3 h-3" /></a>
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

      {/* Time-series + markup-history charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        <SectionCard title="Holdings time series" subtitle="Total disclosed N-PORT $ across all holders per quarter">
          <TimeSeriesChart points={tsPoints} label="Disclosed $" />
        </SectionCard>
        <SectionCard title="All-tranches markup history" subtitle="Implied $ per share by tranche">
          <MarkupHistoryChart series={history} />
        </SectionCard>
      </div>

      {/* Cross-source view */}
      <SectionCard title="Cross-source view"
        subtitle="Form D filings + ADV-registered advisers + N-PORT consolidated">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Form D filings mentioning {company.display_name}</h3>
            {(!cross || cross.form_d_filings.length === 0) ? (
              <p className="text-sm text-gray-500">No Form D filings on record.</p>
            ) : (
              <ul className="space-y-2">
                {cross.form_d_filings.map((f) => (
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
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">ADV-registered advisers holding {company.display_name}</h3>
            {(!cross || cross.related_advisers.length === 0) ? (
              <p className="text-sm text-gray-500">No related ADV records.</p>
            ) : (
              <ul className="space-y-2">
                {cross.related_advisers.map((a) => (
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

  useEffectN(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      const r = await fetchNport(`/api/nport/funds/${cik}/${seriesId}`);
      if (cancelled) return;
      if (!r.ok || !r.data) { setError(r.error || 'Fund not found'); setLoading(false); return; }
      setData(r.data);
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

  const positions = data.positions || [];
  const qoq = data.qoq_changes || [];
  const managers = data.managers || [];

  return (
    <PageChrome breadcrumb={`fund / ${data.series_name || seriesId}`}>
      {/* Header */}
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 mb-6 p-6">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">{data.series_name}</h1>
            <p className="text-sm text-gray-500 mt-1">
              <span className="font-mono text-xs">CIK {data.cik}</span>
              <span className="mx-2">·</span>
              <span className="font-mono text-xs">Series {data.series_id}</span>
              {data.registrant_name && <><span className="mx-2">·</span>{data.registrant_name}</>}
            </p>
            <p className="text-sm text-gray-700 mt-2">
              Adviser: <span className="font-medium">{data.adviser_name}</span>
              {data.adviser_crd && (
                <a href={`/?adviser=${data.adviser_crd}`} className="ml-2 text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1 underline-offset-2 hover:underline">
                  CRD {data.adviser_crd}
                  <IconExternal className="w-3 h-3" />
                </a>
              )}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Total NAV" value={fmtUsd(data.total_nav_usd)} hint={fmtDate(data.latest_period_end)} />
            <Stat label="Private exposure" value={fmtUsd(data.private_exposure_usd)} />
            <Stat label="% of NAV" value={data.private_exposure_pct != null ? `${data.private_exposure_pct.toFixed(2)}%` : '—'} />
          </div>
        </div>
      </div>

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
      <SectionCard title="Private-company exposure" subtitle={`${fmtInt(positions.length)} positions as of ${fmtDate(data.latest_period_end)}`}>
        {positions.length === 0 ? (
          <p className="text-sm text-gray-500">No private positions reported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <tr>
                  <th className="text-left py-2 pr-3">Company</th>
                  <th className="text-left pr-3">Share class</th>
                  <th className="text-right pr-3">Value</th>
                  <th className="text-right pr-3">Acq. cost</th>
                  <th className="text-right pr-3">% of NAV</th>
                  <th className="text-right">Open</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2.5 pr-3 font-medium text-gray-900">{p.company_name}</td>
                    <td className="py-2.5 pr-3 text-gray-700">{p.share_class || '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-gray-900">{fmtUsd(p.value_usd)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-gray-700">{fmtUsd(p.acquisition_cost_usd)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-gray-700">{p.pct_of_nav != null ? `${p.pct_of_nav.toFixed(2)}%` : '—'}</td>
                    <td className="py-2.5 text-right">
                      {p.company_slug ? (
                        <a href={`/company/${p.company_slug}${isMockMode() ? '?mock=1' : ''}`}
                           className="text-xs text-slate-600 hover:text-slate-800 inline-flex items-center gap-1">
                          view company <IconExternal className="w-3 h-3" />
                        </a>
                      ) : <span className="text-xs text-gray-300">—</span>}
                    </td>
                  </tr>
                ))}
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
      const r = await fetchNport('/api/nport/admin/unresolved');
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normalized_name: group.normalized_name, company_slug: slug, pattern_type: 'exact_normalized' })
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normalized_name: group.normalized_name, new_company_name: cleanName, pattern_type: 'exact_normalized' })
      });
    }
  };

  const handleJunk = async (group, reason) => {
    setResolved((prev) => ({ ...prev, [group.normalized_name]: { action: reason } }));
    if (!isMockMode()) {
      await fetchNport('/api/nport/admin/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

                {/* Actions */}
                {!decision && (
                  <TriageActions
                    group={g}
                    directory={directory}
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

const TriageActions = ({ group, directory, onMatch, onCreate, onJunk }) => {
  const [mode, setMode] = useStateN('idle'); // 'idle' | 'matching' | 'creating'
  const [search, setSearch] = useStateN('');
  const [newName, setNewName] = useStateN('');

  const filtered = useMemoN(() => {
    if (!search) return directory.slice(0, 6);
    const q = search.toLowerCase();
    return directory.filter(c => c.display_name.toLowerCase().includes(q) || c.slug.includes(q)).slice(0, 8);
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
                <div className="text-[10px] text-gray-500 font-mono">{c.slug}</div>
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
// app.js boot section calls this when matchNportRoute() returns non-null.
// ---------------------------------------------------------------------------
window.NportRouter = function NportRouter() {
  const route = window.matchNportRoute(window.location.pathname);
  if (!route) return null;
  if (route.kind === 'company') return <CompanyPage slug={route.slug} />;
  if (route.kind === 'fund')    return <FundPage cik={route.cik} seriesId={route.series_id} />;
  if (route.kind === 'admin')   return <AdminUnresolvedPage />;
  return null;
};
