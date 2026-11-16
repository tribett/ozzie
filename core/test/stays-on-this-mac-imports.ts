// The import walker behind the stays-on-this-Mac proofs (core/test/calendar/stays-on-this-mac.test.ts and
// core/test/sources/stays-on-this-mac.test.ts): which modules a module imports, by reading its source, so a proof can
// follow every path from a module that sends something to the code whose text must stay on this Mac.
//
// It errs toward finding too much (review S, M1; review S2, finding 1). Every code file in the app's source folders is
// a module here, JavaScript included, so a .js go-between is seen. Imports are read with TypeScript's own parser, so a
// comment inside an import, or an import split over lines, is followed like any other (review S2). An import is
// followed whether static, type-only, side-effect only, a re-export of another module, dynamic (`import(…)`),
// `require(…)`, an import inside a type, or a worker's `new URL(…, import.meta.url)`. An import the walker can't follow
// is never dropped: it is a problem the proofs fail on. That is a relative import that resolves to nothing, a
// TypeScript module importing JavaScript (a go-between could hide there), a computed specifier, a specifier that is
// neither relative nor a package (one starting with "/", or holding ":" other than a "node:" built-in), and any
// `import.meta.glob`. Packages are not followed: they can't import the app's own code.
//
// It also gives the proofs what they check inside the guarded code: references to the page's global objects that no
// local declaration shadows (`globalRefs`), and the shape of a bridge to native code (`bridgeProblems`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
export const SOURCES = ["core/src", "core/mcp", "product/src", "product/desktop/src"];

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
export const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/u;
/** What a module may import that isn't code: a stylesheet, or a file read as text or data (`?raw`, JSON). */
const NOT_CODE = /\.(?:css|json|txt|md|svg|png)$/u;

function files(dir: string): string[] {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).flatMap(name => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith("dist")) return [];
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : CODE.test(name) ? [path] : [];
  });
}
/** Every code file in the app's source folders, TypeScript and JavaScript. */
export const ALL = SOURCES.flatMap(files);
const cache = new Map<string, string>();
export const source = (path: string): string => {
  let text = cache.get(path);
  if (text === undefined) { text = readFileSync(join(ROOT, path), "utf8"); cache.set(path, text); }
  return text;
};
const trees = new Map<string, ts.SourceFile>();
/** A module's source as TypeScript's parser reads it. */
export function parsed(path: string): ts.SourceFile {
  let tree = trees.get(path);
  if (!tree) {
    const kind = /\.[jt]sx$/u.test(path) ? ts.ScriptKind.TSX : /\.(?:m|c)?js$/u.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    tree = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, kind);
    trees.set(path, tree);
  }
  return tree;
}
const printer = ts.createPrinter({ removeComments: true });
const codes = new Map<string, string>();
/** A module's code with its comments taken out (as TypeScript prints it), for checks that are about code, not words. */
export function code(path: string): string {
  let text = codes.get(path);
  if (text === undefined) { text = printer.printFile(parsed(path)); codes.set(path, text); }
  return text;
}
/** Every node of a module, depth first. */
function nodes(tree: ts.SourceFile): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (n: ts.Node) => { all.push(n); ts.forEachChild(n, visit); };
  visit(tree);
  return all;
}
const lineOf = (n: ts.Node) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
/** A string literal's text (a template without `${…}` counts), or null for anything computed. */
const literalOf = (n: ts.Node | undefined): string | null => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
const isImportMetaUrl = (n: ts.Node | undefined) => Boolean(n && ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression)
  && n.expression.keywordToken === ts.SyntaxKind.ImportKeyword && n.name.text === "url");

export interface Edge { to: string; typeOnly: boolean }
export interface Imports { edges: Edge[]; problems: string[] }

