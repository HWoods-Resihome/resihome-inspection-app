import Foundation

/// Persistence for mirrored photos awaiting background upload+attach.
///
/// Layout (Application Support/bgupload/):
///   <localId>.jpg    — the already-compressed JPEG bytes (uploaded as-is; the
///                      web already stamped + compressed them, never re-compress)
///   <localId>.json   — BgPhotoMeta (state machine: pending → uploaded → done)
///   completed.json   — append log of {localId, url} fully uploaded+attached,
///                      held until the web reconciles (then cleared)
///
/// At field volumes (tens of photos) a directory scan is fine; no index needed.
/// Thread-safety: all mutations are serialized on a private queue.
struct BgPhotoMeta: Codable {
    enum State: String, Codable { case pending, uploaded }
    let localId: String
    let inspectionRecordId: String
    let filename: String
    let replacesUrl: String?
    let target: [String: String]   // flattened PhotoAttachTarget (string values)
    var state: State
    var uploadedUrl: String?
}

struct CompletedEntry: Codable { let localId: String; let url: String }

final class BgUploadStore {
    static let shared = BgUploadStore()
    private let q = DispatchQueue(label: "com.resihome.resiwalk.bgupload.store")
    private let fm = FileManager.default

    private var dir: URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("bgupload", isDirectory: true)
        if !fm.fileExists(atPath: d.path) {
            try? fm.createDirectory(at: d, withIntermediateDirectories: true)
            // Don't back the queue up to iCloud.
            var u = d; var rv = URLResourceValues(); rv.isExcludedFromBackup = true
            try? u.setResourceValues(rv)
        }
        return d
    }
    private func jpg(_ id: String) -> URL { dir.appendingPathComponent("\(id).jpg") }
    private func json(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }
    private var completedLog: URL { dir.appendingPathComponent("completed.json") }

    func savePhoto(meta: BgPhotoMeta, bytes: Data) {
        q.sync {
            try? bytes.write(to: jpg(meta.localId), options: .atomic)
            writeMeta(meta)
        }
    }

    private func writeMeta(_ meta: BgPhotoMeta) {
        if let data = try? JSONEncoder().encode(meta) {
            try? data.write(to: json(meta.localId), options: .atomic)
        }
    }

    func updateMeta(_ meta: BgPhotoMeta) { q.sync { writeMeta(meta) } }

    func bytes(for localId: String) -> Data? { q.sync { try? Data(contentsOf: jpg(localId)) } }

    /// All pending/uploaded photos, oldest first (by file creation date).
    func pending() -> [BgPhotoMeta] {
        q.sync {
            guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey]) else { return [] }
            let metas = files.filter { $0.pathExtension == "json" && $0.lastPathComponent != "completed.json" }
                .compactMap { url -> (BgPhotoMeta, Date)? in
                    guard let d = try? Data(contentsOf: url),
                          let m = try? JSONDecoder().decode(BgPhotoMeta.self, from: d) else { return nil }
                    let created = (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date.distantPast
                    return (m, created)
                }
            return metas.sorted { $0.1 < $1.1 }.map { $0.0 }
        }
    }

    func remove(localId: String) {
        q.sync {
            try? fm.removeItem(at: jpg(localId))
            try? fm.removeItem(at: json(localId))
        }
    }

    /// Mark a photo fully uploaded+attached: delete its files and append to the
    /// completed log for the web to reconcile.
    func complete(localId: String, url: String) {
        q.sync {
            try? fm.removeItem(at: jpg(localId))
            try? fm.removeItem(at: json(localId))
            var log = readCompleted()
            log.append(CompletedEntry(localId: localId, url: url))
            if let data = try? JSONEncoder().encode(log) {
                try? data.write(to: completedLog, options: .atomic)
            }
        }
    }

    private func readCompleted() -> [CompletedEntry] {
        guard let d = try? Data(contentsOf: completedLog),
              let l = try? JSONDecoder().decode([CompletedEntry].self, from: d) else { return [] }
        return l
    }

    /// Return and clear the completed log (called by reconcile()).
    func drainCompletedLog() -> [CompletedEntry] {
        q.sync {
            let l = readCompleted()
            try? fm.removeItem(at: completedLog)
            return l
        }
    }
}
