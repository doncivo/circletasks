import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CAP-IOS-01 (ADR 0015 §4.1) et I-05 critère 6 : cohérence TypeScript / Rust / Swift sans Mac.
 * - un seul fichier nomme chaque commande (`nativeOcr.ts`, `tauriSpeech.ts`) ;
 * - la prise de développement `__ctSpeech` est retirée du build ; aucune demande d'autorisation au démarrage ;
 * - les demandes d'autorisation de l'app n'existent que dans une liste blanche, appelées depuis des gestionnaires de geste.
 */
const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.|\.spec\.|\.d\.ts$/.test(entry.name)) out.push(path.replaceAll('\\', '/'));
  }
  return out;
}

// Lus une seule fois, à la collecte (jamais dans le délai d'un test).
const CONTENTS = new Map(sources('src').map((file) => [file, read(file)] as const));
const filesNaming = (needle: RegExp): string[] => [...CONTENTS].filter(([, text]) => needle.test(text)).map(([file]) => file);

describe('commandes de la capture sur iPhone : un seul fichier les nomme', () => {
  it('speech_* : tauriSpeech.ts seul ; app_settings_open : tauriSystemSettings.ts seul', () => {
    expect(filesNaming(/['"]speech_[a-z_]+['"]/)).toEqual(['src/platform/speech/tauriSpeech.ts']);
    expect(filesNaming(/['"]app_settings_open['"]/)).toEqual(['src/platform/systemSettings/tauriSystemSettings.ts']);
  });

  it('ocr_status et ocr_recognize : nativeOcr.ts seul', () => {
    expect(filesNaming(/['"](ocr_status|ocr_recognize)['"]/)).toEqual(['src/platform/ocr/nativeOcr.ts']);
  });

  it('les noms de commande du TypeScript = le manifeste Rust = la capability iOS', () => {
    const adapter = read('src/platform/speech/tauriSpeech.ts') + read('src/platform/systemSettings/tauriSystemSettings.ts');
    const ocr = read('src/platform/ocr/nativeOcr.ts');
    const build = read('src-tauri/build.rs');
    const capability = JSON.parse(read('src-tauri/capabilities/capture-ios.json')) as { permissions: string[] };
    const names = [...adapter.matchAll(/_COMMAND = '([a-z_]+)'/g), ...ocr.matchAll(/_COMMAND = '([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(names.sort()).toEqual(['app_settings_open', 'ocr_recognize', 'ocr_status', 'speech_listen', 'speech_request_permissions', 'speech_status', 'speech_stop']);
    for (const name of names) {
      expect(build, name).toContain(`"${name}"`);
      expect(capability.permissions, name).toContain(`allow-${name.replaceAll('_', '-')}`);
    }
  });

  it('tous les codes Rust du contrat sont traités par l’adaptateur de dictée', () => {
    const contract = JSON.parse(read('tests/fixtures/capture/speech-contract.json')) as { swiftToRust: Record<string, string>; rustOnly: Record<string, string> };
    const adapter = read('src/platform/speech/tauriSpeech.ts');
    for (const code of ['speech-microphone-denied', 'speech-recognition-denied', 'speech-on-device-unavailable', 'speech-busy', 'speech-unavailable']) {
      expect(Object.values({ ...contract.swiftToRust, ...contract.rustOnly })).toContain(code);
      expect(adapter).toContain(`'${code}'`);
    }
  });

  it('tous les codes Rust d’OCR du contrat sont traités par nativeOcr.ts', () => {
    const contract = JSON.parse(read('tests/fixtures/capture/vision-contract.json')) as { swiftToRust: Record<string, string>; rustOnly: Record<string, string> };
    const adapter = read('src/platform/ocr/nativeOcr.ts');
    for (const code of ['ocr-language-missing', 'ocr-unsupported-format', 'ocr-dimensions-too-large', 'ocr-unavailable']) {
      expect(Object.values({ ...contract.swiftToRust, ...contract.rustOnly })).toContain(code);
      expect(adapter).toContain(`'${code}'`);
    }
  });
});

describe('prise de développement et démarrage', () => {
  it('__ctSpeech : lue sous import.meta.env.DEV seulement (retirée du build de production)', () => {
    const files = filesNaming(/__ctSpeech/);
    expect(files).toEqual(['src/platform/speech/index.ts']);
    const code = read(files[0] as string);
    expect(code).toMatch(/if \(import\.meta\.env\.DEV\) \{\s*const injected = \(globalThis as \{ __ctSpeech/);
  });

  it('le démarrage (bootstrap, startup, synchro) n’appelle aucune demande d’autorisation', () => {
    const startup = [...CONTENTS.keys()].filter((f) => /^src\/(features\/app\/(bootstrap|startup)\.ts|sync\/|platform\/sync\/)/.test(f)).filter((f) => !/barcodeScanner|tauriSync/.test(f));
    for (const file of startup) {
      expect(read(file), file).not.toMatch(/\.requestPermissions?\s*\(|Notification\.requestPermission|getUserMedia\s*\(/);
    }
    // Le branchement de la dictée au démarrage ne lit aucun état : il ne fait que créer le reconnaisseur paresseux.
    const bootstrap = read('src/features/app/bootstrap.ts');
    expect(bootstrap).toContain('openSpeechRecognizer(');
    expect(bootstrap).not.toMatch(/speech\.(permissions|requestPermissions|isAvailable)/);
  });

  it('I-05 critère 6 : liste blanche des appels de demande d’autorisation des écrans', () => {
    const callers = filesNaming(/\.requestPermissions?\b|Notification\.requestPermission|getUserMedia\(/).filter((file) => file.startsWith('src/features/'));
    expect([...callers].sort()).toEqual([
      'src/features/capture/Dictation.tsx',
      'src/features/capture/scan/prepareImage.ts',
      'src/features/reminders/requestPermission.ts',
    ]);
    // Dictation.tsx : la demande n'est atteinte que depuis « Continuer » (gestionnaire), jamais depuis un effet.
    const dictation = read('src/features/capture/Dictation.tsx');
    const request = dictation.indexOf('requestPermissions?.bind');
    const handler = dictation.lastIndexOf('const continueExplain = useCallback', request);
    expect(handler).toBeGreaterThan(-1);
    expect(dictation.slice(handler, request)).not.toContain('useEffect');
    expect(dictation.match(/requestPermissions/g)).toHaveLength(1);
    // prepareImage.ts : la webcam du PC ne démarre qu'après un clic explicite (startWebcam appelé depuis un gestionnaire de ScanSource).
    expect(read('src/features/capture/scan/ScanSource.tsx')).toContain('async function openWebcam');
  });
});
