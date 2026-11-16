// ozzie-calendar: the leader's own calendars on this Mac (Apple Calendar, with any iCloud, Google or Exchange
// accounts added to it), read with EventKit for Today. Read-only.
//
// `ozzie-calendar status` reports what macOS has decided about calendar access, without asking the person anything:
// {"access": "full" | "not-determined" | "denied" | "restricted" | "write-only"}.
//
// `ozzie-calendar ask` asks macOS for access only if it has never asked (macOS shows its own question once; a "no" is
// respected and never asked around), then reports as `status` does. Reading needs full access on macOS 14 and later.
//
// `ozzie-calendar calendars` reports {"access": …, "calendars": [{"id", "title", "account"}]}; the list only with
// full access. The leader chooses which of these Ozzie reads.
//
// `ozzie-calendar events` reads {"from": instant, "to": instant, "calendars": [id, …]} from stdin (at most 15 days and
// 50 calendars) and reports {"access": …, "events": [{"calendar", "id", "title", "location", "start", "end",
// "all_day", "status", "free"}], "truncated": bool}. A timed event's start and end are UTC instants; an all-day
// event's are this Mac's local dates, the end exclusive. At most 1,000 events.
//
// Read-only: nothing here creates, changes or deletes an event, a calendar or a reminder (src/calendars.rs checks this
// source for any such call). Of each event it reads only the calendar, title, place, time, status and whether it
// blocks time: never notes, attendees, the organizer, links or alarms. Calendar text often holds people's names, so
// it goes only to Ozzie on this Mac, over this program's stdout; nothing is written to disk, logged or sent anywhere,
// and Ozzie runs it with no network (src/calendars.rs CALENDAR_POLICY). Failures are exit codes, never content.
import EventKit
import Foundation

enum Exit: Int32 { case usage = 64, invalidInput = 65, failed = 70 }
func fail(_ code: Exit) -> Never { exit(code.rawValue) }

let maxDays: TimeInterval = 15 * 86_400
let maxCalendars = 50
let maxEvents = 1000
let maxText = 300
let maxInput = 64 * 1024

func send(_ object: [String: Any]) -> Never {
    guard let line = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { fail(.failed) }
    FileHandle.standardOutput.write(line + Data([10]))
    exit(0)
}

func access() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return "full"
    case .writeOnly: return "write-only"
    case .notDetermined: return "not-determined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    @unknown default: return "denied"
    }
}

/// Text from a calendar, cut to `maxText` characters; Ozzie makes it plain text again before showing it.
func short(_ text: String?) -> String? {
    guard let text, !text.isEmpty else { return nil }
    return String(text.prefix(maxText))
}

let instant: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()
let instantWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
func parseInstant(_ value: Any?) -> Date? {
    guard let text = value as? String, text.count <= 40 else { return nil }
    return instant.date(from: text) ?? instantWithFraction.date(from: text)
}
var localCalendar = Calendar(identifier: .gregorian)
localCalendar.timeZone = TimeZone.current
let localDay: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.calendar = localCalendar
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 1, let mode = arguments.first else { fail(.usage) }

switch mode {
case "status":
    send(["access": access()])

case "ask":
    DispatchQueue.global().async {
        if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
            let asked = DispatchSemaphore(value: 0)
            EKEventStore().requestFullAccessToEvents { _, _ in asked.signal() }
            asked.wait()
        }
        send(["access": access()])
    }
    dispatchMain()

case "calendars":
    guard access() == "full" else { send(["access": access()]) }
    let calendars = EKEventStore().calendars(for: .event).prefix(200).map { calendar -> [String: Any] in
        var item: [String: Any] = ["id": calendar.calendarIdentifier, "title": short(calendar.title) ?? ""]
        if let account = short(calendar.source?.title) { item["account"] = account }
        return item
    }
    send(["access": "full", "calendars": Array(calendars)])

case "events":
    var input = Data()
    while input.count <= maxInput {
        let chunk = FileHandle.standardInput.readData(ofLength: 16 * 1024)
        if chunk.isEmpty { break }
        input.append(chunk)
    }
    guard input.count <= maxInput,
          let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
          let from = parseInstant(request["from"]), let to = parseInstant(request["to"]),
          from < to, to.timeIntervalSince(from) <= maxDays,
          let ids = request["calendars"] as? [String], ids.count <= maxCalendars,
          ids.allSatisfy({ !$0.isEmpty && $0.count <= 256 }) else { fail(.invalidInput) }
    guard access() == "full" else { send(["access": access()]) }
    let store = EKEventStore()
    let wanted = Set(ids)
    let chosen = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
    // No calendar chosen reads nothing: EventKit reads every calendar when given none, which is never asked here.
    guard !chosen.isEmpty else { send(["access": "full", "events": [Any](), "truncated": false]) }
    let found = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: chosen))
        .sorted { $0.startDate < $1.startDate }
    var events: [[String: Any]] = []
    for event in found.prefix(maxEvents) {
        guard let start = event.startDate, let end = event.endDate else { continue }
        var item: [String: Any] = [
            "calendar": event.calendar?.calendarIdentifier ?? "",
            "id": event.eventIdentifier ?? "",
            "title": short(event.title) ?? "",
            "all_day": event.isAllDay,
            "free": event.availability == .free,
        ]
        if let location = short(event.location) { item["location"] = location }
        switch event.status {
        case .canceled: item["status"] = "cancelled"
        case .tentative: item["status"] = "tentative"
        default: item["status"] = "confirmed"
        }
        if event.isAllDay {
            // EventKit ends an all-day event at the last moment of its last day; Ozzie counts whole local days.
            let first = localCalendar.startOfDay(for: start)
            let last = max(first, localCalendar.startOfDay(for: end.addingTimeInterval(-1)))
            guard let after = localCalendar.date(byAdding: .day, value: 1, to: last) else { continue }
            item["start"] = localDay.string(from: first)
            item["end"] = localDay.string(from: after)
        } else {
            item["start"] = instant.string(from: start)
            item["end"] = instant.string(from: end)
        }
        events.append(item)
    }
    send(["access": "full", "events": events, "truncated": found.count > maxEvents])

default:
    fail(.usage)
}
