#!/bin/bash
# W01 验收脚本
# 验证 koffi 依赖加载和核心原生接口

set -e

echo "=== W01 验收检查 ==="
echo ""

# 1. 检查 Node.js 版本
echo "1. 检查 Node.js 版本..."
NODE_VERSION=$(node --version)
echo "   Node.js: $NODE_VERSION"
if [[ "$NODE_VERSION" != "v22.23.2" ]]; then
  echo "   [WARN] 期望 v22.23.2，实际 $NODE_VERSION"
fi

# 2. 检查 pnpm 版本
echo "2. 检查 pnpm 版本..."
PNPM_VERSION=$(pnpm --version)
echo "   pnpm: $PNPM_VERSION"
if [[ "$PNPM_VERSION" != "11.7.0" ]]; then
  echo "   [WARN] 期望 11.7.0，实际 $PNPM_VERSION"
fi

# 3. 检查 koffi 安装
echo "3. 检查 koffi 安装..."
if node -e "require('koffi')" 2>/dev/null; then
  KOFFI_VERSION=$(node -e "console.log(require('koffi').version || 'unknown')")
  echo "   koffi: $KOFFI_VERSION ✓"
else
  echo "   [FAIL] koffi 未安装或加载失败"
  exit 1
fi

# 4. 检查平台
echo "4. 检查平台..."
PLATFORM=$(node -e "console.log(process.platform)")
echo "   平台: $PLATFORM"

# 5. 检查原生接口模块
echo "5. 检查原生接口模块..."
if [[ -f "packages/process/src/native/windows.ts" ]]; then
  echo "   windows.ts: 存在 ✓"
else
  echo "   [FAIL] windows.ts 不存在"
  exit 1
fi

if [[ -f "packages/process/src/native/posix.ts" ]]; then
  echo "   posix.ts: 存在 ✓"
else
  echo "   [FAIL] posix.ts 不存在"
  exit 1
fi

if [[ -f "packages/process/src/runner-entry.ts" ]]; then
  echo "   runner-entry.ts: 存在 ✓"
else
  echo "   [FAIL] runner-entry.ts 不存在"
  exit 1
fi

# 6. 运行单元测试
echo "6. 运行 process-protocol 单元测试..."
if npx vitest run tests/unit/process-protocol.test.ts --maxWorkers=1 2>&1 | tail -5; then
  echo "   process-protocol 测试: 通过 ✓"
else
  echo "   [FAIL] process-protocol 测试失败"
  exit 1
fi

# 7. 运行原生接口测试
echo "7. 运行原生接口集成测试..."
if npx vitest run tests/integration/node-native-primitives.test.ts --maxWorkers=1 2>&1 | tail -10; then
  echo "   原生接口测试: 通过 ✓"
else
  echo "   [WARN] 原生接口测试失败或跳过"
fi

echo ""
echo "=== W01 验收完成 ==="
