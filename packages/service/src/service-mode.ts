export function assertServiceMode(
  status: { mode?: string; features?: { agy_accounts?: boolean } },
  mode: "full" | "accounts",
) {
  if (mode === "accounts" && status.features?.agy_accounts !== true)
    throw new Error("此 DevFlow 服务尚不支持账号管理，请正常退出并更新安装。");
  if (mode === "full" && status.mode === "accounts")
    throw new Error(
      "SERVICE_MODE_CONFLICT：账号独立服务正在运行，请正常退出后再启动完整 DevFlow；不会自动终止服务。",
    );
}
