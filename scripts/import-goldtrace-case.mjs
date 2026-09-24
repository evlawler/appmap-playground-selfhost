#!/usr/bin/env node
// Import a case from goldtrace-examples as a pull request review entry under reports/.
// Demo data only: a CI job publishing its own review writes the same layout directly.
//
//   node scripts/import-goldtrace-case.mjs <path to case dir> [pr number]
//
// Reads the case README's indented header (upstream, BASE, HEAD, pull request), copies REVIEW.md
// and every recording under files/**/<base|head>/, and writes review.json.
import fs from 'node:fs';
import path from 'node:path';

const [caseDir, prArg] = process.argv.slice(2);
if (!caseDir) { console.error('usage: import-goldtrace-case.mjs <case dir> [pr]'); process.exit(1); }

const readme = fs.readFileSync(path.join(caseDir, 'README.md'), 'utf8');
const lines = readme.split('\n');
const title = (lines.find((l) => l.startsWith('# ')) || '# ').slice(2).trim();
const fields = {};
let key = null;
for (const line of lines.slice(1, 60)) {
  if (line.startsWith('#')) continue;
  if (!line.trim()) { if (Object.keys(fields).length) break; continue; }
  const m = line.match(/^ {2,8}([A-Za-z][A-Za-z ]{0,20}?) {2,}(\S.*)$/);
  if (m) { key = m[1].trim().toLowerCase(); fields[key] = m[2].trim(); }
  else if (key && /^ {12,}\S/.test(line)) fields[key] += ' ' + line.trim();
  else if (Object.keys(fields).length) break;
}
const sha = (s) => ((s || '').match(/^([0-9a-f]{7,40})\b/) || [])[1] || '';
const note = (s) => (s || '').replace(/^[0-9a-f]+\s+/, '');
const upstream = (fields.upstream || '').split(/\s/)[0];
const hay = [fields['pull request'], fields.head, fields.base].filter(Boolean).join(' ');
const pr = Number(prArg || (hay.match(/(?:pull requests?|PR|#)\s*(\d{3,6})\b/i) || [])[1]);
if (!upstream || !pr) { console.error(`could not determine upstream (${upstream}) or PR (${pr}) from the README header`); process.exit(1); }
const prTitle = (hay.match(/"([^"]+)"/) || [])[1] || '';

const repoSlug = upstream.replace('/', '-').toLowerCase();
const out = path.join('reports', repoSlug, `pr-${pr}`);
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join('reports', repoSlug, 'repo.json'))) {
  fs.writeFileSync(path.join('reports', repoSlug, 'repo.json'), JSON.stringify({ name: upstream, url: `https://github.com/${upstream}`, defaultBranch: 'main' }, null, 2) + '\n');
}

let n = { base: 0, head: 0 };
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.appmap.json')) yield p;
  }
}
const files = path.join(caseDir, 'files');
for (const file of walk(files)) {
  const rel = path.relative(files, file).split(path.sep);
  const sideSeg = rel.find((seg) => /^(.*-)?(base|head)$/.test(seg));
  if (!sideSeg) continue;
  const side = sideSeg.endsWith('head') ? 'head' : 'base';
  const after = rel.slice(rel.indexOf(sideSeg) + 1);
  // Keep the subproject path (e.g. app/proprietary) so a monorepo's traces stay distinct; drop the gold_traces boilerplate.
  const gt = after.indexOf('gold_traces');
  const subproject = gt > 0 ? after.slice(0, gt) : [];
  const dest = path.join(out, side, ...subproject, path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  n[side]++;
}
fs.copyFileSync(path.join(caseDir, 'REVIEW.md'), path.join(out, 'REVIEW.md'));
fs.writeFileSync(path.join(out, 'review.json'), JSON.stringify({
  pr,
  title: prTitle || (title.includes(':') ? title.slice(title.indexOf(':') + 1).trim() : title),
  url: `https://github.com/${upstream}/pull/${pr}`,
  date: (fields.head || '').match(/\((\d{1,2} \w{3} \d{4})\)/)?.[1] || '',
  base: { commit: sha(fields.base), note: note(fields.base) },
  head: { commit: sha(fields.head), note: note(fields.head) },
  source: `https://github.com/evlawler/goldtrace-examples/tree/main/${path.basename(caseDir)}`,
}, null, 2) + '\n');
console.log(`${out}: ${n.base} base, ${n.head} head recordings`);
