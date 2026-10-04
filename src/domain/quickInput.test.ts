import { describe, expect, it } from 'vitest';
import { applySuggestion, parseQuickInput, quickSuggestions, tokenKey, type QuickContext, type QuickProject, type QuickSpace } from './quickInput';
import { asLocalDate, asLocalTime, type ProjectId, type SpaceId } from './types';

const asSpaceId = (value: string): SpaceId => value as unknown as SpaceId;
const asProjectId = (value: string): ProjectId => value as unknown as ProjectId;

const PRO = asSpaceId('space-pro');
const PERSO = asSpaceId('space-perso');
const SPACES: QuickSpace[] = [
  { id: PRO, name: 'Pro', sortOrder: 0, color: '#1F6698' as never },
  { id: PERSO, name: 'Perso', sortOrder: 1, color: '#E8A33D' as never },
];
const project = (id: string, spaceId: typeof PRO, name: string, extra: Partial<QuickProject> = {}): QuickProject => ({
  id: asProjectId(id),
  spaceId,
  name,
  archived: false,
  sortOrder: 0,
  deletedAt: null,
  ...extra,
});
const PROJECTS: QuickProject[] = [
  project('p-mission', PRO, 'Mission'),
  project('p-maison', PERSO, 'Maison'),
  project('p-vieux', PRO, 'Ancien', { archived: true }),
  project('p-site', PRO, 'Site web'),
  project('p-eco', PERSO, 'Écologie'),
];
const NOW = { date: asLocalDate('2026-09-22'), time: asLocalTime('08:00') };
const ctx = (extra: Partial<QuickContext> = {}): QuickContext => ({ spaces: SPACES, projects: PROJECTS, defaultSpaceId: PRO, now: NOW, ...extra });

