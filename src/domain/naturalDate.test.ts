import { describe, expect, it } from 'vitest';
import { chronoAbsoluteParser } from './chronoAbsolute';
import { foldKeepLength, naturalDate, removeHits, type NaturalNow } from './naturalDate';
import { parseQuickInput } from './quickInput';
import { asLocalDate, asLocalTime } from './types';

// Mardi 22 septembre 2026, 08:00 (docs/stories/Q-02.md).
const NOW: NaturalNow = { date: asLocalDate('2026-09-22'), time: asLocalTime('08:00') };
type First = 'monday' | 'saturday' | 'sunday';
const parse = (text: string, now: NaturalNow = NOW, firstWeekday?: First) =>
  parseQuickInput(text, { spaces: [], projects: [], defaultSpaceId: null, now, absoluteDates: chronoAbsoluteParser, ...(firstWeekday ? { firstWeekday } : {}) });

// [phrase, titre, date, heure] : au moins 40 phrases françaises (Q-02 critère 11).
const PHRASES: ReadonlyArray<readonly [string, string, string | null, string | null]> = [
  ['Appeler le notaire demain 10h', 'Appeler le notaire', '2026-09-23', '10:00'],
  ['Payer la cantine vendredi', 'Payer la cantine', '2026-09-25', null],
  ['Dentiste lun. 10h', 'Dentiste', '2026-09-28', '10:00'],
  ['Dentiste lundi à 14h30', 'Dentiste', '2026-09-28', '14:30'],
  ['Rappeler Paul dans 3 jours', 'Rappeler Paul', '2026-09-25', null],
  ['Envoyer le devis après-demain', 'Envoyer le devis', '2026-09-24', null],
  ['Envoyer le devis apres demain', 'Envoyer le devis', '2026-09-24', null],
  ['Réunion la semaine prochaine', 'Réunion', '2026-09-28', null],
  ['Bilan le 5 octobre', 'Bilan', '2026-10-05', null],
  ['Bilan le 12/10', 'Bilan', '2026-10-12', null],
  ['Point équipe dans 2 semaines', 'Point équipe', '2026-10-06', null],
  ['Yoga à 18h', 'Yoga', '2026-09-22', '18:00'],
  ['Yoga à 7h', 'Yoga', '2026-09-23', '07:00'],
  ['Réunion 14:00', 'Réunion', '2026-09-22', '14:00'],
  ['Réunion 14 h 30', 'Réunion', '2026-09-22', '14:30'],
  ['Réunion 14 h', 'Réunion', '2026-09-22', '14:00'],
  ['Réunion 9h15 demain', 'Réunion', '2026-09-23', '09:15'],
  ['Tennis 3pm', 'Tennis', '2026-09-22', '15:00'],
  ['Tennis demain 3:30 pm', 'Tennis', '2026-09-23', '15:30'],
  ['Tennis demain 9am', 'Tennis', '2026-09-23', '09:00'],
  ['Déjeuner demain à midi', 'Déjeuner', '2026-09-23', '12:00'],
  ['Déjeuner midi', 'Déjeuner', '2026-09-22', '12:00'],
  ['Déjeuner midi et demi', 'Déjeuner', '2026-09-22', '12:30'],
  ['Feu d’artifice minuit', 'Feu d’artifice', '2026-09-23', '00:00'],
  ['Courses demain matin', 'Courses', '2026-09-23', '09:00'],
  ['Dîner ce soir', 'Dîner', '2026-09-22', '19:00'],
  ['Sieste cet après-midi', 'Sieste', '2026-09-22', '14:00'],
  ['Footing ce matin', 'Footing', '2026-09-22', '09:00'],
  ['Cinéma vendredi soir', 'Cinéma', '2026-09-25', '19:00'],
  ['Cinéma demain soir 8h', 'Cinéma', '2026-09-23', '20:00'],
  ['Médecin jeudi 8h du matin', 'Médecin', '2026-09-24', '08:00'],
  ['Dîner demain 8h du soir', 'Dîner', '2026-09-23', '20:00'],
  ['Pharmacie aujourd’hui', 'Pharmacie', '2026-09-22', null],
  ["Pharmacie aujourd'hui 6h", 'Pharmacie', '2026-09-22', '06:00'],
  ['Mardi 15h dentiste', 'dentiste', '2026-09-29', '15:00'],
  ['Mardi 7h dentiste', 'dentiste', '2026-09-29', '07:00'],
  ['Appel samedi 26 sept.', 'Appel', '2026-09-26', null],
  ['Fête le 1er octobre', 'Fête', '2026-10-01', null],
  ['Stage du 5 au 7 octobre', 'Stage', '2026-10-05', null],
  ['Réunion du lundi au mercredi', 'Réunion', '2026-09-28', null],
  ['Réunion lundi prochain', 'Réunion', '2026-09-28', null],
  ['Rendez-vous le 15 octobre 2026 à 9h', 'Rendez-vous', '2026-10-15', '09:00'],
  ['Anniversaire le 25 décembre', 'Anniversaire', '2026-12-25', null],
  ['Dans trois jours : bilan', 'bilan', '2026-09-25', null],
  ['Ranger le garage dimanche', 'Ranger le garage', '2026-09-27', null],
  ['Pour demain : rapport', 'rapport', '2026-09-23', null],
  ['Dentiste vers 16h', 'Dentiste', '2026-09-22', '16:00'],
  ['Courses samedi 10h30', 'Courses', '2026-09-26', '10:30'],
  ['Courses 3 septembre', 'Courses', '2027-09-03', null],
];

