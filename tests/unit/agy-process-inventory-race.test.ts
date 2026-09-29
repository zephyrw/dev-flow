import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";
import type { Store } from "../../packages/store/src/store.js";

const fixture = vi.hoisted(() => ({ prefix: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execute = promisify(original.execFile);
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (file: string, args: string[], options: object) => {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      return execute(file, [...args.slice(0, -1), Buffer.from(fixture.prefix + script, "utf16le").toString("base64")], options);
    },
  });
  return { ...original, execFile };
});

// Execute the production PowerShell inventory with both CIM commands replaced.
// This never enumerates or stops real processes and never invokes AGY.
function setup(recheck: string, owner = "throw 'HRESULT 0x80041002: object not found'") {
  fixture.prefix = `
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($Filter) {
    if ($Filter -ne 'ProcessId = 34036') { throw 'Unexpected PID query' }
    ${recheck}
    return
  }
  [PSCustomObject]@{ProcessId=34036;ParentProcessId=1;Name='agy.exe';ExecutablePath='C:/fixture/agy.exe';CreationDate=[DateTime]::UtcNow}
  [PSCustomObject]@{ProcessId=34037;ParentProcessId=1;Name='agy.exe';ExecutablePath='C:/fixture/agy.exe';CreationDate=[DateTime]::UtcNow}
}
function Invoke-CimMethod {
  param($InputObject, $MethodName, $ErrorAction)
  if ($InputObject.ProcessId -eq 34036) { ${owner} }
  [PSCustomObject]@{ReturnValue=0;Sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
}
`;
  const host = new AgyAccountProcessHost({ store: {} as Store, agyExecutable: "agy.exe" });
  return () => (host as unknown as { inventory(): Promise<{ pid: number }[]> }).inventory();
}

describe.skipIf(process.platform !== "win32")("AGY CIM inventory exit race", () => {
  beforeEach(() => { fixture.prefix = ""; });
  it("ignores an owner-query failure only when the PID has disappeared, keeping later live AGY entries", async () => {
    expect(await setup("return")()).toEqual([expect.objectContaining({ pid: 34037 })]);
  });
  it("keeps not-found errors when the PID still exists or was reused", async () => {
    await expect(setup("[PSCustomObject]@{ProcessId=34036}")()).rejects.toThrow("0x80041002");
  });
  it("keeps genuine owner permission failures for a live process", async () => {
    await expect(setup("[PSCustomObject]@{ProcessId=34036}", "throw 'Access denied'")()).rejects.toThrow("Access denied");
  });
  it("keeps unsuccessful owner return codes for a live process", async () => {
    await expect(setup("[PSCustomObject]@{ProcessId=34036}", "return [PSCustomObject]@{ReturnValue=2}")()).rejects.toThrow("Cannot establish AGY process owner");
  });
  it("does not interpret a failed PID recheck as absence", async () => {
    await expect(setup("throw 'PID recheck unavailable'")()).rejects.toThrow("PID recheck unavailable");
  });
});
