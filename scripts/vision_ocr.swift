// scripts/vision_ocr.swift — macOS Apple Vision OCR, the SAME engine the iOS app
// uses (CANativePlugin.swift / ShareViewController.swift), pointed at image files.
//
// Purpose: turn any betslip screenshot into exactly the payload the app would
// post to /api/betslip/parse — { text, blocks } with top-left-origin word boxes —
// so downloaded example slips from other sportsbooks become full-fidelity parser
// tests without needing the app or the simulator.
//
// Run:  swift scripts/vision_ocr.swift <image> [image...]
// Output: one JSON object per image on stdout:
//   { "file": ..., "text": ..., "blocks": [ {text,x,y,width,height} ] }
//
// Keep the recognition settings IDENTICAL to the app's (accurate, no language
// correction, en-US, the same custom words) or the fixtures stop representing
// what the device actually produces.

import Foundation
import Vision
import AppKit

let CUSTOM_WORDS = ["Moneyline", "Parlay", "SGP", "Spread", "Puck", "Totals",
                    "FanDuel", "DraftKings", "BetMGM", "Caesars", "BetRivers",
                    "ESPN", "Fanatics", "PrizePicks", "Underdog"]

func ocr(path: String) -> [String: Any] {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ["file": path, "error": "unreadable image"]
    }

    var out: [String: Any] = ["file": path, "width": cg.width, "height": cg.height]
    var lines: [String] = []
    var blocks: [[String: Any]] = []

    let request = VNRecognizeTextRequest { req, err in
        if let err = err { out["error"] = String(describing: err); return }
        for obs in (req.results as? [VNRecognizedTextObservation]) ?? [] {
            guard let cand = obs.topCandidates(1).first else { continue }
            let lineText = cand.string
            lines.append(lineText)
            var placed = false
            var cursor = lineText.startIndex
            for word in lineText.split(separator: " ") {
                guard let range = lineText.range(of: String(word), range: cursor..<lineText.endIndex) else { continue }
                cursor = range.upperBound
                guard let box = try? cand.boundingBox(for: range) else { continue }
                let r = box.boundingBox
                blocks.append(["text": String(word), "x": r.origin.x,
                               "y": 1.0 - r.origin.y - r.height,   // flip to top-left origin
                               "width": r.width, "height": r.height])
                placed = true
            }
            if !placed {
                let r = obs.boundingBox
                blocks.append(["text": lineText, "x": r.origin.x,
                               "y": 1.0 - r.origin.y - r.height,
                               "width": r.width, "height": r.height])
            }
        }
    }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    request.customWords = CUSTOM_WORDS

    let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
    do { try handler.perform([request]) } catch { out["error"] = String(describing: error) }

    out["text"] = lines.joined(separator: "\n")
    out["blocks"] = blocks
    return out
}

for path in CommandLine.arguments.dropFirst() {
    let result = ocr(path: path)
    if let data = try? JSONSerialization.data(withJSONObject: result),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}
