import { describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../../db/seed/defaultSpaces';
import type { QuickContext, QuickProject, QuickSpace } from '../../../domain/quickInput';
import { asLocalDate, asLocalTime, type ProjectId } from '../../../domain/types';
import { defaultDay, detectLine, draftsFromProposals } from './scanDrafts';
import type { ScanProposal } from './scanLines';

// Mercredi 23 septembre 2026, 10:00 (dates figées des maquettes : « sam. 26 sept. » dans Scan.html).
const TODAY = asLocalDate('2026-09-23');
const SPACES: QuickSpace[] = [
  { id: SPACE_PRO_ID, name: 'Pro', sortOrder: 1 },
  { id: SPACE_PERSO_ID, name: 'Perso', sortOrder: 2 },
];
const MISSION = 'p-mission' as ProjectId;
const PROJECTS: QuickProject[] = [{ id: MISSION, spaceId: SPACE_PRO_ID, name: 'Mission', archived: false, sortOrder: 1 }];
const CONTEXT: QuickContext = { spaces: SPACES, projects: PROJECTS, defaultSpaceId: SPACE_PERSO_ID, now: { date: TODAY, time: asLocalTime('10:00') }, dates: true };

const proposal = (text: string, checked = true): ScanProposal => ({ id: `line-${text}`, text, checked, uncertain: false });
const drafts = (texts: string[], date: Parameters<typeof draftsFromProposals>[2]['date'] = { kind: 'today' }, spaceId = SPACE_PERSO_ID) =>
  draftsFromProposals(texts.map((text) => proposal(text)), CONTEXT, { spaceId, date, today: TODAY });

describe('date et marques lues dans une ligne (Q-04 critère 6)', () => {
  it('« resto samedi » : samedi 26 septembre détecté, titre sans la date', () => {
    const parse = detectLine('resto samedi', CONTEXT);
    expect(parse).toMatchObject({ title: 'resto', date: '2026-09-26', dateWritten: true });
  });

  it('« #pro » et « @mission » (Q-06) sont reconnus', () => {
    const parse = detectLine('Écrire le devis #pro @mission', CONTEXT);
    expect(parse).toMatchObject({ title: 'Écrire le devis', spaceId: SPACE_PRO_ID, projectId: MISSION });
  });

  it('une heure dictée en lettres est lue comme dans la saisie (Q-03)', () => {
    expect(detectLine('dentiste demain dix heures', CONTEXT)).toMatchObject({ title: 'dentiste', date: '2026-09-24', time: '10:00' });
  });
});

describe('tâches créées pour les lignes cochées (critères 8 et 9)', () => {
  it('seules les lignes cochées sont créées, dans l’ordre', () => {
    const result = draftsFromProposals([proposal('Appeler le plombier'), proposal('Garage ?', false), proposal('Payer la cantine')], CONTEXT, {
      spaceId: SPACE_PERSO_ID,
      date: { kind: 'today' },
      today: TODAY,
    });
    expect(result.map((d) => d.title)).toEqual(['Appeler le plombier', 'Payer la cantine']);
  });

  it('une ligne sans date reçoit « Date des tâches sans date » : Aujourd’hui par défaut', () => {
    expect(drafts(['Payer la cantine'])[0]).toMatchObject({ date: '2026-09-23', time: null, someday: false, spaceId: SPACE_PERSO_ID, projectId: null });
  });

  it('Demain, une date choisie, Un jour', () => {
    expect(drafts(['Payer la cantine'], { kind: 'tomorrow' })[0]?.date).toBe('2026-09-24');
    expect(drafts(['Payer la cantine'], { kind: 'date', date: asLocalDate('2026-10-12') })[0]?.date).toBe('2026-10-12');
    expect(drafts(['Payer la cantine'], { kind: 'someday' })[0]).toMatchObject({ date: null, someday: true, time: null });
  });

  it('une date écrite l’emporte sur la date par défaut', () => {
    expect(drafts(['resto samedi'], { kind: 'tomorrow' })[0]).toMatchObject({ title: 'resto', date: '2026-09-26' });
    expect(drafts(['resto samedi'], { kind: 'someday' })[0]).toMatchObject({ title: 'resto', date: '2026-09-26', someday: false });
  });

  it('une heure seule se pose sur le jour par défaut ; « Un jour » n’a pas d’heure', () => {
    expect(drafts(['dentiste 14h'], { kind: 'tomorrow' })[0]).toMatchObject({ date: '2026-09-24', time: '14:00' });
    expect(drafts(['dentiste 14h'], { kind: 'someday' })[0]).toMatchObject({ date: null, time: null, someday: true });
  });

  it('l’espace écrit l’emporte sur l’espace choisi, le projet suit son espace', () => {
    const [first, second] = drafts(['Facturer #pro', 'Écrire le devis @mission', 'Courses']);
    expect(first).toMatchObject({ title: 'Facturer', spaceId: SPACE_PRO_ID });
    expect(second).toMatchObject({ title: 'Écrire le devis', spaceId: SPACE_PRO_ID, projectId: MISSION });
    expect(drafts(['Courses'], { kind: 'today' }, SPACE_PRO_ID)[0]?.spaceId).toBe(SPACE_PRO_ID);
  });

  it('une ligne qui ne laisserait aucun titre est ignorée', () => {
    expect(drafts(['#pro', 'Appeler'])).toHaveLength(1);
  });

  it('aucune ligne cochée : aucune tâche', () => {
    expect(draftsFromProposals([proposal('A faire', false)], CONTEXT, { spaceId: SPACE_PRO_ID, date: { kind: 'today' }, today: TODAY })).toEqual([]);
  });
});

describe('defaultDay', () => {
  it('traduit chaque choix en jour', () => {
    expect(defaultDay({ kind: 'today' }, TODAY)).toBe('2026-09-23');
    expect(defaultDay({ kind: 'tomorrow' }, TODAY)).toBe('2026-09-24');
    expect(defaultDay({ kind: 'someday' }, TODAY)).toBeNull();
    expect(defaultDay({ kind: 'date', date: asLocalDate('2027-01-01') }, TODAY)).toBe('2027-01-01');
  });
});
