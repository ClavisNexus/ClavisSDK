import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runMcpServer } from "./mcp-server.js";

export { runMcpServer };

/**
 * Start only when launched as `node dist/mcp.js`. For `clavis mcp` the CLI calls runMcpServer, so
 * nothing starts here. Paths are compared with symbolic links resolved.
 */
function startedDirectly(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string") return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  runMcpServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
