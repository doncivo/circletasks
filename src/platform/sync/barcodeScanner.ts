import type { QrScanner } from './tauriSync';

/**
 * Plugin barcode-scanner de l'app installée sur iPhone (ADR 0011 §23 point 2), chargé à la demande. Module à part de `tauriSync.ts` : la
 * fenêtre `pairing` du PC importe `tauriSync.ts` et garde ainsi son bundle minimal (liste blanche de `tests/bundle/pairingBundle.test.ts`).
 * Seul `index.ts` (fenêtre principale) l'importe, pour l'iPhone seulement.
 */
export function loadBarcodeScanner(): () => Promise<QrScanner> {
  return async () => {
    const plugin = await import('@tauri-apps/plugin-barcode-scanner');
    return {
      checkPermissions: () => plugin.checkPermissions(),
      requestPermissions: () => plugin.requestPermissions(),
      scan: (o) => plugin.scan({ windowed: o.windowed, formats: o.formats as typeof plugin.Format[keyof typeof plugin.Format][] }),
      cancel: () => plugin.cancel(),
      openAppSettings: () => plugin.openAppSettings(),
      qrFormat: plugin.Format.QRCode,
    };
  };
}