/** Where a specifier leads from `from`: a module, something that isn't code, a package (null), or a problem. */
function resolveSpec(from: string, spec: string): { module: string } | { notCode: true } | { problem: string } | null {
  const [bare = "", query] = spec.split("?");
  if (!bare.startsWith(".")) {
    // Review S2: "/src/x.js" is the app's own file to a bundler, and "virtual:", "data:" or "http:" are not packages.
    if (bare.startsWith("/") || bare.startsWith("\\") || (bare.includes(":") && !/^node:[a-z/_]+$/u.test(bare))) {
      return { problem: `${from}: "${spec}" is neither a relative import nor a package` };
    }
    return null;
  }
  const base = relative(ROOT, resolve(ROOT, dirname(from), bare));
  const file = (p: string) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile();
  if (query !== undefined || NOT_CODE.test(base)) return file(base) ? { notCode: true } : { problem: `${from}: "${spec}" resolves to nothing` };
  // The file as written comes first, as the bundler takes it: an x.js beside an x.ts is the x.js.
  const candidates = [base, base.replace(/\.js$/u, ".ts"), base.replace(/\.js$/u, ".tsx"), base.replace(/\.mjs$/u, ".mts"), base.replace(/\.cjs$/u, ".cts"),
    `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}.js`, `${base}.mjs`, `${base}.jsx`, `${base}/index.js`];
  const found = candidates.find(p => CODE.test(p) && file(p));
  if (!found) return { problem: `${from}: "${spec}" resolves to nothing` };
  if (TYPESCRIPT.test(from) && !TYPESCRIPT.test(found)) return { problem: `${from}: "${spec}" resolves to JavaScript (${found})` };
  return { module: found };
}

/** Every specifier a module names as an import, as TypeScript reads it: [the literal or null when computed, type only, where]. */
export function specifiers(path: string): { spec: string | null; typeOnly: boolean; line: number }[] {
  const found: { spec: string | null; typeOnly: boolean; line: number }[] = [];
  for (const n of nodes(parsed(path))) {
    if (ts.isImportDeclaration(n)) found.push({ spec: literalOf(n.moduleSpecifier), typeOnly: Boolean(n.importClause?.isTypeOnly), line: lineOf(n) });
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier) found.push({ spec: literalOf(n.moduleSpecifier), typeOnly: n.isTypeOnly, line: lineOf(n) });
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      found.push({ spec: literalOf(n.moduleReference.expression), typeOnly: n.isTypeOnly, line: lineOf(n) });
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      found.push({ spec: literalOf(n.arguments[0]), typeOnly: false, line: lineOf(n) });
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URL" && isImportMetaUrl(n.arguments?.[1])) {
      found.push({ spec: literalOf(n.arguments?.[0]), typeOnly: false, line: lineOf(n) });
    } else if (ts.isImportTypeNode(n)) {
      const arg = n.argument;
      found.push({ spec: ts.isLiteralTypeNode(arg) ? literalOf(arg.literal) : null, typeOnly: true, line: lineOf(n) });
    }
  }
  return found;
}

const read = new Map<string, Imports>();
/** What `path` imports: each module it reaches directly, and every import the walker couldn't follow. */
export function importsOf(path: string): Imports {
  const known = read.get(path);
  if (known) return known;
  const edges: Edge[] = [], problems: string[] = [];
  for (const { spec, typeOnly, line } of specifiers(path)) {
    if (spec === null) { problems.push(`${path}:${line}: a computed import`); continue; }
    const r = resolveSpec(path, spec);
    if (r === null || "notCode" in r) continue;
    if ("problem" in r) problems.push(r.problem);
    else edges.push({ to: r.module, typeOnly });
  }
  for (const n of nodes(parsed(path))) {
    if (ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && /^glob/u.test(n.name.text)) problems.push(`${path}:${lineOf(n)}: import.meta.${n.name.text}`);
  }
  read.set(path, { edges, problems });
  return { edges, problems };
}

/**
 * The source files a module imports. `types`: whether a type-only import counts. Toward the guarded code it always
 * does (a module that builds what is sent may not even name its types); from it, a type-only import carries no code
 * that could send anything.
 */
