/**
 * Réglages d'iOS de l'app (autorisations) : une seule fonction, `openAppSettings()`, qui appelle la commande existante du plugin de lecture de code QR
 * (`openAppSettings`, déjà utilisée pour la caméra). Sans l'app installée (navigateur, PC) l'appel échoue : l'appelant garde le texte qui explique le chemin.
 */
export async function openAppSettings(): Promise<void> {
  const plugin = await import('@tauri-apps/plugin-barcode-scanner');
  await plugin.openAppSettings();
}
