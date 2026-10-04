//! OCR du PC (Q-04, PRD sections 7 et 10) : Windows.Media.Ocr en français, via des commandes Rust.
//!
//! Sécurité : l'image arrive en mémoire (corps binaire de la commande), est lue dans un flux mémoire
//! et libérée à la fin de l'appel. Rien n'est écrit sur le disque, rien n'est envoyé sur le réseau.
//! Aucun texte d'interface ici : le front traduit les codes d'erreur.

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

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
}

/// Lignes lues, dans l'ordre de la page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OcrResult {
    pub lines: Vec<OcrLine>,
}

/// Une ligne lue. Windows.Media.Ocr ne donne aucune confiance (Q-04 décision D2) : le champ est absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OcrLine {
    pub text: String,
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
        .map(|line| {
            let cleaned: String = line.as_ref().chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
            cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
        })
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
        .map(|text| OcrLine { text })
        .collect()
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
        OcrStatus { available: false, languages: Vec::new() }
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
pub async fn ocr_status() -> OcrStatus {
    tauri::async_runtime::spawn_blocking(status_blocking)
        .await
        .unwrap_or(OcrStatus { available: false, languages: Vec::new() })
}

/// Lit une image (corps binaire de la requête : PNG, JPEG ou BMP) en français.
///
/// Erreurs `{ code, message }` : `ocr-empty-image`, `ocr-too-large`, `ocr-unsupported-format`,
/// `ocr-dimensions-too-large`, `ocr-language-missing`, `ocr-unavailable`, `ocr-engine`.
#[tauri::command]
pub async fn ocr_recognize(request: Request<'_>) -> Result<OcrResult, OcrCommandError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(OcrError::EmptyImage.into());
    };
    validate_image(bytes)?;
    let owned = bytes.clone();
    let lines = tauri::async_runtime::spawn_blocking(move || recognize_blocking(&owned))
        .await
        .map_err(|e| OcrCommandError::from(OcrError::Engine(e.to_string())))??;
    Ok(OcrResult { lines: clean_lines(lines) })
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
