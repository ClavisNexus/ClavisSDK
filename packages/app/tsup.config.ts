import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // tsup sets baseUrl for the .d.ts build, which TypeScript 6 reports as deprecated
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ["jose", "@clavis.nexus/collatio"],
  target: "es2022",
});
