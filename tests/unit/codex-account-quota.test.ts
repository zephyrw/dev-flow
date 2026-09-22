import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCodexAccountQuota } from "../../packages/runtime/src/codex-account-quota.js";

it("queries only account limits, shares a cached result, and does not start a model or consume credits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "devflow-quota-"));
  const cli = join(cwd, "cli.cjs"), calls = join(cwd, "calls.jsonl");
  writeFileSync(cli, `
    const fs=require('node:fs');
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const v=JSON.parse(line); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(v)+'\\n');
      if(v.method==='initialize') console.log(JSON.stringify({id:v.id,result:{}}));
      if(v.method==='account/rateLimits/read') console.log(JSON.stringify({id:v.id,result:{rateLimits:{primary:{usedPercent:82,windowDurationMins:10080}}}}));
    });
  `);
  const source = { executable: process.execPath, prefixArgs: [cli], cwd, home: cwd };
  const [a,b] = await Promise.all([readCodexAccountQuota(source), readCodexAccountQuota(source)]);
  expect(a).toEqual(b);
  expect(a?.buckets[0]?.windows[0]?.used_percent).toBe(82);
  expect(readFileSync(calls,"utf8").trim().split("\n").map(line=>JSON.parse(line).method)).toEqual(["initialize","initialized","account/rateLimits/read"]);
});
