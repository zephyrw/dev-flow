import { statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { PreparedInvocation } from "../../sdk/src/interface.js";
import { writePermissionArtifacts } from "../../sdk/src/permission-artifacts.js";

export interface OpenCodePermissionInvocation {
  executable: string;
  prefix: string[];
  cwd: string;
  session: string;
  prompt: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
  readonly: boolean;
  unmappedPermissionTools?: string[];
}

export interface OpenCodePermissionGrant { calls: Array<{ name: string; parameters?: Record<string, unknown> }> }

/** Convert only the approved tools' native gates to ask in this Run's primary agent. */
export function openCodePermissionAskConfig(
  content: string | undefined,
  agentName: string | undefined,
  grant: OpenCodePermissionGrant,
  readonly: boolean,
  cwd: string,
): { content: string; unmappedTools: string[] } {
  const config = JSON.parse(content ?? "{}");
  if (!config || typeof config !== "object" || Array.isArray(config) || !agentName)
    throw new Error("OpenCode permission bridge requires a scoped primary agent");
  const agent = config.agent?.[agentName];
  if (!agent || typeof agent !== "object" || Array.isArray(agent) || agent.mode !== "primary")
    throw new Error("OpenCode permission bridge cannot change an unbound or child agent");
  const previous = agent.permission;
  if (previous !== undefined && typeof previous !== "string" &&
      (!previous || typeof previous !== "object" || Array.isArray(previous)))
    throw new Error("Invalid OpenCode primary-agent permission configuration");
  const permission: Record<string, unknown> = typeof previous === "string" ? { "*": previous } : { ...(previous ?? {}) };
  const unmappedTools: string[] = [];
  let changed = false;
  const askPattern = (key: string, pattern: string) => {
    const prior = permission[key];
    // A native allow needs no override. In particular ordinary Read calls must
    // not all become ask merely because one external path was approved.
    if (prior === "allow" || prior === "ask" || prior === undefined && ["allow", "ask"].includes(String(permission["*"]))) return true;
    const rules = typeof prior === "string" ? { "*": prior }
      : prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {};
    // Unknown inherited policy may already allow this path. Only promote a
    // locally explicit deny; never replace an unknown user's allow with ask.
    const entries = Object.entries(rules);
    if (entries.some(([old]) => old !== "*" && old !== pattern)) return false;
    const action = entries.filter(([old]) => old === "*" || old === pattern).at(-1)?.[1] ?? permission["*"];
    if (action === "allow" || action === "ask") return true;
    if (action !== "deny") return false;
    delete permission[key];
    permission[key] = { ...Object.fromEntries(Object.entries(rules).filter(([old]) => old !== pattern)), [pattern]: "ask" };
    changed = true;
    return true;
  };
  for (const { name, parameters = {} } of grant.calls) {
    if (readonly && !["read", "glob", "grep", "list"].includes(name))
      throw new Error("OpenCode permission grant exceeds the read-only role");
    const fileTool = ["read", "write", "edit"].includes(name);
    const searchTool = ["glob", "grep"].includes(name);
    if ((!fileTool && !searchTool) || fileTool && typeof parameters.filePath !== "string" ||
        searchTool && typeof parameters.pattern !== "string") { unmappedTools.push(name); continue; }
    const target = resolve(cwd, fileTool ? parameters.filePath as string : typeof parameters.path === "string" ? parameters.path : ".");
    const pattern = fileTool ? relative(cwd, target) : parameters.pattern as string;
    const key = name === "write" || name === "edit" ? "edit" : name;
    // Native permission keys are wildcards, not literals. Do not turn a tool's
    // glob expression or a special-character filename into a broader ask rule.
    if (/[?*]/.test(pattern)) {
      if (permission[key] !== "allow") unmappedTools.push(name);
    } else if (!askPattern(key, pattern)) unmappedTools.push(name);
    const outside = relative(cwd, target);
    if (isAbsolute(outside) || outside === ".." || outside.startsWith("..\\") || outside.startsWith("../")) {
      let directory = name === "glob";
      if (name === "read" || name === "grep") {
        try { directory = statSync(target).isDirectory(); } catch { directory = false; }
      }
      const folder = directory ? target : dirname(target);
      if (/[?*]/.test(folder)) { unmappedTools.push(name); continue; }
      if (!askPattern("external_directory", join(folder, "*").replaceAll("\\", "/"))) unmappedTools.push(name);
    }
  }
  if (changed)
    config.agent = { ...config.agent, [agentName]: { ...agent, permission } };
  return { content: JSON.stringify(config), unmappedTools: [...new Set(unmappedTools)] };
}

/** Only the SDK-generated run form is accepted; unknown options never disappear silently. */
export function openCodePermissionInvocation(
  invocation: PreparedInvocation,
  readonly: boolean,
  expectedConversation: string,
): OpenCodePermissionInvocation {
  // BaseNativeAgentAdapter.prepare applies nativeLaunch first: Windows npm shims
  // become an actual .exe, or node.exe plus a script prefix. Never run a shim via shell.
  if (process.platform === "win32" && extname(invocation.executable).toLowerCase() !== ".exe")
    throw new Error("OpenCode permission bridge requires a resolved Windows executable, not a shell wrapper");
  const run = invocation.args.indexOf("run");
  if (run < 0 || !expectedConversation) throw new Error("OpenCode permission bridge requires a bound run invocation");
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = run + 1; i < invocation.args.length; i++) {
    const arg = invocation.args[i]!;
    if (arg.startsWith("--")) {
      if (!["--format", "--session", "--model", "--variant", "--agent"].includes(arg) || flags[arg] !== undefined)
        throw new Error("Unsupported OpenCode permission invocation option: " + arg);
      const value = invocation.args[++i];
      if (!value) throw new Error("Missing OpenCode invocation option value");
      flags[arg] = value;
    } else positional.push(arg);
  }
  if (flags["--format"] !== "json" || flags["--session"] !== expectedConversation || positional.length !== 1)
    throw new Error("OpenCode permission bridge requires exact JSON session continuation");
  const token = flags["--model"];
  const slash = token?.indexOf("/") ?? -1;
  if (token && (slash < 1 || slash === token.length - 1)) throw new Error("OpenCode model must include its provider");
  if (readonly && flags["--agent"] !== "devflow-review") throw new Error("OpenCode read-only agent was not preserved");
  return {
    executable: invocation.executable, prefix: invocation.args.slice(0, run), cwd: invocation.cwd,
    session: expectedConversation, readonly,
    prompt: positional[0]! + (invocation.stdin ? "\n" + invocation.stdin : ""),
    ...(token ? { model: { providerID: token.slice(0, slash), modelID: token.slice(slash + 1) } } : {}),
    ...(flags["--variant"] ? { variant: flags["--variant"] } : {}),
    ...(flags["--agent"] ? { agent: flags["--agent"] } : {}),
  };
}

