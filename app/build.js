#!/usr/bin/env node
// Build-time preparation of everything under reports/: one indexed trace directory per entry
// (a pull request review, or a repository's latent-defect scan), the report rendered to HTML,
// and entries.json with the metadata the server and the pages need.
//
//   node build.js reports build
//
// Layout consumed (see README.md, "What a CI job publishes"):
//
//   reports/<repo>/repo.json                 { name, url, language, defaultBranch }
//   reports/<repo>/pr-<n>/review.json        { pr, title, url, date, base: {commit, note}, head: {commit, note} }
//   reports/<repo>/pr-<n>/REVIEW.md          the appmap-review report, as posted on the pull request
//   reports/<repo>/pr-<n>/base/**.appmap.json  gold traces recorded on the base commit
//   reports/<repo>/pr-<n>/head/**.appmap.json  gold traces recorded on the head commit
//   reports/<repo>/scan/scan.json            { commit, date, note }
//   reports/<repo>/scan/SCAN.md              the appmap-scan report over the default branch
//   reports/<repo>/scan/findings.yml         scan state (rendered verbatim for now)
//   reports/<repo>/scan/appmaps/**.appmap.json  the gold traces + probes the scan read
//
// Recordings copied here were made in CI on a checkout, but the query UI groups and compares by
// metadata.git.branch, so every recording is stamped with the side it belongs to.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [reportsDir, outDir] = process.argv.slice(2);
if (!reportsDir || !outDir) {
  console.error('usage: build.js <reports-dir> <out-dir>');
  process.exit(1);
}

const LANGUAGE = { java: 'Java', ruby: 'Ruby', python: 'Python', javascript: 'Node', typescript: 'Node' };

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.appmap.json')) yield p;
  }
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = (f) => fs.existsSync(f);

