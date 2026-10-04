import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALENDAR_COMMANDS } from './tauriCalendars';
import { MemorySecretVault } from './memory';
import { PRODUCTION_ENDPOINTS } from './types';

/** Cohérence des contrats d'agendas entre TypeScript, Rust et configuration (ADR 0008). */
const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const capability = JSON.parse(read('src-tauri/capabilities/calendars.json')) as { permissions: string[]; platforms: string[] };
const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app: { security: { csp: Record<string, string> } } };
const hostsRs = read('src-tauri/src/calendars/hosts.rs');

describe('agendas : contrats TypeScript / Rust / configuration', () => {
  it('chaque commande est déclarée dans build.rs et autorisée sur PC et iPhone', () => {
    const buildRs = read('src-tauri/build.rs');
    for (const command of Object.values(CALENDAR_COMMANDS)) {
      expect(buildRs).toContain(`"${command}"`);
      expect(capability.permissions).toContain(`allow-${command.replace(/_/g, '-')}`);
    }
    expect(capability.permissions).toHaveLength(Object.values(CALENDAR_COMMANDS).length);
    expect(capability.platforms).toEqual(['windows', 'iOS']);
  });

  it('les hôtes de production sont dans la liste Rust et la WebView ne contacte aucun hôte externe', () => {
    for (const url of Object.values(PRODUCTION_ENDPOINTS)) expect(hostsRs).toContain(`"${new URL(url).host}"`);
    expect(conf.app.security.csp['connect-src']).toBe("'self' ipc: http://ipc.localhost");
  });
});

describe('coffre en mémoire', () => {
  it('range, détecte et efface un secret (suppression idempotente)', async () => {
    const vault = new MemorySecretVault();
    await vault.set('circletasks.calendar.a', 'secret');
    expect(await vault.has('circletasks.calendar.a')).toBe(true);
    await vault.delete('circletasks.calendar.a');
    await vault.delete('circletasks.calendar.a');
    expect(await vault.has('circletasks.calendar.a')).toBe(false);
  });
});