export function imports(path: string, types = true): string[] {
  return importsOf(path).edges.filter(e => types || !e.typeOnly).map(e => e.to);
}
/** Everything `path` reaches through its imports, itself included. */
export function reach(path: string, types = true): Set<string> {
  const seen = new Set<string>([path]);
  const todo = [path];
  while (todo.length) for (const next of imports(todo.pop()!, types)) if (!seen.has(next)) { seen.add(next); todo.push(next); }
  return seen;
}
/** Every import in the source folders the walker couldn't follow. */
export const unfollowed = (): string[] => ALL.flatMap(p => importsOf(p).problems);

/** Whether `text` names this native command in any quote. */
export const names = (text: string, command: string): boolean => new RegExp(`["'\`]${command}["'\`]`, "u").test(text);

/** Every command the desktop app registers with native code (src-tauri/src/main.rs), by its bare name. */
export const NATIVE_COMMANDS = (() => {
  const main = readFileSync(join(ROOT, "product/desktop/src-tauri/src/main.rs"), "utf8");
  const list = /generate_handler!\[([^\]]*)\]/u.exec(main)?.[1] ?? "";
  return list.split(",").map(s => s.trim().split("::").at(-1)!).filter(s => /^[a-z][a-z0-9_]*$/u.test(s));
})();

/**
 * Ways page code could hand text to something outside the page without a native command: storage (the origin's own
 * file system and the window's name too; review T, L4), the network, a worker or another window, the system's notices,
 * sharing, speech, the clipboard, the window's title, logs.
 */
export const OFF_THE_PAGE_APIS = /console\.|localStorage|sessionStorage|indexedDB|navigator\.storage|\bFileSystem\w*Handle\b|\bshow(?:Open|Save)FilePicker\b|\bshowDirectoryPicker\b|\bwindow\.name\b|\bcookieStore\b|document\.cookie|\bcaches\.(?:open|match|has|delete|keys)\b|fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.clipboard|execCommand|navigator\.share|window\.open|\bNotification\b|postMessage|\bnew\s+(?:Shared)?Worker\b|BroadcastChannel|MessageChannel|speechSynthesis|SpeechSynthesisUtterance|document\.title|\bhistory\.(?:push|replace)State|\blocation\.(?:href|hash|search|assign|replace)\b/u;
/**
 * Ways around a bridge or across the page that the guarded code must not use either (review S2, finding 1): Tauri's own
 * internals (a native call by a name built at run time), events any module can listen to, and code built from text.
 */