// Highest severity in a report: 3 red, 2 yellow, 1 green, 0 none. The summary table
// ("| 🔴 High | 1 |") wins; otherwise the severity words in finding headings.
function severity(report) {
  const table = (emoji, word) => new RegExp(`\\|\\s*${emoji}\\s*${word}\\s*\\|\\s*([0-9]+)`, 'i').exec(report);
  for (const [n, emoji, word] of [[3, '🔴', 'High'], [2, '🟡', 'Medium'], [1, '🟢', 'Low']]) {
    const m = table(emoji, word);
    if (m && Number(m[1]) > 0) return n;
  }
  const rank = { high: 3, medium: 2, low: 1 };
  let best = 0;
  for (const m of report.matchAll(/^#{2,4} .*?\b(?:🔴|🟡|🟢)\s*(HIGH|MEDIUM|LOW)\b/gm)) best = Math.max(best, rank[m[1].toLowerCase()]);
  for (const m of report.matchAll(/^#{2,4} .*?\((high|medium|low)\b/gim)) best = Math.max(best, rank[m[1].toLowerCase()]);
  return best;
}

// Copy every recording under `from` into `traces/<side>/`, stamped with the side, and
// return how many were copied and the language seen.
function copySide(from, traces, side, commit, repoUrl) {
  let n = 0;
  let language = '';
  for (const file of walk(from)) {
    const appmap = readJson(file);
    appmap.metadata = appmap.metadata || {};
    language = language || (appmap.metadata.language && appmap.metadata.language.name) || '';
    appmap.metadata.git = { repository: repoUrl, branch: side, commit: commit || side };
    appmap.metadata.name = `[${side}] ${appmap.metadata.name || path.basename(file, '.appmap.json')}`;
    // Keep the path below the side so subprojects in a monorepo stay distinct.
    const dest = path.join(traces, side, path.relative(from, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(appmap));
    n++;
  }
  return { n, language };
}

function render(md, out) {
  execFileSync('marked', ['--gfm', '-i', md, '-o', out]);
}

const entries = [];
for (const repoSlug of fs.readdirSync(reportsDir).sort()) {
  const repoDir = path.join(reportsDir, repoSlug);
  if (!exists(path.join(repoDir, 'repo.json'))) continue;
  const repo = { slug: repoSlug, defaultBranch: 'main', ...readJson(path.join(repoDir, 'repo.json')) };
  const repoUrl = repo.url || `https://github.com/${repo.name}`;

  // The standing latent-defect report. Always one entry per repository; without a scan/ directory
  // it is a placeholder the server renders from the template alone.
  {
    const scanDir = path.join(repoDir, 'scan');
    const id = `${repoSlug}/scan`;
    const out = path.join(outDir, repoSlug, 'scan');
    fs.mkdirSync(out, { recursive: true });
    const meta = exists(path.join(scanDir, 'scan.json')) ? readJson(path.join(scanDir, 'scan.json')) : null;
    const hasReport = exists(path.join(scanDir, 'SCAN.md'));
    let recordings = 0;
    let language = '';
    if (exists(path.join(scanDir, 'appmaps'))) {
      const r = copySide(path.join(scanDir, 'appmaps'), path.join(out, 'traces'), repo.defaultBranch, meta && meta.commit, repoUrl);
      recordings = r.n; language = r.language;
      if (recordings) execFileSync('appmap', ['index', '--appmap-dir', path.join(out, 'traces')], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    if (hasReport) { render(path.join(scanDir, 'SCAN.md'), path.join(out, 'report.html')); fs.copyFileSync(path.join(scanDir, 'SCAN.md'), path.join(out, 'REPORT.md')); }
    if (exists(path.join(scanDir, 'findings.yml'))) fs.copyFileSync(path.join(scanDir, 'findings.yml'), path.join(out, 'findings.yml'));
    const report = hasReport ? fs.readFileSync(path.join(scanDir, 'SCAN.md'), 'utf8') : '';
    entries.push({
      id, kind: 'scan', repo: repo.name, repoSlug, repoUrl, language: LANGUAGE[language.toLowerCase()] || language || repo.language || '',
      title: `Latent defects on ${repo.defaultBranch}`, branch: repo.defaultBranch,
      commit: (meta && meta.commit) || '', date: (meta && meta.date) || '', note: (meta && meta.note) || '',
      hasReport, hasFindings: exists(path.join(scanDir, 'findings.yml')), recordings, severity: hasReport ? severity(report) : 0,
    });
    console.log(`${id}: ${hasReport ? 'report' : 'placeholder'}, ${recordings} recordings`);
  }

  // One entry per reviewed pull request.
  for (const name of fs.readdirSync(repoDir).sort()) {
    const dir = path.join(repoDir, name);
    if (!/^pr-\d+/.test(name) || !exists(path.join(dir, 'review.json')) || !exists(path.join(dir, 'REVIEW.md'))) continue;
    const meta = readJson(path.join(dir, 'review.json'));
    const id = `${repoSlug}/${name}`;
    const out = path.join(outDir, repoSlug, name);
    const traces = path.join(out, 'traces');
    const base = copySide(path.join(dir, 'base'), traces, 'base', meta.base && meta.base.commit, repoUrl);
    const head = copySide(path.join(dir, 'head'), traces, 'head', meta.head && meta.head.commit, repoUrl);
    const recordings = base.n + head.n;
    if (!recordings) { console.error(`${id}: no recordings, skipped`); continue; }
    execFileSync('appmap', ['index', '--appmap-dir', traces], { stdio: ['ignore', 'ignore', 'inherit'] });
    render(path.join(dir, 'REVIEW.md'), path.join(out, 'report.html'));
    fs.copyFileSync(path.join(dir, 'REVIEW.md'), path.join(out, 'REPORT.md'));
    const language = base.language || head.language;
    entries.push({
      id, kind: 'pr', repo: repo.name, repoSlug, repoUrl, language: LANGUAGE[language.toLowerCase()] || language || repo.language || '',
      pr: meta.pr, title: meta.title || `Pull request ${meta.pr}`, url: meta.url || `${repoUrl}/pull/${meta.pr}`, date: meta.date || '',
      base: { commit: (meta.base && meta.base.commit) || '', note: (meta.base && meta.base.note) || '' },
      head: { commit: (meta.head && meta.head.commit) || '', note: (meta.head && meta.head.note) || '' },
      recordings, perSide: { base: base.n, head: head.n },
      severity: severity(fs.readFileSync(path.join(dir, 'REVIEW.md'), 'utf8')),
    });
    console.log(`${id}: ${recordings} recordings (${base.n} base, ${head.n} head)`);
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'entries.json'), JSON.stringify(entries, null, 2));
console.log(`${entries.length} entries -> ${outDir}/entries.json`);
