# Gumroad PR #7889 (with follow-up #7892), reviewed from its runtime behavior

**Verdict: the PR fixes a defect that was live on base and leaves two neighbouring ones in place.
On base, a seller whose profile section carries a value the current schema refuses cannot close the
account: `POST /users/deactivate` answers `success: false`, nothing is deleted, and every retry fails
on the same row. On head the same request closes the account, soft-deletes every owned record,
frees the username and every public page answers 404. The compare shows the mechanism directly:
the bank routing lookup and the custom-domain uniqueness lookup, both validation queries, no longer
run inside closure, and products are now selected by `deleted_at` only. Unchanged by the PR: a
third-party OAuth token issued to the seller before closure keeps answering `/api/v2/user` (name,
email), `/api/v2/products` and `/api/v2/sales` after closure, and a seller who has not closed
cannot create a product by API or UI while that same stale section exists.** ⚫→✅ on the closure
finding, ⚫ unchanged on the other two, no 🔴.

| | |
| --- | --- |
| Upstream | [antiwork/gumroad#7889](https://github.com/antiwork/gumroad/pull/7889) "Close an account whose owned records no longer validate", merged 2026-09-22 as `795adcf94`, and [#7892](https://github.com/antiwork/gumroad/pull/7892) "Keep account closure working with invalid profile sections", merged 2026-09-22 as `eb57d3de6` |
| Base | `63561f5c4`, main before #7889 |
| Head | `eb57d3de6`, main after #7892 |
| Recorded on | 2026-09-23 (probe) and 2026-09-24 (gold traces and compare), both revisions on the same machine, same MySQL 8, Redis, Elasticsearch and MinIO containers, same agent, plus one probe run per side with the agent disabled |
| Diff | 5 production files, 41 insertions, 30 deletions: `validate:` on `Deletable#mark_deleted!`, `BankAccount#mark_deleted!`, `Link#delete!` and the two profile-section helpers it calls, new `User#soft_delete_owned_records!` shared by `deactivate!` and the GDPR erasure |
| Stack | Ruby 3.4.3, Rails, MySQL 8 and Redis in Docker, rspec request specs, AppMap Ruby agent, AppMap CLI |
| Recorded | Real `POST /users/deactivate` as the signed-in seller, real public product, profile and custom-domain requests after closure, a Doorkeeper access token on `/api/v2/*`, `POST /links` through the UI. No stubs |

## The findings in one paragraph

`User#deactivate!` deletes the owned records one by one with `save!`. On base each `save!`
validates, and `Link#delete!` also rewrites the seller's profile sections through `update!`, so a
`seller_profile_sections` row whose JSON fails the current schema (`default_product_sort:
"obsolete"`, a value an older schema accepted) raises inside the transaction. The base recording of
scenario A shows `Link#delete!` → `remove_from_profile_sections!` →
`SellerProfileProductsSection#shown_products=` and then the rollback, with the controller
answering `success: false, "We could not delete your account"`. The seller's state is unchanged,
so the retry fails identically. On head the same chain runs with `save!(validate: false)`, the
recording shows the `UPDATE` statements committed for the user row, five products, the post, the
bank account, the custom domain and both sections, and the public pages answer 404.

## The evidence

Gold traces, four entries on each side (`files/<side>/gold_traces/`), stable across two recordings.
`review.mjs compare`: one trace changed, the account-closure trace.

    SQL removed   SELECT banks.* WHERE routing_number = ? LIMIT 1           (BankAccount validation)
                  SELECT custom_domains.* WHERE deleted_at IS NULL AND domain = ? LIMIT 1   (uniqueness validation)
                  SELECT links.* WHERE user_id = ?                          (every link)
    SQL added     SELECT links.* WHERE user_id = ? AND deleted_at IS NULL   (Link.visible)
    tables        banks no longer touched by closure
    API           no difference        findings   none new, none resolved

Probe, scenario A (`files/evidence/*-agent-probe.log`, recordings in `files/evidence/probe-appmap-*`):

    BASE  close {status: 200, success: false}   seller deleted=false   all owned records deleted=false
          /l/<permalink> 301   /<username> 301   custom domain / 200
    HEAD  close {status: 200, success: true}    seller deleted=true, username freed
          live, disabled, banned, invalid products deleted=true, sections emptied, post, bank, domain deleted=true
          /l/<permalink> 404   /<username> 404   custom domain / 404

Head enqueues the deletion workers per product (files, archives, rich content, wishlist rows,
Elasticsearch update, IndexNow) that base never reaches.

## Intended, confirmed by a recording ✅

Closure completes with an invalid owned record. The PR's stated population change is also in the
recording: purchase-disabled and banned products go through `Link#delete!` on head (`Link.visible`),
where base selected all links and never got that far.

## Unintended 🔴

None found.

## Seen but not claimed as a change

Two behaviors present on both sides, outside the PR's scope, each filed as its own case:

1. Scenario B: a Doorkeeper access token (`edit_products view_sales view_profile`) created for the
   seller before closure still answers after the head closure. `GET /api/v2/user` 200 with name and
   email, `GET /api/v2/products` 200 (empty list on head, four products on base where closure
   failed), `GET /api/v2/sales` 200, `token.revoked_at` nil. `invalidate_active_sessions!` revokes
   only the mobile application's tokens and `Api::V2::BaseController#current_resource_owner` is
   `User.find(resource_owner_id)` with no `alive?` check. Base cannot show the post-closure state
   because closure fails there. [`gumroad-oauth-token-outlives-closed-account`](../../gumroad-oauth-token-outlives-closed-account/)
2. Scenario C: a seller who has not closed, with the same stale section, gets `success: false` from
   `POST /api/v2/products` and a 302 back to `/products/new` from the UI, no row created, on both
   sides. `Link#add_to_profile_sections` (an `after_create`) still calls `section.update!`, which
   #7892 did not change. Repairing the section makes the create succeed. [`gumroad-invalid-profile-section-blocks-product-create`](../../gumroad-invalid-profile-section-blocks-product-create/)

## Security

Skipping validations on rows being deleted does not widen any access. The tokens finding is the
security-relevant one and is tracked in its own case.

## Coverage and limits

The two coverage entries were added because the rig's original two traces did not reach any
changed symbol. GDPR erasure (`GdprDataErasureService#deactivate_account!`) is changed by the PR and
not probed here. Sidekiq in fake mode, Stripe not called.

## Reproduce

See README, "Reproduce the review".
