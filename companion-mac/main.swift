// Swipe Clean Companion for Mac — lets the Swipe Clean phone app see and clean up the photos on this Mac.
//
// • Lives in the menu bar and shows a 6-digit pairing code.
// • Serves an encrypted (TLS) API on the local network, announced over Bonjour as _swipeclean._tcp.
//   The certificate is self-signed; the phone pins its fingerprint when pairing.
// • Sources: the Photos app library (PhotoKit) and folders you choose.
// • Deleting: Photos library → Recently Deleted (macOS asks to confirm on the Mac); folder files → the Trash.
// Nothing is uploaded anywhere: photos only travel between this Mac and your paired phone.

import AppKit
import Photos
import Network
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

// MARK: - Log (companion.log next to the settings; small, for troubleshooting)

enum Log {
    static let q = DispatchQueue(label: "log")
    static func write(_ fmt: String, _ args: CVarArg...) {
        let line = "\(Date()) " + String(format: fmt, arguments: args) + "\n"
        q.async {
            let url = Store.shared.dir.appendingPathComponent("companion.log")
            if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
            else { try? Data(line.utf8).write(to: url) }
        }
    }
}

// MARK: - Settings

struct Config: Codable {
    var folders: [String] = []
    var includePhotosLibrary = true
    var tokens: [String: String] = [:]   // token -> phone name
}

final class Store {
    static let shared = Store()
    let dir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SwipeCleanCompanion", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    var config = Config()
    private var file: URL { dir.appendingPathComponent("config.json") }
    init() {
        if let d = try? Data(contentsOf: file), let c = try? JSONDecoder().decode(Config.self, from: d) { config = c }
    }
    func save() { if let d = try? JSONEncoder().encode(config) { try? d.write(to: file, options: .atomic) } }
}

// MARK: - TLS identity (self-signed, made once with the system's openssl)

enum Identity {
    static var fingerprint = ""
    static func load() -> sec_identity_t? {
        let dir = Store.shared.dir
        let p12 = dir.appendingPathComponent("identity.p12"), certPem = dir.appendingPathComponent("cert.pem")
        if !FileManager.default.fileExists(atPath: p12.path) {
            let key = dir.appendingPathComponent("key.pem")
            run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key.path, "-out", certPem.path,
                                     "-days", "3650", "-subj", "/CN=Swipe Clean Companion"])
            run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key.path, "-in", certPem.path, "-out", p12.path,
                                     "-passout", "pass:swipeclean"])
            try? FileManager.default.removeItem(at: key)
        }
        guard let data = try? Data(contentsOf: p12) else { return nil }
        var items: CFArray?
        let status = SecPKCS12Import(data as CFData, [kSecImportExportPassphrase as String: "swipeclean"] as CFDictionary, &items)
        guard status == errSecSuccess, let first = (items as? [[String: Any]])?.first,
              let ident = first[kSecImportItemIdentity as String] else { NSLog("identity import failed %d", status); return nil }
        let identity = ident as! SecIdentity
        var cert: SecCertificate?
        SecIdentityCopyCertificate(identity, &cert)
        if let c = cert {
            let der = SecCertificateCopyData(c) as Data
            fingerprint = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        }
        return sec_identity_create(identity)
    }
    @discardableResult static func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit(); return p.terminationStatus
    }
}

// MARK: - Library: Photos app + folders

struct Item {
    let id: String            // "p:<localIdentifier>" or "f:<hash of path>"
    let source: String        // "photos" or "folder"
    let name: String
    let size: Int64
    let taken: Double         // ms since 1970
    let width: Int, height: Int
    let kind: String          // image | video
    let path: String?         // folders only
    let duration: Double?
}

final class Library {
    static let shared = Library()
    private(set) var items: [String: Item] = [:]
    private let q = DispatchQueue(label: "library")
    private let imageExt: Set<String> = ["jpg", "jpeg", "heic", "heif", "png", "gif", "webp", "tif", "tiff", "dng", "raw", "cr2", "nef", "arw"]
    private let videoExt: Set<String> = ["mov", "mp4", "m4v", "avi", "3gp"]

    var photosAuthorized: Bool { PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized }

