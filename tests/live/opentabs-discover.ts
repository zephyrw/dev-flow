import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const client = new Client({ name: "devflow-live-discovery", version: "1" });
try {
  const secret = JSON.parse(
    readFileSync(join(homedir(), ".opentabs/extension/auth.json"), "utf8"),
  ).secret;
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:9515/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  const all = [];
  let cursor: string | undefined;
  do {
    const r = await client.listTools({ cursor });
    all.push(...r.tools);
    cursor = r.nextCursor;
  } while (cursor);
  mkdirSync(".cache/live-opentabs", { recursive: true });
  writeFileSync(
    ".cache/live-opentabs/tools.json",
    JSON.stringify(all, null, 2),
  );
  console.log(
    JSON.stringify(
      all.map((t) => ({
        name: t.name,
        description: t.description?.slice(0, 100),
      })),
    ),
  );
} finally {
  await client.close();
}
