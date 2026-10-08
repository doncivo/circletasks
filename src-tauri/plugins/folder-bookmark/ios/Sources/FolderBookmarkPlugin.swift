// Plugin folder-bookmark de CircleTasks (ADR 0011 §6.3 et §22 ; Y-IOS-01).
//
// Contrat : tests/fixtures/sync/folder-bookmark-contract.json (noms, champs, codes), relu par un contrôle statique contre ce fichier et
// src-tauri/src/sync/bookmark.rs. Seul Rust appelle ces commandes (aucune permission pour la WebView).
//
// Règles :
// - aucune chaîne d'interface ni libellé ici : les textes viennent de Rust (src/i18n/native/fr.json) ;
// - rejet = un code du contrat (`invoke.reject(code, code: code)`), jamais un chemin ni le texte d'une erreur système ;
// - travail de fichier sur une file dédiée (`fileQueue`), jamais sur la file IPC partagée de Tauri ni sur le fil principal ;
//   sélecteur, état de l'app et tâche d'arrière-plan sur le fil principal ;
// - chaque composant sous la racine est ouvert par `openat(..., O_NOFOLLOW)` en chaîne, à chaque appel ; lien, type inattendu,
//   fichier à plusieurs liens physiques en écriture : `unsafe-folder`, rien n'est lu ni écrit ; les entrées-sorties se font sur le
//   descripteur obtenu ;
// - toute opération se fait sous l'accès de sécurité de la racine (ouvert pour la session) et dans `NSFileCoordinator`.

import Darwin
import Foundation
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

// MARK: - Codes et arguments

private enum Code: String {
  case notConfigured = "not-configured"
  case folderUnreachable = "folder-unreachable"
  case unsafeFolder = "unsafe-folder"
  case cloudPending = "cloud-pending"
  case cloudError = "cloud-error"
  case tooLarge = "too-large"
  case notForeground = "not-foreground"
  case io = "io"
}

private struct Failure: Error {
  let code: Code
}

struct ResolveArgs: Decodable {
  let bookmark: String
}

struct StatusArgs: Decodable {
  let path: [String]
}

struct ListArgs: Decodable {
  let path: [String]
  let max: Int
}

struct ReadFromArgs: Decodable {
  let path: [String]
  let offset: Int64
  let max: Int
  let limit: Int64
}

struct DownloadArgs: Decodable {
  let path: [String]
  let timeoutMs: Int
  let limit: Int64
}

struct AppendArgs: Decodable {
  let path: [String]
  let data: String
  let createNew: Bool
}

struct WriteAtomicArgs: Decodable {
  let path: [String]
  let data: String
}

struct RenameArgs: Decodable {
  let dir: [String]
  let from: String
  let to: String
}

struct PathArgs: Decodable {
  let path: [String]
}

/// Confirmation native (ADR 0011 §23 point 3) : tous les textes viennent de Rust (src/i18n/native/fr.json).
struct ConfirmArgs: Decodable {
  let title: String
  let message: String
  let confirm: String
  let cancel: String
}

// MARK: - Sélecteur de dossier

private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
  let onPick: ([URL]) -> Void
  let onCancel: () -> Void

  init(onPick: @escaping ([URL]) -> Void, onCancel: @escaping () -> Void) {
    self.onPick = onPick
    self.onCancel = onCancel
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    onPick(urls)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    onCancel()
  }
}

// MARK: - Plugin

class FolderBookmarkPlugin: Plugin {
  /// File des opérations de fichier (série : une opération à la fois, dans l'ordre des appels de Rust).
  private let fileQueue = DispatchQueue(label: "fr.circletasks.folder-bookmark.files")
  /// Racine résolue pour la session (accès de sécurité ouvert) ; lue et écrite sur `fileQueue` seulement.
  private var root: URL?
  private var rootPath: String?
  /// Sélecteur en cours (fil principal).
  private var picker: PickerDelegate?
  /// Tâche d'arrière-plan et minuteur de garde (fil principal).
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var backgroundGuard: DispatchWorkItem?
  /// Fin forcée de la tâche d'arrière-plan, au plus tard 28 s après son ouverture (§22 point 6).
  private let backgroundGuardSeconds: Double = 28
  /// Sondage de l'état de téléchargement (ms).
  private let downloadPollMs: Int = 250
  /// Alerte de confirmation affichée et sa réponse (fil principal) : fermée et rendue comme refus au passage en arrière-plan.
  private var pendingAlert: UIAlertController?
  private var pendingAnswer: ((Bool) -> Void)?

  // MARK: Cycle de vie et tâche d'arrière-plan

