import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BLURRED_EVENT,
  CAPTURE_WINDOW_LABEL,
  HIDE_COMMAND,
  MAIN_WINDOW_LABEL,
  RESIZE_COMMAND,
  SHOWN_EVENT,
} from './events';

/** Cohérence TypeScript / Rust / configuration de la capture rapide (Q-01) : une divergence casse ce test, pas l'app installée. */
const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const rust = read('src-tauri/src/capture.rs');
const desktop = read('src-tauri/src/desktop.rs');
const lib = read('src-tauri/src/lib.rs');
const build = read('src-tauri/build.rs');
const capability = JSON.parse(read('src-tauri/capabilities/capture.json')) as { windows: string[]; permissions: string[] };
const ocrCapability = JSON.parse(read('src-tauri/capabilities/ocr.json')) as { windows: string[]; permissions: string[] };

describe('capture rapide : cohérence avec src-tauri', () => {
  it('libellés de fenêtre et événements identiques des deux côtés', () => {
    expect(rust).toContain(`pub const CAPTURE_WINDOW: &str = "${CAPTURE_WINDOW_LABEL}";`);
    expect(rust).toContain(`pub const SHOWN_EVENT: &str = "${SHOWN_EVENT}";`);
    expect(rust).toContain(`pub const BLURRED_EVENT: &str = "${BLURRED_EVENT}";`);
    expect(desktop).toContain(`pub const MAIN_WINDOW: &str = "${MAIN_WINDOW_LABEL}";`);
  });

  it('les commandes existent, sont enregistrées, déclarées au manifeste et autorisées à la seule mini-fenêtre', () => {
    for (const command of [HIDE_COMMAND, RESIZE_COMMAND]) {
      expect(rust).toContain(`pub fn ${command}(`);
      expect(lib).toContain(`capture::${command}`);
      expect(build).toContain(`"${command}"`);
      expect(capability.permissions).toContain(`allow-${command.replace(/_/g, '-')}`);
    }
    expect(capability.windows).toEqual([CAPTURE_WINDOW_LABEL]);
  });

  it('la mini-fenêtre n’a aucune permission de base de données, de fichier, de réseau ni de fenêtre', () => {
    expect(capability.permissions.filter((permission) => /sql|fs:|http|opener|shell|window|autostart|updater|process|default/.test(permission))).toEqual([]);
  });

  it('les commandes OCR existent, sont enregistrées et réservées à la fenêtre principale', () => {
    const ocr = read('src-tauri/src/ocr/mod.rs');
    for (const command of ['ocr_status', 'ocr_recognize']) {
      expect(ocr).toContain(`pub async fn ${command}<R: Runtime>(`);
      expect(lib).toContain(`ocr::${command}`);
      expect(build).toContain(`"${command}"`);
      expect(ocrCapability.permissions).toContain(`allow-${command.replace(/_/g, '-')}`);
    }
    expect(ocrCapability.windows).toEqual([MAIN_WINDOW_LABEL]);
  });

  it('la page de la mini-fenêtre est un second point d’entrée Vite', () => {
    expect(rust).toContain('pub const CAPTURE_PAGE: &str = "capture.html";');
    expect(read('vite.config.ts')).toContain("capture.html");
    expect(read('capture.html')).toContain('/src/captureMain.tsx');
  });
});
