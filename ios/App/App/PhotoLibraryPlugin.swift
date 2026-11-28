import Foundation
import UIKit
import Photos
import AVFoundation
import Capacitor
import BackgroundTasks
import UserNotifications
import Vision
import Network
import CryptoKit
import CoreML
import Accelerate
import ImageIO
import UniformTypeIdentifiers

/// "Only on busy days" reminder. iOS can't run an app at an exact time, so we ask for a
/// background refresh no earlier than the chosen time; when iOS runs it, count the photos
/// and videos taken in the last 24 hours and notify only if there are at least `threshold`.
enum BusyCheck {
    static let taskId = "com.aayushmk.swipeclean.busycheck"
    private static let defaults = UserDefaults.standard

    /// Call once from application(_:didFinishLaunchingWithOptions:).
    static func registerTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            run(task as! BGAppRefreshTask)
        }
    }

    static func schedule(hour: Int, minute: Int, threshold: Int) {
        defaults.set(true, forKey: "busy.on")
        defaults.set(hour, forKey: "busy.hour")
        defaults.set(minute, forKey: "busy.minute")
        defaults.set(threshold, forKey: "busy.threshold")
        planNext()
    }

    static func cancel() {
        defaults.set(false, forKey: "busy.on")
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
    }

    static func planNext() {
        guard defaults.bool(forKey: "busy.on") else { return }
        let cal = Calendar.current
        let today = cal.date(bySettingHour: defaults.integer(forKey: "busy.hour"),
                             minute: defaults.integer(forKey: "busy.minute"), second: 0, of: Date()) ?? Date()
        let next: Date
        if defaults.string(forKey: "busy.lastDay") == dayKey(Date()) {
            next = cal.date(byAdding: .day, value: 1, to: today) ?? today   // done today: tomorrow
        } else {
            next = max(today, Date())   // later today, or as soon as iOS allows if the time has passed
        }
        let req = BGAppRefreshTaskRequest(identifier: taskId)
        req.earliestBeginDate = next
        try? BGTaskScheduler.shared.submit(req)
    }

    private static func dayKey(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
    }

    private static func run(_ task: BGAppRefreshTask) {
        task.expirationHandler = { task.setTaskCompleted(success: false) }
        check { task.setTaskCompleted(success: true) }
    }

    /// Count recent items and notify if it was a busy day. Public so the app can run it directly.
    static func check(done: @escaping () -> Void) {
        guard defaults.bool(forKey: "busy.on") else { return done() }
        let threshold = max(1, defaults.integer(forKey: "busy.threshold"))
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "creationDate >= %@ AND (mediaType == %d OR mediaType == %d)",
                                     Date().addingTimeInterval(-24 * 3600) as NSDate,
                                     PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        let count = PHAsset.fetchAssets(with: opts).count
        defaults.set(dayKey(Date()), forKey: "busy.lastDay")
        planNext()
        guard count >= threshold else { return done() }
        let content = UNMutableNotificationContent()
        content.title = "Swipe Clean 🧹"
        content.body = "You took \(count) photos & videos today — clean them up while you remember them."
        content.sound = .default
        let req = UNNotificationRequest(identifier: "busy-day", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { _ in done() }
    }
}

/// Hosts the web app and registers our in-app plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PhotoLibraryPlugin())
    }
}

