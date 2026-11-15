// Entry point: `node ozzie-mcp.mjs` (the bundle `pnpm build:mcp` writes). Speaks only protocol on stdout.
import { bundledSkills } from "../src/harness/bundled-skills.js";
import { readShared, sharedCheckPath } from "./file.js";
import { McpServer, serveStream } from "./server.js";

const path = sharedCheckPath();
const skills = await bundledSkills();
await serveStream(new McpServer({ read: () => readShared(path), skills }), process.stdin, process.stdout);
