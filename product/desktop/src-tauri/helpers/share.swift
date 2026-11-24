// ozzie-share: Ozzie's last check for other AI apps on this Mac (core/docs/mcp.md), with no Node. It runs the same
// read-only server as core/mcp (core/mcp/embedded.ts, built by `pnpm build:share`) in the Mac's own JavaScriptCore,
// from a copy that build.rs links into this binary (section __TEXT,__ozzie_server), so the helper is one signed file.
// Another AI app starts it with no arguments and talks to it over stdin and stdout.
//
// What this file does, and nothing else:
// - reads newline-delimited JSON-RPC from stdin and writes each answer as one line to stdout, as core/mcp/server.ts
//   serveStream does: a line longer than MAX_LINE is answered once as invalid and never parsed (one still unfinished
//   past 3 × MAX_LINE bytes is no longer held, and skipped through its newline unread); the last line before end of
//   input is answered too. Batches, parse errors and everything else are the script's. A stdin or stdout that doesn't
//   block is waited on, never read as ended.
// - on each tool call, reads the shared file as core/mcp/file.ts does: OZZIE_SHARED_CHECK, or shared-check.json in
//   Ozzie's data folder; only while native's on-marker beside it is a regular file (sharing on), before and after the
//   read; opened read-only, without following a link and without waiting (a named pipe in its place reads as no
//   file); a regular file of at most MAX_SHARED_BYTES; read again every time.
// It opens no network connection, starts no process and writes no file. The read is handed to the script as its one
// argument from here; the script's global object has only JavaScriptCore's built-ins (console and WebAssembly among
// them, which it never uses), and nothing evaluates what arrives on stdin. JavaScriptCore runs it without JIT, so no
// hardened-runtime exception is needed.
import Darwin
import Foundation
import JavaScriptCore
import MachO

enum Exit: Int32 { case usage = 64, failed = 70 }
func fail(_ code: Exit, _ why: String) -> Never {
    FileHandle.standardError.write(Data("ozzie-share: \(why)\n".utf8))
    exit(code.rawValue)
}

// The two answers this file writes itself, byte for byte what server.ts writes (the helper's tests compare them).
let refused = #"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}}"#
let internalError = #"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}"#

guard CommandLine.arguments.count == 1 else { fail(.usage, "takes no arguments") }

/// The script build.rs linked into this binary.
func embeddedScript() -> String? {
    var size: UInt = 0
    let header = #dsohandle.assumingMemoryBound(to: mach_header_64.self)
    guard let bytes = getsectiondata(header, "__TEXT", "__ozzie_server", &size), size > 0 else { return nil }
    return String(decoding: UnsafeBufferPointer(start: bytes, count: Int(size)), as: UTF8.self)
}

/// Like Node's os.homedir(): HOME when it is set, otherwise the account's home folder.
func homeFolder() -> String {
    if let home = ProcessInfo.processInfo.environment["HOME"], !home.isEmpty { return home }
    guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { return NSHomeDirectory() }
    return String(cString: dir)
}

/// White space as JavaScript's String.prototype.trim sees it (Node trims OZZIE_SHARED_CHECK with it).
let jsWhiteSpace = CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\u{0A}\u{0B}\u{0C}\u{0D}\u{FEFF}\u{2028}\u{2029}"))

/// file.ts sharedCheckPath: OZZIE_SHARED_CHECK when it is set, otherwise Ozzie's app data folder on a Mac. The test copy
/// of Ozzie's helper (build.rs, `-D OZZIE_TEST_COPY`) reads the test copy's own folder, never the real app's.
func sharedCheckPath(_ file: String) -> String {
    let set = ProcessInfo.processInfo.environment["OZZIE_SHARED_CHECK"]?.trimmingCharacters(in: jsWhiteSpace)
    if let set, !set.isEmpty { return set }
    #if OZZIE_TEST_COPY
    return (homeFolder() as NSString).appendingPathComponent("Library/Application Support/church.ozzie.desktop.test/\(file)")
    #else
    return (homeFolder() as NSString).appendingPathComponent("Library/Application Support/church.ozzie.desktop/\(file)")
    #endif
}

/// file.ts sharingOn: native's marker beside the copy (shared_check.rs ON_FILE) is a regular file, not a link.
func sharingOn(_ marker: String) -> Bool {
    var info = stat()
    return lstat(marker, &info) == 0 && info.st_mode & S_IFMT == S_IFREG
}

