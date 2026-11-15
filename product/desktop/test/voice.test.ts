import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { MAX_QUESTION_CHARS } from "../../../core/src/ask.js";
import { CHECK_WORDS, isVoiceShortcut, listenInto, VOICE_HINT, voiceOff, withWords, type Listened, type Voice } from "../src/voice.js";

/** A stand-in for the native listener: says `words` one at a time, then ends with `end`. */
function fakeVoice(words: string[], end: Listened | Error): Voice & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: async () => { calls.push("status"); return { status: "ready" }; },
    listen: async onWords => {
      calls.push("listen");
      for (const w of words) onWords(w);
      if (end instanceof Error) throw end;
      return end;
    },
    stop: async () => { calls.push("stop"); },
    cancel: async () => { calls.push("cancel"); },
  };
}
const key = (over: Partial<{ key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }>) =>
  ({ key: "l", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...over });

describe("speaking a question into Ask", () => {
  it("fills the box as the words come and leaves the finished words for the person to check", async () => {
    const voice = fakeVoice(["Who could", "Who could cover Greeter"], { status: "heard", text: "Who could cover Greeter?" });
    const shown: string[] = [];
    const after = await listenInto(voice, "", t => shown.push(t));
    expect(shown).toEqual(["Who could", "Who could cover Greeter"]);
    expect(after).toEqual({ text: "Who could cover Greeter?", note: CHECK_WORDS });
    // Listening only fills the box: nothing else was asked of the native side.
    expect(voice.calls).toEqual(["listen"]);
  });

  it("adds the words after what was already typed", async () => {
    expect(withWords("About Sunday,", "  who could   cover Greeter ")).toEqual({ text: "About Sunday, who could cover Greeter", cut: false });
    expect(withWords("About Sunday,  ", "who")).toEqual({ text: "About Sunday, who", cut: false });
    expect(withWords("Typed", "")).toEqual({ text: "Typed", cut: false });
    const after = await listenInto(fakeVoice([], { status: "heard", text: "who could cover Greeter?" }), "About Sunday,", () => {});
    expect(after.text).toBe("About Sunday, who could cover Greeter?");
  });

  it("keeps a long question within the limit and says to check the end", async () => {
    const long = "word ".repeat(150);
    expect(withWords("", long).cut).toBe(true);
    expect(withWords("", long).text).toHaveLength(MAX_QUESTION_CHARS);
    const after = await listenInto(fakeVoice([], { status: "heard", text: long }), "", () => {});
    expect(after.text).toHaveLength(MAX_QUESTION_CHARS);
    expect(after.note).toBe(`Only the first ${MAX_QUESTION_CHARS} characters fit in a question. Check the end, then press Ask.`);
  });

  it("puts back what was typed when nothing was heard, listening was cancelled or it failed", async () => {
    expect(await listenInto(fakeVoice([], { status: "heard", text: "  " }), "Typed", () => {}))
      .toEqual({ text: "Typed", note: "No words came through. Try again, or type your question." });
    // Cancelled (Ask closed): the words so far are dropped.
    expect(await listenInto(fakeVoice(["Private words"], { status: "stopped" }), "Typed", () => {})).toEqual({ text: "Typed", note: null });
    expect(await listenInto(fakeVoice(["Private"], new Error("native")), "Typed", () => {}))
      .toEqual({ text: "Typed", note: "Listening stopped unexpectedly. Nothing was kept. Try again, or type your question." });
    expect((await listenInto(fakeVoice([], { status: "no-microphone" }), "", () => {})).note).toMatch(/No microphone was found/);
  });

  it("turns the button off with a plain reason when this Mac can't listen or the person said no", async () => {
    expect(await listenInto(fakeVoice([], { status: "not-available" }), "", () => {})).toEqual({ text: "", note: null, status: { status: "not-available" } });
    const refused = await listenInto(fakeVoice([], { status: "no-permission", what: "microphone" }), "", () => {});
    expect(refused.status).toEqual({ status: "no-permission", what: "microphone" });
    expect(voiceOff(null)).toBeNull();
    expect(voiceOff({ status: "ready" })).toBeNull();
    expect(voiceOff({ status: "not-available" })).toBe("This Mac can't turn speech into text on its own, so speaking a question is off. Type your question instead.");
    expect(voiceOff({ status: "no-permission", what: "microphone" })).toContain("System Settings › Privacy & Security › Microphone");
    expect(voiceOff({ status: "no-permission", what: "speech" })).toContain("System Settings › Privacy & Security › Speech Recognition");
  });

  it("says in one line that no audio is kept or sent, and uses ⌘⇧L", () => {
    expect(VOICE_HINT).toBe("Speak instead of typing (⌘⇧L). Your words become text on this Mac. No audio is kept or sent.");
    expect(isVoiceShortcut(key({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isVoiceShortcut(key({ key: "L", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isVoiceShortcut(key({ metaKey: true }))).toBe(false);
    expect(isVoiceShortcut(key({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isVoiceShortcut(key({ key: "k", metaKey: true, shiftKey: true }))).toBe(false);
  });
});
