import { describe, expect, it } from "vitest";
import {
  DiagnosticRedactionContext, DiagnosticStreamRedactor, diagnosticClip, publicDiagnostic, redactSecrets,
} from "../../packages/presentation/src/secret-redactor.js";
import { toolSummary } from "../../packages/presentation/src/tool-summary.js";
import { AgentTelemetry } from "../../packages/runtime/src/agent-telemetry.js";
import { createActivityPayload } from "../../packages/core/src/conversation-service.js";

describe("F11 diagnostic copies", () => {
  it("preserves colored test failures and heap diagnostics while masking credentials", () => {
    const colored = '\u001b[31mFAIL\u001b[0m fixture.test.ts: expected 1, received 2\n' +
      '\u001b[2mFATAL ERROR: Reached heap limit\u001b[0m password=secret-value';
    const safe = publicDiagnostic(colored);
    expect(safe).toContain("FAIL fixture.test.ts: expected 1, received 2");
    expect(safe).toContain("FATAL ERROR: Reached heap limit");
    expect(safe).toContain("[REDACTED]");
    expect(safe).not.toContain("secret-value");
    expect(safe).not.toContain("\u001b");
    expect(publicDiagnostic("binary\u0000payload")).toBe("[已省略二进制内容]");
    expect(publicDiagnostic("unknown\u001b]escape")).toBe("[已省略二进制内容]");
  });

  it("strips SGR split across chunks before detecting an authentication operation", () => {
    const raw = 'tool lo\u001b[31mg\u001b[0min\nunlabelled-credential\n';
    for (let split = 1; split < raw.length; split++) {
      const stream = new DiagnosticStreamRedactor();
      const safe = stream.push(raw.slice(0, split)) + stream.push(raw.slice(split), true);
      expect(safe).toContain("仅保留状态");
      expect(safe).not.toContain("unlabelled-credential");
    }
  });

  it("does not mistake V8 GC process prefixes for an unfinished JSON array", () => {
    const raw = '[1234:0xabc] 100 ms: Mark-Compact 4095 MB\nFATAL ERROR: Reached heap limit\n';
    const stream = new DiagnosticStreamRedactor();
    const safe = stream.push(raw, true);
    expect(safe).toContain("Mark-Compact 4095 MB");
    expect(safe).toContain("FATAL ERROR: Reached heap limit");
    expect(safe).not.toContain("不完整诊断");
    const partial = new DiagnosticStreamRedactor();
    expect(partial.push('[1,', true)).toContain("不完整诊断记录已省略");
  });

  it.each([
    'password="two words" after', "--password='two words' after",
    '--api-key "two words" after', "Authorization: Basic dHdvIHdvcmRz after",
    'Bearer dHdvIHdvcmRz after', 'https://user:two%20words@example.test/path',
    'https://example.test/?access%5Ftoken=two%20words&ok=1',
    '-----BEGIN PRIVATE KEY-----\ntwo words\n-----END PRIVATE KEY-----',
    'password="two words',
  ])("removes the complete credential before clipping: %s", (raw) => {
    const safe = redactSecrets(raw);
    for (const secret of ["two words", "two%20words", "dHdvIHdvcmRz"])
      expect(safe).not.toContain(secret);
    expect(redactSecrets(safe)).toBe(safe);
  });

  it("keeps JSON values parseable without changing the input or ordinary diagnostics", () => {
    const input = { output: JSON.stringify({ password: 'two "words"', text: "Build failed: missing module" }), input_tokens: 12 };
    const original = JSON.stringify(input);
    const safe = publicDiagnostic(input);
    expect(JSON.parse(safe.output)).toEqual({ password: "[REDACTED]", text: "Build failed: missing module" });
    expect(safe.input_tokens).toBe(12);
    expect(JSON.stringify(input)).toBe(original);
    expect(diagnosticClip('password="' + "x".repeat(1000) + '" missing module', 50)).toContain("missing module");
  });

  it("buffers every transport split including private keys and preserves JSONL framing", () => {
    const raw = '{"text":"Authorization: Basic dHdvIHdvcmRz"}\n' +
      '-----BEGIN PRIVATE KEY-----\ntwo words\n-----END PRIVATE KEY-----\n' +
      '{"text":"Build failed: missing module"}\n';
    for (let split = 1; split < raw.length; split++) {
      const stream = new DiagnosticStreamRedactor();
      const safe = stream.push(raw.slice(0, split)) + stream.push(raw.slice(split), true);
      expect(safe).not.toContain("dHdvIHdvcmRz");
      expect(safe).not.toContain("two words");
      expect(safe).toContain('}\n');
      expect(safe).toContain("missing module");
    }
    const bounded = new DiagnosticStreamRedactor(32);
    expect(bounded.push("x".repeat(33))).toContain("已省略");
    expect(bounded.push("secret-tail\n", true)).toBe("");
  });

  it("uses the authentication whitelist across timed flushes and complete message deltas", () => {
    const events: unknown[] = [];
    const store = { transaction: (f: () => void) => f(), event: (_w: unknown, _p: unknown, _t: unknown, value: unknown) => events.push(value) };
    const telemetry = new AgentTelemetry(store as any, "wf", "p", "run");
    const update = (step_index: number, fields: Record<string, unknown>) => telemetry.accept({ event: "step_update", step_update: { step_index, step_type: "agent_response", ...fields } });
    update(1, { state: "RUNNING", text_delta: "password=\"two " });
    telemetry.flush();
    update(1, { state: "DONE", text_delta: "words\"" });
    telemetry.flush();
    update(2, { state: "RUNNING", tool_name: "login", tool_info: { parameters: { command: "tool login" } } });
    telemetry.flush();
    update(2, { state: "DONE", tool_info: { output: "unlabelled-credential" } });
    telemetry.flush();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("two ");
    expect(serialized).not.toContain("words");
    expect(serialized).not.toContain("unlabelled-credential");
    expect(serialized).toContain("REDACTED");
    expect(toolSummary("run_command", { command: "tool login", cwd: "sensitive/path" }).cwd).toBeUndefined();
  });

  it("retains authentication activity identity and terminal state without its output", () => {
    const safe = publicDiagnostic({
      id: "tool:1", conversation_id: "conversation", attempt_id: "attempt",
      activity_id: "source:2", source_event_id: "source:2", kind: "tool",
      title: "敏感认证操作", text: "unlabelled-credential", command: "tool login",
      status: "interrupted", exit_code: 1,
    });
    expect(safe.id).toBe("tool:1");
    expect(safe.activity_id).toBe("source:2");
    expect(safe.kind).toBe("tool");
    expect(safe.status).toBe("interrupted");
    expect(safe.exit_code).toBe(1);
    expect(safe.title).toContain("仅保留状态");
    expect(safe.command).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("unlabelled-credential");
    expect(publicDiagnostic(safe)).toEqual(safe);
  });

  it("sanitizes activity titles and cwd as well as text and command before persistence", () => {
    const payload = createActivityPayload(
      { source_id: "source", source_seq: "1" } as any,
      { title: 'password="two words"', cwd: "https://u:two%20words@example.test/path", public_text: "Basic dHdvIHdvcmRz", command: "tool --password='two words'" },
      { id: "conversation", root_id: "conversation" } as any,
      { id: "attempt" } as any,
    );
    expect(payload).toBeDefined();
    expect(JSON.stringify(payload)).not.toMatch(/two words|two%20words|dHdvIHdvcmRz/);
  });
  it.each([
    [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "auth", name: "Bash", input: { command: "tool login" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "auth", content: "bare-secret-value" }] } },
    ],
    [
      { type: "function_call", call_id: "auth", name: "shell", arguments: '{"command":"tool login"}' },
      { type: "function_call_output", call_id: "auth", output: "bare-secret-value" },
    ],
    [
      { event: "step_update", step_update: { step_index: 1, tool_name: "Bash", tool_info: { parameters: { command: "tool login" } }, state: "RUNNING" } },
      { event: "step_update", step_update: { step_index: 1, tool_info: { output: "bare-secret-value" }, state: "DONE" } },
    ],
  ])("correlates authentication results across streams and every transport split", (call, result) => {
    const encoded = JSON.stringify(call) + "\n";
    for (let split = 1; split < encoded.length; split++) {
      const context = new DiagnosticRedactionContext();
      const stdout = new DiagnosticStreamRedactor(65536, context);
      const stderr = new DiagnosticStreamRedactor(65536, context);
      const raw = JSON.stringify(result) + "\n";
      const safe = stdout.push(encoded.slice(0, split)) + stdout.push(encoded.slice(split)) +
        stderr.push(raw) + stdout.push(raw, true);
      expect(safe).not.toContain("bare-secret-value");
      expect(safe).toContain("仅保留状态");
      expect(JSON.stringify(result)).toContain("bare-secret-value");
    }
  });

  it("quarantines early results, repeated calls and unassociated authentication output", () => {
    const context = new DiagnosticRedactionContext();
    const result = { type: "function_call_output", call_id: "early", output: "bare-secret-value" };
    expect(JSON.stringify(context.project(result))).not.toContain("bare-secret-value");
    context.project({ type: "function_call", call_id: "early", name: "shell", arguments: '{"command":"echo ok"}' });
    expect(JSON.stringify(context.project(result))).not.toContain("bare-secret-value");
    context.project({ type: "tool_use", id: "auth", name: "Bash", input: { command: "tool login" } });
    context.project({ type: "tool_use", id: "auth", name: "Bash", input: { command: "echo ok" } });
    expect(JSON.stringify(context.project({ type: "tool_result", tool_use_id: "auth", content: "bare-secret-value" }))).not.toContain("bare-secret-value");
    expect(context.project("bare-secret-value")).not.toContain("bare-secret-value");
    const partial = new DiagnosticRedactionContext();
    partial.project({ type: "content_block_start", content_block: { type: "tool_use", id: "partial", name: "Bash", input: {} } });
    partial.project({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"command":"tool lo' } });
    expect(JSON.stringify(partial.project({ type: "tool_result", tool_use_id: "partial", content: "bare-secret-value" }))).not.toContain("bare-secret-value");
  });

  it("keeps known ordinary tools readable without authorizing sibling output or another Run", () => {
    const context = new DiagnosticRedactionContext();
    context.project({ type: "tool_use", id: "auth", name: "Bash", input: { command: "tool login" } });
    context.project({ type: "tool_use", id: "build", name: "Bash", input: { command: "pnpm build" } });
    const result = { type: "tool_result", tool_use_id: "build", content: "Build failed: missing module" };
    expect(JSON.stringify(context.project(result))).toContain("missing module");
    expect(JSON.stringify(context.project({ content: [result, { type: "text", text: "bare-secret-value" }] }))).not.toContain("bare-secret-value");
    expect(JSON.stringify(new DiagnosticRedactionContext().project(result))).not.toContain("missing module");
    expect(new DiagnosticRedactionContext().project("ordinary diagnostic")).toBe("ordinary diagnostic");
  });

  it("fails closed across both streams after association or framing limits", () => {
    const context = new DiagnosticRedactionContext(1);
    context.project({ type: "tool_use", id: "one", name: "Bash", input: { command: "echo ok" } });
    context.project({ type: "tool_use", id: "two", name: "Bash", input: { command: "echo ok" } });
    expect(context.project("bare-secret-value")).not.toContain("bare-secret-value");
    const shared = new DiagnosticRedactionContext();
    const stdout = new DiagnosticStreamRedactor(32, shared);
    const stderr = new DiagnosticStreamRedactor(65536, shared);
    stdout.push("x".repeat(33));
    expect(stderr.push("bare-secret-value\n")).not.toContain("bare-secret-value");
  });

});
