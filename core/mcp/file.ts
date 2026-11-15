// Where the shared check lives, and the one read of it. Read-only: opened O_RDONLY without following a link and
// without waiting (O_NONBLOCK, so a named pipe put in its place can't hang the server), then a regular file only, at
// most MAX_SHARED_BYTES; anything else reads as no file. Only while sharing is on: native's marker (ON_FILE) must be a
// regular file beside the copy, before and after the read, so a copy left behind when sharing was turned off is never
// shown. Nothing is ever written. The helper bundled with Ozzie (helpers/share.swift) reads it exactly the same way.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_SHARED_BYTES, ON_FILE, SHARED_FILE } from "./snapshot.js";

/** Ozzie's app data folder on a Mac (the desktop app's identifier), or OZZIE_SHARED_CHECK when it is set. */
export function sharedCheckPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const set = env["OZZIE_SHARED_CHECK"]?.trim();
  return set ? set : join(homedir(), "Library", "Application Support", "church.ozzie.desktop", SHARED_FILE);
}

/** Whether sharing is on for the copy at `path`: native's marker in its folder (as written, not tidied) is a regular file, not a link. */
function sharingOn(path: string): boolean {
  try { return lstatSync(`${dirname(path)}/${ON_FILE}`).isFile(); } catch { return false; }
}

/**
 * The file's text, or null when sharing is off, or the file is missing, not a regular file (a pipe, a device, a folder),
 * a link, or too large.
 */
export function readShared(path: string): string | null {
  if (!sharingOn(path)) return null;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0)); } catch { return null; }
  let text: string | null = null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SHARED_BYTES) return null;
    const buffer = Buffer.alloc(MAX_SHARED_BYTES + 1);
    let length = 0, n: number;
    while ((n = readSync(fd, buffer, length, buffer.length - length, null)) > 0) { length += n; if (length > MAX_SHARED_BYTES) return null; }
    text = buffer.subarray(0, length).toString("utf8");
  } catch { return null; } finally { closeSync(fd); }
  // Turned off while it was being read: native removes the marker first, then the copy.
  return sharingOn(path) ? text : null;
}
