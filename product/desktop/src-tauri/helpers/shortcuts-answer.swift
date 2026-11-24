// What Siri and Shortcuts hear when they ask Ozzie, shared by Ozzie's two ways of answering them: the ozzie-shortcuts
// helper a shortcut's Run Shell Script step runs (shortcuts.swift, ADR 0006) and Ozzie's Siri actions (siri-actions.swift,
// ADR 0007). Both are built from this file, so there is one way in: the answers of core/mcp/shortcuts.ts
// (core/mcp/shortcuts-embedded.ts, built by `pnpm build:shortcuts`) run in the Mac's own JavaScriptCore from a copy
// linked into the binary that runs them (section __TEXT,__ozzie_answers; build.rs and intents/OzzieIntents.xcodeproj).
//
// What this file does, and nothing else:
// - checks whether "Let Siri and Shortcuts ask Ozzie" is on: native's marker (shortcuts_check.rs ON_FILE) in Ozzie's
//   data folder is a regular file, never a link;
// - only while it is on, reads the copy for Shortcuts there as file.ts reads the shared check: the marker before and
//   after the read; opened read-only, without following a link and without waiting (a named pipe in its place reads
//   as no file); a regular file of at most MAX_SHARED_BYTES;
// - hands the read to the script and returns what it says.
// It reads no environment variable (the caller says whose home folder), opens no network connection, starts no process
// and writes no file. Nothing evaluates what a shortcut passes. JavaScriptCore runs without JIT, so no hardened-runtime
// exception is needed.
import Darwin
import Foundation
import JavaScriptCore
import MachO

/// What Shortcuts and Siri show the leader when Ozzie can't answer at all: one plain sentence, whatever went wrong inside.
let cannotAnswer = "Ozzie couldn't answer. Open Ozzie, or install it again."

/// Native's marker is a regular file, not a link.
func isRegularFile(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && info.st_mode & S_IFMT == S_IFREG
}

/// file.ts readShared: the file's text, or nil when it is missing, not a regular file (a pipe, a device, a folder), a
/// link, or larger than `limit` bytes. Opened read-only; nothing is ever written.
func readCopy(_ path: String, limit: Int) -> String? {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= off_t(limit) else { return nil }
    var buffer = [UInt8](repeating: 0, count: limit + 1)
    var length = 0
    while length <= limit {
        let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress! + length, limit + 1 - length) }
        if n < 0 && errno == EINTR { continue }
        if n < 0 { return nil }
        if n == 0 { break }
        length += n
    }
    return length > limit ? nil : String(decoding: buffer[..<length], as: UTF8.self)
}

/// The answers linked into this binary, loaded in a fresh JavaScriptCore context.
struct OzzieAnswers {
    private let context: JSContext
    private let answers: JSValue
    private let maxCopy: Int
    private let copyFile: String
    private let onFile: String
    /// What is said while the switch is off (shortcuts.ts OFF).
    let offSentence: String

    /// Nil when the answers aren't linked in, JavaScriptCore can't start, or the script didn't load whole.
    init?() {
        var size: UInt = 0
        let header = #dsohandle.assumingMemoryBound(to: mach_header_64.self)
        guard let bytes = getsectiondata(header, "__TEXT", "__ozzie_answers", &size), size > 0 else { return nil }
        let script = String(decoding: UnsafeBufferPointer(start: bytes, count: Int(size)), as: UTF8.self)
        guard let context = JSContext() else { return nil }
        context.evaluateScript(script)
        guard context.exception == nil, let answers = context.objectForKeyedSubscript("OzzieShortcuts"), answers.isObject else { return nil }
        let maxCopy = Int(answers.objectForKeyedSubscript("MAX_SHARED_BYTES").toInt32())
        let copyFile = answers.objectForKeyedSubscript("SHORTCUTS_FILE").toString() ?? ""
        let onFile = answers.objectForKeyedSubscript("SHORTCUTS_ON_FILE").toString() ?? ""
        let off = answers.objectForKeyedSubscript("OFF").toString() ?? ""
        // The copy's names and limits, as the script says them.
        guard maxCopy > 0, !copyFile.isEmpty, !copyFile.contains("/"), onFile.hasPrefix("."), !onFile.contains("/"), !off.isEmpty else {
            return nil
        }
        (self.context, self.answers, self.maxCopy, self.copyFile, self.onFile, self.offSentence) = (context, answers, maxCopy, copyFile, onFile, off)
    }

    /// Ozzie's data folder in `home`. The test copy of Ozzie's helper (build.rs, `-D OZZIE_TEST_COPY`) reads the test
    /// copy's own folder, never the real app's; the Siri actions are never built for the test copy.
    private func folder(_ home: String) -> String {
        #if OZZIE_TEST_COPY
        return (home as NSString).appendingPathComponent("Library/Application Support/church.ozzie.desktop.test")
        #else
        return (home as NSString).appendingPathComponent("Library/Application Support/church.ozzie.desktop")
        #endif
    }

    /// Whether the leader has "Let Siri and Shortcuts ask Ozzie" on: native's marker in `home` is a regular file.
    func isOn(home: String) -> Bool {
        isRegularFile((folder(home) as NSString).appendingPathComponent(onFile))
    }

    /// What Ozzie says to `question`, from the copy in `home`; nil when no answer came back.
    func answer(_ question: String, home: String) -> String? {
        let marker = (folder(home) as NSString).appendingPathComponent(onFile)
        let copy = (folder(home) as NSString).appendingPathComponent(copyFile)
        let limit = maxCopy
        /// The copy only while the switch is on, before and after the read (native removes the marker first, then the copy).
        let readBlock: @convention(block) () -> Any = {
            guard isRegularFile(marker), let text = readCopy(copy, limit: limit), isRegularFile(marker) else { return NSNull() }
            return text
        }
        let answered = answers.objectForKeyedSubscript("answer").call(withArguments: [
            question, isRegularFile(marker), unsafeBitCast(readBlock, to: AnyObject.self),
            Date().timeIntervalSince1970 * 1000, TimeZone.current.identifier,
        ])
        guard context.exception == nil, let answered, answered.isString, let text = answered.toString(), !text.isEmpty else { return nil }
        return text
    }
}
