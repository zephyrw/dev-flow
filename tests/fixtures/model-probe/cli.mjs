import fs from "node:fs";
import path from "node:path";

const logDir = process.env.MODEL_PROBE_LOG_DIR;
if (!logDir) {
  console.error("MODEL_PROBE_LOG_DIR missing");
  process.exit(2);
}

const controlPath = path.join(logDir, "control.json");
const control = fs.existsSync(controlPath)
  ? JSON.parse(fs.readFileSync(controlPath, "utf8"))
  : {};

const argv = process.argv.slice(2);
const kind = classify(argv);
let stdin = "";
if (kind === "probe") {
  stdin = fs.readFileSync(0, "utf8");
}
const record = {
  kind,
  argv,
  cwd: process.cwd(),
  pid: process.pid,
  stdin,
  env: pickEnv(process.env),
  startedAt: new Date().toISOString(),
};
fs.mkdirSync(logDir, { recursive: true });
fs.appendFileSync(
  path.join(logDir, "invocations.jsonl"),
  JSON.stringify(record) + "\n",
);
fs.writeFileSync(path.join(logDir, "last-pid"), String(process.pid));

const delayMs = Number(control.delayMs ?? 0);
if (kind === "probe" && delayMs > 0) await sleep(delayMs);
if (kind === "catalog" && Number(control.catalogDelayMs ?? 0) > 0) {
  await sleep(Number(control.catalogDelayMs));
}

const adapterId = control.adapterId ?? "codex";
if (kind === "version") {
  console.log(control.versionStdout ?? versionText(adapterId));
  process.exit(0);
}
if (kind === "help") {
  console.log(control.helpStdout ?? helpText(adapterId));
  process.exit(0);
}
if (kind === "catalog") {
  if (control.catalogBehavior === "env-error") {
    console.error("Access is denied: cannot read user directory, DPAPI");
    process.exit(1);
  }
  if (control.catalogBehavior === "fail") {
    console.error("catalog timeout");
    process.exit(1);
  }
  process.stdout.write(control.catalogStdout ?? "");
  process.exit(control.catalogExit ?? 0);
}

await applyBehavior(control.behavior ?? "ok");

function classify(args) {
  if (args.includes("--version")) return "version";
  if (args.includes("--help")) return "help";
  if (
    args.includes("models") ||
    args.includes("--list-models") ||
    args.includes("app-server")
  ) {
    return "catalog";
  }
  if (args.includes("login") || args[0] === "status") return "identity";
  return "probe";
}

function pickEnv(env) {
  const selected = {};
  for (const [key, value] of Object.entries(env)) {
    if (/DEVFLOW|MCP|TOKEN|SECRET|MODEL_PROBE|FORCE|ALWAYS|QODER|OPENCODE/i.test(key)) {
      selected[key] = value;
    }
  }
  return selected;
}

function versionText(adapterId) {
  if (adapterId === "agy") return "agy fixture 1.0 antigravity";
  if (adapterId === "cursor-agent") return "cursor agent fixture 1.0";
  if (adapterId === "grok-build") return "grok fixture 1.0";
  if (adapterId === "opencode") return "opencode fixture 1.0";
  if (adapterId === "qoder") return "qoder fixture 1.0";
  return "codex fixture 1.0";
}

function helpText(adapterId) {
  if (adapterId === "agy") return "agy models --mode plan --sandbox";
  if (adapterId === "cursor-agent") {
    return "agent models --mode ask --sandbox enabled";
  }
  return "codex exec app-server --model";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyBehavior(behavior) {
  if (typeof control.probeStdout === "string") {
    process.stdout.write(control.probeStdout);
    process.stderr.write(control.probeStderr ?? "");
    process.exit(control.probeExit ?? 0);
  }
  if (behavior === "hang" || behavior === "timeout") {
    await sleep(120000);
    process.exit(1);
  }
  if (behavior === "slow-2s") {
    await sleep(2000);
    console.log("OK");
    process.exit(0);
  }
  if (behavior === "ok") {
    console.log("OK");
    process.exit(0);
  }
  if (behavior === "mid-ok-then-error") {
    console.log(JSON.stringify({ type: "message", text: "OK" }));
    console.log(
      JSON.stringify({ type: "result", is_error: true, error: "boom" }),
    );
    process.exit(0);
  }
  if (behavior === "nested-ok") {
    console.log(JSON.stringify({ nested: { status: "OK" } }));
    process.exit(0);
  }
  if (behavior === "model-mismatch") {
    console.log(
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "OK",
        model: "other-model",
      }),
    );
    process.exit(0);
  }
  if (behavior === "terminal-success") {
    console.log(
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "OK",
        model: "gpt-6-astra",
      }),
    );
    process.exit(0);
  }
  if (behavior === "401") {
    console.error("401 Unauthorized token=sk-secret-live");
    console.error("Authorization: Bearer abc123token");
    process.exit(1);
  }
  if (behavior === "403") {
    console.error("403 Forbidden not allowed to use model");
    process.exit(1);
  }
  if (behavior === "429") {
    console.error("429 Too Many Requests");
    process.exit(1);
  }
  if (behavior === "500") {
    console.error("502 Bad Gateway");
    process.exit(1);
  }
  if (behavior === "exit-nonzero-ok") {
    console.log("OK");
    process.exit(2);
  }
  if (behavior === "fallback") {
    console.log("OK");
    console.log("falling back to other-model");
    process.exit(0);
  }
  if (behavior === "env-error") {
    console.error("Access is denied: cannot read user directory, DPAPI");
    process.exit(1);
  }
  if (behavior === "login") {
    console.error("not logged in");
    process.exit(1);
  }
  console.log("OK");
  process.exit(0);
}
