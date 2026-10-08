// Plugin notification-actions de CircleTasks (ADR 0012 avenant N-03, N3.1 à N3.3 ; story N-03).
//
// Rôle : prendre la place du délégué `UNUserNotificationCenterDelegate` du plugin officiel (un seul délégué existe), enregistrer les
// catégories et actions « Fait » et « +15 min », et écrire chaque action reçue (app ouverte, en arrière-plan ou tuée) dans un fichier
// durable que la WebView tire (`drain`) puis acquitte (`ack`). Le plugin n'envoie, n'annule ni ne lit aucune notification : l'envoi reste
// au plugin officiel (`show`, `cancel`, `get_pending`).
//
// Règles :
// - aucune chaîne d'interface ici : les titres des actions viennent du JS (`src/i18n`) ;
// - rejet = un code (`bad-args` ou `io`), jamais le texte d'une erreur système ;
// - une action est écrite dans le fichier (écriture + `fsync`) AVANT d'appeler le gestionnaire de fin de `didReceive` ;
// - toutes les opérations sur le fichier se font sur une file série du plugin (jamais sur le fil principal ni sur la file IPC) ;
// - écriture impossible : compteur `writeFailures` (UserDefaults) rendu par `drain`, jamais un silence ;
// - le délégué est réaffirmé à chaque `didBecomeActive` ; `status` dit s'il est bien le nôtre.
//
// Fichier : Library/Application Support/ct-notification-actions/queue.jsonl, une ligne JSON par action :
//   {"v":1,"n":<entier>,"a":"done"|"snooze15","t":<ms UTC de la réponse>,"sid":<chaîne|null>,"at":<ms UTC de l'échéance|null>}
// Catégories : categories.json (même dossier), relu au chargement du plugin pour que les boutons existent avant le premier JS.

import Darwin
import Foundation
import Tauri
import UIKit
import UserNotifications
import WebKit

// MARK: - Codes, arguments

private enum Code: String {
  case badArgs = "bad-args"
  case io = "io"
}

private struct Failure: Error {
  let code: Code
}

private struct ActionSpec: Codable {
  let id: String
  let title: String
  let foreground: Bool
}

private struct CategorySpec: Codable {
  let id: String
  let actions: [ActionSpec]
}

private struct RegisterArgs: Decodable {
  let types: [CategorySpec]
}

private struct AckArgs: Decodable {
  let count: Int
  let writeFailures: Int
}

private struct WakePayload: Encodable {
  let lines: Int
}

// MARK: - Fichier des actions

private let directoryName = "ct-notification-actions"
private let queueFileName = "queue.jsonl"
private let categoriesFileName = "categories.json"
private let writeFailuresKey = "fr.circletasks.notification-actions.writeFailures"
private let knownActions: Set<String> = ["done", "snooze15"]

/// Lecture et écriture du fichier ; une seule file série pour tout le plugin.
private final class ActionStore {
  static let shared = ActionStore()

  private let queue = DispatchQueue(label: "fr.circletasks.notification-actions.file")

