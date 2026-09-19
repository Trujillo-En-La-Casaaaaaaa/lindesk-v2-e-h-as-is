# shopflow-inventory

Owns the inventory SQLite database and exposes explicit HTTP APIs. Seed IDs are
`prod-a` (SKU-A, stock 20) and `prod-b` (SKU-B, stock 10).

```bash
npm ci
npm test
DATABASE_PATH=./inventory.db PORT=3002 npm start
```
