import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const local = resolve(".cache/dotnet/dotnet.exe");
const dotnet = existsSync(local) ? local : "dotnet";
const env = {
  ...process.env,
  APPDATA: resolve(".cache/appdata"),
  LOCALAPPDATA: resolve(".cache/localappdata"),
  DOTNET_CLI_HOME: resolve(".cache/dotnet-home"),
  NUGET_PACKAGES: resolve(".cache/nuget"),
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
};
const result = spawnSync(
  dotnet,
  [
    "build",
    "host/DevFlow.WinHost",
    "-c",
    "Release",
    "--configfile",
    "host/NuGet.Config",
    "--nologo",
  ],
  { env, stdio: "inherit", windowsHide: true },
);
process.exit(result.status ?? 1);
