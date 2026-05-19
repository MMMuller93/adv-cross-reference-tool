#!/usr/bin/env node
/**
 * IAPD CRD lookup — searches https://adviserinfo.sec.gov for a firm name and
 * returns the candidate CRD(s). Mirrors PFR's existing scripts/iapd_validator.js
 * but is callable from Python via stdin/stdout JSON. One launch handles many
 * queries (so we amortize the Chromium boot cost).
 *
 * USAGE:
 *
 *   # Single query (CLI)
 *   node iapd_scraper.js "AUGUREY VENTURES"
 *
 *   # Batch (JSON line on stdin)
 *   echo '{"names":["A","B"]}' | node iapd_scraper.js --stdin
 *
 *   # Optional flags
 *   --headed              (debug — show browser window)
 *   --delay-ms <n>        (between queries, default 2000)
 *
 * OUTPUT (stdout, JSON):
 *   {"results":[
 *      {"query":"AUGUREY VENTURES","count":N,"firms":[{"name":...,"crd":...}],"error":null},
 *      ...
 *   ]}
 *
 * Designed to be reused by iapd_bridge.py via subprocess.
 */

const { chromium } = require('playwright');
const fs = require('fs');

async function searchIAPD(page, firmName) {
  try {
    await page.goto('https://adviserinfo.sec.gov/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Click FIRM tab if present.
    const firmTab = await page.$('text=FIRM');
    if (firmTab) await firmTab.click();
    await page.waitForTimeout(500);

    // Index 3 = firm-name input (matches PFR's iapd_validator.js).
    const inputs = await page.$$('input');
    if (inputs.length >= 4) {
      await inputs[3].fill('');
      await inputs[3].fill(firmName);
    } else {
      return { count: 0, firms: [], error: 'firm input not found' };
    }

    // The second Search button is for the firm form.
    const searchBtns = await page.$$('button:has-text("Search"), button:has-text("SEARCH")');
    if (searchBtns.length >= 2) {
      await searchBtns[1].click();
    } else if (searchBtns.length === 1) {
      await searchBtns[0].click();
    } else {
      return { count: 0, firms: [], error: 'search button not found' };
    }

    await page.waitForTimeout(4000);

    const parsed = await page.evaluate(() => {
      const text = document.body.innerText;
      const countMatch = text.match(/We found (\d+) results?/i);
      const count = countMatch ? parseInt(countMatch[1], 10) : 0;

      // Walk lines collecting candidate firm name immediately above a CRD line.
      const lines = text.split('\n');
      const firms = [];
      let currentFirm = null;
      for (const raw of lines) {
        const line = raw.trim();
        const crdMatch = line.match(/CRD#:\s*(\d+)/);
        if (crdMatch) {
          if (currentFirm) {
            firms.push({ name: currentFirm, crd: crdMatch[1] });
          }
          currentFirm = null;
          continue;
        }
        if (!line || line.length < 3 || line.length > 120) continue;
        if (/Investment Adviser|Form ADV|SEARCH|City, State/i.test(line)) continue;
        // Treat any line that looks like a firm name (mostly caps, or with
        // entity suffix) as a candidate. False positives are filtered by the
        // CRD-pairing rule above.
        if (/LLC|LP|L\.P\.|INC|LTD|CORP|CO\.|GROUP|MANAGEMENT|CAPITAL|VENTURES|ADVISORS|PARTNERS|FUND/i.test(line)
            || /^[A-Z][A-Z0-9\s,\.&'()\-]+$/.test(line)) {
          currentFirm = line;
        }
      }
      return { count, firms: firms.slice(0, 10) };
    });

    return { count: parsed.count, firms: parsed.firms, error: null };
  } catch (e) {
    return { count: 0, firms: [], error: String(e && e.message ? e.message : e) };
  }
}

async function run(names, opts) {
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    process.stderr.write(`[${i + 1}/${names.length}] ${name}\n`);
    const r = await searchIAPD(page, name);
    results.push({ query: name, ...r });
    process.stderr.write(
      `   -> count=${r.count}${r.firms.length ? ` first=${r.firms[0].name} (CRD ${r.firms[0].crd})` : ''}${r.error ? ` ERR=${r.error}` : ''}\n`,
    );
    if (i < names.length - 1) await page.waitForTimeout(opts.delayMs);
  }

  await browser.close();
  return results;
}

(async function main() {
  const argv = process.argv.slice(2);
  const opts = { headed: false, delayMs: 2000 };
  const positional = [];
  let useStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') useStdin = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--delay-ms') opts.delayMs = parseInt(argv[++i], 10) || 2000;
    else positional.push(a);
  }

  let names = [];
  if (useStdin) {
    const raw = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(raw);
    names = (payload.names || []).filter((n) => typeof n === 'string' && n.trim());
  } else if (positional.length) {
    names = [positional.join(' ')];
  } else {
    console.error(
      'Usage: node iapd_scraper.js "Firm Name"\n       echo \'{"names":["A","B"]}\' | node iapd_scraper.js --stdin',
    );
    process.exit(2);
  }

  const results = await run(names, opts);
  process.stdout.write(JSON.stringify({ results }, null, 2));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
