import { describe, expect, it } from 'vitest';
import { naturalDate, type NaturalNow } from './naturalDate';
import { parseQuickInput, tokenKey, type QuickContext, type QuickProject, type QuickSpace } from './quickInput';
import { asLocalDate, asLocalTime, type ProjectId, type SpaceId } from './types';

const PRO = 'space-pro' as unknown as SpaceId;
const PERSO = 'space-perso' as unknown as SpaceId;
const SPACES: QuickSpace[] = [
  { id: PRO, name: 'Pro', sortOrder: 0 },
  { id: PERSO, name: 'Perso', sortOrder: 1 },
];
const proj = (id: string, spaceId: SpaceId, name: string): QuickProject => ({ id: id as unknown as ProjectId, spaceId, name, archived: false, sortOrder: 0, deletedAt: null });
const PROJECTS = [proj('p-mission', PRO, 'Mission'), proj('p-maison', PERSO, 'Maison')];
// Mardi 22 septembre 2026, 08:00.
const NOW: NaturalNow = { date: asLocalDate('2026-09-22'), time: asLocalTime('08:00') };
const MONDAY: NaturalNow = { date: asLocalDate('2026-09-28'), time: asLocalTime('08:00') };
const ctx = (extra: Partial<QuickContext> = {}): QuickContext => ({ spaces: SPACES, projects: PROJECTS, defaultSpaceId: PRO, now: NOW, ...extra });
const p = (text: string, extra: Partial<QuickContext> = {}, ignored: string[] = []) => parseQuickInput(text, ctx(extra), { ignored: new Set(ignored) });

describe('Q-02 cas limites de date', () => {
  it('Q-02 « lundi » : prochain lundi, strictement après aujourd’hui (comme T-14)', () => {
    expect(p('Sport lundi').date).toBe('2026-09-28');
    expect(p('Sport lundi', { now: MONDAY }).date).toBe('2026-10-05');
  });
  it('Q-02 « lundi » un lundi avec heure : toujours le lundi suivant', () => {
    expect(p('Sport lundi 7h', { now: MONDAY }).date).toBe('2026-10-05');
    expect(p('Sport lundi 9h', { now: MONDAY }).date).toBe('2026-10-05');
  });
  it('Q-02 « lun. 14 h » et « 9h30 »', () => {
    const a = p('Dentiste lun. 14 h');
    expect([a.title, a.date, a.time]).toEqual(['Dentiste', '2026-09-28', '14:00']);
    const b = p('Café 9h30');
    expect([b.title, b.date, b.time]).toEqual(['Café', '2026-09-22', '09:30']);
  });
  it('Q-02 « midi », « 15/10 », « 15 octobre », « dans 3 jours », « dans 2 semaines », « après-demain »', () => {
    expect(p('Déjeuner midi').time).toBe('12:00');
    expect(p('Payer 15/10').date).toBe('2026-10-15');
    expect(p('Payer le 15 octobre').date).toBe('2026-10-15');
    expect(p('Payer 15 octobre').date).toBe('2026-10-15');
    expect(p('Appeler dans 3 jours').date).toBe('2026-09-25');
    expect(p('Appeler dans 2 semaines').date).toBe('2026-10-06');
    expect(p('Appeler après-demain').date).toBe('2026-09-24');
  });
  it('Q-02 « Appeler le notaire demain 10h » avec #pro : titre, date, heure, espace', () => {
    const r = p('Appeler le notaire demain 10h #pro');
    expect([r.title, r.date, r.time, r.spaceId]).toEqual(['Appeler le notaire', '2026-09-23', '10:00', PRO]);
  });
  it('Q-02 « 31 février » est refusé (aucune date inventée)', () => {
    for (const text of ['Payer le 31 février', 'Payer 31/02', 'Payer le 30 février']) {
      const r = p(text);
      expect(r.date, text).toBeNull();
      expect(r.title).toBe(text);
    }
  });
  it('Q-02 titre sans date : rien n’est posé', () => {
    const r = p('Appeler le notaire');
    expect([r.title, r.date, r.time, r.tokens.length]).toEqual(['Appeler le notaire', null, null, 0]);
  });
  it('Q-02 premier jour de semaine (P-03) : « la semaine prochaine »', () => {
    const d = (first: 'monday' | 'saturday' | 'sunday') => p('Bilan la semaine prochaine', { firstWeekday: first }).date;
    expect(d('monday')).toBe('2026-09-28');
    expect(d('sunday')).toBe('2026-09-27');
    expect(d('saturday')).toBe('2026-09-26');
  });
});

