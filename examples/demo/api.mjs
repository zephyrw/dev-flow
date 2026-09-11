import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.env.DEVFLOW_DATA_DIR;
if (!root) throw Error("DEVFLOW_DATA_DIR is required");
mkdirSync(root, { recursive: true });
const file = join(root, "notes.json");
createServer(async (req, res) => {
  res.setHeader("x-devflow-identity", process.env.DEVFLOW_IDENTITY);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.url === "/health") {
    res.end(
      JSON.stringify({ ok: true, workflow: process.env.DEVFLOW_WORKFLOW_ID }),
    );
    return;
  }
  if (req.url === "/notes" && req.method === "POST") {
    let raw = "";
    for await (const b of req) {
      raw += b;
      if (raw.length > 4096) {
        res.writeHead(413).end();
        return;
      }
    }
    try {
      const value = JSON.parse(raw);
      if (typeof value.text !== "string" || !value.text.trim()) throw Error();
      writeFileSync(file, JSON.stringify({ text: value.text }));
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "请输入内容" }));
      return;
    }
  }
  if (req.url === "/notes") {
    res.end(
      existsSync(file) ? readFileSync(file) : JSON.stringify({ text: "" }),
    );
    return;
  }
  res.writeHead(404).end("{}");
}).listen(Number(process.env.DEVFLOW_PORT), "127.0.0.1");
