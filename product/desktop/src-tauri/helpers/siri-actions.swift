// Ozzie's Siri actions (App Intents, ADR 0007): "Are my services covered" and opening Ozzie's Today and Services pages, offered
// to Siri, Spotlight and the Shortcuts app with no setup and no "Allow Running Scripts". build.rs builds them with
// xcodebuild (intents/OzzieIntents.xcodeproj) into Ozzie.app/Contents/Extensions/OzzieIntents.appex: an App Intents
// extension, its own small process that never opens Ozzie's window, inside the App Sandbox with a read-only exception
// for exactly two files (Entitlements-intents.plist): the copy for Shortcuts and its marker.
//
// The answering is shortcuts-answer.swift, the same code the ozzie-shortcuts helper runs over the same copy and switch:
// "Are my services covered" asks it "sunday", the helper's own question, and says what comes back. The two pages open with
// the ozzie:// links the app already takes (shortcuts.rs), in the Ozzie this extension came with, and only while the
// switch is on; otherwise the action says it's turned off, in the helper's words.
//
// Inside the sandbox HOME is the extension's own folder, so the account's home comes from the user database. Nothing
// here reads Planning Center, calls a model, reaches a network, starts a process or writes a file.
import AppIntents
import AppKit
import Darwin
import Foundation

/// The account's home folder (the sandbox's file exception is relative to it).
func accountHome() -> String? {
    guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else { return nil }
    return String(cString: dir)
}

/// What a Siri action says when it can't do what was asked: the sentence Shortcuts shows and Siri speaks.
struct SaidInstead: Error, CustomLocalizedStringResourceConvertible {
    let sentence: String
    var localizedStringResource: LocalizedStringResource { "\(sentence)" }
}

/// Said when a page couldn't be opened.
let cannotOpen = "Ozzie couldn't open that page. Open Ozzie, or install it again."

enum SiriActions {
    /// The pages an action opens, by their ozzie:// link (shortcuts.rs LINKS).
    enum Page {
        case today, sunday
        var link: URL {
            switch self {
            case .today: return URL(string: "ozzie://today")!
            case .sunday: return URL(string: "ozzie://sunday")!
            }
        }
    }

    /// Opening a page: its link while the switch is on, otherwise the sentence said instead.
    enum Opening: Equatable {
        case link(URL)
        case said(String)
    }

    /// What "Are my services covered" says from the copy in `home`: the helper's answer to "sunday". Nil when none came back.
    static func sundayAnswer(home: String) -> String? {
        OzzieAnswers()?.answer("sunday", home: home)
    }

    /// Whether `page` opens for `home` (only while the switch is on), or what is said instead.
    static func opening(_ page: Page, home: String) -> Opening {
        guard let answers = OzzieAnswers() else { return .said(cannotAnswer) }
        return answers.isOn(home: home) ? .link(page.link) : .said(answers.offSentence)
    }

    /// The Ozzie an extension at `appex` came with: Ozzie.app/Contents/Extensions/OzzieIntents.appex, three folders up.
    static func ozzie(of appex: URL) -> URL {
        appex.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    /// Opens `page` in this Ozzie, bringing it forward; throws the sentence to say when it doesn't open.
    static func openPage(_ page: Page) async throws {
        guard let home = accountHome() else { throw SaidInstead(sentence: cannotAnswer) }
        switch opening(page, home: home) {
        case .said(let sentence):
            throw SaidInstead(sentence: sentence)
        case .link(let link):
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            do {
                _ = try await NSWorkspace.shared.open([link], withApplicationAt: ozzie(of: Bundle.main.bundleURL), configuration: configuration)
            } catch {
                throw SaidInstead(sentence: cannotOpen)
            }
        }
    }
}

struct IsSundayCoveredIntent: AppIntent {
    static let title: LocalizedStringResource = "Are my services covered"
    /// Never answered or opened from a locked Mac (review I, L2).
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let description = IntentDescription("Says how your services stand from Ozzie's last check on this Mac, and when that check was made. Ozzie's window doesn't open.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let home = accountHome(), let said = SiriActions.sundayAnswer(home: home) else {
            throw SaidInstead(sentence: cannotAnswer)
        }
        return .result(value: said, dialog: IntentDialog(stringLiteral: said))
    }
}

struct OpenSundayPageIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Ozzie's Services page"
    /// Never answered or opened from a locked Mac (review I, L2).
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let description = IntentDescription("Opens Ozzie to the Services page.")

    func perform() async throws -> some IntentResult {
        try await SiriActions.openPage(.sunday)
        return .result()
    }
}

struct OpenTodayPageIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Ozzie's Today page"
    /// Never answered or opened from a locked Mac (review I, L2).
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let description = IntentDescription("Opens Ozzie to the Today page.")

    func perform() async throws -> some IntentResult {
        try await SiriActions.openPage(.today)
        return .result()
    }
}

/// What Siri and Spotlight offer with no setup. Every phrase names the app, as Siri requires.
struct OzzieShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: IsSundayCoveredIntent(),
            // The page was renamed Services (owner decision 2026-11-19); the earlier phrases still work for anyone who learned them.
            phrases: ["Are my services covered in \(.applicationName)", "Ask \(.applicationName) if my services are covered", "Ask \(.applicationName) about my services",
                      "Is Sunday covered in \(.applicationName)", "Ask \(.applicationName) if Sunday is covered", "Ask \(.applicationName) about Sunday"],
            shortTitle: "Are my services covered",
            systemImageName: "checkmark.circle"
        )
        AppShortcut(
            intent: OpenSundayPageIntent(),
            phrases: ["Open Services in \(.applicationName)", "Show my services in \(.applicationName)", "Open Sunday in \(.applicationName)"],
            shortTitle: "Services page",
            systemImageName: "calendar"
        )
        AppShortcut(
            intent: OpenTodayPageIntent(),
            phrases: ["Open Today in \(.applicationName)", "Show Today in \(.applicationName)"],
            shortTitle: "Today page",
            systemImageName: "sun.max"
        )
    }
}
