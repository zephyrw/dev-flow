export type WindowsNative = ReturnType<
  typeof import("./windows.js").createWindowsNative
>;
export type PosixNative = ReturnType<
  typeof import("./posix.js").createPosixNative
>;
export type NativeModule = WindowsNative | PosixNative;
let native: NativeModule | undefined;
let initializing: Promise<NativeModule> | undefined;
export async function getNativeAsync(): Promise<NativeModule> {
  return (
    native ??
    (initializing ??= (async () => {
      native =
        process.platform === "win32"
          ? (await import("./windows.js")).createWindowsNative()
          : (await import("./posix.js")).createPosixNative();
      return native;
    })())
  );
}
export function getNative(): NativeModule {
  if (!native) throw new Error("NATIVE_NOT_INITIALIZED");
  return native;
}
export async function getWindowsNative(): Promise<WindowsNative> {
  const value = await getNativeAsync();
  if (!("createJob" in value)) throw new Error("WINDOWS_NATIVE_UNSUPPORTED");
  return value;
}
export const isWindows = () => process.platform === "win32";
export const isPosix = () => process.platform !== "win32";
