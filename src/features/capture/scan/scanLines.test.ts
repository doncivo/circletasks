import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isUncertain, MAX_SCAN_LINES, MIN_CONFIDENCE, scanLinesToProposals, stripListMarker } from './scanLines';

const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const texts = (input: readonly { text: string }[]) => scanLinesToProposals(input).proposals.map((p) => p.text);

describe('marques de liste retirées (Q-04 critère 5)', () => {
  it.each([
    ['- Appeler le plombier', 'Appeler le plombier'],
    ['– Acheter des ampoules', 'Acheter des ampoules'],
    ['— Payer la cantine', 'Payer la cantine'],
    ['• Réserver le restaurant', 'Réserver le restaurant'],
    ['· Ranger le garage', 'Ranger le garage'],
    ['* Envoyer la facture', 'Envoyer la facture'],
    ['● Rappeler Paul', 'Rappeler Paul'],
    ['▪ Dentiste', 'Dentiste'],
    ['1. Envoyer le devis', 'Envoyer le devis'],
    ['12) Relire le contrat', 'Relire le contrat'],
    ['(3) Passer à la banque', 'Passer à la banque'],
    ['a) Acheter du lait', 'Acheter du lait'],
    ['[ ] Payer le loyer', 'Payer le loyer'],
    ['[x] Appeler Marie', 'Appeler Marie'],
    ['[X] Poster le courrier', 'Poster le courrier'],
    ['[] Arroser les plantes', 'Arroser les plantes'],
    ['( ) Sortir les poubelles', 'Sortir les poubelles'],
    ['☐ Faire les courses', 'Faire les courses'],
    ['☑ Réunion équipe', 'Réunion équipe'],
    ['✓ Prendre rendez-vous', 'Prendre rendez-vous'],
    ['- [ ] 2. Imprimer les billets', 'Imprimer les billets'],
    ['   -   Espaces   multiples  ', 'Espaces multiples'],
  ])('« %s » devient « %s »', (raw, expected) => {
    expect(stripListMarker(raw)).toBe(expected);
  });

  it('ne retire rien d’un texte qui ressemble seulement à une marque', () => {
    for (const same of ['10h réunion', '2 pommes', 'A. Dupont', 'Appeler - Paul', 'Plan B', '12/10 dentiste', 'TVA 20 %']) {
      expect(stripListMarker(same)).toBe(same);
    }
  });

  it('un numéro seul ne laisse rien', () => {
    expect(stripListMarker('3.')).toBe('');
    expect(stripListMarker('12)')).toBe('');
    expect(stripListMarker('-')).toBe('');
  });
});

describe('une ligne reconnue = une ligne proposée (critères 4 et 5)', () => {
  it('l’ordre et le nombre de lignes sont conservés', () => {
    const result = scanLinesToProposals(lines('- plombier', '- ampoules', '- resto samedi', '- cantine', '- garage ?'));
    expect(result.proposals.map((p) => p.text)).toEqual(['plombier', 'ampoules', 'resto samedi', 'cantine', 'garage ?']);
    expect(result.proposals.map((p) => p.id)).toEqual(['line-1', 'line-2', 'line-3', 'line-4', 'line-5']);
    expect(result.detected).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it('les lignes vides, d’espaces, d’un seul caractère ou réduites à une marque sont ignorées', () => {
    expect(texts(lines('', '   ', '-', '•', 'a', '1.', '–  ', '.', 'Ok', 'Acheter du pain'))).toEqual(['Ok', 'Acheter du pain']);
  });

  it('100 lignes au plus, le reste est annoncé', () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ text: `Tâche numéro ${i + 1}` }));
    const result = scanLinesToProposals(many);
    expect(result.proposals).toHaveLength(MAX_SCAN_LINES);
    expect(result.detected).toBe(130);
    expect(result.truncated).toBe(true);
    expect(result.proposals.at(-1)?.text).toBe('Tâche numéro 100');
  });

  it('exactement 100 lignes ne sont pas tronquées', () => {
    const result = scanLinesToProposals(Array.from({ length: 100 }, (_, i) => ({ text: `Tâche ${i + 1}` })));
    expect(result.truncated).toBe(false);
    expect(result.proposals).toHaveLength(100);
  });

  it('aucune ligne lisible : liste vide', () => {
    expect(scanLinesToProposals([]).proposals).toEqual([]);
    expect(scanLinesToProposals(lines('', ' ', '-')).proposals).toEqual([]);
  });

  it('les lignes sûres sont cochées, les douteuses décochées', () => {
    const { proposals } = scanLinesToProposals(lines('Appeler le plombier', 'garage ?', 'a_b|c', 'ok'));
    expect(proposals.map((p) => [p.text, p.checked, p.uncertain])).toEqual([
      ['Appeler le plombier', true, false],
      ['garage ?', false, true],
      ['a_b|c', false, true],
      ['ok', false, true],
    ]);
  });
});

