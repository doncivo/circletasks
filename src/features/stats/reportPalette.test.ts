import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ReportColor } from '../../domain/reportLayout';
import { REPORT_PALETTE, REPORT_PALETTE_TOKENS } from './reportPalette';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['ui/theme/tokens.css', 'features/routines/routineTokens.css', 'features/stats/statsTokens.css'].map((file) => readFileSync(join(SRC, file), 'utf8'));

/** Première déclaration (thème clair, `:root`) d'un jeton. */
function lightValue(token: string): string | undefined {
  for (const css of FILES) {
    const match = new RegExp(`^\\s*${token}:\\s*(#[0-9a-fA-F]{3,8})`, 'm').exec(css);
    if (match) return match[1]?.toLowerCase();
  }
  return undefined;
}

describe('Palette du rapport exporté (H-03 critères 5 et 6)', () => {
  it('chaque couleur est la valeur claire de son jeton du thème', () => {
    for (const color of Object.keys(REPORT_PALETTE) as ReportColor[]) {
      expect(REPORT_PALETTE[color], `${color} (${REPORT_PALETTE_TOKENS[color]})`).toBe(lightValue(REPORT_PALETTE_TOKENS[color]));
    }
  });
});
