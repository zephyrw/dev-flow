#!/usr/bin/env node
/**
 * 合成凭据 - 生成假凭据用于测试
 *
 * 使用方法:
 *   node tests/fixtures/synthetic-credential.js [选项]
 *
 * 选项:
 *   --action <action>  动作: generate, validate
 *   --output <path>    输出文件路径
 *   --verbose          输出详细信息
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes, createHash } from "node:crypto";

const { values } = parseArgs({
  options: {
    action: { type: "string", default: "generate" },
    output: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
  strict: false,
});

if (values.verbose) {
  console.error(`[synthetic-credential] Action: ${values.action}`);
}

/**
 * 生成合成凭据数据
 * 注意: 这些是完全假的数据，不包含真实凭据
 */
function generateSyntheticCredential() {
  const id = randomBytes(16).toString("hex");
  const secretRef = `synthetic-${id}`;
  const timestamp = new Date().toISOString();

  return {
    // 模拟 Go 输出的字段大小写
    Version: 2,
    RealmID: "test-realm",
    AccountID: `test-account-${id.slice(0, 8)}`,
    Revision: 1,
    Credential: {
      Exists: true,
      Flags: 0,
      Username: `test-user-${id.slice(0, 8)}@example.com`,
      Comment: "Synthetic test credential",
      Persist: true,
      TargetAlias: "",
      Attributes: {},
      // 模拟 Go JSON 对 []byte 的 base64 表示
      Secret: Buffer.from(`synthetic-secret-${id}`).toString("base64"),
    },
    _metadata: {
      created_at: timestamp,
      synthetic: true,
      test_only: true,
    },
  };
}

/**
 * 生成合成的 envelope 格式
 */
function generateSyntheticEnvelope() {
  const id = randomBytes(8).toString("hex");
  const timestamp = new Date().toISOString();

  return {
    // envelope version 2
    envelope_version: 2,
    realm_id: "test-realm",
    account_id: `test-account-${id}`,
    revision: 1,
    created_at: timestamp,
    // 模拟 DPAPI 加密后的数据 (实际是假的)
    encrypted_data: randomBytes(64).toString("base64"),
    // 安全元数据
    metadata: {
      sid: "S-1-5-21-0000000000-0000000000-0000000000-1001",
      acl_verified: true,
      dpapi_scope: "current_user",
    },
    _synthetic: true,
  };
}

/**
 * 验证合成凭据格式
 */
function validateCredential(data) {
  const errors = [];

  // 检查必需字段
  if (typeof data.Version !== "number") {
    errors.push("Missing or invalid Version");
  }
  if (typeof data.RealmID !== "string") {
    errors.push("Missing or invalid RealmID");
  }
  if (typeof data.AccountID !== "string") {
    errors.push("Missing or invalid AccountID");
  }
  if (typeof data.Revision !== "number") {
    errors.push("Missing or invalid Revision");
  }

  // 检查 Credential 对象
  if (!data.Credential || typeof data.Credential !== "object") {
    errors.push("Missing or invalid Credential object");
  } else {
    if (typeof data.Credential.Exists !== "boolean") {
      errors.push("Missing or invalid Credential.Exists");
    }
    if (typeof data.Credential.Username !== "string") {
      errors.push("Missing or invalid Credential.Username");
    }
    if (typeof data.Credential.Secret !== "string") {
      errors.push("Missing or invalid Credential.Secret (should be base64)");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// 执行动作
switch (values.action) {
  case "generate": {
    const credential = generateSyntheticCredential();
    const envelope = generateSyntheticEnvelope();

    const output = {
      credential,
      envelope,
      generated_at: new Date().toISOString(),
      synthetic: true,
    };

    if (values.output) {
      mkdirSync(dirname(values.output), { recursive: true });
      writeFileSync(values.output, JSON.stringify(output, null, 2));
      console.log(`Generated synthetic credential to ${values.output}`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
    break;
  }

  case "validate": {
    if (!values.output) {
      console.error("Error: --output required for validate action");
      process.exit(1);
    }

    try {
      const { readFileSync } = await import("node:fs");
      const data = JSON.parse(readFileSync(values.output, "utf8"));
      const result = validateCredential(data.credential || data);

      if (result.valid) {
        console.log("Credential validation passed");
        if (values.verbose) {
          console.log(JSON.stringify(data, null, 2));
        }
      } else {
        console.error("Credential validation failed:");
        for (const err of result.errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(`Failed to read or parse credential file: ${err}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`Unknown action: ${values.action}`);
    process.exit(1);
}
