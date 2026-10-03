# Subscription billing validation strategy

## Assumptions and scope

No billing service was supplied, so `billing/` contains a minimal HTTP fixture used by the tests. Plans are `basic` (1900 USD cents, no trial) and `pro` (4900 cents, 14 day trial). A successful immediate provider charge persists a successful payment and activates the subscription; decline or timeout records failure and sets `past_due`. Trial completion is represented by a signed payment webhook. Test fixtures seed a small customer catalog and reject unknown IDs.

The suite covers API contracts, lifecycle transitions, persistence, provider interactions, signed webhook validation, duplicate/out-of-order/concurrent deliveries, refunds, and durable repository reopening. It does not implement UI, authentication, production customer management, a real provider, taxes, proration, retry scheduling, or cross-process event locking.

## Test design and patterns

- `SubscriptionStateMachine` is the transition table, so state updates must pass a named trigger allowed from the current state.
- `PlanCatalog` keeps trial and price rules together.
- `FileBillingRepository` isolates persistence operations and is inspectable by tests.
- `RecordingPaymentProvider` is injected through `BillingService`; it records charge arguments and returns configured success, decline, or timeout outcomes.
- `BillingFixture` provisions a fresh repository, seeded customers, server, provider, and API request context per test; the extended Playwright `test` fixture owns setup and teardown.
- `BillingPage` in `tests/page.ts` is an API Page Object Model. This assignment has no browser UI, so it models the billing resource and encapsulates HTTP operations and webhook signing.
- `SubscriptionBuilder` and `buildWebhook` reduce repeated test setup. `tests/subscription.spec.ts` states end-to-end behavior and checks API results against repository snapshots.
- `tests/helpers.ts` contains reusable event construction and API/database consistency assertions so the spec file stays focused on scenarios.

## API and webhook contract

Create accepts `{ customer_id, plan, payment_method_id }`. The API exposes create, get, cancel, plan change, and invoice retrieval. Webhooks use `POST /webhooks/payment-provider`, `X-Provider-Signature` containing HMAC-SHA256 over the exact raw JSON body, and event fields `event_id`, `type`, `subscription_id`, `invoice_id`, `amount`, `currency`, and `created_at`.

The suite checks missing/invalid fields, unknown customer/plan/subscription, invalid state-specific cancellation and plan changes, missing/forged/tampered signatures, malformed JSON and event fields, unsupported event types, unknown/mismatched invoice references, amount/currency mismatch, valid success/failure/refund events, stale events, duplicate-ID replays with altered payload fields, and concurrent duplicate delivery.

## Persistence invariants

The repository records customers, subscriptions, invoices, payments, accepted webhook events, duplicate deliveries, and audit entries. Tests assert API/repository agreement during lifecycle changes, correct invoice and payment amounts/statuses, at most one application of each `event_id`, duplicate delivery auditability without duplicate payment side effects, no reactivation after cancellation, late failure not regressing a paid invoice, and data survival after reopening the repository.

Adversarial webhook cases assert rejected requests do not write processed events, payments, or invoice changes. Duplicate event IDs with altered payload fields are acknowledged as no-ops, recorded as duplicate deliveries, and do not add payments or invoices. Events arriving after cancellation are persisted as no-ops and cannot change subscription state.

Each test uses a unique temporary file and removes it at teardown. The process-local lock is adequate for this single-process fixture, but production multi-process delivery needs a transactional database and a unique event-ID constraint.
