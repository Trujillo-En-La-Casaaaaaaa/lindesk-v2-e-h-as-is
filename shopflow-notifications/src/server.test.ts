import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import test, { type TestContext } from "node:test";
import { createServer } from "./server.js";

type StubRecord = { method: string; path: string; body: unknown };

function createStubProvider(status = 201): { server: Server; received: StubRecord[] } {
  const received: StubRecord[] = [];
  const server = createHttpServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      received.push({ method: req.method ?? "", path: req.url ?? "", body });

      if (req.method === "GET") {
        const messages = received.filter((entry) => entry.method === "POST").map((entry) => entry.body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(messages));
        return;
      }
      if (status >= 400) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "provider failure" }));
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m1", message: body }));
    })();
  });
  return { server, received };
}

async function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server did not bind to a port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startStack(t: TestContext, providerStatus = 201) {
  const stub = createStubProvider(providerStatus);
  const stubListener = await listen(stub.server);
  const notificationsServer = createServer({ providerUrl: `http://127.0.0.1:${stubListener.port}` });
  const app = await listen(notificationsServer);
  t.after(async () => {
    await app.close();
    await stubListener.close();
  });
  return { baseUrl: `http://127.0.0.1:${app.port}`, received: stub.received };
}

test("POST /notifications/order-cancellation forwards a stable cancellation message", async (t) => {
  const stack = await startStack(t);
  const response = await fetch(`${stack.baseUrl}/notifications/order-cancellation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: "o1", customerEmail: "buyer@example.com", reason: "Changed my mind" }),
  });

  assert.equal(response.status, 201);
  assert.equal(stack.received.length, 1);
  const forwarded = stack.received[0].body as {
    type?: string;
    orderId?: string;
    to?: string;
    idempotencyKey?: string;
    payload?: { orderId?: string; reason?: string };
  };
  assert.equal(forwarded.type, "ORDER_CANCELLATION");
  assert.equal(forwarded.orderId, "o1");
  assert.equal(forwarded.to, "buyer@example.com");
  assert.equal(forwarded.idempotencyKey, "order-cancellation:o1");
  assert.deepEqual(forwarded.payload, { orderId: "o1", reason: "Changed my mind" });
});

test("POST /notifications/order-cancellation rejects an invalid body without calling the provider", async (t) => {
  const stack = await startStack(t);
  const response = await fetch(`${stack.baseUrl}/notifications/order-cancellation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerEmail: "buyer.example.com", reason: "x" }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid notification" });
  assert.equal(stack.received.length, 0);
});

test("POST /notifications/order-cancellation surfaces a provider failure as 502", async (t) => {
  const stack = await startStack(t, 500);
  const response = await fetch(`${stack.baseUrl}/notifications/order-cancellation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: "o1", customerEmail: "buyer@example.com", reason: "Changed my mind" }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Notification provider failed" });
});

test("POST /notifications/order-confirmation still returns 201", async (t) => {
  const stack = await startStack(t);
  const response = await fetch(`${stack.baseUrl}/notifications/order-confirmation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: "o2", customerEmail: "buyer@example.com" }),
  });

  assert.equal(response.status, 201);
  const forwarded = stack.received[0].body as { type?: string; idempotencyKey?: string };
  assert.equal(forwarded.type, "ORDER_CONFIRMATION");
  assert.equal(forwarded.idempotencyKey, "order-confirmation:o2");
});

test("GET /notifications proxies the provider message list", async (t) => {
  const stack = await startStack(t);
  await fetch(`${stack.baseUrl}/notifications/order-cancellation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: "o3", customerEmail: "buyer@example.com", reason: "" }),
  });

  const response = await fetch(`${stack.baseUrl}/notifications`);
  assert.equal(response.status, 200);
  const messages = (await response.json()) as Array<{ type?: string }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "ORDER_CANCELLATION");
});

test("GET /health responds ok", async (t) => {
  const stack = await startStack(t);
  const response = await fetch(`${stack.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
