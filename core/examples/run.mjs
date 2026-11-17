// Runs core/examples/sunday-check.ts and prints what it returns. The core is TypeScript written for Vite
// (it imports some fixed texts with `?raw`), so this loads it with the Vite the repository already pins,
// in memory: nothing is built or written, and nothing is fetched.
//
//   node core/examples/run.mjs           the findings as plain text
//   node core/examples/run.mjs --json    the same findings as JSON
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const example = fileURLToPath(new URL("./sunday-check.ts", import.meta.url));
const { module } = await runnerImport(example, { configFile: false, logLevel: "error" });
process.stdout.write(module.main(process.argv.slice(2)));
