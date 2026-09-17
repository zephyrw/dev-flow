import { Worker } from "node:worker_threads";
import { validatePlan } from "./validate.js";
import { FlowError } from "../../contracts/src/index.js";
import { createHash } from "node:crypto";
const parsed = new Set<string>();
const pending = new Map<string, Promise<void>>();
let parserQueue = Promise.resolve();
const keyOf = (sources: string[]) =>
  createHash("sha256").update(JSON.stringify(sources)).digest("hex");
export async function parsePlanDiagrams(input: unknown) {
  const validated = validatePlan(input);
  if (!validated.diagrams.length) return validated;
  const key = keyOf(validated.diagrams);
  if (parsed.has(key)) return validated;
  let task = pending.get(key);
  if (!task) {
    task = parserQueue.then(async () => {
      await parseDiagrams(validated.diagrams);
      parsed.add(key);
      if (parsed.size > 64) parsed.delete(parsed.values().next().value!);
    });
    pending.set(key, task);
    parserQueue = task.catch(() => {});
    void task.finally(() => pending.delete(key)).catch(() => {});
  }
  await task;
  return validated;
}
async function parseDiagrams(diagrams: string[]) {
  // Mermaid sanitizes labels through DOMPurify even during parse. Keep the DOM
  // in a disposable worker so browser globals cannot change the server SDKs.
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><html><body></body></html>');
      globalThis.window = dom.window;
      globalThis.document = dom.window.document;
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        parentPort.postMessage({ ready: true });
        for (const source of workerData) await mermaid.parse(source);
        parentPort.postMessage({ ok: true });
      } finally { dom.window.close(); }
    })().catch(error => parentPort.postMessage({ ok: false, error: String(error) }));
  `,
    // Plain JavaScript dependency loading needs no parent test/dev hooks.
    { eval: true, workerData: diagrams, execArgv: [] },
  );
  try {
    await new Promise<void>((done, fail) => {
      // Cold Windows dependency loading can consume the entire parsing budget.
      // Bound initialization separately; actual grammar parsing still gets 30s.
      let timer = setTimeout(
        () => fail(new Error("图表组件初始化超过 120 秒")),
        120000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        error ? fail(error) : done();
      };
      worker.on("message", (result) => {
        if (result.ready) {
          clearTimeout(timer);
          timer = setTimeout(
            () => fail(new Error("图表解析超过 30 秒")),
            30000,
          );
        } else finish(result.ok ? undefined : new Error(result.error));
      });
      worker.once("error", finish);
      worker.once("exit", (code) => {
        if (code !== 0) finish(new Error("图表解析进程退出：" + code));
      });
    });
  } catch (error) {
    throw new FlowError(
      "MERMAID_INVALID",
      "Mermaid 图无法解析：" + String(error),
    );
  } finally {
    await worker.terminate();
  }
}
