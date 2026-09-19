import { createServer } from "node:http";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.MESSAGE_LOG_PATH ?? "/data/messages.jsonl";
mkdirSync(dirname(path), { recursive: true });
const messages = existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  : [];

createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/health") return res.end(JSON.stringify({ ok: true }));
  if (req.method === "GET" && req.url === "/messages") return res.end(JSON.stringify(messages));
  if (req.method === "POST" && req.url === "/messages") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const message = { id: `message-${messages.length + 1}`, ...input };
    messages.push(message);
    appendFileSync(path, `${JSON.stringify(message)}\n`);
    res.writeHead(201);
    return res.end(JSON.stringify(message));
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}).listen(3004, "0.0.0.0", () => console.log("provider emulator listening on 3004"));
