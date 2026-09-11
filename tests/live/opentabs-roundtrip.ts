import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const output = resolve(".cache/live-opentabs");
mkdirSync(output, { recursive: true });
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    '<!doctype html><html><title>DevFlow OpenTabs 验收</title><body><h1>DevFlow 真实浏览器验收</h1><input id="name" aria-label="测试标记"><button id="submit" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">确认</button><p id="result">等待输入</p></body></html>',
  );
});
await new Promise<void>((r) => server.listen(14815, "127.0.0.1", r));
const client = new Client({ name: "devflow-live-browser-test", version: "1" });
const transcript: unknown[] = [];
let tabId: number | undefined;
function data(result: any): any {
  if (result.structuredContent) return result.structuredContent;
  const t = result.content?.find((c: any) => c.type === "text")?.text;
  try {
    return JSON.parse(t);
  } catch {
    return { text: t };
  }
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  transcript.push({ name, args, result });
  if (result.isError) throw Error(JSON.stringify(result));
  const value = data(result);
  console.log(name, JSON.stringify(value).slice(0, 1500));
  return value;
}
try {
  const secret = JSON.parse(
    readFileSync(join(homedir(), ".opentabs/extension/auth.json"), "utf8"),
  ).secret;
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:9515/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  const opened = await call("browser_open_tab", {
    url: "http://127.0.0.1:14815",
  });
  tabId = opened.tabId ?? opened.id ?? opened.tab?.id;
  if (!tabId) throw Error("Unknown tab identifier");
  await call("browser_wait_for_element", {
    tabId,
    selector: "#submit",
    visible: true,
  });
  await call("browser_type_text", {
    tabId,
    selector: "#name",
    text: "OPENTABS-LIVE-568209",
  });
  await call("browser_click_element", { tabId, selector: "#submit" });
  const value = await call("browser_get_tab_content", {
    tabId,
    selector: "#result",
  });
  if (!JSON.stringify(value).includes("OPENTABS-LIVE-568209"))
    throw Error("Browser roundtrip assertion failed");
  await call("browser_screenshot_tab", {
    tabId,
    filePath: join(output, "real-browser.png"),
  });
  console.log("REAL OPENTABS ROUNDTRIP PASSED");
} finally {
  if (tabId) await call("browser_close_tab", { tabId }).catch(() => {});
  writeFileSync(
    join(output, "roundtrip.json"),
    JSON.stringify(transcript, null, 2),
  );
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
}
