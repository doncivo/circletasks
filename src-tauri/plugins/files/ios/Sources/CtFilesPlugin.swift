// Plugin ct-files de CircleTasks (FILES-IOS-01, ADR 0009 avenant lot F point A2, décision du 2026-10-08).
//
// Contrat : tests/fixtures/files/files-contract.json (commande, champs, codes, types), relu par un contrôle statique contre ce fichier et
// src-tauri/src/export_ios.rs. Seul Rust appelle ce plugin (aucune permission pour la WebView).
//
// Une commande, `present({ path, mime })` -> `{ completed }` : présente le sélecteur « Enregistrer dans Fichiers »
// (`UIDocumentPickerViewController(forExporting:asCopy: true)`, iCloud Drive compris) sur le fichier temporaire écrit par Rust, qui le
// supprime ensuite dans tous les cas. Aucun panneau de partage : rien ne quitte l'appareil par Mail, Messages ni AirDrop (H-03).
//
// Règles :
// - aucune chaîne d'interface ni libellé ici (les libellés du sélecteur sont ceux d'iOS) ;
// - rejet = un code du contrat (`invoke.reject(code, code: code)`), jamais un chemin ni le texte d'une erreur système ;
// - présentation, état et résolution sur le fil principal ;
// - le chemin est revérifié : sous le dossier Caches de l'app, dans `exports/<16 hex>/`, fichier ordinaire (pas un lien) ; le type annoncé
//   doit correspondre à l'extension ;
// - jamais de promesse en suspens : au retour au premier plan, un appel dont le sélecteur n'est plus affiché est résolu comme annulé.

import Foundation
import Tauri
import UIKit
import WebKit

private enum Code: String {
  case notForeground = "not-foreground"
  case failed = "failed"
}

struct PresentArgs: Decodable {
  let path: String
  let mime: String
}

/// Types attendus par extension (mêmes valeurs que `mime_for` de src-tauri/src/export_common.rs).
private let mimeByExtension: [String: String] = [
  "csv": "text/csv",
  "json": "application/json",
  "pdf": "application/pdf",
  "png": "image/png",
  "txt": "text/plain",
]
private let fallbackMime = "application/octet-stream"
private let exportsFolder = "exports"

private final class ExportDelegate: NSObject, UIDocumentPickerDelegate {
  let onDone: (Bool) -> Void

  init(onDone: @escaping (Bool) -> Void) {
    self.onDone = onDone
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    onDone(!urls.isEmpty)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    onDone(false)
  }
}

class CtFilesPlugin: Plugin {
  /// Appel en cours, sélecteur affiché et son délégué (fil principal).
  private var pending: Invoke?
  private var picker: UIDocumentPickerViewController?
  private var delegate: ExportDelegate?
  /// Délai avant de constater, au retour au premier plan, que le sélecteur a disparu sans réponse.
  private let settleSeconds: Double = 0.5

  @objc public override func load(webview: WKWebView) {
    NotificationCenter.default.addObserver(
      self, selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.async(execute: work)
    }
  }

  private func reject(_ invoke: Invoke, _ code: Code) {
    invoke.reject(code.rawValue, code: code.rawValue)
  }

  /// Retour au premier plan : un sélecteur fermé par iOS sans réponse du délégué vaut annulation (fin garantie de l'appel).
  @objc private func appDidBecomeActive() {
    onMain {
      guard self.pending != nil, let controller = self.picker else {
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + self.settleSeconds) {
        if self.picker === controller && controller.presentingViewController == nil && controller.viewIfLoaded?.window == nil {
          self.finish(false)
        }
      }
    }
  }

  /// Rejette l'appel en cours (`failed`) quand le sélecteur n'a pas pu être présenté (fil principal) : jamais d'appel en suspens.
  private func failPending() {
    guard let invoke = pending else {
      return
    }
    pending = nil
    picker = nil
    delegate = nil
    reject(invoke, .failed)
  }

  /// Résout l'appel en cours une seule fois (fil principal).
  private func finish(_ completed: Bool) {
    guard let invoke = pending else {
      return
    }
    pending = nil
    picker = nil
    delegate = nil
    invoke.resolve(["completed": completed])
  }

  /// Chemin écrit par Rust, revérifié : absolu, fichier ordinaire et non lien, dans `<Caches>/…/exports/<16 hex>/`, type cohérent.
  private func checkedURL(_ path: String, _ mime: String) -> URL? {
    guard path.hasPrefix("/") else {
      return nil
    }
    let url = URL(fileURLWithPath: path)
    guard
      let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
      values.isRegularFile == true, values.isSymbolicLink != true
    else {
      return nil
    }
    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      return nil
    }
    let base = caches.resolvingSymlinksInPath().standardizedFileURL.path
    let folder = url.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
    let token = folder.lastPathComponent
    let hex = CharacterSet(charactersIn: "0123456789abcdef")
    guard
      folder.path.hasPrefix(base + "/"),
      folder.deletingLastPathComponent().lastPathComponent == exportsFolder,
      token.count == 16, token.unicodeScalars.allSatisfy({ hex.contains($0) })
    else {
      return nil
    }
    let expected = mimeByExtension[url.pathExtension.lowercased()] ?? fallbackMime
    guard expected == mime else {
      return nil
    }
    return url
  }

  /// Sélecteur « Enregistrer dans Fichiers » sur le fichier désigné par Rust ; `{ completed }` (faux = annulation, pas une erreur).
  @objc public func present(_ invoke: Invoke) {
    guard let input = try? invoke.parseArgs(PresentArgs.self) else {
      reject(invoke, .failed)
      return
    }
    DispatchQueue.main.async {
      if UIApplication.shared.applicationState != .active {
        self.reject(invoke, .notForeground)
        return
      }
      // Rust refuse déjà un second appel (`busy`) : seconde barrière. Un appel resté en suspens alors que son sélecteur n'est plus affiché
      // (fermé par iOS sans réponse) est d'abord résolu comme annulé : jamais d'occupation permanente.
      if self.pending != nil {
        if let stale = self.picker, stale.presentingViewController == nil {
          self.finish(false)
        } else {
          self.reject(invoke, .failed)
          return
        }
      }
      guard let url = self.checkedURL(input.path, input.mime), var presenter = self.manager.viewController else {
        self.reject(invoke, .failed)
        return
      }
      while let next = presenter.presentedViewController {
        presenter = next
      }
      // Un contrôleur en train de partir ou d'arriver ne peut pas présenter : échec visible plutôt qu'une présentation ignorée par UIKit.
      if presenter.isBeingDismissed || presenter.isBeingPresented {
        self.reject(invoke, .failed)
        return
      }
      let delegate = ExportDelegate(onDone: { [weak self] completed in
        self?.onMain { self?.finish(completed) }
      })
      let controller = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
      controller.delegate = delegate
      controller.modalPresentationStyle = .formSheet
      self.pending = invoke
      self.picker = controller
      self.delegate = delegate
      presenter.present(controller, animated: true) {
        // Présentation ignorée sans bruit par UIKit (aucun parent) ou sélecteur aussitôt retiré : l'appel est rejeté, jamais en suspens.
        if self.picker === controller && (controller.presentingViewController == nil || controller.isBeingDismissed) {
          self.failPending()
        }
      }
    }
  }
}

@_cdecl("init_plugin_ct_files")
func initPlugin() -> Plugin {
  return CtFilesPlugin()
}
