import { createServer } from "node:http";
const api = process.env.DEVFLOW_API_TARGET;
if (!api) throw Error("DEVFLOW_API_TARGET is required");
createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    try {
      const chunks = [];
      for await (const b of req) chunks.push(b);
      const response = await fetch(api + req.url.slice(4), {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: ["GET", "HEAD"].includes(req.method)
          ? undefined
          : Buffer.concat(chunks),
        redirect: "error",
      });
      res.writeHead(response.status, {
        "Content-Type": "application/json",
        "x-devflow-identity": response.headers.get("x-devflow-identity") ?? "",
      });
      res.end(await response.text());
    } catch {
      res.writeHead(502).end();
    }
    return;
  }
  res.setHeader("x-devflow-identity", process.env.DEVFLOW_IDENTITY);
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DevFlow 并行环境演示</title><style>body{font:16px system-ui;max-width:760px;margin:80px auto;background:#f4f6f0;color:#17392b}input,button{padding:12px;font:inherit}button{background:#22553f;color:white;border:0;border-radius:6px}output{display:block;margin-top:30px}</style><h1>独立测试环境</h1><p>输入的内容只写入本工作流的数据目录，刷新后仍可读取。</p><label>验收标记 <input id="note"></label> <button id="save">保存</button><output id="result">加载中</output><script>const show=async()=>{const r=await fetch('/api/notes');document.querySelector('#result').textContent=(await r.json()).text||'暂无内容';document.querySelector('#result').dataset.ready='true'};document.querySelector('#save').onclick=async()=>{document.querySelector('#result').dataset.ready='false';await fetch('/api/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:document.querySelector('#note').value})});await show()};show();</script></html>`,
  );
}).listen(Number(process.env.DEVFLOW_PORT), "127.0.0.1");
