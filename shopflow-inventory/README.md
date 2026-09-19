# shopflow-inventory

Owns the inventory SQLite database and exposes explicit HTTP APIs. Seed IDs are
`prod-a` (SKU-A, stock 20) and `prod-b` (SKU-B, stock 10).

```bash
npm ci
npm test
DATABASE_PATH=./inventory.db PORT=3002 npm start
```

## API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `{ "ok": true }` |
| `GET` | `/products` | — | `Product[]` |
| `GET` | `/products/{id}` | — | `Product`, or `404` |
| `POST` | `/inventory/validate` | `{ productId, quantity }` | `{ available: true, product }`; `400` invalid quantity; `409` insufficient stock |
| `POST` | `/inventory/decrement` | `{ productId, quantity }` | `Product`; `400` invalid quantity; `409` insufficient stock |
| `POST` | `/inventory/restore` | `{ productId, quantity, idempotencyKey }` | `Product`; `400` invalid quantity or missing/blank key; `404` unknown product |

`Product` is `{ id, sku, name, priceCents, stock }`.

## `POST /inventory/restore`

Adds `quantity` back to a product's stock. It is the inventory half of order cancellation and is
called by `shopflow-orders` with the key convention `order-cancel:<orderId>`.

```bash
curl -s -X POST localhost:3002/inventory/restore \
  -H 'content-type: application/json' \
  -d '{"productId":"prod-a","quantity":1,"idempotencyKey":"order-cancel:42"}'
```

Semantics:

- `quantity` must be a positive integer, otherwise `400` and no stock change.
- `idempotencyKey` must be non-blank, otherwise `400` and no stock change.
- An unknown `productId` returns `404` and creates no restoration record.
- Stock is incremented **exactly once per `idempotencyKey`**. The key row and the increment are
  written in one transaction to `stock_restorations` inside `inventory.db`, so a repeated request
  with the same key is a successful `200` no-op that reports the current stock (the first applied
  amount wins, even if a retry sends a different quantity). This lets `shopflow-orders` converge
  after a lost response without double-crediting stock.
- Only this service writes stock and the restoration record; callers never touch `inventory.db`.

## Configuration

Environment variables are unchanged:

- `PORT` — HTTP port, default `3002`.
- `DATABASE_PATH` — SQLite file, default `./data/inventory.db`.
