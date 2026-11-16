// Bundles the answers for Siri and Shortcuts (shortcuts-embedded.ts) into one classic script with no Node and no
// imports, the fixed texts inlined: core/mcp/dist-shortcuts/ozzie-shortcuts.js (git-ignored). The global
// `OzzieShortcuts` holds shortcuts-embedded.ts's exports. build.rs puts it inside the helper binary; macOS 14's
// JavaScriptCore is Safari 17's engine.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: { entry: fileURLToPath(new URL("./shortcuts-embedded.ts", import.meta.url)), formats: ["iife"], name: "OzzieShortcuts", fileName: () => "ozzie-shortcuts.js" },
    // Build output, named by path so it isn't read as a source reference.
    outDir: join(dirname(fileURLToPath(import.meta.url)), "dist-shortcuts"),
    emptyOutDir: true,
    target: "safari17",
    minify: false,
    copyPublicDir: false,
  },
});