export const AROUND_THE_BRIDGE = /__TAURI|\bdispatchEvent\b|\bCustomEvent\b|\beval\s*\(|\bFunction\s*\(|\bReflect\.|\bObject\.(?:assign|defineProperty|defineProperties)\s*\(\s*(?:window|globalThis|self|document)\b/u;
/**
 * Ways code could run later on its own (review T, L3): what reads a private link must run only when the leader opens a
 * page or asks, so the guarded page code may not set one up, its bridge's own time limit on a native call aside.
 */
export const TIMERS = /\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\brequestIdleCallback\b|\bqueueMicrotask\b|\bscheduler\.|\bAbortSignal\.timeout\b/u;
/** The page's global objects: guarded code may not reach them (a value set on one is readable by any module). */
export const PAGE_GLOBALS = ["window", "globalThis", "self", "document", "top", "parent", "frames", "opener"] as const;
/** Reading what the page shows: a sending module may not use these to read the church's own words off the page. */
export const PAGE_TEXT_READS = /querySelector|getElementsBy|getElementById|\btextContent\b|\binnerText\b|\binnerHTML\b|\bouterHTML\b|\bRange\b|\bXMLSerializer\b|\bownerDocument\b|\bnodeValue\b|\bTreeWalker\b|\bNodeIterator\b|\bdocument\.(?:body|documentElement|all|forms|links)\b|getSelection|elementsFromPoint|elementFromPoint|\.closest\(|createTreeWalker|createNodeIterator|caretRangeFromPoint|\bMutationObserver\b/u;

/** The names a binding pattern declares. */
function bound(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(e => ts.isOmittedExpression(e) ? [] : bound(e.name));
}
/** Whether an identifier is read as a value here (not a property's name, a declaration's own name or a type). */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id)) return false;
  if ((ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) && p.label === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)
    || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)
    || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isTypeParameterDeclaration(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p)
    || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isJsxAttribute(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  for (let n: ts.Node = id; n.parent; n = n.parent) if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return false;
  return true;
}
/** Names a scope declares directly: a function's parameters, a block's or file's declarations, a loop's or catch's variable. */
function scopeNames(n: ts.Node): string[] | null {
  if (ts.isFunctionLike(n)) {
    const own = (ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.name ? [n.name.text] : [];
    return [...own, ...n.parameters.flatMap(p => bound(p.name))];
  }
  if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
    const statements = ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) ? n.statements : n.statements;
    return statements.flatMap(s => ts.isVariableStatement(s) ? s.declarationList.declarations.flatMap(d => bound(d.name))
      : (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name ? [s.name.text]
        : ts.isImportDeclaration(s) ? importedNames(s) : []);
  }
  if ((ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
    return n.initializer.declarations.flatMap(d => bound(d.name));
  }
  if (ts.isCatchClause(n) && n.variableDeclaration) return bound(n.variableDeclaration.name);
  return null;
}
function importedNames(s: ts.ImportDeclaration): string[] {
  const c = s.importClause;
  if (!c) return [];
  const named = c.namedBindings;
  return [...(c.name ? [c.name.text] : []), ...(named && ts.isNamespaceImport(named) ? [named.name.text] : named ? named.elements.map(e => e.name.text) : [])];
}
/**
 * Every value reference in a module to one of `globals` that no enclosing declaration shadows: [the name, its line, the
 * line's text]. A local named `window` (calendar code calls the days shown its window) is not the page's window.
 */
export function globalRefs(path: string, globals: readonly string[] = PAGE_GLOBALS): { name: string; line: number; text: string }[] {
  const tree = parsed(path);
  const lines = source(path).split("\n");
  const found: { name: string; line: number; text: string }[] = [];
  const walk = (n: ts.Node, scopes: readonly (readonly string[])[]) => {
    const own = scopeNames(n);
    const inner = own ? [...scopes, own] : scopes;
    if (ts.isIdentifier(n) && globals.includes(n.text) && isValueReference(n) && !inner.some(s => s.includes(n.text))) {
      const line = lineOf(n);
      found.push({ name: n.text, line, text: lines[line - 1]!.trim() });
    }
    ts.forEachChild(n, c => walk(c, inner));
  };
  walk(tree, []);
  return found;
}

/** Value references to `name` in a module (declarations excluded), each with the node that holds it. */
function referencesTo(path: string, name: string): ts.Identifier[] {
  return nodes(parsed(path)).filter((n): n is ts.Identifier => ts.isIdentifier(n) && n.text === name && isValueReference(n));
}
/**
 * What is wrong with a bridge to native code (church-sources.ts, calendars.ts), as plain lines; none when it has the
 * one shape the proofs allow (review S2, finding 1; review U, finding 1):
 * - it imports only `invoke`, as `tauriInvoke`, from "@tauri-apps/api/core", and nothing else from Tauri, in any form;
 * - `tauriInvoke` is called once, inside `nativeInvoke`, which is private to the module and refuses any command that
 *   `allowed` refuses before anything is sent;
 * - `allowed` is a function whose body is one switch on `command` with a case for each command in the list named
 *   `list` and nothing else, all as string literals, returning true, and false by default: literal comparisons only,
 *   so nothing an importer could patch (a Set's `has` can be, through its prototype);
 * - `allowed` is used only there, `nativeInvoke` only as the controller's default `invoke`, and `invoke` only inside
 *   `call`, once;
 * - every use of `call` is a call whose command is a string literal in the allow-list: no name built at run time.
 */
export function bridgeProblems(path: string, list: string, commands: readonly string[]): string[] {
  const text = source(path);
  const problems: string[] = [];
  const tauri = specifiers(path).filter(s => s.spec === null || s.spec.startsWith("@tauri-apps"));
  if (tauri.length !== 1 || tauri[0]!.spec !== "@tauri-apps/api/core") problems.push(`imports from Tauri: ${JSON.stringify(tauri.map(t => t.spec))}`);
  if (!/^import \{ invoke as tauriInvoke \} from "@tauri-apps\/api\/core";$/mu.test(text)) problems.push("does not import exactly { invoke as tauriInvoke }");
  const guarded = `const nativeInvoke: Invoke = (command, args) => allowed(command) ? tauriInvoke(command, args) : Promise.reject("unavailable");`;
  const lines = text.split("\n");
  if (lines.filter(l => l === guarded).length !== 1) problems.push(`no single private guarded nativeInvoke`);
  // The guard: one switch over literal cases, exactly the list.
  const tree = parsed(path);
  const guards = tree.statements.filter((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === "allowed");
  const body = guards.length === 1 ? guards[0]!.body?.statements : undefined;
  const sw = body?.length === 1 && ts.isSwitchStatement(body[0]!) ? body[0] : null;
  if (!sw || !ts.isIdentifier(sw.expression) || sw.expression.text !== "command" || guards[0]!.parameters.map(p => p.getText()).join() !== "command: string") {
    problems.push("allowed is not one switch on command");
  } else {
    const clauses = sw.caseBlock.clauses;
    const cases = clauses.filter(ts.isCaseClause);
    const labels = cases.map(c => ts.isStringLiteral(c.expression) ? c.expression.text : null);
    const last = cases.at(-1);
    const fallsThrough = cases.slice(0, -1).every(c => c.statements.length === 0);
    const returns = (c: ts.CaseOrDefaultClause | undefined, value: string) => c?.statements.length === 1 && ts.isReturnStatement(c.statements[0]!) && c.statements[0].expression?.getText() === value;
    const fallback = clauses.at(-1);
    if (labels.includes(null) || [...labels].sort().join() !== [...commands].sort().join() || new Set(labels).size !== labels.length) problems.push(`allowed's cases aren't exactly ${list}: ${JSON.stringify(labels)}`);
    if (!fallsThrough || !returns(last, "true") || !fallback || !ts.isDefaultClause(fallback) || !returns(fallback, "false") || clauses.length !== cases.length + 1) {
      problems.push("allowed doesn't return true for its cases and false otherwise");
    }
  }
  const count = (name: string) => referencesTo(path, name).length;
  if (count("tauriInvoke") !== 1) problems.push(`tauriInvoke used ${count("tauriInvoke")} times (only inside nativeInvoke)`);
  if (count("allowed") !== 1) problems.push(`allowed used ${count("allowed")} times (only inside nativeInvoke)`);
  if (count("nativeInvoke") !== 1 || !lines.map(l => l.trim()).includes("const invoke = deps.invoke ?? nativeInvoke;")) problems.push("nativeInvoke used other than as the default invoke");
  // Nothing outside the module can reach the bridge: neither it nor its guard's state is exported in any form.
  for (const st of tree.statements) {
    if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) problems.push(`line ${lineOf(st)}: an export list or default export`);
  }
  const invokes = referencesTo(path, "invoke");
  if (invokes.length !== 1 || !ts.isCallExpression(invokes[0]!.parent) || invokes[0]!.parent.expression !== invokes[0]
    || invokes[0]!.parent.arguments.map(a => a.getText()).join(", ") !== "command, args") problems.push("invoke used other than once, as invoke(command, args) in call");
  const calls = referencesTo(path, "call");
  for (const id of calls) {
    const p = id.parent;
    const command = ts.isCallExpression(p) && p.expression === id ? literalOf(p.arguments[0]) : null;
    if (command === null || !commands.includes(command)) problems.push(`line ${lineOf(id)}: call without a literal command from ${list}: ${p.getText().slice(0, 80)}`);
  }
  if (!calls.length) problems.push("call is never used");
  return problems;
}

/** A module's code without its import declarations (their paths name modules, not what a page shows). */
export const codeWithoutImports = (path: string): string => code(path).split("\n").filter(l => !/^import[\s{"']/u.test(l.trim())).join("\n");

const MUTATING = /^(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)$/u;
/**
 * What in a module could keep state that one importer writes and another reads (review V, L5), as plain lines; none for
 * a module that only shares functions and fixed values: an exported `let`, `var` or class; an exported value other
 * than a function, a literal or a frozen object; a module-level `let` or `var`; and a write into a module-level
 * object, array, map or set (an assignment to one of its properties, a mutating method, Object.assign onto it).
 */
export function sharedStateProblems(path: string): string[] {
  const tree = parsed(path);
  const problems: string[] = [];
  const kept = new Set<string>();
  const fixed = (e: ts.Expression | undefined): boolean => !e ? false
    : ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
      || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword
      || (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) ? fixed(e.expression) : false)
      || (ts.isCallExpression(e) && /^(?:Object\.freeze|memo|forwardRef|React\.memo)$/u.test(e.expression.getText()));
  for (const statement of tree.statements) {
    const exported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst) problems.push(`${path}:${lineOf(statement)}: a module-level let or var`);
      for (const d of statement.declarationList.declarations) {
        if (exported && !fixed(d.initializer)) problems.push(`${path}:${lineOf(d)}: exports ${d.name.getText()}, which isn't a function or a fixed value`);
        if (ts.isIdentifier(d.name)) kept.add(d.name.text);
      }
    } else if (exported && ts.isClassDeclaration(statement)) problems.push(`${path}:${lineOf(statement)}: exports a class`);
  }
  const target = (e: ts.Expression): string | null => {
    let n: ts.Expression = e;
    while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    return ts.isIdentifier(n) && kept.has(n.text) ? n.text : null;
  };
  for (const n of nodes(tree)) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) && target(n.left)) problems.push(`${path}:${lineOf(n)}: writes into ${target(n.left)}`);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATING.test(n.expression.name.text) && target(n.expression.expression)) {
      problems.push(`${path}:${lineOf(n)}: changes ${target(n.expression.expression)}`);
    }
    if (ts.isCallExpression(n) && n.expression.getText() === "Object.assign" && n.arguments[0] && target(n.arguments[0])) problems.push(`${path}:${lineOf(n)}: assigns into ${target(n.arguments[0])}`);
  }
  return problems;
}

