#!/usr/bin/env node
// Front door. One container holds every report published under reports/: per repository, the
// standing latent-defect scan and one review per pull request, each with the gold traces it was
// written from. A visitor picks an entry; the choice is a cookie, so each browser has its own and
// the query UI's absolute links keep working unchanged. Each entry gets its own `appmap query ui`,
// started on first use and stopped when idle. Listens on 0.0.0.0:$PORT, serves the report page,
// and proxies everything else to the selected entry's query UI. No AI, no credentials: every page
// is rendered from files committed in the repository.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const BUILD = process.env.BUILD || path.join(__dirname, 'build');
const IDLE_MS = Number(process.env.IDLE_MINUTES || 20) * 60000;
const COOKIE = 'appmap_entry';
// Set FRAME_ANCESTORS to the origin(s) allowed to embed the app (e.g. a Confluence site);
// empty means any page may frame it.
const FRAME_ANCESTORS = (process.env.FRAME_ANCESTORS || '').trim();

const BAR_TAG = '<script src="/bar.js" defer></script>';
const withBar = (html) => (html.includes('</body>') ? html.replace('</body>', BAR_TAG + '</body>') : html + BAR_TAG);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const BAR_JS = read('bar.js');
const REVIEW_TEMPLATE = read('review.html');
const SCAN_TEMPLATE = read('scan.html');
const SEV = { 3: '\u{1F534} High', 2: '\u{1F7E1} Medium', 1: '\u{1F7E2} Low' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ENTRIES = JSON.parse(fs.readFileSync(path.join(BUILD, 'entries.json'), 'utf8'));
if (!ENTRIES.length) throw new Error(`no entries in ${BUILD}/entries.json; publish at least one repository under reports/`);
const byId = new Map(ENTRIES.map((e) => [e.id, e]));
// Land new visitors on the most severe pull request review, or the first entry.
const DEFAULT_ENTRY = process.env.ENTRY
  || [...ENTRIES].filter((e) => e.kind === 'pr').sort((a, b) => (b.severity || 0) - (a.severity || 0))[0]?.id
  || ENTRIES[0].id;
if (!byId.has(DEFAULT_ENTRY)) throw new Error(`default entry ${DEFAULT_ENTRY} is not in ${BUILD}/entries.json`);

// Per-entry pages, rendered once.
ENTRIES.forEach((e, i) => {
  e.uiPort = 3001 + i;
  e.tracesDir = path.join(BUILD, e.id, 'traces');
  e.hasTraces = e.recordings > 0 && fs.existsSync(e.tracesDir);
  const build = (f) => path.join(BUILD, e.id, f);
  // Reports link files relative to the checkout they were written in; point them at the commit.
  const commit = e.kind === 'pr' ? e.head.commit : e.commit;
  const absolutize = (html) => html.replace(/href="(?!https?:|#|\/|mailto:)([^"]+)"/g, (m, p) => `href="${e.repoUrl}/blob/${commit || 'HEAD'}/${p}" target="_blank"`);
  // GitHub folds the review detail (coverage matrix, drift); here it is the point, so open it.
  const body = (f) => (fs.existsSync(build(f)) ? absolutize(fs.readFileSync(build(f), 'utf8')).replace(/<details>/g, '<details open>') : '');
  const common = (html) => html
    .replace(/__REPO__/g, esc(e.repo))
    .replace(/__REPO_URL__/g, esc(e.repoUrl))
    .replace(/__LANGUAGE__/g, esc(e.language))
    .replace(/__SEVERITY__/g, esc(SEV[e.severity] || 'no findings'))
    .replace(/__RECORDINGS__/g, String(e.recordings))
    .replace(/__ID__/g, esc(e.id));
  if (e.kind === 'pr') {
    e.pageHtml = withBar(common(REVIEW_TEMPLATE)
      .replace(/__PR__/g, esc(String(e.pr)))
      .replace(/__PR_URL__/g, esc(e.url))
      .replace(/__PR_TITLE__/g, esc(e.title))
      .replace(/__DATE__/g, esc(e.date))
      .replace(/__BASE__/g, esc(e.base.commit.slice(0, 10)))
      .replace(/__BASE_NOTE__/g, esc(e.base.note))
      .replace(/__HEAD__/g, esc(e.head.commit.slice(0, 10)))
      .replace(/__HEAD_NOTE__/g, esc(e.head.note))
      .replace(/__PER_SIDE__/g, `${e.perSide.base} base, ${e.perSide.head} head`)
      .replace('__REPORT_BODY__', () => body('report.html')));
  } else {
    const findings = fs.existsSync(build('findings.yml')) ? fs.readFileSync(build('findings.yml'), 'utf8') : '';
    e.pageHtml = withBar(common(SCAN_TEMPLATE)
      .replace(/__BRANCH__/g, esc(e.branch || 'main'))
      .replace(/__COMMIT__/g, esc((e.commit || '').slice(0, 10)))
      .replace(/__DATE__/g, esc(e.date))
      .replace(/__NOTE__/g, esc(e.note))
      .replace(/__STATE__/g, e.hasReport ? 'report' : 'placeholder')
      .replace('__FINDINGS_YML__', () => esc(findings))
      .replace('__REPORT_BODY__', () => body('report.html')));
  }
});

