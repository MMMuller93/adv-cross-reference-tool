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

/**
 * Render a person's name with an inline LinkedIn icon link when we've
 * enriched it. `personEnrichment` is the per-firm map returned by the
 * API ({ normalizedName: { linkedin_url, inferred_title, confidence } }).
 *
 * Returns React fragments inline (not a separate component) so it can be
 * dropped into existing layouts without re-wrapping.
 */
const renderPersonWithLinkedIn = (name, personEnrichment) => {
  if (!name) return null;
  const enr = personEnrichment && personEnrichment[name];
  if (!enr || !enr.linkedin_url) return name;
  return (
    <>
      {name}
      <a href={enr.linkedin_url} target="_blank" rel="noopener noreferrer"
         className="ml-1 text-[10px] text-blue-700 hover:text-blue-900"
         title={enr.inferred_title ? `${enr.inferred_title} (LinkedIn)` : 'LinkedIn'}>
        in↗
      </a>
    </>
  );
};

/**
 * Build an EDGAR archive index URL for a specific filing.
 *   cik       e.g. '0000044201' or '44201'
 *   accession e.g. '0001193125-26-182055'
 * Returns: https://www.sec.gov/Archives/edgar/data/44201/000119312526182055/
 */
const edgarFilingUrl = (cik, accession) => {
  if (!cik || !accession) return null;
  const cikInt = String(cik).replace(/^0+/, '') || '0';
  const accNoDashes = String(accession).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/`;
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

function AdviserDetailPanel({ adv, holdings, companyName }) {
  if (!adv) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-slate-400 italic px-6 text-center">
        Select a firm on the left to see contacts, principals, and links.
      </div>
    );
  }

  // Backend pre-normalizes owners (LAST, FIRST, NMN -> 'First Last') and
  // returns them as adv.owners array. Fall back to legacy split for older
  // payloads.
  const owners = Array.isArray(adv.owners) && adv.owners.length
    ? adv.owners
    : (adv.owner_full_legal_name || '').split(';').map(s => s.trim()).filter(Boolean);
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
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">
            CRD {adv.crd}
            {adv.crd && (
              <a href={`/intel/adviser/${encodeURIComponent(adv.crd)}`}
                 className="ml-2 text-slate-600 hover:text-slate-900 hover:underline normal-case font-sans">
                View full profile →
              </a>
            )}
          </div>
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
                    <span className="text-slate-900">{renderPersonWithLinkedIn(adv.cco_name, adv.person_enrichment)}</span>
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
                    <span className="text-slate-900">{renderPersonWithLinkedIn(adv.signatory_name, adv.person_enrichment)}</span>
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
                  <span className="font-medium text-slate-900">{renderPersonWithLinkedIn(p.name, adv.person_enrichment)}</span>
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
              {adv.team_members && Array.isArray(adv.team_members) && adv.team_members.length > 0 && (
                <div className="border-t border-slate-100 pt-3 mt-3">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                    Team ({adv.team_members.length})
                  </div>
                  <ul className="space-y-1.5">
                    {adv.team_members.map((m, i) => (
                      <li key={i} className="text-[12px] flex items-baseline gap-2 flex-wrap">
                        <span className="text-slate-900 font-medium">{m.name}</span>
                        {m.title && <span className="text-[10px] text-slate-500">{m.title}</span>}
                        {m.linkedin && (
                          <a href={m.linkedin} target="_blank" rel="noopener noreferrer"
                             className="text-[10px] text-blue-700 hover:text-blue-900 font-medium"
                             title="LinkedIn">in↗</a>
                        )}
                        {m.email && (
                          <a href={`mailto:${m.email}`}
                             className="font-mono text-[10px] text-slate-600 hover:text-slate-900 break-all">
                            {m.email}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* Legacy stringified team_members fallback for older API payloads */}
              {(!Array.isArray(adv.team_members) && adv.team_members_text) && (
                <div className="flex gap-2">
                  <span className="text-slate-500 w-20 shrink-0">Team</span>
                  <span className="text-slate-700">{adv.team_members_text}</span>
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

        {/* Holdings in this company — N-PORT + Form D, sorted by value desc */}
        {holdings && ((holdings.nport && holdings.nport.length) || (holdings.formd && holdings.formd.length)) && (
          <div className="border-t border-slate-100 pt-4">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
              Holdings{companyName ? ` in ${companyName}` : ''}
              <span className="ml-1 text-slate-400 font-normal">
                ({fmtInt((holdings.nport || []).length + (holdings.formd || []).length)})
              </span>
            </div>
            <div className="space-y-1.5 text-sm">
              {[...(holdings.nport || []).map(h => ({ ...h, _kind: 'nport', _label: h.issuer_title, _date: h.evidence_date, _cik: h.registrant_cik })),
                ...(holdings.formd || []).map(h => ({ ...h, _kind: 'formd', _label: h.filer_entityname, _date: h.filing_date, _cik: h.filer_cik }))]
                .sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0))
                .map((h, i) => {
                  const url = edgarFilingUrl(h._cik, h.accession_number);
                  return (
                    <div key={i} className="flex gap-2 items-baseline">
                      <span className={
                        'text-[9px] uppercase tracking-widest font-semibold w-12 shrink-0 ' +
                        (h._kind === 'nport' ? 'text-slate-500' : 'text-amber-700')
                      }>
                        {h._kind === 'nport' ? 'N-PORT' : 'Form D'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] text-slate-700 truncate" title={h._label}>{h._label}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {fmtDate(h._date)}
                          {url && (
                            <a href={url} target="_blank" rel="noopener noreferrer"
                               className="ml-1.5 text-slate-500 hover:text-slate-900"
                               title={`EDGAR filing ${h.accession_number}`}>
                              ↗
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-[12px] font-semibold text-slate-900 tabular-nums">
                          {fmtUsdShort(h.value_usd)}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- adviser list+detail wrapper --------------------------------------------

function AdviserListDetail({ advisers, nportHolders, formdHolders, companyName }) {
  // Identified advisers only — null-CRD rows live in the source tables below
  const identified = useMemoI(
    () => (advisers || []).filter(a => a.crd && a.crd !== 'null'),
    [advisers]
  );
  const [selectedCrd, setSelectedCrd] = useStateI(identified[0] ? identified[0].crd : null);

  // Per-CRD holdings — index once, look up per selection.
  const holdingsByCrd = useMemoI(() => {
    const map = {};
    for (const r of (nportHolders || [])) {
      const key = String(r.adviser_crd || '');
      if (!key) continue;
      if (!map[key]) map[key] = { nport: [], formd: [] };
      map[key].nport.push(r);
    }
    for (const r of (formdHolders || [])) {
      const key = String(r.adviser_crd || '');
      if (!key) continue;
      if (!map[key]) map[key] = { nport: [], formd: [] };
      map[key].formd.push(r);
    }
    return map;
  }, [nportHolders, formdHolders]);

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
        <AdviserDetailPanel
          adv={selected}
          holdings={selected ? (holdingsByCrd[String(selected.crd)] || { nport: [], formd: [] }) : null}
          companyName={companyName}
        />
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

/**
 * Generic paginated/sortable/filterable table with optional CSV download.
 *
 * columns: [{
 *   key: stable identifier (string)
 *   label: header text
 *   align: 'left' | 'right' (default 'left')
 *   accessor: row -> raw sortable value (used for sort + filter + default render)
 *   render: row -> ReactNode (display; falls back to accessor's value)
 *   cellClassName: tailwind className for the <td>
 *   sortable: false to disable sorting on this column (default true)
 * }]
 *
 * defaultSort: { key, direction: 'asc' | 'desc' } applied on mount
 * csvUrl: when present, renders a Download CSV button that opens the URL
 */
function PaginatedTable({ rows, columns, csvUrl, emptyText, defaultSort, pageSize = 50 }) {
  const [filter, setFilter] = React.useState('');
  const [sort, setSort] = React.useState(defaultSort || null);
  const [page, setPage] = React.useState(0);

  if (!rows || !rows.length) {
    return <p className="text-sm text-slate-500">{emptyText || 'No rows.'}</p>;
  }

  const colAccessor = (col, row) => {
    if (col.accessor) return col.accessor(row);
    return row[col.key];
  };

  // Filter (case-insensitive substring across ALL columns' raw values)
  const q = filter.trim().toLowerCase();
  const filtered = !q ? rows : rows.filter(r =>
    columns.some(c => {
      const v = colAccessor(c, r);
      return v != null && String(v).toLowerCase().includes(q);
    })
  );

  // Sort (numeric vs string aware; nulls sort last)
  const sorted = !sort ? filtered : filtered.slice().sort((a, b) => {
    const col = columns.find(c => c.key === sort.key);
    if (!col) return 0;
    const av = colAccessor(col, a);
    const bv = colAccessor(col, b);
    let cmp;
    if (av == null && bv == null) cmp = 0;
    else if (av == null) cmp = 1;
    else if (bv == null) cmp = -1;
    else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sort.direction === 'desc' ? -cmp : cmp;
  });

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const toggleSort = (key) => {
    setPage(0);
    setSort(s => {
      if (!s || s.key !== key) return { key, direction: 'desc' };
      if (s.direction === 'desc') return { key, direction: 'asc' };
      return null; // tri-state: desc -> asc -> none
    });
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-3 py-2">
        <input
          type="text"
          value={filter}
          onChange={e => { setFilter(e.target.value); setPage(0); }}
          placeholder="Filter…"
          className="w-64 rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:border-slate-400"
        />
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            {fmtInt(total)} {total === 1 ? 'row' : 'rows'}
            {q ? ` (filtered from ${fmtInt(rows.length)})` : ''}
          </span>
          {csvUrl && (
            <a
              href={csvUrl}
              className="rounded border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
              download
            >
              Download CSV
            </a>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 tracking-wide">
            <tr>
              {columns.map(c => {
                const sortable = c.sortable !== false;
                const isSorted = sort && sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    onClick={sortable ? () => toggleSort(c.key) : undefined}
                    className={
                      `px-3 py-2 font-semibold ${c.align === 'right' ? 'text-right' : 'text-left'} ` +
                      (sortable ? 'cursor-pointer select-none hover:text-slate-700' : '')
                    }
                  >
                    {c.label}
                    {isSorted && (
                      <span className="ml-1 text-slate-400">
                        {sort.direction === 'desc' ? '↓' : '↑'}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                {columns.map(c => {
                  const content = c.render ? c.render(r) : colAccessor(c, r);
                  return (
                    <td key={c.key} className={`px-3 py-2 ${c.cellClassName || ''}`}>
                      {content == null || content === '' ? <span className="text-slate-300">—</span> : content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <span>
            Showing {fmtInt(safePage * pageSize + 1)}–
            {fmtInt(Math.min((safePage + 1) * pageSize, total))} of {fmtInt(total)}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(0)}
              disabled={safePage === 0}
              className="rounded border border-slate-200 bg-white px-2 py-1 disabled:opacity-40 hover:bg-slate-100"
              aria-label="First page"
            >
              ‹‹
            </button>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="rounded border border-slate-200 bg-white px-2 py-1 disabled:opacity-40 hover:bg-slate-100"
              aria-label="Previous page"
            >
              ‹
            </button>
            <span className="px-2">Page {safePage + 1} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={safePage === totalPages - 1}
              className="rounded border border-slate-200 bg-white px-2 py-1 disabled:opacity-40 hover:bg-slate-100"
              aria-label="Next page"
            >
              ›
            </button>
            <button
              onClick={() => setPage(totalPages - 1)}
              disabled={safePage === totalPages - 1}
              className="rounded border border-slate-200 bg-white px-2 py-1 disabled:opacity-40 hover:bg-slate-100"
              aria-label="Last page"
            >
              ››
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NportTable({ rows, slug, audit }) {
  const columns = [
    {
      key: 'issuer_title',
      label: 'Holding',
      accessor: r => r.issuer_title,
      cellClassName: 'font-mono text-xs text-slate-700',
    },
    {
      key: 'adviser_name',
      label: 'Manager',
      accessor: r => r.adviser_name,
      cellClassName: 'text-slate-900',
      render: r => r.adviser_name && r.adviser_crd
        ? <a href={`/intel/adviser/${encodeURIComponent(r.adviser_crd)}`} className="text-slate-900 hover:text-slate-700 hover:underline">{r.adviser_name}</a>
        : (r.adviser_name || <span className="text-slate-400 italic">unidentified</span>),
    },
    {
      key: 'value_usd',
      label: 'Value',
      align: 'right',
      accessor: r => r.value_usd || 0,
      cellClassName: 'text-right font-mono',
      render: r => fmtUsdShort(r.value_usd),
    },
    {
      key: 'evidence_date',
      label: 'As-of',
      accessor: r => r.evidence_date,
      cellClassName: 'text-xs text-slate-500',
      render: r => fmtDate(r.evidence_date),
    },
    {
      key: 'status_at_evidence_date',
      label: 'Status',
      accessor: r => r.status_at_evidence_date,
      cellClassName: 'text-xs',
      render: r => (
        <span className={r.status_at_evidence_date === 'private' ? 'text-slate-600' : 'text-amber-700'}>
          {fmtStatus(r.status_at_evidence_date)}
        </span>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      sortable: false,
      accessor: r => r.accession_number || '',
      cellClassName: 'text-xs',
      render: r => {
        const url = edgarFilingUrl(r.registrant_cik, r.accession_number);
        if (!url) return null;
        return (
          <a href={url} target="_blank" rel="noopener noreferrer"
             className="text-slate-500 hover:text-slate-900"
             title={`EDGAR filing ${r.accession_number}`}>
            EDGAR ↗
          </a>
        );
      },
    },
  ];
  const csvUrl = slug
    ? `/api/intel/companies/${encodeURIComponent(slug)}/holders/nport.csv${audit ? '?audit=1' : ''}`
    : null;
  return (
    <PaginatedTable
      rows={rows}
      columns={columns}
      csvUrl={csvUrl}
      defaultSort={{ key: 'value_usd', direction: 'desc' }}
      emptyText="No private-era N-PORT holdings."
    />
  );
}

function FormDTable({ rows, slug, audit }) {
  const columns = [
    {
      key: 'filer_entityname',
      label: 'Filer',
      accessor: r => r.filer_entityname,
      cellClassName: 'text-xs text-slate-700',
    },
    {
      key: 'adviser_name',
      label: 'Adviser',
      accessor: r => r.adviser_name,
      cellClassName: 'text-slate-900',
      render: r => r.adviser_name && r.adviser_crd
        ? <a href={`/intel/adviser/${encodeURIComponent(r.adviser_crd)}`} className="text-slate-900 hover:text-slate-700 hover:underline">{r.adviser_name}</a>
        : (r.adviser_name || <span className="text-slate-400 italic">unbridged</span>),
    },
    {
      key: 'value_usd',
      label: 'Offering',
      align: 'right',
      accessor: r => r.value_usd || 0,
      cellClassName: 'text-right font-mono',
      render: r => fmtUsdShort(r.value_usd),
    },
    {
      key: 'filing_date',
      label: 'Filed',
      accessor: r => r.filing_date,
      cellClassName: 'text-xs text-slate-500',
      render: r => fmtDate(r.filing_date),
    },
    {
      key: 'adviser_method',
      label: 'Method',
      accessor: r => r.adviser_method,
      cellClassName: 'text-xs text-slate-500',
    },
    {
      key: 'source',
      label: 'Source',
      sortable: false,
      accessor: r => r.accession_number || '',
      cellClassName: 'text-xs',
      render: r => {
        const url = edgarFilingUrl(r.filer_cik, r.accession_number);
        if (!url) return null;
        return (
          <a href={url} target="_blank" rel="noopener noreferrer"
             className="text-slate-500 hover:text-slate-900"
             title={`EDGAR filing ${r.accession_number}`}>
            EDGAR ↗
          </a>
        );
      },
    },
  ];
  const csvUrl = slug
    ? `/api/intel/companies/${encodeURIComponent(slug)}/holders/formd.csv${audit ? '?audit=1' : ''}`
    : null;
  return (
    <PaginatedTable
      rows={rows}
      columns={columns}
      csvUrl={csvUrl}
      defaultSort={{ key: 'value_usd', direction: 'desc' }}
      emptyText="No private-era Form D pooled-vehicle filings."
    />
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
      {/* Top bar with global search */}
      <div className="flex justify-end mb-4">
        <GlobalSearchBar />
      </div>

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
        <AdviserListDetail
          advisers={advisers}
          nportHolders={nport_holders}
          formdHolders={formd_holders}
          companyName={company.display_name}
        />
      </section>

      {/* N-PORT holdings */}
      <CollapsibleSection title="N-PORT registered-fund holdings" count={nport_holders.length}>
        <NportTable rows={nport_holders} slug={company.slug} audit={summary.audit_mode} />
      </CollapsibleSection>

      {/* Form D pooled vehicles */}
      <CollapsibleSection title="Form D pooled vehicles" count={formd_holders.length}>
        <FormDTable rows={formd_holders} slug={company.slug} audit={summary.audit_mode} />
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

// --- adviser-centric page (all funds held by adviser across all companies) ---

function AdviserPage({ crd }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [audit, setAudit] = React.useState(false);

  React.useEffect(() => {
    setData(null);
    setError(null);
    const url = `/api/intel/advisers/${encodeURIComponent(crd)}${audit ? '?audit=1' : ''}`;
    fetch(url)
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)))
      .then(setData)
      .catch(e => setError(e && e.error ? e.error : 'Failed to load'));
  }, [crd, audit]);

  if (error) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <a href="/" className="text-sm text-slate-500 hover:text-slate-900">← Back</a>
        <h1 className="font-serif text-2xl font-semibold text-slate-900 mt-4">CRD {crd}</h1>
        <p className="mt-3 text-sm text-red-700">{error}</p>
      </div>
    );
  }
  if (!data) {
    return <div className="max-w-5xl mx-auto px-6 py-10 text-sm text-slate-400">Loading…</div>;
  }

  const { adviser, summary, companies } = data;

  const companyColumns = [
    {
      key: 'display_name',
      label: 'Company',
      accessor: r => r.display_name,
      render: r => (
        <a
          href={`/intel/${encodeURIComponent(r.slug)}`}
          className="font-serif italic font-semibold text-slate-900 hover:text-slate-700"
        >
          {r.display_name}
        </a>
      ),
    },
    {
      key: 'sector',
      label: 'Sector',
      accessor: r => r.sector,
      cellClassName: 'text-xs text-slate-500',
    },
    {
      key: 'lifecycle_status',
      label: 'Status',
      accessor: r => r.lifecycle_status,
      cellClassName: 'text-xs',
      render: r => (
        <span className={r.lifecycle_status === 'private' ? 'text-slate-600' : 'text-amber-700'}>
          {fmtStatus(r.lifecycle_status)}
        </span>
      ),
    },
    {
      key: 'evidence_count',
      label: 'Funds',
      align: 'right',
      accessor: r => r.evidence_count,
      cellClassName: 'text-right font-mono text-slate-700 tabular-nums',
      render: r => fmtInt(r.nport_holdings.length + r.formd_holdings.length),
    },
    {
      key: 'total_value_usd',
      label: 'Total held',
      align: 'right',
      accessor: r => r.total_value_usd,
      cellClassName: 'text-right font-mono font-semibold text-slate-900 tabular-nums',
      render: r => fmtUsdShort(r.total_value_usd),
    },
  ];

  const hasContact = adviser.phone || adviser.website || adviser.cco_name || adviser.signatory_name;

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <a href="/" className="text-sm text-slate-500 hover:text-slate-900">← Back</a>

      {/* Top bar with search */}
      <div className="flex justify-end mt-2 mb-2">
        <GlobalSearchBar />
      </div>

      {/* Header */}
      <div className="mt-1 mb-6">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-slate-900">
          {adviser.name || '(unidentified firm)'}
        </h1>
        <div className="text-xs font-mono text-slate-500 mt-1">CRD {adviser.crd}</div>
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          {adviser.website && (
            <a href={normalizeHref(adviser.website)} target="_blank" rel="noopener noreferrer"
               className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
              Website ↗
            </a>
          )}
          <a href={`https://adviserinfo.sec.gov/firm/summary/${adviser.crd}`} target="_blank" rel="noopener noreferrer"
             className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
            IAPD ↗
          </a>
          {adviser.form_adv_url && (
            <a href={adviser.form_adv_url} target="_blank" rel="noopener noreferrer"
               className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
              Form ADV ↗
            </a>
          )}
          {adviser.linkedin_company_url && (
            <a href={adviser.linkedin_company_url} target="_blank" rel="noopener noreferrer"
               className="px-2.5 py-1 border border-slate-200 rounded text-[10px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
              LinkedIn ↗
            </a>
          )}
        </div>
      </div>

      {/* Headline stats */}
      <div className="nport-metric-strip mb-6">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Total AUM</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtUsdShort(adviser.total_aum)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Tracked companies</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtInt(summary.distinct_companies)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Evidence rows</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtInt(summary.total_evidence_count)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Total held</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtUsdShort(summary.total_value_usd)}</div>
        </div>
      </div>

      {/* Audit mode toggle */}
      <div className="flex justify-end mb-3">
        <label className="text-xs text-slate-500 flex items-center gap-2">
          <input type="checkbox" checked={audit} onChange={e => setAudit(e.target.checked)} />
          Show audit mode (include public-era rows)
        </label>
      </div>

      {/* Contact + Principals */}
      {(hasContact || (adviser.owners && adviser.owners.length)) && (
        <section className="nport-panel mb-6">
          <div className="nport-panel-header">
            <h2 className="font-serif text-lg font-semibold text-slate-900">Firm details</h2>
          </div>
          <div className="px-5 py-4 grid md:grid-cols-2 gap-5 text-sm">
            {hasContact && (
              <div>
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Contact</div>
                <div className="space-y-1.5">
                  {adviser.phone && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Phone</span><span className="font-mono text-[12px] text-slate-700">{adviser.phone}</span></div>
                  )}
                  {adviser.website && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Website</span>
                      <a href={normalizeHref(adviser.website)} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] text-slate-700 hover:text-slate-900 underline break-all">{adviser.website}</a>
                    </div>
                  )}
                  {adviser.cco_name && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">CCO</span>
                      <div className="min-w-0">
                        <span className="text-slate-900">{adviser.cco_name}</span>
                        {adviser.cco_email && <a href={`mailto:${adviser.cco_email}`} className="ml-2 text-[12px] font-mono text-slate-600 hover:text-slate-900 break-all">{adviser.cco_email}</a>}
                      </div>
                    </div>
                  )}
                  {adviser.signatory_name && adviser.signatory_name !== adviser.cco_name && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Signatory</span>
                      <div className="min-w-0">
                        <span className="text-slate-900">{adviser.signatory_name}</span>
                        {adviser.signatory_title && <span className="text-[11px] text-slate-500 ml-1.5">({adviser.signatory_title})</span>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {adviser.owners && adviser.owners.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Principals / Owners</div>
                <ul className="space-y-1">
                  {adviser.owners.map((name, i) => (
                    <li key={i} className="text-sm text-slate-900">
                      {renderPersonWithLinkedIn(name, adviser.person_enrichment)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Companies held */}
      <section className="nport-panel">
        <div className="nport-panel-header flex items-center justify-between">
          <h2 className="font-serif text-lg font-semibold text-slate-900">
            Companies held <span className="text-slate-400 text-sm font-normal ml-1">({fmtInt(companies.length)})</span>
          </h2>
        </div>
        <div className="p-3">
          <PaginatedTable
            rows={companies}
            columns={companyColumns}
            defaultSort={{ key: 'total_value_usd', direction: 'desc' }}
            emptyText="No private-era holdings recorded for this adviser."
          />
        </div>
      </section>

      <footer className="mt-12 pt-6 border-t border-slate-200 text-xs text-slate-500">
        Fund Holders Intel V1.1 • Adviser drill-down • Click a company name to see all its holders.
      </footer>
    </div>
  );
}

// --- global search ----------------------------------------------------------

function GlobalSearchBar({ initialQuery = '' }) {
  const [q, setQ] = React.useState(initialQuery);
  const submit = (e) => {
    if (e) e.preventDefault();
    const term = q.trim();
    if (term.length < 2) return;
    window.location.href = `/intel/search?q=${encodeURIComponent(term)}`;
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <input
        type="search"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search companies, advisers, funds, filings…"
        className="w-72 rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:border-slate-500"
      />
      <button type="submit" className="rounded border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50">
        Search
      </button>
    </form>
  );
}

function SearchPage({ initialQuery }) {
  const [q, setQ] = React.useState(initialQuery || '');
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!initialQuery || initialQuery.length < 2) return;
    runSearch(initialQuery);
    // eslint-disable-next-line
  }, []);

  function runSearch(term) {
    setLoading(true);
    setError(null);
    fetch(`/api/intel/search?q=${encodeURIComponent(term)}&limit=25`)
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)))
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e && e.error ? e.error : 'Search failed'); setLoading(false); });
  }

  function handleSubmit(e) {
    e.preventDefault();
    const term = q.trim();
    if (term.length < 2) return;
    const url = new URL(window.location.href);
    url.searchParams.set('q', term);
    window.history.pushState({}, '', url.toString());
    runSearch(term);
  }

  const typeLabels = {
    company: 'Company',
    adviser: 'Adviser',
    adv_fund: 'ADV fund',
    formd_filing: 'Form D',
  };
  const typeColors = {
    company: 'bg-slate-800 text-white',
    adviser: 'bg-slate-200 text-slate-800',
    adv_fund: 'bg-blue-100 text-blue-800',
    formd_filing: 'bg-amber-100 text-amber-900',
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-6">
      <a href="/" className="text-sm text-slate-500 hover:text-slate-900">← Back</a>

      <h1 className="font-serif text-3xl font-semibold tracking-tight text-slate-900 mt-3 mb-5">
        Search
      </h1>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 mb-6">
        <input
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          autoFocus
          placeholder="Search companies, advisers, funds, filings…"
          className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-slate-500"
        />
        <button type="submit" className="rounded border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          Search
        </button>
      </form>

      {loading && <p className="text-sm text-slate-500">Searching…</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}

      {data && (
        <>
          <div className="mb-4 text-xs text-slate-500">
            {data.total === 0
              ? `No results for "${data.query}"`
              : `${fmtInt(data.total)} ${data.total === 1 ? 'result' : 'results'} for "${data.query}"`}
            {data.by_source && (
              <span className="ml-2">
                · companies: {data.by_source.companies}
                · advisers: {data.by_source.advisers}
                · ADV funds: {data.by_source.adv_funds}
                · Form D: {data.by_source.formd_filings}
              </span>
            )}
          </div>
          <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
            {data.results.map((r, i) => {
              const inner = (
                <>
                  <span className={`inline-block text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded ${typeColors[r.type] || 'bg-slate-100 text-slate-700'}`}>
                    {typeLabels[r.type] || r.type}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{r.label}</div>
                    {r.sublabel && <div className="text-[11px] text-slate-500 truncate mt-0.5">{r.sublabel}</div>}
                  </div>
                  {r.url && (
                    <span className="text-slate-400 shrink-0 text-sm">›</span>
                  )}
                </>
              );
              const rowClass = 'flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors';
              if (r.url && r.external) {
                return (
                  <a key={i} href={r.url} target="_blank" rel="noopener noreferrer" className={rowClass}>
                    {inner}
                  </a>
                );
              } else if (r.url) {
                return (
                  <a key={i} href={r.url} className={rowClass}>
                    {inner}
                  </a>
                );
              } else {
                return (
                  <div key={i} className={rowClass + ' cursor-default'}>
                    {inner}
                  </div>
                );
              }
            })}
          </div>
        </>
      )}
    </div>
  );
}

// --- bootstrap --------------------------------------------------------------

window.mountIntelRouter = function () {
  const path = window.location.pathname;
  const searchMatch = path === '/intel/search';
  const adviserMatch = path.match(/^\/intel\/adviser\/([^\/]+)/);
  const companyMatch = path.match(/^\/intel\/([^\/]+)/);
  const root = document.getElementById('root');
  if (!root) return false;
  if (searchMatch) {
    const params = new URLSearchParams(window.location.search);
    const initialQuery = params.get('q') || '';
    ReactDOM.createRoot(root).render(<SearchPage initialQuery={initialQuery} />);
    return true;
  }
  if (adviserMatch) {
    const crd = decodeURIComponent(adviserMatch[1]);
    ReactDOM.createRoot(root).render(<AdviserPage crd={crd} />);
    return true;
  }
  if (companyMatch) {
    const slug = decodeURIComponent(companyMatch[1]);
    ReactDOM.createRoot(root).render(<IntelPage slug={slug} />);
    return true;
  }
  return false;
};
