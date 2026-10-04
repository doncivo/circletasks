//! Windows.Media.Ocr (Windows 10 et 11) : flux mémoire, aucun fichier.

use windows::{
    core::HSTRING,
    Globalization::Language,
    Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat},
    Media::Ocr::OcrEngine,
    Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
};

use super::{pick_french, OcrError, OcrStatus};

fn engine_error(error: windows::core::Error) -> OcrError {
    OcrError::Engine(error.to_string())
}

/// Le fil d'un `spawn_blocking` n'a pas de COM : initialisation multithread (sans effet si déjà faite).
fn init_runtime() {
    // SAFETY: appel sans pointeur ; l'erreur « mode déjà choisi » est sans conséquence ici.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
}

fn installed_tags() -> Vec<String> {
    let Ok(languages) = OcrEngine::AvailableRecognizerLanguages() else { return Vec::new() };
    languages.into_iter().filter_map(|language| language.LanguageTag().ok().map(|tag| tag.to_string())).collect()
}

pub fn status() -> OcrStatus {
    init_runtime();
    let languages = installed_tags();
    let available = pick_french(&languages).is_some();
    OcrStatus { available, languages }
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
    // Le moteur lit Bgra8 ou Gray8 ; la conversion se fait en mémoire.
    let bitmap = decoder
        .GetSoftwareBitmapConvertedAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)
        .map_err(engine_error)?
        .join()
        .map_err(engine_error)?;

    let max = OcrEngine::MaxImageDimension().map_err(engine_error)?;
    let width = u32::try_from(bitmap.PixelWidth().map_err(engine_error)?).unwrap_or(u32::MAX);
    let height = u32::try_from(bitmap.PixelHeight().map_err(engine_error)?).unwrap_or(u32::MAX);
    if width > max || height > max {
        return Err(OcrError::DimensionsTooLarge);
    }

    let result = engine.RecognizeAsync(&bitmap).map_err(engine_error)?.join().map_err(engine_error)?;
    let lines = result.Lines().map_err(engine_error)?;
    let texts = lines.into_iter().filter_map(|line| line.Text().ok().map(|text| text.to_string())).collect();
    // Flux et bitmap sont libérés à la sortie : l'image ne survit pas à l'appel.
    let _ = stream.Close();
    Ok(texts)
}
