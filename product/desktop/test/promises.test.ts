// Ozzie's promises live in one module (onboarding spec §0.2, lane T): no screen retypes one, so a promise can't drift
// between screens; and a write-back build gets every promise in its form B, each exactly true of that build.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_PROMISES, allPromises, BUILD_FORM, firstScreenPromises, promise, WRITE_BACK_BUILD } from "../src/promises.js";

const src = new URL("../src/", import.meta.url);
const files = readdirSync(src).filter(f => /\.(ts|tsx)$/u.test(f) && f !== "promises.ts");
/** The sentences long enough to be a promise rather than a common phrase ("Reads only." is checked on its own). */
const sentences = [...new Set(ALL_PROMISES)].filter(s => s.length > 20);

describe("promises", () => {
  it("each promise sentence appears only in promises.ts", () => {
    const found: string[] = [];
    for (const f of files) {
      // What a screen can show: code and strings, not comments.
      const code = readFileSync(new URL(f, src), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
      for (const s of sentences) if (code.includes(s)) found.push(`${f}: ${s}`);
      if (/["'`>]Reads only\.\s/u.test(code)) found.push(`${f}: Reads only.`);
    }
    expect(found).toEqual([]);
  });

  it("this build only reads, so every promise is in form A", () => {
    expect(WRITE_BACK_BUILD).toBe(false);
    expect(BUILD_FORM).toBe("A");
    expect(firstScreenPromises()).toEqual([
      "It only reads. It never changes anything in Planning Center.",
      "The names Ozzie reads from Planning Center stay on this Mac. The AI sees stand-ins instead.",
      "It never sends anything for you. You send every note yourself.",
    ]);
    expect(promise("readsShort")).toBe("Reads only.");
  });

  it("a write-back build says form B, with no reads-only promise left anywhere", () => {
    const b = allPromises("B");
    expect(b).toContain("It changes nothing in Planning Center unless you confirm that one change.");
    expect(b).toContain("It never sends a message for you. You send every note yourself.");
    expect(promise("readsShort", "B")).toBe("Changes only what you confirm.");
    expect(promise("connectReads", "B")).toBe("Ozzie changes nothing in Planning Center unless you confirm that one change.");
    for (const line of [...b, ...(["readsShort", "connectReads", "still", "connectAnd", "request"] as const).map(n => promise(n, "B"))]) {
      expect(line).not.toMatch(/only reads|never changes anything|Reads only/u);
    }
  });

  it("form A stays exactly true: while this build says it only reads, nothing in it can write to Planning Center (review M12)", () => {
    const dir = (rel: string) => new URL(rel, import.meta.url);
    const rust = (rel: string) => readdirSync(dir(rel)).filter(f => f.endsWith(".rs") && !f.endsWith("_tests.rs")).map(f => ({ f, code: readFileSync(new URL(f, dir(rel)), "utf8") }));
    const native = [...rust("../../../core/native-auth/src/"), ...rust("../src-tauri/src/")];
    // Planning Center's data is read through one request shape only: a GET (source.rs NativeSourceHttp::build).
    const source = native.find(n => n.f === "source.rs")!.code;
    const build = source.slice(source.indexOf("impl NativeSourceHttp {"), source.indexOf("impl SourceHttp for NativeSourceHttp"));
    expect(build).toContain(".get(request.url())");
    expect(build).not.toMatch(/\.(?:post|put|patch|delete|request)\(/u);
    // The only other Planning Center addresses are sign-in's own: token, user info and revoke.
    for (const { f, code } of native) {
      const addresses = [...code.matchAll(/https:\/\/api\.planningcenteronline\.com(\/[\w/.-]*)/gu)].map(m => m[1]);
      if (f === "provider.rs") expect(addresses.sort()).toEqual(["/oauth/revoke", "/oauth/token", "/oauth/userinfo"]);
      else if (f === "source.rs" || f === "sunday_picker.rs" || f === "contact.rs") for (const a of addresses) expect(a, f).toMatch(/^\/(?:services|people|calendar|groups|check-ins|registrations)\/v2\b|^\/?$/u);
    }
    // No write-back action (docs/design/write-back-design.md: prepare and carry_out a change) in this build.
    const hasWrite = native.some(({ code }) => /\bcarry_out\b|write_back|confirm_change/u.test(code));
    expect(hasWrite).toBe(WRITE_BACK_BUILD);
  });
});
