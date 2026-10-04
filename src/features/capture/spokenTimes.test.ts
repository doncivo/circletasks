import { describe, expect, it } from 'vitest';
import { parseQuickInput } from '../../domain/quickInput';
import { asLocalDate, asLocalTime } from '../../domain/types';
import { normalizeQuickText, normalizeSpokenTimes } from './spokenTimes';

// Mardi 22 septembre 2026, 08:00 (comme Q-02).
const NOW = { date: asLocalDate('2026-09-22'), time: asLocalTime('08:00') };
const parse = (text: string) => parseQuickInput(normalizeQuickText(text), { spaces: [], projects: [], defaultSpaceId: null, now: NOW });

// [dictée Windows, texte normalisé] : Q-03 critère 4, au moins 10 phrases dictées.
const NORMALIZED: ReadonlyArray<readonly [string, string]> = [
  ['appeler le notaire demain dix heures', 'appeler le notaire demain 10 h'],
  ['Appeler le notaire demain Dix heures', 'Appeler le notaire demain 10 h'],
  ['réunion neuf heures trente', 'réunion 9 h 30'],
  ['dentiste jeudi huit heures et demie', 'dentiste jeudi 8 h 30'],
  ['déjeuner avec Paul midi', 'déjeuner avec Paul midi'],
  ['pharmacie à quatorze heures quinze', 'pharmacie à 14 h 15'],
  ['yoga ce soir à dix-huit heures', 'yoga ce soir à 18 h'],
  ['cinéma vendredi vingt heures trente', 'cinéma vendredi 20 h 30'],
  ['rendez-vous une heure et quart', 'rendez-vous 1 h 15'],
  ['train onze heures moins le quart', 'train 10 h 45'],
  ['appel dix heures moins vingt', 'appel 9 h 40'],
  ['sport vingt et une heures', 'sport 21 h'],
  ['sport vingt-deux heures cinquante', 'sport 22 h 50'],
  ['bilan sept heures 15', 'bilan 7 h 15'],
  ['café six heures du matin', 'café 6 h du matin'],
];

describe('heures dictées en lettres (Q-03)', () => {
  it.each(NORMALIZED)('« %s » devient « %s »', (spoken, expected) => {
    expect(normalizeSpokenTimes(spoken)).toBe(expected);
  });

  it('une durée n’est pas une heure', () => {
    for (const duration of ['rester pendant deux heures', 'revenir dans une heure', 'finir en trois heures', 'conduire environ quatre heures', 'prévoir plus de deux heures', 'toutes les six heures']) {
      expect(normalizeSpokenTimes(duration)).toBe(duration);
    }
  });

  it('les textes tapés en chiffres et les nombres hors heures traversent sans changement', () => {
    for (const same of ['Appeler le notaire demain 10h', 'Acheter dix pommes', 'Revoir le chapitre douze', 'Réunion 14 h 30', 'dix heuresx', 'Payer 15 heures supplémentaires']) {
      expect(normalizeSpokenTimes(same)).toBe(same);
    }
  });

  it('le reste de la phrase garde sa casse, ses accents et ses marques', () => {
    expect(normalizeSpokenTimes('Appeler Élodie #pro @Mission demain dix heures')).toBe('Appeler Élodie #pro @Mission demain 10 h');
  });

  it('plusieurs heures dans la même phrase sont toutes lues', () => {
    expect(normalizeSpokenTimes('de neuf heures à dix heures trente')).toBe('de 9 h à 10 h 30');
  });
});

describe('dictée -> titre, date, heure', () => {
  it.each([
    ['appeler le notaire demain dix heures', 'appeler le notaire', '2026-09-23', '10:00'],
    ['Appeler le plombier demain neuf heures', 'Appeler le plombier', '2026-09-23', '09:00'],
    ['réunion équipe jeudi neuf heures trente', 'réunion équipe', '2026-09-24', '09:30'],
    ['dentiste vendredi quatorze heures', 'dentiste', '2026-09-25', '14:00'],
    ['yoga ce soir à dix-huit heures', 'yoga', '2026-09-22', '18:00'],
    ['déjeuner demain midi', 'déjeuner', '2026-09-23', '12:00'],
    ['cinéma samedi vingt heures trente', 'cinéma', '2026-09-26', '20:30'],
    ['Dîner demain huit heures du soir', 'Dîner', '2026-09-23', '20:00'],
    ['train lundi sept heures et demie', 'train', '2026-09-28', '07:30'],
    ['rappeler Paul à quinze heures', 'rappeler Paul', '2026-09-22', '15:00'],
    ['envoyer le devis demain', 'envoyer le devis', '2026-09-23', null],
    ['acheter dix pommes', 'acheter dix pommes', null, null],
  ])('« %s »', (spoken, title, date, time) => {
    const result = parse(spoken);
    expect(result.title).toBe(title);
    expect(result.date).toBe(date);
    expect(result.time).toBe(time);
  });

  it('« demain dix heures » écrit en chiffres donne le même résultat que la dictée', () => {
    expect(parse('appeler le notaire demain 10 h')).toMatchObject({ title: 'appeler le notaire', date: '2026-09-23', time: '10:00' });
  });
});
