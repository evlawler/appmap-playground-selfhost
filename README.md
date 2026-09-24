# AppMap reports, self-hosted

A small, no-login web app that shows the AppMap reports produced for a repository and lets
readers explore the recordings behind them in the AppMap query UI. Nothing is generated at
runtime and no AI service is involved: every page is rendered from files committed under
`reports/`, so the app can run on a private network with no outbound access.

Demo: https://appmap-playground-selfhost.fly.dev/ (the `antiwork/gumroad` reports under
`reports/`). The original learning playground with the guided tour and chatbot lives at
https://github.com/evlawler/appmap-playground; this repository is the report-viewer fork of it.

## What a reader sees

One dropdown per repository, with two kinds of entries:

| Entry | What it is | Where it comes from |
|---|---|---|
| **Latent defects on `main`** | The standing report over the repository's current gold traces: what the scan found, the state of each finding, the probe/fix recordings that prove it. One per repository, replaced on each scan run. | `reports/<repo>/scan/` (output of the `appmap-scan` skill) |
| **PR #n: title** | The review of one pull request: the same text that was posted on the PR, plus the base and head recordings it was written from. One per reviewed PR, never rewritten. | `reports/<repo>/pr-<n>/` (output of the `appmap-review` skill) |

Selecting an entry opens its report (`/review`). The **Query UI** link opens the AppMap CLI's
query UI over that entry's recordings; for a PR the Compare page is prefilled with `base` vs
`head`. Selection is a browser cookie, so links are shareable and readers do not affect
each other. Until the first scan runs, the Latent defects entry is a placeholder page that
describes what will appear there.

## The publishing contract

The app consumes a directory tree; how it gets there (a CI job, an agent, a person) is up to
the repository owner.

```text
reports/<repo-slug>/
  repo.json                       { "name": "org/repo", "url": "...", "defaultBranch": "main" }

  scan/                           latent-defects report, one per repository
    scan.json                     { "commit": "<sha>", "date": "...", "note": "..." }
    SCAN.md                       the scan report
    findings.yml                  finding lifecycle (status, chain, next_action, dismissals)
    appmaps/**/*.appmap.json      gold traces and probe/fix recordings the scan read

  pr-<number>/                    one per reviewed pull request
    review.json                   { "pr", "title", "url", "date", "base": {"commit"}, "head": {"commit"} }
    REVIEW.md                     the review as posted on the PR
    base/**/*.appmap.json         recordings on the base commit
    head/**/*.appmap.json         recordings on the head commit
```

Rules the build applies (`app/build.js`):

- A `scan/` entry is always listed; without `SCAN.md` it is the placeholder.
- A `pr-<n>/` entry needs `review.json`, `REVIEW.md` and at least one recording, otherwise it
  is skipped with a warning.
- Recording metadata is stamped with `git.branch = base|head` (or the default branch for scan
  recordings) so the query UI's Compare page can tell the sides apart, then indexed with
  `appmap index`. Markdown is rendered with `marked`.

A typical flow on the repository being analyzed: the review job records base and head gold
traces in the PR's CI, writes `REVIEW.md` as the PR comment, and pushes the `pr-<n>/`
directory to this repository (or to a `reports/` branch of its own). A scheduled scan job does
the same for `scan/`. A commit to `reports/` triggers an image rebuild here.

## Running it

Everything happens at image build time: copy `reports/`, stamp and index the recordings,
render the Markdown. The runtime is Node plus the AppMap CLI, one `appmap query ui` process per
entry with recordings (started on first request, stopped after 20 minutes idle).

```bash
docker build -f app/Dockerfile -t appmap-reports .
docker run --rm -p 8080:8080 appmap-reports
open http://localhost:8080/review
```

Without Docker: `npm i -g @appland/appmap marked`, then `cd app && node build.js ../reports build
&& node server.js`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `ENTRY` | most severe PR review | Entry shown to a first-time visitor |
| `FRAME_ANCESTORS` | unset | Emits `Content-Security-Policy: frame-ancestors <value>`; set it to the Confluence origin to allow embedding only from there, leave unset to allow any |
| `IDLE_MINUTES` | `20` | Idle time before a query UI process is stopped |

Routes: `/review` (report of the selected entry), `/e/<repo>/<entry>[?to=/path]` (select and
redirect, the shareable form), `/api/entries`, `/healthz`; every other path is proxied to the
selected entry's query UI.

### Fly.io (the demo)

`fly launch --copy-config --no-deploy` once, then `fly deploy` from the repository root;
`fly.toml` scales to zero when idle.

### OpenShift

`infra/openshift/appmap-reports.yaml` holds an ImageStream, a BuildConfig (Docker strategy over
this repository, `app/Dockerfile`), a Deployment, a Service and an edge-TLS Route:

```bash
oc new-project appmap-reports
oc apply -f infra/openshift/appmap-reports.yaml
oc start-build appmap-reports --follow
oc get route appmap-reports
```

The image runs under the restricted SCC with an arbitrary UID (`/srv` is group 0 and
group-writable, `HOME=/tmp`). The only network dependency is `npm install` of the AppMap CLI
during the build; point `NPM_CONFIG_REGISTRY` at an internal mirror if the cluster has no
egress, or build the image outside and push it to the internal registry instead of using the
BuildConfig.

### Confluence

Two options, both using the Route URL:

- **Link**: `https://<route>/e/<repo>/pr-<n>` opens that PR's review; `/e/<repo>/scan` the
  latent-defects report.
- **Embed**: the iframe macro (Confluence Data Center/Server) or an HTML/iframe macro app
  (Confluence Cloud) pointing at the same URL. Set `FRAME_ANCESTORS` to the Confluence origin.
  The selection cookie is set `SameSite=None; Secure` when the app is served over HTTPS, which
  is what third-party iframes require.

## Importing from goldtrace-examples

`scripts/import-goldtrace-case.mjs <case dir> [pr]` converts a case from
https://github.com/evlawler/goldtrace-examples into a `pr-<n>/` entry; the demo data was
imported that way.
