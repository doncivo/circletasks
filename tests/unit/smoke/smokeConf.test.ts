import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * REL-TECH-01 (ADR 0016) : la surcharge de configuration du test de fumée (`tauri.smoke.conf.json`) répète la fenêtre `main` de Windows
 * (`tauri.windows.conf.json`, que Tauri fusionne avant `--config` : les tableaux sont remplacés, pas fusionnés) et n'ajoute que le port de
 * débogage ; le port n'existe dans aucune configuration livrée.
 */
const TAURI_DIR = join(import.meta.dirname, '..', '..', '..', 'src-tauri');

interface WindowConf {
  readonly label: string;
  readonly additionalBrowserArgs?: string;
  readonly [key: string]: unknown;
}

interface TauriConf {
  readonly identifier?: string;
  readonly app?: { readonly windows?: readonly WindowConf[] };
}

function read(name: string): { text: string; conf: TauriConf } {
  const text = readFileSync(join(TAURI_DIR, name), 'utf8');
  return { text, conf: JSON.parse(text) as TauriConf };
}

function mainWindow(conf: TauriConf): WindowConf {
  const main = conf.app?.windows?.find((window) => window.label === 'main');
  if (!main) throw new Error('fenêtre main absente');
  return main;
}

describe('REL-TECH-01 : configuration du test de fumée', () => {
  const smoke = read('tauri.smoke.conf.json');
  const windows = read('tauri.windows.conf.json');
  const base = read('tauri.conf.json');

  it('porte un identifiant .smoke distinct de celui de l’app', () => {
    expect(smoke.conf.identifier).toBe(`${base.conf.identifier ?? ''}.smoke`);
  });

  it('répète la fenêtre main de Windows à l’identique, plus les arguments WebView2', () => {
    const { additionalBrowserArgs, ...rest } = mainWindow(smoke.conf);
    expect(rest).toEqual(mainWindow(windows.conf));
    expect(additionalBrowserArgs).toBeDefined();
  });

  it('ouvre le port 9377 et garde les arguments par défaut de wry', () => {
    const args = mainWindow(smoke.conf).additionalBrowserArgs ?? '';
    expect(args).toContain('--remote-debugging-port=9377');
    expect(args).toContain('--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection');
    expect(args).toContain('--autoplay-policy=no-user-gesture-required');
  });

  it('aucune configuration livrée n’ouvre un port de débogage', () => {
    for (const { text } of [base, windows]) {
      expect(text).not.toContain('remote-debugging');
      expect(text).not.toContain('additionalBrowserArgs');
    }
  });
});
