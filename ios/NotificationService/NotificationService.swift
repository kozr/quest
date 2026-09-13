import UserNotifications
import ImageIO
import UniformTypeIdentifiers

final class NotificationService: UNNotificationServiceExtension, URLSessionDownloadDelegate {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private var session: URLSession?
    private static let maximumBytes: Int64 = 5 * 1024 * 1024

    static func iconURL(_ value: Any?) -> URL? {
        guard let value = value as? String, let url = URL(string: value),
              url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil, let host = url.host?.lowercased(),
              host == "mzstatic.com" || host.hasSuffix(".mzstatic.com") else { return nil }
        return url
    }

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        handler = contentHandler
        original = request.content
        lock.unlock()
        guard let url = Self.iconURL(request.content.userInfo["appIconUrl"]) else {
            finish()
            return
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 10
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let downloadSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        lock.lock()
        guard handler != nil else {
            lock.unlock()
            downloadSession.invalidateAndCancel()
            return
        }
        session = downloadSession
        lock.unlock()
        downloadSession.downloadTask(with: url).resume()
    }

    override func serviceExtensionTimeWillExpire() { finish() }

    // Redirects are unnecessary for stored artwork URLs; fall back to text if one occurs.
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        finish()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > Self.maximumBytes || totalBytesExpectedToWrite > Self.maximumBytes { finish() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil { finish() }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let response = downloadTask.response as? HTTPURLResponse,
              response.statusCode == 200,
              let size = try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size > 0, size <= Self.maximumBytes else { finish(); return }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let attachment = try Self.makeAttachment(from: location, in: directory)
            // Keep the file available until iOS consumes the attachment after the callback.
            finish(attachment: attachment)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            finish()
        }
    }

    static func makeAttachment(from sourceURL: URL, in directory: URL) throws -> UNNotificationAttachment {
        guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 256,
                kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary) else { throw CocoaError(.fileReadCorruptFile) }
        let destinationURL = directory.appendingPathComponent("app-icon.png")
        guard let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { throw CocoaError(.fileWriteUnknown) }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
        return try UNNotificationAttachment(identifier: "app-icon", url: destinationURL, options: nil)
    }

    private func finish(attachment: UNNotificationAttachment? = nil) {
        lock.lock()
        guard let callback = handler, let content = original else { lock.unlock(); return }
        handler = nil
        original = nil
        let downloadSession = session
        session = nil
        lock.unlock()
        downloadSession?.invalidateAndCancel()
        if let attachment, let enriched = content.mutableCopy() as? UNMutableNotificationContent {
            enriched.attachments = [attachment]
            callback(enriched)
        } else {
            callback(content)
        }
    }
}
