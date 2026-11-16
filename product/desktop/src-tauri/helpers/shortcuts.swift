// ozzie-shortcuts: what Siri and Shortcuts hear when they ask Ozzie (ADR 0006), with no Node. A shortcut's "Run Shell
// Script" action runs it with one question name ("sunday") and speaks or shows what it prints. The answering is
// shortcuts-answer.swift, built into this helper and into Ozzie's Siri actions alike; build.rs links the answers
// script into this binary (section __TEXT,__ozzie_answers), so the helper is one signed file.
//
// What this file adds, and nothing else:
// - takes the question as its one argument (anything else is answered with the script's fixed "only sunday" words);
// - looks for Ozzie's data folder in HOME, like Node's os.homedir();
// - prints the answer and a newline, and exits 0; when it can't answer at all, it writes one plain sentence for
//   Shortcuts to show (`cannotAnswer`) and exits 70.
// It reads no environment variable but HOME, takes nothing from stdin, opens no network connection, starts no process
// and writes no file.
import Darwin
import Foundation

func fail() -> Never {
    FileHandle.standardError.write(Data((cannotAnswer + "\n").utf8))
    exit(70)
}

/// Like Node's os.homedir(): HOME when it is set, otherwise the account's home folder.
func homeFolder() -> String {
    if let home = ProcessInfo.processInfo.environment["HOME"], !home.isEmpty { return home }
    guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { return NSHomeDirectory() }
    return String(cString: dir)
}

@main
enum ShortcutsHelper {
    static func main() {
        // The answers aren't linked in, JavaScriptCore can't start, or the script didn't load.
        guard let answers = OzzieAnswers() else { fail() }
        let arguments = CommandLine.arguments.dropFirst()
        let question = arguments.count == 1 ? arguments.first! : ""
        // No answer came back.
        guard let text = answers.answer(question, home: homeFolder()) else { fail() }
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
        exit(0)
    }
}
