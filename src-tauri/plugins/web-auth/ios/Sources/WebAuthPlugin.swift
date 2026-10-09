// Plugin web-auth de CircleTasks (ADR 0008 §9.1 ; K-TECH-01) : connexion Google sur iPhone par une session d'authentification web.
//
// Contrat : tests/fixtures/calendars/web-auth-contract.json (commande, champs, codes), relu par un contrôle statique contre ce fichier et
// src-tauri/src/calendars/web_auth.rs. Seul Rust appelle cette commande (aucune permission pour la WebView).
//
// Règles :
// - une seule commande, `authenticate` : ouvre l'URL reçue dans une `ASWebAuthenticationSession` et rend l'URL de retour ; le plugin
//   ne lit ni le code, ni le `state`, ni un jeton (Rust les vérifie et fait l'échange) ;
// - session partagée avec Safari (`prefersEphemeralWebBrowserSession = false`) : un compte Google déjà ouvert se consent en un geste ;
// - aucune chaîne d'interface ici ; rejet = un code du contrat (`invoke.reject(code, code: code)`), jamais un texte d'erreur système ;
// - ni l'URL d'autorisation ni l'URL de retour ne sont journalisées ni copiées dans une erreur (aucun `print`, aucun `NSLog`).

import AuthenticationServices
import Foundation
import Tauri
import UIKit

// MARK: - Codes et arguments

private enum Code: String {
  case cancelled = "cancelled"
  case unavailable = "unavailable"
  case failed = "failed"
}

struct AuthenticateArgs: Decodable {
  let url: String
  let callbackScheme: String
}

/// Ancre de présentation : la fenêtre de l'app, relevée au lancement de la session.
private final class PresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
  private let anchor: ASPresentationAnchor

  init(anchor: ASPresentationAnchor) {
    self.anchor = anchor
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    return anchor
  }
}

// MARK: - Plugin

class WebAuthPlugin: Plugin {
  /// Session en cours et son ancre (fil principal) : la session ne vit que si on la retient, l'ancre n'est retenue que faiblement par elle.
  private var session: ASWebAuthenticationSession?
  private var context: PresentationContext?

  private func reject(_ invoke: Invoke, _ code: Code) {
    invoke.reject(code.rawValue, code: code.rawValue)
  }

  /// Défense en profondeur (Rust a déjà contrôlé l'hôte) : `https`, ou `http` vers 127.0.0.1 dans un build de développement.
  private func isAllowed(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else {
      return false
    }
    if scheme == "https" {
      return url.host != nil
    }
    #if DEBUG
      return scheme == "http" && url.host == "127.0.0.1"
    #else
      return false
    #endif
  }

  /// Fin de la session : libère la session et rend le résultat (sur le fil principal).
  private func finish(_ invoke: Invoke, callbackScheme: String, callbackURL: URL?, error: Error?) {
    session = nil
    context = nil
    if let failure = error {
      if let authError = failure as? ASWebAuthenticationSessionError {
        switch authError.code {
        case .canceledLogin:
          reject(invoke, .cancelled)
        case .presentationContextNotProvided, .presentationContextInvalid:
          reject(invoke, .unavailable)
        default:
          reject(invoke, .failed)
        }
      } else {
        reject(invoke, .failed)
      }
      return
    }
    guard let returned = callbackURL, returned.scheme?.lowercased() == callbackScheme.lowercased() else {
      reject(invoke, .failed)
      return
    }
    invoke.resolve(["callbackUrl": returned.absoluteString])
  }

  /// `authenticate({ url, callbackScheme }) -> { callbackUrl }` ; rejets `cancelled`, `unavailable`, `failed`.
  @objc public func authenticate(_ invoke: Invoke) {
    let input: AuthenticateArgs
    do {
      input = try invoke.parseArgs(AuthenticateArgs.self)
    } catch {
      reject(invoke, .failed)
      return
    }
    DispatchQueue.main.async {
      guard let url = URL(string: input.url), self.isAllowed(url), !input.callbackScheme.isEmpty else {
        self.reject(invoke, .failed)
        return
      }
      if self.session != nil {
        self.reject(invoke, .unavailable)
        return
      }
      guard let window = self.manager.viewController?.view.window else {
        self.reject(invoke, .unavailable)
        return
      }
      let presentation = PresentationContext(anchor: window)
      let created = ASWebAuthenticationSession(url: url, callbackURLScheme: input.callbackScheme) { callbackURL, error in
        DispatchQueue.main.async {
          self.finish(invoke, callbackScheme: input.callbackScheme, callbackURL: callbackURL, error: error)
        }
      }
      created.prefersEphemeralWebBrowserSession = false
      created.presentationContextProvider = presentation
      self.session = created
      self.context = presentation
      if !created.start() {
        self.session = nil
        self.context = nil
        self.reject(invoke, .unavailable)
      }
    }
  }
}

@_cdecl("init_plugin_web_auth")
func initPlugin() -> Plugin {
  return WebAuthPlugin()
}
