// Speaking a question into Ask, on this Mac only (src-tauri/src/local_tools.rs runs
// src-tauri/helpers/listen.swift). macOS turns the speech into text on the device: the sound is
// never recorded, kept or sent anywhere. The words only fill the Ask box; the person checks them
// and presses Ask themselves. Nothing here ever asks a question on its own.
import { Channel, invoke } from "@tauri-apps/api/core";
import { MAX_QUESTION_CHARS } from "../../../core/src/ask.js";

type Refused = { status: "no-permission"; what: "microphone" | "speech" };
/** Whether Ozzie can listen here. Checking never asks the person anything. */
export type VoiceStatus = { status: "ready" } | { status: "not-available" } | Refused;
/** How one listening ended. `stopped`: Ask closed, so whatever was heard was thrown away. */
export type Listened = { status: "heard"; text: string } | { status: "stopped" } | { status: "not-available" } | Refused | { status: "no-microphone" };

export interface Voice {
  status(): Promise<VoiceStatus>;
  /** Listens until `stop` (or 30 seconds); `onWords` gets the words so far as they come. */
  listen(onWords: (words: string) => void): Promise<Listened>;
  /** The person is done: finish with what was said. */
  stop(): Promise<void>;
  /** Stop now and keep nothing. */
  cancel(): Promise<void>;
}

export const nativeVoice: Voice = {
  status: () => invoke<VoiceStatus>("voice_status_check"),
  listen: onWords => {
    const channel = new Channel<string>();
    channel.onmessage = words => { if (typeof words === "string") onWords(words); };
    return invoke<Listened>("listen_for_question", { onWords: channel });
  },
  stop: () => invoke<void>("stop_listening"),
  cancel: () => invoke<void>("cancel_listening"),
};

/** ⌘⇧L ("listen") starts and stops listening while Ask is open. */
export const VOICE_SHORTCUT = "Meta+Shift+L";
export const isVoiceShortcut = (e: { key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }) =>
  e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "l";

export const VOICE_HINT = "Speak instead of typing (⌘⇧L). Your words become text on this Mac. No audio is kept or sent.";
export const LISTENING_NOTE = "Listening on this Mac. Press the microphone or ⌘⇧L to finish.";
export const CHECK_WORDS = "Check the words, then press Ask.";

/** Why the microphone button is off, in plain words; null while it can be used (or before the check). */
export function voiceOff(status: VoiceStatus | null): string | null {
  if (!status || status.status === "ready") return null;
  if (status.status === "not-available") return "This Mac can't turn speech into text on its own, so speaking a question is off. Type your question instead.";
  return status.what === "microphone"
    ? "Ozzie isn't allowed to use the microphone. To speak a question, turn on Ozzie in System Settings › Privacy & Security › Microphone."
    : "Ozzie isn't allowed to use speech recognition. To speak a question, turn on Ozzie in System Settings › Privacy & Security › Speech Recognition.";
}

/** The Ask box while and after listening: what was typed before, then the words, within the question limit. */
export function withWords(before: string, words: string): { text: string; cut: boolean } {
  const spoken = words.replace(/\s+/g, " ").trim();
  const start = before.trimEnd();
  const text = !spoken ? before : start ? `${start} ${spoken}` : spoken;
  return text.length > MAX_QUESTION_CHARS ? { text: text.slice(0, MAX_QUESTION_CHARS), cut: true } : { text, cut: false };
}

/** What one listening leaves in the Ask box, the line to show under it, and the button's new state if it changed. */
export interface AfterListening { text: string; note: string | null; status?: VoiceStatus }

/**
 * Listens once: the words so far go to `onWords` as they come, and the result is what the Ask box
 * should hold. It only ever fills the box; asking stays with the person.
 */
export async function listenInto(voice: Voice, before: string, onWords: (text: string) => void): Promise<AfterListening> {
  let result: Listened;
  try { result = await voice.listen(words => onWords(withWords(before, words).text)); }
  catch { return { text: before, note: "Listening stopped unexpectedly. Nothing was kept. Try again, or type your question." }; }
  switch (result.status) {
    case "heard": {
      const { text, cut } = withWords(before, result.text);
      if (text === before) return { text, note: "No words came through. Try again, or type your question." };
      return { text, note: cut ? `Only the first ${MAX_QUESTION_CHARS} characters fit in a question. Check the end, then press Ask.` : CHECK_WORDS };
    }
    case "stopped": return { text: before, note: null };
    case "no-microphone": return { text: before, note: "No microphone was found. Connect one and try again, or type your question." };
    case "not-available": return { text: before, note: null, status: { status: "not-available" } };
    case "no-permission": return { text: before, note: null, status: { status: "no-permission", what: result.what } };
  }
}
