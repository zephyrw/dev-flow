/** Public runtime facts. Requested configuration is never evidence of the actual model. */
export interface RunActivity {
  id: string;
  kind: "tool" | "message" | "event";
  title: string;
  text: string;
  status: "active" | "done" | "error" | "interrupted";
  command?: string;
  cwd?: string;
  resultText?: string;
}

export interface QuotaBucket {
  id: string;
  label?: string;
  windows: {
    used_percent: number;
    window_minutes: number;
    resets_at?: number;
  }[];
}

export interface RunObservation {
  run_id: string;
  adapter: string;
  purpose?: string;
  requested_model?: string;
  actual_model?: string;
  effort?: string;
  model_source?: "native_event" | "native_session";
  conversation_id?: string;
  status:
    | "starting"
    | "responding"
    | "working"
    | "waiting"
    | "exited"
    | "error";
  started_at: string;
  updated_at: string;
  activity_at?: string;
  current_activity?: RunActivity;
  active_tools: number;
  quota?: {
    source: "native_session" | "native_event";
    observed_at: string;
    buckets: QuotaBucket[];
  };
}
