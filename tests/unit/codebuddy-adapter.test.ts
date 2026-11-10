import { expect, it } from "vitest";
import { CodeBuddyNativeAdapter } from "../../packages/adapters/codebuddy/src/adapter.js";
import { classifyCodeBuddyQuotaFailure } from "../../packages/adapters/codebuddy/src/provider-failure.js";
import type { RunContext } from "../../packages/adapters/sdk/src/interface.js";

const root = process.cwd();
const adapter = new CodeBuddyNativeAdapter();
const context: RunContext = {
  workflowId: "wf", runId: "run", stage: "planning", epoch: 1,
  workspaceRoots: { main: root }, allowedPaths: [root], purpose: "planning",
  conversationId: "native-session",
  prompt: '包含中文、引号和换行\n"原样交付"',
  toolProfile: {
    id: "profile", revision: 1, adapterId: "codebuddy-code",
    modelSelection: "explicit", modelId: "example/custom-model", options: {},
  },
};

it("sends input on stdin and limits review to the native read tools on exact resume", () => {
  const result = adapter.buildInvocation(context, process.execPath);
  expect(result.stdin).toBe(context.prompt);
  expect(result.args).toContain("--strict-mcp-config");
  expect(result.args).toContain("Read,Glob,Grep");
  expect(result.args.slice(result.args.indexOf("--permission-mode"), result.args.indexOf("--permission-mode") + 2))
    .toEqual(["--permission-mode", "plan"]);
  expect(result.args.slice(-4)).toEqual(["--resume", "native-session", "--model", "example/custom-model"]);
  expect(result.args).not.toContain(context.prompt);
});

it("distinguishes native credits and rate limits without assuming every HTTP 429 is either", () => {
  const failure = (code: number, status = 429, detail = "Request rejected") => ({
    type: "result", subtype: "error_during_execution", is_error: true,
    errors: [detail], errors_info: [{ status, code }],
  });
  expect(classifyCodeBuddyQuotaFailure(failure(14018), true)).toBe("MODEL_CREDITS_EXHAUSTED");
  expect(classifyCodeBuddyQuotaFailure(failure(6005), true)).toBe("MODEL_RATE_LIMIT");
  expect(classifyCodeBuddyQuotaFailure(failure(14015), true)).toBeUndefined();
  expect(classifyCodeBuddyQuotaFailure(failure(14003, 400), true)).toBeUndefined();
  expect(classifyCodeBuddyQuotaFailure(failure(14003), false)).toBeUndefined();
  expect(classifyCodeBuddyQuotaFailure(failure(14003, 429, "too many requests"), false)).toBe("MODEL_RATE_LIMIT");
  expect(classifyCodeBuddyQuotaFailure({ ...failure(14018), is_error: false }, true)).toBeUndefined();
});

it("uses the native edit mode for a new execution round without resuming another conversation", () => {
  const result = adapter.buildInvocation({ ...context, purpose: "implement", conversationId: undefined }, process.execPath);
  expect(result.args).toContain("acceptEdits");
  expect(result.args).not.toContain("--resume");
  expect(result.args).not.toContain("--continue");
  expect(result.args).not.toContain("--tools");
});
