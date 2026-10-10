import { describe, expect, it } from "vitest";
import { OwnedProcessTracker, darwinProcessRecords } from "../../scripts/ci/owned-processes.mjs";

type ProcessRecord = {
  pid: number;
  parent: number;
  group: number;
  creation: string;
  zombie: boolean;
};

const record = (pid: number, parent: number, group: number, creation = `birth-${pid}`): ProcessRecord =>
  ({ pid, parent, group, creation, zombie: false });

describe("CI owned descendant cleanup (R04 / A11)", () => {
  it("anchors macOS descendants with the SDK's microsecond kernel birth identity", async () => {
    let processes = darwinProcessRecords([
      { pid: 100, parent: 1, pgid: 100, creation_time: "1791000000:123456" },
      { pid: 101, parent: 100, pgid: 101, creation_time: "1791000000:234567" },
      { pid: 200, parent: 1, pgid: 200, creation_time: "1791000000:345678" },
    ]);
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => processes, pid => {
      signalled.push(pid); processes = processes.filter(process => process.pid !== pid);
    });
    tracker.setRoot(100, "1791000000:123456");
    await tracker.capture();
    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({ confirmed: true, error: null });
    expect(signalled).toEqual([101]);
    expect(processes.map(process => process.pid)).toEqual([100, 200]);
    expect(() => darwinProcessRecords([{ pid: 100, parent: 1, pgid: 100, creation_time: "Thu Oct 9" }]))
      .toThrow("PROCESS_IDENTITY_INVALID");
  });
  it("retains detached descendants after their parent exits and leaves unrelated processes alone", async () => {
    let processes = [record(100, 1, 100), record(101, 100, 100),
      record(102, 101, 102), record(103, 102, 102), record(200, 1, 200)];
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => processes, (pid: number) => {
      signalled.push(pid);
      processes = processes.filter(item => item.pid !== pid);
    });
    tracker.setRoot(100, "birth-100");
    await tracker.capture();
    processes = [record(102, 1, 102), record(103, 102, 102), record(200, 1, 200)];

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({ confirmed: true, error: null });
    expect(signalled).toEqual([103, 102]);
    expect(processes.map(item => item.pid)).toEqual([200]);
  });

  it("rechecks birth identity immediately before signalling a remembered PID", async () => {
    let snapshots = 0;
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => {
      snapshots++;
      return [record(100, 1, 100), record(102, 100, 102,
        snapshots <= 2 ? "birth-102" : "replacement-102")];
    }, (pid: number) => signalled.push(pid));
    tracker.setRoot(100, "birth-100");
    await tracker.capture();

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({ confirmed: true, error: null });
    expect(snapshots).toBeGreaterThanOrEqual(3);
    expect(signalled).toEqual([]);
  });

  it("cleans previously tracked descendants that change groups without changing birth identity", async () => {
    let processes = [record(100, 1, 100), record(102, 100, 100),
      record(103, 102, 100), record(200, 1, 200)];
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => processes, (pid: number) => {
      signalled.push(pid);
      processes = processes.filter(item => item.pid !== pid);
    });
    tracker.setRoot(100, "birth-100");
    await tracker.capture();
    processes = [record(102, 1, 102), record(103, 102, 102), record(200, 1, 200)];

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({ confirmed: true, error: null });
    expect(signalled).toEqual([103, 102]);
    expect(processes.map(item => item.pid)).toEqual([200]);
  });

  it("does not refresh topology from a replacement process with a reused PID", async () => {
    let processes = [record(100, 1, 100), record(102, 100, 100)];
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => processes,
      (pid: number) => signalled.push(pid));
    tracker.setRoot(100, "birth-100");
    await tracker.capture();
    processes = [record(102, 1, 102, "replacement-102")];

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({ confirmed: true, error: null });
    expect(signalled).toEqual([]);
  });

  it("leaves a descendant that rejoins the launcher group for SDK cleanup", async () => {
    let snapshots = 0;
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => {
      snapshots++;
      return [record(100, 1, 100), record(102, 100, snapshots === 2 ? 102 : 100)];
    }, (pid: number) => signalled.push(pid));
    tracker.setRoot(100, "birth-100");
    await tracker.capture();

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({ confirmed: true, error: null });
    expect(snapshots).toBeGreaterThanOrEqual(3);
    expect(signalled).toEqual([]);
  });

  it("does not attribute a reused launcher PID's children to the previous target", async () => {
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => [
      record(100, 1, 100, "replacement-root"), record(201, 100, 201),
    ], (pid: number) => signalled.push(pid));
    tracker.setRoot(100, "birth-100");

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({ confirmed: true, error: null });
    expect(signalled).toEqual([]);
  });

  it("reports snapshot failure without signalling processes", async () => {
    const signalled: number[] = [];
    const tracker = new OwnedProcessTracker(async () => { throw new Error("unavailable"); },
      (pid: number) => signalled.push(pid));
    tracker.setRoot(100, "birth-100");

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({
      confirmed: false, error: "PROCESS_SNAPSHOT_FAILED",
    });
    expect(signalled).toEqual([]);
  });

  it("reports an owned descendant that cannot be terminated", async () => {
    const tracker = new OwnedProcessTracker(async () => [
      record(100, 1, 100), record(102, 100, 102),
    ], () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    tracker.setRoot(100, "birth-100");

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({
      confirmed: false, error: "PROCESS_CLEANUP_FAILED",
    });
  });

  it("reports only fixed kernel failure reasons and numeric identity facts", async () => {
    const secret = "credential-and-private-cli-arguments";
    const tracker = new OwnedProcessTracker(async () => {
      throw Object.assign(new Error(secret), { code: "DARWIN_PROCESS_QUERY_FAILED",
        reason: "bsd_read_unconfirmed", facts: { pid: 70, flavor: 3, arg: 1, errno: 1,
          short_errno: 3, status: 2, path: secret, command: secret, bytes: secret } });
    }, () => { throw new Error("must not signal an unknown process"); });
    tracker.setRoot(100, "birth-100");
    const result = await tracker.cleanup(Date.now() + 1000);
    expect(result).toEqual({ confirmed: false,
      error: "PROCESS_SNAPSHOT_FAILED (bsd_read_unconfirmed,pid=70,flavor=3,arg=1,errno=1,short_errno=3,status=2)" });
    expect(JSON.stringify(result)).not.toContain(secret);
    const untrusted = new OwnedProcessTracker(async () => { throw Object.assign(new Error(secret), {
      code: "DARWIN_PROCESS_QUERY_FAILED", reason: secret, facts: { pid: 70 } }); });
    untrusted.setRoot(100, "birth-100");
    expect(await untrusted.cleanup(Date.now() + 1000)).toEqual({ confirmed: false, error: "PROCESS_SNAPSHOT_FAILED" });
  });

  it("does not claim confirmed cleanup after an earlier ownership snapshot failed", async () => {
    let snapshots = 0;
    const tracker = new OwnedProcessTracker(async () => {
      if (++snapshots === 1) throw new Error("temporary read failure");
      return [];
    }, () => {});
    tracker.setRoot(100, "birth-100");
    await tracker.capture();

    expect(await tracker.cleanup(Date.now() + 1000)).toEqual({
      confirmed: false, error: "PROCESS_SNAPSHOT_FAILED",
    });
  });

  it("reports unconfirmed cleanup once its deadline is reached", async () => {
    const tracker = new OwnedProcessTracker(async () => [], () => {});
    tracker.setRoot(100, "birth-100");

    expect(await tracker.cleanup(Date.now())).toEqual({
      confirmed: false, error: "PROCESS_CLEANUP_UNCONFIRMED",
    });
  });
});
