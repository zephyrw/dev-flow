import { Worker } from "node:worker_threads";
import { validatePlan } from "./validate.js";
import { FlowError } from "../../contracts/src/index.js";
export async function parsePlanDiagrams(input: unknown) {
  const validated = validatePlan(input);
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
        for (const source of workerData) await mermaid.parse(source);
        parentPort.postMessage({ ok: true });
      } finally { dom.window.close(); }
    })().catch(error => parentPort.postMessage({ ok: false, error: String(error) }));
  `,
    { eval: true, workerData: validated.diagrams },
  );
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("图表解析超过 30 秒")),
        30000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        error ? fail(error) : done();
      };
      worker.once("message", (result) =>
        finish(result.ok ? undefined : new Error(result.error)),
      );
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
  return validated;
}