    func refresh() -> [Item] {
        q.sync {
            var all: [String: Item] = [:]
            if Store.shared.config.includePhotosLibrary && photosAuthorized {
                let opts = PHFetchOptions()
                opts.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
                PHAsset.fetchAssets(with: opts).enumerateObjects { a, _, _ in
                    let res = PHAssetResource.assetResources(for: a)
                    let primary = res.first { $0.type == .photo || $0.type == .video }
                    let size = (primary?.value(forKey: "fileSize") as? NSNumber)?.int64Value ?? 0
                    let it = Item(id: "p:" + a.localIdentifier, source: "photos", name: primary?.originalFilename ?? "Photo",
                                  size: size, taken: (a.creationDate?.timeIntervalSince1970 ?? 0) * 1000,
                                  width: a.pixelWidth, height: a.pixelHeight, kind: a.mediaType == .video ? "video" : "image",
                                  path: nil, duration: a.mediaType == .video ? a.duration : nil)
                    all[it.id] = it
                }
            }
            for folder in Store.shared.config.folders {
                let url = URL(fileURLWithPath: folder)
                guard let en = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey, .creationDateKey, .contentModificationDateKey, .isPackageKey],
                                                             options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
                for case let f as URL in en {
                    let ext = f.pathExtension.lowercased()
                    let isImage = imageExt.contains(ext), isVideo = videoExt.contains(ext)
                    guard isImage || isVideo else { continue }
                    let rv = try? f.resourceValues(forKeys: [.fileSizeKey, .creationDateKey, .contentModificationDateKey])
                    var taken = (rv?.creationDate ?? rv?.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000
                    var w = 0, h = 0
                    if isImage, let src = CGImageSourceCreateWithURL(f as CFURL, nil),
                       let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] {
                        w = props[kCGImagePropertyPixelWidth] as? Int ?? 0
                        h = props[kCGImagePropertyPixelHeight] as? Int ?? 0
                        if let o = props[kCGImagePropertyOrientation] as? Int, o >= 5 { swap(&w, &h) }
                        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
                           let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String, let d = Self.exifDate(s) {
                            taken = d.timeIntervalSince1970 * 1000
                        }
                    }
                    let id = "f:" + Insecure.SHA1.hash(data: Data(f.path.utf8)).map { String(format: "%02x", $0) }.joined()
                    all[id] = Item(id: id, source: "folder", name: f.lastPathComponent, size: Int64(rv?.fileSize ?? 0), taken: taken,
                                   width: w, height: h, kind: isVideo ? "video" : "image", path: f.path, duration: nil)
                }
            }
            items = all
            return Array(all.values)
        }
    }

    static func exifDate(_ s: String) -> Date? {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        return f.date(from: s)
    }

    func item(_ id: String) -> Item? { q.sync { items[id] } }

    /// JPEG preview, longest side ~size px.
    func thumbnail(_ id: String, size: Int) -> Data? {
        guard let it = item(id) else { return nil }
        if it.source == "photos" {
            guard let a = PHAsset.fetchAssets(withLocalIdentifiers: [String(id.dropFirst(2))], options: nil).firstObject else { return nil }
            let o = PHImageRequestOptions(); o.isSynchronous = true; o.deliveryMode = .highQualityFormat; o.isNetworkAccessAllowed = true; o.resizeMode = .fast
            var out: Data?
            PHImageManager.default().requestImage(for: a, targetSize: CGSize(width: size, height: size), contentMode: .aspectFit, options: o) { img, _ in
                if let cg = img?.cgImage(forProposedRect: nil, context: nil, hints: nil) { out = Self.jpeg(cg) }
            }
            return out
        }
        guard let p = it.path else { return nil }
        if it.kind == "video" { return nil }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                                                   kCGImageSourceCreateThumbnailWithTransform: true,
                                                                   kCGImageSourceThumbnailMaxPixelSize: size] as CFDictionary) else { return nil }
        return Self.jpeg(cg)
    }

    static func jpeg(_ cg: CGImage) -> Data? {
        let d = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(d, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(dst) ? d as Data : nil
    }

    /// Folder files → Trash (can be put back). Photos library → Recently Deleted (macOS asks on the Mac).
    func trash(_ ids: [String], done: @escaping ([String]) -> Void) {
        var gone: [String] = []
        for id in ids where id.hasPrefix("f:") {
            if let p = item(id)?.path, (try? FileManager.default.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: nil)) != nil { gone.append(id) }
        }
        let photoIds = ids.filter { $0.hasPrefix("p:") }.map { String($0.dropFirst(2)) }
        if photoIds.isEmpty { q.sync { gone.forEach { items.removeValue(forKey: $0) } }; return done(gone) }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: photoIds, options: nil)
        DispatchQueue.main.async { NSApp.activate(ignoringOtherApps: true) }   // so the confirmation is visible
        PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.deleteAssets(assets) }) { ok, _ in
            if ok { gone.append(contentsOf: photoIds.map { "p:" + $0 }) }
            self.q.sync { gone.forEach { self.items.removeValue(forKey: $0) } }
            done(gone)
        }
    }
}