  private func directory() throws -> URL {
    let manager = FileManager.default
    let base = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let dir = base.appendingPathComponent(directoryName, isDirectory: true)
    if !manager.fileExists(atPath: dir.path) {
      try manager.createDirectory(
        at: dir, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }
    return dir
  }

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

  /// Lignes physiques du fichier (sans le saut de ligne final) ; fichier absent : aucune.
  private func readLines(_ url: URL) throws -> [Data] {
    if !FileManager.default.fileExists(atPath: url.path) {
      return []
    }
    let data = try Data(contentsOf: url)
    if data.isEmpty {
      return []
    }
    var lines = data.split(separator: 0x0A, omittingEmptySubsequences: false).map { Data($0) }
    // Le fichier se termine par un saut de ligne : le dernier élément est vide. Sinon la dernière ligne est partielle (coupure) et reste
    // une ligne, signalée illisible.
    if let last = lines.last, last.isEmpty {
      lines.removeLast()
    }
    return lines
  }

  /// Ajoute une ligne et `fsync` ; échec : compteur incrémenté, `false`.
  func append(_ entry: [String: Any]) -> Bool {
    return queue.sync { () -> Bool in
      do {
        guard JSONSerialization.isValidJSONObject(entry) else {
          throw Failure(code: .io)
        }
        var line = try JSONSerialization.data(withJSONObject: entry, options: [])
        line.append(0x0A)
        let url = try directory().appendingPathComponent(queueFileName)
        let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
        if fd < 0 {
          throw Failure(code: .io)
        }
        defer { close(fd) }
        try writeAll(fd, line)
        return true
      } catch {
        let defaults = UserDefaults.standard
        defaults.set(defaults.integer(forKey: writeFailuresKey) + 1, forKey: writeFailuresKey)
        defaults.synchronize()
        return false
      }
    }
  }

  /// Une ligne valide du format, ou nil.
  private func parse(_ line: Data) -> [String: Any]? {
    guard let object = try? JSONSerialization.jsonObject(with: line, options: []) as? [String: Any] else {
      return nil
    }
    guard let version = object["v"] as? Int, version == 1 else {
      return nil
    }
    guard let n = object["n"] as? Int, let a = object["a"] as? String, knownActions.contains(a), let t = (object["t"] as? NSNumber)?.int64Value else {
      return nil
    }
    var sid: Any = NSNull()
    if let value = object["sid"] as? String {
      sid = value
    } else if !(object["sid"] is NSNull) {
      return nil
    }
    var at: Any = NSNull()
    if let value = (object["at"] as? NSNumber)?.int64Value {
      at = value
    } else if !(object["at"] is NSNull) {
      return nil
    }
    return ["n": n, "a": a, "t": t, "sid": sid, "at": at]
  }

  func drain() throws -> JsonObject {
    return try queue.sync { () throws -> JsonObject in
      let url = try directory().appendingPathComponent(queueFileName)
      let lines = try readLines(url)
      var entries: [[String: Any]] = []
      var unreadable = 0
      for line in lines {
        if let entry = parse(line) {
          entries.append(entry)
        } else {
          unreadable += 1
        }
      }
      let result: JsonObject = [
        "entries": entries,
        "lines": lines.count,
        "unreadable": unreadable,
        "writeFailures": UserDefaults.standard.integer(forKey: writeFailuresKey),
      ]
      return result
    }
  }

  /// Retire les `count` premières lignes physiques (fichier temporaire, `fsync`, renommage) et soustrait `writeFailures` du compteur.
  func ack(count: Int, writeFailures: Int) throws -> JsonObject {
    return try queue.sync { () throws -> JsonObject in
      if count < 0 || writeFailures < 0 {
        throw Failure(code: .badArgs)
      }
      let dir = try directory()
      let url = dir.appendingPathComponent(queueFileName)
      let lines = try readLines(url)
      let removed = min(count, lines.count)
      if removed > 0 {
        var rest = Data()
        for line in lines.dropFirst(removed) {
          rest.append(line)
          rest.append(0x0A)
        }
        let temp = dir.appendingPathComponent(queueFileName + ".tmp")
        unlink(temp.path)
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        if fd < 0 {
          throw Failure(code: .io)
        }
        do {
          try writeAll(fd, rest)
        } catch {
          close(fd)
          unlink(temp.path)
          throw error
        }
        close(fd)
        if rename(temp.path, url.path) != 0 {
          unlink(temp.path)
          throw Failure(code: .io)
        }
        let dirFd = open(dir.path, O_RDONLY | O_CLOEXEC)
        if dirFd >= 0 {
          fsync(dirFd)
          close(dirFd)
        }
      }
      if writeFailures > 0 {
        let defaults = UserDefaults.standard
        defaults.set(max(0, defaults.integer(forKey: writeFailuresKey) - writeFailures), forKey: writeFailuresKey)
        defaults.synchronize()
      }
      let result: JsonObject = ["removed": removed]
      return result
    }
  }

  func categoriesURL() throws -> URL {
    return try directory().appendingPathComponent(categoriesFileName)
  }
}

// MARK: - Délégué

private final class ActionsDelegate: NSObject, UNUserNotificationCenterDelegate {
  weak var plugin: NotificationActionsPlugin?

  /// Notification reçue app ouverte : bannière, liste et son. Aucune table, aucune lecture du contenu.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  /// Réponse de l'utilisateur : « Fait » et « +15 min » sont écrites dans le fichier AVANT le gestionnaire de fin ; l'appui simple, le
  /// rejet et toute autre action n'écrivent rien (l'app s'ouvre, rien à appliquer).
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let action = response.actionIdentifier
    guard knownActions.contains(action) else {
      completionHandler()
      return
    }
    let request = response.notification.request
    let extra = request.content.userInfo["__EXTRA__"] as? [String: String]
    var entry: [String: Any] = [
      "v": 1,
      "n": Int(request.identifier) ?? -1,
      "a": action,
      "t": Int64(Date().timeIntervalSince1970 * 1000),
    ]
    if let sid = extra?["sid"] {
      entry["sid"] = sid
    } else {
      entry["sid"] = NSNull()
    }
    if let at = extra?["at"], let value = Int64(at) {
      entry["at"] = value
    } else {
      entry["at"] = NSNull()
    }
    let written = ActionStore.shared.append(entry)
    completionHandler()
    if written {
      plugin?.wake()
    }
  }
}

