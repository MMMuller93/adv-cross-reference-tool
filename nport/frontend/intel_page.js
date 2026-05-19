/* Fund Holders Intel — standalone React page for /intel/:slug
 *
 * Design: matches PFR's brand language — Inter (sans), Source Serif 4
 * (headings), JetBrains Mono (numbers/CRDs), slate color scale.
 *
 * Data source: GET /api/intel/companies/:slug/holders
 *
 * Layout:
 *   1. Company header card        (name, sector, founded, last round, valuation)
 *   2. Lifecycle banner           (only when current_status != 'private')
 *   3. Summary metrics row        (4 stat cards)
 *   4. Adviser firm rollup        (cards sorted by total holdings value)
 *   5. N-PORT holdings table      (collapsible)
 *   6. Form D pooled vehicles     (collapsible)
 *   7. Lifecycle events timeline  (collapsible, only when events exist)
 */

const { useState: useStateI, useEffect: useEffectI, useMemo: useMemoI } = React;

// --- formatters -------------------------------------------------------------

const fmtUsdShort = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};

const fmtInt = (n) => {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US').format(Number(n));
};

const fmtDate = (d) => (d ? String(d).slice(0, 10) : '—');

const fmtStatus = (s) => {
  if (!s) return '—';
  return s.replace(/_/g, ' ');
};

// --- adviser card -----------------------------------------------------------

