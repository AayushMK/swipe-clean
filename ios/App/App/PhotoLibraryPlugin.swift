import Foundation
import UIKit
import Photos
import AVFoundation
import Capacitor

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
        opts.resizeMode = .fast
        opts.isNetworkAccessAllowed = true   // items stored in iCloud
        opts.isSynchronous = false
        let target = CGSize(width: size, height: size)
        imageManager.requestImage(for: a, targetSize: target, contentMode: isThumb ? .aspectFill : .aspectFit, options: opts) { image, _ in
            guard let image = image, let data = image.jpegData(compressionQuality: isThumb ? 0.75 : 0.88) else {
                return call.reject("Could not load photo")
            }
            do {
                try data.write(to: file, options: .atomic)
                call.resolve(["path": file.absoluteString])
            } catch {
                call.reject("Could not cache photo", nil, error)
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
                        call.reject("Could not copy video", nil, error)
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

    /// Opens Apple's Photos app (there is no public link straight to Recently Deleted).
    @objc func openPhotosApp(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: "photos-redirect://") else { return call.resolve(["opened": false]) }
            UIApplication.shared.open(url) { ok in call.resolve(["opened": ok]) }
        }
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
