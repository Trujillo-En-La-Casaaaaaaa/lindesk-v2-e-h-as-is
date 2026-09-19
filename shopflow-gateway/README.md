# shopflow-gateway

Public Node.js/TypeScript API on port 3000. It only maps and proxies the public
contract; order and inventory business rules remain in their owning services.
It is stateless and rule-free: no validation, retry, deduplication or state.

## Proxied routes

| Public route | Upstream | Notes |
| --- | --- | --- |
| `GET /api/products` | `INVENTORY_URL` `/products` | |
| `GET /api/products/{id}` | `INVENTORY_URL` `/products/{id}` | |
| `POST /api/orders` | `ORDERS_URL` `/orders` | |
| `GET /api/orders/{id}` | `ORDERS_URL` `/orders/{id}` | |
| `POST /api/orders/{id}/ship` | `ORDERS_URL` `/orders/{id}/ship` | |
| `POST /api/orders/{id}/cancel` | `ORDERS_URL` `/orders/{id}/cancel` | Body `{ "reason": "…" }`; upstream status/body passed through unchanged (`200` `Order`, `400`, `404`, `409`, `502`) |
| `GET /api/notifications` | `NOTIFICATIONS_URL` `/notifications` | |

The public route table lives in `src/routes.ts` (`createDestination`); `src/server.ts`
only wires it to the environment-derived upstream URLs.

Inline (not proxied) endpoints: `GET /api/health` → `{ "ok": true }`, `OPTIONS *` → `204`,
CORS headers `access-control-allow-origin: *`, `access-control-allow-headers: content-type`,
`access-control-allow-methods: GET,POST,OPTIONS`. Unknown route → `404`,
upstream fetch failure → `502`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORDERS_URL` | `http://orders:3001` | `shopflow-orders` base URL |
| `INVENTORY_URL` | `http://inventory:3002` | `shopflow-inventory` base URL |
| `NOTIFICATIONS_URL` | `http://notifications:3003` | `shopflow-notifications` base URL |
| `PORT` | `3000` | listen port |

No secrets are read; nothing new is required for cancellation.

## Commands

```bash
npm ci
npm test
ORDERS_URL=http://localhost:3001 INVENTORY_URL=http://localhost:3002 NOTIFICATIONS_URL=http://localhost:3003 PORT=3000 npm start
```

`npm test` builds (`tsc`) and then runs the `node:test` route-table suite
(`dist/routes.test.js`). The Docker image copies `dist/` and runs `node dist/server.js`.
