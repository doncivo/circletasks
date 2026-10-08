// Plugin haptics de CircleTasks (A-07, ADR 0013 §1.1).
//
// Trois commandes appelées par le JS (src/platform/haptics/tauriHaptics.ts) : impactFeedback({ style }), notificationFeedback({ type }),
// selectionFeedback(). Tauri appelle les plugins sur une file série d'arrière-plan (constat 1) : chaque générateur UIKit est créé et
// déclenché sur le fil principal (DispatchQueue.main.async), puis l'appel est résolu. Valeur inconnue : rejet `invalid-argument` (code
// seul, aucun texte d'interface). Pas de vibrate ni de Core Haptics.

import Tauri
import UIKit
import WebKit

struct ImpactArgs: Decodable {
  let style: String
}

struct NotificationArgs: Decodable {
  let type: String
}

class HapticsPlugin: Plugin {
  private func invalid(_ invoke: Invoke) {
    invoke.reject("invalid-argument", code: "invalid-argument")
  }

  @objc public func impactFeedback(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(ImpactArgs.self) else {
      invalid(invoke)
      return
    }
    let style: UIImpactFeedbackGenerator.FeedbackStyle
    switch args.style {
    case "light":
      style = .light
    case "medium":
      style = .medium
    case "heavy":
      style = .heavy
    default:
      invalid(invoke)
      return
    }
    DispatchQueue.main.async {
      let generator = UIImpactFeedbackGenerator(style: style)
      generator.prepare()
      generator.impactOccurred()
      invoke.resolve()
    }
  }

  @objc public func notificationFeedback(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(NotificationArgs.self) else {
      invalid(invoke)
      return
    }
    let kind: UINotificationFeedbackGenerator.FeedbackType
    switch args.type {
    case "success":
      kind = .success
    case "warning":
      kind = .warning
    case "error":
      kind = .error
    default:
      invalid(invoke)
      return
    }
    DispatchQueue.main.async {
      let generator = UINotificationFeedbackGenerator()
      generator.prepare()
      generator.notificationOccurred(kind)
      invoke.resolve()
    }
  }

  @objc public func selectionFeedback(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let generator = UISelectionFeedbackGenerator()
      generator.prepare()
      generator.selectionChanged()
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_ct_haptics")
func initPlugin() -> Plugin {
  return HapticsPlugin()
}