// MARK: - Plugin

class NotificationActionsPlugin: Plugin {
  private let actionsDelegate = ActionsDelegate()

  override init() {
    super.init()
    actionsDelegate.plugin = self
    applySavedCategories()
    claimDelegate()
    NotificationCenter.default.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  /// Le plugin officiel pose son propre délégué à son chargement : le nôtre le remplace (un seul délégué existe).
  private func claimDelegate() {
    let center = UNUserNotificationCenter.current()
    if center.delegate !== actionsDelegate {
      center.delegate = actionsDelegate
    }
  }

  @objc private func appDidBecomeActive() {
    claimDelegate()
  }

  /// Réveil du JS : une action vient d'être écrite (la source de vérité reste le fichier).
  fileprivate func wake() {
    try? trigger("action", data: WakePayload(lines: 1))
  }

  // MARK: Catégories

  private func apply(_ types: [CategorySpec]) {
    var categories = Set<UNNotificationCategory>()
    for type in types {
      var actions: [UNNotificationAction] = []
      for spec in type.actions {
        actions.append(
          UNNotificationAction(identifier: spec.id, title: spec.title, options: spec.foreground ? [.foreground] : []))
      }
      categories.insert(
        UNNotificationCategory(identifier: type.id, actions: actions, intentIdentifiers: [], options: []))
    }
    UNUserNotificationCenter.current().setNotificationCategories(categories)
  }

  /// Au chargement : les catégories du dernier démarrage, avant que le JS n'ait rien demandé.
  private func applySavedCategories() {
    guard let url = try? ActionStore.shared.categoriesURL(), let data = try? Data(contentsOf: url) else {
      return
    }
    if let types = try? JSONDecoder().decode([CategorySpec].self, from: data) {
      apply(types)
    }
  }

  @objc public func registerActionTypes(_ invoke: Invoke) {
    let input: RegisterArgs
    do {
      input = try invoke.parseArgs(RegisterArgs.self)
    } catch {
      invoke.reject(Code.badArgs.rawValue, code: Code.badArgs.rawValue)
      return
    }
    apply(input.types)
    do {
      let data = try JSONEncoder().encode(input.types)
      let url = try ActionStore.shared.categoriesURL()
      try data.write(to: url, options: .atomic)
    } catch {
      // Les boutons sont enregistrés pour ce lancement ; seule la copie pour le prochain a échoué (le JS réenregistre à chaque démarrage).
    }
    let result: JsonObject = ["registered": input.types.count]
    invoke.resolve(result)
  }

  // MARK: Fichier

  @objc public func drain(_ invoke: Invoke) {
    do {
      invoke.resolve(try ActionStore.shared.drain())
    } catch {
      invoke.reject(Code.io.rawValue, code: Code.io.rawValue)
    }
  }

  @objc public func ack(_ invoke: Invoke) {
    let input: AckArgs
    do {
      input = try invoke.parseArgs(AckArgs.self)
    } catch {
      invoke.reject(Code.badArgs.rawValue, code: Code.badArgs.rawValue)
      return
    }
    do {
      invoke.resolve(try ActionStore.shared.ack(count: input.count, writeFailures: input.writeFailures))
    } catch let failure as Failure {
      invoke.reject(failure.code.rawValue, code: failure.code.rawValue)
    } catch {
      invoke.reject(Code.io.rawValue, code: Code.io.rawValue)
    }
  }

  // MARK: État

  @objc public func status(_ invoke: Invoke) {
    let isDelegate = UNUserNotificationCenter.current().delegate === actionsDelegate
    UNUserNotificationCenter.current().getNotificationCategories { categories in
      let result: JsonObject = ["delegate": isDelegate, "categories": categories.count]
      invoke.resolve(result)
    }
  }
}

@_cdecl("init_plugin_notification_actions")
func initPlugin() -> Plugin {
  return NotificationActionsPlugin()
}