describe('parseQuickInput : marques # et @ (Q-06)', () => {
  it('critère 1 : « Relancer client #pro @mission »', () => {
    const r = parseQuickInput('Relancer client #pro @mission', ctx());
    expect(r.title).toBe('Relancer client');
    expect(r.spaceId).toBe(PRO);
    expect(r.projectId).toBe('p-mission');
    expect(r.tokens.map((t) => t.kind)).toEqual(['space', 'project']);
  });

  it('exemple du PRD : « Relancer client demain 9h #pro @mission »', () => {
    const r = parseQuickInput('Relancer client demain 9h #pro @mission', ctx());
    expect(r.title).toBe('Relancer client');
    expect(r.date).toBe('2026-09-23');
    expect(r.time).toBe('09:00');
    expect(r.spaceId).toBe(PRO);
    expect(r.projectId).toBe('p-mission');
    expect(r.tokens.map((t) => t.kind)).toEqual(['space', 'project', 'date']);
  });

  it('marque en début, au milieu, accents et casse', () => {
    expect(parseQuickInput('#perso acheter du pain', ctx()).title).toBe('acheter du pain');
    expect(parseQuickInput('Planter #PERSO des arbres', ctx()).spaceId).toBe(PERSO);
    expect(parseQuickInput('Trier @ecologie', ctx()).projectId).toBe('p-eco');
    expect(parseQuickInput('Trier @ÉCOLOGIE', ctx()).projectId).toBe('p-eco');
  });

  it('nom de projet de plusieurs mots', () => {
    const r = parseQuickInput('Refonte @site web demain', ctx());
    expect(r.projectId).toBe('p-site');
    expect(r.title).toBe('Refonte');
    expect(r.date).toBe('2026-09-23');
    expect(parseQuickInput('Refonte @site-web', ctx()).projectId).toBe('p-site');
  });

  it('ponctuation après la marque', () => {
    const r = parseQuickInput('Appeler @mission, puis écrire', ctx());
    expect(r.projectId).toBe('p-mission');
    expect(r.title).toBe('Appeler, puis écrire');
  });

  it('critère 4 : « @mission » sans « # » donne l’espace du projet', () => {
    const r = parseQuickInput('Préparer @maison', ctx());
    expect(r.spaceId).toBe(PERSO);
    expect(r.spaceWritten).toBe(false);
    expect(r.projectId).toBe('p-maison');
  });

  it('critère 4 : plusieurs projets du même nom, l’espace par défaut départage', () => {
    const doubles = [...PROJECTS, project('p-mission-perso', PERSO, 'Mission')];
    expect(parseQuickInput('Ecrire @mission', ctx({ projects: doubles, defaultSpaceId: PERSO })).projectId).toBe('p-mission-perso');
    expect(parseQuickInput('Ecrire @mission', ctx({ projects: doubles, defaultSpaceId: PRO })).projectId).toBe('p-mission');
    // Sans espace par défaut : le premier par ordre d’espace.
    expect(parseQuickInput('Ecrire @mission', ctx({ projects: doubles, defaultSpaceId: null })).projectId).toBe('p-mission');
    // « # » écrit : il départage.
    expect(parseQuickInput('Ecrire @mission #perso', ctx({ projects: doubles })).projectId).toBe('p-mission-perso');
  });

  it('critère 5 : projet d’un autre espace, le mot reste et le signalement apparaît', () => {
    const r = parseQuickInput('Relancer #perso @mission', ctx());
    expect(r.spaceId).toBe(PERSO);
    expect(r.projectId).toBeNull();
    expect(r.title).toBe('Relancer @mission');
    expect(r.unknownProject).toEqual({ name: 'mission', spaceId: PERSO });
  });

  it('critère 6 : « #xyz » reste dans le titre, sans erreur', () => {
    const r = parseQuickInput('Appeler #xyz demain', ctx());
    expect(r.title).toBe('Appeler #xyz');
    expect(r.spaceId).toBeNull();
    expect(r.unknownProject).toBeNull();
  });

  it('« @inconnu » sans « # » reste dans le titre, sans signalement', () => {
    const r = parseQuickInput('Appeler @inconnu', ctx());
    expect(r.title).toBe('Appeler @inconnu');
    expect(r.projectId).toBeNull();
    expect(r.unknownProject).toBeNull();
  });

  it('un projet archivé ou supprimé n’est jamais reconnu', () => {
    expect(parseQuickInput('Voir @ancien', ctx()).projectId).toBeNull();
    const supprime = [project('p-x', PRO, 'Supprimé', { deletedAt: '2026-09-01T00:00:00.000Z' as never })];
    expect(parseQuickInput('Voir @supprime', ctx({ projects: supprime })).projectId).toBeNull();
  });

  it('critère 7 : « a#b » et « mail@site.fr » restent du texte', () => {
    expect(parseQuickInput('colonne a#pro', ctx()).spaceId).toBeNull();
    expect(parseQuickInput('colonne a#pro', ctx()).title).toBe('colonne a#pro');
    const mail = parseQuickInput('Écrire à marie@mission.fr', ctx());
    expect(mail.projectId).toBeNull();
    expect(mail.title).toBe('Écrire à marie@mission.fr');
  });

  it('critère 7 : plusieurs « # », le dernier gagne, tous sont retirés', () => {
    const r = parseQuickInput('#pro Appeler #perso', ctx());
    expect(r.spaceId).toBe(PERSO);
    expect(r.title).toBe('Appeler');
  });

  it('critère 7 : titre qui deviendrait vide, refusé', () => {
    expect(parseQuickInput('#pro', ctx()).title).toBe('');
    expect(parseQuickInput('#pro @mission', ctx()).title).toBe('');
    expect(parseQuickInput('#pro demain', ctx()).title).toBe('demain');
    expect(parseQuickInput('#pro demain', ctx()).date).toBeNull();
  });

  it('noms réels renommés (D2)', () => {
    const renamed: QuickSpace[] = [
      { id: PRO, name: 'Boulot', sortOrder: 0 },
      { id: PERSO, name: 'Maison', sortOrder: 1 },
    ];
    expect(parseQuickInput('Faire #boulot', ctx({ spaces: renamed })).spaceId).toBe(PRO);
    expect(parseQuickInput('Faire #pro', ctx({ spaces: renamed })).spaceId).toBeNull();
  });

  it('retirer une marque la rend au texte (D4)', () => {
    const ignored = new Set([tokenKey('space', '#pro')]);
    const r = parseQuickInput('Relancer #pro', ctx(), { ignored });
    expect(r.title).toBe('Relancer #pro');
    expect(r.spaceId).toBeNull();
  });

  it('retirer la date la rend au texte', () => {
    const ignored = new Set([tokenKey('date', 'demain 10h')]);
    const r = parseQuickInput('Appeler demain 10h', ctx(), { ignored });
    expect(r.title).toBe('Appeler demain 10h');
    expect(r.date).toBeNull();
  });

  it('dates désactivées : seules les marques sont lues', () => {
    const r = parseQuickInput('Appeler demain 10h #perso', ctx({ dates: false }));
    expect(r.title).toBe('Appeler demain 10h');
    expect(r.date).toBeNull();
    expect(r.spaceId).toBe(PERSO);
  });

  it('sans « maintenant », aucune date n’est cherchée', () => {
    const { now: _now, ...sansHorloge } = ctx();
    expect(parseQuickInput('Appeler demain', sansHorloge).date).toBeNull();
  });

  it('analyse en moins de 5 ms (critère 10)', () => {
    const start = performance.now();
    for (let i = 0; i < 50; i += 1) parseQuickInput('Relancer client #pro @mission', ctx({ dates: false }));
    expect((performance.now() - start) / 50).toBeLessThan(5);
  });
});