/**
 * OpenCode 1.x run auto-rejects permission.asked and never invokes permission.ask.
 * Use its native server API for an approved continuation, with one private server
 * owned by this subprocess. No plugin, persistent grant, or global server is used.
 */
export function prepareOpenCodePermissionBridge(
  invocation: PreparedInvocation,
  runRoot: string,
  grant: OpenCodePermissionGrant,
  readonly: boolean,
  expectedConversation: string,
): { invocation: PreparedInvocation; cleanup: () => void } {
  if (!isAbsolute(runRoot)) throw new Error("OpenCode permission driver requires an absolute Run root");
  const input = openCodePermissionInvocation(invocation, readonly, expectedConversation);
  const ask = openCodePermissionAskConfig(invocation.env.OPENCODE_CONFIG_CONTENT, input.agent, grant, readonly, invocation.cwd);
  input.unmappedPermissionTools = ask.unmappedTools;
  const scriptPath = join(runRoot, "opencode-permission-driver.mjs");
  const cleanup = writePermissionArtifacts([{ path: scriptPath, content: openCodePermissionDriverSource(input) }]);
  return {
    invocation: { ...invocation, executable: process.execPath, args: [scriptPath], stdin: undefined,
      env: { ...invocation.env, OPENCODE_CONFIG_CONTENT: ask.content } },
    cleanup,
  };
}

