import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepared } from "../helpers.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import type { Run } from "../../packages/contracts/src/index.js";

it("the profile-based production runtime rejects a successful CLI footer containing denied actions", async () => {
  const s = await prepared();
  const cli = join(s.root, "denied-cli.mjs");
  writeFileSync(
    cli,
    `console.log(JSON.stringify({event:"init",conversation_id:"denied-session"})); console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"{}",denied_actions:[{action:"write_file",display_name:"WriteToFile"}]}}));`,
  );
  const run: Run = {
    started_at: new Date().toISOString(),
    package_hash: "isolated-permission-fixture",
    id: s.principal.run_id,
    workflow_id: s.workflow.id,
    stage: "execute",
    purpose: "implement",
    adapter: "agy",
    execution_spec_id: "isolated-spec",
    status: "running",
    plan_revision: 1,
    profile: {
      id: "test-agy",
      adapterId: "agy",
      revision: 1,
      executableRef: process.execPath,
      modelSelection: "explicit",
      modelId: "fixture-only",
      options: { prefixArgs: [cli] },
    },
  };
  s.store.put("execution_spec", "isolated-spec", s.workflow.id, {
    workflow_id: s.workflow.id,
  });
  s.store.put("run", run.id, s.workflow.id, run);
  const runtime = new LocalRuntime(s.engine);
  try {
    await expect(
      runtime.execute(s.engine.get(s.workflow.id), run, "fixture-token"),
    ).rejects.toMatchObject({ code: "NATIVE_PERMISSION_DENIED" });
    expect(s.store.list("delivery", s.workflow.id)).toEqual([]);
    expect(s.store.get("conversation", s.workflow.id)).toMatchObject({
      id: "denied-session",
    });
    expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
  } finally {
    await runtime.close();
    s.store.close();
  }
});