// ---- Escape hatches (review U, finding 1) ----------------------------------------------------------------------
// Word lists alone can be passed by reaching the page or shared state another way: a `declare` that hides a global,
// a node's `ownerDocument.defaultView`, a name built at run time and used as a key, a value left on a built-in or its
// prototype. These checks use TypeScript's type checker over the guarded modules, so what an expression *is* counts,
// whatever it is called. They are checks on Ozzie's own code, not a sandbox.

let checked: { program: ts.Program; checker: ts.TypeChecker } | null = null;
/** One program over every guarded module (the compiler's own options), made once per test file. */
function program(): { program: ts.Program; checker: ts.TypeChecker } {
  if (!checked) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config as unknown;
    const options = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
    const roots = ALL.filter(p => TYPESCRIPT.test(p)).map(p => join(ROOT, p));
    const made = ts.createProgram(roots, { ...options, noEmit: true });
    checked = { program: made, checker: made.getTypeChecker() };
  }
  return checked;
}
/** Whether a type is, or may be, the page's window, its document or the global object. */
function pageObject(checker: ts.TypeChecker, type: ts.Type): boolean {
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  return parts.some(t => {
    const name = t.getSymbol()?.getName();
    return name === "Window" || name === "Document" || checker.typeToString(t) === "typeof globalThis";
  });
}
/** The identifier an expression starts from, through property and element access, calls' targets, parentheses and casts. */
function rootOf(e: ts.Expression): ts.Expression {
  let n = e;
  for (;;) {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n)
      || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    else return n;
  }
}
/**
 * Whether an identifier names a built-in: something declared only in TypeScript's own libraries or in packages' type
 * declarations (Math, Set; `performance`, which Node's types declare too), never in the app's code or imported by it.
 */
