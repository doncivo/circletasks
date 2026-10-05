import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fr } from '../../i18n/fr';

/**
 * P-04 : la boîte système montrée par Rust quand la récupération échoue précède toute WebView ; son début doit rester celui du texte
 * `backup.recoveryFailed` de `src/i18n`, sans quoi les deux dériveraient.
 */
describe('Message de récupération impossible (P-04)', () => {
  it('RECOVERY_FAILED_MESSAGE de desktop.rs commence par le texte français de backup.recoveryFailed', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../src-tauri/src/desktop.rs'), 'utf8');
    const match = /pub const RECOVERY_FAILED_MESSAGE: &str = "([^"]*)";/.exec(source);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').startsWith(fr.backup.recoveryFailed)).toBe(true);
  });
});