/// file.ts readShared: the file's text, or nil when it is missing, not a regular file (a pipe, a device, a folder), a
/// link, or larger than `limit` bytes. Opened read-only; nothing is ever written.
func readShared(_ path: String, limit: Int) -> String? {
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

guard let script = embeddedScript() else { fail(.failed, "the server script isn't in this binary") }
guard let context = JSContext() else { fail(.failed, "JavaScriptCore isn't available") }
context.evaluateScript(script)
let loaded = context.objectForKeyedSubscript("OzzieShare")
guard context.exception == nil, let share = loaded, share.isObject else { fail(.failed, "the server script couldn't start") }
let maxLine = Int(share.objectForKeyedSubscript("MAX_LINE").toInt32())
let maxShared = Int(share.objectForKeyedSubscript("MAX_SHARED_BYTES").toInt32())
let sharedFile = share.objectForKeyedSubscript("SHARED_FILE").toString() ?? ""
let onFile = share.objectForKeyedSubscript("ON_FILE").toString() ?? ""
guard maxLine > 0, maxShared > 0, !sharedFile.isEmpty, !sharedFile.contains("/"), onFile.hasPrefix("."), !onFile.contains("/") else {
    fail(.failed, "the server script's limits are missing")
}

let path = sharedCheckPath(sharedFile)
/// file.ts: the marker in the copy's folder, `dirname(path)/ON_FILE`.
let marker = (path.lastIndex(of: "/").map { String(path[...$0]) } ?? "") + onFile
/// The copy only while sharing is on, before and after the read (native removes the marker first, then the copy).
let readBlock: @convention(block) () -> Any = {
    guard sharingOn(marker), let text = readShared(path, limit: maxShared), sharingOn(marker) else { return NSNull() }
    return text
}
let created = share.objectForKeyedSubscript("createServer").call(withArguments: [unsafeBitCast(readBlock, to: AnyObject.self)])
guard context.exception == nil, let server = created, server.isObject else { fail(.failed, "the server script couldn't start") }

signal(SIGPIPE, SIG_IGN)
/// Waits until a stdin or stdout that doesn't block is ready again (EAGAIN, which is EWOULDBLOCK on a Mac).
func waitFor(_ fd: Int32, _ event: Int32) {
    var ready = pollfd(fd: fd, events: Int16(event), revents: 0)
    _ = poll(&ready, 1, -1)
}
/// One answer and its newline on stdout, all of it; a client that has gone away ends the helper.
func write(_ line: String) {
    let bytes = Array((line + "\n").utf8)
    var done = 0
    while done < bytes.count {
        let n = bytes.withUnsafeBytes { Darwin.write(1, $0.baseAddress! + done, bytes.count - done) }
        if n < 0 && errno == EINTR { continue }
        if n < 0 && errno == EAGAIN { waitFor(1, POLLOUT); continue }
        if n <= 0 { exit(0) }
        done += n
    }
}
/// One line of input to the script (server.ts McpServer.line), its answer written back.
func answer<Bytes: Collection>(_ line: Bytes) where Bytes.Element == UInt8 {
    autoreleasepool {
        let reply = server.call(withArguments: [String(decoding: line, as: UTF8.self)])
        if context.exception != nil {
            context.exception = nil
            write(internalError)
        } else if let reply, reply.isString, let text = reply.toString() {
            write(text)
        }
    }
}

// The script measures a whole line in UTF-16 units, as Node does. A line still unfinished past 3 × MAX_LINE bytes is
// longer than MAX_LINE units however it is encoded, so it is refused here without holding more of it.
let longest = 3 * maxLine
var pending: [UInt8] = []
var skipping = false
var chunk = [UInt8](repeating: 0, count: 64 * 1024)
while true {
    let n = chunk.withUnsafeMutableBytes { read(0, $0.baseAddress!, $0.count) }
    if n < 0 && errno == EINTR { continue }
    if n < 0 && errno == EAGAIN { waitFor(0, POLLIN); continue }
    if n <= 0 { break }
    var start = 0
    for i in 0..<n where chunk[i] == UInt8(ascii: "\n") {
        if skipping {
            skipping = false
        } else {
            pending.append(contentsOf: chunk[start..<i])
            answer(pending.last == UInt8(ascii: "\r") ? pending.dropLast() : pending[...])
        }
        pending.removeAll(keepingCapacity: true)
        start = i + 1
    }
    guard !skipping else { continue }
    pending.append(contentsOf: chunk[start..<n])
    if pending.count > longest {
        pending = []
        skipping = true
        write(refused)
    }
}
if !skipping { answer(pending) }
exit(0)
