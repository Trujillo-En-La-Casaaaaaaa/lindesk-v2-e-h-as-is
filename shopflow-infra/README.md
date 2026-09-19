# ShopFlow F3 infrastructure

This is the Compose entry point for the frozen six-repository ecosystem.
Orders and inventory use distinct SQLite database volumes. The local provider
emulator deterministically records notifications and deduplicates writes by
`idempotencyKey`; no production cloud service or runtime internet access is used.

## Start

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/api/health
```

Gateway: http://127.0.0.1:3000  
Web: http://127.0.0.1:8080

## Test

`npm test` runs the black-box acceptance suite (`integration.test.js`) against a
running stack through the public gateway API. It covers the existing baseline
workflow (health, product read, order create with a stock decrement, ship and the
`ORDER_CONFIRMATION` notification) and the order-cancellation feature end to end:
successful cancellation with `cancelledAt`/`cancellationReason`, inventory
restored exactly once, the `ORDER_CANCELLATION` notification, reason validation
(blank and >200 characters rejected, 200 accepted), rejection of `SHIPPED` orders
with `409`, repeated cancellation convergence, and provider deduplication by
`idempotencyKey`.

```bash
npm test
```

### Fault-injection recovery test

The optional inventory-outage recovery case is gated behind
`SHOPFLOW_FAULT_INJECTION=1`. It stops the `inventory` service through
`docker compose`, asserts the first cancellation returns `502` while the order is
already `CANCELLED`, restarts `inventory`, waits for it to become healthy, and
then asserts the retried cancellation returns `200` with inventory restored
exactly once (not twice). When the flag is not set the test is reported as
skipped with an explicit reason.

```bash
# PowerShell: $env:SHOPFLOW_FAULT_INJECTION = "1"
SHOPFLOW_FAULT_INJECTION=1 npm test
```

`SHOPFLOW_BASE_URL` (default `http://127.0.0.1:3000`) and `SHOPFLOW_PROVIDER_URL`
(default `http://127.0.0.1:3004`) override the endpoints under test.

### Per-service unit tests

```powershell
../shopflow-orders: npm ci; npm test
../shopflow-inventory: npm ci; npm test
```

From the evaluation root:

```powershell
./scripts/run-acceptance.ps1 -Target fixtures/F3-high/app/shopflow-infra -Suite baseline -StartCompose
```

Reset deterministic state with `docker compose down -v`.
