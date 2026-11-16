// Ready-made setup for other AI apps: for each app, the exact text it needs to start Ozzie's read-only helper on this
// Mac and the steps in plain words. Pure: a helper path in, text out. Nothing here shares, reads or opens anything.
// Where each app's format comes from, and which were run on a Mac and which only read in the maker's own
// documentation, is recorded in core/docs/mcp.md ("Ready-made setup").

/** The name every app lists Ozzie's helper under. */
export const SETUP_NAME = "ozzie";

export const SETUP_APP_IDS = ["claude", "claude-code", "codex", "cursor", "vs-code", "lm-studio", "gemini", "other"] as const;
export type SetupAppId = typeof SETUP_APP_IDS[number];

export interface SetupApp {
  readonly id: SetupAppId;
  /** The app's name as the person knows it. */
  readonly name: string;
  /** What the text is called beside its Copy button. */
  readonly textLabel: string;
  /** Steps in plain words. A file or folder name the person has to find is wrapped in backticks. */
  readonly steps: readonly string[];
  /** The exact text for this app, for the helper at `path`. */
  readonly text: (path: string) => string;
  /** True when Ozzie can hand this app a file it opens by itself (Claude's own extension file). */
  readonly oneClick: boolean;
  /** Set when the helper's path is also shown by itself, under these words (an app that asks for a command). */
  readonly pathLabel?: string;
}

/**
 * A helper path the setup text can carry as it is: absolute, one line, no control characters, and no `${` (an AI app's
 * extension file would read that as a blank to fill in). Anything else gets no setup text at all.
 */
export const usablePath = (path: string): boolean =>
  path.startsWith("/") && path.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(path) && !path.includes("${");

/** One word for a POSIX shell: single quotes, with any single quote inside closed, escaped and opened again. */
export const shellWord = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

const json = (value: unknown): string => JSON.stringify(value, null, 2);
/** The shape Claude, Cursor, LM Studio and most other apps read. */
const listed = (path: string): string => json({ mcpServers: { [SETUP_NAME]: { command: path, args: [] } } });
const ASK = "\"What still needs attention for Sunday in Ozzie?\"";

export const SETUP_APPS: readonly SetupApp[] = [
  {
    id: "claude", name: "Claude", textLabel: "Setup text", oneClick: true,
    steps: [
      "In Claude, open Settings, choose Developer, then Edit Config.",
      "Paste the setup text into the file that opens, and save it. If the file already lists other apps, put the \"ozzie\" part beside them instead of replacing them.",
      `Quit Claude and open it again. Then ask Claude, for example, ${ASK}`,
    ],
    text: listed,
  },
  {
    id: "claude-code", name: "Claude Code", textLabel: "Line for Terminal", oneClick: false,
    steps: [
      "Open Terminal, paste this line and press Return.",
      `Start Claude Code again. Then ask it, for example, ${ASK}`,
    ],
    text: path => `claude mcp add --scope user ${SETUP_NAME} -- ${shellWord(path)}`,
  },
  {
    id: "codex", name: "Codex", textLabel: "Line for Terminal", oneClick: false,
    steps: [
      "Open Terminal, paste this line and press Return.",
      `Start Codex again. Then ask it, for example, ${ASK}`,
    ],
    text: path => `codex mcp add ${SETUP_NAME} -- ${shellWord(path)}`,
  },
  {
    id: "cursor", name: "Cursor", textLabel: "Setup text", oneClick: false,
    steps: [
      "Open the file `mcp.json` in the `.cursor` folder of your home folder. If it isn't there, make it.",
      "Paste the setup text and save it. If the file already lists other apps, put the \"ozzie\" part beside them instead of replacing them.",
      `Then ask Cursor, for example, ${ASK} If Cursor doesn't find Ozzie, quit Cursor and open it again.`,
    ],
    text: listed,
  },
  {
    id: "vs-code", name: "VS Code", textLabel: "Line for Terminal", oneClick: false,
    steps: [
      "If you haven't before: in VS Code, press Shift-Command-P, type \"shell command\" and choose Shell Command: Install 'code' command in PATH.",
      "Open Terminal, paste this line and press Return.",
      `Then ask the chat in VS Code, for example, ${ASK}`,
    ],
    text: path => `code --add-mcp ${shellWord(JSON.stringify({ name: SETUP_NAME, type: "stdio", command: path }))}`,
  },
  {
    id: "lm-studio", name: "LM Studio", textLabel: "Setup text", oneClick: false,
    steps: [
      "In LM Studio, open the Program tab, choose Install, then Edit `mcp.json`.",
      "Paste the setup text and save it. If the file already lists other apps, put the \"ozzie\" part beside them instead of replacing them.",
      `Then ask, for example, ${ASK}`,
    ],
    text: listed,
  },
  {
    id: "gemini", name: "Gemini CLI", textLabel: "Line for Terminal", oneClick: false,
    steps: [
      "Open Terminal, paste this line and press Return.",
      `Start Gemini CLI again. Then ask it, for example, ${ASK}`,
    ],
    text: path => `gemini mcp add --scope user ${SETUP_NAME} ${shellWord(path)}`,
  },
  {
    id: "other", name: "Another app", textLabel: "Setup text", oneClick: false, pathLabel: "The command by itself",
    steps: [
      "Find where that app lets you add a program it can start on this Mac. Many apps take the setup text as it is.",
      "If the app asks for a command instead, give it only the command by itself, shown below the setup text. It needs nothing else.",
    ],
    text: listed,
  },
];

