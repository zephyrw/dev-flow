import type { Store } from "../../store/src/store.js";
import { objectHash, now } from "./util.js";
import { FlowError } from "../../contracts/src/index.js";

export interface IdempotencyRecord {
  request_id: string;
  payload_hash: string;
  response: any;
  created_at: string;
}

export class IdempotencyService {
  constructor(private store: Store) {}

  /**
   * 检查或记录幂等操作。
   * 同键同 payload：返回缓存的历史结果，标记 isExisting = true
   * 同键不同 payload：抛出 409 IDEMPOTENCY_CONFLICT
   * 新键：执行操作并记录持久化结果
   */
  async executeIdempotent<T>(
    requestId: string,
    payload: unknown,
    execute: () => Promise<T> | T,
  ): Promise<{ result: T; isExisting: boolean }> {
    const payloadHash = objectHash(payload);
    const existing = this.store.get<IdempotencyRecord>(
      "idempotency_record",
      requestId,
    );

    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new FlowError(
          "IDEMPOTENCY_CONFLICT",
          `请求 ${requestId} 已存在，但携带了不同的载荷参数`,
          409,
        );
      }
      return { result: existing.response as T, isExisting: true };
    }

    const result = await execute();

    try {
      this.store.put("idempotency_record", requestId, "global", {
        request_id: requestId,
        payload_hash: payloadHash,
        response: result,
        created_at: now(),
      });
    } catch {}

    return { result, isExisting: false };
  }
}
