import Foundation
import WebKit
import BackgroundTasks

/// Drives the actual uploads: for each mirrored photo, POST /api/upload to get a
/// hosted URL, then POST /api/inspections/{id}/attach-photo to attach it — the
/// exact two calls the web makes (lib/photoUpload.ts + lib/photoAttachOutbox.ts),
/// so there's no second server contract. Idempotent on the server (attach dedupes
/// by URL), so racing the web foreground path can't double-attach.
///
/// Phase 1 runs uploads with async URLSession inside the granted execution window
/// (a BGProcessingTask window, or a UIApplication background-task assertion when
/// the app is backgrounded). That covers the dominant field case — signal returns
/// and iOS grants a window. HARDENING (phase 3, see spec §7/§12): switch to a
/// background-configured URLSession with file-backed upload/download tasks so a
/// transfer that outlives the window survives suspension; the store + state
/// machine here are already shaped for it.
final class BgUploader {
    static let shared = BgUploader()
    static let taskIdentifier = "com.resihome.resiwalk.bgupload.process"

    var serverBase = URL(string: "https://resihome-inspection-app.vercel.app")!
    private let store = BgUploadStore.shared
    private let q = DispatchQueue(label: "com.resihome.resiwalk.bgupload.uploader")
    private var draining = false

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = HTTPCookieStorage.shared
        cfg.httpShouldSetCookies = true
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 60 * 10
        return URLSession(configuration: cfg)
    }()

    // MARK: Cookies
    /// Copy the webview's session cookies for our host into HTTPCookieStorage so
    /// the native URLSession authenticates. Without this every POST 401s and the
    /// queue silently stalls (spec §6 — the single biggest correctness risk).
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

    /// Called from the registered BGProcessingTask handler (see AppDelegate).
    func handleProcessingTask(_ task: BGProcessingTask) {
        scheduleProcessing() // re-arm so it keeps firing while work remains
        let work = Task { await self.drainAsync() }
        task.expirationHandler = { work.cancel() }
        Task {
            _ = await work.value
            task.setTaskCompleted(success: true)
        }
    }

    // MARK: Drain
    /// Fire-and-forget drain (foreground/background-grace kick).
    func drain() {
        q.async {
            if self.draining { return }
            self.draining = true
            Task {
                await self.drainAsync()
                self.q.async { self.draining = false }
            }
        }
    }

    /// Drain everything pending. ANSWERS first, then photos — an attach can depend
    /// on the answer record an answer-replay creates (same ordering rule the web
    /// uses). Stops early on offline / auth failure (keeps work for the next
    /// window). Never throws.
    func drainAsync() async {
        await drainAnswers()
        if Task.isCancelled { return }
        let items = store.pending()
        for var meta in items {
            if Task.isCancelled { break }
            // 1) Upload bytes → hosted URL (skip if already uploaded last run).
            if meta.state == .pending || meta.uploadedUrl == nil {
                guard let bytes = store.bytes(for: meta.localId) else { store.remove(localId: meta.localId); continue }
                switch await uploadBytes(filename: meta.filename, jpeg: bytes) {
                case .success(let url):
                    meta.uploadedUrl = url; meta.state = .uploaded; store.updateMeta(meta)
                case .authFailure, .offline:
                    return // keep everything; retry next window
                case .permanentFailure:
                    store.remove(localId: meta.localId); continue // poison — drop (logged)
                case .transient:
                    return // retry next window
                }
            }
            // 2) Attach hosted URL → record (idempotent; may DEFER until the
            //    answer record exists — keep & retry, never treat as done).
            guard let url = meta.uploadedUrl else { continue }
            switch await attach(inspectionRecordId: meta.inspectionRecordId, url: url, replacesUrl: meta.replacesUrl, target: meta.target) {
            case .doneAttached:
                store.complete(localId: meta.localId, url: url)
            case .deferred, .transient:
                continue // keep uploaded state; retry next window
            case .authFailure, .offline:
                return
            case .permanentFailure:
                store.remove(localId: meta.localId)
            }
        }
    }

    /// Replay every pending answer/edit entry, oldest first (idempotent upserts).
    private func drainAnswers() async {
        for meta in store.pendingAnswers() {
            if Task.isCancelled { return }
            switch await replayAnswer(meta) {
            case .doneAttached:
                store.completeAnswer(id: meta.id)
            case .authFailure, .offline:
                return // keep everything; retry next window
            case .permanentFailure:
                store.removeAnswer(id: meta.id) // poison — drop (logged)
            case .deferred, .transient:
                return // retry next window
            }
        }
    }

    // MARK: HTTP
    private enum UploadResult { case success(String); case offline; case authFailure; case transient; case permanentFailure }
    private enum AttachResult { case doneAttached; case deferred; case offline; case authFailure; case transient; case permanentFailure }

    /// Build an absolute URL from a server-relative path (endpoints come in as
    /// full paths like "/api/upload" or "/api/inspections/123/answers").
    private func absoluteURL(_ path: String) -> URL {
        return URL(string: serverBase.absoluteString + path) ?? serverBase
    }

    private func replayAnswer(_ meta: BgAnswerMeta) async -> AttachResult {
        var req = URLRequest(url: absoluteURL(meta.endpoint))
        req.httpMethod = meta.method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = meta.bodyJSON.data(using: .utf8)
        do {
            let (_, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return .transient }
            switch http.statusCode {
            case 200..<300: return .doneAttached
            case 401, 403: return .authFailure
            case 429: return .transient
            case 400..<500: return .permanentFailure
            default: return .transient
            }
        } catch {
            return .offline
        }
    }

    private func uploadBytes(filename: String, jpeg: Data) async -> UploadResult {
        var req = URLRequest(url: absoluteURL("/api/upload"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["filename": filename, "contentType": "image/jpeg", "base64": jpeg.base64EncodedString()]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return .transient }
            switch http.statusCode {
            case 200..<300:
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let url = obj["url"] as? String { return .success(url) }
                return .transient
            case 401, 403: return .authFailure
            case 429: return .transient
            case 400..<500: return .permanentFailure
            default: return .transient
            }
        } catch {
            return .offline
        }
    }

    private func attach(inspectionRecordId: String, url: String, replacesUrl: String?, target: [String: String]) async -> AttachResult {
        var req = URLRequest(url: absoluteURL("/api/inspections/\(inspectionRecordId)/attach-photo"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["url": url, "target": target]
        if let r = replacesUrl { body["replacesUrl"] = r }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return .transient }
            switch http.statusCode {
            case 200..<300:
                // The endpoint returns { deferred: true } when the parent record
                // doesn't exist yet (answer outbox hasn't synced) — keep & retry.
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   (obj["deferred"] as? Bool) == true { return .deferred }
                return .doneAttached
            case 401, 403: return .authFailure
            case 429: return .transient
            case 400..<500: return .permanentFailure
            default: return .transient
            }
        } catch {
            return .offline
        }
    }
}
