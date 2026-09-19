# shopflow-web

React + TypeScript UI for catalog, order creation/detail, shipping, and
cancellation. Every application request uses relative `/api` URLs, which are
proxied only to `shopflow-gateway`.

## Cancelling an order

A `CONFIRMED` order shows a cancellation-reason input and a `Cancel order`
action. Submitting it issues `POST /api/orders/{id}/cancel` with the trimmed
reason and renders the returned `CANCELLED` state (cancelled time and reason);
the catalog is then re-read so restored stock is visible. `SHIPPED` orders
offer no cancellation, and a cancelled order no longer offers shipping.

The reason rule (non-empty, at most 200 characters after trimming) lives in
`src/cancelReason.ts` and is applied on the client only as a convenience guard.
The backend remains authoritative: its `400`, `404`, `409` and `502` responses
are surfaced to the user as returned, and an error never makes the UI present
the order as un-cancelled.

No environment variables or secrets are required; the app only ever calls
relative `/api` URLs.

```bash
npm ci
npm test
```

`npm test` builds with `tsc -b` and `vite build`, then compiles the pure reason
rule and runs the `node:test` cases in `test/`. The standalone `tsc` call that
emits `.test-dist` passes `--skipLibCheck`, because a bare `tsc <file>` run would
otherwise type-check every installed `@types` package; the tests are matched with
the `test/*.test.mjs` glob because Node's test runner resolves a bare directory
argument as a module.
