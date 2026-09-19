# shopflow-notifications

Owns order-confirmation orchestration and sends messages through the configured
provider HTTP interface. Compose configures the deterministic local emulator.

```bash
npm ci
npm test
PROVIDER_URL=http://localhost:3004 PORT=3003 npm start
```
