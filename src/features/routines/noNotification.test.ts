import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R-02 critère 7 : le PC n'émet aucun rappel (CLAUDE.md : « Rappels émis sur l'iPhone uniquement »). Le module Routines ne fait
 * qu'écrire des données de rappel (`reminder`) ; il n'appelle jamais de notification.
 */
describe('Routines : aucune notification émise', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(here).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'testKit.tsx');

  it('aucun fichier du module n’importe un plugin de notification ni n’appelle l’API Notification', () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const name of sources) {
      const code = readFileSync(join(here, name), 'utf8');
      expect(code, name).not.toMatch(/plugin-notification|new Notification\(|Notification\.requestPermission|sendNotification/);
    }
  });
});