// MARK: - Pairing

final class Pairing {
    static let shared = Pairing()
    // Testing: SWIPECLEAN_TEST_CODE=123456 sets the first code (normal launches get a random one).
    private(set) var code = ProcessInfo.processInfo.environment["SWIPECLEAN_TEST_CODE"] ?? Pairing.newCode()
    private var issued = Date()
    var onChange: (() -> Void)?
    static func newCode() -> String { String(format: "%06d", Int.random(in: 0...999_999)) }
    func current() -> String {
        if Date().timeIntervalSince(issued) > 300 { rotate() }
        return code
    }
    func rotate() { code = Self.newCode(); issued = Date(); DispatchQueue.main.async { self.onChange?() } }
    func pair(code c: String, name: String) -> String? {
        guard c == current() else { return nil }
        let token = UUID().uuidString + UUID().uuidString
        Store.shared.config.tokens[token] = name
        Store.shared.save()
        rotate()   // a code works once
        return token
    }
}

// MARK: - HTTPS server (tiny HTTP/1.1 over NWListener with TLS)

final class Server {
    static let shared = Server()
    let port: UInt16 = 8787
    private var listener: NWListener?

    func start() {
        guard let identity = Identity.load() else { NSLog("No TLS identity"); return }
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, identity)
        let params = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        params.includePeerToPeer = true
        do {
            let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            l.service = NWListener.Service(name: Host.current().localizedName ?? "Mac", type: "_swipeclean._tcp",
                                           txtRecord: NWTXTRecord(["fp": Identity.fingerprint, "v": "1"]))
            l.newConnectionHandler = { [weak self] c in self?.handle(c) }
            l.start(queue: .global(qos: .userInitiated))
            listener = l
        } catch { NSLog("listener failed: \(error)") }
    }

    private func handle(_ c: NWConnection) {
        c.stateUpdateHandler = { st in
            if case let .failed(e) = st { Log.write("conn failed: %@", "\(e)") }
        }
        c.start(queue: .global(qos: .userInitiated))
        receive(c, buffer: Data())
    }

    private func receive(_ c: NWConnection, buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, err in
            var buf = buffer
            if let d = data { buf.append(d) }
            if let range = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<range.lowerBound], as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                var headers: [String: String] = [:]
                for l in lines.dropFirst() { if let i = l.firstIndex(of: ":") { headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
                let need = Int(headers["content-length"] ?? "0") ?? 0
                let body = buf[range.upperBound...]
                if body.count >= need {
                    let parts = (lines.first ?? "").split(separator: " ")
                    self.route(c, method: parts.first.map(String.init) ?? "GET", target: parts.count > 1 ? String(parts[1]) : "/",
                               headers: headers, body: Data(body.prefix(need)))
                    return
                }
            }
            if done || err != nil || buf.count > 64 << 20 { c.cancel(); return }
            self.receive(c, buffer: buf)
        }
    }

    private func send(_ c: NWConnection, _ status: Int, _ type: String, _ body: Data) {
        Log.write("reply %d (%d bytes)", status, body.count)
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found"][status] ?? "OK"
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        head += ""
        var out = Data(head.utf8); out.append(body)
        // Don't close right after handing the data to macOS: over Wi-Fi it's still on its way
        // and closing early cuts the reply off. Mark the reply complete, then wait for the phone
        // to finish reading and hang up (or give up after a minute).
        c.send(content: out, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { err in
            if let err = err { Log.write("send failed: %@", "\(err)"); c.cancel(); return }
            Self.drainUntilClosed(c)
        })
        DispatchQueue.global().asyncAfter(deadline: .now() + 60) { if c.state != .cancelled { c.cancel() } }
    }
    private static func drainUntilClosed(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, done, err in
            if done || err != nil { c.cancel() } else { drainUntilClosed(c) }
        }
    }

    private func json(_ c: NWConnection, _ obj: Any, status: Int = 200) {
        send(c, status, "application/json", (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8))
    }

    private func route(_ c: NWConnection, method: String, target: String, headers: [String: String], body: Data) {
        Log.write("request %@ %@", method, String(target.prefix(60)))
        let comps = URLComponents(string: "https://x" + target)
        let path = comps?.path ?? "/"
        let q = Dictionary(uniqueKeysWithValues: (comps?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        let token = (headers["authorization"] ?? "").replacingOccurrences(of: "Bearer ", with: "")
        let authed = Store.shared.config.tokens[token] != nil

        switch (method, path) {
        case ("GET", "/info"):
            json(c, ["name": Host.current().localizedName ?? "Mac", "platform": "mac", "version": 1, "paired": authed])
        case ("POST", "/pair"):
            let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            if let t = Pairing.shared.pair(code: o["code"] as? String ?? "", name: o["name"] as? String ?? "Phone") {
                DispatchQueue.main.async { AppDelegate.shared?.refreshMenu() }
                json(c, ["token": t, "name": Host.current().localizedName ?? "Mac"])
            } else { json(c, ["error": "Wrong or expired code"], status: 401) }
        case _ where !authed:
            json(c, ["error": "Not paired"], status: 401)
        case ("GET", "/items"):
            DispatchQueue.global(qos: .userInitiated).async {
                let list = Library.shared.refresh().map { it -> [String: Any] in
                    var d: [String: Any] = ["id": it.id, "source": it.source, "name": it.name, "size": it.size, "taken": it.taken,
                                            "width": it.width, "height": it.height, "kind": it.kind]
                    if let du = it.duration { d["duration"] = du }
                    return d
                }
                self.json(c, ["items": list, "photosLibrary": Library.shared.photosAuthorized && Store.shared.config.includePhotosLibrary,
                              "folders": Store.shared.config.folders])
            }
        case ("GET", "/thumb"):
            DispatchQueue.global(qos: .userInitiated).async {
                if let d = Library.shared.thumbnail(q["id"] ?? "", size: Int(q["size"] ?? "360") ?? 360) { self.send(c, 200, "image/jpeg", d) }
                else { self.json(c, ["error": "No preview"], status: 404) }
            }
        case ("POST", "/trash"):
            let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            Library.shared.trash(o["ids"] as? [String] ?? []) { gone in self.json(c, ["deleted": gone]) }
        default:
            json(c, ["error": "Not found"], status: 404)
        }
    }
}

// MARK: - Menu bar app

final class AppDelegate: NSObject, NSApplicationDelegate {
    static var shared: AppDelegate?
    private var status: NSStatusItem!
    private var window: NSWindow?
    private let codeLabel = NSTextField(labelWithString: "")
    private let infoLabel = NSTextField(wrappingLabelWithString: "")

    func applicationDidFinishLaunching(_ n: Notification) {
        AppDelegate.shared = self
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = NSImage(systemSymbolName: "photo.on.rectangle.angled", accessibilityDescription: "Swipe Clean Companion")
        Pairing.shared.onChange = { [weak self] in self?.refreshMenu() }
        if Store.shared.config.includePhotosLibrary {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in DispatchQueue.main.async { self.refreshMenu() } }
        }
        Server.shared.start()
        refreshMenu()
        showWindow()
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refreshMenu() }
    }

    /// A small window with the pairing code, so you don't have to find the menu bar icon
    /// (on MacBooks it can hide behind the camera notch). Opening the app again shows it again.
    func showWindow() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300), styleMask: [.titled, .closable],
                             backing: .buffered, defer: false)
            w.title = "Swipe Clean Companion"
            w.isReleasedWhenClosed = false
            let title = NSTextField(labelWithString: "Pairing code")
            title.font = .systemFont(ofSize: 13, weight: .medium); title.textColor = .secondaryLabelColor
            codeLabel.font = .monospacedDigitSystemFont(ofSize: 44, weight: .semibold)
            infoLabel.font = .systemFont(ofSize: 13)
            let newCode = NSButton(title: "New code", target: self, action: #selector(newCode))
            let folder = NSButton(title: "Add a folder…", target: self, action: #selector(addFolder))
            let buttons = NSStackView(views: [newCode, folder])
            let stack = NSStackView(views: [title, codeLabel, infoLabel, buttons])
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
            stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
            infoLabel.preferredMaxLayoutWidth = 370
            w.contentView = stack
            w.center()
            window = w
        }
        refreshMenu()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(); return true
    }

    func refreshMenu() {
        let codeNow = Pairing.shared.current()
        codeLabel.stringValue = "\(codeNow.prefix(3)) \(codeNow.suffix(3))"
        let paired = Array(Set(Store.shared.config.tokens.values)).sorted()
        var photos = "Photos library: not included (turn it on from the menu bar icon)"
        if Store.shared.config.includePhotosLibrary {
            switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
            case .authorized: photos = "Photos library: included ✓"
            case .notDetermined: photos = "Photos library: waiting for your permission"
            default: photos = "Photos library: access is off — System Settings → Privacy & Security → Photos"
            }
        }
        let folders = Store.shared.config.folders.isEmpty ? "Folders: none" : "Folders: " + Store.shared.config.folders.map { ($0 as NSString).lastPathComponent }.joined(separator: ", ")
        let pairedText = paired.isEmpty ? "No phones paired yet" : "Paired: " + paired.joined(separator: ", ")
        infoLabel.stringValue = [
            "On your phone: Swipe Clean → Your computer → tap this Mac → type the code.",
            "Phone and Mac must be on the same Wi-Fi. The code changes every 5 minutes.",
            "", pairedText, photos, folders,
        ].joined(separator: "\n")
        let m = NSMenu()
        m.addItem(withTitle: "Show pairing window", action: #selector(showWindowAction), keyEquivalent: "").target = self
        let code = Pairing.shared.current()
        m.addItem(withTitle: "Pairing code:  \(code.prefix(3)) \(code.suffix(3))", action: nil, keyEquivalent: "")
        m.addItem(withTitle: "Enter it in Swipe Clean → Connect a computer", action: nil, keyEquivalent: "")
        m.addItem(withTitle: "New code", action: #selector(newCode), keyEquivalent: "").target = self
        m.addItem(.separator())
        let phones = Array(Set(Store.shared.config.tokens.values)).sorted()
        m.addItem(withTitle: phones.isEmpty ? "No phones paired yet" : "Paired: " + phones.joined(separator: ", "), action: nil, keyEquivalent: "")
        m.addItem(.separator())
        let lib = NSMenuItem(title: "Include Photos library", action: #selector(togglePhotos), keyEquivalent: "")
        lib.state = Store.shared.config.includePhotosLibrary ? .on : .off; lib.target = self
        m.addItem(lib)
        m.addItem(withTitle: "Add a folder…", action: #selector(addFolder), keyEquivalent: "").target = self
        for f in Store.shared.config.folders {
            let it = NSMenuItem(title: "  ✕  " + (f as NSString).abbreviatingWithTildeInPath, action: #selector(removeFolder(_:)), keyEquivalent: "")
            it.representedObject = f; it.target = self; m.addItem(it)
        }
        m.addItem(.separator())
        m.addItem(withTitle: "Unpair all phones", action: #selector(unpair), keyEquivalent: "").target = self
        m.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = m
    }

    @objc func newCode() { Pairing.shared.rotate() }
    @objc func showWindowAction() { showWindow() }
    @objc func togglePhotos() {
        Store.shared.config.includePhotosLibrary.toggle(); Store.shared.save()
        if Store.shared.config.includePhotosLibrary { PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in } }
        refreshMenu()
    }
    @objc func addFolder() {
        let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = true
        p.message = "Choose folders with photos for Swipe Clean"
        NSApp.activate(ignoringOtherApps: true)
        if p.runModal() == .OK {
            for u in p.urls where !Store.shared.config.folders.contains(u.path) { Store.shared.config.folders.append(u.path) }
            Store.shared.save(); refreshMenu()
        }
    }
    @objc func removeFolder(_ s: NSMenuItem) {
        if let f = s.representedObject as? String { Store.shared.config.folders.removeAll { $0 == f }; Store.shared.save(); refreshMenu() }
    }
    @objc func unpair() { Store.shared.config.tokens = [:]; Store.shared.save(); refreshMenu() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
app.run()
