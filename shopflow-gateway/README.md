# shopflow-gateway

Public Node.js/TypeScript API on port 3000. It only maps and proxies the public
contract; order and inventory business rules remain in their owning services.

```bash
npm ci
npm test
ORDERS_URL=http://localhost:3001 INVENTORY_URL=http://localhost:3002 NOTIFICATIONS_URL=http://localhost:3003 PORT=3000 npm start
```
