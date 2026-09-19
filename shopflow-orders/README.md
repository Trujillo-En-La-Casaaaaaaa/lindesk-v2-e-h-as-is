# shopflow-orders

Owns order lifecycle and its private SQLite database. Inventory validation and
stock changes use the inventory HTTP API; confirmations use the notifications
HTTP API. This service never opens another service's database.

```bash
npm ci
npm test
DATABASE_PATH=./orders.db INVENTORY_URL=http://localhost:3002 NOTIFICATIONS_URL=http://localhost:3003 PORT=3001 npm start
```
