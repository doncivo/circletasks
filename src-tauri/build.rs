//! Les commandes applicatives sont déclarées dans un manifeste : Tauri génère une permission
//! `allow-<commande>` par commande, et seules les capabilities qui la citent peuvent l'appeler
//! (permissions minimales, D-01). À mettre à jour avec `desktop::set_tray_labels`.

/// Identifiants client OAuth Google (ADR 0008 section 5, docs/stories/K-01.md) : variable d'environnement du build, sinon fichier `.env`
/// local à la racine du dépôt (ignoré par git). Jamais commités ; absents : l'app affiche « non configuré ».
const BUILD_SECRETS: [&str; 2] = ["CT_GOOGLE_CLIENT_ID", "CT_GOOGLE_CLIENT_SECRET"];

fn forward_local_env() {
    let dotenv = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("..").join(".env");
    println!("cargo:rerun-if-changed={}", dotenv.display());
    for key in BUILD_SECRETS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let Ok(text) = std::fs::read_to_string(&dotenv) else { return };
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim().trim_matches('"').trim_matches('\''));
        if BUILD_SECRETS.contains(&key) && !value.is_empty() && std::env::var_os(key).is_none() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn main() {
    forward_local_env();
    // Exécutables de test sous Windows : manifeste comctl32 v6 (voir windows-test.manifest).
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows") {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
            .join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        if std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc") {
            println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
        }
    }

    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["set_tray_labels", "confirm_quit", "backup_database_before_migration",
            // Agendas externes (ADR 0008) : PC et iPhone.
            "calendar_secret_set", "calendar_secret_exists", "calendar_secret_delete",
            "calendar_oauth_google_authorize", "calendar_oauth_google_revoke", "calendar_http",
        ])),
    )
    .expect("échec de la configuration de la compilation Tauri");
}
