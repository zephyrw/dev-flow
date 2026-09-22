/**
 * 进程协议类型定义
 *
 * 定义 ProcessIdentity 和 StopObservation 类型，用于统一进程管理。
 * 这些类型追加进已有 process_record JSON，不新增数据表或另一个持久化进程注册中心。
 */

/**
 * 进程身份信息
 * 记录实际启动的系统级身份，用于确认进程归属和清理。
 */
export interface ProcessIdentity {
  /** 固定为 'node-v1'，标识后端实现版本 */
  backend: 'node-v1';
  /** 原 spec.id，保留已有业务关联 */
  id: string;
  /** 每次实际启动新生成，防止迟到消息覆盖下一次运行 */
  attempt_id: string;
  /** 模型/命令实际根进程 PID，不填启动器 PID */
  pid?: number;
  /** 启动器进程 PID */
  launcher_pid?: number;
  /** 可验证的 OS 创建身份，不能拿 Date.now 冒充 */
  creation_time?: string;
  /** Windows Job 名称，每个实际启动唯一 */
  job_name?: string;
  /** POSIX 进程组 ID */
  pgid?: number;
}

/**
 * 停止观测状态
 * 用于报告进程停止的确认程度。
 */
export interface StopObservation {
  /** 进程状态 */
  state: 'running' | 'confirmed_exited' | 'unknown' | 'not_owned';
  /** 活跃进程数（仅 Windows Job 有意义） */
  active_processes?: number;
  /** 状态描述或失败原因 */
  reason?: string;
}

/**
 * 生成唯一的 Job 名称
 * 使用固定前缀和启动随机标识，不能单靠可复用 PID 或业务 ID。
 */
export function generateJobName(prefix: string = 'DevFlow'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}.${timestamp}.${random}`;
}

/**
 * 生成唯一的 attempt_id
 * 用于区分同 spec.id 的不同实际启动。
 */
export function generateAttemptId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 验证 attempt_id 格式
 */
export function isValidAttemptId(id: string): boolean {
  return /^att_\d+_[a-z0-9]{8}$/.test(id);
}

/**
 * 验证 Job 名称格式
 */
export function isValidJobName(name: string): boolean {
  return /^[A-Za-z0-9_-]+\.[a-z0-9]+\.[a-z0-9]{6}$/.test(name);
}

/**
 * 从 process_record 中提取 ProcessIdentity
 * 如果记录中没有 identity 字段，返回 null。
 */
export function extractIdentity(record: Record<string, unknown>): ProcessIdentity | null {
  const identity = record.identity as ProcessIdentity | undefined;
  if (!identity || identity.backend !== 'node-v1') return null;
  return identity;
}

/**
 * 合并 ProcessIdentity 到 process_record
 * 保留已有的业务字段，追加或更新 identity。
 */
export function mergeIdentity(
  record: Record<string, unknown>,
  identity: ProcessIdentity,
): Record<string, unknown> {
  return {
    ...record,
    identity,
    updated_at: new Date().toISOString(),
  };
}

/**
 * 检查迟到的退出/取消/输出事件
 * 如果事件的 attempt_id 与当前记录不匹配，应忽略。
 */
export function isCurrentAttempt(
  record: Record<string, unknown>,
  eventAttemptId: string,
): boolean {
  const identity = extractIdentity(record);
  if (!identity) return false;
  return identity.attempt_id === eventAttemptId;
}