function AdviserCard({ adv }) {
  const owners = (adv.owner_full_legal_name || '').split(';').map(s => s.trim()).filter(Boolean);
  const titles = (adv.owner_title_or_status || '').split(';').map(s => s.trim()).filter(Boolean);
  const principals = owners.slice(0, 6).map((name, i) => ({
    name,
    title: titles[i] || '',
  }));
  const hasContact = adv.cco_email || adv.regulatory_contact_email || adv.alt_contact_email;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-serif text-lg font-semibold text-slate-900 leading-tight">
            {adv.name || '(unidentified)'}
          </h3>
          <p className="font-mono text-xs text-slate-500 mt-0.5">CRD {adv.crd}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-serif font-semibold text-slate-900">
            {fmtUsdShort(adv.total_value_usd)}
          </div>
          <div className="text-xs text-slate-500">{adv.evidence_count} holding{adv.evidence_count === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm mb-3">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">Total AUM</div>
          <div className="font-mono">{fmtUsdShort(adv.total_aum)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">Phone</div>
          <div className="font-mono text-xs">{adv.phone || '—'}</div>
        </div>
      </div>

      {adv.website && (
        <div className="mb-3">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-0.5">Website</div>
          <a href={adv.website.toLowerCase().startsWith('http') ? adv.website : 'https://' + adv.website}
             target="_blank" rel="noopener noreferrer"
             className="text-sm text-slate-700 hover:text-slate-900 underline break-all">
            {adv.website}
          </a>
        </div>
      )}

      {hasContact && (
        <div className="border-t border-slate-100 pt-3 mb-3">
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">Contact</div>
          {adv.cco_name && (
            <div className="text-sm mb-1">
              <span className="text-slate-500">CCO: </span>
              <span className="text-slate-900">{adv.cco_name}</span>
              {adv.cco_email && (
                <a href={`mailto:${adv.cco_email}`} className="ml-2 text-xs text-slate-600 hover:text-slate-900 font-mono break-all">
                  {adv.cco_email}
                </a>
              )}
            </div>
          )}
          {adv.signatory_name && adv.signatory_name !== adv.cco_name && (
            <div className="text-sm mb-1">
              <span className="text-slate-500">Signatory: </span>
              <span className="text-slate-900">{adv.signatory_name}</span>
              {adv.signatory_title && <span className="text-xs text-slate-500 ml-1">({adv.signatory_title})</span>}
            </div>
          )}
          {adv.regulatory_contact_email && adv.regulatory_contact_email !== adv.cco_email && (
            <div className="text-sm">
              <span className="text-slate-500">Reg contact: </span>
              <a href={`mailto:${adv.regulatory_contact_email}`} className="text-xs font-mono text-slate-700 hover:text-slate-900 break-all">
                {adv.regulatory_contact_email}
              </a>
            </div>
          )}
          {adv.alt_contact_email && (
            <div className="text-sm">
              <span className="text-slate-500">Web-found: </span>
              <a href={`mailto:${adv.alt_contact_email}`} className="text-xs font-mono text-slate-700 hover:text-slate-900 break-all">
                {adv.alt_contact_email}
              </a>
            </div>
          )}
        </div>
      )}

      {principals.length > 0 && (
        <div className="border-t border-slate-100 pt-3 mb-3">
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">
            Principals / Owners
            {adv.ownership_amount && (
              <span className="ml-1 text-slate-500 normal-case font-normal">({adv.ownership_amount})</span>
            )}
          </div>
          <ul className="text-sm space-y-0.5">
            {principals.map((p, i) => (
              <li key={i} className="text-slate-700">
                <span className="font-medium text-slate-900">{p.name}</span>
                {p.title && <span className="text-xs text-slate-500 ml-2">{p.title}</span>}
              </li>
            ))}
            {owners.length > principals.length && (
              <li className="text-xs text-slate-400 italic">+{owners.length - principals.length} more</li>
            )}
          </ul>
        </div>
      )}

      {adv.team_members && (
        <div className="border-t border-slate-100 pt-3 mb-3">
          <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">Team (web-enriched)</div>
          <div className="text-sm text-slate-700">{adv.team_members}</div>
        </div>
      )}

      <div className="border-t border-slate-100 pt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {adv.form_adv_url && (
          <a href={adv.form_adv_url} target="_blank" rel="noopener noreferrer"
             className="text-slate-600 hover:text-slate-900 underline">
            Form ADV ↗
          </a>
        )}
        {adv.linkedin_company_url && (
          <a href={adv.linkedin_company_url} target="_blank" rel="noopener noreferrer"
             className="text-slate-600 hover:text-slate-900 underline">
            LinkedIn ↗
          </a>
        )}
        {adv.twitter_handle && (
          <a href={`https://twitter.com/${adv.twitter_handle.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer"
             className="text-slate-600 hover:text-slate-900 underline">
            @{adv.twitter_handle.replace(/^@/, '')} ↗
          </a>
        )}
      </div>
    </div>
  );
}

// --- collapsible tables -----------------------------------------------------

function CollapsibleSection({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useStateI(defaultOpen);
  return (
    <section className="mb-8">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-left mb-3 group">
        <h2 className="font-serif text-xl font-semibold text-slate-900">
          {title}
          {count != null && <span className="ml-2 text-sm text-slate-500 font-sans font-normal">({count})</span>}
        </h2>
        <span className="text-slate-400 group-hover:text-slate-700 text-sm">
          {open ? '▼' : '▶'}
        </span>
      </button>
      {open && children}
    </section>
  );
}

function NportTable({ rows }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No private-era N-PORT holdings.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 tracking-wide">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Holding</th>
            <th className="px-3 py-2 text-left font-semibold">Manager</th>
            <th className="px-3 py-2 text-right font-semibold">Value</th>
            <th className="px-3 py-2 text-left font-semibold">As-of</th>
            <th className="px-3 py-2 text-left font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.issuer_title}</td>
              <td className="px-3 py-2 text-slate-900">{r.adviser_name || <span className="text-slate-400 italic">unidentified</span>}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtUsdShort(r.value_usd)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{fmtDate(r.evidence_date)}</td>
              <td className="px-3 py-2 text-xs">
                <span className={r.status_at_evidence_date === 'private'
                  ? 'text-slate-600' : 'text-amber-700'}>
                  {fmtStatus(r.status_at_evidence_date)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && (
        <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100 bg-slate-50">
          Showing first 200 of {fmtInt(rows.length)} rows. Full CSV is at intelligence/out/.
        </div>
      )}
    </div>
  );
}

function FormDTable({ rows }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No private-era Form D pooled-vehicle filings.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 tracking-wide">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Filer</th>
            <th className="px-3 py-2 text-left font-semibold">Adviser</th>
            <th className="px-3 py-2 text-right font-semibold">Offering</th>
            <th className="px-3 py-2 text-left font-semibold">Filed</th>
            <th className="px-3 py-2 text-left font-semibold">Method</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="px-3 py-2 text-xs text-slate-700">{r.filer_entityname}</td>
              <td className="px-3 py-2 text-slate-900">{r.adviser_name || <span className="text-slate-400 italic">unbridged</span>}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtUsdShort(r.value_usd)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{fmtDate(r.filing_date)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{r.adviser_method || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && (
        <div className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100 bg-slate-50">
          Showing first 200 of {fmtInt(rows.length)} rows.
        </div>
      )}
    </div>
  );
}

function LifecycleTimeline({ events }) {
  if (!events || !events.length) return <p className="text-sm text-slate-500">No lifecycle events recorded.</p>;
  return (
    <ol className="space-y-2 border-l-2 border-slate-200 pl-4">
      {events.map((e, i) => (
        <li key={i} className="relative">
          <div className="absolute -left-[1.4rem] top-1.5 h-2 w-2 rounded-full bg-slate-400"></div>
          <div className="text-sm">
            <span className="font-mono text-xs text-slate-500">{fmtDate(e.event_date)}</span>
            <span className="ml-2 font-medium text-slate-900">{fmtStatus(e.event_type)}</span>
            <span className="ml-2 text-slate-600">→ {fmtStatus(e.status_after)}</span>
          </div>
          {e.source_name && (
            <div className="text-xs text-slate-500 mt-0.5">
              source: {e.source_url
                ? <a href={e.source_url} target="_blank" rel="noopener noreferrer" className="underline">{e.source_name}</a>
                : e.source_name}
              {e.confidence && <span className="ml-2">confidence: {e.confidence}</span>}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

// --- main page --------------------------------------------------------------

function IntelPage({ slug }) {
  const [data, setData] = useStateI(null);
  const [error, setError] = useStateI(null);
  const [auditMode, setAuditMode] = useStateI(false);

  useEffectI(() => {
    setData(null);
    setError(null);
    const params = auditMode ? '?audit=1' : '';
    fetch(`/api/intel/companies/${encodeURIComponent(slug)}/holders${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [slug, auditMode]);

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="font-serif text-2xl font-semibold mb-2 text-slate-900">Error loading {slug}</h1>
        <p className="text-sm text-red-700">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <p className="text-sm text-slate-500">Loading {slug}...</p>
      </div>
    );
  }

  const { company, lifecycle, summary, nport_holders, formd_holders, advisers } = data;
  const isPrivate = lifecycle.current_status === 'private';
  const totalValue = (advisers || []).reduce((s, a) => s + (a.total_value_usd || 0), 0);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Company header */}
      <header className="mb-8 pb-6 border-b border-slate-200">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="font-serif text-4xl font-bold tracking-tight text-slate-900">{company.display_name}</h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-slate-600">
              {company.sector && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-xs uppercase tracking-wide font-medium">{company.sector}</span>}
              {company.founded_year && <span>Founded {company.founded_year}</span>}
              {company.primary_domain && (
                <a href={`https://${company.primary_domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-slate-700 hover:text-slate-900 underline">
                  {company.primary_domain}
                </a>
              )}
            </div>
          </div>
          <div className="text-right">
            {company.latest_known_valuation_usd && (
              <>
                <div className="font-serif text-2xl font-semibold text-slate-900">{fmtUsdShort(company.latest_known_valuation_usd)}</div>
                <div className="text-xs text-slate-500">{company.most_recent_round || 'last reported valuation'}{company.most_recent_round_date ? ` • ${fmtDate(company.most_recent_round_date)}` : ''}</div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Lifecycle banner */}
      {!isPrivate && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
          <strong className="font-semibold">Lifecycle note: </strong>
          {company.display_name} is currently <strong>{fmtStatus(lifecycle.current_status)}</strong>
          {lifecycle.last_event_date && ` as of ${fmtDate(lifecycle.last_event_date)}`}.
          {!auditMode && ` Showing private-era holdings only — public-era rows are excluded.`}
          {auditMode && ` AUDIT MODE: all holdings shown regardless of era.`}
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wide">N-PORT holdings</div>
          <div className="font-serif text-2xl font-semibold text-slate-900 mt-1">{fmtInt(summary.eligible_nport)}</div>
          {summary.total_nport !== summary.eligible_nport && (
            <div className="text-xs text-slate-500 mt-0.5">{fmtInt(summary.total_nport - summary.eligible_nport)} public-era hidden</div>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Form D vehicles</div>
          <div className="font-serif text-2xl font-semibold text-slate-900 mt-1">{fmtInt(summary.eligible_formd)}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Adviser firms</div>
          <div className="font-serif text-2xl font-semibold text-slate-900 mt-1">{fmtInt(summary.distinct_advisers)}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wide">Total value</div>
          <div className="font-serif text-2xl font-semibold text-slate-900 mt-1">{fmtUsdShort(totalValue)}</div>
        </div>
      </div>

      {/* Audit toggle */}
      <div className="mb-6 flex items-center justify-end text-xs">
        <label className="flex items-center gap-2 text-slate-600 cursor-pointer">
          <input type="checkbox" checked={auditMode} onChange={(e) => setAuditMode(e.target.checked)} className="rounded border-slate-300" />
          Show audit mode (include public-era rows)
        </label>
      </div>

      {/* Advisers — primary section */}
      <section className="mb-10">
        <h2 className="font-serif text-2xl font-semibold text-slate-900 mb-4">Adviser firms</h2>
        {advisers.length === 0 ? (
          <p className="text-sm text-slate-500">No adviser firms identified for this company's eligible holdings.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {advisers.map((adv) => <AdviserCard key={adv.crd} adv={adv} />)}
          </div>
        )}
      </section>

      {/* N-PORT holdings */}
      <CollapsibleSection title="N-PORT registered-fund holdings" count={nport_holders.length}>
        <NportTable rows={nport_holders} />
      </CollapsibleSection>

      {/* Form D pooled vehicles */}
      <CollapsibleSection title="Form D pooled vehicles" count={formd_holders.length}>
        <FormDTable rows={formd_holders} />
      </CollapsibleSection>

      {/* Lifecycle events */}
      {(lifecycle.events && lifecycle.events.length > 0) && (
        <CollapsibleSection title="Lifecycle events" count={lifecycle.events.length}>
          <LifecycleTimeline events={lifecycle.events} />
        </CollapsibleSection>
      )}

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t border-slate-200 text-xs text-slate-500">
        Fund Holders Intel V1.1 • Lifecycle-aware • Source: N-PORT, Form D, ADV via SEC EDGAR
      </footer>
    </div>
  );
}

// --- bootstrap --------------------------------------------------------------

window.mountIntelRouter = function () {
  const match = window.location.pathname.match(/^\/intel\/([^\/]+)/);
  if (!match) return false;
  const slug = decodeURIComponent(match[1]);
  const root = document.getElementById('root');
  if (!root) return false;
  ReactDOM.createRoot(root).render(<IntelPage slug={slug} />);
  return true;
};
