//! OCR (Q-04, CAP-IOS-01, PRD sections 7 et 10) : Windows.Media.Ocr en français sur PC, Vision sur iPhone (plugin Swift `vision`, ADR 0015
//! section 1), derrière les deux mêmes commandes Rust.
//!
//! Sécurité : l'image arrive en mémoire (corps binaire de la commande), est lue dans un flux mémoire
//! et libérée à la fin de l'appel. Rien n'est écrit sur le disque, rien n'est envoyé sur le réseau.
//! Aucun texte d'interface ici : le front traduit les codes d'erreur.

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Runtime};

pub mod vision;
#[cfg(windows)]
mod win;

/// Langue de reconnaissance exigée (PRD section 10).
pub const LANGUAGE_PREFIX: &str = "fr";
/// Étiquette préférée si plusieurs variantes du français sont installées.
pub const PREFERRED_LANGUAGE: &str = "fr-FR";
/// Taille maximale acceptée par la commande : l'image est réduite à 2 000 px par le front,
/// 12 Mo laissent de la marge à un PNG de page photographiée tout en bornant la mémoire.
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
/// Pixels au plus (largeur x hauteur) : 2 000 px de côté côté front, 4 096 x 4 096 au pire pour le moteur ; au-delà, refus avant conversion.
pub const MAX_PIXELS: u64 = 16 * 1024 * 1024;
/// Nombre de lignes renvoyées au plus (le front en garde 100, Q-04 critère 5).
pub const MAX_LINES: usize = 500;

/// Formats que le décodeur du système lit sans extension ; le front convertit tout le reste en PNG.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Bmp,
}

/// Raisons d'un échec ; le front associe un message français à chaque code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OcrError {
    /// Aucune donnée reçue.
    EmptyImage,
    /// Plus de `MAX_IMAGE_BYTES`.
    TooLarge,
    /// Ni PNG, ni JPEG, ni BMP.
    UnsupportedFormat,
    /// Image plus grande que la limite du moteur (en pixels, côté le plus long).
    DimensionsTooLarge,
    /// Pack de langue français absent (PRD section 10).
    LanguageMissing,
    /// Système non Windows.
    Unavailable,
    /// Échec du moteur ou du décodeur.
    Engine(String),
}

impl OcrError {
    /// Code stable renvoyé au front.
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyImage => "ocr-empty-image",
            Self::TooLarge => "ocr-too-large",
            Self::UnsupportedFormat => "ocr-unsupported-format",
            Self::DimensionsTooLarge => "ocr-dimensions-too-large",
            Self::LanguageMissing => "ocr-language-missing",
            Self::Unavailable => "ocr-unavailable",
            Self::Engine(_) => "ocr-engine",
        }
    }
}

/// Erreur de commande `{ code, message }` (ADR 0001).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OcrCommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<OcrError> for OcrCommandError {
    fn from(error: OcrError) -> Self {
        Self { code: error.code(), message: format!("{error:?}") }
    }
}

/// État du moteur : présence du français avec reconnaissance de texte (Q-04 critère 11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
    /// Vrai si un pack français est installé et utilisable.
    pub available: bool,
    /// Étiquettes des langues de reconnaissance installées (`fr-FR`, `en-US`…).
    pub languages: Vec<String>,
    /// Pourquoi le moteur est indisponible (iPhone seulement, ADR 0015 §1.1) : `language-missing` ou `plugin-unavailable`. Absent sur PC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// Lignes lues, dans l'ordre de la page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OcrResult {
    pub lines: Vec<OcrLine>,
}

/// Une ligne lue. Windows.Media.Ocr ne donne aucune confiance (Q-04 décision D2) : le champ est absent ; Vision la donne (0 à 100).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OcrLine {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<u8>,
}

/// Format de l'image d'après ses premiers octets (jamais d'après un nom de fichier).
pub fn sniff_image(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if bytes.starts_with(b"BM") && bytes.len() > 14 {
        Some(ImageKind::Bmp)
    } else {
        None
    }
}

/// Dimensions déclarées par l'en-tête de l'image : refus si un côté dépasse `max_side` (limite du moteur) ou si le total dépasse `MAX_PIXELS`.
pub fn check_dimensions(width: u32, height: u32, max_side: u32) -> Result<(), OcrError> {
    if width == 0 || height == 0 || width > max_side || height > max_side || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(OcrError::DimensionsTooLarge);
    }
    Ok(())
}

/// Plus grand côté accepté par Vision (ADR 0015 §1.1) : le front réduit à 2 000 px, 4 096 couvre le cas où `prepareImage` rend la source.
pub const VISION_MAX_SIDE: u32 = 4096;

/// Nombre maximal de segments JPEG parcourus pour trouver l'en-tête de dimensions (parcours borné).
const MAX_JPEG_SEGMENTS: usize = 256;

/// Dimensions (largeur, hauteur) déclarées par l'en-tête, sans décoder l'image. PNG : bloc `IHDR` ; JPEG : premier segment `SOF0` à `SOF15`
/// (hors `DHT`, `JPG`, `DAC`). `None` si l'en-tête est absent, tronqué ou incohérent ; BMP : non lu (refusé sur iPhone).
pub fn declared_dimensions(bytes: &[u8], kind: ImageKind) -> Option<(u32, u32)> {
    match kind {
        ImageKind::Png => {
            if bytes.len() < 24 || &bytes[12..16] != b"IHDR" {
                return None;
            }
            let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
            let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            Some((width, height))
        }
        ImageKind::Jpeg => {
            let mut at = 2usize;
            for _ in 0..MAX_JPEG_SEGMENTS {
                // Marqueur : 0xFF, éventuellement précédé d'octets de bourrage 0xFF.
                if *bytes.get(at)? != 0xFF {
                    return None;
                }
                while *bytes.get(at)? == 0xFF {
                    at += 1;
                }
                let marker = *bytes.get(at)?;
                at += 1;
                match marker {
                    // Sans longueur : TEM, RSTn, SOI.
                    0x01 | 0xD0..=0xD8 => continue,
                    // Fin d'image ou début des données : plus d'en-tête à lire.
                    0xD9 | 0xDA => return None,
                    _ => {}
                }
                let length = usize::from(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]));
                if length < 2 {
                    return None;
                }
                if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                    let height = u32::from(u16::from_be_bytes([*bytes.get(at + 3)?, *bytes.get(at + 4)?]));
                    let width = u32::from(u16::from_be_bytes([*bytes.get(at + 5)?, *bytes.get(at + 6)?]));
                    return Some((width, height));
                }
                at += length;
            }
            None
        }
        ImageKind::Bmp => None,
    }
}

