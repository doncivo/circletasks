// Plugin vision de CircleTasks (CAP-IOS-01, ADR 0015 section 1.2) : lecture de texte d'une photo de liste avec Vision.
//
// Contrat : tests/fixtures/capture/vision-contract.json (noms, champs, codes), relu par un contrôle statique contre ce fichier et
// src-tauri/src/ocr/vision.rs. Seul Rust appelle ces commandes (aucune permission pour la WebView).
//
// Règles :
// - aucune chaîne d'interface ni libellé ici ; rejet = un code du contrat (`invoke.reject(code.rawValue, code: code.rawValue)`),
//   jamais le texte d'une erreur système, ni un texte reconnu ;
// - chaque méthode résout ou rejette sur tous ses chemins, une seule fois (`Settle`) ;
// - le travail tourne sur `visionQueue` (série, dédiée), jamais sur la file IPC partagée de Tauri ni sur le fil principal ;
// - l'image reste en mémoire : rien n'est écrit, rien n'est envoyé (ni fichier, ni réseau).

import CoreGraphics
import Foundation
import ImageIO
import Tauri
import Vision
import WebKit

// MARK: - Codes et arguments

private enum Code: String {
  case invalidArgument = "invalid-argument"
  case unsupportedFormat = "unsupported-format"
  case dimensions = "dimensions"
  case languageMissing = "language-missing"
  case busy = "busy"
  case timeout = "timeout"
  case failed = "failed"
}

private struct Failure: Error {
  let code: Code
}

struct RecognizeArgs: Decodable {
  let image: String
  let languages: [String]
  let maxSide: Int
  let maxLines: Int
}

/// Un seul résultat par appel : le premier qui passe (lecture terminée ou garde de temps) répond, l'autre se tait.
private final class Settle {
  private let lock = NSLock()
  private var done = false

  func first() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if done {
      return false
    }
    done = true
    return true
  }
}

// MARK: - Plugin

class VisionPlugin: Plugin {
  /// File des lectures (série, dédiée) : `perform` est synchrone et ne doit jamais tourner sur le fil principal.
  private let visionQueue = DispatchQueue(label: "fr.circletasks.vision.read", qos: .userInitiated)
  /// File des gardes de temps (distincte : la file de lecture est occupée pendant `perform`).
  private let guardQueue = DispatchQueue(label: "fr.circletasks.vision.guard", qos: .userInitiated)
  /// Garde de temps d'une lecture (s) : au-delà, la requête est annulée et `timeout` rendu.
  private let readTimeoutSeconds: Double = 15
  private let stateLock = NSLock()
  private var reading = false

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

  private func beginReading() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    if reading {
      return false
    }
    reading = true
    return true
  }

  private func endReading() {
    stateLock.lock()
    reading = false
    stateLock.unlock()
  }

  private func supportedLanguages(_ request: VNRecognizeTextRequest) throws -> [String] {
    do {
      return try request.supportedRecognitionLanguages()
    } catch {
      throw Failure(code: .failed)
    }
  }

  // MARK: Commandes

  /// Langues que Vision sait lire (niveau précis, révision 3).
  @objc public func status(_ invoke: Invoke) {
    visionQueue.async {
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.revision = VNRecognizeTextRequestRevision3
      do {
        let languages = try self.supportedLanguages(request)
        invoke.resolve(["languages": languages])
      } catch {
        self.reject(invoke, .failed)
      }
    }
  }

  /// Lit l'image et rend les lignes (texte, confiance de 0 à 1, position normalisée).
  @objc public func recognize(_ invoke: Invoke) {
    guard let input = args(invoke, RecognizeArgs.self) else {
      return
    }
    if input.maxSide <= 0 || input.maxLines <= 0 || input.languages.isEmpty {
      reject(invoke, .invalidArgument)
      return
    }
    if !beginReading() {
      reject(invoke, .busy)
      return
    }
    visionQueue.async {
      defer { self.endReading() }
      let settle = Settle()
      do {
        let lines = try self.read(input, settle: settle, invoke: invoke)
        if settle.first() {
          invoke.resolve(["lines": lines])
        }
      } catch let failure as Failure {
        if settle.first() {
          self.reject(invoke, failure.code)
        }
      } catch {
        if settle.first() {
          self.reject(invoke, .failed)
        }
      }
    }
  }

  // MARK: Lecture

  private func read(_ input: RecognizeArgs, settle: Settle, invoke: Invoke) throws -> [[String: Any]] {
    guard let data = Data(base64Encoded: input.image), !data.isEmpty else {
      throw Failure(code: .invalidArgument)
    }
    // Propriétés lues AVANT tout décodage : une image qui déclare des dimensions démesurées n'est jamais décodée.
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions), CGImageSourceGetCount(source) > 0 else {
      throw Failure(code: .unsupportedFormat)
    }
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, sourceOptions) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0
    else {
      throw Failure(code: .unsupportedFormat)
    }
    if width > input.maxSide || height > input.maxSide {
      throw Failure(code: .dimensions)
    }
    let rawOrientation = (properties[kCGImagePropertyOrientation] as? UInt32) ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, sourceOptions) else {
      throw Failure(code: .unsupportedFormat)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.revision = VNRecognizeTextRequestRevision3
    request.automaticallyDetectsLanguage = false
    let supported = try supportedLanguages(request)
    // Le français doit être lisible ; les autres langues demandées (anglais) ne servent que si Vision les connaît.
    let wanted = input.languages.filter { tag in supported.contains { $0.caseInsensitiveCompare(tag) == .orderedSame } }
    guard let first = input.languages.first, wanted.contains(where: { $0.caseInsensitiveCompare(first) == .orderedSame }) else {
      throw Failure(code: .languageMissing)
    }
    request.recognitionLanguages = wanted

    // Garde de temps : annule la requête et répond `timeout` si la lecture dépasse la butée.
    let guardItem = DispatchWorkItem { [weak self] in
      if settle.first() {
        request.cancel()
        self?.reject(invoke, .timeout)
      }
    }
    guardQueue.asyncAfter(deadline: .now() + readTimeoutSeconds, execute: guardItem)
    defer { guardItem.cancel() }

    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    do {
      try handler.perform([request])
    } catch {
      throw Failure(code: .failed)
    }
    let observations = request.results ?? []
    var lines: [[String: Any]] = []
    for observation in observations.prefix(input.maxLines) {
      guard let best = observation.topCandidates(1).first else {
        continue
      }
      let box = observation.boundingBox
      lines.append([
        "text": best.string,
        "confidence": Double(best.confidence),
        "x": Double(box.minX),
        "y": Double(box.maxY),
      ])
    }
    return lines
  }
}

@_cdecl("init_plugin_vision")
func initPlugin() -> Plugin {
  return VisionPlugin()
}
