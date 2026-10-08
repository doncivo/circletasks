// Plugin reminders de CircleTasks (ADR 0008 §10.4 ; stories K-05, K-06, K-07) : lit les listes et les rappels d'EventKit, écrit titre,
// échéance et statut terminé d'un rappel, supprime un rappel, signale `EKEventStoreChanged`.
//
// Contrat : tests/fixtures/calendars/reminders-contract.json (commandes, champs, codes), relu par un contrôle statique contre ce fichier,
// src/platform/reminders/tauriReminders.ts et src-tauri/capabilities/reminders-ios.json. La WebView appelle ces commandes (aucun secret ici).
//
// Règles :
// - aucune chaîne d'interface ni libellé ici ; rejet = un code du contrat (`invoke.reject(code, code: code)`), jamais le texte d'une erreur
//   système ni un titre de rappel ;
// - périmètre des données (K-05 D1) : titre, échéance (date, heure), statut terminé, récurrence (lecture seule), dates de modification et de
//   création, identifiants. Notes, priorité, drapeau, sous-tâches, lieu : jamais lus ni écrits. Les alertes ne sont pas lues ; seule une alerte
//   ABSOLUE égale à l'ancienne échéance est déplacée avec elle (retirée si l'échéance l'est) pour que Rappels ne sonne pas à l'ancienne heure ;
// - un rappel récurrent n'est jamais modifié ni supprimé (`recurring-refused`) ;
// - `upsert` et `setCompleted` rendent le rappel RELU après l'enregistrement (`modifiedAt` compris : base de l'anti-boucle) ;
// - la demande d'accès (`requestAccess`) n'est faite que sur appel explicite de la WebView, jamais au chargement du plugin ;
// - toute opération sur le magasin se fait sur une file série du plugin, jamais sur la file IPC ni sur le fil principal.

import EventKit
import Foundation
import Tauri
import WebKit

// MARK: - Codes et arguments

private enum Code: String {
  case accessDenied = "access-denied"
  case storeUnavailable = "store-unavailable"
  case readFailed = "read-failed"
  case writeFailed = "write-failed"
  case notFound = "not-found"
  case listNotFound = "list-not-found"
  case readOnlyList = "read-only-list"
  case recurringRefused = "recurring-refused"
  case invalidInput = "invalid-input"
}

private struct Failure: Error {
  let code: Code
}

private struct IdRef: Decodable {
  let id: String
  let externalRef: String?
}

private struct FetchArgs: Decodable {
  let listIds: [String]
  let scopeListIds: [String]
  let limitPerList: Int
  let ids: [IdRef]
}

private struct DueArgs: Decodable {
  let date: String
  let time: String?
}

private struct UpsertArgs: Decodable {
  let id: String?
  let listId: String
  let title: String
  let due: DueArgs?
  let completed: Bool
  let completedAt: String?
}

private struct CompletedArgs: Decodable {
  let id: String
  let completed: Bool
  let completedAt: String?
}

private struct DeleteArgs: Decodable {
  let id: String
}

private struct ChangedPayload: Encodable {
  let changed: Bool
}

// MARK: - Conversions

private let isoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  formatter.timeZone = TimeZone(identifier: "UTC") ?? TimeZone.current
  return formatter
}()

private func iso(_ date: Date?) -> Any {
  if let date = date {
    return isoFormatter.string(from: date)
  }
  return NSNull()
}

private func orNull(_ value: String?) -> Any {
  if let value = value {
    return value
  }
  return NSNull()
}

private func gregorian(_ zone: TimeZone) -> Calendar {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = zone
  return calendar
}

/// Instant d'une échéance (fuseau de l'échéance, sinon le fuseau courant) ; nil sans date complète.
private func dueInstant(_ components: DateComponents?) -> Date? {
  guard let components = components else {
    return nil
  }
  return gregorian(components.timeZone ?? TimeZone.current).date(from: components)
}

/// Échéance rendue à la WebView : heure murale du fuseau COURANT (une échéance enregistrée dans un autre fuseau est convertie) ; date seule : sans heure.
private func dueJSON(_ components: DateComponents?) -> Any {
  guard let c = components, let year = c.year, let month = c.month, let day = c.day else {
    return NSNull()
  }
  var y = year
  var m = month
  var d = day
  var time: Any = NSNull()
  if let hour = c.hour {
    let minute = c.minute ?? 0
    var h = hour
    var min = minute
    if let zone = c.timeZone, zone != TimeZone.current {
      var parts = DateComponents()
      parts.year = year
      parts.month = month
      parts.day = day
      parts.hour = hour
      parts.minute = minute
      if let instant = gregorian(zone).date(from: parts) {
        let local = gregorian(TimeZone.current).dateComponents([.year, .month, .day, .hour, .minute], from: instant)
        y = local.year ?? year
        m = local.month ?? month
        d = local.day ?? day
        h = local.hour ?? hour
        min = local.minute ?? minute
      }
    }
    time = String(format: "%02d:%02d", h, min)
  }
  let result: JsonObject = ["date": String(format: "%04d-%02d-%02d", y, m, d), "time": time]
  return result
}

