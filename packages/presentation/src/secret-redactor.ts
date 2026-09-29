/** Pure diagnostic projection. Never apply this to execution arguments or credentials. */
const MASK = "[REDACTED]";
const KEY = String.raw`[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?key)[\w.-]*`;
const sensitiveKey = new RegExp(`^(?:${KEY})$`, "i");
const tokenCount = /^(input|output|cached|reasoning|thinking|cache_read|cache_write|total|prompt|completion)_tokens$/;
const value = String.raw`(?:\[REDACTED\]|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;&}\]]+)`;
const assignment = new RegExp(`(^|[^\\w.-])((?:["']?${KEY}["']?)\\s*[:=]\\s*)${value}`, "gi");
const cli = new RegExp(`(^|[\\s"';])(--${KEY}|-p)(?:=|\\s+)${value}`, "gi");

export function highRiskDiagnostic(text: string): boolean {
  return /Get-ChildItem\s+Env:|(?:^|\s)(?:env|set)\s*(?:$|[;&|])|(?:^|[;\n])\s*export\s+(?:-p(?:\s|$)|[A-Za-z_]\w*=)|敏感认证操作|(?:^|[^\p{L}\p{N}])(?:login|signin|sign-in|enroll|enrollment|authorization_code|oauth|2fa|mfa|totp|otp|credential-store)(?:$|[^\p{L}\p{N}])/iu.test(text);
}

