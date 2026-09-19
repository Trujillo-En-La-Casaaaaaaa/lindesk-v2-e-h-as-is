# ShopFlow F3 infrastructure

This is the Compose entry point for the frozen six-repository ecosystem.
Orders and inventory use distinct SQLite database volumes. The local provider
emulator deterministically records notifications; no production cloud service
or runtime internet access is used.

## Start

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/api/health
```

Gateway: http://127.0.0.1:3000  
Web: http://127.0.0.1:8080

## Test

```powershell
../shopflow-orders: npm ci; npm test
../shopflow-inventory: npm ci; npm test
```

From the evaluation root:

```powershell
./scripts/run-acceptance.ps1 -Target fixtures/F3-high/app/shopflow-infra -Suite baseline -StartCompose
```

Reset deterministic state with `docker compose down -v`.
