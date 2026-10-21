import { defineConfig } from "tsup";

const shared = {
  format: ["esm"] as ["esm"],
  // tsup sets baseUrl for the .d.ts build, which TypeScript 6 reports as deprecated
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
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
