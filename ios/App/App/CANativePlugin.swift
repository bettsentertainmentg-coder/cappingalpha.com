import Foundation
import Capacitor
import Vision
import UIKit

/// CANative — the betslip bridge between the web app and iOS.
///
/// Two jobs, both of which exist so a screenshot never has to leave the phone:
///
///   ocr(image)        Reads a betslip with Apple's Vision framework. Free, offline,
///                     and materially better than the Tesseract.js path the browser
///                     uses, because it returns per-word BOUNDING BOXES as well as
///                     text. A betslip is a two-column layout (selection on the left,
///                     price right-aligned) and plain OCR reading order splits those
///                     onto separate lines; the boxes let the server rebuild the real
///                     visual rows. See linesFromBlocks() in src/betslip_parse.js.
///
///   takeSharedSlip()  Hands over whatever the Share Extension parked in the shared
///                     App Group container, and CLEARS it, so one share is consumed
///                     exactly once. Called on launch and on every resume.
///
/// Nothing here uploads an image. Only the extracted text and boxes are ever posted,
/// and only to our own /api/betslip/parse.
@objc(CANativePlugin)
public class CANativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CANativePlugin"
    public let jsName = "CANative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ocr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeSharedSlip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasSharedSlip", returnType: CAPPluginReturnPromise)
    ]

    /// Must match the App Group on BOTH the app target and the share extension.
    static let appGroup = "group.com.cappingalpha.app"
    static let slipKey = "ca.pendingBetslip"

    // MARK: - OCR

    @objc func ocr(_ call: CAPPluginCall) {
        guard let raw = call.getString("image"), let image = CANativePlugin.decodeImage(raw) else {
            call.reject("No readable image was provided.")
            return
        }
        CANativePlugin.recognize(image: image) { result in
            switch result {
            case .success(let payload):
                call.resolve(payload)
            case .failure(let err):
                call.reject("Could not read that image.", nil, err)
            }
        }
    }

    /// Runs Vision text recognition and returns { text, blocks, width, height }.
    /// Blocks are normalized 0..1 with the ORIGIN AT TOP-LEFT: Vision reports
    /// bottom-left origin, so y is flipped here. Getting that backwards silently
    /// reverses the reading order of the whole slip.
    static func recognize(image: UIImage,
                          completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let cg = image.cgImage else {
            completion(.failure(NSError(domain: "CANative", code: 1,
                                        userInfo: [NSLocalizedDescriptionKey: "No image data"])))
            return
        }

        let request = VNRecognizeTextRequest { request, error in
            if let error = error { completion(.failure(error)); return }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []

            var blocks: [[String: Any]] = []
            var lines: [String] = []

            for obs in observations {
                guard let candidate = obs.topCandidates(1).first else { continue }
                let lineText = candidate.string
                lines.append(lineText)

                // Split the observation into word boxes. Vision gives a bounding box
                // per substring range, which is what makes a right-aligned price
                // attributable to the row it visually sits on.
                var placedWord = false
                var searchStart = lineText.startIndex
                for word in lineText.split(separator: " ") {
                    guard let range = lineText.range(of: String(word), range: searchStart..<lineText.endIndex) else { continue }
                    searchStart = range.upperBound
                    guard let box = try? candidate.boundingBox(for: range) else { continue }
                    let r = box.boundingBox
                    blocks.append([
                        "text": String(word),
                        "x": r.origin.x,
                        "y": 1.0 - r.origin.y - r.height,   // flip to top-left origin
                        "width": r.width,
                        "height": r.height
                    ])
                    placedWord = true
                }
                // Fall back to the whole observation when per-word boxes are refused.
                if !placedWord {
                    let r = obs.boundingBox
                    blocks.append([
                        "text": lineText,
                        "x": r.origin.x,
                        "y": 1.0 - r.origin.y - r.height,
                        "width": r.width,
                        "height": r.height
                    ])
                }
            }

            completion(.success([
                "text": lines.joined(separator: "\n"),
                "blocks": blocks,
                "width": cg.width,
                "height": cg.height
            ]))
        }

        // Accurate over fast: a betslip is read once, by hand, and a misread price
        // is a wrong number in someone's record. usesLanguageCorrection is OFF on
        // purpose, because it "helpfully" rewrites team names and prices.
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        // Words a dictionary will not know but a betslip is full of.
        request.customWords = ["Moneyline", "Parlay", "SGP", "Spread", "Puck", "Totals",
                               "FanDuel", "DraftKings", "BetMGM", "Caesars", "BetRivers",
                               "ESPN", "Fanatics", "PrizePicks", "Underdog"]

        DispatchQueue.global(qos: .userInitiated).async {
            let handler = VNImageRequestHandler(cgImage: cg, orientation: image.cgImageOrientation, options: [:])
            do { try handler.perform([request]) } catch { completion(.failure(error)) }
        }
    }

    static func decodeImage(_ raw: String) -> UIImage? {
        var payload = raw
        if let comma = raw.range(of: ",") , raw.hasPrefix("data:") {
            payload = String(raw[comma.upperBound...])
        }
        guard let data = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }

    // MARK: - Share extension handoff

    @objc func hasSharedSlip(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: CANativePlugin.appGroup) else {
            // Distinguish "nothing was shared" from "the App Group is not configured",
            // otherwise a missing capability looks exactly like an idle app forever.
            call.resolve(["pending": false, "groupAvailable": false])
            return
        }
        call.resolve([
            "pending": defaults.dictionary(forKey: CANativePlugin.slipKey) != nil,
            "groupAvailable": true
        ])
    }

    /// Returns the pending slip and clears it in the same breath, so a share is
    /// consumed exactly once even if the web layer asks twice (launch AND resume
    /// both call this).
    @objc func takeSharedSlip(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: CANativePlugin.appGroup),
              let stored = defaults.dictionary(forKey: CANativePlugin.slipKey) else {
            call.resolve([:])
            return
        }
        defaults.removeObject(forKey: CANativePlugin.slipKey)
        defaults.synchronize()

        var out: [String: Any] = [:]
        if let text = stored["text"] as? String { out["text"] = text }
        if let blocks = stored["blocks"] as? [[String: Any]] { out["blocks"] = blocks }
        if let book = stored["book"] as? String { out["book"] = book }

        // The extension usually OCRs on the spot; when it could not, it leaves the
        // image behind in the container for us to read here instead.
        if let file = stored["imageFile"] as? String,
           let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: CANativePlugin.appGroup) {
            let url = dir.appendingPathComponent(file)
            if let data = try? Data(contentsOf: url) {
                out["image"] = "data:image/png;base64," + data.base64EncodedString()
            }
            try? FileManager.default.removeItem(at: url)
        }
        call.resolve(out)
    }
}

private extension UIImage {
    /// UIImage orientation -> the CGImagePropertyOrientation Vision expects. A
    /// screenshot is always .up, but a photo of a screen is not, and getting this
    /// wrong makes Vision read sideways text as noise.
    var cgImageOrientation: CGImagePropertyOrientation {
        switch imageOrientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
