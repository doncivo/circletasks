//! Les commandes applicatives sont déclarées dans un manifeste : Tauri génère une permission
//! `allow-<commande>` par commande, et seules les capabilities qui la citent peuvent l'appeler
//! (permissions minimales, D-01). À mettre à jour avec `desktop::set_tray_labels`.

fn main() {
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
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["set_tray_labels", "confirm_quit", "backup_database_before_migration"])),
    )
    .expect("échec de la configuration de la compilation Tauri");
}
