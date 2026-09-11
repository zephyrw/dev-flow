import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
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
type Challenge = {
  id: string;
  challenge: string;
  action: string;
  binding: string;
  expires: number;
  used: boolean;
};
type Credential = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: WebAuthnCredential["transports"];
};
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
      .prepare("SELECT data FROM tokens WHERE hash=?")
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
      .prepare("SELECT hash,data FROM tokens")
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
  setupCode() {
    const existing = this.store.get<{ hash: string; expires: number }>(
      "settings",
      "pairing",
    );
    if (existing && existing.expires > Date.now())
      throw new FlowError(
        "PAIRING_ACTIVE",
        "已有配对码；请使用原始配对文件",
        409,
      );
    const code = secret();
    this.store.put("settings", "pairing", "system", {
      hash: hash(code),
      expires: Date.now() + 600000,
    });
    return code;
  }
  checkPairing(code: string) {
    const record = this.store.get<{ hash: string; expires: number }>(
      "settings",
      "pairing",
    );
    requireCondition(
      record && record.hash === hash(code) && record.expires > Date.now(),
      "PAIRING_INVALID",
      "配对码无效",
      403,
    );
    requireCondition(
      this.store.list("credential").length === 0,
      "ALREADY_PAIRED",
      "已配对；新增凭证需要现有用户授权",
      403,
    );
  }
  async registrationOptions(code: string) {
    this.checkPairing(code);
    const options = await generateRegistrationOptions({
      rpName: "DevFlow",
      rpID: new URL(this.origin).hostname,
      userName: "DevFlow 本机用户",
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    const key = id("reg");
    this.store.put("challenge", key, "human", {
      id: key,
      challenge: options.challenge,
      action: "register",
      binding: hash(code),
      expires: Date.now() + 60000,
      used: false,
    });
    return { id: key, options };
  }
  async register(
    key: string,
    code: string,
    response: RegistrationResponseJSON,
  ) {
    this.checkPairing(code);
    const challenge = this.challenge(key, "register", hash(code));
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origin,
      expectedRPID: new URL(this.origin).hostname,
      requireUserVerification: true,
    });
    requireCondition(
      result.verified && result.registrationInfo,
      "WEBAUTHN_FAILED",
      "用户验证失败",
      403,
    );
    const c = result.registrationInfo.credential;
    this.store.transaction(() => {
      this.consume(challenge);
      this.store.put("credential", c.id, "human", {
        ...c,
        publicKey: Buffer.from(c.publicKey).toString("base64"),
      });
      this.store.remove("settings", "pairing");
    });
    return this.issue({ role: "human" }, 12 * 3600000);
  }
  async authenticationOptions(action: string, binding: unknown) {
    const credentials = this.store.list<Credential>("credential");
    requireCondition(
      credentials.length,
      "NOT_PAIRED",
      "请先从本机 CLI 配对",
      409,
    );
    const options = await generateAuthenticationOptions({
      rpID: new URL(this.origin).hostname,
      userVerification: "required",
      allowCredentials: credentials.map((c) => ({
        id: c.id,
        ...(c.transports ? { transports: c.transports } : {}),
      })),
    });
    const key = id("challenge");
    this.store.put("challenge", key, "human", {
      id: key,
      challenge: options.challenge,
      action,
      binding: objectHash(binding),
      expires: Date.now() + 60000,
      used: false,
    });
    return { id: key, options };
  }
  async assertion(
    key: string,
    action: string,
    binding: unknown,
    response: AuthenticationResponseJSON,
  ) {
    const challenge = this.challenge(key, action, objectHash(binding));
    const credential = this.store.must<Credential>("credential", response.id);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origin,
      expectedRPID: new URL(this.origin).hostname,
      credential: {
        ...credential,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64")),
      },
      requireUserVerification: true,
    });
    requireCondition(result.verified, "WEBAUTHN_FAILED", "用户验证失败", 403);
    this.store.transaction(() => {
      this.consume(challenge);
      this.store.put("credential", credential.id, "human", {
        ...credential,
        counter: result.authenticationInfo.newCounter,
      });
      this.store.put("human_proof", key, "human", {
        action,
        binding: objectHash(binding),
        created_at: now(),
      });
    });
    return key;
  }
  private challenge(key: string, action: string, binding: string) {
    const c = this.store.must<Challenge>("challenge", key);
    requireCondition(
      !c.used &&
        c.expires > Date.now() &&
        c.action === action &&
        c.binding === binding,
      "CHALLENGE_INVALID",
      "挑战过期、已使用或内容不一致",
      403,
    );
    return c;
  }
  private consume(c: Challenge) {
    const latest = this.store.must<Challenge>("challenge", c.id);
    requireCondition(!latest.used, "CHALLENGE_REPLAY", "挑战已被消费", 403);
    this.store.put("challenge", c.id, "human", { ...c, used: true });
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