function builtIn(made: ts.Program, checker: ts.TypeChecker, e: ts.Expression): boolean {
  if (!ts.isIdentifier(e)) return false;
  const declarations = checker.getSymbolAtLocation(e)?.declarations ?? [];
  return declarations.length > 0 && declarations.every(d => {
    const file = d.getSourceFile();
    return file.isDeclarationFile && (made.isSourceFileDefaultLibrary(file) || file.fileName.includes("/node_modules/"));
  });
}
/** Whether an identifier is a binding imported from another module (an object written onto would be shared with every importer). */
function imported(checker: ts.TypeChecker, e: ts.Expression): boolean {
  return ts.isIdentifier(e) && ((checker.getSymbolAtLocation(e)?.flags ?? 0) & ts.SymbolFlags.Alias) !== 0;
}
/** Names no guarded code may use, as a property or a variable: they lead from any node to the page and its window. */
const TO_THE_PAGE = new Set(["ownerDocument", "defaultView", "view", "getRootNode", "constructor", "clipboardData", "clipboard", "addEventListener"]);
/** Built-ins that are themselves channels any module can read: the performance timeline (its clock aside), the custom-element registry, a bare `open(`, the clipboard, ranges over the page. */
const CHANNELS = ["performance", "customElements", "open", "ClipboardItem", "Range", "XMLSerializer"] as const;
/** React props for events no one has to ask for (an animation repeating, a transition ending) or that put text off the page (copy). */
const UNASKED_PROPS = /^on(?:Copy|Cut|Paste|Animation\w*|Transition\w*)(?:Capture)?$/u;
/** Whether a key is fixed in the code: a literal, or typed as a number or as particular strings. */
function fixedKey(checker: ts.TypeChecker, key: ts.Expression): boolean {
  if (ts.isStringLiteral(key) || ts.isNumericLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return true;
  const type = checker.getTypeAtLocation(key);
  const parts = type.isUnion() ? type.types : [type];
  return parts.every(t => (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLiteral | ts.TypeFlags.EnumLiteral)) !== 0);
}
/**
 * The ways around the word lists a module uses, as `path:line: what`; none in a module that has none:
 * - a `declare` of anything (it emits nothing, so it can hide a global under a local's name);
 * - any expression typed as the page's window, its document or the global object, however it was reached;
 * - a name in TO_THE_PAGE as a property or a variable, and a reference to a built-in in CHANNELS;
 * - a key that isn't fixed in the code (`x[name]` with a string made at run time);
 * - a write to a property of a built-in or its prototype (`Set.prototype.has = …`, `Math.x = …`) or of an imported
 *   object (`React.x = …`), or either handed to Object.assign, defineProperty, defineProperties or setPrototypeOf;
 * - a React prop for an event no one asks for, or one that puts text on the clipboard.
 */
