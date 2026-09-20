/** Legacy log redaction could corrupt JSON inside command output. Salvage only its completion envelope. */
export function storedNativeRecord(line: string): any | undefined {
  try { return JSON.parse(line); } catch {
    const head = line.match(/^\{"type":"item.completed","item":\{"id":"([\w-]+)","type":"command_execution",/);
    const tail = line.match(/,"exit_code":(-?\d+),"status":"(completed|failed)"\}\}\s*$/);
    if (!head || !tail) return;
    return { type: "item.completed", item: { id: head[1], type: "command_execution", exit_code: Number(tail[1]), status: tail[2] } };
  }
}
