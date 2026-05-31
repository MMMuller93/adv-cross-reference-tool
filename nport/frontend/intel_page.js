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

// --- watchlist (localStorage-backed) ----------------------------------------

const WATCHLIST_KEY = 'intel.watchlist.slugs';
const DEFAULT_WATCHLIST = ['anthropic', 'openai', 'spacex', 'figure-ai', 'databricks', 'stripe'];

function readWatchlist() {
  try {
    const raw = window.localStorage && window.localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return DEFAULT_WATCHLIST.slice();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr.filter(s => typeof s === 'string') : DEFAULT_WATCHLIST.slice();
  } catch (_) { return DEFAULT_WATCHLIST.slice(); }
}
function writeWatchlist(slugs) {
  try {
    const unique = Array.from(new Set(slugs.filter(Boolean)));
    window.localStorage && window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(unique));
    return unique;
  } catch (_) { return slugs; }
}
function useWatchlist() {
  const [list, setList] = useStateI(readWatchlist);
  useEffectI(() => {
    const onStorage = (e) => { if (e.key === WATCHLIST_KEY) setList(readWatchlist()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const toggle = React.useCallback((slug) => {
    setList(prev => {
      const next = prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug];
      return writeWatchlist(next);
    });
  }, []);
  const add = React.useCallback((slug) => {
    if (!slug) return;
    setList(prev => prev.includes(slug) ? prev : writeWatchlist([...prev, slug]));
  }, []);
  const remove = React.useCallback((slug) => {
    setList(prev => writeWatchlist(prev.filter(s => s !== slug)));
  }, []);
  return { list, toggle, add, remove, has: (s) => list.includes(s) };
}

// Pretty company slug for display in the rail when no live name is available.
const prettySlug = (slug) => String(slug || '')
  .replace(/[-_]/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());

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
// Inline external-link icon — replaces the prior `↗` text marker.
// Used everywhere we link out (EDGAR, SEC IAPD, LinkedIn, vendor pages).
const ExternalLinkIcon = ({ className = 'w-3 h-3 ml-0.5 inline-block opacity-60' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round"
       className={className} aria-hidden="true">
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

// Shared footer used across every intel page. No version stamps, no
// page-specific jargon — just the attribution. Keeps every page's
// chrome identical so the product feels coherent, not "internal V1".
const IntelFooter = () => (
  <footer className="mt-16 pt-6 border-t border-slate-200">
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 text-xs text-slate-500">
      <div>
        Sourced from SEC filings — N-PORT, Form D, and Form ADV via EDGAR.
      </div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
        Fund Holders Intel
      </div>
    </div>
  </footer>
);

const renderPersonWithLinkedIn = (name, personEnrichment) => {
  if (!name) return null;
  const enr = personEnrichment && personEnrichment[name];
  if (!enr || !enr.linkedin_url) return name;
  return (
    <>
      {name}
      <a href={enr.linkedin_url} target="_blank" rel="noopener noreferrer"
         className="ml-1 text-[11px] text-slate-500 hover:text-slate-900 align-baseline"
         title={enr.inferred_title ? `${enr.inferred_title} · LinkedIn` : 'LinkedIn profile'}>
        <ExternalLinkIcon />
      </a>
    </>
  );
};

/**
 * PersonContactButtons — contact-pill row for a single person.
 *
 * Renders LinkedIn / Email pills only when data is present. Returns null
 * if neither is present (no disabled-state UI — see UI_REDESIGN_PLAN
 * 2026-05-25 §4 Phase A.4: empty state was visual debt with zero info).
 * Email pill is shown ONLY when the email is structurally attributable
 * to this specific person (from enriched_managers.team_members[*].email
 * OR intel_person_enrichment.inferred_email). Firm-level CCO email is
 * NOT shown here unless the person IS the CCO.
 *
 * Props:
 *   linkedin: URL or null
 *   email:    address or null
 *   size:     'sm' (default) | 'md'
 */
const PersonContactButtons = ({ linkedin, email, size = 'sm' }) => {
  if (!linkedin && !email) return null;
  const pad = size === 'md' ? 'px-2.5 py-1' : 'px-2 py-0.5';
  const text = size === 'md' ? 'text-[11px]' : 'text-[10px]';
  const iconSize = size === 'md' ? 'w-3 h-3' : 'w-2.5 h-2.5';

  const activeCls = `inline-flex items-center gap-1 ${pad} bg-white border border-slate-200 rounded ${text} font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors`;

  return (
    <span className="inline-flex flex-wrap gap-1 items-center">
      {linkedin && (
        <a href={linkedin} target="_blank" rel="noopener noreferrer"
           className={activeCls} title="View on LinkedIn">
          <svg className={iconSize} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14M8.27 18.5V10H6.7v8.5h1.57m-.79-9.39c.5 0 .91-.41.91-.92 0-.5-.41-.91-.91-.91-.5 0-.91.41-.91.91 0 .51.41.92.91.92M18.5 18.5v-4.65c0-2.07-1.43-2.85-2.86-2.85a2.5 2.5 0 0 0-2.21 1.21V10h-1.5v8.5h1.5v-4.7c0-.97.79-1.76 1.76-1.76.97 0 1.81.79 1.81 1.76v4.7h1.5z"/>
          </svg>
          LinkedIn
        </a>
      )}
      {email && (
        <a href={`mailto:${email}`} className={activeCls} title={`Email ${email}`}>
          <svg className={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="5" width="18" height="14" rx="2"/>
            <path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7"/>
          </svg>
          Email
        </a>
      )}
    </span>
  );
};

/**
 * Resolve a person's contact info from the data shapes the API returns.
 * Single source of truth for what to show next to a person's name.
 *
 *   person: {name, title?, linkedin?, email?}    (from team_members)
 *           OR {name, title?}                    (from owners_detail)
 *           OR string                            (legacy)
 *   personEnrichmentMap: { [normalized_name]: {linkedin_url, inferred_email, ...} }
 *
 * Priority for linkedin: person.linkedin → enrichment[name].linkedin_url
 * Priority for email:    person.email     → enrichment[name].inferred_email
 *                        (no firm-level fallback — that would falsely
 *                         attribute the firm's generic email to this person)
 */
const resolvePersonContact = (person, personEnrichmentMap) => {
  if (!person) return { linkedin: null, email: null };
  const name = typeof person === 'string' ? person : (person.name || '');
  const enr = (personEnrichmentMap || {})[name] || {};
  return {
    linkedin: (typeof person === 'object' ? person.linkedin : null) || enr.linkedin_url || null,
    email: (typeof person === 'object' ? person.email : null) || enr.inferred_email || null,
  };
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

// --- manager card (lazy-fetched, shown in row expansion + anywhere we need rich info) --

// Module-level cache so re-opening rows doesn't re-fetch.
const _managerEnrichmentCache = new Map();

/**
 * ManagerCard — given a manager descriptor `{kind, crd, discoveredId}`, lazy-
 * fetches the full enrichment (website, contact, owners, team members) from
 * `/api/intel/advisers/<crd>` (when kind=crd) or `/api/intel/discovered/<id>`
 * (when kind=discovered) and renders a compact contact card.
 *
 * Cached by module-level Map so the second expand of the same row is instant
 * and we don't hammer the API. Returns null when no manager is known.
 */
function ManagerCard({ kind, crd, discoveredId, compact = false }) {
  const cacheKey = kind === 'crd' ? `crd:${crd}` : `disc:${discoveredId}`;
  const [data, setData] = useStateI(() => _managerEnrichmentCache.get(cacheKey) || null);
  const [loading, setLoading] = useStateI(false);
  const [error, setError] = useStateI(null);

  useEffectI(() => {
    if (data) return;
    if (!crd && !discoveredId) return;
    if (_managerEnrichmentCache.has(cacheKey)) {
      setData(_managerEnrichmentCache.get(cacheKey));
      return;
    }
    setLoading(true);
    const url = kind === 'crd'
      ? `/api/intel/advisers/${encodeURIComponent(crd)}`
      : `/api/intel/discovered/${encodeURIComponent(discoveredId)}`;
    fetch(url)
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)))
      .then(d => {
        _managerEnrichmentCache.set(cacheKey, d);
        setData(d);
        setLoading(false);
      })
      .catch(e => {
        setError(String(e && e.error ? e.error : e));
        setLoading(false);
      });
    // eslint-disable-next-line
  }, [cacheKey]);

  if (loading) return <div className="text-[11px] text-slate-400 italic">Loading manager details…</div>;
  if (error) return <div className="text-[11px] text-slate-400">Couldn't load: {error}</div>;
  if (!data) return null;

  // Normalize: discovered API returns {manager, summary, holders...};
  // adviser API returns {adviser, summary, companies, service_providers}.
  const m = kind === 'crd' ? data.adviser : data.manager;
  if (!m) return null;

  const website = m.primary_website || m.website || m.website_url || null;
  const linkedin = m.linkedin_company_url || null;
  const twitter = m.twitter_handle || null;
  const email = m.cco_email || m.alt_contact_email || m.primary_contact_email || null;
  const phone = m.phone || m.phone_number || null;
  const teamMembers = Array.isArray(m.team_members) ? m.team_members : [];
  const personEnrichment = m.person_enrichment || {};
  const ownersRaw = Array.isArray(m.owners_detail) && m.owners_detail.length
    ? m.owners_detail
    : (Array.isArray(m.owners) ? m.owners.map(o => typeof o === 'string' ? { name: o } : o) : []);
  const cco = m.cco_name;
  const signatory = m.signatory_name;
  const teamLimit = compact ? 5 : 10;
  const ownerLimit = compact ? 3 : 6;

  return (
    <div className="space-y-3">
      {/* Action chips */}
      <div className="flex flex-wrap gap-1">
        {website && (
          <a href={normalizeHref(website)} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 px-2 py-1 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
            Website
            <ExternalLinkIcon className="w-2.5 h-2.5 opacity-50" />
          </a>
        )}
        {linkedin && (
          <a href={linkedin} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 px-2 py-1 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
            LinkedIn
          </a>
        )}
        {twitter && (
          <a href={`https://twitter.com/${String(twitter).replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 px-2 py-1 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
            Twitter
          </a>
        )}
        {kind === 'crd' && m.crd && (
          <a href={`https://adviserinfo.sec.gov/firm/summary/${m.crd}`} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 px-2 py-1 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
            IAPD
          </a>
        )}
        {kind === 'crd' && m.form_adv_url && (
          <a href={m.form_adv_url} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 px-2 py-1 border border-slate-200 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-50 bg-white">
            Form ADV
          </a>
        )}
      </div>

      {/* Contact facts */}
      {(website || email || phone) && (
        <dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 text-[11px]">
          {website && (
            <React.Fragment>
              <dt className="text-slate-500">Web</dt>
              <dd className="font-mono text-slate-700 break-all">{String(website).replace(/^https?:\/\//, '')}</dd>
            </React.Fragment>
          )}
          {email && (
            <React.Fragment>
              <dt className="text-slate-500">Email</dt>
              <dd className="font-mono text-slate-700 break-all">
                <a href={`mailto:${email}`} className="hover:text-slate-900 underline underline-offset-2">{email}</a>
              </dd>
            </React.Fragment>
          )}
          {phone && (
            <React.Fragment>
              <dt className="text-slate-500">Phone</dt>
              <dd className="font-mono text-slate-700">{phone}</dd>
            </React.Fragment>
          )}
          {cco && (
            <React.Fragment>
              <dt className="text-slate-500">CCO</dt>
              <dd className="text-slate-900">
                {renderPersonWithLinkedIn(cco, personEnrichment)}
                {m.cco_email && (
                  <a href={`mailto:${m.cco_email}`} className="ml-2 font-mono text-[10px] text-slate-500 hover:text-slate-900 break-all">{m.cco_email}</a>
                )}
              </dd>
            </React.Fragment>
          )}
          {signatory && signatory !== cco && (
            <React.Fragment>
              <dt className="text-slate-500">Signatory</dt>
              <dd className="text-slate-900">
                {renderPersonWithLinkedIn(signatory, personEnrichment)}
                {m.signatory_title && <span className="ml-1 text-[10px] text-slate-500">({m.signatory_title})</span>}
              </dd>
            </React.Fragment>
          )}
        </dl>
      )}

      {/* Principals / Owners */}
      {ownersRaw.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
            Principals / Owners
            {ownersRaw.length > ownerLimit && <span className="ml-1.5 text-slate-400 normal-case tracking-normal font-normal">({ownerLimit} of {ownersRaw.length})</span>}
          </div>
          <ul className="text-[11px] space-y-1">
            {ownersRaw.slice(0, ownerLimit).map((o, i) => {
              const contact = resolvePersonContact(o, personEnrichment);
              return (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-slate-900">{o.name}</span>
                  {o.title && <span className="text-[10px] text-slate-500">{o.title}</span>}
                  <PersonContactButtons linkedin={contact.linkedin} email={contact.email} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Team members */}
      {teamMembers.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
            Team
            <span className="ml-1.5 text-slate-400 normal-case tracking-normal font-normal">
              ({teamMembers.length > teamLimit ? `${teamLimit} of ${teamMembers.length}` : teamMembers.length})
            </span>
          </div>
          <ul className="text-[11px] space-y-1">
            {teamMembers.slice(0, teamLimit).map((tm, i) => {
              const contact = resolvePersonContact(tm, personEnrichment);
              return (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-slate-900">{tm.name}</span>
                  {tm.title && <span className="text-[10px] text-slate-500">{tm.title}</span>}
                  <PersonContactButtons linkedin={contact.linkedin} email={contact.email} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Deep-link to the manager page */}
      <div>
        <a href={kind === 'crd' ? `/intel/adviser/${encodeURIComponent(crd)}` : `/intel/discovered/${encodeURIComponent(discoveredId)}`}
           className="text-[11px] text-slate-600 hover:text-slate-900 underline underline-offset-2">
          View full {kind === 'crd' ? 'adviser' : 'discovered manager'} page →
        </a>
      </div>
    </div>
  );
}

// --- adviser list row (left pane) -------------------------------------------

function AdviserListRow({ adv, selected, onClick }) {
  // No avatar — a column of 21 dark blocks reads like a Figma mockup.
  // Selection state is carried by the left border + bg only (PFR pattern).
  return (
    <div
      onClick={onClick}
      className={
        'flex items-baseline gap-4 px-4 py-3 cursor-pointer transition-colors border-l-2 ' +
        (selected
          ? 'bg-slate-50 border-slate-900'
          : 'bg-white border-transparent hover:bg-slate-50')
      }
    >
      {/* Name + CRD */}
      <div className="flex-1 min-w-0">
        <div className="font-serif text-[14px] font-semibold text-slate-900 tracking-tight truncate leading-snug">
          {adv.name || 'Unidentified adviser'}
        </div>
        <div className="text-[10px] font-mono text-slate-400 mt-0.5 uppercase tracking-wider">CRD {adv.crd}</div>
      </div>

      {/* AUM */}
      <div className="text-right shrink-0 hidden sm:block">
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">AUM</div>
        <div className="text-[12px] font-mono text-slate-700 tabular-nums mt-0.5">{fmtUsdShort(adv.total_aum)}</div>
      </div>

      {/* Total held */}
      <div className="text-right shrink-0 w-24">
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Held</div>
        <div className="text-[13px] font-mono font-semibold text-slate-900 tabular-nums tracking-tight mt-0.5">{fmtUsdShort(adv.total_value_usd)}</div>
      </div>
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
            {adv.name || 'Unidentified adviser'}
          </h2>
          <div className="text-[10px] font-mono text-slate-500 mt-1 uppercase tracking-wider">
            CRD {adv.crd}
            {adv.crd && (
              <a href={`/intel/adviser/${encodeURIComponent(adv.crd)}`}
                 className="ml-3 text-slate-600 hover:text-slate-900 hover:underline normal-case font-sans tracking-normal">
                View full profile →
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {adv.website && (
            <a href={normalizeHref(adv.website)} target="_blank" rel="noopener noreferrer" className="nport-button">
              Website
            </a>
          )}
          {adv.crd && (
            <a href={`https://adviserinfo.sec.gov/firm/summary/${adv.crd}`} target="_blank" rel="noopener noreferrer" className="nport-button">
              IAPD
            </a>
          )}
          {adv.form_adv_url && (
            <a href={adv.form_adv_url} target="_blank" rel="noopener noreferrer" className="nport-button">
              Form ADV
            </a>
          )}
          {adv.linkedin_company_url && (
            <a href={adv.linkedin_company_url} target="_blank" rel="noopener noreferrer" className="nport-button">
              LinkedIn
            </a>
          )}
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Headline stats */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Total AUM</div>
            <div className="font-mono text-[15px] font-semibold text-slate-900 tabular-nums tracking-tight mt-0.5">{fmtUsdShort(adv.total_aum)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Total held</div>
            <div className="font-mono text-[15px] font-semibold text-slate-900 tabular-nums tracking-tight mt-0.5">{fmtUsdShort(adv.total_value_usd)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">Filings</div>
            <div className="font-mono text-[15px] font-semibold text-slate-900 tabular-nums tracking-tight mt-0.5">{fmtInt(adv.evidence_count)}</div>
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
                  <ul className="space-y-2">
                    {adv.team_members.map((m, i) => {
                      const contact = resolvePersonContact(m, adv.person_enrichment);
                      return (
                        <li key={i} className="text-sm">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-slate-900 font-medium text-[12px]">{m.name}</span>
                            <PersonContactButtons linkedin={contact.linkedin} email={contact.email} />
                          </div>
                          {m.title && <div className="text-[10px] text-slate-500 mt-0.5">{m.title}</div>}
                        </li>
                      );
                    })}
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
                      <span className="text-[9px] uppercase tracking-widest font-semibold font-mono text-slate-500 w-12 shrink-0">
                        {h._kind === 'nport' ? 'N-PORT' : 'Form D'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] text-slate-700 truncate" title={h._label}>{h._label}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {fmtDate(h._date)}
                          {url && (
                            <a href={url} target="_blank" rel="noopener noreferrer"
                               className="ml-1.5 text-slate-400 hover:text-slate-900"
                               title={`EDGAR filing ${h.accession_number}`}>
                              <ExternalLinkIcon />
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
function PaginatedTable({ rows, columns, csvUrl, emptyText, defaultSort, pageSize = 50, expandableRender, rowKey, toolbarExtras }) {
  const [filter, setFilter] = React.useState('');
  const [sort, setSort] = React.useState(defaultSort || null);
  const [page, setPage] = React.useState(0);
  const [openKey, setOpenKey] = React.useState(null);

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
          {toolbarExtras}
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
              {expandableRender && <th className="w-8 px-2 py-2"></th>}
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
            {pageRows.map((r, i) => {
              const key = rowKey ? rowKey(r) : i;
              const isOpen = expandableRender && openKey === key;
              return (
                <React.Fragment key={key}>
                  <tr
                    className={`border-t border-slate-100 ${expandableRender ? 'cursor-pointer hover:bg-slate-50' : ''} ${isOpen ? 'bg-slate-50' : ''}`}
                    onClick={expandableRender ? (e) => {
                      // Don't toggle when clicking a link or button inside the row
                      const tag = (e.target.tagName || '').toLowerCase();
                      if (tag === 'a' || tag === 'button' || e.target.closest('a,button')) return;
                      setOpenKey(prev => prev === key ? null : key);
                    } : undefined}
                  >
                    {expandableRender && (
                      <td className="px-2 py-2 text-slate-400 select-none">
                        <span className="inline-block w-4 text-center">{isOpen ? '▾' : '▸'}</span>
                      </td>
                    )}
                    {columns.map(c => {
                      const content = c.render ? c.render(r) : colAccessor(c, r);
                      return (
                        <td key={c.key} className={`px-3 py-2 ${c.cellClassName || ''}`}>
                          {content == null || content === '' ? <span className="text-slate-300">—</span> : content}
                        </td>
                      );
                    })}
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50 border-t border-slate-100">
                      <td colSpan={columns.length + 1} className="px-6 py-4">
                        {expandableRender(r)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
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
      accessor: r => (r.manager && r.manager.name) || r.adviser_name,
      cellClassName: 'text-slate-900',
      render: r => {
        const mgr = r.manager;
        if (mgr && mgr.url && mgr.name) {
          return <a href={mgr.url} className="text-slate-900 hover:text-slate-700 hover:underline">{mgr.name}</a>;
        }
        if (mgr && mgr.name) return <span>{mgr.name}</span>;
        return r.adviser_name && r.adviser_crd
          ? <a href={`/intel/adviser/${encodeURIComponent(r.adviser_crd)}`} className="text-slate-900 hover:text-slate-700 hover:underline">{r.adviser_name}</a>
          : (r.adviser_name || <span className="text-slate-300">—</span>);
      },
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
            EDGAR
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
      emptyText="No mutual-fund holdings yet."
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
      render: r => r.accession_number
        ? <a href={`/intel/fund/${encodeURIComponent(r.accession_number)}`} className="text-slate-700 hover:text-slate-900 hover:underline">{r.filer_entityname}</a>
        : r.filer_entityname,
    },
    {
      key: 'adviser_name',
      label: 'Adviser',
      accessor: r => (r.manager && r.manager.name) || r.adviser_name,
      cellClassName: 'text-slate-900',
      render: r => {
        const mgr = r.manager;
        if (mgr && mgr.url && mgr.name) {
          return <a href={mgr.url} className="text-slate-900 hover:text-slate-700 hover:underline">{mgr.name}</a>;
        }
        if (mgr && mgr.name) return <span>{mgr.name}</span>;
        return r.adviser_name && r.adviser_crd
          ? <a href={`/intel/adviser/${encodeURIComponent(r.adviser_crd)}`} className="text-slate-900 hover:text-slate-700 hover:underline">{r.adviser_name}</a>
          : (r.adviser_name || <span className="text-slate-300">—</span>);
      },
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
            EDGAR
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
      emptyText="No SPV offerings yet."
    />
  );
}

// --- Unified Funds pane: N-PORT + Form D merged, source-filterable, expandable rows ---

/**
 * UnifiedFundsPane — single sortable/expandable table of both N-PORT
 * mutual-fund holdings + Form D SPV offerings.
 *
 * Props:
 *   nportHolders, formdHolders — row arrays from the API
 *   slug, audit                — passthrough for CSV download URL
 *   lockedSource               — optional 'nport' | 'formd'. When set,
 *                                the toolbar source toggle is hidden,
 *                                the Source column is dropped, and only
 *                                the chosen source's rows render. Used
 *                                by IntelPage's tabbed view to render
 *                                "Funds" or "SPVs" tabs as a single-
 *                                source filtered view.
 */
function UnifiedFundsPane({ nportHolders, formdHolders, slug, audit, lockedSource }) {
  const [showNport, setShowNport] = React.useState(lockedSource !== 'formd');
  const [showFormd, setShowFormd] = React.useState(lockedSource !== 'nport');

  // Normalize both shapes into a single row schema
  const nportRows = (nportHolders || []).map(r => ({
    _src: 'N-PORT',
    _key: `nport:${r.evidence_id || r.accession_number}:${r.series_id || ''}:${r.issuer_title}`,
    name: r.issuer_title,
    adviser_name: r.adviser_name,
    adviser_crd: r.adviser_crd,
    adviser_method: r.adviser_method,
    manager: r.manager || null,
    value_usd: r.value_usd,
    date: r.evidence_date,
    status: r.status_at_evidence_date,
    cik: r.registrant_cik,
    accession_number: r.accession_number,
    raw: r,
  }));
  const formdRows = (formdHolders || []).map(r => ({
    _src: 'Form D',
    _key: `formd:${r.evidence_id || r.accession_number}:${r.filer_entityname}`,
    name: r.filer_entityname,
    adviser_name: r.adviser_name,
    adviser_crd: r.adviser_crd,
    adviser_method: r.adviser_method,
    manager: r.manager || null,
    value_usd: r.value_usd,
    date: r.filing_date,
    status: null, // Form D doesn't carry a per-row status
    cik: r.filer_cik,
    accession_number: r.accession_number,
    raw: r,
  }));
  const merged = [
    ...(showNport ? nportRows : []),
    ...(showFormd ? formdRows : []),
  ];

  const columns = [
    // Source pill — dropped entirely when lockedSource is set (tab view
    // already filters to one source, so the column would be redundant).
    ...(lockedSource ? [] : [{
      key: '_src',
      label: 'Source',
      accessor: r => r._src,
      cellClassName: 'text-xs',
      render: r => (
        <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-widest text-slate-600">
          {r._src}
        </span>
      ),
    }]),
    {
      key: 'name',
      label: lockedSource === 'formd' ? 'SPV' : (lockedSource === 'nport' ? 'Fund' : 'Fund / Vehicle'),
      accessor: r => r.name,
      cellClassName: 'text-xs text-slate-700',
      render: r => {
        if (r._src === 'Form D' && r.accession_number) {
          return (
            <a
              href={`/intel/fund/${encodeURIComponent(r.accession_number)}`}
              className="text-slate-700 hover:text-slate-900 hover:underline"
            >
              {r.name}
            </a>
          );
        }
        return r.name;
      },
    },
    {
      key: 'adviser_name',
      label: 'Manager / Adviser',
      accessor: r => (r.manager && r.manager.name) || r.adviser_name,
      cellClassName: 'text-slate-900',
      render: r => {
        const mgr = r.manager;
        // Discovered = non-SEC-registered firm found via series-master
        // extraction + enriched_managers lookup; CRD = exact ADV match.
        // Small "via filings" pill signals the lower-confidence path.
        const discoveredPill = mgr && mgr.kind === 'discovered' ? (
          <span className="text-[9px] uppercase tracking-widest font-semibold font-mono px-1 py-0.5 rounded bg-slate-100 text-slate-500"
                title="Manager discovered via Form D series-master parsing (not SEC-registered)">
            via filings
          </span>
        ) : null;
        if (mgr && mgr.url && mgr.name) {
          return (
            <span className="inline-flex items-baseline gap-1.5 flex-wrap">
              <a href={mgr.url} className="text-slate-900 hover:text-slate-700 hover:underline">{mgr.name}</a>
              {discoveredPill}
            </span>
          );
        }
        if (mgr && mgr.name) {
          return (
            <span className="inline-flex items-baseline gap-1.5 flex-wrap">
              <span>{mgr.name}</span>
              {discoveredPill}
            </span>
          );
        }
        return r.adviser_name && r.adviser_crd
          ? <a href={`/intel/adviser/${encodeURIComponent(r.adviser_crd)}`} className="text-slate-900 hover:text-slate-700 hover:underline">{r.adviser_name}</a>
          : (r.adviser_name || <span className="text-slate-300">—</span>);
      },
    },
    {
      key: 'value_usd',
      label: 'Value / Offering',
      align: 'right',
      accessor: r => r.value_usd || 0,
      cellClassName: 'text-right font-mono',
      render: r => fmtUsdShort(r.value_usd),
    },
    {
      key: 'date',
      label: 'Date',
      accessor: r => r.date,
      cellClassName: 'text-xs text-slate-500',
      render: r => fmtDate(r.date),
    },
    {
      key: 'status',
      label: 'Status',
      accessor: r => r.status || '',
      cellClassName: 'text-xs',
      render: r => {
        if (r._src === 'N-PORT' && r.status) {
          return (
            <span className={r.status === 'private' ? 'text-slate-600' : 'text-amber-700'}>
              {fmtStatus(r.status)}
            </span>
          );
        }
        return null;
      },
    },
    {
      key: 'source',
      label: 'EDGAR',
      sortable: false,
      accessor: r => r.accession_number || '',
      cellClassName: 'text-xs',
      render: r => {
        const url = edgarFilingUrl(r.cik, r.accession_number);
        if (!url) return null;
        return (
          <a href={url} target="_blank" rel="noopener noreferrer"
             className="text-slate-500 hover:text-slate-900"
             title={`EDGAR filing ${r.accession_number}`}>
            EDGAR
          </a>
        );
      },
    },
  ];

  const expandableRender = (row) => {
    const raw = row.raw || {};
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Filing</div>
          <dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-slate-500">Source</dt>
            <dd className="text-slate-900 font-medium">{row._src}</dd>
            <dt className="text-slate-500">Accession</dt>
            <dd className="font-mono text-slate-700">{row.accession_number || '—'}</dd>
            <dt className="text-slate-500">CIK</dt>
            <dd className="font-mono text-slate-700">{row.cik || '—'}</dd>
            <dt className="text-slate-500">{row._src === 'N-PORT' ? 'As-of date' : 'Filed'}</dt>
            <dd className="text-slate-700">{fmtDate(row.date) || '—'}</dd>
            {row._src === 'N-PORT' && raw.series_id && (
              <React.Fragment>
                <dt className="text-slate-500">Series</dt>
                <dd className="font-mono text-slate-700">{raw.series_id}</dd>
              </React.Fragment>
            )}
            {row._src === 'N-PORT' && raw.status_at_evidence_date && (
              <React.Fragment>
                <dt className="text-slate-500">Status</dt>
                <dd className="text-slate-700">{fmtStatus(raw.status_at_evidence_date)}</dd>
              </React.Fragment>
            )}
          </dl>
          {edgarFilingUrl(row.cik, row.accession_number) && (
            <a
              href={edgarFilingUrl(row.cik, row.accession_number)}
              target="_blank" rel="noopener noreferrer"
              className="mt-2 inline-block text-xs text-slate-600 hover:text-slate-900 underline"
            >
              View full filing on EDGAR
            </a>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1 flex items-baseline gap-2">
            Manager / Adviser
            {row.manager?.kind === 'discovered' && (
              <span className="text-[9px] uppercase tracking-widest font-semibold font-mono px-1 py-0.5 rounded bg-slate-100 text-slate-500"
                    title="Discovered via Form D series-master parsing (not SEC-registered)">via filings</span>
            )}
          </div>
          {/* Firm name (always shown) */}
          <div className="text-[13px] font-serif font-semibold text-slate-900 mb-2">
            {(row.manager?.name || row.adviser_name) ? (
              <a href={row.manager?.url || (row.adviser_crd ? `/intel/adviser/${encodeURIComponent(row.adviser_crd)}` : '#')}
                 className="hover:text-slate-700 hover:underline">
                {row.manager?.name || row.adviser_name}
              </a>
            ) : (
              <span className="text-slate-300 font-sans">No manager attribution yet</span>
            )}
            {row.manager?.kind === 'crd' && row.adviser_crd && (
              <span className="ml-2 text-[10px] font-mono font-normal text-slate-500 uppercase tracking-wider">CRD {row.adviser_crd}</span>
            )}
          </div>
          {/* Lazy-fetched enrichment: website, contacts, owners, team members */}
          {row.manager?.kind === 'crd' && row.manager.crd && (
            <ManagerCard kind="crd" crd={row.manager.crd} compact />
          )}
          {row.manager?.kind === 'discovered' && row.manager.discovered_manager_id && (
            <ManagerCard kind="discovered" discoveredId={row.manager.discovered_manager_id} compact />
          )}
          {!row.manager && (
            <div className="text-[11px] text-slate-400 italic">
              No manager identified for this filing yet. The entityname didn't match a registered adviser or a discovered manager.
            </div>
          )}
        </div>
      </div>
    );
  };

  // Toolbar source-filter checkboxes — hidden when lockedSource is set
  // (the surrounding tab view already filters to one source).
  const toolbarExtras = lockedSource ? null : (
    <div className="flex items-center gap-4 text-xs text-slate-600 mr-3">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={showNport}
          onChange={(e) => setShowNport(e.target.checked)}
          className="rounded border-slate-300"
        />
        <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-widest text-slate-600">N-PORT</span>
        <span className="text-slate-400 font-mono tabular-nums">{fmtInt(nportRows.length)}</span>
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={showFormd}
          onChange={(e) => setShowFormd(e.target.checked)}
          className="rounded border-slate-300"
        />
        <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-widest text-slate-600">Form D</span>
        <span className="text-slate-400 font-mono tabular-nums">{fmtInt(formdRows.length)}</span>
      </label>
    </div>
  );

  return (
    <PaginatedTable
      rows={merged}
      columns={columns}
      defaultSort={{ key: 'value_usd', direction: 'desc' }}
      emptyText="No fund holdings to display."
      rowKey={r => r._key}
      expandableRender={expandableRender}
      toolbarExtras={toolbarExtras}
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

// --- segmented tabs ---------------------------------------------------------

/**
 * SegmentedTabs — Linear/PFR-style horizontal segmented control for
 * switching between equivalent views of the same dataset. Each tab gets
 * an optional count badge. Active tab carries a slate-900 bottom-border
 * indicator and a filled count chip; inactive tabs are quiet.
 *
 * Used by IntelPage to switch between [Managers / Mutual funds / SPVs /
 * Timeline] — three lenses on the same company-holders data. Solves the
 * "managers AND N-PORT AND pooled vehicles flow is clunky" feedback by
 * making the three lenses peers rather than sequential sections.
 *
 * Props:
 *   tabs:      [{ key, label, count? }]
 *   activeKey: string
 *   onChange:  fn(key)
 */
function SegmentedTabs({ tabs, activeKey, onChange }) {
  return (
    <div className="flex items-stretch border-b border-slate-200 mb-6 overflow-x-auto">
      {tabs.map(t => {
        const isActive = activeKey === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={
              'group flex items-center gap-2 px-4 py-3 text-[12px] font-semibold transition-colors border-b-2 -mb-px whitespace-nowrap ' +
              (isActive
                ? 'text-slate-900 border-slate-900'
                : 'text-slate-500 border-transparent hover:text-slate-800 hover:border-slate-300')
            }
          >
            <span>{t.label}</span>
            {t.count != null && (
              <span className={
                'inline-flex items-center justify-center rounded text-[10px] font-mono tabular-nums px-1.5 py-0.5 ' +
                (isActive
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-500 group-hover:bg-slate-200')
              }>
                {fmtInt(t.count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * useHashTab — sync a tab key with `window.location.hash`. Reads hash
 * on mount, listens for hashchange (back/forward), writes hash on
 * change. Falls back to defaultKey when the hash doesn't match a valid
 * tab key.
 */
function useHashTab(validKeys, defaultKey) {
  const readHash = React.useCallback(() => {
    const h = (window.location.hash || '').replace(/^#/, '');
    return validKeys.includes(h) ? h : defaultKey;
  }, [validKeys, defaultKey]);
  const [key, setKey] = useStateI(readHash());
  useEffectI(() => {
    const onHash = () => setKey(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [readHash]);
  const setKeyAndHash = React.useCallback((k) => {
    if (window.location.hash.replace(/^#/, '') !== k) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${k}`);
    }
    setKey(k);
  }, []);
  // When validKeys changes (e.g., Timeline appears/disappears), re-read hash
  // so we don't end up stuck on an invalid key.
  useEffectI(() => { setKey(readHash()); }, [validKeys.join(',')]);
  return [key, setKeyAndHash];
}

// --- AppShell — persistent rail + topbar that wraps every /intel/* page ----

/**
 * AppShell — the global chrome for /intel/*.
 *
 * Renders:
 *   - 248px left rail with brand / search / WATCHLIST / MODULES / (optional
 *     filter panel via railFilters prop)
 *   - 52px sticky topbar with breadcrumb + optional rightActions
 *   - Main content pane (children)
 *
 * Props:
 *   children: page body
 *   activeModule: one of 'dashboard' | 'companies' | 'managers' | 'funds' |
 *     'spvs' | 'people' | 'timeline' — highlights the module in the rail
 *   activeWatchlistSlug: company slug to highlight in the WATCHLIST section
 *   breadcrumb: array of {label, href?} segments (or React node)
 *   rightActions: optional ReactNode rendered in the topbar's right side
 *   railFilters: optional ReactNode rendered below the modules — the
 *     "rail morphs into a filter panel" PFR pattern.
 *
 * The watchlist is read from localStorage (`useWatchlist` hook). Defaults to
 * 6 high-profile tracked companies on first load.
 */
function AppShell({ children, activeModule, activeWatchlistSlug, breadcrumb, rightActions, railFilters }) {
  const { list: watchlist } = useWatchlist();

  // ⌘K → /intel/search
  useEffectI(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        window.location.href = '/intel/search';
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isActiveSlug = (slug) => activeWatchlistSlug && activeWatchlistSlug === slug;

  return (
    <div className="intel-shell">
      <aside className="intel-rail">
        <a href="/intel" className="intel-rail-brand" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="intel-rail-brand-mark">F</span>
          <span>
            <span className="intel-rail-brand-name">Fund Holders</span>
            <div className="intel-rail-brand-kicker">Intel</div>
          </span>
        </a>

        <a href="/intel/search" className="intel-rail-search">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <span>Search…</span>
          <span className="intel-rail-search-shortcut">⌘K</span>
        </a>

        <div className="intel-rail-section-title">Watchlist</div>
        {watchlist.length === 0 ? (
          <div className="intel-rail-item intel-rail-item-empty">No companies pinned</div>
        ) : watchlist.map(slug => (
          <a key={slug} href={`/intel/${slug}`}
             className={isActiveSlug(slug) ? 'intel-rail-item active' : 'intel-rail-item'}>
            <span>{prettySlug(slug)}</span>
          </a>
        ))}
        <a href="/intel/companies" className="intel-rail-item intel-rail-item-empty">+ Add company</a>

        <div className="intel-rail-section-title">Modules</div>
        <a href="/intel"           className={'intel-rail-item' + (activeModule === 'dashboard' ? ' active' : '')}>Dashboard</a>
        <a href="/intel/companies" className={'intel-rail-item' + (activeModule === 'companies' ? ' active' : '')}>All companies</a>
        <a href="/intel/managers"  className={'intel-rail-item' + (activeModule === 'managers'  ? ' active' : '')}>All managers</a>
        <a href="/intel/funds"     className={'intel-rail-item' + (activeModule === 'funds'     ? ' active' : '')}>All funds</a>
        <a href="/intel/spvs"      className={'intel-rail-item' + (activeModule === 'spvs'      ? ' active' : '')}>All SPVs</a>
        <a href="/intel/people"    className={'intel-rail-item' + (activeModule === 'people'    ? ' active' : '')}>People</a>
        <a href="/intel/timeline"  className={'intel-rail-item' + (activeModule === 'timeline'  ? ' active' : '')}>Timeline</a>

        {railFilters && (
          <>
            <div className="intel-rail-section-title">Parameters</div>
            <div className="intel-rail-filters">{railFilters}</div>
          </>
        )}
      </aside>

      <div className="intel-main">
        <div className="intel-topbar">
          <div className="intel-breadcrumb">
            {Array.isArray(breadcrumb) ? breadcrumb.map((seg, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="intel-breadcrumb-sep">/</span>}
                {seg.href ? <a href={seg.href}>{seg.label}</a> :
                  <span className={i === breadcrumb.length - 1 ? 'intel-breadcrumb-current' : ''}>{seg.label}</span>}
              </React.Fragment>
            )) : breadcrumb}
          </div>
          <div className="flex items-center gap-2">{rightActions}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

// Pin/unpin button — small action shown on company pages.
function WatchlistButton({ slug }) {
  const { has, toggle } = useWatchlist();
  const pinned = has(slug);
  return (
    <button onClick={() => toggle(slug)} className="nport-button" title={pinned ? 'Remove from watchlist' : 'Add to watchlist'}>
      {pinned ? '★ Watching' : '☆ Watch'}
    </button>
  );
}

// --- cross-cutting placeholder pages ----------------------------------------
// Stub implementations — Phase 3 fills these with real data + filters.

function DashboardPage() {
  return (
    <AppShell activeModule="dashboard" breadcrumb={[{ label: 'Dashboard' }]}>
      <div className="intel-page">
        <h1 className="font-serif text-[28px] font-bold tracking-tight">Good evening</h1>
        <p className="text-[12px] text-slate-500 mt-1">Dashboard placeholder — companies-list + activity feed land here next.</p>
        <div className="mt-6 text-sm text-slate-600">
          Pinned companies are in the rail on the left. Click any to drill in. Use the Modules section for cross-cutting views.
        </div>
      </div>
    </AppShell>
  );
}

function AllCompaniesPage() {
  return (
    <AppShell activeModule="companies" breadcrumb={[{ label: 'All companies' }]}>
      <div className="intel-page">
        <h1 className="font-serif text-[26px] font-bold tracking-tight">All companies</h1>
        <p className="text-[12px] text-slate-500 mt-1">Sortable list of every tracked company — coming next session. For now, click a watchlist item.</p>
      </div>
    </AppShell>
  );
}

function AllManagersPage() {
  return (
    <AppShell activeModule="managers" breadcrumb={[{ label: 'All managers' }]}>
      <div className="intel-page">
        <h1 className="font-serif text-[26px] font-bold tracking-tight">All managers</h1>
        <p className="text-[12px] text-slate-500 mt-1">Cross-cutting view across all tracked companies — coming next session.</p>
      </div>
    </AppShell>
  );
}

function AllFundsPage() {
  return (
    <AppShell activeModule="funds" breadcrumb={[{ label: 'All funds' }]}>
      <div className="intel-page">
        <h1 className="font-serif text-[26px] font-bold tracking-tight">All funds</h1>
        <p className="text-[12px] text-slate-500 mt-1">All N-PORT mutual fund holdings of tracked companies — coming next session.</p>
      </div>
    </AppShell>
  );
}

function AllSpvsPage() {
  return (
    <AppShell activeModule="spvs" breadcrumb={[{ label: 'All SPVs' }]}>
      <div className="intel-page">
        <h1 className="font-serif text-[26px] font-bold tracking-tight">All SPVs</h1>
        <p className="text-[12px] text-slate-500 mt-1">All Form D pooled-vehicle offerings of tracked companies — coming next session.</p>
      </div>
    </AppShell>
  );
}

function PeoplePage() {
  return (
    <AppShell activeModule="people" breadcrumb={[{ label: 'People' }]}>
      <div className="intel-page">
        <h1 className="font-serif text-[26px] font-bold tracking-tight">People</h1>
        <p className="text-[12px] text-slate-500 mt-1">Signatories, CCOs, principals, and team members across all entities — coming next session.</p>
      </div>
    </AppShell>
  );
}

function TimelinePage() {
  return (
    <AppShell activeModule="timeline" breadcrumb={[{ label: 'Timeline' }]}>
      <div className="intel-page">
        <h1 className="font-serif text-[26px] font-bold tracking-tight">Timeline</h1>
        <p className="text-[12px] text-slate-500 mt-1">Recent lifecycle events + filings across all tracked companies — coming next session.</p>
      </div>
    </AppShell>
  );
}

// --- main page --------------------------------------------------------------

// Static tab keys for the IntelPage tab control. Module-level to keep the
// reference stable across renders (useHashTab compares deps).
const INTEL_TAB_KEYS = ['managers', 'funds', 'spvs', 'timeline'];

function IntelPage({ slug }) {
  const [data, setData] = useStateI(null);
  const [error, setError] = useStateI(null);
  const [auditMode, setAuditMode] = useStateI(false);
  const [showAdvanced, setShowAdvanced] = useStateI(false);
  const [activeTab, setActiveTab] = useHashTab(INTEL_TAB_KEYS, 'managers');

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

  // Pretty fallback while data is loading. Uses the module-level
  // prettySlug helper (not the React Hook rules; just a function).
  const slugPretty = prettySlug(slug);

  // Dynamic browser tab title.
  useEffectI(() => {
    const name = (data && data.company && data.company.display_name) || slugPretty;
    document.title = `${name} · Fund Holders Intel`;
  }, [data, slugPretty]);

  const breadcrumb = [
    { label: 'Companies', href: '/intel/companies' },
    { label: (data && data.company && data.company.display_name) || slugPretty },
  ];

  if (error) {
    return (
      <AppShell activeWatchlistSlug={slug} breadcrumb={breadcrumb}>
        <div className="intel-page">
          <div className="max-w-2xl py-12">
            <h1 className="font-serif text-3xl font-semibold mb-3 text-slate-900">
              Couldn't load {slugPretty}
            </h1>
            <p className="text-sm text-slate-600 mb-4">{error}</p>
            <a href="/intel/search" className="nport-button">← Back to search</a>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell activeWatchlistSlug={slug} breadcrumb={breadcrumb}>
        <div className="intel-page">
          <div className="animate-pulse">
            <div className="h-9 w-64 bg-slate-200 rounded mb-3"></div>
            <div className="h-3 w-48 bg-slate-100 rounded mb-10"></div>
            <div className="h-72 rounded-lg bg-slate-100"></div>
          </div>
        </div>
      </AppShell>
    );
  }

  const { company, lifecycle, summary, nport_holders, formd_holders, advisers } = data;
  const isPrivate = lifecycle.current_status === 'private';
  const totalValue = (advisers || []).reduce((s, a) => s + (a.total_value_usd || 0), 0);
  const hasTimeline = lifecycle.events && lifecycle.events.length > 0;

  return (
    <AppShell
      activeWatchlistSlug={slug}
      breadcrumb={breadcrumb}
      rightActions={<WatchlistButton slug={slug} />}
    >
      <div className="intel-page">
        {/* Company header — name + metadata on left, last valuation on right.
            Visual debt cleanup applied: dropped the 4-card metric strip, the
            heavy amber banner, and the "most recent reported" wordy eyebrow.
            See .llm/IA_REDESIGN_CRITIQUE_2026-05-26.md §3. */}
        <header className="flex items-start justify-between gap-6 flex-wrap mb-2">
          <div className="min-w-0">
            <h1 className="nport-title text-slate-900">{company.display_name}</h1>
            <div className="flex items-center flex-wrap gap-3 mt-3 text-[12px] text-slate-600">
              {company.sector && <span className="nport-status">{company.sector}</span>}
              {company.founded_year && <span className="text-slate-500">Founded {company.founded_year}</span>}
              {company.primary_domain && (
                <a href={`https://${company.primary_domain}`} target="_blank" rel="noopener noreferrer"
                   className="font-mono text-[11px] text-slate-600 hover:text-slate-900 underline underline-offset-2">
                  {company.primary_domain}
                </a>
              )}
              {!isPrivate && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                  Now {fmtStatus(lifecycle.current_status)}
                  {lifecycle.last_event_date && ` · ${fmtDate(lifecycle.last_event_date)}`}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <AddToCrmButton kind="company" slug={slug} label="Add managers to CRM" />
          </div>
          {company.latest_known_valuation_usd && (
            <div className="text-right shrink-0">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Last valuation</div>
              <div className="font-mono text-[26px] font-semibold text-slate-900 tabular-nums tracking-tight mt-1 leading-none">
                {fmtUsdShort(company.latest_known_valuation_usd)}
              </div>
              {(company.most_recent_round || company.most_recent_round_date) && (
                <div className="text-[11px] text-slate-500 mt-1">
                  {company.most_recent_round}
                  {company.most_recent_round && company.most_recent_round_date && ' · '}
                  {company.most_recent_round_date && fmtDate(company.most_recent_round_date)}
                </div>
              )}
            </div>
          )}
        </header>

        {/* One-line stat summary replaces the 4-card metric strip (§3 #5). */}
        <p className="text-[13px] text-slate-600 mt-5 mb-6">
          <span className="font-mono font-semibold text-slate-900 tabular-nums">{fmtUsdShort(totalValue)}</span> held by tracked investors —{' '}
          <span className="tabular-nums font-mono">{fmtInt(summary.distinct_advisers)}</span> managers ·{' '}
          <span className="tabular-nums font-mono">{fmtInt(summary.eligible_nport)}</span> mutual fund filings ·{' '}
          <span className="tabular-nums font-mono">{fmtInt(summary.eligible_formd)}</span> SPVs
        </p>

        {/* Sub-tabs — segmented control */}
        <SegmentedTabs
          tabs={[
            { key: 'managers', label: 'Managers', count: summary.distinct_advisers },
            { key: 'funds', label: 'Mutual funds', count: nport_holders.length },
            { key: 'spvs', label: 'SPVs', count: formd_holders.length },
            ...(hasTimeline ? [{ key: 'timeline', label: 'Timeline', count: lifecycle.events.length }] : []),
          ]}
          activeKey={activeTab}
          onChange={setActiveTab}
        />

        {/* Tab body */}
        {activeTab === 'managers' && (
          <AdviserListDetail
            advisers={advisers}
            nportHolders={nport_holders}
            formdHolders={formd_holders}
            companyName={company.display_name}
          />
        )}

        {activeTab === 'funds' && (
          <UnifiedFundsPane
            nportHolders={nport_holders}
            formdHolders={formd_holders}
            slug={company.slug}
            audit={summary.audit_mode}
            lockedSource="nport"
          />
        )}

        {activeTab === 'spvs' && (
          <UnifiedFundsPane
            nportHolders={nport_holders}
            formdHolders={formd_holders}
            slug={company.slug}
            audit={summary.audit_mode}
            lockedSource="formd"
          />
        )}

        {activeTab === 'timeline' && hasTimeline && (
          <LifecycleTimeline events={lifecycle.events} />
        )}

        {/* Advanced disclosure (audit toggle moved off primary view) */}
        {activeTab !== 'timeline' && (
          <div className="mt-8 pt-4 border-t border-slate-100">
            <button onClick={() => setShowAdvanced(s => !s)}
                    className="text-[11px] text-slate-400 hover:text-slate-700 font-mono uppercase tracking-wider">
              {showAdvanced ? '▾ Advanced' : '▸ Advanced'}
            </button>
            {showAdvanced && (
              <div className="mt-3 text-[12px] text-slate-500">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={auditMode} onChange={(e) => setAuditMode(e.target.checked)} className="rounded border-slate-300" />
                  <span>Include filings after the company went public ({fmtInt(summary.total_nport - summary.eligible_nport)} hidden)</span>
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

// --- adviser-centric page (all funds held by adviser across all companies) ---

function AdviserPage({ crd }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [audit, setAudit] = React.useState(false);
  // Expandable section state — must come before early returns
  // (React hooks rules: same hooks in same order every render).
  const [ownersExpanded, setOwnersExpanded] = React.useState(false);
  const [spExpanded, setSpExpanded] = React.useState(false);

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
      <AppShell activeModule="managers" breadcrumb={[{ label: 'Managers', href: '/intel/managers' }, { label: `CRD ${crd}` }]}>
        <div className="intel-page">
          <div className="max-w-2xl py-12">
            <a href="/intel/search" className="text-sm text-slate-500 hover:text-slate-900">← Back to search</a>
            <h1 className="font-serif text-3xl font-semibold text-slate-900 mt-4 mb-3">Couldn't load adviser</h1>
            <p className="text-sm text-slate-600">{error}</p>
          </div>
        </div>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell activeModule="managers" breadcrumb={[{ label: 'Managers', href: '/intel/managers' }, { label: `CRD ${crd}` }]}>
        <div className="intel-page">
          <div className="animate-pulse">
            <div className="h-9 w-80 bg-slate-200 rounded mb-3"></div>
            <div className="h-3 w-40 bg-slate-100 rounded mb-10"></div>
            <div className="h-64 rounded-lg bg-slate-100"></div>
          </div>
        </div>
      </AppShell>
    );
  }

  const { adviser, summary, companies, service_providers: serviceProviders } = data;

  const companyColumns = [
    {
      key: 'display_name',
      label: 'Company',
      accessor: r => r.display_name,
      render: r => (
        <a
          href={`/intel/${encodeURIComponent(r.slug)}`}
          className="font-serif font-semibold text-slate-900 hover:text-slate-700 hover:underline underline-offset-2"
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
        <span className={r.lifecycle_status === 'private' ? 'text-slate-600' : 'text-slate-500'}>
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
    <AppShell
      activeModule="managers"
      breadcrumb={[
        { label: 'Managers', href: '/intel/managers' },
        { label: adviser.name || 'Unidentified firm' },
      ]}
    >
      <div className="intel-page">
      {/* Header */}
      <div className="mt-1 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-slate-900">
            {adviser.name || 'Unidentified firm'}
          </h1>
          <AddToCrmButton kind="firm" crd={adviser.crd} label="Add firm's people to CRM" />
        </div>
        <div className="text-xs font-mono text-slate-500 mt-1">CRD {adviser.crd}</div>
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          {adviser.website && (
            <a href={normalizeHref(adviser.website)} target="_blank" rel="noopener noreferrer" className="nport-button">
              Website
            </a>
          )}
          <a href={`https://adviserinfo.sec.gov/firm/summary/${adviser.crd}`} target="_blank" rel="noopener noreferrer" className="nport-button">
            IAPD
          </a>
          {adviser.form_adv_url && (
            <a href={adviser.form_adv_url} target="_blank" rel="noopener noreferrer" className="nport-button">
              Form ADV
            </a>
          )}
          {adviser.linkedin_company_url && (
            <a href={adviser.linkedin_company_url} target="_blank" rel="noopener noreferrer" className="nport-button">
              LinkedIn
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
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Filings</div>
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
          Show holdings after IPO
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
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Principals / Owners ({(adviser.owners_detail || adviser.owners).length})
                </div>
                <ul className="space-y-2">
                  {(adviser.owners_detail && adviser.owners_detail.length > 0
                    ? adviser.owners_detail.slice(0, 5)
                    : adviser.owners.slice(0, 5).map(name => ({ name, title: null, ownership_amount: null, owner_type: null }))
                  ).map((o, i) => {
                    const contact = resolvePersonContact(o, adviser.person_enrichment);
                    return (
                      <li key={i} className="text-sm">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-slate-900 font-medium">{o.name}</span>
                          <PersonContactButtons linkedin={contact.linkedin} email={contact.email} />
                        </div>
                        {(o.title || o.ownership_amount) && (
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            {o.title}{o.title && o.ownership_amount && ' · '}
                            {o.ownership_amount && (<span className="font-mono">{o.ownership_amount}</span>)}
                            {o.owner_type && o.owner_type !== 'Direct' && (
                              <span className="ml-1 text-[9px] uppercase tracking-widest text-slate-400">({o.owner_type})</span>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {(adviser.owners_detail || adviser.owners).length > 5 && (
                  <button onClick={() => setOwnersExpanded(!ownersExpanded)}
                          className="mt-2 text-[11px] text-slate-600 hover:text-slate-900">
                    {ownersExpanded ? 'Show less' : `Show all ${(adviser.owners_detail || adviser.owners).length}`}
                  </button>
                )}
                {ownersExpanded && (
                  <ul className="space-y-2 mt-2 pt-2 border-t border-slate-100">
                    {(adviser.owners_detail || adviser.owners.map(name => ({ name }))).slice(5).map((o, i) => {
                      const contact = resolvePersonContact(o, adviser.person_enrichment);
                      return (
                        <li key={i} className="text-sm">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-slate-900 font-medium">{o.name}</span>
                            <PersonContactButtons linkedin={contact.linkedin} email={contact.email} />
                          </div>
                          {(o.title || o.ownership_amount) && (
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              {o.title}{o.title && o.ownership_amount && ' · '}
                              {o.ownership_amount && (<span className="font-mono">{o.ownership_amount}</span>)}
                              {o.owner_type && o.owner_type !== 'Direct' && (
                                <span className="ml-1 text-[9px] uppercase tracking-widest text-slate-400">({o.owner_type})</span>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Service Providers — aggregated from the firm's funds_enriched rows */}
      {serviceProviders && (
        (serviceProviders.auditors.length || serviceProviders.administrators.length ||
         serviceProviders.custodians.length || serviceProviders.prime_brokers.length) ? (
          <section className="nport-panel mb-6">
            <button onClick={() => setSpExpanded(!spExpanded)}
                    className="w-full nport-panel-header flex items-center justify-between hover:bg-slate-50 transition-colors">
              <h2 className="font-serif text-lg font-semibold text-slate-900">
                Service Providers
                <span className="text-slate-400 text-sm font-normal ml-2">
                  ({serviceProviders.auditors.length + serviceProviders.administrators.length +
                    serviceProviders.custodians.length + serviceProviders.prime_brokers.length} distinct, aggregated across firm's funds)
                </span>
              </h2>
              <span className={'text-slate-400 ' + (spExpanded ? 'rotate-180' : '')}>▾</span>
            </button>
            {spExpanded && (
              <div className="px-5 py-4 grid md:grid-cols-2 gap-x-6 gap-y-5 text-sm">
                {serviceProviders.auditors.length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Auditors ({serviceProviders.auditors.length})</div>
                    <ul className="space-y-0.5">{serviceProviders.auditors.map((n, i) => <li key={i} className="text-[12px] text-slate-700">{n}</li>)}</ul>
                  </div>
                )}
                {serviceProviders.administrators.length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Administrators ({serviceProviders.administrators.length})</div>
                    <ul className="space-y-0.5">{serviceProviders.administrators.map((n, i) => <li key={i} className="text-[12px] text-slate-700">{n}</li>)}</ul>
                  </div>
                )}
                {serviceProviders.custodians.length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Custodians ({serviceProviders.custodians.length})</div>
                    <ul className="space-y-0.5">{serviceProviders.custodians.map((n, i) => <li key={i} className="text-[12px] text-slate-700">{n}</li>)}</ul>
                  </div>
                )}
                {serviceProviders.prime_brokers.length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Prime Brokers ({serviceProviders.prime_brokers.length})</div>
                    <ul className="space-y-0.5">{serviceProviders.prime_brokers.map((n, i) => <li key={i} className="text-[12px] text-slate-700">{n}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </section>
        ) : null
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
            emptyText="No holdings recorded for this adviser."
          />
        </div>
      </section>
      </div>
    </AppShell>
  );
}

// --- global search ----------------------------------------------------------

// --- fund detail page (Form D pooled-vehicle SPV) -----------------------------

function FundPage({ accession }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    setData(null);
    setError(null);
    fetch(`/api/intel/funds/${encodeURIComponent(accession)}`)
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)))
      .then(setData)
      .catch(e => setError(e && e.error ? e.error : 'Failed to load'));
  }, [accession]);

  if (error) {
    return (
      <AppShell activeModule="spvs" breadcrumb={[{ label: 'SPVs', href: '/intel/spvs' }, { label: accession }]}>
        <div className="intel-page">
          <div className="max-w-2xl py-12">
            <a href="/intel/search" className="text-sm text-slate-500 hover:text-slate-900">← Back to search</a>
            <h1 className="font-serif text-3xl font-semibold text-slate-900 mt-4 mb-3">Couldn't load filing</h1>
            <p className="text-sm text-slate-600">{error}</p>
          </div>
        </div>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell activeModule="spvs" breadcrumb={[{ label: 'SPVs', href: '/intel/spvs' }, { label: accession }]}>
        <div className="intel-page">
          <div className="animate-pulse">
            <div className="h-9 w-96 bg-slate-200 rounded mb-3"></div>
            <div className="h-3 w-60 bg-slate-100 rounded mb-10"></div>
            <div className="h-64 rounded-lg bg-slate-100"></div>
          </div>
        </div>
      </AppShell>
    );
  }

  const { filing, related_parties: relatedParties, adviser, tracked_companies: trackedCompanies, edgar_url: edgarUrl } = data;
  const offeringTotal = filing.total_offering_amount ? parseFloat(filing.total_offering_amount) : null;
  const offeringSold = filing.total_amount_sold ? parseFloat(filing.total_amount_sold) : null;
  const offeringRemaining = filing.total_remaining ? parseFloat(filing.total_remaining) : null;
  const minInvest = filing.minimum_investment ? parseFloat(filing.minimum_investment) : null;
  const totalInvestors = filing.total_investors != null ? parseInt(filing.total_investors, 10) : null;

  return (
    <AppShell
      activeModule="spvs"
      breadcrumb={[
        { label: 'SPVs', href: '/intel/spvs' },
        { label: filing.entityname || accession },
      ]}
    >
      <div className="intel-page">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <a href="/" className="nport-button">← Back</a>
        <GlobalSearchBar />
      </div>

      <div className="mt-3 mb-6">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {filing.investment_fund_type && (
            <span className="text-[10px] uppercase tracking-widest font-semibold bg-slate-100 text-slate-700 px-2 py-1 rounded">
              {filing.investment_fund_type}
            </span>
          )}
          {filing.is_amendment && (
            <span className="text-[10px] uppercase tracking-widest font-semibold bg-slate-100 text-slate-600 px-2 py-1 rounded">
              Amendment (D/A)
            </span>
          )}
        </div>
        <h1 className="font-serif text-2xl md:text-3xl font-semibold tracking-tight text-slate-900 leading-tight">
          {filing.entityname}
        </h1>
        <div className="text-xs font-mono text-slate-500 mt-1">
          CIK {filing.cik} · Accession {filing.accession_number}
          {edgarUrl && (
            <a href={edgarUrl} target="_blank" rel="noopener noreferrer"
               className="ml-3 text-slate-600 hover:text-slate-900 underline">
              EDGAR
            </a>
          )}
        </div>
        {trackedCompanies && trackedCompanies.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <span className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Holds</span>
            {trackedCompanies.map((tc, i) => (
              <a key={i} href={`/intel/${encodeURIComponent(tc.slug)}`}
                 className="text-sm font-serif font-semibold text-slate-900 hover:text-slate-700 underline">
                {tc.slug}
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="nport-metric-strip mb-6">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Offering total</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtUsdShort(offeringTotal)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Amount sold</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtUsdShort(offeringSold)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Remaining</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtUsdShort(offeringRemaining)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Minimum check</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{fmtUsdShort(minInvest)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Investors</div>
          <div className="font-mono text-lg font-semibold text-slate-900 tabular-nums mt-1">{totalInvestors != null ? fmtInt(totalInvestors) : '—'}</div>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-5">
        <div className="md:col-span-2 space-y-5">
          <section className="nport-panel">
            <div className="nport-panel-header">
              <h2 className="font-serif text-lg font-semibold text-slate-900">Filing details</h2>
            </div>
            <dl className="px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Filing date</dt><dd className="text-slate-900 mt-0.5">{fmtDate(filing.filing_date)}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">First sale</dt><dd className="text-slate-900 mt-0.5">{fmtDate(filing.sale_date) || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Signature date</dt><dd className="text-slate-900 mt-0.5">{fmtDate(filing.signature_date) || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Submission type</dt><dd className="text-slate-900 mt-0.5">{filing.submission_type || '—'}</dd></div>
              <div className="col-span-2"><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Federal exemptions</dt><dd className="text-slate-900 mt-0.5 font-mono text-xs">{filing.federal_exemptions || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Entity type</dt><dd className="text-slate-900 mt-0.5">{filing.entity_type || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Jurisdiction</dt><dd className="text-slate-900 mt-0.5">{filing.jurisdiction || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Year of inc.</dt><dd className="text-slate-900 mt-0.5">{filing.year_of_inc || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Industry group</dt><dd className="text-slate-900 mt-0.5">{filing.industry_group_type || '—'}</dd></div>
              <div className="col-span-2"><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Issuer address</dt><dd className="text-slate-900 mt-0.5">{[filing.street1, filing.city, filing.state_or_country, filing.zipcode].filter(Boolean).join(', ') || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Issuer phone</dt><dd className="text-slate-900 mt-0.5 font-mono text-xs">{filing.issuer_phone || '—'}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Signed by</dt><dd className="text-slate-900 mt-0.5">{filing.name_of_signer || '—'}{filing.signature_title && <span className="text-[11px] text-slate-500 ml-1">({filing.signature_title})</span>}</dd></div>
              {filing.previous_accession && (
                <div className="col-span-2"><dt className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">Previous accession</dt>
                  <dd className="text-slate-900 mt-0.5 font-mono text-xs">
                    <a href={`/intel/fund/${encodeURIComponent(filing.previous_accession)}`} className="text-slate-600 hover:text-slate-900 underline">{filing.previous_accession}</a>
                  </dd>
                </div>
              )}
            </dl>
          </section>
        </div>

        <div className="md:col-span-1 space-y-5">
          {adviser && (
            <section className="nport-panel">
              <div className="nport-panel-header">
                <h2 className="font-serif text-base font-semibold text-slate-900">Investment Adviser</h2>
              </div>
              <div className="px-4 py-3 space-y-2 text-sm">
                <a href={`/intel/adviser/${encodeURIComponent(adviser.crd)}`} className="font-serif font-semibold text-slate-900 hover:text-slate-700 underline block">{adviser.name}</a>
                <div className="text-[10px] font-mono text-slate-500">CRD {adviser.crd}</div>
                {adviser.total_aum && <div className="text-[11px] text-slate-600">AUM <span className="font-mono">{fmtUsdShort(adviser.total_aum)}</span></div>}
                {adviser.phone && <div className="text-[12px] flex gap-2 items-baseline"><span className="text-slate-500">Phone</span><span className="font-mono text-slate-700">{adviser.phone}</span></div>}
                {adviser.website && <div className="text-[12px] flex gap-2 items-baseline"><span className="text-slate-500">Web</span><a href={normalizeHref(adviser.website)} target="_blank" rel="noopener noreferrer" className="font-mono text-slate-700 hover:text-slate-900 underline break-all">{adviser.website}</a></div>}
                {adviser.cco_name && <div className="text-[12px] flex gap-2 items-baseline"><span className="text-slate-500">CCO</span><div><span className="text-slate-900">{renderPersonWithLinkedIn(adviser.cco_name, adviser.person_enrichment)}</span>{adviser.cco_email && <a href={`mailto:${adviser.cco_email}`} className="ml-2 font-mono text-[10px] text-slate-600 hover:text-slate-900">{adviser.cco_email}</a>}</div></div>}
                {adviser.team_members && adviser.team_members.length > 0 && (
                  <div className="pt-3 mt-3 border-t border-slate-100">
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Team ({adviser.team_members.length})</div>
                    <ul className="space-y-1.5">
                      {adviser.team_members.slice(0, 5).map((m, i) => (
                        <li key={i} className="text-[12px]">
                          <span className="text-slate-900 font-medium">{m.name}</span>
                          {m.linkedin && <a href={m.linkedin} target="_blank" rel="noopener noreferrer" className="ml-1.5 text-slate-400 hover:text-slate-900" title="LinkedIn profile"><ExternalLinkIcon /></a>}
                          {m.email && <a href={`mailto:${m.email}`} className="ml-2 font-mono text-[10px] text-slate-600 hover:text-slate-900">{m.email}</a>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          {relatedParties && relatedParties.length > 0 && (
            <section className="nport-panel">
              <div className="nport-panel-header">
                <h2 className="font-serif text-base font-semibold text-slate-900">Related Parties ({relatedParties.length})</h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {relatedParties.map((rp, i) => (
                  <li key={i} className="px-4 py-2.5">
                    <div className="text-sm font-medium text-slate-900">{rp.name}</div>
                    {rp.role && <div className="text-[11px] text-slate-500 mt-0.5">{rp.role}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="nport-panel">
            <div className="nport-panel-header">
              <h2 className="font-serif text-base font-semibold text-slate-900">Filings</h2>
            </div>
            <ul className="px-4 py-3 space-y-1 text-sm">
              {edgarUrl && <li><a href={edgarUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between text-slate-700 hover:text-slate-900 py-1.5"><span>Form D archive</span><span className="text-xs text-slate-400">EDGAR</span></a></li>}
              {adviser && adviser.form_adv_url && <li><a href={adviser.form_adv_url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between text-slate-700 hover:text-slate-900 py-1.5"><span>Adviser Form ADV</span><span className="text-xs text-slate-400">SEC</span></a></li>}
              {adviser && <li><a href={`https://adviserinfo.sec.gov/firm/summary/${adviser.crd}`} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between text-slate-700 hover:text-slate-900 py-1.5"><span>Adviser IAPD</span><span className="text-xs text-slate-400">SEC</span></a></li>}
            </ul>
          </section>
        </div>
      </div>
      </div>
    </AppShell>
  );
}


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
        className="nport-input w-80 px-3 py-1.5 text-[12px] text-slate-700 placeholder:text-slate-400"
      />
      <button type="submit" className="nport-button">
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
  // All 4 types use the same neutral pill — type-label text differentiates
  // without bright color noise. Was: company slate-800/white, adviser
  // slate-200, adv_fund blue, formd amber.
  const typeColors = {
    company: 'bg-slate-100 text-slate-700',
    adviser: 'bg-slate-100 text-slate-700',
    adv_fund: 'bg-slate-100 text-slate-700',
    formd_filing: 'bg-slate-100 text-slate-700',
  };

  return (
    <AppShell breadcrumb={[{ label: 'Search' }]}>
      <div className="intel-page">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-slate-900 mt-1 mb-5">
        Search
      </h1>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 mb-6">
        <input
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          autoFocus
          placeholder="Search companies, advisers, funds, filings…"
          className="nport-input flex-1 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400"
        />
        <button type="submit" className="nport-button nport-button-primary px-4 py-2">
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
          <div className="nport-panel divide-y divide-slate-100 overflow-hidden">
            {data.results.map((r, i) => {
              const inner = (
                <>
                  <span className={`inline-block text-[10px] uppercase tracking-widest font-semibold font-mono px-1.5 py-0.5 rounded ${typeColors[r.type] || 'bg-slate-100 text-slate-700'}`}>
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
    </AppShell>
  );
}

// --- discovered manager page (non-CRD VC/PE firm from enriched_managers) ----

/**
 * DiscoveredPage — detail page for a manager found via series-master
 * extraction (NOT SEC-registered). Mirrors AdviserPage but simpler since
 * the data is less rich. Backend: GET /api/intel/discovered/:id.
 */
function DiscoveredPage({ id }) {
  const [data, setData] = useStateI(null);
  const [error, setError] = useStateI(null);

  useEffectI(() => {
    setData(null);
    setError(null);
    fetch(`/api/intel/discovered/${encodeURIComponent(id)}`)
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)))
      .then(setData)
      .catch(e => setError(e && e.error ? e.error : 'Failed to load'));
  }, [id]);

  useEffectI(() => {
    const name = (data && data.manager && data.manager.name) || 'Discovered manager';
    document.title = `${name} · Fund Holders Intel`;
  }, [data]);

  if (error) {
    return (
      <AppShell activeModule="managers" breadcrumb={[{ label: 'Managers', href: '/intel/managers' }, { label: 'Discovered' }]}>
        <div className="intel-page">
          <div className="max-w-2xl py-12">
            <a href="/intel/search" className="text-sm text-slate-500 hover:text-slate-900">← Back to search</a>
            <h1 className="font-serif text-3xl font-semibold text-slate-900 mt-4 mb-3">Couldn't load manager</h1>
            <p className="text-sm text-slate-600">{error}</p>
          </div>
        </div>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell activeModule="managers" breadcrumb={[{ label: 'Managers', href: '/intel/managers' }, { label: 'Discovered' }]}>
        <div className="intel-page">
          <div className="animate-pulse">
            <div className="h-9 w-80 bg-slate-200 rounded mb-3"></div>
            <div className="h-3 w-40 bg-slate-100 rounded mb-10"></div>
            <div className="h-64 rounded-lg bg-slate-100"></div>
          </div>
        </div>
      </AppShell>
    );
  }

  const { manager, summary, holders_using_this_manager: holders } = data;
  const hasContact = manager.website_url || manager.linkedin_company_url || manager.twitter_handle || manager.primary_contact_email || manager.phone_number;
  const hasGeo = manager.headquarters_city || manager.headquarters_state || manager.headquarters_country;

  return (
    <AppShell
      activeModule="managers"
      breadcrumb={[
        { label: 'Managers', href: '/intel/managers' },
        { label: manager.name || 'Discovered manager' },
      ]}
    >
      <div className="intel-page">
      <div className="mt-1 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-slate-900">
              {manager.name}
            </h1>
            <span className="text-[10px] uppercase tracking-widest font-semibold font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500"
                  title="Manager discovered via Form D series-master parsing (not SEC-registered)">
              via filings
            </span>
          </div>
          <AddToCrmButton kind="firm" enrichedManagerId={manager.id || id} label="Add firm's people to CRM" />
        </div>
        <div className="text-[11px] font-mono text-slate-500 mt-2 uppercase tracking-wider">
          {manager.enrichment_status || 'candidate'}
          {manager.fund_type && <span className="ml-3 normal-case tracking-normal font-sans">{manager.fund_type}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          {manager.website_url && (
            <a href={manager.website_url} target="_blank" rel="noopener noreferrer" className="nport-button">Website</a>
          )}
          {manager.linkedin_company_url && (
            <a href={manager.linkedin_company_url} target="_blank" rel="noopener noreferrer" className="nport-button">LinkedIn</a>
          )}
          {manager.twitter_handle && (
            <a href={`https://twitter.com/${manager.twitter_handle.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer" className="nport-button">Twitter</a>
          )}
        </div>
      </div>

      <div className="nport-metric-strip nport-metric-strip-3 mb-6">
        <div>
          <div className="nport-metric-label">Total holdings</div>
          <div className="nport-metric-value">{fmtInt(summary?.total_holdings || 0)}</div>
        </div>
        <div>
          <div className="nport-metric-label">Total value</div>
          <div className="nport-metric-value">{fmtUsdShort(summary?.total_value_usd || 0)}</div>
        </div>
        <div>
          <div className="nport-metric-label">Source</div>
          <div className="nport-metric-value text-[15px] font-sans normal-case tracking-normal">Form D filings</div>
        </div>
      </div>

      {(hasContact || hasGeo) && (
        <section className="nport-panel mb-6">
          <div className="nport-panel-header">
            <h2 className="font-serif text-lg font-semibold text-slate-900">Firm details</h2>
          </div>
          <div className="px-5 py-4 grid md:grid-cols-2 gap-5 text-sm">
            {hasContact && (
              <div>
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Contact</div>
                <div className="space-y-1.5">
                  {manager.primary_contact_email && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Email</span>
                      <a href={`mailto:${manager.primary_contact_email}`} className="font-mono text-[12px] text-slate-700 hover:text-slate-900 break-all">{manager.primary_contact_email}</a>
                    </div>
                  )}
                  {manager.phone_number && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Phone</span>
                      <span className="font-mono text-[12px] text-slate-700">{manager.phone_number}</span>
                    </div>
                  )}
                  {manager.website_url && (
                    <div className="flex gap-2"><span className="text-slate-500 w-20 shrink-0">Web</span>
                      <a href={manager.website_url} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] text-slate-700 hover:text-slate-900 underline break-all">{manager.website_url.replace(/^https?:\/\//, '')}</a>
                    </div>
                  )}
                </div>
              </div>
            )}
            {hasGeo && (
              <div>
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Headquarters</div>
                <div className="text-[12px] text-slate-700">
                  {[manager.headquarters_city, manager.headquarters_state, manager.headquarters_country].filter(Boolean).join(', ')}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Team members from enriched_managers — only if enrichment found people */}
      {Array.isArray(manager.team_members) && manager.team_members.length > 0 && (
        <section className="nport-panel mb-6">
          <div className="nport-panel-header">
            <h2 className="font-serif text-lg font-semibold text-slate-900">
              Team <span className="text-slate-400 text-sm font-normal ml-1">({manager.team_members.length})</span>
            </h2>
          </div>
          <div className="px-5 py-4 grid md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            {manager.team_members.map((m, i) => {
              // Enrichment sources use either `title` or `role` for the
              // person's role at the firm — accept both.
              const role = m.title || m.role;
              return (
                <div key={i} className="space-y-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-serif text-[13px] font-semibold text-slate-900">{m.name}</span>
                    <PersonContactButtons linkedin={m.linkedin || m.linkedin_url} email={m.email} />
                  </div>
                  {role && <div className="text-[11px] text-slate-500">{role}</div>}
                  {m.email && (
                    <a href={`mailto:${m.email}`} className="text-[11px] font-mono text-slate-600 hover:text-slate-900 break-all block">{m.email}</a>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {holders && holders.length > 0 && (
        <section className="nport-panel">
          <div className="nport-panel-header flex items-center justify-between">
            <h2 className="font-serif text-lg font-semibold text-slate-900">
              Form D filings <span className="text-slate-400 text-sm font-normal ml-1">({fmtInt(holders.length)})</span>
            </h2>
          </div>
          <div className="p-3">
            <ul className="divide-y divide-slate-100">
              {holders.map((h, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-2 px-2">
                  <div className="min-w-0 flex-1">
                    <a href={`/intel/fund/${encodeURIComponent(h.accession_number)}`}
                       className="text-[13px] font-serif font-semibold text-slate-900 hover:text-slate-700 hover:underline truncate block">
                      {h.filer_entityname}
                    </a>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {h.company_slug && <a href={`/intel/${encodeURIComponent(h.company_slug)}`} className="hover:text-slate-900 hover:underline">{h.company_slug}</a>}
                      {h.filing_date && <span className="ml-2">{fmtDate(h.filing_date)}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0 font-mono text-[12px] font-semibold text-slate-900 tabular-nums">
                    {fmtUsdShort(h.value_usd)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      </div>
    </AppShell>
  );
}

// ============================================================================
// CRM PAGES (added 2026-05-31)
// Personal CRM for tracking outreach to fund managers.
// API: /api/intel/crm/*. Schema: nport/migrations/010_crm_schema.sql.
// ============================================================================

const CRM_STATUSES = ['cold','researching','outreach_sent','responded','engaged','dormant'];
const CRM_PRIORITIES = [1, 2, 3, 4, 5];

// ----------------------------------------------------------------------------
// AddToCrmButton — reusable "Add manager-people to CRM" trigger for
// /intel/<slug>, /intel/discovered/<id>, /intel/adviser/<crd>.
// Two-step flow: preview (dry-run) → confirm (execute).
// ----------------------------------------------------------------------------
function AddToCrmButton({ kind, slug, crd, enrichedManagerId, label }) {
  const [open, setOpen] = React.useState(false);
  const [stage, setStage] = React.useState('idle'); // idle | preview | preview_done | executing | done | error
  const [preview, setPreview] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);

  const apiPath = kind === 'company' ? '/api/intel/crm/add-by-company' : '/api/intel/crm/add-by-firm';
  const apiBody = kind === 'company'
    ? { company_slug: slug }
    : crd ? { crd } : { enriched_manager_id: enrichedManagerId };

  async function runPreview() {
    setStage('preview');
    setError(null);
    try {
      const r = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...apiBody, execute: false }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setPreview(d);
      setStage('preview_done');
    } catch (e) {
      setError(String(e));
      setStage('error');
    }
  }

  async function runExecute() {
    setStage('executing');
    setError(null);
    try {
      const r = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...apiBody, execute: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResult(d);
      setStage('done');
    } catch (e) {
      setError(String(e));
      setStage('error');
    }
  }

  function openModal() {
    setOpen(true);
    setStage('idle');
    setPreview(null);
    setResult(null);
    setError(null);
    runPreview();
  }

  return (
    <>
      <button
        onClick={openModal}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400"
        title="Add the people we have contact info for at this firm / company's manager firms to the CRM"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
          <path d="M10 4a1 1 0 011 1v4h4a1 1 0 110 2h-4v4a1 1 0 11-2 0v-4H5a1 1 0 110-2h4V5a1 1 0 011-1z" />
        </svg>
        {label || 'Add to CRM'}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900 mb-3">Add to CRM</h3>
            {stage === 'preview' && <div className="text-sm text-slate-600">Computing preview…</div>}
            {stage === 'error' && (
              <div className="text-sm text-rose-700">Error: {error}</div>
            )}
            {stage === 'preview_done' && preview?.audit && (
              <div className="space-y-3">
                <div className="text-sm text-slate-700">This will add the following to your CRM:</div>
                <table className="text-[12px] w-full">
                  <tbody className="font-mono">
                    <tr><td className="text-slate-500 pr-3">Firms exposed</td><td className="font-semibold">{preview.audit.firms_total}</td></tr>
                    <tr><td className="text-slate-500 pr-3">People we have contact for</td><td className="font-semibold">{preview.audit.persons_after_filter}</td></tr>
                    <tr><td className="text-slate-500 pr-3">Filter</td><td>has email/linkedin/twitter</td></tr>
                  </tbody>
                </table>
                <div className="text-[11px] text-slate-500 italic">
                  Existing CRM rows won't be duplicated — re-running is idempotent.
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={runExecute}
                          className="px-3 py-1.5 text-[12px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800">
                    Confirm — add {preview.audit.persons_after_filter} people
                  </button>
                  <button onClick={() => setOpen(false)}
                          className="px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-900">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {stage === 'preview_done' && !preview?.audit && (
              <div className="text-sm text-slate-700">
                Preview not available — the seed script may not produce an audit JSON for this kind. Click below to proceed.
                <div className="mt-3">
                  <button onClick={runExecute} className="px-3 py-1.5 text-[12px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800">
                    Add to CRM
                  </button>
                </div>
              </div>
            )}
            {stage === 'executing' && <div className="text-sm text-slate-600">Adding to CRM…</div>}
            {stage === 'done' && (
              <div className="space-y-3">
                <div className="text-sm text-emerald-700 font-medium">✓ Added to CRM</div>
                {result?.audit && (
                  <table className="text-[12px] w-full font-mono">
                    <tbody>
                      <tr><td className="text-slate-500 pr-3">Firms upserted</td><td>{result.audit.firms_upserted ?? '—'}</td></tr>
                      <tr><td className="text-slate-500 pr-3">Persons upserted</td><td>{result.audit.persons_upserted ?? '—'}</td></tr>
                    </tbody>
                  </table>
                )}
                <div className="flex gap-2 pt-2">
                  <a href="/intel/crm" className="px-3 py-1.5 text-[12px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800 no-underline">
                    Open CRM
                  </a>
                  <button onClick={() => setOpen(false)}
                          className="px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-900">
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const fmtUsd = (v) => {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n >= 1e9) return `$${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
// NOTE: fmtDate is already defined at line 85 — re-using rather than re-declaring

function CrmPersonListPage() {
  const [rows, setRows] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [filters, setFilters] = React.useState({ status: '', priorityMax: '', tag: '', hasEmail: false });

  React.useEffect(() => {
    const p = new URLSearchParams({ limit: '500' });
    if (filters.status) p.set('status', filters.status);
    if (filters.priorityMax) p.set('priority_max', filters.priorityMax);
    if (filters.tag) p.set('tag', filters.tag);
    if (filters.hasEmail) p.set('has_email', '1');
    setLoading(true);
    fetch(`/api/intel/crm/people?${p.toString()}`)
      .then(r => r.json())
      .then(d => { setRows(d.rows || []); setTotal(d.total || 0); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [filters]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-semibold text-slate-900">CRM — People</h1>
          <div className="flex gap-2 text-sm">
            <a href="/intel/crm/deals" className="px-3 py-1 bg-white border border-slate-200 rounded hover:bg-slate-100">Deals view</a>
            <a href="/api/intel/crm/export.csv" className="px-3 py-1 bg-white border border-slate-200 rounded hover:bg-slate-100">Export CSV</a>
            <button onClick={() => alert('Use the python CLI for now: intelligence/crm/add_person.py')} className="px-3 py-1 bg-slate-900 text-white rounded hover:bg-slate-800">+ Add person</button>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded p-3 mb-4 flex flex-wrap gap-3 text-sm">
          <label>Status:&nbsp;
            <select value={filters.status} onChange={e => setFilters({...filters, status: e.target.value})} className="border border-slate-300 rounded px-2 py-0.5">
              <option value="">all</option>
              {CRM_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Priority ≤
            <select value={filters.priorityMax} onChange={e => setFilters({...filters, priorityMax: e.target.value})} className="border border-slate-300 rounded px-2 py-0.5 ml-1">
              <option value="">any</option>
              {CRM_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>Tag:&nbsp;
            <input type="text" value={filters.tag} onChange={e => setFilters({...filters, tag: e.target.value})} placeholder="e.g. anthropic"
                   className="border border-slate-300 rounded px-2 py-0.5 w-28" />
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={filters.hasEmail} onChange={e => setFilters({...filters, hasEmail: e.target.checked})} />
            has email
          </label>
          <span className="ml-auto text-slate-500">{total} {total === 1 ? 'person' : 'people'}</span>
        </div>
        {loading && <div className="text-slate-500 text-sm">Loading…</div>}
        {error && <div className="text-rose-600 text-sm">Error: {error}</div>}
        {!loading && !error && (
          <div className="bg-white border border-slate-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  <th className="text-left px-3 py-2">Person</th>
                  <th className="text-left px-3 py-2">Title</th>
                  <th className="text-left px-3 py-2">Firm</th>
                  <th className="text-left px-3 py-2">Channels</th>
                  <th className="text-left px-3 py-2">Exposure</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Pri</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.person_id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <a href={`/intel/crm/person/${r.person_id}`} className="font-medium text-slate-900 hover:text-blue-700 hover:underline">
                        {r.full_name || r.email || `Person ${r.person_id}`}
                      </a>
                      {r.do_not_contact && <span className="ml-2 text-xs text-rose-600 font-semibold">DNC</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{r.title || <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2">
                      {r.firm ? (
                        <span>
                          <span className="font-medium text-slate-800">{r.firm.display_name}</span>
                          {r.firm.website_url && <a href={r.firm.website_url} target="_blank" rel="noreferrer noopener" title="firm site" className="ml-1 text-slate-400 hover:text-slate-700">↗</a>}
                          {r.firm.linkedin_company_url && <a href={r.firm.linkedin_company_url} target="_blank" rel="noreferrer noopener" title="firm LinkedIn" className="ml-0.5 text-slate-400 hover:text-blue-600">in</a>}
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs space-x-1">
                      {r.email && <a href={`mailto:${r.email}`} className="text-blue-700 hover:underline">@</a>}
                      {r.linkedin_url && <a href={r.linkedin_url} target="_blank" rel="noreferrer noopener" className="text-blue-700 hover:underline">in</a>}
                      {r.twitter_handle && <a href={`https://twitter.com/${r.twitter_handle.replace(/^@/,'')}`} target="_blank" rel="noreferrer noopener" className="text-blue-700 hover:underline">tw</a>}
                      {r.phone && <span className="text-slate-600">☎</span>}
                      {!(r.email||r.linkedin_url||r.twitter_handle||r.phone) && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {r.firm ? <span>{r.firm.exposure_company_count || 0} cos · {fmtUsd((+r.firm.exposure_total_nport_usd||0))}</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="px-1.5 py-0.5 bg-slate-100 rounded">{r.engagement_status}</span>
                    </td>
                    <td className="px-3 py-2 text-center text-slate-700">{r.priority}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">No people in CRM yet. Use python intelligence/crm/add_by_tracked_company.py --company &lt;slug&gt; --execute</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CrmPersonDetailPage({ id }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [showInteraction, setShowInteraction] = React.useState(false);
  const [showDeal, setShowDeal] = React.useState(false);
  const [showFollowup, setShowFollowup] = React.useState(false);
  const reload = React.useCallback(() => {
    fetch(`/api/intel/crm/people/${id}`).then(r => r.json()).then(setData).catch(e => setError(String(e)));
  }, [id]);
  React.useEffect(() => { reload(); }, [reload]);

  if (error) return <div className="p-6 text-rose-600">Error: {error}</div>;
  if (!data) return <div className="p-6 text-slate-500">Loading…</div>;
  if (data.error) return <div className="p-6 text-rose-600">{data.error}</div>;

  const p = data.person;
  const f = data.firm;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <a href="/intel/crm" className="text-sm text-slate-500 hover:text-slate-700">← All people</a>
        <div className="mt-3 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold text-slate-900">{p.full_name || p.email || `Person ${p.person_id}`}</h1>
          <div className="text-sm text-slate-500">{p.title} {p.role && <>· {p.role}</>}</div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <section className="bg-white border border-slate-200 rounded p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Contact</h2>
            <dl className="text-sm space-y-1">
              <div className="flex gap-2"><dt className="text-slate-500 w-20">email:</dt><dd>{p.email ? <a href={`mailto:${p.email}`} className="text-blue-700 hover:underline">{p.email}</a> : '—'}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500 w-20">linkedin:</dt><dd>{p.linkedin_url ? <a href={p.linkedin_url} target="_blank" rel="noreferrer noopener" className="text-blue-700 hover:underline truncate">{p.linkedin_url}</a> : '—'}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500 w-20">twitter:</dt><dd>{p.twitter_handle ? <a href={`https://twitter.com/${p.twitter_handle.replace(/^@/,'')}`} target="_blank" rel="noreferrer noopener" className="text-blue-700 hover:underline">{p.twitter_handle}</a> : '—'}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500 w-20">phone:</dt><dd>{p.phone || '—'}</dd></div>
            </dl>
          </section>
          <section className="bg-white border border-slate-200 rounded p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Firm</h2>
            {f ? (
              <div className="text-sm space-y-1">
                <div className="font-medium text-slate-900">{f.display_name}</div>
                {f.website_url && <a href={f.website_url} target="_blank" rel="noreferrer noopener" className="block text-blue-700 hover:underline truncate">{f.website_url}</a>}
                {f.linkedin_company_url && <a href={f.linkedin_company_url} target="_blank" rel="noreferrer noopener" className="block text-blue-700 hover:underline truncate">{f.linkedin_company_url}</a>}
                <div className="text-slate-500 mt-1">{f.exposure_company_count || 0} tracked cos · {fmtUsd(f.exposure_total_nport_usd)} N-PORT · {fmtUsd(f.exposure_total_formd_usd)} Form D</div>
              </div>
            ) : <div className="text-slate-400 text-sm">No firm</div>}
          </section>
        </div>

        <section className="mt-4 bg-white border border-slate-200 rounded p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sm font-semibold text-slate-700">CRM state</h2>
          </div>
          <div className="text-sm flex flex-wrap gap-3 items-center">
            <span>Status: <span className="px-2 py-0.5 bg-slate-100 rounded">{p.engagement_status}</span></span>
            <span>Priority: <span className="font-semibold">{p.priority}</span></span>
            {p.do_not_contact && <span className="text-rose-700 font-semibold">DO NOT CONTACT{p.do_not_contact_reason ? ` — ${p.do_not_contact_reason}` : ''}</span>}
            {p.needs_compliance_review && <span className="text-amber-700 font-semibold">⚠ COMPLIANCE REVIEW</span>}
            <span>Added via: <span className="text-slate-600">{p.added_via}</span></span>
            {(p.added_for_companies || []).length > 0 && <span>For: {(p.added_for_companies || []).map(s => <a key={s} href={`/intel/${s}`} className="ml-1 text-blue-700 hover:underline">{s}</a>)}</span>}
          </div>
        </section>

        <section className="mt-4 bg-white border border-slate-200 rounded p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Timeline ({(data.interactions || []).length})</h2>
            <button onClick={() => setShowInteraction(true)} className="text-xs px-2 py-1 bg-slate-900 text-white rounded hover:bg-slate-800">+ Log event</button>
          </div>
          {(data.interactions || []).length === 0 && <div className="text-slate-400 text-sm">No interactions yet.</div>}
          <ul className="text-sm space-y-2">
            {(data.interactions || []).map(i => (
              <li key={i.interaction_id} className="border-l-2 border-slate-200 pl-3">
                <div className="flex gap-2 items-baseline">
                  <span className="text-xs text-slate-500">{fmtDate(i.occurred_at)}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${i.direction === 'outbound' ? 'bg-blue-100 text-blue-800' : i.direction === 'inbound' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{i.direction}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100">{i.channel}</span>
                  <span className="text-xs text-slate-500">{i.type}</span>
                  {i.outcome && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{i.outcome}</span>}
                </div>
                {i.subject && <div className="font-medium text-slate-800">{i.subject}</div>}
                {i.body && <div className="text-slate-700 whitespace-pre-wrap">{i.body}</div>}
                {i.related_company_slug && <div className="text-xs text-slate-500">re: <a href={`/intel/${i.related_company_slug}`} className="text-blue-700 hover:underline">{i.related_company_slug}</a></div>}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-4 bg-white border border-slate-200 rounded p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Deal interests ({(data.deal_interests || []).length})</h2>
            <button onClick={() => setShowDeal(true)} className="text-xs px-2 py-1 bg-slate-900 text-white rounded hover:bg-slate-800">+ Add deal interest</button>
          </div>
          {(data.deal_interests || []).length === 0 && <div className="text-slate-400 text-sm">No deal interests logged.</div>}
          <table className="w-full text-sm">
            <tbody>
              {(data.deal_interests || []).map(d => (
                <tr key={d.deal_interest_id} className="border-t border-slate-100">
                  <td className="py-1 pr-3"><a href={`/intel/${d.company_slug}`} className="text-blue-700 hover:underline">{d.company_slug}</a></td>
                  <td className="py-1 pr-3"><span className={d.side === 'buy' ? 'text-emerald-700 font-semibold' : d.side === 'sell' ? 'text-rose-700 font-semibold' : 'text-slate-700'}>{d.side}</span></td>
                  <td className="py-1 pr-3">{d.state}</td>
                  <td className="py-1 pr-3 text-slate-700">{d.price_per_share_min ? `$${d.price_per_share_min}` : '—'}{d.price_per_share_max && d.price_per_share_max !== d.price_per_share_min ? `–$${d.price_per_share_max}` : ''} / sh</td>
                  <td className="py-1 pr-3 text-slate-700">{fmtUsd(d.size_usd)}</td>
                  <td className="py-1 text-xs text-slate-500">{d.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-4 mb-8 bg-white border border-slate-200 rounded p-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Follow-ups ({(data.followups || []).filter(x => x.status === 'open').length} open)</h2>
            <button onClick={() => setShowFollowup(true)} className="text-xs px-2 py-1 bg-slate-900 text-white rounded hover:bg-slate-800">+ Schedule</button>
          </div>
          <ul className="text-sm space-y-1">
            {(data.followups || []).map(f => (
              <li key={f.followup_id} className={`flex gap-3 items-center ${f.status !== 'open' ? 'text-slate-400 line-through' : ''}`}>
                <span className="text-xs text-slate-500 w-20">{fmtDate(f.due_at)}</span>
                <span>{f.reason}</span>
                <span className="text-xs text-slate-500 ml-auto">{f.status}</span>
              </li>
            ))}
            {(data.followups || []).length === 0 && <div className="text-slate-400 text-sm">No followups scheduled.</div>}
          </ul>
        </section>

        {showInteraction && <InteractionModal personId={id} onClose={() => setShowInteraction(false)} onSaved={() => { setShowInteraction(false); reload(); }} />}
        {showDeal && <DealInterestModal personId={id} onClose={() => setShowDeal(false)} onSaved={() => { setShowDeal(false); reload(); }} />}
        {showFollowup && <FollowupModal personId={id} onClose={() => setShowFollowup(false)} onSaved={() => { setShowFollowup(false); reload(); }} />}
      </div>
    </div>
  );
}

function InteractionModal({ personId, onClose, onSaved }) {
  const [form, setForm] = React.useState({
    occurred_at: new Date().toISOString().slice(0, 16),
    direction: 'outbound', channel: 'email', type: 'intro',
    subject: '', body: '', outcome: '', sentiment: '', related_company_slug: '',
  });
  const submit = async () => {
    const payload = { ...form };
    if (form.occurred_at) payload.occurred_at = new Date(form.occurred_at).toISOString();
    Object.keys(payload).forEach(k => { if (payload[k] === '') delete payload[k]; });
    const r = await fetch(`/api/intel/crm/people/${personId}/interactions`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
    });
    if (!r.ok) { alert(`Error: ${await r.text()}`); return; }
    onSaved();
  };
  return (
    <Modal title="Log interaction" onClose={onClose} onSubmit={submit}>
      <Field label="When"><input type="datetime-local" value={form.occurred_at} onChange={e => setForm({...form, occurred_at: e.target.value})} /></Field>
      <Field label="Direction"><Select v={form.direction} on={v => setForm({...form, direction: v})} opts={['outbound','inbound','internal_note']} /></Field>
      <Field label="Channel"><Select v={form.channel} on={v => setForm({...form, channel: v})} opts={['email','linkedin_msg','twitter_dm','phone','meeting','sms','event','referral','note']} /></Field>
      <Field label="Type"><Select v={form.type} on={v => setForm({...form, type: v})} opts={['intro','followup','deal_pitch','response','meeting','call_summary','internal_note']} /></Field>
      <Field label="Subject"><input value={form.subject} onChange={e => setForm({...form, subject: e.target.value})} /></Field>
      <Field label="Body"><textarea value={form.body} onChange={e => setForm({...form, body: e.target.value})} rows={4} /></Field>
      <Field label="Outcome"><Select v={form.outcome} on={v => setForm({...form, outcome: v})} opts={['','sent','replied','no_reply','meeting_booked','interested','not_interested','out_of_scope','wrong_person']} /></Field>
      <Field label="Sentiment"><Select v={form.sentiment} on={v => setForm({...form, sentiment: v})} opts={['','positive','neutral','negative','no_signal']} /></Field>
      <Field label="Re: company (slug)"><input value={form.related_company_slug} onChange={e => setForm({...form, related_company_slug: e.target.value})} placeholder="anthropic" /></Field>
    </Modal>
  );
}

function DealInterestModal({ personId, onClose, onSaved }) {
  const [form, setForm] = React.useState({
    company_slug: '', side: 'buy', state: 'open',
    security_type: '', share_class: '', structure: '',
    price_per_share_min: '', price_per_share_max: '',
    size_usd: '', conditions: '', notes: '',
  });
  const submit = async () => {
    const payload = { ...form };
    Object.keys(payload).forEach(k => { if (payload[k] === '') delete payload[k]; });
    const r = await fetch(`/api/intel/crm/people/${personId}/deal-interests`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
    });
    if (!r.ok) { alert(`Error: ${await r.text()}`); return; }
    onSaved();
  };
  return (
    <Modal title="Log deal interest" onClose={onClose} onSubmit={submit}>
      <Field label="Company slug *"><input value={form.company_slug} onChange={e => setForm({...form, company_slug: e.target.value})} placeholder="anthropic" required /></Field>
      <Field label="Side"><Select v={form.side} on={v => setForm({...form, side: v})} opts={['buy','sell','either']} /></Field>
      <Field label="State"><Select v={form.state} on={v => setForm({...form, state: v})} opts={['open','soft','firm','matched','negotiating','passed','stale','compliance_review']} /></Field>
      <Field label="Security type"><input value={form.security_type} onChange={e => setForm({...form, security_type: e.target.value})} placeholder="common / preferred / SAFE / LP_interest" /></Field>
      <Field label="Share class"><input value={form.share_class} onChange={e => setForm({...form, share_class: e.target.value})} placeholder="Series F-1" /></Field>
      <Field label="Structure"><input value={form.structure} onChange={e => setForm({...form, structure: e.target.value})} placeholder="secondary / primary / SPV / forward / tender" /></Field>
      <Field label="Price/share min"><input type="number" step="any" value={form.price_per_share_min} onChange={e => setForm({...form, price_per_share_min: e.target.value})} /></Field>
      <Field label="Price/share max"><input type="number" step="any" value={form.price_per_share_max} onChange={e => setForm({...form, price_per_share_max: e.target.value})} /></Field>
      <Field label="Size $"><input type="number" step="any" value={form.size_usd} onChange={e => setForm({...form, size_usd: e.target.value})} /></Field>
      <Field label="Conditions"><textarea rows={2} value={form.conditions} onChange={e => setForm({...form, conditions: e.target.value})} /></Field>
      <Field label="Notes"><textarea rows={2} value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} /></Field>
    </Modal>
  );
}

function FollowupModal({ personId, onClose, onSaved }) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [form, setForm] = React.useState({ due_at: tomorrow, reason: '' });
  const submit = async () => {
    const payload = { due_at: new Date(form.due_at).toISOString(), reason: form.reason };
    const r = await fetch(`/api/intel/crm/people/${personId}/followups`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
    });
    if (!r.ok) { alert(`Error: ${await r.text()}`); return; }
    onSaved();
  };
  return (
    <Modal title="Schedule followup" onClose={onClose} onSubmit={submit}>
      <Field label="Due"><input type="date" value={form.due_at} onChange={e => setForm({...form, due_at: e.target.value})} /></Field>
      <Field label="Reason"><input value={form.reason} onChange={e => setForm({...form, reason: e.target.value})} required placeholder="30-day check-in" /></Field>
    </Modal>
  );
}

function CrmDealsPage() {
  const [rows, setRows] = React.useState([]);
  const [error, setError] = React.useState(null);
  const params = new URLSearchParams(window.location.search);
  const companyFilter = params.get('company') || '';
  React.useEffect(() => {
    const p = new URLSearchParams();
    if (companyFilter) p.set('company', companyFilter);
    fetch(`/api/intel/crm/deal-interests?${p.toString()}`)
      .then(r => r.json()).then(d => setRows(d.rows || []))
      .catch(e => setError(String(e)));
  }, [companyFilter]);

  // Group by company
  const byCompany = {};
  for (const r of rows) {
    if (!byCompany[r.company_slug]) byCompany[r.company_slug] = { buy: [], sell: [], either: [] };
    byCompany[r.company_slug][r.side].push(r);
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-6xl mx-auto px-4 py-6">
        <a href="/intel/crm" className="text-sm text-slate-500 hover:text-slate-700">← All people</a>
        <h1 className="text-2xl font-semibold text-slate-900 mt-3 mb-4">CRM — Deal interests by company</h1>
        {error && <div className="text-rose-600 text-sm">Error: {error}</div>}
        {Object.entries(byCompany).map(([slug, sides]) => (
          <div key={slug} className="bg-white border border-slate-200 rounded mb-4 p-4">
            <h2 className="font-semibold text-slate-900 mb-2"><a href={`/intel/${slug}`} className="hover:underline">{slug}</a></h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-700 mb-1">Buy ({sides.buy.length})</div>
                {sides.buy.sort((a,b) => (+b.price_per_share_max||0) - (+a.price_per_share_max||0)).map(d => (
                  <DealRow key={d.deal_interest_id} d={d} />
                ))}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-rose-700 mb-1">Sell ({sides.sell.length})</div>
                {sides.sell.sort((a,b) => (+a.price_per_share_min||9e9) - (+b.price_per_share_min||9e9)).map(d => (
                  <DealRow key={d.deal_interest_id} d={d} />
                ))}
              </div>
            </div>
          </div>
        ))}
        {!Object.keys(byCompany).length && <div className="text-slate-500">No open deal interests.</div>}
      </div>
    </div>
  );
}

function DealRow({ d }) {
  const p = d.crm_person || {};
  const f = d.crm_firm || {};
  return (
    <div className="text-sm border-l-2 border-slate-200 pl-2 mb-1">
      <div>
        <a href={`/intel/crm/person/${p.person_id}`} className="text-blue-700 hover:underline">{p.full_name || p.email || 'Unknown'}</a>
        {f.display_name && <span className="text-slate-500"> · {f.display_name}</span>}
      </div>
      <div className="text-xs text-slate-600">
        ${d.price_per_share_min || '—'}{d.price_per_share_max && d.price_per_share_max !== d.price_per_share_min ? `–$${d.price_per_share_max}` : ''} / sh
        {d.size_usd && ` · ${fmtUsd(d.size_usd)}`}
        <span className="ml-1 px-1 bg-slate-100 rounded">{d.state}</span>
      </div>
    </div>
  );
}

// Tiny modal + form helpers
function Modal({ title, onClose, onSubmit, children }) {
  return (
    <div className="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded shadow-xl p-5 max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>
        <div className="space-y-2">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 text-sm border border-slate-300 rounded hover:bg-slate-100">Cancel</button>
          <button onClick={onSubmit} className="px-3 py-1 text-sm bg-slate-900 text-white rounded hover:bg-slate-800">Save</button>
        </div>
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return <label className="block text-sm"><span className="block text-xs text-slate-500 mb-0.5">{label}</span>{React.cloneElement(children, { className: 'w-full border border-slate-300 rounded px-2 py-1 text-sm' })}</label>;
}
function Select({ v, on, opts }) {
  return <select value={v} onChange={e => on(e.target.value)}>{opts.map(o => <option key={o} value={o}>{o || '—'}</option>)}</select>;
}

// --- bootstrap --------------------------------------------------------------

window.mountIntelRouter = function () {
  const path = window.location.pathname;
  const root = document.getElementById('root');
  if (!root) return false;

  // Reserved cross-cutting routes — must come BEFORE the generic
  // /intel/<slug> match so they don't get swallowed.
  // Order matters: more-specific routes first.
  const routes = [
    { match: /^\/intel\/?$/, render: () => <DashboardPage /> },
    { match: /^\/intel\/search\/?$/, render: () => {
      const params = new URLSearchParams(window.location.search);
      return <SearchPage initialQuery={params.get('q') || ''} />;
    } },
    { match: /^\/intel\/companies\/?$/, render: () => <AllCompaniesPage /> },
    { match: /^\/intel\/managers\/?$/, render: () => <AllManagersPage /> },
    { match: /^\/intel\/funds\/?$/, render: () => <AllFundsPage /> },
    { match: /^\/intel\/spvs\/?$/, render: () => <AllSpvsPage /> },
    { match: /^\/intel\/people\/?$/, render: () => <PeoplePage /> },
    { match: /^\/intel\/timeline\/?$/, render: () => <TimelinePage /> },
    // CRM routes (more-specific than the generic /intel/<slug>)
    { match: /^\/intel\/crm\/?$/, render: () => <CrmPersonListPage /> },
    { match: /^\/intel\/crm\/deals\/?$/, render: () => <CrmDealsPage /> },
    { match: /^\/intel\/crm\/person\/([^\/]+)/, render: (m) => <CrmPersonDetailPage id={decodeURIComponent(m[1])} /> },
    { match: /^\/intel\/fund\/([^\/]+)/, render: (m) => <FundPage accession={decodeURIComponent(m[1])} /> },
    { match: /^\/intel\/adviser\/([^\/]+)/, render: (m) => <AdviserPage crd={decodeURIComponent(m[1])} /> },
    { match: /^\/intel\/discovered\/([^\/]+)/, render: (m) => <DiscoveredPage id={decodeURIComponent(m[1])} /> },
    // Catch-all: any other /intel/<slug> is a company page.
    { match: /^\/intel\/([^\/]+)/, render: (m) => <IntelPage slug={decodeURIComponent(m[1])} /> },
  ];

  for (const route of routes) {
    const m = path.match(route.match);
    if (m) {
      ReactDOM.createRoot(root).render(route.render(m));
      return true;
    }
  }
  return false;
};