describe('Q-02 faux positifs : le texte peut rester tel quel', () => {
  it('Q-02 « Lire Le Monde » et « Mars » (planète) : aucune date', () => {
    for (const text of ['Lire Le Monde', 'Mars', 'Observer Mars au télescope', 'Lire Le Monde du soir']) {
      const r = p(text);
      expect(r.date, text).toBeNull();
      expect(r.title).toBe(text);
    }
  });
  it('Q-02 « Préparer la réunion de lundi » : détecté mais annulable, le texte revient entier', () => {
    const text = 'Préparer la réunion de lundi';
    const r = p(text);
    expect(r.date).toBe('2026-09-28');
    const date = r.tokens.find((t) => t.kind === 'date');
    if (!date) throw new Error('date attendue');
    const off = p(text, {}, [date.key]);
    expect(off.date).toBeNull();
    expect(off.time).toBeNull();
    expect(off.title).toBe(text);
  });
  it('Q-02 annuler la détection garde les marques # @', () => {
    const r = p('Appeler Paul demain #perso');
    const dateToken = r.tokens.find((t) => t.kind === 'date');
    if (!dateToken) throw new Error('date attendue');
    const off = p('Appeler Paul demain #perso', {}, [dateToken.key]);
    expect([off.title, off.spaceId, off.date]).toEqual(['Appeler Paul demain', PERSO, null]);
  });
  it('Q-02 « Mars » seul ne devient pas date (naturalDate)', () => {
    expect(naturalDate('Mars', NOW, { firstWeekday: 'monday' })?.date ?? null).toBeNull();
  });
});

describe('Q-06 cas limites', () => {
  it('Q-06 #pro / #perso insensibles à la casse et aux accents', () => {
    for (const text of ['Tâche #PRO', 'Tâche #Pro', 'Tâche #pRo']) expect(p(text).spaceId, text).toBe(PRO);
    const accent: QuickSpace[] = [{ id: PRO, name: 'Pro', sortOrder: 0 }, { id: PERSO, name: 'Privé', sortOrder: 1 }];
    expect(p('Tâche #prive', { spaces: accent }).spaceId).toBe(PERSO);
    expect(p('Tâche #PRIVÉ', { spaces: accent }).spaceId).toBe(PERSO);
    expect(p('Tâche #PRIVÉ', { spaces: accent }).title).toBe('Tâche');
  });
  it('Q-06 @projet insensible aux accents et à la casse', () => {
    const projects = [proj('p-eco', PERSO, 'Écologie')];
    const r = p('Trier @ECOLOGIE', { projects });
    expect([r.projectId, r.spaceId, r.title]).toEqual(['p-eco', PERSO, 'Trier']);
  });
  it('Q-06 @projet d’un autre espace : non reconnu, mot gardé, signalement', () => {
    const r = p('Réparer #perso @mission');
    expect(r.projectId).toBeNull();
    expect(r.title).toBe('Réparer @mission');
    expect(r.unknownProject?.spaceId).toBe(PERSO);
  });
  it('Q-06 @projet inconnu sans # : mot gardé, pas de signalement', () => {
    const r = p('Réparer @zzz');
    expect([r.projectId, r.spaceId, r.title, r.unknownProject]).toEqual([null, null, 'Réparer @zzz', null]);
  });
  it('Q-06 plusieurs # contradictoires : le dernier gagne', () => {
    expect(p('Tâche #pro #perso').spaceId).toBe(PERSO);
    expect(p('Tâche #perso #pro').spaceId).toBe(PRO);
    expect(p('Tâche #perso #pro').title).toBe('Tâche');
  });
  it('Q-06 plusieurs # contradictoires avec un @projet du premier espace', () => {
    const r = p('Tâche #pro @mission #perso');
    expect(r.spaceId).toBe(PERSO);
    expect(r.projectId).toBeNull();
  });
  it('Q-06 marque retirée : elle redevient du texte', () => {
    const r = p('Tâche #pro', {}, [tokenKey('space', '#pro')]);
    expect([r.spaceId, r.title]).toEqual([null, 'Tâche #pro']);
  });
});
