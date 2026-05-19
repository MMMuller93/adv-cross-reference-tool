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
 *   4. Adviser firms              (two-pane list + detail, list sorted by total $ desc)
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

const normalizeHref = (url) => {
  if (!url) return null;
  return url.toLowerCase().startsWith('http') ? url : `https://${url}`;
};

const firstInitial = (name) => {
  if (!name) return '?';
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
};

// --- adviser list row (left pane) -------------------------------------------

function AdviserListRow({ adv, selected, onClick }) {
  return (
    <div
      onClick={onClick}
      className={
        'flex items-center gap-3 px-3 py-3 cursor-pointer transition-colors border-l-2 ' +
        (selected
          ? 'bg-slate-50 border-slate-800'
          : 'bg-white border-transparent hover:bg-slate-50')
      }
    >
      {/* Avatar */}
      <div className="w-9 h-9 rounded bg-slate-800 flex items-center justify-center text-white font-serif font-medium text-base flex-shrink-0">
        {firstInitial(adv.name)}
      </div>

      {/* Name + CRD */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-serif font-semibold italic text-slate-900 tracking-tight truncate">
          {adv.name || '(unidentified)'}
        </div>
        <div className="text-[10px] font-mono text-slate-400 mt-0.5">CRD {adv.crd}</div>
      </div>

      {/* AUM */}
      <div className="text-right shrink-0 hidden sm:block">
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">AUM</div>
        <div className="text-[12px] font-mono text-slate-700 tabular-nums">{fmtUsdShort(adv.total_aum)}</div>
      </div>

      {/* Total value */}
      <div className="text-right shrink-0 w-20">
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Held</div>
        <div className="text-[13px] font-mono font-semibold text-slate-900 tabular-nums">{fmtUsdShort(adv.total_value_usd)}</div>
      </div>

      {/* Chevron */}
      <span className={'text-slate-300 shrink-0 ' + (selected ? 'text-slate-700' : '')}>›</span>
    </div>
  );
}

// --- adviser detail panel (right pane) --------------------------------------

function AdviserDetailPanel({ adv }) {
  if (!adv) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-slate-400 italic px-6 text-center">
        Select a firm on the left to see contacts, principals, and links.
      </div>
    );
  }

  const owners = (adv.owner_full_legal_name || '').split(';').map(s => s.trim()).filter(Boolean);
  const titles = (adv.owner_title_or_status || '').split(';').map(s => s.trim()).filter(Boolean);
  const principals = owners.map((name, i) => ({ name, title: titles[i] || '' }));

  const hasContact = adv.phone || adv.website || adv.cco_name || adv.signatory_name;
  const hasWeb = adv.linkedin_company_url || adv.team_members || adv.twitter_handle || adv.alt_contact_email;
  const showRegContact =
    adv.regulatory_contact_email && adv.regulatory_contact_email !== adv.cco_email;

  return (
    <div className="bg-white">
      {/* Sticky header with name, CRD, action buttons */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-lg font-semibold text-slate-900 tracking-tight leading-tight truncate">
            {adv.name || '(unidentified)'}
          </h2>
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">CRD {adv.crd}</div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {adv.website && (
            <a
              href={normalizeHref(adv.website)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white transition-all"
            >
              Website ↗
            </a>
          )}
          {adv.crd && (
            <a
              href={`https://adviserinfo.sec.gov/firm/summary/${adv.crd}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white transition-all"
            >
              IAPD ↗
            </a>
          )}
          {adv.form_adv_url && (
            <a
              href={adv.form_adv_url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white transition-all"
            >
              Form ADV ↗
            </a>
          )}
          {adv.linkedin_company_url && (
            <a
              href={adv.linkedin_company_url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white transition-all"
            >
              LinkedIn ↗
            </a>
          )}
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Headline stats */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Total AUM</div>
            <div className="font-mono text-[15px] font-semibold text-slate-900 tabular-nums mt-0.5">{fmtUsdShort(adv.total_aum)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Held $</div>
            <div className="font-mono text-[15px] font-semibold text-slate-900 tabular-nums mt-0.5">{fmtUsdShort(adv.total_value_usd)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Evidence</div>
            <div className="font-mono text-[15px] font-semibold text-slate-900 tabular-nums mt-0.5">{fmtInt(adv.evidence_count)}</div>
          </div>
        </div>

        {/* Contact */}
        {hasContact && (
          <div className="border-t border-slate-100 pt-4">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Contact</div>
            <div className="space-y-1.5 text-sm">
              {adv.phone && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Phone</span>
                  <span className="font-mono text-[12px] text-slate-700">{adv.phone}</span>
                </div>
              )}
              {adv.website && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Website</span>
                  <a
                    href={normalizeHref(adv.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[12px] text-slate-700 hover:text-slate-900 underline break-all"
                  >
                    {adv.website}
                  </a>
                </div>
              )}
              {adv.cco_name && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">CCO</span>
                  <div className="min-w-0">
                    <span className="text-slate-900">{adv.cco_name}</span>
                    {adv.cco_email && (
                      <a
                        href={`mailto:${adv.cco_email}`}
                        className="ml-2 text-[12px] font-mono text-slate-600 hover:text-slate-900 break-all"
                      >
                        {adv.cco_email}
                      </a>
                    )}
                  </div>
                </div>
              )}
              {adv.signatory_name && adv.signatory_name !== adv.cco_name && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Signatory</span>
                  <div className="min-w-0">
                    <span className="text-slate-900">{adv.signatory_name}</span>
                    {adv.signatory_title && (
                      <span className="text-[11px] text-slate-500 ml-1.5">({adv.signatory_title})</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Principals / Owners */}
        {principals.length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
              Principals / Owners
              {adv.ownership_amount && (
                <span className="ml-1.5 text-slate-400 normal-case tracking-normal font-normal">({adv.ownership_amount})</span>
              )}
            </div>
            <ul className="text-sm space-y-1">
              {principals.map((p, i) => (
                <li key={i} className="text-slate-700">
                  <span className="font-medium text-slate-900">{p.name}</span>
                  {p.title && <span className="text-[11px] text-slate-500 ml-2">{p.title}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Web-enriched */}
        {hasWeb && (
          <div className="border-t border-slate-100 pt-4">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Web-enriched</div>
            <div className="space-y-1.5 text-sm">
              {adv.linkedin_company_url && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">LinkedIn</span>
                  <a
                    href={adv.linkedin_company_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[12px] text-slate-700 hover:text-slate-900 underline break-all"
                  >
                    {adv.linkedin_company_url.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              )}
              {adv.twitter_handle && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Twitter</span>
                  <a
                    href={`https://twitter.com/${adv.twitter_handle.replace(/^@/, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[12px] text-slate-700 hover:text-slate-900 underline"
                  >
                    @{adv.twitter_handle.replace(/^@/, '')}
                  </a>
                </div>
              )}
              {adv.alt_contact_email && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Email</span>
                  <a
                    href={`mailto:${adv.alt_contact_email}`}
                    className="font-mono text-[12px] text-slate-700 hover:text-slate-900 break-all"
                  >
                    {adv.alt_contact_email}
                  </a>
                </div>
              )}
              {adv.team_members && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Team</span>
                  <span className="text-slate-700">{adv.team_members}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Regulatory contact */}
        {showRegContact && (
          <div className="border-t border-slate-100 pt-4">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Regulatory contact</div>
            <div className="text-sm flex gap-2">
              {adv.regulatory_contact_name && (
                <span className="text-slate-900">{adv.regulatory_contact_name}</span>
              )}
              <a
                href={`mailto:${adv.regulatory_contact_email}`}
                className="font-mono text-[12px] text-slate-700 hover:text-slate-900 underline break-all"
              >
                {adv.regulatory_contact_email}
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- adviser list+detail wrapper --------------------------------------------

function AdviserListDetail({ advisers }) {
  // Identified advisers only — null-CRD rows live in the source tables below
  const identified = useMemoI(
    () => (advisers || []).filter(a => a.crd && a.crd !== 'null'),
    [advisers]
  );
  const [selectedCrd, setSelectedCrd] = useStateI(identified[0] ? identified[0].crd : null);

  // If the data refreshes (audit toggle, slug change), re-seed selection
  useEffectI(() => {
    if (identified.length === 0) {
      setSelectedCrd(null);
      return;
    }
    if (!identified.some(a => a.crd === selectedCrd)) {
      setSelectedCrd(identified[0].crd);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advisers]);

  if (identified.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No adviser firms identified for this company's eligible holdings.
      </p>
    );
  }

  const selected = identified.find(a => a.crd === selectedCrd) || null;

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 items-stretch">
      {/* LEFT: list */}
      <div className="lg:w-3/5 w-full rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="divide-y divide-slate-100 max-h-[640px] overflow-y-auto">
          {identified.map((adv) => (
            <AdviserListRow
              key={adv.crd}
              adv={adv}
              selected={adv.crd === selectedCrd}
              onClick={() => setSelectedCrd(adv.crd)}
            />
          ))}
        </div>
      </div>

      {/* RIGHT: detail */}
      <div className="lg:w-2/5 w-full rounded-lg border border-slate-200 bg-white overflow-hidden lg:max-h-[640px] lg:overflow-y-auto">
        <AdviserDetailPanel adv={selected} />
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

      {/* Advisers — primary section (two-pane list + detail) */}
      <section className="mb-10">
        <h2 className="font-serif text-2xl font-semibold text-slate-900 mb-4">Adviser firms</h2>
        <AdviserListDetail advisers={advisers} />
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
