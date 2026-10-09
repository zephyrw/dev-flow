import koffi from "koffi";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  createWriteStream,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadStream } from "node:tty";
import { promisify } from "node:util";

const execute = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** The CLI inherits the already-owned runner group; Terminal only relays its PTY. */
export async function spawnDarwinInteractive(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  onDisconnect: () => void;
}): Promise<ChildProcess> {
  if (process.platform !== "darwin")
    throw new Error("INTERACTIVE_LOGIN_UNSUPPORTED");
  input.signal.throwIfAborted();
  const libc = koffi.load("libSystem.B.dylib");
  const open = libc.func(
    "int openpty(void *master, void *slave, void *name, void *termios, void *winsize)",
  );
  const masterSlot = Buffer.alloc(4),
    slaveSlot = Buffer.alloc(4),
    size = Buffer.alloc(8);
  size.writeUInt16LE(36);
  size.writeUInt16LE(120, 2);
  if (open(masterSlot, slaveSlot, null, null, size) !== 0)
    throw new Error("PTY_CREATE_FAILED");
  const master = masterSlot.readInt32LE(),
    slave = slaveSlot.readInt32LE();
  // The detached runner is a session leader. Give its CLI a controlling
  // terminal as well as TTY descriptors (login clients may open /dev/tty).
  const session = libc.func("int getsid(int pid)");
  if (session(0) === process.pid) {
    const ioctl = libc.func("int ioctl(int fd, ulong request, ...)");
    const group = Buffer.alloc(4);
    group.writeInt32LE(process.pid);
    if (
      ioctl(slave, 0x20007461, "void *", null) !== 0 ||
      ioctl(slave, 0x80047476, "void *", group) !== 0
    ) {
      closeSync(master);
      closeSync(slave);
      throw new Error("PTY_CONTROL_FAILED");
    }
  }
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "df-tty-"));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, "relay");
  let socket: Socket | undefined, reader: ReadStream | undefined;
  let cleaned = false,
    slaveClosed = false;
  const writer = createWriteStream("", { fd: master, autoClose: false });
  const server = createServer();
  let rejectConnection!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => {
    rejectConnection = reject;
    server.once("connection", (client) => {
      socket = client;
      // Accept exactly one same-user endpoint in the private socket directory.
      server.close();
      client.on("error", disconnect);
      client.once("close", disconnect);
      resolve();
    });
  });
  void connected.catch(() => {});
  function disconnect() {
    if (cleaned) return;
    cleanup();
    input.onDisconnect();
  }
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    rejectConnection(new Error("INTERACTIVE_LOGIN_CANCELLED"));
    input.signal.removeEventListener("abort", cleanup);
    server.close();
    socket?.destroy();
    writer.destroy();
    if (reader) reader.destroy();
    else closeSync(master);
    if (!slaveClosed) {
      slaveClosed = true;
      closeSync(slave);
    }
    rmSync(directory, { recursive: true, force: true });
  }
  input.signal.addEventListener("abort", cleanup, { once: true });
  writer.on("error", disconnect);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    const command =
      "/bin/stty raw -echo; /usr/bin/nc -U " +
      quote(socketPath) +
      "; /bin/stty sane; exit";
    await execute(
      "/usr/bin/osascript",
      [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        'tell application "Terminal" to do script ' + JSON.stringify(command),
      ],
      { timeout: 25000, signal: input.signal, maxBuffer: 65536 },
    );
    await connected;
    input.signal.throwIfAborted();
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: { ...input.env, TERM: "xterm-256color" },
      stdio: [slave, slave, slave],
      detached: false,
      shell: false,
    });
    closeSync(slave);
    slaveClosed = true;
    reader = new ReadStream(master);
    reader.on("error", cleanup);
    reader.pipe(socket!);
    socket!.pipe(writer);
    child.once("exit", cleanup);
    child.once("error", cleanup);
    return child;
  } catch (error) {
    cleanup();
    throw error;
  }
}
