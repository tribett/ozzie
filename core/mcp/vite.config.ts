// Bundles the server into one Node file, with the fixed texts and procedures (`?raw` imports) inlined:
// core/mcp/dist/ozzie-mcp.mjs. Node 22 or later; no packages are needed at run time.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL("./main.ts", import.meta.url)),
    // Build output (git-ignored), named by path so it isn't read as a source reference.
    outDir: join(dirname(fileURLToPath(import.meta.url)), "dist"),
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: { output: { format: "es", entryFileNames: "ozzie-mcp.mjs" } },
  },
  ssr: { noExternal: true, target: "node" },
});