/// Reads the real photo library (photos + videos) and deletes items from it.
/// JS name: PhotoLibrary
@objc(PhotoLibraryPlugin)
public class PhotoLibraryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoLibraryPlugin"
    public let jsName = "PhotoLibrary"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openPhotosApp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStorageInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleBusyCheck", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareItems", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "indexLibrary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "indexStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "findSimilar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPeople", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "findDuplicates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoverComputers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "computerRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelBusyCheck", returnType: CAPPluginReturnPromise),
    ]

    private let imageManager = PHCachingImageManager()
    private let fm = FileManager.default
    private lazy var thumbDir: URL = makeDir("thumbs")
    private lazy var fullDir: URL = makeDir("full")
    private lazy var videoDir: URL = makeDir("video")
    private var recentVideos: [URL] = []          // keep only a few big video copies around
    private let videoQueue = DispatchQueue(label: "swipeclean.video")

    private func makeDir(_ name: String) -> URL {
        let base = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("photo-cache/\(name)", isDirectory: true)
        try? fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    override public func load() {
        // Full-size copies are only needed while swiping; start fresh each launch.
        for dir in [fullDir, videoDir] {
            try? fm.removeItem(at: dir)
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        // Copies made for sharing are deleted when the share sheet closes; if the app was
        // closed mid-share, clean them up now.
        for f in (try? fm.contentsOfDirectory(at: fm.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
        where f.lastPathComponent.hasPrefix("share-") {
            try? fm.removeItem(at: f)
        }
    }

    private static func statusName(_ s: PHAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "granted"
        case .limited: return "limited"
        case .denied, .restricted: return "denied"
        default: return "prompt"
        }
    }

    private static func safeName(_ id: String) -> String {
        id.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined()
    }

    private func asset(_ id: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
    }

    private static func bytes(of asset: PHAsset) -> Int64 {
        PHAssetResource.assetResources(for: asset).reduce(Int64(0)) { sum, r in
            sum + ((r.value(forKey: "fileSize") as? NSNumber)?.int64Value ?? 0)
        }
    }

    @objc func requestAccess(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            call.resolve(["status": Self.statusName(status)])
        }
    }

    @objc func getPhotos(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let opts = PHFetchOptions()
            opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            opts.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d",
                                         PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
            let result = PHAsset.fetchAssets(with: opts)
            var items: [[String: Any]] = []
            items.reserveCapacity(result.count)
            result.enumerateObjects { asset, _, _ in
                var item: [String: Any] = [
                    "id": asset.localIdentifier,
                    "taken": (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000,
                    "width": asset.pixelWidth,
                    "height": asset.pixelHeight,
                    "type": asset.mediaType == .video ? "video" : "image",
                ]
                if asset.mediaType == .video { item["duration"] = asset.duration }
                if asset.mediaSubtypes.contains(.photoScreenshot) { item["screenshot"] = true }
                items.append(item)
            }
            call.resolve(["photos": items])
        }
    }

    /// File size on the phone (all resources of the item), looked up lazily.
    @objc func getInfo(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let a = asset(id) else { return call.reject("Not found") }
        DispatchQueue.global(qos: .utility).async {
            call.resolve(["size": Self.bytes(of: a)])
        }
    }

    /// Writes a JPEG of the photo (or a video's poster frame), longest side ~size px,
    /// to the cache and returns its file URL.
    @objc func getImage(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        let size = max(64, call.getInt("size") ?? 400)
        let isThumb = size <= 600
        let file = (isThumb ? thumbDir : fullDir).appendingPathComponent("\(Self.safeName(id))_\(size).jpg")
        if fm.fileExists(atPath: file.path) {
            return call.resolve(["path": file.absoluteString])
        }
        guard let a = asset(id) else { return call.reject("Photo not found") }
        let opts = PHImageRequestOptions()
        opts.deliveryMode = .highQualityFormat
        opts.resizeMode = isThumb ? .fast : .exact   // full views: properly resampled pixels
        opts.isNetworkAccessAllowed = true   // items stored in iCloud
        opts.isSynchronous = false
        let target = CGSize(width: size, height: size)
        imageManager.requestImage(for: a, targetSize: target, contentMode: isThumb ? .aspectFill : .aspectFit, options: opts) { image, _ in
            // Detail view (4096 px) gets near-lossless quality.
            let quality: CGFloat = isThumb ? 0.75 : (size > 2048 ? 0.95 : 0.9)
            guard let image = image, let data = image.jpegData(compressionQuality: quality) else {
                return call.reject("Could not load photo")
            }
            do {
                try data.write(to: file, options: .atomic)
                call.resolve(["path": file.absoluteString])
            } catch {
                // Phone full: hand the picture over directly instead of via a file.
                call.resolve(["data": "data:image/jpeg;base64," + data.base64EncodedString()])
            }
        }
    }

    /// Makes a playable copy of a video in the cache and returns its file URL.
    @objc func getVideo(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let a = asset(id), a.mediaType == .video else {
            return call.reject("Video not found")
        }
        let base = videoDir.appendingPathComponent(Self.safeName(id))
        for ext in ["mov", "mp4", "m4v"] {
            let f = base.appendingPathExtension(ext)
            if fm.fileExists(atPath: f.path) { return call.resolve(["path": f.absoluteString]) }
        }
        let opts = PHVideoRequestOptions()
        opts.isNetworkAccessAllowed = true
        opts.deliveryMode = .automatic
        opts.version = .current
        PHImageManager.default().requestAVAsset(forVideo: a, options: opts) { [weak self] av, _, _ in
            guard let self = self, let av = av else { return call.reject("Could not load video") }
            self.videoQueue.async {
                if let urlAsset = av as? AVURLAsset {
                    let ext = urlAsset.url.pathExtension.isEmpty ? "mov" : urlAsset.url.pathExtension.lowercased()
                    let dest = base.appendingPathExtension(ext)
                    do {
                        try? self.fm.removeItem(at: dest)
                        try self.fm.copyItem(at: urlAsset.url, to: dest)
                        self.remember(dest)
                        call.resolve(["path": dest.absoluteString])
                    } catch {
                        let full = (error as NSError).code == NSFileWriteOutOfSpaceError
                        call.reject(full ? "Not enough free space to play this video" : "Could not copy video", full ? "NO_SPACE" : nil, error)
                    }
                } else {
                    // Slo-mo and edited videos come as compositions: export to MP4.
                    let dest = base.appendingPathExtension("mp4")
                    guard let export = AVAssetExportSession(asset: av, presetName: AVAssetExportPresetHighestQuality) else {
                        return call.reject("Could not export video")
                    }
                    export.outputURL = dest
                    export.outputFileType = .mp4
                    export.exportAsynchronously {
                        if export.status == .completed {
                            self.videoQueue.async { self.remember(dest) }
                            call.resolve(["path": dest.absoluteString])
                        } else {
                            call.reject("Could not export video")
                        }
                    }
                }
            }
        }
    }

    private func remember(_ url: URL) {
        recentVideos.removeAll { $0 == url }
        recentVideos.append(url)
        while recentVideos.count > 4 {
            try? fm.removeItem(at: recentVideos.removeFirst())
        }
    }

    /// Deletes items from the library. iOS always shows its own confirmation;
    /// deleted items go to the Photos app's "Recently Deleted" album.
    @objc func deletePhotos(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") ?? []).compactMap { $0 as? String }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        if assets.count == 0 {
            // Already gone from the library (e.g. deleted in Photos).
            return call.resolve(["deleted": true, "bytes": 0])
        }
        DispatchQueue.global(qos: .userInitiated).async {
            var total: Int64 = 0
            assets.enumerateObjects { a, _, _ in total += Self.bytes(of: a) }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.deleteAssets(assets)
            }) { success, error in
                if success {
                    call.resolve(["deleted": true, "bytes": total])
                } else {
                    call.resolve(["deleted": false, "error": error?.localizedDescription ?? "Cancelled"])
                }
            }
        }
    }

    /// Total size of all photos and videos in the library, plus the phone's storage.
    /// Sizes are the full originals (with iCloud "Optimize iPhone Storage" the phone may hold less).
    @objc func getStorageInfo(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .utility).async {
            var photoBytes: Int64 = 0, videoBytes: Int64 = 0, photoCount = 0, videoCount = 0
            var sizes: [String: Int64] = [:]   // per item, for "Largest first"
            let opts = PHFetchOptions()
            opts.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d",
                                         PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
            PHAsset.fetchAssets(with: opts).enumerateObjects { a, _, _ in
                autoreleasepool {
                    let b = Self.bytes(of: a)
                    sizes[a.localIdentifier] = b
                    if a.mediaType == .video { videoBytes += b; videoCount += 1 } else { photoBytes += b; photoCount += 1 }
                }
            }
            var total: Int64 = 0, free: Int64 = 0
            let keys: Set<URLResourceKey> = [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey]
            if let v = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: keys) {
                total = Int64(v.volumeTotalCapacity ?? 0)
                free = v.volumeAvailableCapacityForImportantUsage ?? 0
            }
            call.resolve([
                "photoBytes": photoBytes, "videoBytes": videoBytes,
                "photoCount": photoCount, "videoCount": videoCount,
                "totalBytes": total, "freeBytes": free,
                "sizes": sizes,
            ])
        }
    }

    /// Opens Apple's Photos app (there is no public link straight to Recently Deleted).
    @objc func openPhotosApp(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: "photos-redirect://") else { return call.resolve(["opened": false]) }
            UIApplication.shared.open(url) { ok in call.resolve(["opened": ok]) }
        }
    }

    // MARK: Sharing originals

    /// Shares the original files (best quality the phone has) through the system share sheet.
    /// zip: one .zip (chat apps send it untouched, as a document). jpeg: convert HEIC to JPEG.
    /// The copies live in a temporary folder that is deleted as soon as the sheet closes.
    @objc func shareItems(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") ?? []).compactMap { $0 as? String }
        let zip = call.getBool("zip") ?? false
        let jpeg = call.getBool("jpeg") ?? false
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        var byId: [String: PHAsset] = [:]
        fetched.enumerateObjects { a, _, _ in byId[a.localIdentifier] = a }
        let assets = ids.compactMap { byId[$0] }
        if assets.isEmpty { return call.reject("Nothing to share") }

        let root = fm.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
        let folder = root.appendingPathComponent("Swipe Clean photos", isDirectory: true)
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)

        DispatchQueue.global(qos: .userInitiated).async {
            var urls = [URL?](repeating: nil, count: assets.count)
            var taken = Set<String>()
            for (i, a) in assets.enumerated() {
                urls[i] = Self.exportOriginal(a, into: folder, jpeg: jpeg, taken: &taken)
            }
            var items: [URL] = urls.compactMap { $0 }
            if items.isEmpty {
                try? self.fm.removeItem(at: root)
                return call.reject("Could not read the photos")
            }
            if zip, let z = Self.zipFolder(folder, to: root.appendingPathComponent("Swipe Clean photos.zip")) {
                items = [z]
            }
            DispatchQueue.main.async {
                let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
                sheet.completionWithItemsHandler = { type, completed, _, _ in
                    try? self.fm.removeItem(at: root)
                    self.notifyListeners("shareDone", data: ["completed": completed, "app": type?.rawValue ?? ""])
                }
                guard let vc = self.bridge?.viewController else { return call.reject("No window") }
                if let pop = sheet.popoverPresentationController {   // iPad
                    pop.sourceView = vc.view
                    pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
                }
                vc.present(sheet, animated: true) { call.resolve(["presented": true]) }
            }
        }
    }

    /// Writes the asset's original file (the edited version if it was edited) into `folder`.
    private static func exportOriginal(_ a: PHAsset, into folder: URL, jpeg: Bool, taken: inout Set<String>) -> URL? {
        let res = PHAssetResource.assetResources(for: a)
        let pick: PHAssetResource?
        if a.mediaType == .video {
            pick = res.first { $0.type == .fullSizeVideo } ?? res.first { $0.type == .video }
        } else {
            pick = res.first { $0.type == .fullSizePhoto } ?? res.first { $0.type == .photo }
        }
        guard let r = pick else { return nil }
        let original = res.first { $0.type == .photo || $0.type == .video }?.originalFilename ?? r.originalFilename
        let base = (original as NSString).deletingPathExtension
        let ext = (r.originalFilename as NSString).pathExtension.isEmpty ? "jpg" : (r.originalFilename as NSString).pathExtension
        var name = "\(base).\(ext)", n = 2
        while taken.contains(name.lowercased()) { name = "\(base) (\(n)).\(ext)"; n += 1 }
        taken.insert(name.lowercased())
        let url = folder.appendingPathComponent(name)

        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = true   // download from iCloud if needed
        let sem = DispatchSemaphore(value: 0)
        var failed = false
        PHAssetResourceManager.default().writeData(for: r, toFile: url, options: opts) { err in
            failed = err != nil; sem.signal()
        }
        sem.wait()
        if failed { return nil }

        // "Most compatible": HEIC → JPEG, keeping the photo's metadata (date, place, orientation).
        if jpeg, a.mediaType == .image, ["heic", "heif"].contains(ext.lowercased()) {
            let jpgURL = url.deletingPathExtension().appendingPathExtension("jpg")
            if let src = CGImageSourceCreateWithURL(url as CFURL, nil),
               let dst = CGImageDestinationCreateWithURL(jpgURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) {
                CGImageDestinationAddImageFromSource(dst, src, 0, [kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
                if CGImageDestinationFinalize(dst) {
                    try? FileManager.default.removeItem(at: url)
                    return jpgURL
                }
            }
        }
        return url
    }

    /// Zips a folder using the system (no extra libraries).
    private static func zipFolder(_ folder: URL, to dest: URL) -> URL? {
        var result: URL?
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: folder, options: [.forUploading], error: &err) { zipped in
            try? FileManager.default.removeItem(at: dest)
            if (try? FileManager.default.copyItem(at: zipped, to: dest)) != nil { result = dest }
        }
        return result
    }

    // MARK: Similar photos and people (all on the phone)

    @objc func indexLibrary(_ call: CAPPluginCall) {
        SimilarityIndex.shared.run(progress: { done, total in
            self.notifyListeners("indexProgress", data: ["done": done, "total": total])
        }) { status in call.resolve(status) }
    }

    @objc func indexStatus(_ call: CAPPluginCall) {
        call.resolve(SimilarityIndex.shared.status())
    }

    @objc func findSimilar(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        let limit = call.getInt("limit") ?? 80
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(["matches": SimilarityIndex.shared.similar(to: id, limit: limit)])
        }
    }

    @objc func getPeople(_ call: CAPPluginCall) {
        let strict = call.getDouble("strictness") ?? 0.5
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(["people": SimilarityIndex.shared.people(strictness: strict)])
        }
    }

    @objc func findDuplicates(_ call: CAPPluginCall) {
        let maxD = call.getDouble("maxDistance") ?? 0.3
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(["groups": SimilarityIndex.shared.duplicates(maxDistance: Float(maxD))])
        }
    }

    // MARK: Computers (Swipe Clean Companion on a Mac / PC)

    private var browser: NWBrowser?

    /// Looks for companions on the Wi-Fi for ~3 s (Bonjour _swipeclean._tcp) and returns name, address and
    /// the certificate fingerprint each one announces.
    @objc func discoverComputers(_ call: CAPPluginCall) {
        let params = NWParameters()
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_swipeclean._tcp", domain: nil), using: params)
        var results: [NWBrowser.Result] = []
        b.browseResultsChangedHandler = { r, _ in results = Array(r) }
        b.start(queue: .global(qos: .userInitiated))
        browser = b
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            b.cancel()
            let group = DispatchGroup()
            var out: [[String: Any]] = []
            let lock = NSLock()
            for r in results {
                guard case let .service(name, _, _, _) = r.endpoint else { continue }
                var fp = ""
                if case let .bonjour(txt) = r.metadata { fp = txt["fp"] ?? "" }
                group.enter()
                Self.resolve(r.endpoint) { host, port in
                    if let host = host {
                        lock.lock(); out.append(["name": name, "host": host, "port": port, "fp": fp]); lock.unlock()
                    }
                    group.leave()
                }
            }
            group.notify(queue: .main) { call.resolve(["computers": out]) }
        }
    }

    /// Bonjour name → IPv4 address and port.
    private static func resolve(_ endpoint: NWEndpoint, done: @escaping (String?, Int) -> Void) {
        let p = NWParameters.tcp
        if let ip = p.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let c = NWConnection(to: endpoint, using: p)
        var finished = false
        let finish: (String?, Int) -> Void = { h, port in if !finished { finished = true; c.cancel(); done(h, port) } }
        c.stateUpdateHandler = { st in
            switch st {
            case .ready:
                if case let .hostPort(host, port)? = c.currentPath?.remoteEndpoint {
                    var h = "\(host)"
                    if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }
                    finish(h, Int(port.rawValue))
                } else { finish(nil, 0) }
            case .failed, .cancelled: finish(nil, 0)
            default: break
            }
        }
        c.start(queue: .global())
        DispatchQueue.global().asyncAfter(deadline: .now() + 4) { finish(nil, 0) }
    }

    /// HTTPS request to a paired computer. Only a server whose certificate matches `pin` (SHA-256 of the
    /// certificate) is accepted; with an empty pin the fingerprint is returned so the app can store it.
    @objc func computerRequest(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), let path = call.getString("path") else { return call.reject("host and path are required") }
        let port = call.getInt("port") ?? 8787
        let hostPart = host.contains(":") ? "[\(host)]" : host
        guard let url = URL(string: "https://\(hostPart):\(port)\(path)") else { return call.reject("Bad address") }
        var req = URLRequest(url: url, timeoutInterval: call.getDouble("timeout") ?? 20)
        req.httpMethod = call.getString("method") ?? "GET"
        if let t = call.getString("token"), !t.isEmpty { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let body = call.getObject("body"), let d = try? JSONSerialization.data(withJSONObject: body) {
            req.httpBody = d; req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let pinner = PinningDelegate(pin: call.getString("pin") ?? "")
        let session = URLSession(configuration: .ephemeral, delegate: pinner, delegateQueue: nil)
        session.dataTask(with: req) { data, resp, err in
            session.finishTasksAndInvalidate()
            if let err = err { return call.reject(pinner.mismatch ? "This computer's identity changed. Pair it again." : err.localizedDescription) }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let d = data ?? Data()
            var ret: [String: Any] = ["status": status, "fp": pinner.seen]
            if call.getBool("binary") ?? false { ret["base64"] = d.base64EncodedString() }
            else { ret["text"] = String(decoding: d, as: UTF8.self) }
            call.resolve(ret)
        }.resume()
    }

    @objc func scheduleBusyCheck(_ call: CAPPluginCall) {
        BusyCheck.schedule(hour: call.getInt("hour") ?? 20, minute: call.getInt("minute") ?? 0,
                           threshold: call.getInt("threshold") ?? 30)
        call.resolve()
    }

    @objc func cancelBusyCheck(_ call: CAPPluginCall) {
        BusyCheck.cancel()
        call.resolve()
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }
}