describe('naturalDate : phrases françaises (Q-02 critère 11)', () => {
  it('compte au moins 40 phrases', () => {
    expect(PHRASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(PHRASES)('« %s »', (text, title, date, time) => {
    const result = parse(text);
    expect(result.title).toBe(title);
    expect(result.date).toBe(date);
    expect(result.time).toBe(time);
  });
});

// Phrases où rien ne doit être détecté : le texte reste intact.
describe('naturalDate : pas de date (critère 7)', () => {
  it.each([
    'Réserver mars',
    'Appeler May',
    'Marcher',
    'Prendre mai en photo',
    'Dîner mardi gras',
    'Acheter 5 euros de pain',
    'Voir 2 amis',
    'Version 3.4 du plan',
    'Appeler Sam 10 fois',
    'Payer chaque lundi',
    'Courses tous les samedis',
    'Dans 2 heures',
    'Appeler le 0612345678',
    'Revoir le midi',
    'Plage en juillet',
    'Acheter un mer',
    'Lire page 12/40',
  ])('« %s »', (text) => {
    const result = parse(text);
    expect(result.date).toBeNull();
    expect(result.time).toBeNull();
    expect(result.title).toBe(text);
  });

  it('texte vide ou espaces', () => {
    expect(parse('').title).toBe('');
    expect(parse('   ').date).toBeNull();
  });
});

describe('naturalDate : règles de date', () => {
  it('un titre qui deviendrait vide garde le texte entier, sans date (critère 8)', () => {
    for (const text of ['demain 10h', 'demain', 'vendredi', '18h', 'le 5 octobre']) {
      const result = parse(text);
      expect(result.title).toBe(text);
      expect(result.date).toBeNull();
      expect(result.time).toBeNull();
    }
  });

  it('un jour de semaine seul est la prochaine occurrence STRICTEMENT après aujourd’hui (comme T-14)', () => {
    expect(parse('Payer mardi').date).toBe('2026-09-29');
    const afternoon: NaturalNow = { date: asLocalDate('2026-09-22'), time: asLocalTime('16:00') };
    expect(parse('Dentiste mardi 10h', afternoon).date).toBe('2026-09-29');
    expect(parse('Dentiste mardi 17h', afternoon).date).toBe('2026-09-29');
    expect(parse('Dentiste mercredi', afternoon).date).toBe('2026-09-23');
  });

  it('une heure égale à l’heure actuelle passe à demain', () => {
    expect(parse('Yoga 8h').date).toBe('2026-09-23');
  });

  it('« aujourd’hui » explicite avec une heure passée reste aujourd’hui (D4)', () => {
    const afternoon: NaturalNow = { date: asLocalDate('2026-09-22'), time: asLocalTime('16:00') };
    expect(parse('Facture aujourd’hui 9h', afternoon).date).toBe('2026-09-22');
    expect(parse('Facture 9h', afternoon).date).toBe('2026-09-23');
  });

  it('« la semaine prochaine » suit le premier jour de la semaine (P-03)', () => {
    expect(parse('Bilan la semaine prochaine').date).toBe('2026-09-28');
    expect(parse('Bilan la semaine prochaine', NOW, 'sunday').date).toBe('2026-09-27');
    expect(parse('Bilan la semaine prochaine', NOW, 'saturday').date).toBe('2026-09-26');
  });

  it('« lundi prochain » est le lundi de la semaine suivante', () => {
    expect(parse('Réunion lundi prochain').date).toBe('2026-09-28');
    expect(parse('Réunion vendredi prochain').date).toBe('2026-10-02');
    expect(parse('Réunion prochain vendredi').date).toBe('2026-10-02');
    expect(parse('Réunion lundi prochain', NOW, 'sunday').date).toBe('2026-09-28');
  });

  it('plage : seule la première date est retenue, la plage est mémorisée', () => {
    const result = parse('Séminaire du lundi au mercredi');
    expect(result.date).toBe('2026-09-28');
    expect(result.dateRange).toEqual({ start: '2026-09-28', end: '2026-09-30' });
    expect(parse('Stage du 5 au 7 octobre').dateRange).toEqual({ start: '2026-10-05', end: '2026-10-07' });
  });

  it('année : une date passée de l’année passe à l’année suivante', () => {
    expect(parse('Impôts le 15/09').date).toBe('2027-09-15');
    expect(parse('Impôts le 15/09/2026').date).toBe('2026-09-15');
  });

  it('fin d’année et années bissextiles', () => {
    const december: NaturalNow = { date: asLocalDate('2026-12-30'), time: asLocalTime('08:00') };
    expect(parse('Voeux demain', december).date).toBe('2026-12-31');
    expect(parse('Voeux après-demain', december).date).toBe('2027-01-01');
    expect(parse('Voeux dans 3 jours', december).date).toBe('2027-01-02');
    const leap: NaturalNow = { date: asLocalDate('2028-02-28'), time: asLocalTime('08:00') };
    expect(parse('Anniv après-demain', leap).date).toBe('2028-03-01');
  });

  it('accents et casse', () => {
    expect(parse('RAPPEL DEMAIN 10H').date).toBe('2026-09-23');
    expect(parse('Reunion Apres-Demain A 10h').date).toBe('2026-09-24');
    expect(parse('Bilan LE 5 OCTOBRE').date).toBe('2026-10-05');
    expect(parse('Bilan le 5 décembre').date).toBe('2026-12-05');
  });

  it('abréviations avec point seulement', () => {
    expect(parse('Dentiste ven. 10h').date).toBe('2026-09-25');
    expect(parse('Appeler Sam 10h').title).toBe('Appeler Sam');
    expect(parse('Appeler Sam 10h').date).toBe('2026-09-22');
  });

  it('heures invalides ignorées', () => {
    expect(parse('Match 25h').time).toBeNull();
    expect(parse('Match 10h75').time).toBeNull();
  });

  it('le jour dépend de « maintenant » (fuseau de l’appareil, T-11)', () => {
    const tokyo: NaturalNow = { date: asLocalDate('2026-09-23'), time: asLocalTime('01:00') };
    expect(parse('Appel demain 10h', tokyo).date).toBe('2026-09-24');
  });

  it('dateWritten distingue une date écrite d’une date déduite d’une heure seule', () => {
    expect(parse('Yoga 18h').dateWritten).toBe(false);
    expect(parse('Yoga demain 18h').dateWritten).toBe(true);
    expect(parse('Yoga').dateWritten).toBe(false);
  });

  it('analyse en moins de 20 ms', () => {
    parse('chauffe demain 10h');
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) parse('Relancer le client pour le devis du projet demain à 9h30 #pro @mission');
    expect((performance.now() - start) / 20).toBeLessThan(20);
  });
});

describe('naturalDate : utilitaires', () => {
  it('foldKeepLength garde la longueur', () => {
    const text = 'Réunion à l’école — çà et là 🎉';
    expect(foldKeepLength(text)).toHaveLength(text.length);
    expect(foldKeepLength('Éé')).toBe('ee');
  });

  it('naturalDate rend les zones reconnues', () => {
    const text = 'Appeler demain 10h';
    const result = naturalDate(text, NOW, { absoluteDates: chronoAbsoluteParser });
    expect(result?.spans.map((span) => [span.kind, text.slice(span.start, span.end)])).toEqual([
      ['date', 'demain'],
      ['time', '10h'],
    ]);
  });

  it('removeHits retire les petits mots et les espaces', () => {
    expect(removeHits('Appeler le 5 octobre le notaire', [{ start: 11, end: 20 }])).toBe('Appeler le notaire');
    expect(removeHits('Dîner à 19h, chez Paul', [{ start: 8, end: 11 }])).toBe('Dîner, chez Paul');
  });
});
