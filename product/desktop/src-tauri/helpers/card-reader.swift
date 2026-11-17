// ozzie-card-reader: visitor-card text recognition on this Mac with Apple Vision (local and
// non-generative, the only kind of recognition cards may go through).
//
// Reads one PNG, JPEG or HEIC photo from stdin (of a HEIC with several pictures, its primary one only) and writes one JSON line per piece of recognized text to
// stdout: {"t": text, "c": confidence, "x", "y", "w", "h": its box, 0 to 1 from the top left of the
// upright photo}. Ozzie (src/local_tools.rs) puts the pieces back into lines. The photo and its
// text live only in memory for this one run: this program writes nothing to disk, logs nothing
// and sends nothing anywhere. Failures are exit codes only, never card content.
//
// Ozzie runs it two ways, each under its own deny-by-default sandbox with no network:
// - preparing (CARD_PREPARE_POLICY): once per launch, on Ozzie's fixed practice picture, never a
//   card. Apple's recognizer may compile its models into its own two cache folders; that takes a
//   minute or two the first time on a Mac and after a macOS update.
// - reading a card (CARD_READER_POLICY): no file writes at all; the compiled models are read-only. A HEIC photo is
//   read under CARD_HEIC_READER_POLICY, the same and one service more: Apple's video decoder, which decodes it in
//   Apple's own sandbox (by the owner's decision of 2026-11-16).
//
// Of the photo's own details it reads only its type, width, height and orientation: never its location, camera or
// other EXIF details, which stay in the bytes it was given and go nowhere.
import CoreGraphics
import Foundation
import ImageIO
import Vision

enum Exit: Int32 {
    // unreadable: the photo is a picture the reader opens, but it decoded to nothing (or not at all).
    case usage = 64, invalidImage = 65, unreadable = 66, unavailable = 69, failed = 70, tooMuch = 74
}
func fail(_ code: Exit) -> Never { exit(code.rawValue) }

// Same limits as src/local_tools.rs: 8 MB per photo, at most 40 million pixels.
let maxImageBytes = 8 * 1024 * 1024
let maxPixels = 40_000_000
let maxPieces = 512
let maxPieceBytes = 2048
let maxTextBytes = 16 * 1024

guard CommandLine.arguments.count == 1 else { fail(.usage) }

var image = Data()
while image.count <= maxImageBytes {
    let chunk = FileHandle.standardInput.readData(ofLength: 256 * 1024)
    if chunk.isEmpty { break }
    image.append(chunk)
}
guard !image.isEmpty, image.count <= maxImageBytes else { fail(.invalidImage) }

// The types the reader opens: PNG, JPEG, and HEIC (public.heif is a HEIC whose file names no HEVC brand of its own).
// Not public.heics (a sequence), public.avif or anything else.
let readerTypes: Set<String> = ["public.png", "public.jpeg", "public.heic", "public.heif"]
let noCache = [kCGImageSourceShouldCache: false] as CFDictionary
// A HEIC can hold several pictures; the primary one is the photo (0 for PNG and JPEG).
guard let source = CGImageSourceCreateWithData(image as CFData, noCache),
      let type = CGImageSourceGetType(source) as String?,
      readerTypes.contains(type),
      case let index = CGImageSourceGetPrimaryImageIndex(source),
      index < CGImageSourceGetCount(source),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, index, noCache) as? [CFString: Any],
      let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
      let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
      width > 0, height > 0, width <= maxPixels, height <= maxPixels, width * height <= maxPixels else { fail(.invalidImage) }
// Decoded now, once, and kept for the recognizer.
guard let picture = CGImageSourceCreateImageAtIndex(source, index, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
      picture.width > 0, picture.height > 0 else { fail(.unreadable) }
image = Data()

// A picture that decodes to nothing reads as no text at all, which would look like a blank card. A decoder that
// can't run (a HEIC without Apple's video decoder service) fails that way, without an error. So a picture whose every
// pixel is the same, transparent ones included, is refused as unreadable, whatever its type. A small copy is enough
// to tell: a photo of a card is never one flat colour.
func blank(_ picture: CGImage) -> Bool {
    let side = 64
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8,
                                      bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.interpolationQuality = .low
        context.draw(picture, in: CGRect(x: 0, y: 0, width: side, height: side))
        return true
    }
    guard drawn else { return true }
    let first = pixels[0..<4]
    return stride(from: 4, to: pixels.count, by: 4).allSatisfy { pixels[$0..<$0 + 4] == first }
}
guard !blank(picture) else { fail(.unreadable) }
// A phone photo taken upright is often stored sideways with an orientation tag.
let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)
    .flatMap { CGImagePropertyOrientation(rawValue: $0.uint32Value) } ?? .up

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
// Off: card intake keeps the writer's exact wording, and unclear handwriting is flagged, not guessed (owner decisions).
request.usesLanguageCorrection = false
request.automaticallyDetectsLanguage = false
guard (try? request.supportedRecognitionLanguages())?.contains("en-US") == true else { fail(.unavailable) }

struct Piece: Encodable {
    let t: String
    let c: Float
    let x: Double, y: Double, w: Double, h: Double
}
var pieces: [Piece] = []
var textBytes = 0
do {
    try VNImageRequestHandler(cgImage: picture, orientation: orientation, options: [:]).perform([request])
} catch {
    // Never print the error: its description could carry details of the photo.
    fail(.failed)
}
for observation in request.results ?? [] {
    guard let best = observation.topCandidates(1).first else { continue }
    let text = best.string
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
    textBytes += text.utf8.count
    guard text.utf8.count <= maxPieceBytes, textBytes <= maxTextBytes, pieces.count < maxPieces else { fail(.tooMuch) }
    let box = observation.boundingBox
    // Vision measures from the bottom left; Ozzie reads top to bottom.
    pieces.append(Piece(t: text, c: best.confidence, x: Double(box.minX), y: Double(1 - box.maxY),
                        w: Double(box.width), h: Double(box.height)))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
var out = Data()
for piece in pieces {
    guard let line = try? encoder.encode(piece) else { fail(.failed) }
    out.append(line)
    out.append(10)
}
FileHandle.standardOutput.write(out)
exit(0)