export function openCodePermissionDriverSource(input: OpenCodePermissionInvocation): string {
  return `const input = ${JSON.stringify(input)};\n` + String.raw`
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
const password = randomBytes(32).toString("hex");
const username = "devflow";
if (input.unmappedPermissionTools?.length) process.stderr.write(
  "OpenCode permission bridge: cannot safely derive all native ask rules for " + input.unmappedPermissionTools.join(", ") +
  "; unsupported or inherited rules are unchanged and may still deny this call.\n");
const headers = {
  Authorization: "Basic " + Buffer.from(username + ":" + password).toString("base64"),
  "Content-Type": "application/json",
  "x-opencode-directory": encodeURIComponent(input.cwd),
};
// Native --port 0 prefers the shared default 4096. Reserve an ephemeral port
// explicitly; if another process wins the close/start race, startup must fail.
const port = await new Promise((resolve, reject) => {
  const reservation = createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    reservation.close(error => {
      if (error || !address || typeof address === "string") reject(error ?? new Error("No ephemeral port"));
      else resolve(address.port);
    });
  });
});
const server = spawn(input.executable, [...input.prefix, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--mdns=false"], {
  cwd: input.cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
});
const lifetime = new AbortController();
let origin;
let stopping = false;
let busy = false;
let failed = false;
let denied = false;
let readyTimer;
let exitResolve;
const exited = new Promise(resolve => { exitResolve = resolve; });
server.once("exit", (code, signal) => { exitResolve(); if (!stopping) lifetime.abort(new Error("OpenCode server exited: " + (code ?? signal))); });
server.once("error", error => { exitResolve(); lifetime.abort(error); });
const emit = (type, data) => process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID: input.session, ...data }) + "\n");
const ready = new Promise((resolve, reject) => {
  let buffer = "";
  readyTimer = setTimeout(() => reject(new Error("OpenCode private server did not become ready")), 30000);
  const inspect = chunk => {
    if (origin) return;
    buffer = (buffer + chunk.toString("utf8")).slice(-16384);
    const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
    if (match) {
      if (match[1] !== "http://127.0.0.1:" + port) { reject(new Error("OpenCode listener identity changed")); return; }
      origin = match[1]; clearTimeout(readyTimer); resolve();
    }
  };
  server.stdout.on("data", inspect);
  server.stderr.on("data", chunk => { inspect(chunk); process.stderr.write(chunk); });
  server.once("error", reject);
  server.once("exit", () => reject(new Error("OpenCode private server exited before startup")));
});
async function request(path, method = "GET", body, timeout = 15000) {
  const response = await fetch(new URL(path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeout ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]) : lifetime.signal,
  });
  if (!response.ok) throw new Error("OpenCode native API returned " + response.status);
  return response;
}
async function json(path, method, body) { return (await request(path, method, body)).json(); }
const sessionPath = "/session/" + encodeURIComponent(input.session);
async function replyPermission(permission) {
  // Do not consume another session's request, including child-agent requests.
  if (permission.sessionID !== input.session) {
    await json("/permission/" + encodeURIComponent(permission.id) + "/reply", "POST", { reply: "reject" });
    return;
  }
  let allow = false;
  try {
    let part;
    if (permission.tool?.messageID && permission.tool?.callID) {
      const message = await json(sessionPath + "/message/" + encodeURIComponent(permission.tool.messageID));
      part = message.parts?.find(part => part.type === "tool" && part.callID === permission.tool.callID && part.messageID === permission.tool.messageID);
    }
    if (!part || part.sessionID !== input.session || !part.messageID || !part.callID ||
        !["pending", "running"].includes(part.state?.status) || !part.state?.input ||
        typeof part.state.input !== "object" || Array.isArray(part.state.input)) throw new Error("Native call is no longer pending");
    if (input.readonly && !["read", "glob", "grep", "list"].includes(part.tool)) throw new Error("Read-only role");
    if (!process.env.DEVFLOW_RUN_TOKEN || !process.env.DEVFLOW_BASE_URL) throw new Error("Missing permission host");
    const approval = await fetch(new URL("/api/worker/native-permission", process.env.DEVFLOW_BASE_URL), {
      method: "POST", headers: { Authorization: "Bearer " + process.env.DEVFLOW_RUN_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: permission.sessionID, nativeCallId: part.messageID + ":" + part.callID,
        toolCall: { name: part.tool, args: part.state.input } }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    });
    if (!approval.ok) throw new Error("Permission host unavailable");
    allow = (await approval.json()).decision === "allow";
  } catch { allow = false; }
  await json("/permission/" + encodeURIComponent(permission.id) + "/reply", "POST", { reply: allow ? "once" : "reject" });
  if (!allow) denied = true;
}
async function handle(event) {
  const props = event.properties;
  if (!props) return false;
  if (event.type === "permission.asked") {
    await replyPermission(props);
    return false;
  }
  if (event.type === "question.asked") {
    // Non-interactive run denies questions. A server continuation must not
    // wait forever or treat a boolean tool approval as an answer.
    await json("/question/" + encodeURIComponent(props.id) + "/reject", "POST");
    return false;
  }
  if (event.type === "message.part.updated") {
    const part = props.part;
    if (!part || part.sessionID !== input.session) return false;
    if (part.type === "tool" && ["running", "completed", "error"].includes(part.state?.status)) emit("tool_use", { part });
    if (part.type === "step-start") emit("step_start", { part });
    if (part.type === "step-finish") emit("step_finish", { part });
    if (part.type === "text" && part.time?.end) emit("text", { part });
  }
  if (event.type === "session.error" && props.sessionID === input.session) {
    failed = true;
    emit("error", { error: props.error });
    throw new Error("OpenCode native session failed");
  }
  if (event.type === "session.status" && props.sessionID === input.session) {
    if (props.status?.type === "busy") busy = true;
    if (busy && props.status?.type === "idle") return true;
  }
  return false;
}
async function events(response) {
  if (!response.body) throw new Error("OpenCode event stream missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("OpenCode event stream ended before the session finished");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024) throw new Error("OpenCode event frame too large");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        if (line === "" && data.length) {
          const raw = data.join("\n"); data = [];
          if (await handle(JSON.parse(raw))) return;
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
let shutdownPromise;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    clearTimeout(readyTimer);
    if (origin && server.exitCode === null) {
      try { await request(sessionPath + "/abort", "POST", undefined, 2000); } catch {}
    }
    lifetime.abort();
    if (server.pid && server.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else server.kill("SIGTERM");
      const force = setTimeout(() => { try { server.kill("SIGKILL"); } catch {} }, 3000);
      await exited;
      clearTimeout(force);
    }
  })();
  return shutdownPromise;
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void shutdown().finally(() => process.exit(130)); });
process.once("exit", () => { if (server.pid && server.exitCode === null) { try { server.kill("SIGKILL"); } catch {} } });
try {
  await ready;
  const session = await json(sessionPath);
  if (session.id !== input.session) throw new Error("OpenCode resumed a different session");
  // The current purpose's configured primary agent must exist; never fall back to a writable agent.
  if (input.agent) {
    const agents = await json("/agent");
    if (!Array.isArray(agents) || !agents.some(agent => agent.name === input.agent && agent.mode !== "subagent"))
      throw new Error("OpenCode configured primary agent is unavailable");
  }
  const stream = await request("/event", "GET", undefined, 0);
  const streamed = events(stream);
  const prompted = request(sessionPath + "/message", "POST", {
    ...(input.model ? { model: input.model } : {}), ...(input.variant ? { variant: input.variant } : {}),
    ...(input.agent ? { agent: input.agent } : {}), parts: [{ type: "text", text: input.prompt }],
  }, 0).then(response => response.json()).then(result => {
    if (result.info?.error) {
      failed = true;
      emit("error", { error: result.info.error });
      // Reject Promise.all immediately; finally aborts SSE and the native session
      // even when the server never produces a busy -> idle transition.
      throw new Error("OpenCode native prompt failed");
    }
  });
  await Promise.all([streamed, prompted]);
  if (failed || denied) process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  if (!failed) emit("error", { error: { name: "OpenCodePermissionBridgeError", data: { message: String(error?.message ?? error) } } });
} finally { await shutdown(); }
`;
}