export function redactSecrets(text: string): string {
  return text
    // An unfinished private key is sensitive through the end of the input too.
    .replace(/-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, MASK)
    .replace(/\b(Bearer|Basic)\s+(?:\[REDACTED\]|[^\s,"';}\]]+)/gi, `$1 ${MASK}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, (_m, scheme, credentials: string) => {
      const colon = credentials.indexOf(":");
      return scheme + (colon >= 0 ? credentials.slice(0, colon) + ":" : "") + MASK + "@";
    })
    .replace(/(?:[A-Za-z]:)?[/\\](?:Users|home)[/\\][^/\\\s]+(?=[/\\])/gi, "[USER_HOME]")
    .replace(/([/\\](?:\.devflow|devflow)[/\\](?:accounts?|credentials?|auth-host|authhost))[/\\][^\s"']+/gi, "$1/[PRIVATE]")
    .replace(cli, (_m, before, key) => `${before}${key} ${MASK}`)
    .replace(assignment, (_m, before, prefix) => `${before}${prefix}${MASK}`)
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, sep, key: string) => {
      let decoded = key;
      try { decoded = decodeURIComponent(key); } catch { /* malformed key stays literal */ }
      return sensitiveKey.test(decoded) ? `${sep}${key}=${MASK}` : match;
    });
}

export function diagnosticText(text: string): string {
  return highRiskDiagnostic(text) ? "[敏感认证操作：仅保留状态]" : redactSecrets(text);
}

export function diagnosticClip(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : diagnosticText(text).slice(0, max);
}

/** Recursive copies also sanitize JSON encoded inside tool output strings. */
export function publicDiagnostic(input: unknown): any {
  if (typeof input === "string") {
    if (/[\u0000-\u0008\u000e-\u001f]/.test(input)) return "[已省略二进制内容]";
    if (/^[\s]*[\[{]/.test(input)) {
      try {
        const parsed: unknown = JSON.parse(input);
        if (parsed && typeof parsed === "object") return JSON.stringify(publicDiagnostic(parsed));
      } catch {
        if (/^\s*(?:\{\s*["}]|\[\s*["{\[])/.test(input)) return "[不完整诊断记录已省略]";
      }
    }
    return diagnosticText(input);
  }
  if (Array.isArray(input)) return input.map(publicDiagnostic);
  if (!input || typeof input !== "object") return input;
  const entries = Object.entries(input);
  const record = input as Record<string, unknown>;
  if ((record.type === "text" && (typeof record.data === "string" || record.part)) ||
      /(?:_delta|_chunk)$/.test(String(record.type ?? record.sessionUpdate ?? ""))) {
    return { type: "text", diagnostic: "模型输出分片未记录" };
  }
  const risky = entries.some(([key, item]) =>
    /^(?:command|cmd|CommandLine|tool|tool_name|name|title|event|type)$/.test(key) &&
    typeof item === "string" && highRiskDiagnostic(item));
  if (risky) {
    // No arbitrary output, paths, arguments or prompts from authentication flows.
    return Object.fromEntries(entries.filter(([key, item]) =>
      (key === "status" && typeof item === "string" && /^(?:active|running|done|completed|failed|error|waiting|stopped|pending|starting|discovered|pausing|paused|interrupted|cancelled|unknown)$/.test(item)) ||
      (/^(?:timestamp|created_at|occurred_at)$/.test(key) && typeof item === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(item)) ||
      (/^(?:id|workflow_id|run_id|conversation_id|attempt_id|root_id|activity_id|source_event_id|replaces_conversation_id|command_id|CommandId|tool_call_id|tool_use_id|call_id)$/.test(key) && typeof item === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(item)) ||
      (key === "kind" && typeof item === "string" && /^(?:tool|message|event|separator)$/.test(item)) ||
      (/^(?:event|type)$/.test(key) && typeof item === "string" && /^(?:login|oauth|2fa|mfa)(?:[._](?:started|completed|failed))?$/.test(item)) ||
      (/^(?:exit_code|source_seq|event_seq|duration_ms|step_index)$/.test(key) && typeof item === "number" && Number.isFinite(item))
    ).concat(entries.filter(([key]) => /^(?:title|text|public_text)$/.test(key))
      .map(([key]): [string, unknown] => [key, "敏感认证操作：仅保留状态"])));
  }
  return Object.fromEntries(entries
    .filter(([key, item]) => !/^(?:text_delta|delta)$/.test(key) && (!/thought|reasoning/i.test(key) || (key === "reasoning_tokens" && typeof item === "number")))
    .map(([key, item]) => [key,
      sensitiveKey.test(key) && !(typeof item === "number" && tokenCount.test(key))
        ? MASK : publicDiagnostic(item)]));
}

/** One instance per Run, shared by stdout/stderr. No execution payload is mutated.
 * Unknown/early results are quarantined, and sensitive IDs are never evicted or
 * downgraded by repeated DONE/call records. Exhaustion fails closed for the Run.
 */
export class DiagnosticRedactionContext {
  private calls = new Map<string, boolean>();
  private authenticationSeen = false;
  private saturated = false;
  constructor(private readonly maxCalls = 1024) {}

  suppress(): void { this.saturated = true; }

  private remember(id: string, sensitive: boolean): void {
    if (!this.calls.has(id) && this.calls.size >= this.maxCalls) {
      this.saturated = true;
      return;
    }
    this.calls.set(id, sensitive || this.calls.get(id) === true);
  }

  project(input: unknown): any {
    if (typeof input === "string") {
      try { return JSON.stringify(this.project(JSON.parse(input))); }
      catch { /* Plain text has no trustworthy call association. */ }
      if (highRiskDiagnostic(input)) this.authenticationSeen = true;
      return this.saturated || this.authenticationSeen
        ? "[敏感认证操作：仅保留状态]" : publicDiagnostic(input);
    }
    const nodes: Array<{ value: Record<string, any>; scope: string }> = [];
    let seen = 0;
    const visit = (value: unknown, scope: string, depth: number): void => {
      if (!value || typeof value !== "object") return;
      if (++seen > 4096 || depth > 32) { this.saturated = true; return; }
      if (Array.isArray(value)) { for (const child of value) visit(child, scope, depth + 1); return; }
      const record = value as Record<string, any>;
      const localScope = String(record.conversation_id ?? record.session_id ?? scope);
      if (localScope.length > 256) { this.saturated = true; return; }
      nodes.push({ value: record, scope: localScope });
      for (const child of Object.values(record)) visit(child, localScope, depth + 1);
    };
    visit(input, "root", 0);
    let sensitiveRecord = false;
    let associatedSafe = false;
    const idFor = (record: Record<string, any>, scope: string): string | undefined => {
      const type = String(record.type ?? record.event ?? "");
      const id = record.tool_use_id ?? record.tool_call_id ?? record.call_id ?? record.CommandId ??
        (/^(?:tool_use|tool_call|function_call|command_execution)$/.test(type) ? record.id : undefined);
      if (typeof id === "string" && id.length > 0 && id.length <= 256)
        return JSON.stringify(["call", scope, id]);
      if (Number.isSafeInteger(record.step_index) && record.step_index >= 0)
        return JSON.stringify(["step", scope, record.step_index]);
      return undefined;
    };
    // Register all declarations before handling results nested in the same frame.
    for (const { value: record, scope } of nodes) {
      const type = String(record.type ?? record.event ?? "");
      const declared = /^(?:tool_use|tool_call|function_call|command_execution)$/.test(type) ||
        (record.step_index !== undefined && record.tool_info?.parameters !== undefined);
      if (!declared) continue;
      const id = idFor(record, scope);
      const argumentsValue = record.input ?? record.arguments ?? record.command ?? record.tool_info?.parameters;
      // Streaming tool declarations often start with an empty input object.
      // They must not authorize a later result before arguments are complete.
      let complete = typeof argumentsValue === "string" ? argumentsValue.trim().length > 0 :
        !!argumentsValue && typeof argumentsValue === "object" && Object.keys(argumentsValue).length > 0;
      if (type === "function_call" && typeof argumentsValue === "string") {
        try { JSON.parse(argumentsValue); } catch { complete = false; }
      }
      const risky = highRiskDiagnostic(JSON.stringify(record));
      if (risky || !complete) this.authenticationSeen = true;
      if (id) this.remember(id, risky || !complete);
      else sensitiveRecord = true;
    }
    for (const { value: record, scope } of nodes) {
      const type = String(record.type ?? record.event ?? "");
      const id = idFor(record, scope);
      const result = /^(?:tool_result|function_call_output|tool_output|command_execution)$/.test(type) ||
        record.role === "tool" || record.tool_use_id !== undefined ||
        (record.step_index !== undefined && record.tool_info?.output !== undefined) ||
        (id !== undefined && (record.output !== undefined || record.result !== undefined || record.content !== undefined));
      if (result && (!id || !this.calls.has(id))) {
        this.authenticationSeen = true;
        sensitiveRecord = true;
        if (id) this.remember(id, true);
      }
      if (id && this.calls.has(id)) {
        if (this.calls.get(id)) sensitiveRecord = true;
        else associatedSafe = true;
      }
      // Commands can also occur in provider envelopes without a typed call node.
      if (Object.entries(record).some(([key, value]) =>
        /^(?:command|cmd|CommandLine|name|tool_name|tool|title|type|event)$/.test(key) &&
        typeof value === "string" && highRiskDiagnostic(value))) {
        this.authenticationSeen = true;
        sensitiveRecord = true;
        if (id) this.remember(id, true);
      }
    }
    // A safe tool nested in an envelope must not authorize sibling unassociated text.
    const unassociatedText = (value: unknown, scope: string, safe: boolean, depth = 0): boolean => {
      if (depth > 32) return true;
      if (Array.isArray(value)) return value.some(child => unassociatedText(child, scope, safe, depth + 1));
      if (!value || typeof value !== "object") return typeof value === "string" && !safe;
      const record = value as Record<string, any>;
      const localScope = String(record.conversation_id ?? record.session_id ?? scope);
      const id = idFor(record, localScope);
      const localSafe = safe || (id !== undefined && this.calls.get(id) === false);
      return Object.entries(record).some(([key, child]) => {
        if (child && typeof child === "object") return unassociatedText(child, localScope, localSafe, depth + 1);
        return /^(?:text|content|output|result|response|data|part|message|aggregated_output)$/.test(key) &&
          typeof child === "string" && !localSafe;
      });
    };
    if (this.saturated || sensitiveRecord || (this.authenticationSeen &&
        (!associatedSafe || unassociatedText(input, "root", false)))) {
      // Preserve only fixed status values and safe routing identity, never output.
      const status = nodes.map(({ value }) => value.status ?? value.state)
        .find(value => typeof value === "string" && /^(?:RUNNING|DONE|ERROR|active|running|done|completed|failed|error|waiting|stopped|pending|starting|cancelled|unknown)$/.test(value));
      const identity = input && typeof input === "object" && !Array.isArray(input)
        ? publicDiagnostic({ ...input, command: "login" }) : {};
      return { ...identity, ...(status ? { status } : {}), diagnostic: "敏感认证操作：仅保留状态" };
    }
    return publicDiagnostic(input);
  }
}

/** Buffer diagnostic lines across transport chunks; the original stream is untouched.
 * Oversize/incomplete records fail closed for the rest of this stream, never emit a tail.
 */
export class DiagnosticStreamRedactor {
  private pending = "";
  private suppressed = false;
  constructor(
    private readonly limit = 64 * 1024,
    private readonly context = new DiagnosticRedactionContext(),
  ) {}

  push(chunk: string, final = false): string {
    if (this.suppressed) return "";
    this.pending += chunk;
    if (this.pending.length > this.limit) {
      this.pending = "";
      this.suppressed = true;
      this.context.suppress();
      return "[诊断记录超过安全缓冲上限，后续内容已省略]\n";
    }
    let output = "";
    while (this.pending.includes("\n")) {
      let end = this.pending.indexOf("\n") + 1;
      const first = this.pending.slice(0, end);
      if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(first)) {
        const match = /-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(this.pending);
        if (!match) break;
        end = match.index + match[0].length;
      } else if (/^\s*(?:\{\s*["}]|\[\s*["{\[\d-])/.test(first)) {
        try { JSON.parse(first); } catch { break; }
      } else if (/(?:[:=]\s*|--[\w-]+\s+)["'][^"'\r\n]*\r?\n$/.test(first)) {
        break;
      }
      const record = this.pending.slice(0, end);
      const safe = String(this.context.project(record));
      output += safe + (record.endsWith("\n") && !safe.endsWith("\n") ? "\n" : "");
      this.pending = this.pending.slice(end);
    }
    if (final && this.pending) {
      // Invalid JSON or a multiline unfinished value cannot be projected safely.
      const rest = this.pending;
      this.pending = "";
      if (/^\s*(?:\{\s*["}]|\[\s*["{\[\d-])/.test(rest)) {
        try { output += JSON.stringify(this.context.project(JSON.parse(rest))); }
        catch { this.context.suppress(); output += "[不完整诊断记录已省略]"; }
      } else output += String(this.context.project(rest));
    }
    return output;
  }
}
