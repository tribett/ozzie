// ozzie-listen: a spoken question for Ask, turned into text on this Mac only.
//
// `ozzie-listen --check` reports, without asking the person anything, whether this Mac can
// recognize speech on the device and what macOS has already decided about the microphone and
// speech recognition: {"onDevice": true, "speech": "authorized", "microphone": "not-determined"}.
//
// `ozzie-listen` asks for permission if macOS hasn't asked before, then listens until its stdin
// closes (the person pressed Stop) or 30 seconds pass. It writes JSON lines to stdout:
// {"status": "listening"}, then {"text": what it has heard so far} as it goes, and finally
// {"final": everything it heard}. A problem is {"status": "not-available" | "no-permission" |
// "no-microphone" | "failed"} (no-permission adds "what": "speech" or "microphone").
//
// Recognition runs on this Mac only (requiresOnDeviceRecognition): the audio is never sent to
// Apple or anyone else. Sound goes from the microphone straight into the recognizer in memory and
// is never recorded or written anywhere. Ozzie (src/local_tools.rs) runs this with no network
// and no file writes (LISTEN_POLICY). The words go only to Ozzie's Ask box, for the person to
// check and send themselves; nothing here sends them anywhere.
import AVFoundation
import Foundation
import Speech

let maxListening: TimeInterval = 30
let maxTextBytes = 4096
let output = DispatchQueue(label: "church.ozzie.listen.output")

func send(_ object: [String: Any]) {
    output.sync {
        guard let line = try? JSONSerialization.data(withJSONObject: object) else { return }
        FileHandle.standardOutput.write(line + Data([10]))
    }
}
func stop(_ status: String, _ code: Int32, what: String? = nil) -> Never {
    var report: [String: Any] = ["status": status]
    if let what { report["what"] = what }
    send(report)
    exit(code)
}

func speechPermission() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .notDetermined: return "not-determined"
    case .restricted: return "restricted"
    default: return "denied"
    }
}
func microphonePermission() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .notDetermined: return "not-determined"
    case .restricted: return "restricted"
    default: return "denied"
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
let onDevice = recognizer?.supportsOnDeviceRecognition ?? false

if arguments == ["--check"] {
    send(["onDevice": onDevice, "speech": speechPermission(), "microphone": microphonePermission()])
    exit(0)
}
guard arguments.isEmpty else { stop("failed", 64) }
// Never fall back to Apple's servers: without on-device recognition there is no listening at all.
guard let recognizer, onDevice else { stop("not-available", 69) }

final class Listening {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    let request = SFSpeechAudioBufferRecognitionRequest()
    var task: SFSpeechRecognitionTask?
    var heard = ""
    var ending = false
    let lock = NSLock()

    init(_ recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
    }

    func start() {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { stop("no-microphone", 69) }
        // Each buffer of sound goes straight to the recognizer and is then let go: no recording.
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [request] buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch { stop("no-microphone", 69) }
        task = recognizer.recognitionTask(with: request) { [self] result, error in
            if let result {
                let text = result.bestTranscription.formattedString
                lock.lock()
                heard = text
                lock.unlock()
                if text.utf8.count > maxTextBytes || result.isFinal {
                    finish()
                } else {
                    send(["text": text])
                }
            } else if error != nil {
                // Silence, or recognition ended: whatever was heard so far is the result.
                finish()
            }
        }
        send(["status": "listening"])
    }

    /// The person pressed Stop (or time ran out): stop the microphone, let the recognizer finish
    /// the last words, then report. If it takes more than two seconds, report what was heard.
    func endAudio() {
        lock.lock()
        let already = ending
        ending = true
        lock.unlock()
        if already { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.finish() }
    }

    func finish() {
        engine.stop()
        lock.lock()
        var text = heard
        lock.unlock()
        while text.utf8.count > maxTextBytes { text.removeLast() }
        send(["final": text])
        exit(0)
    }
}

let listening = Listening(recognizer)

DispatchQueue.global().async {
    // Ask only when macOS hasn't asked before; a "no" is respected, never asked around.
    let asked = DispatchSemaphore(value: 0)
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
        SFSpeechRecognizer.requestAuthorization { _ in asked.signal() }
        asked.wait()
    }
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else { stop("no-permission", 77, what: "speech") }
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        AVCaptureDevice.requestAccess(for: .audio) { _ in asked.signal() }
        asked.wait()
    }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
        stop("no-permission", 77, what: "microphone")
    }
    DispatchQueue.main.async {
        listening.start()
        // Stop when Ozzie closes stdin (the person pressed Stop), or after 30 seconds.
        DispatchQueue.global().async {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            DispatchQueue.main.async { listening.endAudio() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + maxListening) { listening.endAudio() }
    }
}
dispatchMain()