describe('quickSuggestions (Q-06 critères 2 et 3)', () => {
  it('« # » propose les espaces par leur nom réel, « #pe » filtre', () => {
    const all = quickSuggestions('Appeler #', 9, ctx());
    expect(all?.kind).toBe('space');
    expect(all?.items.map((i) => i.label)).toEqual(['Pro', 'Perso']);
    const some = quickSuggestions('Appeler #pe', 11, ctx());
    expect(some?.items.map((i) => i.label)).toEqual(['Perso']);
    expect(quickSuggestions('Appeler #zz', 11, ctx())).toBeNull();
  });

  it('« @ » propose les projets actifs de tous les espaces, avec l’espace', () => {
    const r = quickSuggestions('Appeler @', 9, ctx());
    expect(r?.kind).toBe('project');
    expect(r?.items.map((i) => [i.label, i.spaceName])).toEqual([
      ['Mission', 'Pro'],
      ['Site web', 'Pro'],
      ['Maison', 'Perso'],
      ['Écologie', 'Perso'],
    ]);
    expect(r?.items.some((i) => i.label === 'Ancien')).toBe(false);
  });

  it('« @ » après « # » : seulement les projets de cet espace', () => {
    const r = quickSuggestions('#perso Appeler @', 16, ctx());
    expect(r?.items.map((i) => i.label)).toEqual(['Maison', 'Écologie']);
    expect(r?.items.every((i) => i.spaceName === null)).toBe(true);
  });

  it('filtre sans accents ni casse, projets de plusieurs mots', () => {
    expect(quickSuggestions('@eco', 4, ctx())?.items.map((i) => i.label)).toEqual(['Écologie']);
    expect(quickSuggestions('@site w', 7, ctx())?.items.map((i) => i.label)).toEqual(['Site web']);
  });

  it('pas de suggestion hors d’une marque', () => {
    expect(quickSuggestions('Appeler Paul', 12, ctx())).toBeNull();
    expect(quickSuggestions('a#pro', 5, ctx())).toBeNull();
    expect(quickSuggestions('mail@mis', 8, ctx())).toBeNull();
    expect(quickSuggestions('#pro ', 5, ctx())).toBeNull();
  });

  it('suit le curseur au milieu du texte', () => {
    const r = quickSuggestions('Appeler #pe demain', 11, ctx());
    expect(r?.items.map((i) => i.label)).toEqual(['Perso']);
  });

  it('applySuggestion complète le mot et place le curseur après', () => {
    const s = quickSuggestions('Appeler #pe', 11, ctx());
    if (!s || !s.items[0]) throw new Error('suggestion attendue');
    expect(applySuggestion('Appeler #pe', s, s.items[0])).toEqual({ text: 'Appeler #Perso ', caret: 15 });
    const mid = quickSuggestions('Appeler #pe demain', 11, ctx());
    if (!mid || !mid.items[0]) throw new Error('suggestion attendue');
    expect(applySuggestion('Appeler #pe demain', mid, mid.items[0])).toEqual({ text: 'Appeler #Perso demain', caret: 15 });
  });

  it('le texte complété est reconnu par parseQuickInput', () => {
    const s = quickSuggestions('Appeler @si', 11, ctx());
    if (!s || !s.items[0]) throw new Error('suggestion attendue');
    const done = applySuggestion('Appeler @si', s, s.items[0]);
    expect(parseQuickInput(done.text, ctx()).projectId).toBe('p-site');
  });
});