/// On-device index for "Similar photos" and "People".
/// For every photo: Apple's image fingerprint (Vision feature print), plus the faces Vision
/// finds and a fingerprint of each face. Only these numbers and small face thumbnails are kept;
/// no photos are copied. Phase 1 compares faces with the general fingerprint, which is rough;
/// a dedicated face model replaces it later.
final class SimilarityIndex {
    static let shared = SimilarityIndex()

    struct Face: Codable { var box: [Double]; var print: Data }
    struct Entry: Codable {
        var print: Data
        var faces: [Face]
        var fv: Int?          // which face method made `faces` (2 = SFace face recognition)
    }
    static let faceVersion = 2

    private var index: [String: Entry] = [:]
    private var loaded = false
    private var running = false
    private var waiters: [([String: Any]) -> Void] = []
    private let queue = DispatchQueue(label: "swipeclean.index", qos: .utility)
    private let lock = NSLock()
    private let fm = FileManager.default

    private var file: URL {
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("similarity-index.plist")
    }
    private var faceDir: URL {
        let d = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("faces", isDirectory: true)
        try? fm.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func loadIfNeeded() {
        lock.lock(); defer { lock.unlock() }
        if loaded { return }
        loaded = true
        if let d = try? Data(contentsOf: file), let i = try? PropertyListDecoder().decode([String: Entry].self, from: d) { index = i }
    }
    private func save() {
        lock.lock(); let snapshot = index; lock.unlock()
        let enc = PropertyListEncoder(); enc.outputFormat = .binary
        if let d = try? enc.encode(snapshot) { try? d.write(to: file, options: .atomic) }
    }

    private func allAssets() -> PHFetchResult<PHAsset> {
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d",
                                     PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        return PHAsset.fetchAssets(with: opts)
    }

    func status() -> [String: Any] {
        loadIfNeeded()
        let total = allAssets().count
        lock.lock(); let n = index.count; let faces = index.values.reduce(0) { $0 + $1.faces.count }; lock.unlock()
        return ["indexed": min(n, total), "total": total, "faces": faces, "running": running]
    }

    func run(progress: @escaping (Int, Int) -> Void, done: @escaping ([String: Any]) -> Void) {
        loadIfNeeded()
        lock.lock()
        waiters.append(done)
        if running { lock.unlock(); return }
        running = true
        lock.unlock()
        queue.async {
            let assets = self.allAssets()
            var live = Set<String>()
            var todo: [PHAsset] = []
            assets.enumerateObjects { a, _, _ in
                live.insert(a.localIdentifier)
                let e = self.index[a.localIdentifier]
                if e == nil || (a.mediaType == .image && e?.fv != Self.faceVersion) { todo.append(a) }
            }
            self.lock.lock()
            for id in self.index.keys where !live.contains(id) { self.index.removeValue(forKey: id) }   // deleted elsewhere
            self.lock.unlock()
            let total = assets.count
            var done = total - todo.count
            progress(done, total)
            for a in todo {
                autoreleasepool {
                    self.lock.lock(); let old = self.index[a.localIdentifier]; self.lock.unlock()
                    if let e = self.analyze(a, keepPrint: old?.print) {
                        self.lock.lock(); self.index[a.localIdentifier] = e; self.lock.unlock()
                    }
                }
                done += 1
                if done % 20 == 0 { progress(done, total) }
                if done % 300 == 0 { self.save() }
            }
            self.save()
            progress(total, total)
            self.lock.lock()
            self.running = false
            let ws = self.waiters; self.waiters = []
            self.lock.unlock()
            let st = self.status()
            ws.forEach { $0(st) }
        }
    }

    private func image(for a: PHAsset, size: CGFloat) -> CGImage? {
        let opts = PHImageRequestOptions()
        opts.isSynchronous = true
        opts.deliveryMode = .highQualityFormat
        opts.resizeMode = .fast
        opts.isNetworkAccessAllowed = false   // don't download the whole library from iCloud
        var out: CGImage?
        PHImageManager.default().requestImage(for: a, targetSize: CGSize(width: size, height: size),
                                              contentMode: .aspectFit, options: opts) { img, _ in out = img?.cgImage }
        return out
    }

    private static func vector(_ o: VNFeaturePrintObservation) -> Data {
        var floats = [Float](repeating: 0, count: o.elementCount)
        if o.elementType == .float {
            o.data.withUnsafeBytes { raw in for i in 0..<o.elementCount { floats[i] = raw.load(fromByteOffset: i * 4, as: Float.self) } }
        } else {
            o.data.withUnsafeBytes { raw in for i in 0..<o.elementCount { floats[i] = Float(raw.load(fromByteOffset: i * 8, as: Double.self)) } }
        }
        // normalise so distances are comparable
        let len = sqrt(floats.reduce(0) { $0 + $1 * $1 })
        if len > 0 { for i in floats.indices { floats[i] /= len } }
        return floats.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    /// Fingerprint (for Similar / Duplicates) plus faces (for People).
    /// keepPrint: reuse an existing fingerprint and only redo the faces.
    private func analyze(_ a: PHAsset, keepPrint: Data? = nil) -> Entry? {
        guard let cg = image(for: a, size: 1024) else { NSLog("SwipeClean index: no image for %@", a.localIdentifier); return nil }
        let printReq = Self.cpuOnSimulator(VNGenerateImageFeaturePrintRequest())
        let faceReq = Self.cpuOnSimulator(VNDetectFaceLandmarksRequest())
        var reqs: [VNRequest] = []
        if keepPrint == nil { reqs.append(printReq) }
        if a.mediaType == .image { reqs.append(faceReq) }
        if !reqs.isEmpty {
            do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform(reqs) } catch {
                NSLog("SwipeClean index: vision failed %@", error.localizedDescription); return nil
            }
        }
        let print: Data
        if let p = keepPrint { print = p }
        else if let fp = printReq.results?.first as? VNFeaturePrintObservation { print = Self.vector(fp) }
        else { return nil }
        var faces: [Face] = []
        let W = CGFloat(cg.width), H = CGFloat(cg.height)
        for f in (faceReq.results ?? []) where f.boundingBox.width * W > 40 && f.confidence > 0.6 {
            guard let pts = Self.fivePoints(f, width: W, height: H),
                  let emb = FaceEmbedder.shared.embed(cg, points: pts) else { continue }
            let b = f.boundingBox
            faces.append(Face(box: [b.minX, 1 - b.maxY, b.width, b.height], print: emb))
            // small round thumbnail for the People row
            let side = max(b.width * W, b.height * H) * 1.35
            let rect = CGRect(x: b.midX * W - side / 2, y: (1 - b.midY) * H - side / 2, width: side, height: side)
                .intersection(CGRect(x: 0, y: 0, width: W, height: H))
            if let crop = cg.cropping(to: rect) { saveThumb(crop, name: Self.faceName(a.localIdentifier, k: faces.count - 1)) }
        }
        return Entry(print: print, faces: faces, fv: a.mediaType == .image ? Self.faceVersion : nil)
    }

    /// The 5 points SFace is aligned on, in image pixels (top-left origin), in template order:
    /// eye on the image's left, eye on the image's right, nose tip, mouth corner left, mouth corner right.
    static func fivePoints(_ f: VNFaceObservation, width W: CGFloat, height H: CGFloat) -> [CGPoint]? {
        guard let lm = f.landmarks, let le = lm.leftEye, let re = lm.rightEye, let nose = lm.nose, let lips = lm.outerLips else { return nil }
        let size = CGSize(width: W, height: H)
        func pts(_ r: VNFaceLandmarkRegion2D) -> [CGPoint] { r.pointsInImage(imageSize: size).map { CGPoint(x: $0.x, y: H - $0.y) } }
        func mid(_ p: [CGPoint]) -> CGPoint {
            CGPoint(x: p.map(\.x).reduce(0, +) / CGFloat(p.count), y: p.map(\.y).reduce(0, +) / CGFloat(p.count))
        }
        let eyes = [mid(pts(le)), mid(pts(re))].sorted { $0.x < $1.x }
        let n = pts(nose)
        // nose tip ≈ lowest-middle of the nose outline
        let noseTip = CGPoint(x: mid(n).x, y: n.map(\.y).max() ?? mid(n).y)
        let mouth = pts(lips)
        guard let ml = mouth.min(by: { $0.x < $1.x }), let mr = mouth.max(by: { $0.x < $1.x }) else { return nil }
        return [eyes[0], eyes[1], noseTip, ml, mr]
    }

    #if DEBUG
    /// Test hook: numbers only (no images), to tune the match thresholds on a real phone.
    func debugSummary() {
        lock.lock(); let all = index; lock.unlock()
        let faces = all.values.reduce(0) { $0 + $1.faces.count }
        NSLog("SwipeClean summary: indexed=%d faces=%d", all.count, faces)
        for id in all.keys.sorted().prefix(6) {
            let d = similar(to: id, limit: 8).compactMap { ($0["d"] as? Double).map { String(format: "%.3f", $0) } }
            NSLog("SwipeClean nearest: %@", d.joined(separator: " "))
        }
        for (k, v) in [("dups", 0.27)] { NSLog("SwipeClean %@ groups=%d", k, duplicates(maxDistance: Float(v)).count) }
        for s in [0.25, 0.5, 0.75] {
            let p = people(strictness: s)
            NSLog("SwipeClean people strict=%.2f groups=%d sizes=%@", s, p.count, p.prefix(12).map { "\($0["count"] ?? 0)" }.joined(separator: ","))
        }
    }
    #endif

    /// The simulator has no Neural Engine/GPU path for Vision models; real phones don't need this.
    static func cpuOnSimulator<T: VNRequest>(_ r: T) -> T {
        #if targetEnvironment(simulator)
        r.usesCPUOnly = true
        #endif
        return r
    }

    static func faceName(_ id: String, k: Int) -> String {
        id.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined() + "_\(k).jpg"
    }
    private func saveThumb(_ cg: CGImage, name: String) {
        let size: CGFloat = 120
        let r = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
        let img = r.image { _ in UIImage(cgImage: cg).draw(in: CGRect(x: 0, y: 0, width: size, height: size)) }
        if let d = img.jpegData(compressionQuality: 0.8) { try? d.write(to: faceDir.appendingPathComponent(name)) }
    }

    private static func distance(_ a: Data, _ b: Data) -> Float {
        a.withUnsafeBytes { pa in b.withUnsafeBytes { pb in
            let x = pa.bindMemory(to: Float.self), y = pb.bindMemory(to: Float.self)
            var s: Float = 0
            for i in 0..<min(x.count, y.count) { let d = x[i] - y[i]; s += d * d }
            return sqrt(s)
        } }
    }

    /// Closest photos to `id`, nearest first. Indexes the photo itself first if needed.
    func similar(to id: String, limit: Int) -> [[String: Any]] {
        loadIfNeeded()
        lock.lock(); var q = index[id]; lock.unlock()
        if q == nil, let a = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject, let e = analyze(a) {
            lock.lock(); index[id] = e; lock.unlock(); q = e
        }
        guard let query = q else { return [] }
        lock.lock(); let all = index; lock.unlock()
        return all.compactMap { (k, e) -> (String, Float)? in k == id ? nil : (k, Self.distance(query.print, e.print)) }
            .sorted { $0.1 < $1.1 }
            .prefix(limit)
            .map { ["id": $0.0, "d": Double($0.1)] }
    }

    /// Duplicates and near-duplicates: each photo is compared with its neighbours in date
    /// order (copies saved twice keep their date, bursts sit together). Best copy first.
    func duplicates(maxDistance: Float) -> [[String: Any]] {
        loadIfNeeded()
        lock.lock(); let all = index; lock.unlock()
        var ordered: [PHAsset] = []
        allAssets().enumerateObjects { a, _, _ in if all[a.localIdentifier] != nil { ordered.append(a) } }
        let n = ordered.count, window = 40
        var parent = Array(0..<n)
        func find(_ x: Int) -> Int { var x = x; while parent[x] != x { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
        for i in 0..<n {
            guard let pi = all[ordered[i].localIdentifier]?.print else { continue }
            for j in (i + 1)..<min(n, i + window) {
                // photos and videos never count as duplicates of each other
                if ordered[i].mediaType != ordered[j].mediaType { continue }
                guard let pj = all[ordered[j].localIdentifier]?.print else { continue }
                if Self.distance(pi, pj) <= maxDistance { parent[find(j)] = find(i) }
            }
        }
        var groups: [Int: [PHAsset]] = [:]
        for i in 0..<n { groups[find(i), default: []].append(ordered[i]) }
        return groups.values.filter { $0.count >= 2 }
            .map { g in g.sorted { a, b in
                let pa = a.pixelWidth * a.pixelHeight, pb = b.pixelWidth * b.pixelHeight
                if pa != pb { return pa > pb }
                if a.isFavorite != b.isFavorite { return a.isFavorite }
                return (a.creationDate ?? .distantPast) < (b.creationDate ?? .distantPast)
            } }
            .sorted { ($0.first?.creationDate ?? .distantPast) > ($1.first?.creationDate ?? .distantPast) }
            .map { ["ids": $0.map { $0.localIdentifier }] }
    }

    /// Groups faces that look alike. strictness 0…1 (higher = only very close matches).
    /// Faces are unit vectors, so closeness is a dot product (done with Accelerate).
    func people(strictness: Double) -> [[String: Any]] {
        loadIfNeeded()
        lock.lock(); let all = index; lock.unlock()
        // distance between unit vectors: d² = 2 − 2·cos. Tuned on a real library (phase 1, rough).
        // SFace: the same person is usually cosine ≥ ~0.36 (OpenCV's suggested threshold).
        let minCos = Float(0.22 + 0.32 * strictness)
        var centroids: [[Float]] = []        // normalised running means
        var sums: [[Float]] = []
        var members: [[(String, Int)]] = []
        for (id, e) in all.sorted(by: { $0.key < $1.key }) {
            guard e.fv == Self.faceVersion else { continue }   // only faces from the face-recognition model
            for (k, f) in e.faces.enumerated() {
                let v: [Float] = f.print.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
                var best = -1, bestCos: Float = -2
                v.withUnsafeBufferPointer { vp in
                    for (gi, c) in centroids.enumerated() {
                        var dot: Float = 0
                        c.withUnsafeBufferPointer { cp in vDSP_dotpr(vp.baseAddress!, 1, cp.baseAddress!, 1, &dot, vDSP_Length(min(vp.count, cp.count))) }
                        if dot > bestCos { bestCos = dot; best = gi }
                    }
                }
                if best >= 0 && bestCos >= minCos {
                    vDSP_vadd(sums[best], 1, v, 1, &sums[best], 1, vDSP_Length(v.count))
                    var norm: Float = 0
                    vDSP_svesq(sums[best], 1, &norm, vDSP_Length(v.count))
                    var scale = 1 / max(sqrt(norm), 1e-6)
                    vDSP_vsmul(sums[best], 1, &scale, &centroids[best], 1, vDSP_Length(v.count))
                    members[best].append((id, k))
                } else {
                    centroids.append(v); sums.append(v); members.append([(id, k)])
                }
            }
        }
        let dir = faceDir
        return members.compactMap { m -> [String: Any]? in
            let ids = Array(Set(m.map { $0.0 }))
            guard ids.count >= 3 else { return nil }   // a "person" needs a few photos
            return ["ids": ids, "count": ids.count, "thumb": dir.appendingPathComponent(Self.faceName(m[0].0, k: m[0].1)).absoluteString]
        }
        .sorted { ($0["count"] as! Int) > ($1["count"] as! Int) }
        .prefix(40).map { $0 }
    }
}


/// SFace face recognition (OpenCV model zoo, converted to Core ML): an aligned 112×112 face →
/// 128 numbers; faces of the same person point the same way.
final class FaceEmbedder {
    static let shared = FaceEmbedder()
    private let model: MLModel?
    // Standard 112×112 positions for the 5 points (same template as Android/YuNet).
    private let template: [CGPoint] = [
        CGPoint(x: 38.2946, y: 51.6963), CGPoint(x: 73.5318, y: 51.5014), CGPoint(x: 56.0252, y: 71.7366),
        CGPoint(x: 41.5493, y: 92.3655), CGPoint(x: 70.7299, y: 92.2041),
    ]

    private init() {
        let cfg = MLModelConfiguration()
        #if targetEnvironment(simulator)
        cfg.computeUnits = .cpuOnly
        #endif
        if let url = Bundle.main.url(forResource: "SFace", withExtension: "mlmodelc") {
            model = try? MLModel(contentsOf: url, configuration: cfg)
        } else { model = nil }
        if model == nil { NSLog("SwipeClean faces: SFace model missing") }
    }

    func embed(_ cg: CGImage, points: [CGPoint]) -> Data? {
        guard let model = model, points.count == 5 else { return nil }
        // Similarity transform (scale + rotate + shift) taking the 5 points onto the template.
        let n = CGFloat(5)
        let sx = points.map(\.x).reduce(0, +) / n, sy = points.map(\.y).reduce(0, +) / n
        let dx = template.map(\.x).reduce(0, +) / n, dy = template.map(\.y).reduce(0, +) / n
        var na: CGFloat = 0, nb: CGFloat = 0, den: CGFloat = 0
        for (p, q) in zip(points, template) {
            let x = p.x - sx, y = p.y - sy, u = q.x - dx, v = q.y - dy
            na += x * u + y * v; nb += x * v - y * u; den += x * x + y * y
        }
        guard den > 0 else { return nil }
        let a = na / den, b = nb / den
        let t = CGAffineTransform(a: a, b: b, c: -b, d: a, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy))

        // Draw the aligned face into a 112×112 RGBA buffer (top-left origin).
        var px = [UInt8](repeating: 0, count: 112 * 112 * 4)
        guard let ctx = CGContext(data: &px, width: 112, height: 112, bitsPerComponent: 8, bytesPerRow: 112 * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.translateBy(x: 0, y: 112); ctx.scaleBy(x: 1, y: -1)   // match image coordinates
        ctx.concatenate(t)
        ctx.translateBy(x: 0, y: CGFloat(cg.height)); ctx.scaleBy(x: 1, y: -1)
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))

        guard let input = try? MLMultiArray(shape: [1, 3, 112, 112], dataType: .float32) else { return nil }
        let plane = 112 * 112
        let ptr = input.dataPointer.bindMemory(to: Float32.self, capacity: 3 * plane)
        for i in 0..<plane {   // RGB, 0–255, channel-first
            ptr[i] = Float32(px[i * 4]); ptr[plane + i] = Float32(px[i * 4 + 1]); ptr[2 * plane + i] = Float32(px[i * 4 + 2])
        }
        guard let out = try? model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["data": input])),
              let emb = out.featureValue(for: "embedding")?.multiArrayValue else { return nil }
        var v = (0..<emb.count).map { Float(truncating: emb[$0]) }
        let len = sqrt(v.reduce(0) { $0 + $1 * $1 })
        if len > 0 { for i in v.indices { v[i] /= len } }
        return v.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}


/// Accepts only the companion whose certificate hash matches the pin (or records it when no pin yet).
final class PinningDelegate: NSObject, URLSessionDelegate {
    let pin: String
    var seen = ""
    var mismatch = false
    init(pin: String) { self.pin = pin.lowercased() }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let cert = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        seen = SHA256.hash(data: SecCertificateCopyData(cert) as Data).map { String(format: "%02x", $0) }.joined()
        if pin.isEmpty || seen == pin { completionHandler(.useCredential, URLCredential(trust: trust)) }
        else { mismatch = true; completionHandler(.cancelAuthenticationChallenge, nil) }
    }
}