  @objc public override func load(webview: WKWebView) {
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(appWillResignActive),
      name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(
      self, selector: #selector(appDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
  }

  /// Passage en arrière-plan : une alerte de confirmation ouverte est fermée et vaut refus (échec fermé).
  @objc private func appDidEnterBackground() {
    if Thread.isMainThread {
      dismissPendingAlert()
    } else {
      DispatchQueue.main.async { self.dismissPendingAlert() }
    }
  }

  private func dismissPendingAlert() {
    guard let alert = pendingAlert, let answer = pendingAnswer else {
      return
    }
    alert.dismiss(animated: false, completion: nil)
    answer(false)
  }

  /// Passage en arrière-plan : la tâche est ouverte avant que la WebView soit suspendue ; le moteur borne son cycle à 25 s.
  @objc private func appWillResignActive() {
    if Thread.isMainThread {
      beginBackgroundTask()
    } else {
      DispatchQueue.main.async { self.beginBackgroundTask() }
    }
  }

  @objc private func appDidBecomeActive() {
    if Thread.isMainThread {
      endBackgroundTask()
    } else {
      DispatchQueue.main.async { self.endBackgroundTask() }
    }
  }

  private func beginBackgroundTask() {
    if backgroundTask != .invalid {
      return
    }
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "ct-sync") { [weak self] in
      self?.endBackgroundTask()
    }
    if backgroundTask == .invalid {
      return
    }
    let item = DispatchWorkItem { [weak self] in
      self?.endBackgroundTask()
    }
    backgroundGuard = item
    DispatchQueue.main.asyncAfter(deadline: .now() + backgroundGuardSeconds, execute: item)
  }

  private func endBackgroundTask() {
    backgroundGuard?.cancel()
    backgroundGuard = nil
    if backgroundTask != .invalid {
      let task = backgroundTask
      backgroundTask = .invalid
      UIApplication.shared.endBackgroundTask(task)
    }
  }

  // MARK: Outils communs

  private func reject(_ invoke: Invoke, _ code: Code) {
    invoke.reject(code.rawValue, code: code.rawValue)
  }

  /// Exécute `body` sur la file des fichiers ; une `Failure` devient son code, toute autre erreur `io`.
  private func onFiles(_ invoke: Invoke, _ body: @escaping () throws -> JsonObject) {
    fileQueue.async {
      do {
        let result = try body()
        invoke.resolve(result)
      } catch let failure as Failure {
        self.reject(invoke, failure.code)
      } catch {
        self.reject(invoke, .io)
      }
    }
  }

  /// Arguments décodés, sinon `io` (jamais le texte du décodeur).
  private func args<T: Decodable>(_ invoke: Invoke, _ type: T.Type) -> T? {
    do {
      return try invoke.parseArgs(type)
    } catch {
      reject(invoke, .io)
      return nil
    }
  }

  /// Composant sûr : non vide, ni `.`, ni `..`, sans `/` ni NUL.
  private func checkComponent(_ part: String) throws {
    if part.isEmpty || part == "." || part == ".." || part.contains("/") || part.contains("\0") {
      throw Failure(code: .unsafeFolder)
    }
  }

  /// Chemin canonique d'une URL de fichier (même règle au choix et à la résolution du signet).
  private func canonicalPath(_ url: URL) -> String {
    return url.standardizedFileURL.resolvingSymlinksInPath().path
  }

  private func isDirectory(_ mode: mode_t) -> Bool {
    return (mode & S_IFMT) == S_IFDIR
  }

  private func isRegular(_ mode: mode_t) -> Bool {
    return (mode & S_IFMT) == S_IFREG
  }

  private func isLink(_ mode: mode_t) -> Bool {
    return (mode & S_IFMT) == S_IFLNK
  }

  /// Code d'une erreur système : lien ou type inattendu → `unsafe-folder` ; le reste → `io`.
  private func codeOf(_ error: Int32) -> Code {
    switch error {
    case ELOOP, ENOTDIR, EMLINK, EISDIR:
      return .unsafeFolder
    default:
      return .io
    }
  }

  /// Racine de la session, recontrôlée : toujours un dossier, jamais un lien.
  private func sessionRoot() throws -> (URL, String) {
    guard let root = root, let path = rootPath else {
      throw Failure(code: .notConfigured)
    }
    var st = stat()
    if lstat(path, &st) != 0 {
      throw Failure(code: .folderUnreachable)
    }
    if isLink(st.st_mode) {
      throw Failure(code: .unsafeFolder)
    }
    if !isDirectory(st.st_mode) {
      throw Failure(code: .folderUnreachable)
    }
    return (root, path)
  }

  /// URL d'un élément sous la racine (métadonnées iCloud et coordination seulement ; les entrées-sorties passent par `openat`).
  private func itemURL(_ root: URL, _ parts: [String]) -> URL {
    var url = root
    for part in parts {
      url.appendPathComponent(part)
    }
    return url
  }

