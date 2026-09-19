# shopflow-orders

Owns order lifecycle and its private SQLite database. Inventory validation and
stock changes use the inventory HTTP API; confirmations and cancellations use the
notifications HTTP API. This service never opens another service's database.

## Order status

`CONFIRMED` → `SHIPPED`, or `CONFIRMED` → `CANCELLED`. `CANCELLED` is terminal:
`POST /orders/{id}/ship` keeps rejecting every order that is not `CONFIRMED`.

## API

| Route | Description |
| --- | --- |
| `GET /health` | liveness |
| `POST /orders` | create an order (`{ productId, quantity, customerEmail }` → `201`) |
| `GET /orders/{id}` | read one order |
| `POST /orders/{id}/ship` | ship a `CONFIRMED` order |
| `POST /orders/{id}/cancel` | cancel a `CONFIRMED` order with `{ "reason": "…" }` |

`POST /orders/{id}/cancel` answers with the updated order and the status codes the
gateway exposes at `POST /api/orders/{id}/cancel`:

| Status | When |
| --- | --- |
| `200` | cancellation complete, or the order was already `CANCELLED` and its compensation is done |
| `400` | missing/blank reason, or more than 200 characters after trimming |
| `404` | unknown order id |
| `409` | the order is `SHIPPED` (cancellation is refused, the order is untouched) |
| `502` | the cancellation is durably committed but a compensation step is still outstanding; the body carries the current order state |

## Cancellation and compensation

`cancel` writes `status = 'CANCELLED'`, `cancelledAt`, `cancellationReason` and the durable
marker `inventoryRestoreState = 'PENDING'` in a single conditional `UPDATE ... WHERE
status = 'CONFIRMED'`. That statement is the single claim point, so concurrent or repeated
cancellations of the same order converge instead of double-compensating.

Once claimed, the service completes the cancellation in a fixed order and records each step:

1. `POST {INVENTORY_URL}/inventory/restore` with `{ productId, quantity, idempotencyKey }`
   where `idempotencyKey = "order-cancel:<orderId>"`; on success `inventoryRestoreState = 'DONE'`.
2. `POST {NOTIFICATIONS_URL}/notifications/order-cancellation` with
   `{ orderId, customerEmail, reason }`; on success `cancellationNotifiedAt` is set.

If a compensation call fails the cancellation stays committed and the request answers `502`
("Cancellation is durable but completion is pending") instead of reporting a false success. A
later `cancel` call, or the startup `reconcileCancellations()` pass that resumes every
`CANCELLED` order with a pending restore or notification, retries the outstanding step only.
Because the restore is keyed by order id, the inventory side applies it exactly once even when
the request is retried.

## Storage

The orders table also stores `cancelled_at`, `cancellation_reason`,
`inventory_restore_state` and `cancellation_notified_at`. On startup an idempotent, guarded
migration rebuilds a legacy table (old `status` CHECK without `CANCELLED`) inside one
transaction, carrying every existing row over with `inventory_restore_state = 'NOT_REQUIRED'`,
so the persistent `orders_db` volume is preserved. A fresh or already-migrated database is left
untouched.

## Running

```bash
npm ci
npm test
DATABASE_PATH=./orders.db INVENTORY_URL=http://localhost:3002 NOTIFICATIONS_URL=http://localhost:3003 PORT=3001 npm start
```
