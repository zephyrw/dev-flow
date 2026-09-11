import { Store } from "../../store/src/store.js";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import { hash, id, now, objectHash, secret } from "./util.js";
export interface Principal {
  role: "planner" | "worker" | "human";
  workflow_id?: string;
  run_id?: string;
  expires: number;
  revoked?: boolean;
}
export class Auth {
  constructor(
    private store: Store,
    public origin: string,
  ) {}
  issue(p: Omit<Principal, "expires">, ttl = 3600000) {
    const token = secret();
    this.store.db
      .prepare("INSERT INTO tokens VALUES(?,?)")
      .run(hash(token), JSON.stringify({ ...p, expires: Date.now() + ttl }));
    return token;
  }
  verify(
    token: string | undefined,
    role?: Principal["role"],
    workflow?: string,
  ): Principal {
    if (!token) throw new FlowError("UNAUTHORIZED", "缺少凭证", 401);
    const row = this.store.db
      .prepare<
        unknown[],
        { data: string }
      >("SELECT data FROM tokens WHERE hash=?")
      .get(hash(token));
    const p = row ? (JSON.parse(row.data as string) as Principal) : undefined;
    requireCondition(
      p && !p.revoked && p.expires > Date.now(),
      "UNAUTHORIZED",
      "凭证过期或失效",
      401,
    );
    if (role)
      requireCondition(p.role === role, "FORBIDDEN", "角色无权执行", 403);
    if (workflow && p.role === "worker")
      requireCondition(
        p.workflow_id === workflow,
        "FORBIDDEN",
        "工作流不匹配",
        403,
      );
    return p;
  }
  revokeRun(runId: string) {
    for (const row of this.store.db
      .prepare<
        unknown[],
        { hash: string; data: string }
      >("SELECT hash,data FROM tokens")
      .all()) {
      const p = JSON.parse(row.data as string) as Principal;
      if (p.run_id === runId)
        this.store.db
          .prepare("UPDATE tokens SET data=? WHERE hash=?")
          .run(JSON.stringify({ ...p, revoked: true }), row.hash as string);
    }
  }
  revoke(token: string) {
    this.store.db.prepare("DELETE FROM tokens WHERE hash=?").run(hash(token));
  }
  // A local UI confirmation receipt, not identity verification or a login key.
  recordConfirmation(action: "approve" | "accept", binding: unknown) {
    const key = id("confirmation");
    this.store.put("human_proof", key, "human", {
      action,
      binding: objectHash(binding),
      created_at: now(),
      method: "local_confirmation",
    });
    return key;
  }
  consumeProof(key: string, action: string, binding: unknown) {
    const p = this.store.must<{
      action: string;
      binding: string;
      created_at: string;
    }>("human_proof", key);
    requireCondition(
      p.action === action &&
        p.binding === objectHash(binding) &&
        Date.now() - Date.parse(p.created_at) < 60000,
      "PROOF_INVALID",
      "审批凭据不匹配或过期",
      403,
    );
    this.store.remove("human_proof", key);
  }
}
