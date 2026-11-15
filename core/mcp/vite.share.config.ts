// Bundles the server for Ozzie's bundled helper (embedded.ts) into one classic script with no Node and no imports,
// the fixed texts and procedures (`?raw` imports) inlined: core/mcp/dist-share/ozzie-share.js (git-ignored). The
// global `OzzieShare` holds embedded.ts's exports. build.rs puts it inside the helper binary; macOS 14's JavaScriptCore
// is Safari 17's engine.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: { entry: fileURLToPath(new URL("./embedded.ts", import.meta.url)), formats: ["iife"], name: "OzzieShare", fileName: () => "ozzie-share.js" },
    // Build output, named by path so it isn't read as a source reference.
    outDir: join(dirname(fileURLToPath(import.meta.url)), "dist-share"),
    emptyOutDir: true,
    target: "safari17",
    minify: false,
    copyPublicDir: false,
  },
});
