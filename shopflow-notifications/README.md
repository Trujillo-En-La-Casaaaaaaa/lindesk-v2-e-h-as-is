# shopflow-notifications

Owns order notification orchestration and sends messages through the configured
provider HTTP interface. Compose configures the deterministic local emulator.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | `200 { "ok": true }` |
| `POST` | `/notifications/order-confirmation` | Validates `orderId` and `customerEmail`, then forwards an `ORDER_CONFIRMATION` message to the provider. `201` with the provider response, `400` invalid, `502` provider failure. |
| `POST` | `/notifications/order-cancellation` | Validates `orderId` and `customerEmail`, then forwards an `ORDER_CANCELLATION` message to the provider. `201` with the provider response, `400` invalid, `502` provider failure. |
| `GET` | `/notifications` | Proxies the provider message list (`GET {PROVIDER_URL}/messages`). |

## Message types

Messages are forwarded to `POST {PROVIDER_URL}/messages` with a stable
`idempotencyKey` derived from the order id only, so a retried notification
converges to a single logical message (the provider deduplicates on the key):

- `ORDER_CONFIRMATION`

  ```json
  {
    "type": "ORDER_CONFIRMATION",
    "orderId": "…",
    "to": "buyer@example.com",
    "idempotencyKey": "order-confirmation:<orderId>",
    "payload": { "orderId": "…" }
  }
  ```

- `ORDER_CANCELLATION` — request body
  `{ "orderId": "…", "customerEmail": "buyer@example.com", "reason": "Changed my mind" }`

  ```json
  {
    "type": "ORDER_CANCELLATION",
    "orderId": "…",
    "to": "buyer@example.com",
    "idempotencyKey": "order-cancellation:<orderId>",
    "payload": { "orderId": "…", "reason": "Changed my mind" }
  }
  ```

The cancellation `reason` is forwarded as a string (including empty). The reason
length rule is owned by `shopflow-orders`, so it is not re-validated here.

## Configuration

- `PROVIDER_URL` — provider base URL (default `http://notification-provider:3004`).
- `PORT` — listening port (default `3003`).

## Usage

```bash
npm ci
npm test
PROVIDER_URL=http://localhost:3004 PORT=3003 npm start
```