// An entry's query UI: spawned on first request, killed after IDLE_MS without one.
class Ui {
  constructor(e) { this.e = e; this.proc = null; this.ready = null; this.timer = null; }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), IDLE_MS);
    if (!this.proc) this.start();
    return this.ready;
  }
  start() {
    console.log(`starting query ui for ${this.e.id} on :${this.e.uiPort}`);
    this.proc = spawn('appmap', ['query', 'ui', '--appmap-dir', this.e.tracesDir, '--port', String(this.e.uiPort), '--no-open'], { stdio: ['ignore', 'inherit', 'inherit'] });
    this.proc.on('exit', (code) => { console.error(`query ui ${this.e.id} exited with ${code}`); this.proc = null; this.ready = null; });
    this.ready = this.waitForPort();
  }
  stop() { if (this.proc) { console.log(`stopping idle query ui for ${this.e.id}`); this.proc.kill('SIGTERM'); } }
  waitForPort(attempts = 100) {
    return new Promise((resolve, reject) => {
      const tryOnce = (n) => {
        const s = http.get({ host: '127.0.0.1', port: this.e.uiPort, path: '/api/dashboard' }, (r) => { r.resume(); resolve(); });
        s.on('error', () => (n > 0 && this.proc ? setTimeout(() => tryOnce(n - 1), 200) : reject(new Error('query ui did not start'))));
      };
      tryOnce(attempts);
    });
  }
}
const uis = new Map(ENTRIES.filter((e) => e.hasTraces).map((e) => [e.id, new Ui(e)]));

function currentEntry(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return (m && byId.get(decodeURIComponent(m[1]))) || byId.get(DEFAULT_ENTRY);
}
// Over https the cookie is SameSite=None so the app keeps working inside a wiki page's iframe.
function setCookie(id, req) {
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; ${https ? 'SameSite=None; Secure' : 'SameSite=Lax'}`;
}

// Proxy to the entry's query UI. HTML pages get the picker bar appended.
async function proxy(req, res, e) {
  const ui = uis.get(e.id);
  if (!ui) { res.writeHead(302, { location: '/review' }); res.end(); return; }
  try { await ui.touch(); } catch (err) {
    res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' });
    res.end('The query UI is still starting. Refresh in a moment.\n');
    return;
  }
  const headers = { ...req.headers };
  delete headers['accept-encoding'];
  const upstream = http.request(
    { host: '127.0.0.1', port: e.uiPort, method: req.method, path: req.url, headers },
    (up) => {
      const type = up.headers['content-type'] || '';
      const h = { ...up.headers, ...frameHeaders() };
      if (!type.startsWith('text/html')) {
        res.writeHead(up.statusCode || 502, h);
        up.pipe(res);
        return;
      }
      const chunks = [];
      up.on('data', (ch) => chunks.push(ch));
      up.on('end', () => {
        const body = withBar(Buffer.concat(chunks).toString('utf8'));
        h['content-length'] = Buffer.byteLength(body);
        delete h['transfer-encoding'];
        res.writeHead(up.statusCode || 502, h);
        res.end(body);
      });
    }
  );
  upstream.on('error', () => {
    res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' });
    res.end('The query UI is still starting. Refresh in a moment.\n');
  });
  req.pipe(upstream);
}

// Embedding: the app is meant to be linked or framed from a wiki page. Restrict framing only when asked.
function frameHeaders() {
  return FRAME_ANCESTORS ? { 'content-security-policy': `frame-ancestors ${FRAME_ANCESTORS}` } : {};
}
const html = (res, body, extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...frameHeaders(), ...extra }); res.end(body); };
const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(JSON.stringify(obj)); };
const publicEntry = (e) => ({
  id: e.id, kind: e.kind, repo: e.repo, repoUrl: e.repoUrl, language: e.language, title: e.title, pr: e.pr, url: e.url, date: e.date,
  severity: e.severity, recordings: e.recordings, hasTraces: e.hasTraces, hasReport: e.kind === 'pr' ? true : e.hasReport,
  base: e.base && e.base.commit, head: e.head && e.head.commit, commit: e.commit, branch: e.branch,
});

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/$/, '') || '/';
    const e = currentEntry(req);

    // /e/<repo>/<entry>[?to=/path] selects an entry for this browser. Shareable: it lands on the report.
    const pick = p.match(/^\/e\/([a-z0-9._-]+\/[a-z0-9._-]+)$/i);
    if (pick) {
      const chosen = byId.get(pick[1]);
      if (!chosen) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no such entry\n'); return; }
      const to = url.searchParams.get('to');
      const dest = to && to.startsWith('/') && !to.startsWith('//') && (chosen.hasTraces || to === '/review') ? to : '/review';
      res.writeHead(302, { location: dest, 'set-cookie': setCookie(chosen.id, req) });
      res.end();
      return;
    }
    if (p === '/review' || p === '/report') { html(res, e.pageHtml, { 'set-cookie': setCookie(e.id, req) }); return; }
    if (p === '/bar.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(BAR_JS);
      return;
    }
    if (p === '/api/entries') { json(res, { current: e.id, entries: ENTRIES.map(publicEntry) }); return; }
    if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    proxy(req, res, e);
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`listening on http://0.0.0.0:${PORT}/review with ${ENTRIES.length} entries`);
    const u = uis.get(DEFAULT_ENTRY);
    if (u) u.touch().catch(() => {});
  });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const u of uis.values()) u.stop();
    process.exit(0);
  });
}
