// Entry bar. Injected into every page (the query UI via the proxy, the report page directly).
// A fixed banner across the top: which repository and pull request the recordings on this page
// belong to (so "base" and "head" in Compare always have a name), and a picker listing every
// published report, grouped by repository: the standing latent-defect scan first, then one
// review per pull request, most severe first. Switching sets the server-side cookie for this
// browser and reloads the same page against the other entry's recordings.
(function () {
  if (window.__appmapBar) return;
  window.__appmapBar = true;

  const BAR = 40;
  const MOBILE = 820;
  const DOT = { 3: '\u{1F534} ', 2: '\u{1F7E1} ', 1: '\u{1F7E2} ' };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const bar = document.createElement('div');
  bar.id = 'appmap-bar';
  const root = bar.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; position: fixed; top: 0; left: 0; right: 0; height: ${BAR}px; z-index: 2147483000; display: flex; align-items: center; gap: .8rem; padding: 0 1rem; box-sizing: border-box; background: #0b1220; color: #e5e7eb; border-bottom: 1px solid #1f2937; font: 13px/1.2 system-ui, -apple-system, Segoe UI, sans-serif; white-space: nowrap; }
  b { color: #fff; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
  select { max-width: 34rem; min-width: 0; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: .4rem; padding: .3rem .5rem; font: inherit; }
  .tag { font-size: 11px; padding: .1rem .45rem; border-radius: 999px; border: 1px solid #374151; color: #d1d5db; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #d1d5db; }
  .who { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .grow { flex: 1; }
  @media (max-width: ${MOBILE}px) { :host { gap: .5rem; padding: 0 .75rem; font-size: 12px; } .who, .tag { display: none; } select { max-width: 100%; flex: 1; } }
</style>
<select id="entries" title="Report"></select><span class="tag" id="tag"></span><span class="who" id="who"></span><span class="grow"></span><a href="/review" id="report">Report</a>`;
  document.documentElement.appendChild(bar);
  document.documentElement.style.marginTop = BAR + 'px';

  const $ = (id) => root.getElementById(id);
  const picker = $('entries');
  picker.onchange = () => { location.href = '/e/' + picker.value + '?to=' + encodeURIComponent(location.pathname); };

  const label = (e) => e.kind === 'scan'
    ? (DOT[e.severity] || '') + 'Latent defects on ' + (e.repo.split('/').pop()) + (e.hasReport ? '' : ' (no scan yet)')
    : (DOT[e.severity] || '') + 'PR #' + e.pr + ': ' + e.title;

  fetch('/api/entries').then((r) => r.json()).then((d) => {
    const groups = new Map();
    for (const e of d.entries) { if (!groups.has(e.repo)) groups.set(e.repo, []); groups.get(e.repo).push(e); }
    for (const [repo, es] of groups) {
      const g = document.createElement('optgroup'); g.label = repo;
      es.sort((a, b) => (a.kind === 'scan' ? -1 : b.kind === 'scan' ? 1 : (b.severity || 0) - (a.severity || 0) || (b.pr || 0) - (a.pr || 0)));
      for (const e of es) { const o = document.createElement('option'); o.value = e.id; o.textContent = label(e); o.selected = e.id === d.current; g.appendChild(o); }
      picker.appendChild(g);
    }
    const cur = d.entries.find((e) => e.id === d.current);
    if (!cur) return;
    const short = (s) => (s || '').slice(0, 7);
    if (cur.kind === 'pr') {
      $('who').innerHTML = '<b>' + esc(cur.repo) + '</b> <a href="' + esc(cur.url) + '" target="_blank">#' + cur.pr + '</a>' +
        ' · <code>base</code> = ' + short(cur.base) + ' → <code>head</code> = ' + short(cur.head) + ' · ' + cur.recordings + ' recordings';
    } else {
      $('who').innerHTML = '<b>' + esc(cur.repo) + '</b> latent defects' + (cur.commit ? ' · <code>' + short(cur.commit) + '</code>' : '') + (cur.recordings ? ' · ' + cur.recordings + ' recordings' : '');
    }
    $('tag').textContent = ({ 3: 'high', 2: 'medium', 1: 'low' }[cur.severity] || (cur.hasReport ? 'no findings' : 'pending')) + (cur.language ? ' · ' + cur.language : '');
  }).catch(() => {});

  // The query UI's own nav has no idea about the report; add it.
  function addNavLink() {
    const nav = document.querySelector('nav');
    if (!nav || nav.querySelector('a[href="/review"]')) return;
    const dash = nav.querySelector('a[href="/"]');
    if (!dash) return;
    const a = dash.cloneNode(true); a.href = '/review'; a.textContent = 'Report';
    a.className = dash.className.replace(/\bbg-\S+|\btext-white\b/g, '').trim();
    dash.parentNode.insertBefore(a, dash);
  }
  // Every entry is recorded as branches "base" and "head"; prefill Compare so nobody has to know that.
  function prefillCompare() {
    if (location.pathname.replace(/\/$/, '') !== '/compare') return;
    const inputs = document.querySelectorAll('main input');
    if (inputs.length < 2 || inputs[0].value || inputs[1].value) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    [['base', inputs[0]], ['head', inputs[1]]].forEach(([v, i]) => {
      setter.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  addNavLink(); prefillCompare();
  new MutationObserver(() => { addNavLink(); prefillCompare(); }).observe(document.documentElement, { childList: true, subtree: true });
})();
