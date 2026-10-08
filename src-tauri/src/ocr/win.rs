//! Windows.Media.Ocr (Windows 10 et 11) : flux mémoire, aucun fichier.

use windows::{
    core::HSTRING,
    Globalization::Language,
    Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat},
    Media::Ocr::OcrEngine,
    Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    Win32::System::Com::CoIncrementMTAUsage,
};
use std::sync::OnceLock;

use super::{check_dimensions, pick_french, OcrError, OcrStatus};

fn engine_error(error: windows::core::Error) -> OcrError {
    OcrError::Engine(error.to_string())
}

/// Maintient l'appartement multithread (MTA) du processus en vie jusqu'à sa fin.
///
/// Les fabriques WinRT (`OcrEngine`, `Language`…) sont mises en cache par `windows-rs` dans des statiques. Or l'MTA n'existe
/// que tant qu'un fil l'occupe : quand le fil qui l'a créé se termine (fil de `spawn_blocking` ou de test), l'MTA est détruit
/// et le pointeur en cache devient invalide ; l'appel suivant, depuis un autre fil, plante (STATUS_ACCESS_VIOLATION, constaté
/// sur le runner CI). `CoIncrementMTAUsage` garde l'MTA vivant ; les fils sans COM y entrent alors implicitement.
fn init_runtime() {
    static MTA: OnceLock<bool> = OnceLock::new();
    // SAFETY: appel sans pointeur ; le cookie n'est jamais libéré (usage valable pour la durée du processus).
    MTA.get_or_init(|| unsafe { CoIncrementMTAUsage() }.is_ok());
}

fn installed_tags() -> Vec<String> {
    let Ok(languages) = OcrEngine::AvailableRecognizerLanguages() else { return Vec::new() };
    languages.into_iter().filter_map(|language| language.LanguageTag().ok().map(|tag| tag.to_string())).collect()
}

pub fn status() -> OcrStatus {
    init_runtime();
    let languages = installed_tags();
    let available = pick_french(&languages).is_some();
    OcrStatus { available, languages, reason: None }
}

fn french_engine() -> Result<OcrEngine, OcrError> {
    let tags = installed_tags();
    let tag = pick_french(&tags).ok_or(OcrError::LanguageMissing)?;
    let language = Language::CreateLanguage(&HSTRING::from(tag.as_str())).map_err(engine_error)?;
    OcrEngine::TryCreateFromLanguage(&language).map_err(|_| OcrError::LanguageMissing)
}

pub fn recognize(bytes: &[u8]) -> Result<Vec<String>, OcrError> {
    init_runtime();
    let engine = french_engine()?;

    let stream = InMemoryRandomAccessStream::new().map_err(engine_error)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(engine_error)?;
    writer.WriteBytes(bytes).map_err(engine_error)?;
    writer.StoreAsync().map_err(engine_error)?.join().map_err(engine_error)?;
    writer.DetachStream().map_err(engine_error)?;
    stream.Seek(0).map_err(engine_error)?;

    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(engine_error)?.join().map_err(|_| OcrError::UnsupportedFormat)?;
    // Dimensions déclarées lues AVANT toute conversion : une image minuscule qui déclare des milliards de pixels (bombe de
    // décompression) est refusée sans jamais allouer le bitmap.
    let max = OcrEngine::MaxImageDimension().map_err(engine_error)?;
    let declared_width = decoder.PixelWidth().map_err(engine_error)?;
    let declared_height = decoder.PixelHeight().map_err(engine_error)?;
    check_dimensions(declared_width, declared_height, max)?;
    // Le moteur lit Bgra8 ou Gray8 ; la conversion se fait en mémoire.
    let bitmap = decoder
        .GetSoftwareBitmapConvertedAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)
        .map_err(engine_error)?
        .join()
        .map_err(engine_error)?;

    let result = engine.RecognizeAsync(&bitmap).map_err(engine_error)?.join().map_err(engine_error)?;
    let lines = result.Lines().map_err(engine_error)?;
    let texts = lines.into_iter().filter_map(|line| line.Text().ok().map(|text| text.to_string())).collect();
    // Flux et bitmap sont libérés à la sortie : l'image ne survit pas à l'appel.
    let _ = stream.Close();
    Ok(texts)
}
