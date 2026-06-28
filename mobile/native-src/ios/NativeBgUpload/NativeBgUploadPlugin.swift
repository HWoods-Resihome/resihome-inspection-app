import Foundation
import Capacitor

/// NativeBgUpload — the iOS half of ResiWALK's force-quit background photo upload.
///
/// The web app (lib/nativeBridge.ts → lib/offlinePhotoStore.ts) mirrors every
/// queued photo's already-compressed JPEG bytes + attach target here the moment
/// it's captured. This plugin persists them and drives a BGProcessingTask-backed
/// uploader that POSTs to the SAME endpoints the web uses (/api/upload then
/// /api/inspections/{id}/attach-photo), so photos land even after the app is
/// swiped away — the one gap the web foreground sync can't cover on iOS (WebKit
/// has no Background Sync API). See mobile/IOS_BACKGROUND_UPLOAD_SPEC.md.
///
/// Capacitor 6 registers this via CAPBridgedPlugin (no .m bridge file needed).
@objc(NativeBgUploadPlugin)
public class NativeBgUploadPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeBgUploadPlugin"
    public let jsName = "NativeBgUpload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "mirrorPhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearPhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reconcile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleProcessing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mirrorAnswer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAnswer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reconcileAnswers", returnType: CAPPluginReturnPromise)
    ]

    private let store = BgUploadStore.shared
    private lazy var uploader = BgUploader.shared

    /// The web app's origin to POST to. Read from the live webview URL (so it
    /// follows server.url / a future resiwalk.com switch) with a constant
    /// fallback that matches mobile/capacitor.config.ts.
    private func serverBase() -> URL {
        if let u = self.webView?.url, let scheme = u.scheme, let host = u.host {
            var c = URLComponents()
            c.scheme = scheme
            c.host = host
            if let port = u.port { c.port = port }
            if let url = c.url { return url }
        }
        return URL(string: "https://resihome-inspection-app.vercel.app")!
    }

    public override func load() {
        // Seed the uploader with the server origin + a cookie snapshot so a later
        // background task can authenticate even if the webview is gone by then.
        uploader.serverBase = serverBase()
        uploader.refreshCookies(from: self.webView)
        // Register the background-session delegate now so iOS can deliver any
        // pending completion events (from a transfer that finished while the app
        // was suspended) as soon as we're back.
        uploader.activate()
    }

    @objc func mirrorPhoto(_ call: CAPPluginCall) {
        guard
            let localId = call.getString("localId"),
            let inspectionRecordId = call.getString("inspectionRecordId"),
            let base64 = call.getString("base64"),
            let filename = call.getString("filename"),
            let bytes = Data(base64Encoded: base64)
        else {
            call.reject("mirrorPhoto: missing localId/inspectionRecordId/base64/filename")
            return
        }
        // Flatten the PhotoAttachTarget to [String:String] (all its fields are
        // strings: kind, externalId, field, section, location, summaryLabel, fcSlot).
        var target: [String: String] = [:]
        if let raw = call.getObject("target") {
            for (k, v) in raw {
                if let s = v as? String { target[k] = s }
            }
        }
        let replacesUrl = call.getString("replacesUrl")
        let meta = BgPhotoMeta(
            localId: localId,
            inspectionRecordId: inspectionRecordId,
            filename: filename,
            replacesUrl: replacesUrl,
            target: target,
            state: .pending,
            uploadedUrl: nil
        )
        store.savePhoto(meta: meta, bytes: bytes)
        // Keep the cookie snapshot fresh while the app is alive, then ask iOS for
        // a processing window AND kick an immediate drain (common case: signal is
        // back within seconds and we're still foreground/background-grace).
        uploader.refreshCookies(from: self.webView)
        uploader.scheduleProcessing()
        uploader.drain()
        call.resolve()
    }

    @objc func clearPhoto(_ call: CAPPluginCall) {
        guard let localId = call.getString("localId") else { call.reject("clearPhoto: missing localId"); return }
        store.remove(localId: localId)
        call.resolve()
    }

    /// Return (and clear) the list of photos the background uploader has fully
    /// uploaded + attached since the last reconcile, so the web can drop the
    /// matching IndexedDB drafts.
    @objc func reconcile(_ call: CAPPluginCall) {
        let completed = store.drainCompletedLog() // [(localId, url)]
        let done = completed.map { ["localId": $0.localId, "url": $0.url] }
        call.resolve(["done": done])
    }

    @objc func scheduleProcessing(_ call: CAPPluginCall) {
        uploader.refreshCookies(from: self.webView)
        uploader.scheduleProcessing()
        uploader.drain()
        call.resolve()
    }

    // MARK: - Phase 2: answers / edits

    @objc func mirrorAnswer(_ call: CAPPluginCall) {
        guard
            let id = call.getString("id"),
            let inspectionRecordId = call.getString("inspectionRecordId"),
            let endpoint = call.getString("endpoint"),
            let method = call.getString("method")
        else {
            call.reject("mirrorAnswer: missing id/inspectionRecordId/endpoint/method")
            return
        }
        // Serialize the arbitrary body object/array back to a JSON string.
        var bodyJSON = "{}"
        if let body = call.getObject("body"),
           let data = try? JSONSerialization.data(withJSONObject: body),
           let s = String(data: data, encoding: .utf8) {
            bodyJSON = s
        } else if let arr = call.getArray("body"),
                  let data = try? JSONSerialization.data(withJSONObject: arr),
                  let s = String(data: data, encoding: .utf8) {
            bodyJSON = s
        }
        store.saveAnswer(BgAnswerMeta(id: id, inspectionRecordId: inspectionRecordId, endpoint: endpoint, method: method, bodyJSON: bodyJSON))
        uploader.refreshCookies(from: self.webView)
        uploader.scheduleProcessing()
        uploader.drain()
        call.resolve()
    }

    @objc func clearAnswer(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("clearAnswer: missing id"); return }
        store.removeAnswer(id: id)
        call.resolve()
    }

    @objc func reconcileAnswers(_ call: CAPPluginCall) {
        let ids = store.drainAnswersCompletedLog()
        call.resolve(["ids": ids])
    }
}
