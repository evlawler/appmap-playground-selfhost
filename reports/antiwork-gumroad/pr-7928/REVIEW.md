# Gumroad: consumption events written against any buyer's purchase, from the runtime behavior

**Verdict: on both sides, an anonymous `POST /consumption_analytics` that names another buyer's
purchase (its external id, the same id that appears in receipt and download links) and any
`url_redirect_id` at all is accepted with `{"success": true}`, and a `consumption_events` row is
written against that purchase with the caller's `event_type`, `platform` and `consumed_at`. The
request runs no query against `url_redirects` and reads no session or token. The row is then read
by `DisputeEvidence::GenerateAccessActivityLogsService`, so the fabricated access appears in the
access log Gumroad submits to Stripe when the buyer disputes the charge. The PR under review (7928)
protects the sibling endpoint `POST /purchase_custom_fields` with the buyer's download token and
leaves this one as it was.** ⚫ latent on both sides, unchanged by HEAD.

| | |
| --- | --- |
| Reviewed with | [antiwork/gumroad#7928](https://github.com/antiwork/gumroad/pull/7928), base `01223f018`, head `e10f290ca` |
| Recorded on | 2026-09-24, both sides, agent on and off |
| Recorded | Two buyers of different products, each with a `url_redirect`. Real `POST /purchase_custom_fields` with no token, the other buyer's token, and the owner's token. Real `POST /consumption_analytics` with the other buyer's `url_redirect_id` plus the victim's `purchase_id`, then with the victim's own `url_redirect_id`, no login, no token. Then `GenerateAccessActivityLogsService.perform(victim_purchase)` |

## What the compare shows

Six gold traces, stable across two recordings on each side (`files/evidence/gold-check-*.txt`).
`review.mjs compare` between BASE and HEAD (`files/evidence/compare.log`):

    Traces: 1 changed, 0 new, 0 removed.
      changed  Gold_trace_download_page_writes_stores_the_buyer_s_answer_to_a_post-purchase_custom_field
    SQL: 1 new queries: SELECT ? AS one FROM `url_redirects` WHERE token = ? AND purchase_id = ? LIMIT ?
    tables +url_redirects

That is the PR: `PurchaseCustomFieldsController#create` now asks `url_redirects` whether the token
belongs to the purchase before it writes. The trace of the other download-page write,
`records a consumption event for the download page`, is byte-for-byte unchanged between the
sides. The one request that identifies a purchase by id and did not gain a `url_redirects` check is
the one the probe went after.

## What the probe recording shows

HEAD, scenario B (`files/evidence/probe-appmaps-head/...B_neighbour...`, tree in
`files/evidence/probe-head-tree.txt`), one request:

    HTTP POST /consumption_analytics            (anonymous: logged_in_user nil, current_api_user nil)
        ConsumptionAnalyticsController#create
        ObfuscateIds.decrypt                     (url_redirect_id, the other buyer's)
        ObfuscateIds.decrypt                     (purchase_id, the victim's)
        SELECT purchases.* WHERE id = ?          (the victim's purchase, to fill link_id)
        ConsumptionEvent.create_event!
        INSERT INTO consumption_events (product_file_id, url_redirect_id, purchase_id, event_type, platform, ...)
      -> 200 {"success": true}

No `SELECT ... FROM url_redirects` anywhere in the request: the `url_redirect_id` is decrypted and
stored, never loaded, so it is not checked against the purchase, and it need not even exist. The
second request, with the victim's own `url_redirect_id` taken from the same receipt link, is
identical. After the two requests:

    events on the victim's purchase:
      ["download", "web",    "2026-09-01T09:00:00Z", "127.0.0.1", "foreign url_redirect"]
      ["watch",    "iphone", "2026-09-02T10:00:00Z", "127.0.0.1", "own url_redirect"]
    dispute access log:
      The customer accessed the product 2 times.
      consumed_at,event_type,platform,ip_address
      2026-09-01 09:00:00 UTC,download,web,127.0.0.1
      2026-09-02 10:00:00 UTC,watch,iphone,127.0.0.1

The dates are the caller's (`consumed_at` is taken from the request), the platform is the caller's,
the event type is any of `ConsumptionEvent::EVENT_TYPES`. Same output on BASE and with the agent
off (`files/evidence/probe-*-noagent.txt`).

Scenario A, the PR's own path, behaves as the PR says: BASE stores the stranger's text with no token
and with the wrong token (204 three times), HEAD answers 404 to both and 204 only to the owner's
token.

## Why it matters

The access log is evidence Gumroad submits on the seller's behalf in a chargeback, and it is
supposed to record what the buyer did. Anyone who knows a purchase's external id (the download page
sends it in the clear with every analytics call, `app/javascript/data/consumption_analytics.ts`,
and the seller's dashboard and API expose it as the purchase's id) can post
downloads with chosen timestamps and platforms against that purchase, and the log then says the
customer accessed the product on those dates. The same write also inflates any per-purchase
consumption count. There is no authentication on the route
(`skip_before_action :check_suspended`, no `authenticate_user!`, no token check), and it is
reachable on every domain scope Gumroad routes (`config/routes.rb` declares it three times).

## What would close it

The purchase a consumption event is written against should be the `url_redirect`'s purchase, with a
caller-supplied `purchase_id` accepted only when it agrees. That is what
`PurchaseCustomFieldsController` now does with the token, and `CreateConsumptionEvent` can do the same
with the `url_redirect` it is already given. See CLAIM.md and `files/fix/` for the local fix and
its trace.