export function hatchProblems(path: string): string[] {
  const { program: made, checker } = program();
  const tree = made.getSourceFile(join(ROOT, path));
  if (!tree) return [`${path}: not in the program`];
  const problems: string[] = [];
  const at = (n: ts.Node, what: string) => problems.push(`${path}:${tree.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${what}`);
  const visit = (n: ts.Node): void => {
    if (ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) at(n, "a declare");
    if (ts.isModuleDeclaration(n) && n.name.getText() === "global") at(n, "declare global");
    // `view` only as a property (an event's window); a local of that name is the code's own.
    if (ts.isIdentifier(n) && TO_THE_PAGE.has(n.text) && (n.text !== "view" || (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
      || (ts.isBindingElement(n.parent) && (n.parent.propertyName ?? n.parent.name) === n && ts.isObjectBindingPattern(n.parent.parent)))) at(n, `uses ${n.text}`);
    // The clock alone is no channel: `performance.now()` (and `typeof performance`) are the one use allowed.
    const clockOnly = (id: ts.Identifier) => id.text === "performance" && (ts.isTypeOfExpression(id.parent)
      || (ts.isPropertyAccessExpression(id.parent) && id.parent.name.text === "now" && ts.isCallExpression(id.parent.parent) && id.parent.parent.expression === id.parent));
    if (ts.isIdentifier(n) && (CHANNELS as readonly string[]).includes(n.text) && isValueReference(n) && builtIn(made, checker, n) && !clockOnly(n)) at(n, `uses the built-in ${n.text}`);
    if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) && !ts.isTypeNode(n.parent)
      && (!ts.isIdentifier(n) || isValueReference(n)) && pageObject(checker, checker.getTypeAtLocation(n))) at(n, `reaches the page's window or document: ${n.getText().slice(0, 60)}`);
    if (ts.isElementAccessExpression(n) && !fixedKey(checker, n.argumentExpression)) at(n, `a key made at run time: ${n.getText().slice(0, 60)}`);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) && (builtIn(made, checker, rootOf(n.left)) || imported(checker, rootOf(n.left)))) {
      at(n, `writes onto a built-in or an imported object: ${n.left.getText().slice(0, 60)}`);
    }
    if (ts.isCallExpression(n) && /^(?:Object|Reflect)\.(?:assign|defineProperty|defineProperties|setPrototypeOf)$/u.test(n.expression.getText()) && n.arguments[0]
      && (builtIn(made, checker, rootOf(n.arguments[0])) || imported(checker, rootOf(n.arguments[0])))) at(n, `changes a built-in or an imported object: ${n.getText().slice(0, 60)}`);
    if (ts.isJsxAttribute(n) && UNASKED_PROPS.test(n.name.getText())) at(n, `the ${n.name.getText()} prop`);
    ts.forEachChild(n, visit);
  };
  visit(tree);
  return problems;
}

