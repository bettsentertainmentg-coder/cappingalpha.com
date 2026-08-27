import UIKit
import Social
import Vision
import UniformTypeIdentifiers
import MobileCoreServices

/// The CappingAlpha Share Extension.
///
/// This is what puts CappingAlpha in the "More ways to share" row of FanDuel,
/// DraftKings, BetMGM and every other book: they present a standard
/// UIActivityViewController, and any app shipping a share extension that accepts
/// an image appears in it. The books do not have to know we exist.
///
/// FLOW (Jack chose "open the app to a confirm screen", 2026-08-26):
///   1. Take the shared image (or the text a book shared instead).
///   2. Run Apple Vision RIGHT HERE, so the heavy work happens while the user is
///      still looking at their book and the app opens on a finished read.
///   3. Park the text + word boxes in the shared App Group container.
///   4. Open the app on a deep link; CANativePlugin.takeSharedSlip() hands it over.
///
/// The IMAGE only travels when Vision could not read it (a fallback the app
/// retries), and it never leaves the device either way.
class ShareViewController: UIViewController {

    /// Must match CANativePlugin.appGroup and the App Group capability on BOTH
    /// targets. If these ever drift, the share silently goes nowhere.
    static let appGroup = "group.com.cappingalpha.app"
    static let slipKey = "ca.pendingBetslip"
    /// Registered in the App target's Info.plist (CFBundleURLSchemes).
    static let deepLink = "cappingalpha://betslip"

    private let spinner = UIActivityIndicatorView(style: .large)
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        buildUI()
        handleInput()
    }

    // A deliberately tiny sheet: the user chose "share to CappingAlpha", so the
    // job is to get out of the way, not to make them confirm twice.
    private func buildUI() {
        view.backgroundColor = UIColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1)
        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        label.text = "Reading your bet..."
        label.textColor = UIColor(white: 0.85, alpha: 1)
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner); view.addSubview(label)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 18),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32)
        ])
    }

    // MARK: - Input

    private func handleInput() {
        guard let item = (extensionContext?.inputItems as? [NSExtensionItem])?.first,
              let providers = item.attachments, !providers.isEmpty else {
            finish(message: "Nothing to read.")
            return
        }

        // Prefer an image; fall back to text, then to a URL. Books share a rendered
        // card image, but some share a text summary and a couple share a link.
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { [weak self] value, _ in
                guard let self = self else { return }
                if let image = Self.coerceImage(value) { self.process(image: image) }
                else { self.finish(message: "Could not open that image.") }
            }
            return
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] value, _ in
                let text = (value as? String) ?? (value as? NSAttributedString)?.string ?? ""
                self?.store(payload: ["text": text])
            }
            return
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] value, _ in
                let url = (value as? URL)?.absoluteString ?? ""
                self?.store(payload: ["text": url])
            }
            return
        }
        finish(message: "That is not something we can read as a bet.")
    }

    /// The share sheet hands an image over as any of these, depending on the app.
    private static func coerceImage(_ value: NSSecureCoding?) -> UIImage? {
        if let image = value as? UIImage { return image }
        if let url = value as? URL, let data = try? Data(contentsOf: url) { return UIImage(data: data) }
        if let data = value as? Data { return UIImage(data: data) }
        return nil
    }

    // MARK: - Read

    private func process(image: UIImage) {
        guard let cg = image.cgImage else { fallback(image: image); return }

        let request = VNRecognizeTextRequest { [weak self] request, error in
            guard let self = self else { return }
            if error != nil { self.fallback(image: image); return }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            if observations.isEmpty { self.fallback(image: image); return }

            var lines: [String] = []
            var blocks: [[String: Any]] = []
            for obs in observations {
                guard let candidate = obs.topCandidates(1).first else { continue }
                let text = candidate.string
                lines.append(text)
                var placed = false
                var cursor = text.startIndex
                for word in text.split(separator: " ") {
                    guard let range = text.range(of: String(word), range: cursor..<text.endIndex) else { continue }
                    cursor = range.upperBound
                    guard let box = try? candidate.boundingBox(for: range) else { continue }
                    let r = box.boundingBox
                    // Vision's origin is bottom-left; the parser wants top-left.
                    blocks.append(["text": String(word), "x": r.origin.x,
                                   "y": 1.0 - r.origin.y - r.height,
                                   "width": r.width, "height": r.height])
                    placed = true
                }
                if !placed {
                    let r = obs.boundingBox
                    blocks.append(["text": text, "x": r.origin.x,
                                   "y": 1.0 - r.origin.y - r.height,
                                   "width": r.width, "height": r.height])
                }
            }
            self.store(payload: ["text": lines.joined(separator: "\n"), "blocks": blocks])
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
            do { try handler.perform([request]) } catch { self?.fallback(image: image) }
        }
    }

    /// Vision failed. Park the raw image so the app can try again with its own
    /// reader rather than losing the share entirely.
    private func fallback(image: UIImage) {
        guard let data = image.pngData(),
              let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else {
            finish(message: "Could not read that bet.")
            return
        }
        let name = "shared-slip-\(Int(Date().timeIntervalSince1970)).png"
        try? data.write(to: dir.appendingPathComponent(name))
        store(payload: ["imageFile": name])
    }

    // MARK: - Handoff

    private func store(payload: [String: Any]) {
        // The App Group is the ONLY channel between this extension and the app. When
        // the capability is missing (not registered on the developer portal, or not
        // ticked on both targets) UserDefaults(suiteName:) hands back nil, and an
        // optional-chained write here would drop the bet and still open the app, which
        // reads to the user as "CappingAlpha lost my bet". Say what actually happened.
        guard let defaults = UserDefaults(suiteName: Self.appGroup) else {
            NSLog("[CappingAlphaShare] App Group \(Self.appGroup) is unavailable. Enable App Groups on both the App and CappingAlphaShare targets.")
            finish(message: "CappingAlpha is not finished setting up on this device, so the bet could not be handed over.")
            return
        }
        var body = payload
        body["at"] = Date().timeIntervalSince1970
        defaults.set(body, forKey: Self.slipKey)
        DispatchQueue.main.async { [weak self] in self?.openApp() }
    }

    /// Extensions cannot call UIApplication.shared.open, so walk the responder
    /// chain to the hosting application and ask it to open the deep link. This is
    /// the long-standing way to do it and works on current iOS.
    private func openApp() {
        guard let url = URL(string: Self.deepLink) else { finish(message: nil); return }
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                break
            }
            responder = r.next
        }
        // Give the hand-off a beat before tearing the sheet down.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.finish(message: nil) }
    }

    private func finish(message: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let message = message {
                self.spinner.stopAnimating()
                self.label.text = message
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                    self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
                }
            } else {
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
        }
    }
}
