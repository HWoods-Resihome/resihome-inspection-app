import Foundation
import WebKit
import BackgroundTasks

/// Drives the actual uploads: for each mirrored photo, POST /api/upload to get a
/// hosted URL, then POST /api/inspections/{id}/attach-photo to attach it — and for
/// each mirrored edit, replay its {endpoint, method, body}. These are the exact
/// calls the web makes (lib/photoUpload.ts + photoAttachOutbox.ts + offlineOutbox.ts),
/// so there's no second server contract. Idempotent on the server (attach dedupes
/// by URL; /api/upload dedupes by the dedupeKey-derived filename via RETURN_EXISTING;
/// answers upsert by answer_id_external), so racing the web foreground path can't
/// duplicate.
///
/// PHASE 3 (this file): a **background-configured URLSession** with file-backed
/// upload tasks + a delegate. Unlike the Phase-1 in-window async session, these
/// tasks survive app suspension/termination — iOS continues the transfer and
/// relaunches the app on completion (sessionSendsLaunchEvents) — so a photo whose
/// upload outlives the BGProcessingTask window still lands. State lives in
/// BgUploadStore (pending → uploaded → done); the delegate advances it as tasks
/// finish, keyed by each task's `taskDescription` ("upload:<id>" / "attach:<id>" /
/// "answer:<id>").
final class BgUploader: NSObject, URLSessionDataDelegate {
    static let shared = BgUploader()
    static let taskIdentifier = "com.resihome.resiwalk.bgupload.process"
    static let sessionIdentifier = "com.resihome.resiwalk.bgupload.session"

    var serverBase = URL(string: "https://resihome-inspection-app.vercel.app")!
    /// Set by AppDelegate.handleEventsForBackgroundURLSession; called when the
    /// session finishes delivering events after a background relaunch.
    var backgroundCompletionHandler: (() -> Void)?