/// Contrôle des entrées de `ocr_recognize` sur iPhone, avant tout appel du plugin (ADR 0015 §1.1) : PNG et JPEG seulement, dimensions
/// déclarées lues et bornées par `VISION_MAX_SIDE` et `MAX_PIXELS`.
pub fn validate_for_vision(bytes: &[u8]) -> Result<ImageKind, OcrError> {
    let kind = validate_image(bytes)?;
    if kind == ImageKind::Bmp {
        return Err(OcrError::UnsupportedFormat);
    }
    let (width, height) = declared_dimensions(bytes, kind).ok_or(OcrError::UnsupportedFormat)?;
    if width == 0 || height == 0 {
        return Err(OcrError::UnsupportedFormat);
    }
    check_dimensions(width, height, VISION_MAX_SIDE)?;
    Ok(kind)
}

/// Contrôle des entrées de `ocr_recognize` (Q-04 sous-tâche 2).
pub fn validate_image(bytes: &[u8]) -> Result<ImageKind, OcrError> {
    if bytes.is_empty() {
        return Err(OcrError::EmptyImage);
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(OcrError::TooLarge);
    }
    sniff_image(bytes).ok_or(OcrError::UnsupportedFormat)
}

/// Nettoie les lignes brutes du moteur : caractères de contrôle ôtés, espaces de bord retirés et
/// multiples réduits, lignes vides supprimées, au plus `MAX_LINES`. Le sens des lignes n'est pas
/// interprété ici (puces, dates : front).
pub fn clean_lines<I, S>(raw: I) -> Vec<OcrLine>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    raw.into_iter()
        .map(|line| clean_text(line.as_ref()))
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
        .map(|text| OcrLine { text, confidence: None })
        .collect()
}

/// Nettoyage d'une ligne : caractères de contrôle remplacés par des espaces, espaces de bord retirés et multiples réduits.
pub fn clean_text(line: &str) -> String {
    let cleaned: String = line.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Choisit la variante du français à utiliser : `fr-FR` si présente, sinon la première `fr`/`fr-*`.
pub fn pick_french(installed: &[String]) -> Option<&String> {
    let is_french = |tag: &&String| {
        let lower = tag.to_lowercase();
        lower == LANGUAGE_PREFIX || lower.starts_with("fr-")
    };
    installed.iter().find(|tag| tag.eq_ignore_ascii_case(PREFERRED_LANGUAGE)).or_else(|| installed.iter().find(is_french))
}

fn status_blocking() -> OcrStatus {
    #[cfg(windows)]
    {
        win::status()
    }
    #[cfg(not(windows))]
    {
        OcrStatus { available: false, languages: Vec::new(), reason: None }
    }
}

fn recognize_blocking(bytes: &[u8]) -> Result<Vec<String>, OcrError> {
    #[cfg(windows)]
    {
        win::recognize(bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err(OcrError::Unavailable)
    }
}

/// Langues de reconnaissance installées et présence du français (premier scan, Q-04 critère 11).
/// N'échoue jamais : un système sans moteur donne `available: false`.
#[tauri::command]
pub async fn ocr_status<R: Runtime>(app: AppHandle<R>) -> OcrStatus {
    #[cfg(target_os = "ios")]
    {
        vision::status_on_device(&app).await
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(status_blocking)
            .await
            .unwrap_or(OcrStatus { available: false, languages: Vec::new(), reason: None })
    }
}

/// Lit une image (corps binaire de la requête : PNG, JPEG ou BMP sur PC ; PNG ou JPEG sur iPhone) en français.
///
/// Erreurs `{ code, message }` : `ocr-empty-image`, `ocr-too-large`, `ocr-unsupported-format`,
/// `ocr-dimensions-too-large`, `ocr-language-missing`, `ocr-unavailable`, `ocr-engine`.
#[tauri::command]
pub async fn ocr_recognize<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<OcrResult, OcrCommandError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(OcrError::EmptyImage.into());
    };
    #[cfg(target_os = "ios")]
    {
        vision::recognize_on_device(&app, bytes.clone()).await
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = &app;
        validate_image(bytes)?;
        let owned = bytes.clone();
        let lines = tauri::async_runtime::spawn_blocking(move || recognize_blocking(&owned))
            .await
            .map_err(|e| OcrCommandError::from(OcrError::Engine(e.to_string())))??;
        Ok(OcrResult { lines: clean_lines(lines) })
    }
}

/// Lecture directe pour les tests d'intégration (même chemin que la commande, sans IPC).
pub fn recognize_bytes(bytes: &[u8]) -> Result<OcrResult, OcrError> {
    validate_image(bytes)?;
    recognize_blocking(bytes).map(|lines| OcrResult { lines: clean_lines(lines) })
}

/// État du moteur pour les tests d'intégration.
pub fn status() -> OcrStatus {
    status_blocking()
}
