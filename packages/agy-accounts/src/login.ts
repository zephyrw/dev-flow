import { resolveFingerprintedAgyExecutable } from "../../adapters/agy/src/executable-resolver.js";

export interface InteractiveLoginJobPort {
  /** The implementation must create the official CLI suspended, assign its Job, then show/resume it.
   * Resolves after the Job is confirmed idle or (when keepSessionOnSuccess is set) after verified credential capture. */
  start(input: {
    executable: string;
    args: readonly string[];
    signal: AbortSignal;
    keepSessionOnSuccess?: boolean;
    saveBeforeDetach?: () => Promise<void>;
    checkCredentialReady?: () => Promise<{
      status: "waiting" | "ready" | "mismatch";
      error?: string;
    }>;
  }): Promise<{
    exit_code: number | null;
    fully_stopped: boolean;
    session_kept?: boolean;
    error?: string;
  }>;
}
export interface VerifiedLoginCommand {
  executable: string;
  args: readonly string[];
  executable_fingerprint: string;
}
export interface InteractiveLoginOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  keepSessionOnSuccess?: boolean;
  saveBeforeDetach?: () => Promise<void>;
  checkCredentialReady?: () => Promise<{
    status: "waiting" | "ready" | "mismatch";
    error?: string;
  }>;
}
export interface InteractiveLoginResult {
  completed: boolean;
  cancelled: boolean;
  timed_out: boolean;
  fully_stopped: boolean;
  session_kept?: boolean;
  exit_code?: number | null;
  error?: string;
}
/** Credential writes/rollback belong to the durable account operation, never this launcher. */
export class AgyLoginLauncher {
  private active?: AbortController;
  constructor(
    private readonly job?: InteractiveLoginJobPort,
    private readonly command?: VerifiedLoginCommand,
  ) {}
  get available(): boolean {
    return !!this.job && !!this.command;
  }
  async startInteractiveLogin(
    options: InteractiveLoginOptions = {},
  ): Promise<InteractiveLoginResult> {
    if (!this.job || !this.command)
      return {
        completed: false,
        cancelled: false,
        timed_out: false,
        fully_stopped: true,
        error: "interactive_login_capability_unverified",
      };
    if (this.active) throw new Error("login_already_running");
    const resolved = await resolveFingerprintedAgyExecutable(this.command.executable);
    if (
      !resolved.fingerprint ||
      resolved.fingerprint !== this.command.executable_fingerprint
    )
      return {
        completed: false,
        cancelled: false,
        timed_out: false,
        fully_stopped: true,
        error: "login_cli_changed",
      };
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 900000);
    try {
      const result = await this.job.start({
        ...this.command,
        signal: controller.signal,
        ...(options.keepSessionOnSuccess ? { keepSessionOnSuccess: true } : {}),
        saveBeforeDetach: options.saveBeforeDetach,
        ...(options.checkCredentialReady
          ? { checkCredentialReady: options.checkCredentialReady }
          : {}),
      });
      if (result.error) {
        return {
          completed: false,
          cancelled: controller.signal.aborted && !timedOut,
          timed_out: timedOut,
          fully_stopped: result.fully_stopped,
          session_kept: result.session_kept,
          error: result.error,
        };
      }
      if (!result.fully_stopped && !result.session_kept)
        return {
          completed: false,
          cancelled: controller.signal.aborted && !timedOut,
          timed_out: timedOut,
          fully_stopped: false,
          error: "login_stop_unconfirmed",
        };
      return {
        completed: result.exit_code === 0 && !controller.signal.aborted,
        cancelled: controller.signal.aborted && !timedOut,
        timed_out: timedOut,
        fully_stopped: result.fully_stopped,
        session_kept: result.session_kept,
        exit_code: result.exit_code,
      };
    } catch {
      // The owner cannot infer that a rejected job request has no surviving children.
      return {
        completed: false,
        cancelled: controller.signal.aborted && !timedOut,
        timed_out: timedOut,
        fully_stopped: false,
        error: "login_state_unknown",
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.active = undefined;
    }
  }
  cancelLogin(): void {
    this.active?.abort();
  }
}