private func itemJSON(_ reminder: EKReminder) -> JsonObject {
  return [
    "id": reminder.calendarItemIdentifier,
    "externalRef": orNull(reminder.calendarItemExternalIdentifier),
    "listId": reminder.calendar?.calendarIdentifier ?? "",
    "title": reminder.title ?? "",
    "due": dueJSON(reminder.dueDateComponents),
    "completed": reminder.isCompleted,
    "completedAt": iso(reminder.completionDate),
    "recurring": reminder.hasRecurrenceRules,
    "modifiedAt": iso(reminder.lastModifiedDate),
    "createdAt": iso(reminder.creationDate),
  ]
}

/// Échéance reçue de la WebView (`yyyy-MM-dd`, `HH:mm` facultative) vers des composantes : date seule sans fuseau ; avec heure, fuseau courant.
private func components(_ due: DueArgs) throws -> DateComponents {
  let dateParts = due.date.split(separator: "-").compactMap { Int($0) }
  guard dateParts.count == 3, dateParts[1] >= 1, dateParts[1] <= 12, dateParts[2] >= 1, dateParts[2] <= 31 else {
    throw Failure(code: .invalidInput)
  }
  var result = DateComponents()
  result.calendar = Calendar(identifier: .gregorian)
  result.year = dateParts[0]
  result.month = dateParts[1]
  result.day = dateParts[2]
  if let time = due.time {
    let timeParts = time.split(separator: ":").compactMap { Int($0) }
    guard timeParts.count == 2, timeParts[0] >= 0, timeParts[0] <= 23, timeParts[1] >= 0, timeParts[1] <= 59 else {
      throw Failure(code: .invalidInput)
    }
    result.hour = timeParts[0]
    result.minute = timeParts[1]
    result.timeZone = TimeZone.current
  }
  return result
}

private func sameDue(_ a: DateComponents?, _ b: DateComponents?) -> Bool {
  guard let a = a, let b = b else {
    return a == nil && b == nil
  }
  return a.year == b.year && a.month == b.month && a.day == b.day && a.hour == b.hour && a.minute == b.minute
}

// MARK: - Plugin

class RemindersPlugin: Plugin {
  private let work = DispatchQueue(label: "fr.circletasks.reminders.store")
  private var storeInstance: EKEventStore?

  /// Un seul magasin pour la durée du processus (créé à la première utilisation, sur la file de travail).
  private func store() -> EKEventStore {
    if let existing = storeInstance {
      return existing
    }
    let created = EKEventStore()
    storeInstance = created
    return created
  }

  @objc public override func load(webview: WKWebView) {
    // Aucune demande d'accès ici : la fenêtre iOS n'apparaît que sur `requestAccess`, après l'explication de l'écran (K-05 critère 7).
    NotificationCenter.default.addObserver(
      self, selector: #selector(storeChanged), name: .EKEventStoreChanged, object: nil)
  }

  /// Rend visibles à la WebView les changements du magasin (sans contenu) ; elle relit.
  @objc private func storeChanged() {
    try? trigger("changed", data: ChangedPayload(changed: true))
  }

  private func reject(_ invoke: Invoke, _ code: Code) {
    invoke.reject(code.rawValue, code: code.rawValue)
  }

  private func args<T: Decodable>(_ invoke: Invoke, _ type: T.Type) -> T? {
    do {
      return try invoke.parseArgs(type)
    } catch {
      reject(invoke, .invalidInput)
      return nil
    }
  }

  /// `not-determined`, `denied`, `restricted` ou `full` ; l'accès « écriture seule » (sans objet pour des rappels) vaut `denied`.
  private func accessState() -> String {
    if #available(iOS 17.0, *) {
      switch EKEventStore.authorizationStatus(for: .reminder) {
      case .fullAccess:
        return "full"
      case .notDetermined:
        return "not-determined"
      case .restricted:
        return "restricted"
      default:
        return "denied"
      }
    }
    return "denied"
  }

  private func requireFull(_ invoke: Invoke) -> Bool {
    if accessState() != "full" {
      reject(invoke, .accessDenied)
      return false
    }
    return true
  }

