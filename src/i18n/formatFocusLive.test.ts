import { afterEach, describe, expect, it } from 'vitest';
import { formatFocusTodayLive } from './formatFocus';
import { setLocale } from './index';

/** UI-FIX-06 : pied de l'écran Focus avec la session active (secondes, puis minutes entamées). */
describe('formatFocusTodayLive', () => {
  afterEach(() => setLocale('fr'));

  it('rien de terminé, rien d’actif : « Aujourd’hui : 0 min de concentration »', () => {
    expect(formatFocusTodayLive({ minutes: 0, sessions: 0 }, 0)).toBe('Aujourd’hui : 0 min de concentration');
  });

  it('rien de terminé, 42 s actives : les secondes', () => {
    expect(formatFocusTodayLive({ minutes: 0, sessions: 0 }, 42)).toBe('Aujourd’hui : 42 s de concentration');
  });

  it('rien de terminé, 90 s actives : la minute entamée, « session en cours »', () => {
    expect(formatFocusTodayLive({ minutes: 0, sessions: 0 }, 90)).toBe('Aujourd’hui : 1 min de concentration · session en cours');
  });

  it('25 min et 1 session terminées, 125 s actives : 27 min · 1 session · en cours', () => {
    expect(formatFocusTodayLive({ minutes: 25, sessions: 1 }, 125)).toBe('Aujourd’hui : 27 min de concentration · 1 session · en cours');
  });

  it('sans session active, le texte historique est inchangé', () => {
    expect(formatFocusTodayLive({ minutes: 75, sessions: 3 }, null)).toBe('Aujourd’hui : 1 h 15 de concentration · 3 sessions');
  });

  it('anglais', () => {
    setLocale('en');
    expect(formatFocusTodayLive({ minutes: 0, sessions: 0 }, 42)).toBe('Today: 42 s of focus');
    expect(formatFocusTodayLive({ minutes: 0, sessions: 0 }, 90)).toBe('Today: 1 min of focus · session in progress');
  });
});
