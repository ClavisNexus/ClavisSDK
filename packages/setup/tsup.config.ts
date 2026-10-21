import { defineConfig } from "tsup";

const shared = {
  format: ["esm"] as ["esm"],
  dts: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  external: ["jose", "@modelcontextprotocol/sdk", "zod"],
  target: "es2022" as const,
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    clean: true,
  },
  {
    ...shared,
    entry: { cli: "src/cli.ts", mcp: "src/mcp.ts" },
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
