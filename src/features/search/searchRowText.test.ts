import { describe, expect, it } from 'vitest';
import { toSearchResult, type SearchHit } from '../../domain/search';
import { asHexColor, asLocalDate, asSpaceId } from '../../domain/types';
import { formatDayLabel } from '../../i18n/format';
import { resultLabel, subtitleParts } from './searchRowText';

const SPACE = { id: asSpaceId('11111111-1111-4111-8111-111111111111'), name: 'Pro', color: asHexColor('#2e2150') };

const HIT: SearchHit = {
  kind: 'task',
  id: 't1',
  title: 'Envoyer la facture',
  note: '',
  date: asLocalDate('2026-09-23'),
  time: null,
  status: 'todo',
  spaceId: SPACE.id,
  projectId: null,
  someday: false,
  icon: null,
  items: [],
  itemsChecked: 0,
  repeat: null,
};

describe('résultat de recherche : texte des lignes', () => {
  const result = toSearchResult(HIT, ['facture']);

  it('le nom accessible précalculé avec la sous-ligne est identique à celui calculé seul', () => {
    const parts = subtitleParts(result, [SPACE]);
    expect(resultLabel(result, [SPACE], parts)).toBe(resultLabel(result, [SPACE]));
    expect(resultLabel(result, [SPACE])).toBe(`Tâche, Envoyer la facture, ${formatDayLabel('2026-09-23')}, Pro, à faire`);
  });

  it('le libellé de jour reste identique d’un appel à l’autre (formateur réutilisé)', () => {
    expect(formatDayLabel('2026-09-23')).toBe(formatDayLabel('2026-09-23'));
    expect(formatDayLabel('2026-09-24')).not.toBe(formatDayLabel('2026-09-23'));
  });
});
