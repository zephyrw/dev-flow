/** Compare a simple host command to a configured argv. Shell compositions are
 * intentionally not treated as proof of an individual required check. */
export function matchesCommand(
  command: string,
  executable: string,
  args: string[],
): boolean {
  const tokens: string[] = [];
  let token = "",
    quote = "",
    present = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      present = true;
      continue;
    }
    if (/[|;&<>\r\n]/.test(ch)) return false;
    if (/\s/.test(ch)) {
      if (present) {
        tokens.push(token);
        token = "";
        present = false;
      }
    } else {
      token += ch;
      present = true;
    }
  }
  if (quote) return false;
  if (present) tokens.push(token);
  const expected = [executable, ...args];
  if (tokens.length !== expected.length) return false;
  return tokens.every((v, i) =>
    i === 0 && process.platform === "win32"
      ? v.replaceAll("\\", "/").toLowerCase() ===
        expected[i]!.replaceAll("\\", "/").toLowerCase()
      : v === expected[i],
  );
}