    private let store = BgUploadStore.shared
    private let lock = NSLock()
    private var responseData: [Int: Data] = [:]   // taskId → accumulated body
    private var bodyTempFiles: [Int: URL] = [:]    // taskId → temp request-body file to delete

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: BgUploader.sessionIdentifier)
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.httpShouldSetCookies = true
        cfg.sessionSendsLaunchEvents = true   // relaunch the app to finish handling
        cfg.isDiscretionary = false           // upload promptly when possible
        cfg.allowsCellularAccess = true
        cfg.timeoutIntervalForResource = 60 * 60 * 24  // a day to complete on bad signal
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    /// Force the lazy session to initialize at launch so the background-session
    /// delegate is registered BEFORE iOS delivers any pending completion events.
    func activate() { _ = session }

    // MARK: Cookies
    /// Copy the webview's session cookies for our host into HTTPCookieStorage so
    /// the background URLSession authenticates (spec §6 — the main correctness
    /// risk). In a pure background relaunch the webview is nil and we rely on the
    /// last snapshot persisted in HTTPCookieStorage.shared.
    func refreshCookies(from webView: WKWebView?) {
        guard let webView = webView else { return }
        let host = serverBase.host
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            for c in cookies where host == nil || c.domain.contains(host!) || (host?.contains(c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain) ?? false) {
                HTTPCookieStorage.shared.setCookie(c)
            }
        }
    }

    // MARK: Scheduling
    func scheduleProcessing() {
        let request = BGProcessingTaskRequest(identifier: BgUploader.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        do { try BGTaskScheduler.shared.submit(request) }
        catch { NSLog("[BgUploader] schedule failed: \(error)") }
    }

    /// Called from the registered BGProcessingTask handler (see AppDelegate). We
    /// re-arm, enqueue any pending work onto the background session, then complete
    /// the BGTask — the background session keeps the transfers running on its own.
    func handleProcessingTask(_ task: BGProcessingTask) {
        scheduleProcessing()
        task.expirationHandler = { /* tasks live on in the background session */ }
        drain()
        task.setTaskCompleted(success: true)
    }

    // MARK: Drain — enqueue tasks for anything pending not already in flight
    func drain() {
        session.getAllTasks { existing in
            let active = Set(existing.compactMap { $0.taskDescription })
            // Answers first — an attach can depend on the answer record a replay
            // creates (same ordering rule the web uses).
            for a in self.store.pendingAnswers() where !active.contains("answer:\(a.id)") {
                self.startAnswer(a)
            }
            for p in self.store.pending() {
                if p.state == .uploaded, let url = p.uploadedUrl {
                    if !active.contains("attach:\(p.localId)") { self.startAttach(localId: p.localId, url: url) }
                } else {
                    if !active.contains("upload:\(p.localId)") { self.startUpload(p) }
                }
            }
        }
    }

    // MARK: Task starters (all use file-backed background upload tasks)
    private func absoluteURL(_ path: String) -> URL { URL(string: serverBase.absoluteString + path) ?? serverBase }

    private func writeTempBody(_ data: Data) -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bgu_\(UUID().uuidString).json")
        do { try data.write(to: url, options: .atomic); return url } catch { return nil }
    }

    private func startUpload(_ meta: BgPhotoMeta) {
        guard let bytes = store.bytes(for: meta.localId) else { store.remove(localId: meta.localId); return }
        let body: [String: Any] = [
            "filename": meta.filename,
            "contentType": "image/jpeg",
            "base64": bytes.base64EncodedString(),
            "dedupeKey": meta.localId,   // → same hosted URL as the foreground flush
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body), let tmp = writeTempBody(data) else { return }
        var req = URLRequest(url: absoluteURL("/api/upload"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: req, fromFile: tmp)
        task.taskDescription = "upload:\(meta.localId)"
        lock.lock(); bodyTempFiles[task.taskIdentifier] = tmp; lock.unlock()
        task.resume()
    }

    private func startAttach(localId: String, url: String) {
        guard let meta = store.photoMeta(localId) else { return }
        var body: [String: Any] = ["url": url, "target": meta.target]
        if let r = meta.replacesUrl { body["replacesUrl"] = r }
        guard let data = try? JSONSerialization.data(withJSONObject: body), let tmp = writeTempBody(data) else { return }
        var req = URLRequest(url: absoluteURL("/api/inspections/\(meta.inspectionRecordId)/attach-photo"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: req, fromFile: tmp)
        task.taskDescription = "attach:\(localId)"
        lock.lock(); bodyTempFiles[task.taskIdentifier] = tmp; lock.unlock()
        task.resume()
    }

    private func startAnswer(_ meta: BgAnswerMeta) {
        guard let tmp = writeTempBody(meta.bodyJSON.data(using: .utf8) ?? Data()) else { return }
        var req = URLRequest(url: absoluteURL(meta.endpoint))
        req.httpMethod = meta.method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: req, fromFile: tmp)
        task.taskDescription = "answer:\(meta.id)"
        lock.lock(); bodyTempFiles[task.taskIdentifier] = tmp; lock.unlock()
        task.resume()
    }

    // MARK: URLSession delegate
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); responseData[dataTask.taskIdentifier, default: Data()].append(data); lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let id = task.taskIdentifier
        lock.lock()
        let data = responseData.removeValue(forKey: id) ?? Data()
        if let tmp = bodyTempFiles.removeValue(forKey: id) { try? FileManager.default.removeItem(at: tmp) }
        lock.unlock()

        let desc = task.taskDescription ?? ""
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? -1
        // Transport error (no HTTP response) → offline/transient: leave the work
        // queued; the next drain re-enqueues it.
        if error != nil && status < 0 { return }

        let parts = desc.split(separator: ":", maxSplit: 1).map(String.init)
        guard parts.count == 2 else { return }
        let kind = parts[0], key = parts[1]

        switch kind {
        case "upload":
            switch classify(status) {
            case .ok:
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let url = obj["url"] as? String, !url.isEmpty,
                   var meta = store.photoMeta(key) {
                    meta.uploadedUrl = url; meta.state = .uploaded; store.updateMeta(meta)
                    startAttach(localId: key, url: url)   // chain straight into the attach
                }
            case .permanent: store.remove(localId: key)
            case .authOrTransient: break                  // keep; retry next drain
            }
        case "attach":
            switch classify(status) {
            case .ok:
                // { deferred: true } → parent record not synced yet; keep & retry.
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   (obj["deferred"] as? Bool) == true { return }
                if let meta = store.photoMeta(key), let url = meta.uploadedUrl {
                    store.complete(localId: key, url: url)
                } else {
                    store.remove(localId: key)
                }
            case .permanent: store.remove(localId: key)
            case .authOrTransient: break
            }
        case "answer":
            switch classify(status) {
            case .ok: store.completeAnswer(id: key)
            case .permanent: store.removeAnswer(id: key)
            case .authOrTransient: break
            }
        default: break
        }
    }

    /// iOS finished delivering background events after a relaunch — let the system
    /// know we're done so it can snapshot/suspend the app.
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            let handler = self.backgroundCompletionHandler
            self.backgroundCompletionHandler = nil
            handler?()
        }
    }

    private enum Outcome { case ok, permanent, authOrTransient }
    private func classify(_ status: Int) -> Outcome {
        switch status {
        case 200..<300: return .ok
        case 429: return .authOrTransient
        case 401, 403: return .authOrTransient
        case 400..<500: return .permanent
        default: return .authOrTransient   // 5xx / unknown → retry
        }
    }
}