export const setupApp = (id: SetupAppId): SetupApp => SETUP_APPS.find(app => app.id === id) ?? SETUP_APPS[0]!;

// --- The file Claude opens by itself ("Add Ozzie to Claude") ---------------------------------------------------------
// Claude for Mac opens a file ending in .mcpb and asks the person whether to install it. The file is a zip holding a
// manifest. Ozzie's holds no program of its own: it names the helper inside this copy of Ozzie, so what Claude starts
// is the helper at that place: the one that came with the Ozzie on this Mac. Native writes the file
// (product/desktop/src-tauri/src/share_bundle.rs) from its own copy of this manifest; a test holds the two equal.

export const CLAUDE_BUNDLE_FILE = "Ozzie.mcpb";
/** A short note inside the file, so its entry point is a real file a curious person can read. */
export const CLAUDE_BUNDLE_NOTE = "server/about.txt";
export const claudeBundleNote = (path: string): string =>
  `This file holds no program. Claude starts the read-only helper inside Ozzie on this Mac:\n${path}\n`;

/** The four read-only tools, as the manifest lists them for the person reviewing the install. */
export const CLAUDE_BUNDLE_TOOLS = [
  { name: "sunday_readiness", description: "Where the coming Sunday stands at Ozzie's last check, with labels instead of names." },
  { name: "rooms_follow_ups_groups", description: "Room bookings that overlap, follow-ups without an owner and group meetings at serving times, at Ozzie's last check." },
  { name: "church_rules", description: "The Church rules Ozzie checks against, in words." },
  { name: "what_happened", description: "What Ozzie ran recently and how it ended." },
] as const;

export const claudeBundleManifest = (path: string, version: string) => ({
  manifest_version: "0.3",
  name: SETUP_NAME,
  display_name: "Ozzie",
  version,
  description: "Read Ozzie's last Sunday check on this Mac. Read-only, with labels like [Person 1] instead of names.",
  long_description: "Lets Claude read the last check Ozzie saved on this Mac, only while \"Use Ozzie's last check in other AI apps\" is on in Ozzie's Settings. People, roles and rooms appear as labels like [Person 1]; the names Ozzie read from Planning Center stay in Ozzie. It can't check Planning Center, change anything or send anything. It starts the helper inside Ozzie on this Mac, so if Ozzie moves or is removed, add it again from Ozzie's Settings.",
  author: { name: "Ozzie", url: "https://ozzie.church" },
  homepage: "https://ozzie.church",
  server: { type: "binary", entry_point: CLAUDE_BUNDLE_NOTE, mcp_config: { command: path, args: [] as string[] } },
  tools: CLAUDE_BUNDLE_TOOLS,
  compatibility: { platforms: ["darwin"] },
  license: "Apache-2.0",
});
