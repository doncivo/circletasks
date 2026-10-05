import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupSearchResults, toSearchResult, type SearchHit, type SearchResult } from '../../domain/search';
import { asHexColor, asLocalDate, asSpaceId } from '../../domain/types';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import { SearchGroups, type SearchGroupsProps } from './SearchResults';

const SPACE_ID = asSpaceId('11111111-1111-4111-8111-111111111111');
const SPACES = [{ id: SPACE_ID, name: 'Pro', color: asHexColor('#2e2150') }];

const EVENT: SearchHit = {
  kind: 'event',
  id: 'e1',
  title: 'Réunion facture',
  note: '',
  date: asLocalDate('2026-09-23'),
  time: '15:30' as SearchHit['time'],
  status: null,
  spaceId: SPACE_ID,
  projectId: null,
  someday: false,
  icon: null,
  items: [],
  itemsChecked: 0,
  repeat: null,
};

const resultOf = (hit: SearchHit): SearchResult => toSearchResult(hit, ['facture']);

function props(result: SearchResult, over: Partial<SearchGroupsProps> = {}): SearchGroupsProps {
  return { groups: groupSearchResults([result]), spaces: SPACES, selectedKey: null, onSelect: vi.fn(), onOpen: vi.fn(), onMove: vi.fn(() => null), ...over };
}

describe('SearchGroups : lignes mémoïsées qui restent à jour (RC-02)', () => {
  afterEach(() => setFormatPrefs({ timeFormat: '24h' }));

  it('un espace renommé met à jour la sous-ligne et le nom accessible', () => {
    const result = resultOf(EVENT);
    const { rerender } = render(<SearchGroups {...props(result)} />);
    expect(screen.getByRole('button', { name: /, Pro/ })).toBeTruthy();
    rerender(<SearchGroups {...props(result, { spaces: [{ id: SPACE_ID, color: asHexColor('#2e2150'), name: 'Travail' }] })} />);
    expect(screen.getByRole('button', { name: /, Travail/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /, Pro/ })).toBeNull();
  });

  it('un résultat dont le titre ou la date change est redessiné', () => {
    const { rerender } = render(<SearchGroups {...props(resultOf(EVENT))} />);
    expect(screen.getByRole('button', { name: /Réunion facture/ })).toBeTruthy();
    rerender(<SearchGroups {...props(resultOf({ ...EVENT, title: 'Rendez-vous facture', date: asLocalDate('2026-09-24') }))} />);
    const row = screen.getByRole('button', { name: /Rendez-vous facture/ });
    expect(row.getAttribute('aria-label')).toContain('24');
    expect(screen.queryByRole('button', { name: /Réunion facture/ })).toBeNull();
  });

  it('le format d’heure 12 h met à jour la sous-ligne et le nom accessible', () => {
    render(<SearchGroups {...props(resultOf(EVENT))} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('15:30');
    act(() => setFormatPrefs({ timeFormat: '12h' }));
    const label = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(label).not.toContain('15:30');
    expect(label).toMatch(/3:30/);
    expect(screen.getByRole('button').textContent).not.toContain('15:30');
  });

  it('un nouveau onOpen est appelé par Ctrl+Entrée, pas l’ancien', () => {
    const result = resultOf(EVENT);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<SearchGroups {...props(result, { onOpen: first })} />);
    rerender(<SearchGroups {...props(result, { onOpen: second })} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter', ctrlKey: true });
    expect(second).toHaveBeenCalledWith(result, true);
    expect(first).not.toHaveBeenCalled();
  });
});
