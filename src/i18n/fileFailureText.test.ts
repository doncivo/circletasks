import { describe, expect, it } from 'vitest';
import { fileFailureEn, fileFailureFr } from './fileFailureText';

describe('textes des échecs d’enregistrement sans nouvel essai', () => {
  it('mêmes clés en anglais', () => {
    expect(Object.keys(fileFailureEn).sort()).toEqual(Object.keys(fileFailureFr).sort());
  });
});