  /// Ouvre la racine, puis chaque dossier de `parts` par rapport au précédent, sans suivre de lien ; `create` : dossiers créés au
  /// besoin. Rend le descripteur du dernier dossier (à fermer), ou nil s'il manque un dossier.
  private func openDirectory(_ rootPath: String, _ parts: [String], create: Bool) throws -> Int32? {
    // Revue (audit) : la racine elle-même n'est jamais un lien suivi ; son type est contrôlé sur le descripteur ouvert.
    var fd = open(rootPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 {
      throw Failure(code: .folderUnreachable)
    }
    var rootStat = stat()
    if fstat(fd, &rootStat) != 0 || !isDirectory(rootStat.st_mode) {
      close(fd)
      throw Failure(code: .unsafeFolder)
    }
    for part in parts {
      do {
        try checkComponent(part)
      } catch {
        close(fd)
        throw error
      }
      var next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      if next < 0 && errno == ENOENT && create {
        if mkdirat(fd, part, 0o755) != 0 && errno != EEXIST {
          let error = errno
          close(fd)
          throw Failure(code: codeOf(error))
        }
        next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      }
      if next < 0 {
        let error = errno
        close(fd)
        if error == ENOENT {
          return nil
        }
        throw Failure(code: codeOf(error))
      }
      close(fd)
      var st = stat()
      if fstat(next, &st) != 0 || !isDirectory(st.st_mode) {
        close(next)
        throw Failure(code: .unsafeFolder)
      }
      fd = next
    }
    return fd
  }

  /// Dossier parent et nom d'un fichier.
  private func split(_ parts: [String]) throws -> ([String], String) {
    guard let name = parts.last else {
      throw Failure(code: .unsafeFolder)
    }
    try checkComponent(name)
    return (Array(parts.dropLast()), name)
  }

  /// Ancien emplacement d'un fichier resté dans le nuage : `.<nom>.icloud`.
  private func placeholderName(_ name: String) -> String {
    return "." + name + ".icloud"
  }

  private func placeholderTarget(_ name: String) -> String? {
    let prefix = "."
    let suffix = ".icloud"
    if name.count > prefix.count + suffix.count && name.hasPrefix(prefix) && name.hasSuffix(suffix) {
      return String(name.dropFirst(prefix.count).dropLast(suffix.count))
    }
    return nil
  }

  /// Revue (audit) : valide la chaîne de dossiers (`openDirectory`, sans lien) et le dernier composant (jamais un lien ni un fichier à
  /// plusieurs liens physiques) avant un appel par URL, qui suivrait les liens. Faux si un dossier de la chaîne manque.
  private func checkChain(_ rootPath: String, _ dir: [String], _ name: String) throws -> Bool {
    guard let dirFd = try openDirectory(rootPath, dir, create: false) else {
      return false
    }
    defer { close(dirFd) }
    var st = stat()
    if fstatat(dirFd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && (!isRegular(st.st_mode) || st.st_nlink > 1) {
      throw Failure(code: .unsafeFolder)
    }
    return true
  }

  /// Disponibilité locale d'un élément : `cloud` si iCloud ne l'a pas encore téléchargé, `error` si l'état est illisible.
  private func availability(_ url: URL) -> String {
    var item = url
    item.removeAllCachedResourceValues()
    guard
      let values = try? item.resourceValues(forKeys: [
        .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey,
      ])
    else {
      return "error"
    }
    if values.isUbiquitousItem != true {
      return "local"
    }
    if let status = values.ubiquitousItemDownloadingStatus, status != URLUbiquitousItemDownloadingStatus.current {
      return "cloud"
    }
    return "local"
  }

  /// Lecture coordonnée (`metadataOnly` : sans téléchargement).
  private func coordinatedRead<T>(_ url: URL, metadataOnly: Bool, _ body: @escaping () throws -> T) throws -> T {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var outcome: Result<T, Error>?
    let options: NSFileCoordinator.ReadingOptions = metadataOnly ? [.immediatelyAvailableMetadataOnly] : []
    coordinator.coordinate(readingItemAt: url, options: options, error: &coordinationError) { _ in
      outcome = Result<T, Error>(catching: { try body() })
    }
    if coordinationError != nil {
      throw Failure(code: .io)
    }
    guard let result = outcome else {
      throw Failure(code: .io)
    }
    return try result.get()
  }

  /// Écriture coordonnée (`replacing` : remplacement atomique).
  private func coordinatedWrite<T>(_ url: URL, replacing: Bool, _ body: @escaping () throws -> T) throws -> T {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var outcome: Result<T, Error>?
    let options: NSFileCoordinator.WritingOptions = replacing ? [.forReplacing] : []
    coordinator.coordinate(writingItemAt: url, options: options, error: &coordinationError) { _ in
      outcome = Result<T, Error>(catching: { try body() })
    }
    if coordinationError != nil {
      throw Failure(code: .io)
    }
    guard let result = outcome else {
      throw Failure(code: .io)
    }
    return try result.get()
  }

  /// Renommage coordonné (revue, audit) : source `forMoving`, destination `forReplacing`, le coordinateur prévenu du déplacement.
  private func coordinatedMove<T>(_ from: URL, _ to: URL, _ body: @escaping () throws -> T) throws -> T {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var outcome: Result<T, Error>?
    coordinator.coordinate(
      writingItemAt: from, options: .forMoving, writingItemAt: to, options: .forReplacing, error: &coordinationError
    ) { source, destination in
      coordinator.item(at: source, willMoveTo: destination)
      outcome = Result<T, Error>(catching: { try body() })
      if case .success = outcome {
        coordinator.item(at: source, didMoveTo: destination)
      }
    }
    if coordinationError != nil {
      throw Failure(code: .io)
    }
    guard let result = outcome else {
      throw Failure(code: .io)
    }
    return try result.get()
  }

  /// Écrit tous les octets sur `fd`, puis `fsync`.
  private func writeAll(_ fd: Int32, _ data: Data) throws {
    var written = 0
    let total = data.count
    if total > 0 {
      try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let base = raw.baseAddress else {
          throw Failure(code: .io)
        }
        while written < total {
          let n = write(fd, base.advanced(by: written), total - written)
          if n < 0 {
            if errno == EINTR {
              continue
            }
            throw Failure(code: .io)
          }
          written += n
        }
      }
    }
    if fsync(fd) != 0 {
      throw Failure(code: .io)
    }
  }

  // MARK: Signet

  /// Résout un signet, ouvre l'accès de sécurité de sa racine pour la session et la garde ; signet obsolète : nouveau signet rendu.
  private func resolveBookmark(_ data: Data) throws -> JsonObject {
    var stale = false
    let url: URL
    do {
      url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    } catch {
      throw Failure(code: .folderUnreachable)
    }
    let started = url.startAccessingSecurityScopedResource()
    var st = stat()
    if lstat(url.path, &st) != 0 {
      if started {
        url.stopAccessingSecurityScopedResource()
      }
      throw Failure(code: .folderUnreachable)
    }
    if isLink(st.st_mode) {
      if started {
        url.stopAccessingSecurityScopedResource()
      }
      throw Failure(code: .unsafeFolder)
    }
    if !isDirectory(st.st_mode) {
      if started {
        url.stopAccessingSecurityScopedResource()
      }
      throw Failure(code: .folderUnreachable)
    }
    let path = canonicalPath(url)
    // Jamais la racine d'un volume.
    if path.split(separator: "/").count <= 1 {
      if started {
        url.stopAccessingSecurityScopedResource()
      }
      throw Failure(code: .unsafeFolder)
    }
    var refreshed: Any = NSNull()
    if stale {
      if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        refreshed = fresh.base64EncodedString()
      }
    }
    var kind = "local"
    if let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey]), values.isUbiquitousItem == true {
      kind = "icloud"
    }
    if let previous = root, previous != url {
      previous.stopAccessingSecurityScopedResource()
    }
    root = url
    rootPath = path
    return ["path": path, "name": url.lastPathComponent, "kind": kind, "refreshed": refreshed]
  }

  @objc public func resolve(_ invoke: Invoke) {
    guard let input = args(invoke, ResolveArgs.self) else {
      return
    }
    onFiles(invoke) {
      guard let data = Data(base64Encoded: input.bookmark) else {
        throw Failure(code: .folderUnreachable)
      }
      return try self.resolveBookmark(data)
    }
  }

  /// Sélecteur de dossier (`UIDocumentPickerViewController`, dossiers seulement). La racine d'iCloud Drive choisie : `CircleTasks` y est
  /// créé puis lié (règle du PC, section 6.1).
  @objc public func pickFolder(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard var presenter = self.manager.viewController else {
        self.reject(invoke, .io)
        return
      }
      while let next = presenter.presentedViewController {
        presenter = next
      }
      let delegate = PickerDelegate(
        onPick: { urls in
          self.picker = nil
          guard let chosen = urls.first else {
            invoke.resolve(["cancelled": true])
            return
          }
          self.onFiles(invoke) {
            return try self.bindPicked(chosen)
          }
        },
        onCancel: {
          self.picker = nil
          invoke.resolve(["cancelled": true])
        })
      self.picker = delegate
      let controller = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
      controller.delegate = delegate
      controller.allowsMultipleSelection = false
      controller.modalPresentationStyle = .formSheet
      presenter.present(controller, animated: true, completion: nil)
    }
  }

  /// Dossier choisi : signet créé sous l'accès de sécurité, puis résolu comme au démarrage (même chemin canonique).
  private func bindPicked(_ chosen: URL) throws -> JsonObject {
    let started = chosen.startAccessingSecurityScopedResource()
    defer {
      if started {
        chosen.stopAccessingSecurityScopedResource()
      }
    }
    var target = chosen
    if chosen.lastPathComponent == "com~apple~CloudDocs" {
      let parentPath = chosen.path
      let child = "CircleTasks"
      guard let fd = try openDirectory(parentPath, [child], create: true) else {
        throw Failure(code: .io)
      }
      close(fd)
      target = chosen.appendingPathComponent(child, isDirectory: true)
    }
    let bookmark: Data
    do {
      bookmark = try target.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    } catch {
      throw Failure(code: .io)
    }
    var result = try resolveBookmark(bookmark)
    result.removeValue(forKey: "refreshed")
    result["bookmark"] = bookmark.base64EncodedString()
    return result
  }

  // MARK: Métadonnées

  /// État d'un fichier : présence, type, taille, disponibilité ; un ancien emplacement `.<nom>.icloud` vaut « dans le nuage ».
  @objc public func status(_ invoke: Invoke) {
    guard let input = args(invoke, StatusArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      let url = self.itemURL(root, input.path)
      return try self.coordinatedRead(url, metadataOnly: true) { () throws -> JsonObject in
        let absent: JsonObject = ["exists": false, "isDir": false, "size": NSNull(), "availability": "local"]
        if input.path.isEmpty {
          return ["exists": true, "isDir": true, "size": NSNull(), "availability": "local"]
        }
        let (dir, name) = try self.split(input.path)
        guard let fd = try self.openDirectory(rootPath, dir, create: false) else {
          return absent
        }
        defer { close(fd) }
        var st = stat()
        if fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0 {
          if errno != ENOENT {
            throw Failure(code: .io)
          }
          var placeholder = stat()
          if fstatat(fd, self.placeholderName(name), &placeholder, AT_SYMLINK_NOFOLLOW) == 0 && self.isRegular(placeholder.st_mode) {
            return ["exists": true, "isDir": false, "size": NSNull(), "availability": "cloud"]
          }
          return absent
        }
        if self.isLink(st.st_mode) {
          return ["exists": true, "isDir": false, "size": NSNull(), "availability": "error"]
        }
        let directory = self.isDirectory(st.st_mode)
        var size: Any = NSNull()
        if !directory {
          size = NSNumber(value: Int64(st.st_size))
        }
        return ["exists": true, "isDir": directory, "size": size, "availability": self.availability(url)]
      }
    }
  }

  /// Liste d'un dossier (`max` entrées au plus) ; un lien est listé `error` et n'est jamais suivi.
  @objc public func list(_ invoke: Invoke) {
    guard let input = args(invoke, ListArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      for part in input.path {
        try self.checkComponent(part)
      }
      let dirURL = self.itemURL(root, input.path)
      return try self.coordinatedRead(dirURL, metadataOnly: true) { () throws -> JsonObject in
        guard let fd = try self.openDirectory(rootPath, input.path, create: false) else {
          return ["missing": true]
        }
        defer { close(fd) }
        let copy = dup(fd)
        if copy < 0 {
          throw Failure(code: .io)
        }
        guard let stream = fdopendir(copy) else {
          close(copy)
          throw Failure(code: .io)
        }
        defer { closedir(stream) }
        var entries: [JsonObject] = []
        var truncated = false
        while let entry = readdir(stream) {
          var raw = entry.pointee.d_name
          let capacity = MemoryLayout.size(ofValue: raw)
          let name = withUnsafePointer(to: &raw) { (pointer) -> String in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { (chars) -> String in
              String(cString: chars)
            }
          }
          if name == "." || name == ".." {
            continue
          }
          if entries.count >= input.max {
            truncated = true
            break
          }
          var st = stat()
          if fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0 {
            continue
          }
          if let target = self.placeholderTarget(name), self.isRegular(st.st_mode) {
            entries.append(["name": target, "isDir": false, "size": NSNull(), "availability": "cloud"])
            continue
          }
          if self.isLink(st.st_mode) {
            entries.append(["name": name, "isDir": false, "size": NSNull(), "availability": "error"])
            continue
          }
          let directory = self.isDirectory(st.st_mode)
          var size: Any = NSNull()
          if !directory {
            size = NSNumber(value: Int64(st.st_size))
          }
          let state = directory ? "local" : self.availability(dirURL.appendingPathComponent(name))
          entries.append(["name": name, "isDir": directory, "size": size, "availability": state])
        }
        return ["entries": entries, "truncated": truncated]
      }
    }
  }

  // MARK: Lecture

  /// Lecture à partir d'un octet ; **jamais d'hydratation** : un fichier pas encore téléchargé rend `cloud-pending`.
  @objc public func readFrom(_ invoke: Invoke) {
    guard let input = args(invoke, ReadFromArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      if input.offset < 0 || input.max < 0 {
        throw Failure(code: .io)
      }
      let (dir, name) = try self.split(input.path)
      let url = self.itemURL(root, input.path)
      if try !self.checkChain(rootPath, dir, name) {
        return ["missing": true]
      }
      if self.availability(url) == "cloud" {
        throw Failure(code: .cloudPending)
      }
      return try self.coordinatedRead(url, metadataOnly: false) { () throws -> JsonObject in
        guard let dirFd = try self.openDirectory(rootPath, dir, create: false) else {
          return ["missing": true]
        }
        defer { close(dirFd) }
        let fd = openat(dirFd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
          let error = errno
          if error == ENOENT {
            var placeholder = stat()
            if fstatat(dirFd, self.placeholderName(name), &placeholder, AT_SYMLINK_NOFOLLOW) == 0 {
              throw Failure(code: .cloudPending)
            }
            return ["missing": true]
          }
          throw Failure(code: self.codeOf(error))
        }
        defer { close(fd) }
        var st = stat()
        // Revue (audit) : un fichier à plusieurs liens physiques est refusé en lecture comme en écriture.
        if fstat(fd, &st) != 0 || !self.isRegular(st.st_mode) || st.st_nlink > 1 {
          throw Failure(code: .unsafeFolder)
        }
        let size = Int64(st.st_size)
        // Taille annoncée contrôlée avant toute lecture.
        if size > input.limit {
          throw Failure(code: .tooLarge)
        }
        let remaining = max(Int64(0), size - input.offset)
        let want = Int(min(Int64(input.max), remaining))
        var buffer = [UInt8](repeating: 0, count: want)
        var got = 0
        if want > 0 {
          try buffer.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            guard let base = raw.baseAddress else {
              throw Failure(code: .io)
            }
            while got < want {
              let n = pread(fd, base.advanced(by: got), want - got, off_t(input.offset) + off_t(got))
              if n < 0 {
                if errno == EINTR {
                  continue
                }
                throw Failure(code: .io)
              }
              if n == 0 {
                break
              }
              got += n
            }
          }
        }
        let data = Data(buffer.prefix(got))
        let eof = got < input.max || input.offset + Int64(got) >= size
        return ["data": data.base64EncodedString(), "size": NSNumber(value: size), "eof": eof]
      }
    }
  }

  /// Téléchargement forcé (`startDownloadingUbiquitousItem`), sondé toutes les 250 ms jusqu'à `.current`, `timeoutMs` au plus.
  @objc public func download(_ invoke: Invoke) {
    guard let input = args(invoke, DownloadArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      let (dir, name) = try self.split(input.path)
      // Revue (audit) : chaîne de dossiers et fichier validés avant tout appel par URL ; dossier absent : rien à télécharger.
      if try !self.checkChain(rootPath, dir, name) {
        return [:]
      }
      let url = self.itemURL(root, input.path)
      var item = url
      item.removeAllCachedResourceValues()
      let values = try? item.resourceValues(forKeys: [
        .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .fileSizeKey, .totalFileSizeKey,
      ])
      // Taille annoncée au-delà de la borne : aucun téléchargement.
      let announced = values?.totalFileSize ?? values?.fileSize
      if let size = announced, Int64(size) > input.limit {
        throw Failure(code: .tooLarge)
      }
      if values?.isUbiquitousItem != true || values?.ubiquitousItemDownloadingStatus == URLUbiquitousItemDownloadingStatus.current {
        return [:]
      }
      do {
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
      } catch {
        throw Failure(code: .cloudError)
      }
      let deadline = Date().addingTimeInterval(Double(max(0, input.timeoutMs)) / 1000)
      while Date() < deadline {
        Thread.sleep(forTimeInterval: Double(self.downloadPollMs) / 1000)
        var probe = url
        probe.removeAllCachedResourceValues()
        guard
          let state = try? probe.resourceValues(forKeys: [
            .ubiquitousItemDownloadingStatusKey, .ubiquitousItemDownloadingErrorKey,
          ])
        else {
          continue
        }
        if state.ubiquitousItemDownloadingError != nil {
          throw Failure(code: .cloudError)
        }
        if state.ubiquitousItemDownloadingStatus == URLUbiquitousItemDownloadingStatus.current {
          return [:]
        }
      }
      throw Failure(code: .cloudPending)
    }
  }

  // MARK: Écriture

  /// Ajout en fin de fichier, puis `fsync`. `createNew` : le fichier ne doit pas exister.
  @objc public func append(_ invoke: Invoke) {
    guard let input = args(invoke, AppendArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      guard let data = Data(base64Encoded: input.data) else {
        throw Failure(code: .io)
      }
      let (dir, name) = try self.split(input.path)
      let url = self.itemURL(root, input.path)
      return try self.coordinatedWrite(url, replacing: false) { () throws -> JsonObject in
        guard let dirFd = try self.openDirectory(rootPath, dir, create: false) else {
          return ["missing": true]
        }
        defer { close(dirFd) }
        var flags = O_WRONLY | O_APPEND | O_NOFOLLOW | O_CLOEXEC
        if input.createNew {
          flags |= O_CREAT | O_EXCL
        }
        let fd = openat(dirFd, name, flags, 0o644)
        if fd < 0 {
          let error = errno
          if error == EEXIST && input.createNew {
            return ["exists": true]
          }
          if error == ENOENT && !input.createNew {
            return ["missing": true]
          }
          throw Failure(code: self.codeOf(error))
        }
        defer { close(fd) }
        var st = stat()
        if fstat(fd, &st) != 0 || !self.isRegular(st.st_mode) || st.st_nlink > 1 {
          throw Failure(code: .unsafeFolder)
        }
        try self.writeAll(fd, data)
        return [:]
      }
    }
  }

  /// Remplacement atomique : `<nom>.tmp` supprimé s'il existe, recréé exclusivement, écrit, `fsync`, puis `renameat` sur `<nom>`.
  @objc public func writeAtomic(_ invoke: Invoke) {
    guard let input = args(invoke, WriteAtomicArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      guard let data = Data(base64Encoded: input.data) else {
        throw Failure(code: .io)
      }
      let (dir, name) = try self.split(input.path)
      let temp = name + ".tmp"
      let url = self.itemURL(root, input.path)
      return try self.coordinatedWrite(url, replacing: true) { () throws -> JsonObject in
        guard let dirFd = try self.openDirectory(rootPath, dir, create: false) else {
          throw Failure(code: .io)
        }
        defer { close(dirFd) }
        var existing = stat()
        if fstatat(dirFd, name, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
          if !self.isRegular(existing.st_mode) || existing.st_nlink > 1 {
            throw Failure(code: .unsafeFolder)
          }
        }
        if unlinkat(dirFd, temp, 0) != 0 && errno != ENOENT {
          throw Failure(code: self.codeOf(errno))
        }
        let fd = openat(dirFd, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
        if fd < 0 {
          throw Failure(code: self.codeOf(errno))
        }
        do {
          try self.writeAll(fd, data)
        } catch {
          close(fd)
          unlinkat(dirFd, temp, 0)
          throw error
        }
        close(fd)
        if renameat(dirFd, temp, dirFd, name) != 0 {
          let error = errno
          unlinkat(dirFd, temp, 0)
          throw Failure(code: self.codeOf(error))
        }
        fsync(dirFd)
        return [:]
      }
    }
  }

  /// Renommage dans un même dossier (remplacement) ; la source doit être un fichier ordinaire à lien unique.
  @objc public func rename(_ invoke: Invoke) {
    guard let input = args(invoke, RenameArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      try self.checkComponent(input.from)
      try self.checkComponent(input.to)
      for part in input.dir {
        try self.checkComponent(part)
      }
      let source = self.itemURL(root, input.dir + [input.from])
      let destination = self.itemURL(root, input.dir + [input.to])
      return try self.coordinatedMove(source, destination) { () throws -> JsonObject in
        guard let dirFd = try self.openDirectory(rootPath, input.dir, create: false) else {
          throw Failure(code: .io)
        }
        defer { close(dirFd) }
        var st = stat()
        if fstatat(dirFd, input.from, &st, AT_SYMLINK_NOFOLLOW) != 0 {
          throw Failure(code: .io)
        }
        if !self.isRegular(st.st_mode) || st.st_nlink > 1 {
          throw Failure(code: .unsafeFolder)
        }
        if renameat(dirFd, input.from, dirFd, input.to) != 0 {
          throw Failure(code: self.codeOf(errno))
        }
        fsync(dirFd)
        return [:]
      }
    }
  }

  /// Création d'un dossier et de ses parents (idempotent), chaque composant contrôlé.
  @objc public func createDir(_ invoke: Invoke) {
    guard let input = args(invoke, PathArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      if input.path.isEmpty {
        throw Failure(code: .unsafeFolder)
      }
      let url = self.itemURL(root, input.path)
      return try self.coordinatedWrite(url, replacing: false) { () throws -> JsonObject in
        guard let fd = try self.openDirectory(rootPath, input.path, create: true) else {
          throw Failure(code: .io)
        }
        close(fd)
        return [:]
      }
    }
  }

  /// Suppression d'un fichier ; `removed` faux s'il n'existait pas ; un lien ou un dossier : `unsafe-folder`.
  @objc public func remove(_ invoke: Invoke) {
    guard let input = args(invoke, PathArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      let (dir, name) = try self.split(input.path)
      let url = self.itemURL(root, input.path)
      return try self.coordinatedWrite(url, replacing: false) { () throws -> JsonObject in
        guard let dirFd = try self.openDirectory(rootPath, dir, create: false) else {
          return ["removed": false]
        }
        defer { close(dirFd) }
        var st = stat()
        if fstatat(dirFd, name, &st, AT_SYMLINK_NOFOLLOW) != 0 {
          if errno == ENOENT {
            return ["removed": false]
          }
          throw Failure(code: .io)
        }
        if !self.isRegular(st.st_mode) {
          throw Failure(code: .unsafeFolder)
        }
        if unlinkat(dirFd, name, 0) != 0 {
          if errno == ENOENT {
            return ["removed": false]
          }
          throw Failure(code: self.codeOf(errno))
        }
        return ["removed": true]
      }
    }
  }

  /// Suppression d'un dossier vide (sans effet s'il ne l'est pas, ou s'il n'existe pas).
  @objc public func removeEmptyDir(_ invoke: Invoke) {
    guard let input = args(invoke, PathArgs.self) else {
      return
    }
    onFiles(invoke) {
      let (root, rootPath) = try self.sessionRoot()
      let (dir, name) = try self.split(input.path)
      let url = self.itemURL(root, input.path)
      return try self.coordinatedWrite(url, replacing: false) { () throws -> JsonObject in
        guard let parentFd = try self.openDirectory(rootPath, dir, create: false) else {
          return [:]
        }
        defer { close(parentFd) }
        var st = stat()
        if fstatat(parentFd, name, &st, AT_SYMLINK_NOFOLLOW) != 0 {
          if errno == ENOENT {
            return [:]
          }
          throw Failure(code: .io)
        }
        if !self.isDirectory(st.st_mode) {
          throw Failure(code: .unsafeFolder)
        }
        if unlinkat(parentFd, name, AT_REMOVEDIR) != 0 {
          let error = errno
          if error == ENOTEMPTY || error == EEXIST || error == ENOENT {
            return [:]
          }
          throw Failure(code: self.codeOf(error))
        }
        return [:]
      }
    }
  }

  // MARK: Confirmation native

  /// `UIAlertController` (style alerte) : « Annuler » en style `.cancel` et action préférée, action de confirmation en style `.default` ;
  /// refusée hors du premier plan (`not-foreground`, aucune alerte) ; `{ confirmed }` vrai seulement pour l'action de confirmation.
  @objc public func confirm(_ invoke: Invoke) {
    guard let input = args(invoke, ConfirmArgs.self) else {
      return
    }
    DispatchQueue.main.async {
      if UIApplication.shared.applicationState != .active || self.pendingAlert != nil {
        self.reject(invoke, .notForeground)
        return
      }
      guard var presenter = self.manager.viewController else {
        self.reject(invoke, .io)
        return
      }
      while let next = presenter.presentedViewController {
        presenter = next
      }
      var answered = false
      let answer: (Bool) -> Void = { confirmed in
        if answered {
          return
        }
        answered = true
        self.pendingAlert = nil
        self.pendingAnswer = nil
        invoke.resolve(["confirmed": confirmed])
      }
      let alert = UIAlertController(title: input.title, message: input.message, preferredStyle: .alert)
      let cancelAction = UIAlertAction(title: input.cancel, style: .cancel) { _ in
        answer(false)
      }
      let confirmAction = UIAlertAction(title: input.confirm, style: .default) { _ in
        answer(true)
      }
      alert.addAction(cancelAction)
      alert.addAction(confirmAction)
      alert.preferredAction = cancelAction
      self.pendingAlert = alert
      self.pendingAnswer = answer
      presenter.present(alert, animated: true, completion: nil)
    }
  }

  // MARK: État de l'app

  /// `active`, `inactive` ou `background` (`UIApplication.shared.applicationState`, lu sur le fil principal).
  @objc public func appState(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let state: String
      switch UIApplication.shared.applicationState {
      case .active:
        state = "active"
      case .inactive:
        state = "inactive"
      default:
        state = "background"
      }
      invoke.resolve(["state": state])
    }
  }
}

@_cdecl("init_plugin_folder_bookmark")
func initPlugin() -> Plugin {
  return FolderBookmarkPlugin()
}
