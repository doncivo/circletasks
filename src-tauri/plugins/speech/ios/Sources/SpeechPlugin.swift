// Plugin speech de CircleTasks (CAP-IOS-01, ADR 0015 section 2.2) : dictée française SUR L'APPAREIL et ouverture des Réglages de l'app.
//
// Contrat : tests/fixtures/capture/speech-contract.json (noms, champs, codes), relu par un contrôle statique contre ce fichier et
// src-tauri/src/speech/mod.rs. Seul Rust appelle ces commandes (aucune permission pour la WebView).
//
// Règles :
// - aucune chaîne d'interface ni libellé ici ; rejet = un code du contrat (`invoke.reject(code.rawValue, code: code.rawValue)`),
//   jamais le texte d'une erreur système, ni un texte reconnu ;
// - la reconnaissance est imposée sur l'appareil (une seule affectation du réglage, à vrai) : sans modèle français, `on-device-unavailable`,
//   jamais un repli vers les serveurs d'Apple ;
// - tout l'état (session d'écoute, moteur audio, requête, tâche) vit sur `speechQueue` (série, dédiée) ; les rappels du reconnaisseur y
//   arrivent par `recognizer.queue` ; `listen` garde l'appel en attente et rend la file IPC de Tauri aussitôt, si bien que `stop` peut
//   arriver pendant l'écoute ;
// - une fin unique et idempotente (`finish` puis `complete`, ou `abort`) arrête le moteur, retire le tap, désactive la session audio et
//   rend toutes les références ; chaque appel résout ou rejette exactement une fois ;
// - rien n'est enregistré : les tampons audio vont directement à la requête, le texte partiel reste en mémoire jusqu'à la fin.

import AVFAudio
import Foundation
import Speech
import Tauri
import UIKit
import WebKit

// MARK: - Codes et arguments

private enum Code: String {
  case invalidArgument = "invalid-argument"
  case microphoneDenied = "microphone-denied"
  case speechRecognitionDenied = "speech-recognition-denied"
  case onDeviceUnavailable = "on-device-unavailable"
  case recognizerUnavailable = "recognizer-unavailable"
  case busy = "busy"
  case audioUnavailable = "audio-unavailable"
  case failed = "failed"
}

struct ListenArgs: Decodable {
  let locale: String
  let maxDurationMs: Int
}

struct StopArgs: Decodable {
  let reason: String
}

/// Une écoute en cours (lue et écrite sur `speechQueue` seulement).
private final class Listening {
  let invoke: Invoke
  let recognizer: SFSpeechRecognizer
  let engine = AVAudioEngine()
  let request = SFSpeechAudioBufferRecognitionRequest()
  var task: SFSpeechRecognitionTask?
  var text = ""
  var stoppedBy = "user"
  var finishing = false
  var completed = false
  var capItem: DispatchWorkItem?
  var waitItem: DispatchWorkItem?

  init(invoke: Invoke, recognizer: SFSpeechRecognizer) {
    self.invoke = invoke
    self.recognizer = recognizer
  }
}

// MARK: - Plugin

class SpeechPlugin: Plugin {
  private let speechQueue = DispatchQueue(label: "fr.circletasks.speech.state", qos: .userInitiated)
  /// Attente du résultat final après la fin de l'audio (s), puis la tâche est annulée.
  private let finalResultWaitSeconds: Double = 1.5
  /// Code d'erreur de la reconnaissance pour « aucune parole détectée ».
  private let noSpeechErrorCode = 1110
  private var current: Listening?
  private var observers: [NSObjectProtocol] = []

  // MARK: Cycle de vie

