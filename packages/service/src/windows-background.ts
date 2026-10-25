import { spawn } from "node:child_process";

// WMI creates the process outside the MCP client's Job hierarchy. Passing data
// through stdin avoids shell interpolation and keeps environment values out of
// the command line and logs. The broker runs locally as the current user.
export async function spawnWindowsBackground(executable: string, args: string[], cwd: string,
  env: Record<string, string>, stdoutPath: string, stderrPath: string): Promise<number> {
  const quote = (value: string) => '\"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '\"';
  if ([executable, cwd, stdoutPath, stderrPath, ...args, ...Object.values(env)].some(value => value.includes("\0")))
    throw new Error("INVALID_PROCESS_ARGUMENT");
  const commandLine = [executable, "--import", new URL("./background-stdio.mjs", import.meta.url).href, ...args].map(quote).join(" ");
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadLine() | ConvertFrom-Json
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow = [uint16]0
  CreateFlags = [uint32]0x09000400
  EnvironmentVariables = [string[]]$request.environment
}
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = [string]$request.commandLine
  CurrentDirectory = [string]$request.cwd
  ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) { throw ('CONTROLLER_JOB_ISOLATION_FAILED: WMI ' + $result.ReturnValue) }
[Console]::Out.Write([string]$result.ProcessId)
`;
  const broker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise<number>((resolve, reject) => {
    let output = "", failed = "";
    const timer = setTimeout(() => { broker.kill(); reject(new Error("CONTROLLER_JOB_ISOLATION_FAILED: broker timeout")); }, 20000);
    broker.stdout.on("data", data => { output += data.toString(); });
    broker.stderr.on("data", data => { failed += data.toString(); });
    broker.once("error", error => { clearTimeout(timer); reject(error); });
    broker.once("close", code => {
      clearTimeout(timer);
      const pid = Number(output.trim());
      if (code === 0 && Number.isInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error("CONTROLLER_JOB_ISOLATION_FAILED: " + (failed.match(/WMI \d+/)?.[0] ?? `broker exit ${code}`)));
    });
    broker.stdin.on("error", error => { clearTimeout(timer); reject(error); });
    // JSON escapes embedded newlines; one trailing newline frames the request
    // without depending on EOF propagation through inherited Windows pipes.
    broker.stdin.end(JSON.stringify({ commandLine, cwd, environment: Object.entries({ ...env,
      DEVFLOW_CONTROLLER_STDOUT: stdoutPath, DEVFLOW_CONTROLLER_STDERR: stderrPath,
    }).map(([key, value]) => `${key}=${value}`) }) + "\n");
  });
}
