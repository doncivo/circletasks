// Plugin privacy-shield de CircleTasks (I-03, ADR 0013 §2.5).
//
// Une commande appelée par le JS (src/platform/privacyShield/tauriPrivacyShield.ts) : setEnabled({ enabled }). Activé, le plugin pose
// une vue opaque au-dessus du contenu de la fenêtre à `willResignActive` (sélecteur d'apps, centre de contrôle, passage en arrière-plan)
// et la retire à `didBecomeActive`. Le JS garde son propre cache et décide du verrou au retour.
//
// Règles : état et vues sur le fil principal seulement ; aucune chaîne d'interface ; rejet = code seul (`invalid-argument`).

import Tauri
import UIKit
import WebKit

struct SetEnabledArgs: Decodable {
  let enabled: Bool
}

class PrivacyShieldPlugin: Plugin {
  /// WebView de l'app : sa fenêtre porte le cache (lue sur le fil principal).
  private weak var webview: WKWebView?
  /// Cache activé par le réglage du verrou (fil principal).
  private var enabled = false
  /// Vue opaque posée (fil principal).
  private var shield: UIView?

  @objc public override func load(webview: WKWebView) {
    self.webview = webview
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(appWillResignActive),
      name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(
      self, selector: #selector(appDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(
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

  @objc private func appWillResignActive() {
    onMain { self.showShield() }
  }

  @objc private func appDidEnterBackground() {
    onMain { self.showShield() }
  }

  @objc private func appDidBecomeActive() {
    onMain { self.hideShield() }
  }

  private func hostWindow() -> UIWindow? {
    if let window = webview?.window {
      return window
    }
    for scene in UIApplication.shared.connectedScenes {
      guard let windowScene = scene as? UIWindowScene else {
        continue
      }
      if let key = windowScene.windows.first(where: { $0.isKeyWindow }) {
        return key
      }
      if let first = windowScene.windows.first {
        return first
      }
    }
    return nil
  }

  private func showShield() {
    guard enabled, shield == nil, let window = hostWindow() else {
      return
    }
    let view = UIView(frame: window.bounds)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.backgroundColor = UIColor.systemBackground
    view.isOpaque = true
    view.isUserInteractionEnabled = false
    view.accessibilityElementsHidden = true
    window.addSubview(view)
    window.bringSubviewToFront(view)
    shield = view
  }

  private func hideShield() {
    shield?.removeFromSuperview()
    shield = nil
  }

  @objc public func setEnabled(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(SetEnabledArgs.self) else {
      invoke.reject("invalid-argument", code: "invalid-argument")
      return
    }
    DispatchQueue.main.async {
      self.enabled = args.enabled
      if !args.enabled {
        self.hideShield()
      }
      invoke.resolve(["enabled": args.enabled])
    }
  }
}

@_cdecl("init_plugin_privacy_shield")
func initPlugin() -> Plugin {
  return PrivacyShieldPlugin()
}
