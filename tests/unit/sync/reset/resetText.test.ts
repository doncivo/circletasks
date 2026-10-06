import { describe, expect, it } from 'vitest';
import { SYNC_ERROR_CODES } from '../../../../src/domain/sync/format';
import { resetFailureText, resetReason } from '../../../../src/features/sync/resetText';

/**
 * Y-11 critère 17 (aucun échec silencieux) : chaque code d'erreur de la synchro donne à l'écran une raison lisible, jamais le code brut,
 * jamais un texte vide ; les échecs de lancement et des étapes se distinguent.
 */

describe('raison lisible de chaque code d’échec (critère 17)', () => {
  for (const code of SYNC_ERROR_CODES) {
    it(`${code} : texte français non vide, sans le code brut`, () => {
      const reason = resetReason(code);
      expect(reason.trim().length).toBeGreaterThan(5);
      expect(reason).not.toContain(code);
      expect(reason).not.toMatch(/^sync\./);
      for (const step of ['start', 'announced', 'snapshot', 'switching', 'superseded'] as const) {
        const text = resetFailureText({ code, step });
        expect(text).not.toMatch(/sync\.reset|undefined|\{.*\}/);
        expect(text).toContain(reason);
      }
    });
  }
});
