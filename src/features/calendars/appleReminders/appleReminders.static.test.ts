import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * K-06 critère 9 (ADR 0008 §10.5, §10.8) : les écritures du passage utilisent les cas d'usage et les repositories seulement. Aucun SQL dans
 * la feature : ni `execute(` ni `select(` sur un pilote, ni requête littérale ; l'accès au plugin passe par `container.reminders` seulement.
 */
const dir = __dirname;
const sources = readdirSync(dir)
  .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'testKit.ts')
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));

describe('feature Rappels Apple : aucun SQL, aucun plugin direct', () => {
  it.each(sources.map((source) => [source.name, source.text] as const))('%s', (_, text) => {
    expect(text).not.toMatch(/\.(execute|select)\s*\(/);
    expect(text).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\s+(\*|INTO|FROM|\w+\s+SET)\b/);
    expect(text).not.toMatch(/sqlite|driver\.|db\.driver/i);
    expect(text).not.toMatch(/plugin:reminders|tauriReminders|@tauri-apps/);
    expect(text).not.toMatch(/\bfetch\(['"`]http/);
  });

  it('il y a bien des sources à contrôler', () => {
    expect(sources.map((source) => source.name)).toEqual(expect.arrayContaining(['remindersPass.ts', 'remindersWrites.ts', 'appleRemindersState.ts', 'appleGuards.ts']));
  });
});