/** Methods of the lists' controller that read a file or a link (church-sources.ts). */
export const READS = new Set(["read", "readOne", "readIfOld", "load"]);
const EFFECT = /^(?:React\.)?use(?:Layout|Insertion)?Effect$/u;
/** Each effect in a module: the call, whether its dependency list is written out as an array, and whether its body calls a read. */
export function effectsOf(path: string): { line: number; deps: string | null; reads: boolean }[] {
  return nodes(parsed(path)).filter((n): n is ts.CallExpression => ts.isCallExpression(n) && EFFECT.test(n.expression.getText())).map(n => {
    const deps = n.arguments[1];
    const reads = n.arguments[0] !== undefined && nodes(parsed(path)).some(c => ts.isCallExpression(c) && c.pos >= n.arguments[0]!.pos && c.end <= n.arguments[0]!.end
      && ts.isPropertyAccessExpression(c.expression) && READS.has(c.expression.name.text));
    return { line: lineOf(n), deps: deps && ts.isArrayLiteralExpression(deps) ? deps.getText() : null, reads };
  });
}
/** Calls in a module to a read (READS by name) that are not inside an onClick handler, as `path:line`. */
export function readsOutsideClicks(path: string): string[] {
  return nodes(parsed(path)).filter(n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && READS.has(n.expression.name.text)).filter(n => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isJsxAttribute(p)) return p.name.getText() !== "onClick";
    return true;
  }).map(n => `${path}:${lineOf(n)}`);
}
