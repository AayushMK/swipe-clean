import Foundation
import UIKit
import Photos
import Capacitor

/// Hosts the web app and registers our in-app plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PhotoLibraryPlugin())
    }
}

/// Reads the real photo library and deletes photos from it.
/// JS name: PhotoLibrary
@objc(PhotoLibraryPlugin)
public class PhotoLibraryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoLibraryPlugin"
    public let jsName = "PhotoLibrary"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    private let imageManager = PHCachingImageManager()
    private let fm = FileManager.default
    private lazy var thumbDir: URL = makeDir("thumbs")
    private lazy var fullDir: URL = makeDir("full")

    private func makeDir(_ name: String) -> URL {
        let base = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("photo-cache/\(name)", isDirectory: true)
        try? fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    override public func load() {
        // Full-size copies are only needed while swiping; start fresh each launch.
        try? fm.removeItem(at: fullDir)
        try? fm.createDirectory(at: fullDir, withIntermediateDirectories: true)
    }

    private static func statusName(_ s: PHAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "granted"
        case .limited: return "limited"
        case .denied, .restricted: return "denied"
        default: return "prompt"
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
            let result = PHAsset.fetchAssets(with: .image, options: opts)
            var items: [[String: Any]] = []
            items.reserveCapacity(result.count)
            result.enumerateObjects { asset, _, _ in
                items.append([
                    "id": asset.localIdentifier,
                    "taken": (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000,
                    "width": asset.pixelWidth,
                    "height": asset.pixelHeight,
                ])
            }
            call.resolve(["photos": items])
        }
    }

    /// Writes a JPEG of the photo (longest side ~size px) to the cache and returns its file URL.
    @objc func getImage(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required") }
        let size = max(64, call.getInt("size") ?? 400)
        let isThumb = size <= 600
        let safe = id.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined()
        let file = (isThumb ? thumbDir : fullDir).appendingPathComponent("\(safe)_\(size).jpg")
        if fm.fileExists(atPath: file.path) {
            return call.resolve(["path": file.absoluteString])
        }
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            return call.reject("Photo not found")
        }
        let opts = PHImageRequestOptions()
        opts.deliveryMode = .highQualityFormat
        opts.resizeMode = .fast
        opts.isNetworkAccessAllowed = true   // photos stored in iCloud
        opts.isSynchronous = false
        let target = CGSize(width: size, height: size)
        imageManager.requestImage(for: asset, targetSize: target, contentMode: isThumb ? .aspectFill : .aspectFit, options: opts) { image, _ in
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

    /// Deletes photos from the library. iOS always shows its own confirmation;
    /// deleted photos go to the Photos app's "Recently Deleted" album.
    @objc func deletePhotos(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") ?? []).compactMap { $0 as? String }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        if assets.count == 0 {
            // Already gone from the library (e.g. deleted in Photos).
            return call.resolve(["deleted": true])
        }
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(assets)
        }) { success, error in
            if success {
                call.resolve(["deleted": true])
            } else {
                call.resolve(["deleted": false, "error": error?.localizedDescription ?? "Cancelled"])
            }
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
