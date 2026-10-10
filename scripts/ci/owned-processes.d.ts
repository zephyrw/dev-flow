export interface ProcessRecord {
  pid: number;
  parent: number;
  group: number;
  creation: string;
  zombie: boolean;
}

export interface CleanupResult {
  confirmed: boolean;
  error: string | null;
}

export declare function readPosixProcesses(): Promise<ProcessRecord[]>;
export declare function darwinProcessRecords(records: Array<{
  pid: number; parent: number; pgid: number; creation_time: string;
}>): ProcessRecord[];

export declare class OwnedProcessTracker {
  constructor(
    read?: () => Promise<ProcessRecord[]>,
    signal?: (pid: number) => void,
  );
  setRoot(pid: number, creation: string): void;
  remember(records: ProcessRecord[]): void;
  capture(): Promise<ProcessRecord[] | null>;
  cleanup(deadline: number): Promise<CleanupResult>;
}
