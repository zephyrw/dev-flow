import { isAbsolute, resolve } from "node:path";
import { FlowError } from "../../contracts/src/index.js";
import { openPosixMaterialRoot } from "../../process/src/native/material-filesystem-posix.js";
import { openWindowsMaterialRoot } from "../../process/src/native/material-filesystem-windows.js";

export function materialRelativePath(input: string): string {
  if (typeof input !== "string" || !input || input !== input.trim() || isAbsolute(input) || /^[\\/]/.test(input) || /[:\x00-\x1f]/.test(input)) throw new FlowError("INVALID_PATH", "材料路径不是安全相对路径", 400);
  const parts = input.replaceAll("\\", "/").split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new FlowError("INVALID_PATH", "材料路径包含非法路径段", 400);
  return parts.join("/");
}

export function withMaterialRoot<T>(root: string, fn: (port: ReturnType<typeof openPosixMaterialRoot>) => T): T {
  const boundaryError = (error: unknown) => {
    if (error instanceof FlowError) return error;
    const native = error as { message?: string; errno?: number; native_status?: number };
    const conflict = /REPARSE|BINDING|CONFLICT|INVALID_TYPE/.test(native.message ?? "") || [20, 40, 62].includes(native.errno ?? 0) || [0xc0000103, 0xc000050b, 0xc0000279, 0xc0000033].includes(native.native_status ?? 0);
    return new FlowError(conflict ? "MATERIAL_FS_CONFLICT" : "MATERIAL_FS_UNSUPPORTED", conflict ? "材料目录或对象身份发生冲突" : "当前材料目录不支持安全句柄操作", 409);
  };
  let port: ReturnType<typeof openPosixMaterialRoot>;
  try { port = process.platform === "win32" ? openWindowsMaterialRoot(resolve(root)) : openPosixMaterialRoot(resolve(root)); }
  catch (error) { throw boundaryError(error); }
  try { return fn(port); } catch (error) { throw boundaryError(error); } finally { port.close(); }
}

export function readMaterialFile(root: string, path: string): Buffer | undefined {
  const rel = materialRelativePath(path);
  return withMaterialRoot(root, (port) => port.read(rel));
}

export function publishMaterialFile(root: string, path: string, data: Buffer, operationId: string): void {
  const rel = materialRelativePath(path);
  withMaterialRoot(root, (port) => {
    port.publish(rel, data, operationId);
    const actual = port.read(rel);
    if (!actual?.equals(data)) throw new FlowError("MATERIAL_FILE_CONFLICT", "材料对象内容冲突", 409);
    port.validate();
    if (withMaterialRoot(root, (current) => current.identity) !== port.identity) throw new FlowError("MATERIAL_BINDING_CONFLICT", "材料根目录已迁移", 409);
  });
}
