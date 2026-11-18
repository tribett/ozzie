// The onboarding bridge (src/onboarding-bridge.ts) against the native contract's shapes, on fakes: replies are checked
// and reduced to codes, counts, ids and services' own names; a command native doesn't have yet takes its fallback; a key
// or provider text never comes back. Fictional data only.
import { describe, expect, it } from "vitest";
import { MODEL_EVENT, paidEnd, parseKeyResult, parseLocal, parseModelProgress, parseOffer, parsePick, parseProgress, parseProviders, parseSaved, parseSetupCheck, pausedUntil } from "../src/onboarding-bridge.js";
import { fakeNative, NOTHING_PLANNED, pickReply, planNext, SATURDAY_NIGHT, SUNDAY_MORNING } from "./onboarding-fakes.js";

describe("onboarding bridge", () => {
  it("reads pick_service as native sends it", async () => {
    const { bridge } = fakeNative({ pick_service: pickReply(SATURDAY_NIGHT, SUNDAY_MORNING, NOTHING_PLANNED) });
    const pick = await bridge.pickService();
    expect(pick.time_zone).toBe("America/Chicago");
    expect(pick.services.map(s => [s.name, s.next?.id ?? null])).toEqual([["Saturday Night", "93000001"], ["Sunday Morning", "92902197"], ["Christmas Eve", null]]);
    expect(pick.services[1]!.next!.times).toEqual(["2026-11-22T15:00:00Z", "2026-11-22T17:00:00Z"]);
  });

  it("without pick_service, builds the same from the two picker reads, soonest first, with no times", async () => {
    const { bridge, calls } = fakeNative({
      list_service_types: { items: [{ id: "1500", name: "Sunday Morning" }, { id: "1600", name: "Saturday Night" }, { id: "1800", name: "Christmas Eve" }], more: false },
      list_upcoming_plans: ({ serviceTypeId }: Record<string, unknown>) => ({ items: serviceTypeId === "1500"
        ? [planNext("92902197", "2026-11-22T09:00:00Z")] : serviceTypeId === "1600" ? [planNext("93000001", "2026-11-21T17:00:00Z")] : [], more: false }),
    });
    const pick = await bridge.pickService();
    expect(pick.services.map(s => s.name)).toEqual(["Saturday Night", "Sunday Morning", "Christmas Eve"]);
    expect(pick.services[0]!.next!.times).toEqual([]);
    expect(calls.map(c => c.command)).toEqual(["pick_service", "list_service_types", "list_upcoming_plans", "list_upcoming_plans", "list_upcoming_plans"]);
  });

  it("a refused read is passed on, not hidden behind the fallback", async () => {
    const { bridge } = fakeNative({ pick_service: () => { throw { "sunday-choices": "denied" }; } });
    await expect(bridge.pickService()).rejects.toEqual({ "sunday-choices": "denied" });
  });

  it("cleans names and drops what isn't an id or a date", () => {
    const pick = parsePick({ services: [{ id: "1500", name: "Sunday‮ Morning\n", next: { id: "x", sort_date: "2026-11-22T09:00:00Z" } }, { id: "abc" }], time_zone: "Bad Zone!" });
    expect(pick).toEqual({ services: [{ id: "1500", name: "Sunday Morning", next: null, problem: null }], time_zone: null, more: false });
  });

  it("progress carries a stage, start or done, and a count only", () => {
    expect(parseProgress({ stage: "people", state: "done", count: 31, name: "Avery" })).toEqual({ stage: "people", done: true, count: 31 });
    expect(parseProgress({ stage: "elsewhere", state: "start" })).toBeNull();
  });

  it("key verdicts are closed words; nothing else comes back", () => {
    expect(parseKeyResult({ verdict: "wrong-kind", provider: "openai", looks_like: "anthropic", key: "sk-ant-secret" })).toEqual({ verdict: "wrong-kind", looks_like: "anthropic" });
    expect(parseKeyResult({ verdict: "Incorrect API key provided: sk-abc" })).toEqual({ verdict: "unavailable" });
    // Native re-check NM2 and Low 3: another service's secret, and an OpenRouter key offered to a company's card.
    expect(parseKeyResult({ verdict: "not-an-ai-key", provider: "openai", looks_like: null })).toEqual({ verdict: "not-an-ai-key" });
    expect(parseKeyResult({ verdict: "wrong-kind", provider: "openai", looks_like: "openrouter" })).toEqual({ verdict: "wrong-kind", looks_like: "openrouter" });
    expect(parseKeyResult({ verdict: "wrong-kind", provider: "openai", looks_like: "somewhere-else" })).toEqual({ verdict: "wrong-kind" });
    expect(JSON.stringify(parseKeyResult({ verdict: "refused", detail: "sk-live-123" }))).not.toContain("sk-");
  });

  it("a key command native doesn't have yet says so, so the page offers the clipboard", async () => {
    const { bridge } = fakeNative({ own_key_paste: { verdict: "works", provider: "openai", looks_like: null, status: { configured: true, route: "own", label: "ChatGPT" } } });
    expect((await bridge.enterKey({ provider: "openai" })).verdict).toBe("unavailable");
    expect((await bridge.pasteKey({ provider: "openai" })).verdict).toBe("works");
  });

  it("the offer is open only in its exact shape", () => {
    expect(parseOffer({ open: true, plan: "personal", price_text: "$19 a month", answers_text: "About 400 answers a month" })).toEqual({ open: true, price_text: "$19 a month", answers_text: "About 400 answers a month", reason: null });
    expect(parseOffer({ open: true, plan: "personal", price_text: "<b>$19</b>", answers_text: "About 400 answers a month" }).open).toBe(false);
    expect(parseOffer({ open: false, reason: "closed" }).open).toBe(false);
    expect(parseOffer(null).open).toBe(false);
  });

  it("setup_check is read into closed codes", () => {
    expect(parseSetupCheck({ planning_center: "connected", church: "Fictional Grace Church", checked_at_ms: 1, service: "watching", ai: "ready", ai_route: "own",
      ai_provider: "openai", notices: "allowed", start_with_mac: "on", report: "pc: connected" })).toMatchObject({ planning_center: "connected", ai_provider: "openai" });
    expect(parseSetupCheck({ planning_center: "great" })).toBeNull();
  });

  it("reads the corrected provider data: verified only when native says so, the notes the guide needs, no invented figures", () => {
    const [openai, anthropic, gemini] = parseProviders([
      { id: "openai", name: "ChatGPT", company: "OpenAI", tag: "easiest", model: "gpt-6-luna", price_per_million: { input: 0.1, output: 0.5 }, min_topup: null, typical_month: null,
        retention_line: "OpenAI doesn't train its models on what apps send through a key, and keeps it for up to 30 days to watch for abuse.", free_plan: false,
        free_plan_not_for_church_data: false, free_plan_line: null, key_note: null, checked_on: "2026-11-17", verified_live: true },
      { id: "anthropic", name: "Claude", company: "Anthropic", tag: null, model: "claude-haiku-5-5", min_topup: null, typical_month: null, retention_line: "x", free_plan: false,
        key_note: "When you create the key, choose a workspace for it, and choose Never for when it expires unless your church's policy says otherwise.", checked_on: "2026-11-17" },
      { id: "gemini", name: "Gemini", company: "Google", tag: null, model: "gemini-3.5-flash-lite", min_topup: "$5", typical_month: null, retention_line: "x", free_plan: true,
        free_plan_not_for_church_data: true, free_plan_line: "On the free plan, Google may use what the app sends to improve its products, and people at Google may read it.", checked_on: "2026-11-17", verified_live: "yes" },
    ]);
    expect(openai).toMatchObject({ verified: true, min_topup: null, typical_month: null, key_note: null });
    // Only a literal true is verified: absent, false or anything else is not.
    expect(anthropic).toMatchObject({ verified: false, key_note: expect.stringContaining("choose a workspace") });
    expect(gemini).toMatchObject({ verified: false, min_topup: "$5", free_plan_not_for_church_data: true, free_plan_line: expect.stringContaining("people at Google may read it") });
  });

  it("knows the new key verdicts and the paid connect that heard nothing back", () => {
    expect(parseKeyResult({ verdict: "needs-workspace" }).verdict).toBe("needs-workspace");
    expect(parseKeyResult({ verdict: "wrong-address" }).verdict).toBe("wrong-address");
    expect(paidEnd("not-finished")).toBe("not-finished");
    expect(paidEnd("something else")).toBe("unreachable");
  });

  it("tells a closed offer from one Ozzie couldn't reach", () => {
    expect(parseOffer({ open: false, reason: "unreachable" })).toMatchObject({ open: false, reason: "unreachable" });
    expect(parseOffer({ open: false, reason: "closed" })).toMatchObject({ open: false, reason: "closed" });
    expect(parseOffer(null)).toMatchObject({ open: false, reason: "unreachable" });
  });

  it("each local app's own hint for starting it, and the account's pause end when the server gives one", () => {
    const found = parseLocal({ apps: [{ app: "lm-studio", installed: true, running: false, start_hint: "LM Studio's server doesn't start by itself. In LM Studio, open the Developer tab and turn on Start server, then press Look again.", models: [] }] });
    expect(found.apps[1]!.start_hint).toContain("Developer tab");
    expect(found.apps[0]!.start_hint).toBeNull();
    expect(pausedUntil({ paused_until: "2026-11-18T00:00:00Z" })).toBe("2026-11-18T00:00:00Z");
    expect(pausedUntil({ paused_until: "soon" })).toBeNull();
  });

  it("No AI for now and Remove my key are their own commands", async () => {
    const { bridge, calls } = fakeNative({ set_no_ai: { configured: false, route: "none", label: "" }, remove_own_key: { removed: "none", status: { configured: false, route: "none", label: "" } } });
    expect((await bridge.setNoAi()).route).toBe("none");
    expect((await bridge.removeOwnKey()).removed).toBe("none");
    expect(calls.map(c => c.command)).toEqual(["set_no_ai", "remove_own_key"]);
  });

  it("reads which companies' keys are kept as closed ids only, and null when native can't say (live, 2026-11-18)", async () => {
    expect(parseSaved(["openai", "anthropic", "gemini", "other"])).toEqual(["openai", "anthropic", "gemini", "other"]);
    expect(parseSaved([])).toEqual([]);
    // Anything but the closed ids (a host, a key's text, a name) is not read as a list at all.
    const leak = ["sk-", "proj-fictional0canary"].join("");
    for (const v of [["openai", "api.example.com"], [leak], [{ id: "openai" }], "openai", null, { companies: ["openai"] }, Array(21).fill("other")]) {
      expect(parseSaved(v)).toBeNull();
    }
    const { bridge, calls } = fakeNative({ own_key_saved: ["gemini", "openai"] });
    expect(await bridge.savedKeys()).toEqual(["gemini", "openai"]);
    expect(calls).toEqual([{ command: "own_key_saved", args: {} }]);
    // An older native side without the command: not known.
    expect(await fakeNative({}).bridge.savedKeys()).toBeNull();
  });
  it("reads the three models Ozzie can set up as closed words and numbers, and offers none native didn't say fits (owner, 2026-11-18)", () => {
    const found = parseLocal({ free_bytes: 30_000_000_000, advice: "too-small", catalogue: [
      { size: "small", id: "qwen3:4b", size_bytes: 2_500_000_000, fits: true, offered: false, recommended: false, downloaded: false, set_up: false, disk: "enough", downloaded_by_ozzie: false, note: "x" },
      { size: "medium", id: "qwen3:8b", size_bytes: 5_225_388_164, fits: "yes", offered: "yes", recommended: true, downloaded: true, set_up: true, disk: "lots", downloaded_by_ozzie: true },
      { size: "huge", id: "gpt-oss:20b", size_bytes: 13_780_173_839, fits: true },
      { size: "large", id: "bad id with spaces", size_bytes: 1, fits: true },
    ] });
    expect(found.free_bytes).toBe(30_000_000_000);
    expect(found.advice).toBe("too-small");
    expect(found.catalogue).toEqual([
      { size: "small", id: "qwen3:4b", bytes: 2_500_000_000, fits: true, offered: false, recommended: false, downloaded: false, set_up: false, disk: "enough", downloaded_by_ozzie: false },
      // Only a literal true fits or is offered; a disk word native doesn't use is unknown.
      { size: "medium", id: "qwen3:8b", bytes: 5_225_388_164, fits: false, offered: false, recommended: true, downloaded: true, set_up: true, disk: "unknown", downloaded_by_ozzie: true },
    ]);
    // The advice words native gives today; the old ones ("slow", "small") are no longer native's.
    expect(parseLocal({ advice: "slow" }).advice).toBeNull();
    expect(parseLocal({ advice: "small" }).advice).toBeNull();
    // An older native side: no rows, so the page keeps today's path.
    expect(parseLocal({ apps: [] }).catalogue).toEqual([]);
    expect(parseLocal(null)).toMatchObject({ free_bytes: null, catalogue: [] });
  });

  it("reads a download's progress as numbers and closed words only, with the check's verdict only once it is done", () => {
    const working = { model: "qwen3:8b", phase: "downloading", done_bytes: 9e9, total_bytes: 5_225_388_164, end: null, check: null, said: "pulling a3de86cd1c13" };
    expect(parseModelProgress(working)).toEqual({ model: "qwen3:8b", phase: "downloading", done_bytes: 5_225_388_164, total_bytes: 5_225_388_164, end: null, check: null });
    expect(parseModelProgress({ ...working, phase: "pulling" })).toBeNull();
    expect(parseModelProgress({ ...working, model: "qwen3:8b; rm" })).toBeNull();
    expect(parseModelProgress({ ...working, done_bytes: -1 })).toBeNull();
    // Numbers past what the page shows are shown as the most, never dropped; and an ending always gets through, whatever
    // its numbers say, so the page is never left at work (review L-3).
    expect(parseModelProgress({ ...working, done_bytes: 2 ** 60, total_bytes: 2 ** 60 })).toMatchObject({ done_bytes: 2 ** 50, total_bytes: 2 ** 50 });
    expect(parseModelProgress({ ...working, done_bytes: "lots", end: "stalled" })).toMatchObject({ end: "stalled", done_bytes: 0 });
    expect(parseModelProgress({ ...working, total_bytes: -5, done_bytes: Number.NaN, end: "failed" })).toMatchObject({ end: "failed", done_bytes: 0, total_bytes: 0 });
    expect(parseModelProgress({ ...working, done_bytes: Number.POSITIVE_INFINITY })).toBeNull();
    // An ending native has no word for is said as a failure, never shown as Ollama wrote it.
    expect(parseModelProgress({ ...working, end: "write: no space left on device" })?.end).toBe("failed");
    const done = parseModelProgress({ ...working, phase: "checking", end: "done", check: { verdict: "answers", seconds: 31, small_room: false, status: { label: "x" } } });
    expect(done?.check).toEqual({ verdict: "answers", seconds: 31 });
    expect(parseModelProgress({ ...working, end: "cancelled", check: { verdict: "answers" } })?.check).toBeNull();
    expect(MODEL_EVENT).toBe("ozzie:local-model");
  });

  it("starts, follows, stops and removes a download by the catalogue id only, and says why one couldn't start", async () => {
    const { bridge, calls, emit } = fakeNative({
      local_model_download: ({ model }: Record<string, unknown>) => { if (model !== "qwen3:8b") throw "not-in-catalogue"; return { model, phase: "starting", done_bytes: 0, total_bytes: 5_225_388_164, end: null, check: null }; },
      local_model_progress: null, local_model_cancel: true, local_model_remove: { removed: "removed", route_cleared: false },
    });
    expect(await bridge.downloadModel("qwen3:8b")).toMatchObject({ progress: { phase: "starting" } });
    expect(await bridge.downloadModel("llama3.2")).toEqual({ refused: "not-in-catalogue" });
    expect(await bridge.modelProgress()).toBeNull();
    const heard: unknown[] = [];
    const stop = bridge.onModelProgress(p => heard.push(p.phase));
    await Promise.resolve();
    emit(MODEL_EVENT, { model: "qwen3:8b", phase: "verifying", done_bytes: 1, total_bytes: 2, end: null, check: null });
    emit(MODEL_EVENT, { model: "qwen3:8b", phase: "elsewhere" });
    stop();
    emit(MODEL_EVENT, { model: "qwen3:8b", phase: "finishing", done_bytes: 1, total_bytes: 2, end: null, check: null });
    expect(heard).toEqual(["verifying"]);
    await bridge.stopDownload();
    expect(await bridge.removeModel("qwen3:8b")).toEqual({ removed: "removed", routeCleared: false });
    expect(calls.map(c => c.command)).toEqual(["local_model_download", "local_model_download", "local_model_progress", "local_model_cancel", "local_model_remove"]);
    // An older native side: the download says it couldn't start; removing says it failed; nothing is under way.
    const older = fakeNative({}).bridge;
    expect(await older.downloadModel("qwen3:8b")).toEqual({ refused: "unavailable" });
    expect(await older.modelProgress()).toBeNull();
    expect(await older.removeModel("qwen3:8b")).toEqual({ removed: "failed", routeCleared: false });
  });
});