describe('lecture douteuse (critère 7)', () => {
  it.each([
    ['ab', undefined, true],
    ['--', undefined, true],
    ['12', undefined, true],
    ['Garage ?', undefined, true],
    ['Acheter du pain?', undefined, true],
    ['Payer | la cantine', undefined, true],
    ['Appeler ~ le plombier', undefined, true],
    ['Payer la cantine_', undefined, true],
    ['\\\\ Appeler', undefined, true],
    ['a .,;:!- b c', undefined, true],
    ['Appeler le plombier', undefined, false],
    ['Rendez-vous à 10h30', undefined, false],
    ['Acheter 2 pommes (bio)', undefined, false],
    ['Écrire à l’école', undefined, false],
    ['Payer 20 € à Paul', undefined, false],
    ['Réunion #pro @mission', undefined, false],
    ['Appeler le plombier', MIN_CONFIDENCE - 1, true],
    ['Appeler le plombier', MIN_CONFIDENCE, false],
    ['Appeler le plombier', 95, false],
    ['Appeler le plombier', 0, true],
  ])('« %s » (confiance %s) douteuse : %s', (text, confidence, expected) => {
    expect(isUncertain(text, confidence)).toBe(expected);
  });

  it('la confiance de tesseract.js décoche la ligne', () => {
    const { proposals } = scanLinesToProposals([
      { text: 'Appeler le plombier', confidence: 91 },
      { text: 'Acheter des ampoules', confidence: 42 },
    ]);
    expect(proposals.map((p) => p.checked)).toEqual([true, false]);
    expect(proposals[1]?.uncertain).toBe(true);
  });
});

describe('jeu d’images de test : lignes attendues -> tâches proposées (Q-04 D7)', () => {
  const expected = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/ocr/expected.json', import.meta.url), 'utf8')) as Record<
    string,
    { lines: string[]; readable: boolean }
  >;

  it('la liste imprimée donne cinq tâches cochées, mots pour mots', () => {
    const printed = expected['liste-imprimee.png']?.lines ?? [];
    const result = scanLinesToProposals(printed.map((text) => ({ text })));
    expect(result.proposals.map((p) => p.text)).toEqual(printed);
    expect(result.proposals.every((p) => p.checked)).toBe(true);
  });

  it('la liste à puces, tirets, numéros et cases perd ses marques', () => {
    const bullets = expected['liste-puces.png']?.lines ?? [];
    expect(texts(bullets.map((text) => ({ text })))).toEqual(['Appeler le notaire demain 10h', 'Acheter du pain', 'Envoyer la facture', 'Réserver le dentiste', 'Payer le loyer']);
  });

  it('la page vide ne donne aucune ligne', () => {
    expect(scanLinesToProposals((expected['page-vide.png']?.lines ?? []).map((text) => ({ text }))).proposals).toEqual([]);
  });

  it('la liste manuscrite (« garage ? ») garde une ligne douteuse décochée', () => {
    const handwritten = expected['liste-manuscrite.png']?.lines ?? [];
    const { proposals } = scanLinesToProposals(handwritten.map((text) => ({ text })));
    expect(proposals.map((p) => p.text)).toEqual(handwritten);
    expect(proposals.at(-1)).toMatchObject({ text: 'garage ?', checked: false, uncertain: true });
    expect(proposals.slice(0, 4).every((p) => p.checked)).toBe(true);
  });
});

describe('Q-04 cas limites de lignes (QA)', () => {
  it('une ligne très longue reste une seule ligne, sans coupure ni perte', () => {
    const long = `Organiser ${'la grande fête de famille '.repeat(60)}`.trim();
    const out = texts(lines(`- ${long}`));
    expect(out).toEqual([long]);
  });

  it('les accents et majuscules accentuées sont conservés', () => {
    expect(texts(lines('1. Écrire à Hélène', '☐ Réserver l’hôtel à Cluny', '- Ça va être déjà fait'))).toEqual(['Écrire à Hélène', 'Réserver l’hôtel à Cluny', 'Ça va être déjà fait']);
  });

  it('une ligne contenant plusieurs phrases reste une seule tâche', () => {
    expect(texts(lines('Appeler Paul. Puis Marie, puis Luc'))).toEqual(['Appeler Paul. Puis Marie, puis Luc']);
  });

  it('une page de lignes toutes vides ou réduites à des marques ne propose rien', () => {
    expect(texts(lines('', ' ', '-', '☐', '1.', '•'))).toEqual([]);
  });
});
