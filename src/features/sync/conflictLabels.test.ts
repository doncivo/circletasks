import { describe, expect, it } from 'vitest';
import { fieldLabel } from './conflictText';

describe('UI-FIX-02 : champ modifié nommé en langage utilisateur', () => {
  it.each([['date', 'date prévue'], ['time', 'heure prévue'], ['status', 'état de la tâche']])('%s possède un libellé explicite', (name, label) => {
    expect(fieldLabel({ name: 'task' }, { name })).toBe(label);
  });
});
