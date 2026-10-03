# Subscription billing SDET submission

This standalone folder contains only the billing fixture and its Playwright API automation. It does not include the VidTech video application or its dependencies.

## Setup and run

Requires Node.js 20 or newer. From this directory:

```sh
npm ci
npm run typecheck
npm test
```

The suite uses Playwright's `APIRequestContext`; browser binaries are not needed. To start the local demonstration service on port 5001, run `npm run billing:start`.

## Structure

- `billing/`: minimal Express fixture, lifecycle rules, provider seam, and file-backed repository.
- `tests/page.ts`: API Page Object Model for subscriptions, invoices, and signed payment webhooks.
- `tests/fixture.ts`: isolated service, repository, and recording payment-provider setup.
- `tests/helpers.ts`: shared webhook builders and persistence/API assertions.
- `tests/subscription.spec.ts`: Playwright lifecycle, API, persistence, webhook, and provider scenarios.
- `TEST_STRATEGY.md`: assumptions, design patterns, coverage, and known limitations.

The data file is created in a temporary directory for each test and removed at teardown. The standalone demo server stores its data in `billing/data.json` unless `BILLING_DATA_FILE` is set.