  @objc public override func load(webview: WKWebView) {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
        self?.speechQueue.async { self?.finishCurrent("background") }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        if raw == AVAudioSession.InterruptionType.began.rawValue {
          self?.speechQueue.async { self?.finishCurrent("interrupted") }
        }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        if raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
          self?.speechQueue.async { self?.finishCurrent("interrupted") }
        }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
        self?.speechQueue.async {
          if let session = self?.current {
            self?.abort(session, .audioUnavailable)
          }
        }
      })
  }

  // MARK: Outils communs

  private func reject(_ invoke: Invoke, _ code: Code) {
    invoke.reject(code.rawValue, code: code.rawValue)
  }

  /// Arguments décodés, sinon `invalid-argument` (jamais le texte du décodeur).
  private func args<T: Decodable>(_ invoke: Invoke, _ type: T.Type) -> T? {
    do {
      return try invoke.parseArgs(type)
    } catch {
      reject(invoke, .invalidArgument)
      return nil
    }
  }

  private func microphoneState() -> String {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return "granted"
    case .denied:
      return "denied"
    case .undetermined:
      return "prompt"
    @unknown default:
      return "unknown"
    }
  }

  private func speechState() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
      return "granted"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    case .notDetermined:
      return "prompt"
    @unknown default:
      return "unknown"
    }
  }

  private func frenchRecognizer() -> SFSpeechRecognizer? {
    return SFSpeechRecognizer(locale: Locale(identifier: "fr-FR"))
  }

  // MARK: Commandes

  /// Lit l'état du service et des deux autorisations, sans ouvrir aucune fenêtre d'iOS.
  @objc public func status(_ invoke: Invoke) {
    speechQueue.async {
      let recognizer = self.frenchRecognizer()
      invoke.resolve([
        "recognizer": recognizer != nil,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "microphone": self.microphoneState(),
        "speechRecognition": self.speechState(),
      ])
    }
  }

  /// Remplace la méthode de même nom de la classe de base de Tauri. Demande le micro, puis (si accordé) la reconnaissance vocale. Un état déjà décidé n'est jamais redemandé.
  @objc public override func requestPermissions(_ invoke: Invoke) {
    speechQueue.async {
      self.askMicrophone {
        if self.microphoneState() == "granted" {
          self.askSpeech { self.resolvePermissions(invoke) }
        } else {
          self.resolvePermissions(invoke)
        }
      }
    }
  }

  private func askMicrophone(_ done: @escaping () -> Void) {
    if AVAudioApplication.shared.recordPermission != .undetermined {
      done()
      return
    }
    AVAudioApplication.requestRecordPermission { _ in
      self.speechQueue.async { done() }
    }
  }

  private func askSpeech(_ done: @escaping () -> Void) {
    if SFSpeechRecognizer.authorizationStatus() != .notDetermined {
      done()
      return
    }
    SFSpeechRecognizer.requestAuthorization { _ in
      self.speechQueue.async { done() }
    }
  }

  private func resolvePermissions(_ invoke: Invoke) {
    invoke.resolve(["microphone": microphoneState(), "speechRecognition": speechState()])
  }

  /// Écoute en français puis rend `{ text, stoppedBy }` à la fin (arrêt demandé, butée, arrière-plan, interruption).
  @objc public func listen(_ invoke: Invoke) {
    guard let input = args(invoke, ListenArgs.self) else {
      return
    }
    if input.locale != "fr-FR" || input.maxDurationMs <= 0 {
      reject(invoke, .invalidArgument)
      return
    }
    speechQueue.async {
      self.startListening(input, invoke)
    }
  }

  /// Arrête l'écoute en cours (la cause est transmise au résultat) ; sans écoute, rend `stopped: false`.
  @objc public func stop(_ invoke: Invoke) {
    guard let input = args(invoke, StopArgs.self) else {
      return
    }
    speechQueue.async {
      guard let session = self.current, !session.finishing else {
        invoke.resolve(["stopped": false])
        return
      }
      let allowed = ["user", "time-limit", "background"]
      self.finish(session, allowed.contains(input.reason) ? input.reason : "user", immediate: false)
      invoke.resolve(["stopped": true])
    }
  }

  /// Ouvre la page de l'app dans Réglages iOS ; résout toujours, avec `opened: false` si iOS refuse.
  @objc public func openAppSettings(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let url = URL(string: UIApplication.openSettingsURLString), UIApplication.shared.canOpenURL(url) else {
        invoke.resolve(["opened": false])
        return
      }
      UIApplication.shared.open(url, options: [:]) { success in
        invoke.resolve(["opened": success])
      }
    }
  }

  // MARK: Écoute (speechQueue)

  private func startListening(_ input: ListenArgs, _ invoke: Invoke) {
    if current != nil {
      reject(invoke, .busy)
      return
    }
    if microphoneState() != "granted" {
      reject(invoke, .microphoneDenied)
      return
    }
    if speechState() != "granted" {
      reject(invoke, .speechRecognitionDenied)
      return
    }
    guard let recognizer = frenchRecognizer() else {
      reject(invoke, .recognizerUnavailable)
      return
    }
    // Reconnaisseur indisponible : refus, aucune requête créée.
    if !recognizer.isAvailable {
      reject(invoke, .recognizerUnavailable)
      return
    }
    // Sans modèle français sur l'appareil : refus, aucune requête créée, aucun envoi vers le réseau.
    if !recognizer.supportsOnDeviceRecognition {
      reject(invoke, .onDeviceUnavailable)
      return
    }
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.underlyingQueue = speechQueue
    recognizer.queue = queue

    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
      try audioSession.setActive(true, options: [])
    } catch {
      reject(invoke, .audioUnavailable)
      return
    }

    let session = Listening(invoke: invoke, recognizer: recognizer)
    let request = session.request
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    request.taskHint = .dictation
    current = session

    session.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      self?.handle(session, result: result, error: error)
    }

    let inputNode = session.engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    if format.sampleRate <= 0 || format.channelCount == 0 {
      abort(session, .audioUnavailable)
      return
    }
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
    session.engine.prepare()
    do {
      try session.engine.start()
    } catch {
      abort(session, .audioUnavailable)
      return
    }

    let cap = DispatchWorkItem { [weak self] in
      self?.finish(session, "time-limit", immediate: false)
    }
    session.capItem = cap
    speechQueue.asyncAfter(deadline: .now() + Double(input.maxDurationMs) / 1000.0, execute: cap)
  }

  /// Résultat ou erreur de la tâche (arrive sur `speechQueue`).
  private func handle(_ session: Listening, result: SFSpeechRecognitionResult?, error: Error?) {
    if session.completed {
      return
    }
    if let result = result {
      session.text = result.bestTranscription.formattedString
      if result.isFinal {
        // Le texte final est arrivé : fin de la dictée.
        if !session.finishing {
          finish(session, "user", immediate: true)
        } else {
          complete(session)
        }
        return
      }
    }
    guard let failure = error else {
      return
    }
    if session.finishing {
      // Erreur attendue après la fin de l'audio (par exemple aucune parole) : on rend le texte déjà reconnu.
      complete(session)
      return
    }
    if !session.text.isEmpty || (failure as NSError).code == noSpeechErrorCode {
      finish(session, "interrupted", immediate: true)
      return
    }
    abort(session, session.recognizer.supportsOnDeviceRecognition ? .failed : .onDeviceUnavailable)
  }

  private func finishCurrent(_ stoppedBy: String) {
    if let session = current {
      finish(session, stoppedBy, immediate: false)
    }
  }

  /// Fin de l'audio (idempotente) : moteur arrêté, tap retiré, requête close ; le résultat final est attendu au plus 1,5 s.
  private func finish(_ session: Listening, _ stoppedBy: String, immediate: Bool) {
    if session.finishing {
      return
    }
    session.finishing = true
    session.stoppedBy = stoppedBy
    session.capItem?.cancel()
    release(session)
    session.request.endAudio()
    if immediate {
      complete(session)
      return
    }
    let wait = DispatchWorkItem { [weak self] in
      self?.complete(session)
    }
    session.waitItem = wait
    speechQueue.asyncAfter(deadline: .now() + finalResultWaitSeconds, execute: wait)
  }

  /// Moteur arrêté et tap retiré.
  private func release(_ session: Listening) {
    if session.engine.isRunning {
      session.engine.stop()
    }
    session.engine.inputNode.removeTap(onBus: 0)
  }

  /// Dernière étape : tâche annulée, session audio désactivée, références rendues, texte rendu (une seule fois).
  private func complete(_ session: Listening) {
    if session.completed {
      return
    }
    session.completed = true
    teardown(session)
    let text = session.text
    session.text = ""
    session.invoke.resolve(["text": text, "stoppedBy": session.stoppedBy])
  }

  /// Échec : même nettoyage, puis rejet d'un code du contrat (une seule fois).
  private func abort(_ session: Listening, _ code: Code) {
    if session.completed {
      return
    }
    session.completed = true
    session.finishing = true
    session.capItem?.cancel()
    release(session)
    session.request.endAudio()
    teardown(session)
    reject(session.invoke, code)
  }

  private func teardown(_ session: Listening) {
    session.capItem?.cancel()
    session.waitItem?.cancel()
    session.capItem = nil
    session.waitItem = nil
    session.task?.cancel()
    session.task = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    if current === session {
      current = nil
    }
  }
}

@_cdecl("init_plugin_speech")
func initPlugin() -> Plugin {
  return SpeechPlugin()
}