  /// Rappel par identifiant local, sinon par identifiant externe.
  private func findReminder(_ store: EKEventStore, _ id: String, _ externalRef: String?) -> EKReminder? {
    if let found = store.calendarItem(withIdentifier: id) as? EKReminder {
      return found
    }
    if let external = externalRef, !external.isEmpty {
      for item in store.calendarItems(withExternalIdentifier: external) {
        if let reminder = item as? EKReminder {
          return reminder
        }
      }
    }
    return nil
  }

  private func done(_ invoke: Invoke, _ body: @escaping () throws -> JsonObject) {
    work.async {
      do {
        invoke.resolve(try body())
      } catch let failure as Failure {
        self.reject(invoke, failure.code)
      } catch {
        self.reject(invoke, .storeUnavailable)
      }
    }
  }

  // MARK: Accès

  @objc public func status(_ invoke: Invoke) {
    let result: JsonObject = ["access": accessState()]
    invoke.resolve(result)
  }

  @objc public func requestAccess(_ invoke: Invoke) {
    if #available(iOS 17.0, *) {
      work.async {
        self.store().requestFullAccessToReminders { _, _ in
          // Après l'accord, le magasin est remis à zéro pour qu'il relise les listes et les rappels désormais accessibles (documentation EventKit).
          self.work.async {
            self.store().reset()
            let result: JsonObject = ["access": self.accessState()]
            invoke.resolve(result)
          }
        }
      }
    } else {
      reject(invoke, .storeUnavailable)
    }
  }

  // MARK: Lecture

  @objc public func lists(_ invoke: Invoke) {
    if !requireFull(invoke) {
      return
    }
    done(invoke) {
      var lists: [JsonObject] = []
      for calendar in self.store().calendars(for: .reminder) {
        lists.append(["id": calendar.calendarIdentifier, "name": calendar.title, "writable": calendar.allowsContentModifications])
      }
      return ["lists": lists]
    }
  }

  @objc public func fetch(_ invoke: Invoke) {
    guard let input = args(invoke, FetchArgs.self) else {
      return
    }
    if !requireFull(invoke) {
      return
    }
    if input.limitPerList < 1 || input.limitPerList > 5000 || input.listIds.count > 200 || input.ids.count > 5000 {
      reject(invoke, .invalidInput)
      return
    }
    work.async {
      let store = self.store()
      var known: [String: EKCalendar] = [:]
      for calendar in store.calendars(for: .reminder) {
        known[calendar.calendarIdentifier] = calendar
      }
      var missingLists: [String] = []
      var wanted: [(String, EKCalendar)] = []
      for listId in input.listIds {
        if let calendar = known[listId] {
          wanted.append((listId, calendar))
        } else {
          missingLists.append(listId)
        }
      }
      let lock = NSLock()
      var fetched: [String: [EKReminder]] = [:]
      var failed = false
      let group = DispatchGroup()
      for (listId, calendar) in wanted {
        group.enter()
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: [calendar])
        _ = store.fetchReminders(matching: predicate) { reminders in
          lock.lock()
          if let reminders = reminders {
            fetched[listId] = reminders
          } else {
            failed = true
          }
          lock.unlock()
          group.leave()
        }
      }
      group.notify(queue: self.work) {
        if failed {
          self.reject(invoke, .readFailed)
          return
        }
        var lists: [JsonObject] = []
        for (listId, _) in wanted {
          let all = fetched[listId] ?? []
          // Échéance croissante, sans échéance ensuite, puis création (K-05 : les 500 premiers restent importés).
          let ordered = all.sorted { left, right in
            let a = dueInstant(left.dueDateComponents)
            let b = dueInstant(right.dueDateComponents)
            if let a = a, let b = b, a != b {
              return a < b
            }
            if (a == nil) != (b == nil) {
              return a != nil
            }
            let created1 = left.creationDate ?? Date.distantFuture
            let created2 = right.creationDate ?? Date.distantFuture
            if created1 != created2 {
              return created1 < created2
            }
            return left.calendarItemIdentifier < right.calendarItemIdentifier
          }
          lists.append(["listId": listId, "total": ordered.count, "items": ordered.prefix(input.limitPerList).map { itemJSON($0) }])
        }
        var byId: [JsonObject] = []
        var missing: [String] = []
        let scope = Set(input.scopeListIds)
        for ref in input.ids {
          if let reminder = self.findReminder(store, ref.id, ref.externalRef) {
            // Hors des listes suivies : l'identifiant et la liste seulement (le rappel a pu être déplacé dans une liste que l'utilisateur ne partage pas).
            let listId = reminder.calendar?.calendarIdentifier ?? ""
            if scope.contains(listId) {
              byId.append(itemJSON(reminder))
            } else {
              byId.append(["id": reminder.calendarItemIdentifier, "listId": listId])
            }
          } else {
            missing.append(ref.id)
          }
        }
        let result: JsonObject = ["lists": lists, "byId": byId, "missing": missing, "missingLists": missingLists]
        invoke.resolve(result)
      }
    }
  }

  // MARK: Écriture

  /// Enregistre `reminder` puis le relit (valeurs et `modifiedAt` tels que le magasin les porte).
  private func saveAndReread(_ store: EKEventStore, _ reminder: EKReminder) throws -> JsonObject {
    do {
      try store.save(reminder, commit: true)
    } catch {
      throw Failure(code: .writeFailed)
    }
    let reread = store.calendarItem(withIdentifier: reminder.calendarItemIdentifier) as? EKReminder ?? reminder
    return ["item": itemJSON(reread)]
  }

  private func apply(completed: Bool, completedAt: String?, to reminder: EKReminder) {
    if reminder.isCompleted != completed {
      reminder.isCompleted = completed
    }
    if completed {
      reminder.completionDate = completedAt.flatMap { isoFormatter.date(from: $0) } ?? reminder.completionDate ?? Date()
    } else {
      reminder.completionDate = nil
    }
  }

  @objc public func upsert(_ invoke: Invoke) {
    guard let input = args(invoke, UpsertArgs.self) else {
      return
    }
    if !requireFull(invoke) {
      return
    }
    done(invoke) {
      let store = self.store()
      let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
      if title.isEmpty {
        throw Failure(code: .invalidInput)
      }
      let newDue: DateComponents? = try input.due.map { try components($0) }
      let reminder: EKReminder
      if let id = input.id {
        guard let existing = self.findReminder(store, id, nil) else {
          throw Failure(code: .notFound)
        }
        if existing.hasRecurrenceRules {
          throw Failure(code: .recurringRefused)
        }
        if let calendar = existing.calendar, !calendar.allowsContentModifications {
          throw Failure(code: .readOnlyList)
        }
        reminder = existing
      } else {
        guard let calendar = store.calendars(for: .reminder).first(where: { $0.calendarIdentifier == input.listId }) else {
          throw Failure(code: .listNotFound)
        }
        if !calendar.allowsContentModifications {
          throw Failure(code: .readOnlyList)
        }
        reminder = EKReminder(eventStore: store)
        reminder.calendar = calendar
      }
      if reminder.title != title {
        reminder.title = title
      }
      if !sameDue(reminder.dueDateComponents, newDue) {
        // Une alerte absolue égale à l'ancienne échéance suit l'échéance (K-05 A5, à vérifier sur l'appareil).
        let oldInstant = dueInstant(reminder.dueDateComponents)
        var moved = false
        if let old = oldInstant, let alarms = reminder.alarms {
          for alarm in alarms {
            if let at = alarm.absoluteDate, Swift.abs(at.timeIntervalSince(old)) < 1 {
              reminder.removeAlarm(alarm)
              moved = true
            }
          }
        }
        reminder.dueDateComponents = newDue
        if moved, let due = newDue, due.hour != nil, let instant = dueInstant(due) {
          reminder.addAlarm(EKAlarm(absoluteDate: instant))
        }
      }
      self.apply(completed: input.completed, completedAt: input.completedAt, to: reminder)
      return try self.saveAndReread(store, reminder)
    }
  }

  @objc public func setCompleted(_ invoke: Invoke) {
    guard let input = args(invoke, CompletedArgs.self) else {
      return
    }
    if !requireFull(invoke) {
      return
    }
    done(invoke) {
      let store = self.store()
      guard let reminder = self.findReminder(store, input.id, nil) else {
        throw Failure(code: .notFound)
      }
      if reminder.hasRecurrenceRules {
        throw Failure(code: .recurringRefused)
      }
      if let calendar = reminder.calendar, !calendar.allowsContentModifications {
        throw Failure(code: .readOnlyList)
      }
      self.apply(completed: input.completed, completedAt: input.completedAt, to: reminder)
      return try self.saveAndReread(store, reminder)
    }
  }

  @objc public func delete(_ invoke: Invoke) {
    guard let input = args(invoke, DeleteArgs.self) else {
      return
    }
    if !requireFull(invoke) {
      return
    }
    done(invoke) {
      let store = self.store()
      // Idempotent : un rappel déjà absent est un succès.
      guard let reminder = self.findReminder(store, input.id, nil) else {
        return [:]
      }
      if reminder.hasRecurrenceRules {
        throw Failure(code: .recurringRefused)
      }
      if let calendar = reminder.calendar, !calendar.allowsContentModifications {
        throw Failure(code: .readOnlyList)
      }
      do {
        try store.remove(reminder, commit: true)
      } catch {
        throw Failure(code: .writeFailed)
      }
      return [:]
    }
  }
}

@_cdecl("init_plugin_reminders")
func initPlugin() -> Plugin {
  return RemindersPlugin()
}
