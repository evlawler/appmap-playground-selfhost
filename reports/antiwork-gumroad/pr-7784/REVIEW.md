# Gumroad PR #7784, reviewed from its runtime behavior

**Verdict: the PR fixes a defect that was live on base, and leaves one neighbouring one in place.
On base, closing an account through `POST /users/deactivate` leaves `is_team_member` set on the
closed row, and when the closed account is the Gumroad account it leaves the flag set on every
team member of it: the member's next `GET /admin/impersonate` still passes the staff gate and
still writes the impersonation key to Redis. On head the same closure runs
`User#clear_team_member_flags!` inside `deactivate!`, the recording shows the extra
`UPDATE users SET flags` per affected row, and the member's next `GET /admin/impersonate` is
turned away at the gate (302 to `/`, no Redis write). An unrelated staff user is untouched on
both sides. GDPR erasure of an account closed earlier clears the flag on head and not on base.
Unchanged by the PR: a Helper/CLI admin API token issued to a staff member before closure keeps
answering `/internal/admin/whoami` and `/internal/admin/users/info` (a buyer's email in the
body) after the account is closed and, on head, after its flag is cleared, until it is revoked
by hand or expires.** ⚫→✅ on the first finding, ⚫ unchanged on the second, no 🔴.

| | |
| --- | --- |
| Upstream | [antiwork/gumroad#7784](https://github.com/antiwork/gumroad/pull/7784) "Clear the team-member staff flag when an account is closed", squash-merged 2026-09-18 13:45 EDT as `c8daccf9d` |
| Base (2026-09-18 12:51:51 EDT) | `efc357177`, main before the PR (its parent commit) |
| Head (2026-09-18 13:45:01 EDT) | `c8daccf9dcb7cfe2866ae322cb0ae7346ca8d8ee`, main after the PR |
| Recorded on | 2026-09-23, both revisions on the same machine, same MySQL 8, Redis, Elasticsearch and MinIO containers, same agent, plus one run per side with the agent disabled |
| Diff | 20 production lines: `User#clear_team_member_flags!` (new) called from `User#deactivate!`, and one call to it inside `GdprDataErasureService#perform!` between `deactivate_account!` and the anonymization. Plus model and service spec examples |
| Stack | Ruby 3.4.3, Rails, MySQL 8 and Redis in Docker, rspec request specs, AppMap Ruby agent 1.1.1, AppMap CLI 3.203.0 |
| Recorded | Real `POST /users/deactivate` on the web host as the signed-in seller, real `GET /admin/impersonate` as a team member (the staff gate, then Redis), a real PKCE exchange on `POST /internal/admin/auth/exchange` and the bearer token on `/internal/admin/whoami`, `/internal/admin/users/info` and `/internal/admin/auth/revoke`, and `GdprDataErasureService#perform!` called directly (it has no route). No stubs |

## The findings in one paragraph

`is_team_member` is the one input to Gumroad's staff surfaces: `Admin::BaseController#require_admin!`,
`Impersonate#can_impersonate?`, the profiler, the cable connection and the staff by-passes in the
purchase gates read it from the user row, and none of them ask whether the row is deleted. On
base nothing clears it when an account closes. `deactivate!` sets `deleted_at`, deletes the
products, cancels subscriptions and invalidates web sessions, and the flag stays. When the account
that closes is the Gumroad account itself (`hi@gumroad.com`), the members whose staff status
derives from their membership of it keep the flag too. The probe creates that account, one member
with a membership, and one unrelated staff user, closes the Gumroad account through the real route
as its owner, and then has the member try the staff-only `GET /admin/impersonate`. On base the
member is admitted (302 to `/products`, the impersonation key written to Redis). On head
`deactivate!` calls `clear_team_member_flags!`, the recording shows `UPDATE users SET flags` for
the Gumroad row and the member's row, and the same member request is refused by `require_admin!`
before the action (302 to `/`, no Redis write); the unrelated staff user is still admitted. A staff
member closing their own account, and GDPR erasure of a staff account that was closed earlier,
follow the same pattern: flag kept on base, cleared on head.

The second finding is what the PR's own description names as the reason for the change, "an
already-issued token kept resolving a closed staff account", tested on the internal admin API.
`Api::Internal::Admin::BaseController#authorize_admin_token!` accepts any `AdminApiToken` that is
not revoked and not expired; it does not read `is_team_member` or `deleted_at` on the actor.
`invalidate_active_sessions!` revokes the mobile OAuth application's tokens only. So a token issued
to a staff member through the real PKCE exchange keeps working after that member closes their
account, on base with the flag still set and on head with the flag cleared: `whoami` 200,
`users/info?email=` 200 with the buyer's email in the body, until `POST /internal/admin/auth/revoke`
(401 afterwards). The PR closes the flag for the surfaces that read it and does not touch this
one.

Severity, first finding: medium. The consequence on base is that closing an account, the one
action the project treats as final, leaves staff authorization in place for the closed account
and, for the Gumroad account, for every member of it, on every staff surface at once. It is
bounded by needing an authenticated request from the closed or demoted account (web sessions are
invalidated, mobile tokens revoked), so the live paths are other OAuth tokens and, for members
of the Gumroad account, their ordinary still-open sessions. Severity, second finding: low. Human
admin API tokens expire in 30 days (`HUMAN_TOKEN_TTL`) and can be revoked, the token is issued only
to a signed-in staff user, and the routes it reaches are the internal admin read and write API.

## The evidence

The probe fails on base and passes on head for the flag, and fails on both for the token
(`files/evidence/{base,head}-agent-probe.log`, same lines with the agent disabled in
`files/evidence/{base,head}-noagent-probe.log`):

```
BASE  probe A before closure: Gumroad(deleted=false team_member=true) Member(deleted=false team_member=true) Outsider(deleted=false team_member=true) member admin gate={status: 302, location: "/products", impersonating: true}
      probe A closure: {status: 200, success: true, message: nil}
      probe A after closure: Gumroad(deleted=true team_member=true) Member(deleted=false team_member=true) Outsider(deleted=false team_member=true) member admin gate={status: 302, location: "/products", impersonating: true} outsider gate={status: 302, location: "/products", impersonating: true}
      probe B before closure: Staffer(deleted=false team_member=true) whoami=200 users/info=200 email_in_body=true
      probe B closure: {status: 200, success: true, message: nil} token_active=true
      probe B after closure: Staffer(deleted=true team_member=true) whoami=200 users/info=200 email_in_body=true
      probe B after revoke: whoami=401
      probe C closure: {status: 200, success: true, message: nil} Erased(deleted=true team_member=true)
      probe C after erasure: [deleted](deleted=true team_member=true) email=deleted-N@deleted.gumroad.com name=[deleted]
      3 examples, 3 failures
HEAD  probe A before closure: (same)
      probe A closure: {status: 200, success: true, message: nil}
      probe A after closure: Gumroad(deleted=true team_member=false) Member(deleted=false team_member=false) Outsider(deleted=false team_member=true) member admin gate={status: 302, location: "/", impersonating: false} outsider gate={status: 302, location: "/products", impersonating: true}
      probe B before closure: (same)
      probe B closure: {status: 200, success: true, message: nil} token_active=true
      probe B after closure: Staffer(deleted=true team_member=false) whoami=200 users/info=200 email_in_body=true
      probe B after revoke: whoami=401
      probe C closure: {status: 200, success: true, message: nil} Erased(deleted=true team_member=false)
      probe C after erasure: [deleted](deleted=true team_member=false) email=deleted-N@deleted.gumroad.com name=[deleted]
      3 examples, 1 failure
```

Each line is logged from the response and the reloaded rows before the assertions run. The one
head failure is the probe's assertion that the token should be refused after closure
(`Expected 200 to eq 401`), the second finding.

The closure path from the recordings (`files/evidence/probe-{base,head}-closure-tree.txt`, from
`files/tree.py`), scenario A:

    BASE  HTTP POST /users/deactivate
            UsersController#deactivate
              UserPolicy#deactivate?
              User#deactivate!
                SQL UPDATE users SET deleted_at = ?, username = ?, flags = ? WHERE id = ?
                User#invalidate_active_sessions!
                  SQL UPDATE users SET last_active_sessions_invalidated_at = ? WHERE id = ?
          -> 200
          HTTP GET /admin/impersonate            (the member, after the closure)
            Admin::BaseController#impersonate
              Impersonate#impersonate_user
          -> 302

    HEAD  HTTP POST /users/deactivate
            UsersController#deactivate
              UserPolicy#deactivate?
              User#deactivate!
                SQL UPDATE users SET deleted_at = ?, username = ?, flags = ? WHERE id = ?
                User#invalidate_active_sessions!
                  SQL UPDATE users SET last_active_sessions_invalidated_at = ? WHERE id = ?
                User#clear_team_member_flags!
                  SQL UPDATE users SET flags = ? WHERE id = ?      the Gumroad row
                  SQL UPDATE users SET flags = ? WHERE id = ?      the member's row
          -> 200
          HTTP GET /admin/impersonate            (the member, after the closure)
          -> 302                                  (no action reached: require_admin! redirected)

The `flags = ?` in the first UPDATE on both sides is `payouts_paused_internally`, part of the
existing `update!`; the two extra UPDATEs on head are the new method. Scenario B has one extra
UPDATE on head (the closing staffer's own row) and then the same token path on both sides:
`AdminApiToken.authenticate` → `AdminApiToken#active?` → `true`, `UPDATE admin_api_tokens SET
last_used_at`, 200, on every request until the revoke writes `revoked_at` and the next
`authenticate` returns nil, 401. Scenario C on head shows `User#clear_team_member_flags!` a second
time, called from the erasure service after `deactivate_account!` returned early, with no UPDATE
because the closure already cleared it; on base the erasure's `UPDATE users SET email, name, ...`
runs and no flag write ever appears.

The same probe with the agent disabled (`APPMAP=false`) on both sides gives the same logged lines
and the same assertion results, and writes no recording.

## Intended, confirmed by a recording ✅

- Closing an account clears its own `is_team_member`: scenario B and C rows go `team_member=true`
  → `false` on head, one `UPDATE users SET flags` inside the `deactivate!` transaction.
- Closing the Gumroad account clears the flag of its team members and of nobody else: the member's
  row is updated, the unrelated staff user's is not, and their next staff requests are refused and
  admitted respectively.
- The staff gate reads the cleared flag on the next request: the member's `GET /admin/impersonate`
  goes from 302 `/products` with a Redis write to 302 `/` with none.
- GDPR erasure of an account closed before the change clears the flag: scenario C, `deactivate_account!`
  returns early on the already-closed row and `clear_team_member_flags!` still runs before the
  anonymization, as the PR describes.
- `update_columns` writes the flag without callbacks: the recording shows the bare UPDATE and no
  `clear_products_cache` or other callback under `clear_team_member_flags!`.

## Unintended 🔴

None. The unrelated staff user, the closure response, the products deletion, the session
invalidation and the two ordinary gold traces are the same on both sides.

## Seen but not claimed as a change

- The internal admin API token surviving closure (second finding above) is the same on both sides.
  It is filed as latent, unchanged by the PR, because the PR's stated goal is the flag and the
  surfaces that read it, and `authorize_admin_token!` reads neither the flag nor `deleted_at`.
  The fix would be one line in `AdminApiToken.authenticate` or `authorize_admin_token!`
  (`return nil unless actor_user.alive? && actor_user.is_team_member?`), or revoking the actor's
  admin API tokens from `deactivate!` next to the mobile tokens.
- Other OAuth applications' tokens (the Doorkeeper path `current_api_user` → `can_impersonate?`)
  were not exercised. That is the path the PR's description has in mind and the flag is what
  `can_impersonate?` reads, so the head clearance should close it; there is no recording of it here.
- `require_admin!` itself does not appear in the recordings (a private before_action the agent
  does not record under this configuration). Its effect is in the trace: on head the member's
  request produces no `Admin::BaseController#impersonate` event and answers 302 to `/`.
- Suspension and reactivation were not exercised. The PR does not change them.

## Security

The first finding is an authorization defect on base: a closed account, and for the Gumroad
account every member of it, keeps staff authorization on every surface that reads
`is_team_member`. Head closes it for those surfaces. The second finding is a narrower version of
the same shape on a surface that does not read the flag: a live admin API token outlives its
holder's account on both sides. No new query and no new write on head beyond the flag UPDATEs.

## Coverage and limits

- Two gold traces (the license-key lookup request and the ordinary refund under frozen time),
  the Gumroad rig from case 7861, seeded on both revisions. The compare between the revisions
  reports `Traces: 0 changed, 0 new, 0 removed. SQL: 0 new queries, 0 removed. API: no breaking
  change.` (`files/evidence/gold-traces-compare.txt`). `covers --name` for `User#deactivate!`,
  `clear_team_member_flags`, `GdprDataErasureService`, `require_admin`, `AdminApiToken.authenticate`
  and `can_impersonate`: `No baseline runs a code object matching` each. Nothing ordinary reaches
  the changed code or the gates it feeds, so the probe is the gold trace for this area. The
  project's own tests for the change are model and service specs that call the methods directly.
- On head the license-key gold trace came back `Nondeterministic` on one `check --record` pass
  and stable on the next `update --record`; the two seeded baselines compare equal between the
  sides. Noted as a test-stability observation, not a finding.
- `GdprDataErasureService` has no route (it is run from the console), so scenario C calls the
  service directly against the real database. Everything else in the probe is a real request.
- Setup order deviated from the protocol: the AppMap commits from case 7861 were cherry-picked onto
  both worktrees before the prerequisite gate (bundle, Vite test build, `db:seed`, one project
  request spec) was rerun on them. The gate passed afterwards; two environment faults on the way
  (missing `db:seed` rows, the Vite build writing to `public/vite-dev` under `--mode=test`, worked
  around with a symlink) are environment, not findings.
- The sanitized recordings had cookie and authorization values redacted a second time
  (`files/redact_cookies.py`) because `appmap sanitize` left nested cookie hashes and array-valued
  `set-cookie` headers. Searches for the session cookie name, `Bearer ` and the profiler cookie
  return nothing in the copies here.

## Reproduce

`reproduce.sh` in this directory: lays the recording setup, manifest, baseline and probe onto
both commits in a local clone, runs the probe on each (with `RECORD=1`, re-records the gold
traces and runs `covers`), prints the logged state and the closure trees, and compares the
committed gold traces between the sides. `AGENT=0` runs the probe with the agent disabled.

Copyright 2026 Elizabeth Lawler. CC BY 4.0.
