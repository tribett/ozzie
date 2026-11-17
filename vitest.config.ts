import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";

// The TypeScript tests run on the Node pinned in .node-version (and .nvmrc). The pinned Pi packages the agent loop
// uses (@earendil-works/pi-agent-core and pi-ai) declare Node 22.19 or later, so older versions are refused here
// rather than failing in confusing ways; other versions are not what the suite was verified on (older ICU data
// changes some date formatting).
const pinned = readFileSync(new URL(".node-version", import.meta.url), "utf8").trim();
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  throw new Error(`Node ${process.versions.node} is too old for these tests; use Node ${pinned} (.node-version).`);
}
if (process.versions.node !== pinned) {
  console.warn(`Note: these tests are verified on Node ${pinned} (.node-version); this is Node ${process.versions.node}.`);
}

export default defineConfig({
  test: {
    // Half the cores: with a worker on every core, the runner's own process starved and a worker's report timed out
    // ("Timeout calling onTaskUpdate", every test passed but the run failed on CI and this Mac). Faster this way too.
    maxWorkers: "50%",
    include: ["core", "product"].flatMap(root =>
      configDefaults.include.map(pattern => `${root}/${pattern}`)),
  },
});
