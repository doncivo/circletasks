import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOCUS_TOKEN_PAIRS,
  GRAPHIC_TOKEN_PAIRS,
  SRC_DIR,
  THEMES,
  TOKEN_PAIRS,
  analyzeRules,
  cascadeColor,
  colorOfDecl,
  colorTokens,
  compose,
  contrastOf,
  declOf,
  loadRules,
  resolveColor,
  systemDarkMismatches,
  tokenScopeIssues,
  themeTokens,
  toHex,
  type Color,
  type Theme,
} from '../../../tests/unit/theme/cssContrastKit';

/**
 * UI-FIX-01 : contraste calculé sur les règles CSS réelles de `src/**\/*.css` (analyse statique, jsdom ne charge aucun CSS), dans les deux thèmes.
 * Trois mécanismes : (a) paires de même règle (texte + fond) à 4,5:1 ; (b) relations de composants désignées par sélecteur à 3:1 ;
 * (c) inventaire : tout jeton de couleur est dans une paire, une relation, la liste fermée des jetons décoratifs ou celle des reports.
 *
 * Ce que ce test prouve : le texte d'une règle contre SON PROPRE fond (160 règles par thème), quelques relations désignées à la main, et que
 * chaque jeton de couleur a été classé. Ce qu'il ne prouve pas : voir « ANGLES MORTS » dans `tests/unit/theme/cssContrastKit.ts` (texte hérité,
 * fond d'un parent, couleurs du TSX, opacité des ancêtres), renvoyés au balayage en navigateur réel après la 1.0.
 */
const rules = loadRules();
const fmt = (n: number): string => n.toFixed(2).replace('.', ',');
const names: Record<Theme, string> = { light: 'clair', dark: 'sombre' };

/* --------------------------------------------------------- listes fermées */

/** Règles à fond et texte exclues du seuil de 4,5:1 (état désactivé ou opacité <= 0,5 : WCAG 1.4.3 les exempte). Aucune aujourd'hui. */
const EXCLUES: readonly string[] = [];

/** Règles que le lecteur ne peut pas résoudre, comparées exactement (une règle nouvelle non résolue fait échouer), avec la raison. */
const NON_RESOLUES: readonly { rule: string; raison: string }[] = [
  {
    rule: "features/week/WeekScreen.css :: .ct-week-event[data-layout='pc']",
    raison: 'texte `color: inherit` : hérité du corps (--ct-color-text), vérifié par la relation « texte hérité » ci-dessous',
  },
];

/** Exemptions du seuil de 3:1 des relations de composants (clé : relation + thème), avec la raison. Rien d'autre n'est exempté. */
const EXEMPTIONS: readonly { relation: string; theme: Theme; raison: string }[] = [
  {
    relation: 'interrupteur éteint : piste sur la surface',
    theme: 'light',
    raison: 'maquette Reglages.html (.sw, #DDD9E4 sur blanc = 1,39:1) conservée, décision d’Ali du 2026-10-18 ; l’état se lit aussi à la position du pouce',
  },
  {
    relation: 'interrupteur éteint : pouce sur la piste',
    theme: 'light',
    raison: 'même maquette : pouce blanc sur #DDD9E4 (1,39:1) ; l’état se lit aussi à la position du pouce',
  },
  {
    relation: 'interrupteur désactivé-éteint : contour du pouce creux sur la piste',
    theme: 'light',
    raison:
      'contour du texte (2,61:1) à l’opacité 0,5 de la décision 9 sur la piste composée ; WCAG 1.4.11 exempte les composants inactifs ; avant revue : contour blanc, 1,17:1 ; à confirmer par Ali (question 4 de la fiche)',
  },
  {
    relation: 'interrupteur désactivé-éteint : contour du pouce creux sur la piste',
    theme: 'dark',
    raison: 'contour du texte (2,72:1) à l’opacité 0,5 sur la piste composée ; mêmes raisons ; à confirmer par Ali (question 4 de la fiche)',
  },
];

/** Jetons de couleur qui ne servent à aucune paire texte / fond ni relation : bordures, ombres, pastels d’onglets, remplissages, accents. */
const DECORATIFS: Readonly<Record<string, string>> = {
  '--ct-color-border': 'filet de séparation des lignes et cartes ; l’information est portée par le texte et l’espacement',
  '--ct-color-select-ring': 'anneau de sélection d’une pastille, redondant avec la coche',
  '--ct-color-warning-border': 'bordure de l’encadré « lecture incertaine » ; le texte de l’encadré est dans la paire warning-text / warning-bg',
  '--ct-color-space-pro': 'couleur de base de la pastille Pro, mélangée au blanc en sombre ; contraste testé par contrast.test.ts (pastilles d’espace)',
  '--ct-color-space-perso': 'couleur de base de la pastille Perso ; même test dans contrast.test.ts (pastilles d’espace)',
  '--ct-focus-track': 'rail de l’arc de progression de l’écran Focus ; le temps restant est en texte (paires --ct-focus-*)',
  '--ct-focus-arc-paused': 'arc de progression en pause ; le texte « En pause » porte l’état',
  '--ct-focus-border': 'bordure des boutons de l’écran Focus ; leur libellé porte l’information',
  '--ct-ios-pair-line': 'filet de l’écran d’appairage iPhone',
  '--ct-routine-off-border': 'contour des jours sans routine ; la lettre du jour porte l’information',
  '--ct-routine-ring': 'anneau des jours manqués ; la lettre colorée --ct-routine-ring-text porte l’information',
  '--ct-routine-today-ring': 'anneau « aujourd’hui » de la carte de chaleur ; le jour est aussi écrit en chiffres',
  '--ct-stats-bar': 'barre du graphique de complétion ; les valeurs sont écrites dans le rapport',
  '--ct-stats-bar-current': 'barre de la semaine courante ; même raison',
  '--ct-stats-bar-empty': 'barre vide du graphique ; même raison',
  '--ct-swipe-shadow': 'ombre portée des actions de geste',
};

/**
 * Jetons de couleur dont le contraste n'est PAS vérifié et qui ne sont pas décoratifs : reportés au balayage des écrans en navigateur réel
 * après la 1.0 (décision d'Ali du 2026-10-18, question 2 de la fiche UI-FIX-01). Un report n'est pas une exemption : le défaut est connu.
 */
const REPORTES: Readonly<Record<string, string>> = {
  '--ct-color-icon-amber': 'icône Lucide qui accompagne un libellé ; contraste en sombre non mesuré (jeton identique dans les deux thèmes)',
  '--ct-color-icon-blue': 'icône Lucide qui accompagne un libellé ; contraste en sombre non mesuré (jeton identique dans les deux thèmes)',
  '--ct-color-icon-green': 'icône Lucide qui accompagne un libellé ; contraste en sombre non mesuré (jeton identique dans les deux thèmes)',
  '--ct-color-icon-purple': 'icône Lucide ; 2,00:1 en sombre sur --ct-color-surface-input (les deux règles de texte concernées sont corrigées, les icônes restent)',
  '--ct-color-icon-red': 'icône Lucide qui accompagne un libellé ; contraste en sombre non mesuré (jeton identique dans les deux thèmes)',
  '--ct-color-icon-skyblue': 'icône Lucide qui accompagne un libellé ; contraste en sombre non mesuré (jeton identique dans les deux thèmes)',
  '--ct-color-border-strong': 'contour des boutons secondaires et des champs (WCAG 1.4.11 pour les champs) : non mesuré, à traiter avec le balayage',
};

/* ------------------------------------------------------------ relations */

type Located = { color: Color; tokens: string[] };

interface Relation {
  label: string;
  /** Couleur au premier plan et couleur de fond, résolues dans le thème à partir du CSS réel. */
  of: (theme: Theme) => { fg: Located; bg: Located };
  min: number;
}

const TRACK = '.ct-switch__track';
const THUMB = '.ct-switch__thumb';
const CHECKED_TRACK = `.ct-switch[data-checked='true'] ${TRACK}`;
const CHECKED_THUMB = `.ct-switch[data-checked='true'] ${THUMB}`;

function resolveToken(theme: Theme, token: string): Located {
  const resolved = resolveColor(`var(${token})`, themeTokens(rules, theme));
  if (!resolved.ok) throw new Error(`${token} : ${resolved.why}`);
  return { color: resolved.color, tokens: resolved.tokens };
}

/** La surface sur laquelle posent les lignes de réglages. */
const surface = (theme: Theme): Located => resolveToken(theme, '--ct-color-bg');

/** Textes et graphiques posés sur un fond que porte une autre règle (liste explicite de jetons) : même seuil que les relations par sélecteur. */
const TOKEN_RELATIONS: readonly (readonly [fg: string, bg: string, min: number])[] = [
  ['--ct-routine-off-text', '--ct-color-bg', 4.5],
  ['--ct-routine-heat-text', '--ct-routine-heat-missed', 4.5],
  ['--ct-ios-pair-text', '--ct-ios-pair-bg', 4.5],
  ['--ct-ios-pair-muted', '--ct-ios-pair-bg', 4.5],
  ['--ct-ios-pair-muted', '--ct-ios-pair-panel', 4.5],
  ['--ct-ios-pair-accent', '--ct-ios-pair-bg', 4.5],
  ['--ct-ios-pair-done', '--ct-ios-pair-bg', 4.5],
  ['--ct-color-tab-active-bg', '--ct-color-pill-all', 4.5],
  ['--ct-color-tab-text', '--ct-color-tab-tasks', 4.5],
  ['--ct-color-tab-text', '--ct-color-tab-week', 4.5],
  ['--ct-color-tab-text', '--ct-color-tab-routines', 4.5],
  ['--ct-color-tab-text', '--ct-color-tab-events', 4.5],
  ['--ct-color-tab-text', '--ct-color-tab-checklists', 4.5],
  ['--ct-color-tab-text', '--ct-color-tab-settings', 4.5],
  ['--ct-edit-idle-knob', '--ct-edit-track', 3],
  ['--ct-color-handle', '--ct-color-bg', 3],
  ['--ct-color-someday', '--ct-color-someday-bg', 4.5],
];

/** Couleur d'un élément du bouton désactivé : l'opacité du bouton (`.ct-switch:disabled`) est composée sur la surface. */
function dimmed(located: Located, theme: Theme): Located {
  const opacity = Number.parseFloat(declOf(rules, '.ct-switch:disabled', 'opacity', theme));
  return { color: compose(located.color, opacity, surface(theme).color), tokens: located.tokens };
}

const RELATIONS: readonly Relation[] = [
  {
    label: 'interrupteur désactivé-éteint : contour du pouce creux sur la piste',
    of: (t) => ({
      fg: dimmed(colorOfDecl(rules, '.ct-switch:disabled .ct-switch__thumb', 'border', t), t),
      bg: dimmed(cascadeColor(rules, [TRACK], 'background', t), t),
    }),
    min: 3,
  },
  {
    label: 'interrupteur désactivé-activé : contour du pouce creux sur la piste',
    of: (t) => ({
      fg: dimmed(colorOfDecl(rules, `.ct-switch[data-checked='true']:disabled ${THUMB}`, 'border-color', t), t),
      bg: dimmed(cascadeColor(rules, [TRACK, CHECKED_TRACK], 'background', t), t),
    }),
    min: 3,
  },
  ...TOKEN_RELATIONS.map(
    ([a, b, min]): Relation => ({ label: `${a} sur ${b}`, of: (t) => ({ fg: resolveToken(t, a), bg: resolveToken(t, b) }), min }),
  ),
  {
    label: 'interrupteur activé : piste sur la surface',
    of: (t) => ({ fg: cascadeColor(rules, [TRACK, CHECKED_TRACK], 'background', t), bg: surface(t) }),
    min: 3,
  },
  {
    label: 'interrupteur activé : pouce sur la piste',
    of: (t) => ({ fg: cascadeColor(rules, [THUMB, CHECKED_THUMB], 'background', t), bg: cascadeColor(rules, [TRACK, CHECKED_TRACK], 'background', t) }),
    min: 3,
  },
  {
    label: 'interrupteur éteint : piste sur la surface',
    of: (t) => ({ fg: cascadeColor(rules, [TRACK], 'background', t), bg: surface(t) }),
    min: 3,
  },
  {
    label: 'interrupteur éteint : pouce sur la piste',
    of: (t) => ({ fg: cascadeColor(rules, [THUMB], 'background', t), bg: cascadeColor(rules, [TRACK], 'background', t) }),
    min: 3,
  },
  {
    label: 'interrupteur : anneau de focus sur la surface',
    of: (t) => ({ fg: colorOfDecl(rules, '.ct-switch:focus-visible', 'outline', t), bg: surface(t) }),
    min: 3,
  },
  {
    label: 'bandeau « Annuler » : anneau de focus sur le fond du bandeau',
    of: (t) => ({ fg: colorOfDecl(rules, '.ct-toast__action:focus-visible', 'outline', t), bg: colorOfDecl(rules, '.ct-toast', 'background', t) }),
    min: 3,
  },
  {
    label: 'événement de la semaine : texte hérité sur son fond',
    of: (t) => ({ fg: resolveToken(t, '--ct-color-text'), bg: colorOfDecl(rules, ".ct-week-event[data-layout='pc']", 'background', t) }),
    min: 4.5,
  },
];

function measure(rel: Relation, theme: Theme): { ratio: number; line: string; tokens: string[] } {
  const { fg, bg } = rel.of(theme);
  const ratio = contrastOf(fg.color, bg.color);
  return {
    ratio,
    line: `${rel.label} (${names[theme]}) : ${toHex(fg.color)} sur ${toHex(bg.color)} = ${fmt(ratio)}:1 (minimum ${fmt(rel.min)}:1)`,
    tokens: [...fg.tokens, ...bg.tokens],
  };
}

/* ---------------------------------------------------- (a) paires de règle */

describe.each(THEMES)('paires de même règle, thème %s', (theme) => {
  const analysis = analyzeRules(rules, theme);

  it('garde : le lecteur voit le CSS réel (au moins 100 paires, règles repères présentes)', () => {
    expect(analysis.pairs.length).toBeGreaterThanOrEqual(100);
    const ids = new Set(analysis.pairs.map((p) => p.id));
    for (const id of ['ui/Toast.css :: .ct-toast', 'features/spaces/SpacesScreen.css :: .ct-projects__button--primary', 'features/spaces/SpacesScreen.css :: .ct-projects__error']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('toute règle qui porte son texte et son propre fond atteint 4,5:1 (hors angles morts du noyau)', () => {
    const failures = analysis.pairs.filter((p) => p.ratio < 4.5).map((p) => `${p.id} (${names[theme]}) : ${p.fg} sur ${p.bg} = ${fmt(p.ratio)}:1 (minimum 4,5:1)`);
    expect(failures).toEqual([]);
  });

  it.each([
    ['ui/Toast.css :: .ct-toast', 14],
    ['features/spaces/SpacesScreen.css :: .ct-projects__button--primary', 14],
  ] as const)('%s : blanc sur violet, au moins %i:1 en clair et 17:1 en sombre (audit B11)', (id, lightFloor) => {
    const floor = theme === 'dark' ? 17 : lightFloor;
    const pair = analysis.pairs.find((p) => p.id === id);
    expect(pair, id).toBeDefined();
    expect(pair?.ratio ?? 0, `${id} (${names[theme]}) : ${pair?.fg ?? '?'} sur ${pair?.bg ?? '?'} = ${fmt(pair?.ratio ?? 0)}:1 (minimum ${String(floor)}:1)`).toBeGreaterThanOrEqual(floor);
  });

  it('les règles non résolues sont celles de la liste fermée (avec leur raison)', () => {
    expect(analysis.unresolved.map((u) => u.id)).toEqual(NON_RESOLUES.map((n) => n.rule));
    for (const entry of NON_RESOLUES) expect(entry.raison.length, entry.rule).toBeGreaterThan(10);
  });

  it('les règles exclues (désactivé, opacité <= 0,5) sont celles de la liste fermée', () => {
    expect(analysis.excluded).toEqual([...EXCLUES]);
  });

  it('aucune règle ne pose le texte --ct-color-accent-on sur le fond --ct-color-nav-bg', () => {
    const wrong = analysis.pairs.filter((p) => p.tokens.includes('--ct-color-accent-on') && p.tokens.includes('--ct-color-nav-bg')).map((p) => p.id);
    expect(wrong).toEqual([]);
  });
});

describe('liste des règles non résolues', () => {
  it('compte au plus 25 règles', () => {
    expect(NON_RESOLUES.length).toBeLessThanOrEqual(25);
  });
});

/* ------------------------------------------------- (b) relations de composants */

describe.each(THEMES)('relations de composants, thème %s', (theme) => {
  it.each(RELATIONS.map((r) => [r.label, r] as const))('%s', (_label, rel) => {
    const { ratio, line } = measure(rel, theme);
    const exempt = EXEMPTIONS.some((e) => e.relation === rel.label && e.theme === theme);
    if (exempt) expect(ratio, `${line} : exemption devenue inutile, à retirer`).toBeLessThan(rel.min);
    else expect(ratio, line).toBeGreaterThanOrEqual(rel.min);
  });
});

describe('exemptions', () => {
  it('chacune désigne une relation existante et porte une raison', () => {
    for (const e of EXEMPTIONS) {
      expect(
        RELATIONS.some((r) => r.label === e.relation),
        e.relation,
      ).toBe(true);
      expect(e.raison.length, e.relation).toBeGreaterThan(20);
    }
  });
});

/* -------------------------------------------- rendu clair inchangé (maquettes) */

describe('rendu clair inchangé (critère 4)', () => {
  const light = (selector: string, prop: string): string => toHex(colorOfDecl(rules, selector, prop, 'light').color);

  it('bandeau « Annuler » : blanc sur #2e2150', () => {
    expect(light('.ct-toast', 'background')).toBe('#2e2150');
    expect(light('.ct-toast', 'color')).toBe('#ffffff');
  });

  it('bouton principal des projets : blanc sur #2e2150, bordure #2e2150', () => {
    expect(light('.ct-projects__button--primary', 'background')).toBe('#2e2150');
    expect(light('.ct-projects__button--primary', 'border-color')).toBe('#2e2150');
    expect(light('.ct-projects__button--primary', 'color')).toBe('#ffffff');
  });

  it('interrupteur : activé #2e2150 / #ffffff, éteint #ddd9e4 / #ffffff', () => {
    expect(toHex(cascadeColor(rules, [TRACK, CHECKED_TRACK], 'background', 'light').color)).toBe('#2e2150');
    expect(toHex(cascadeColor(rules, [THUMB, CHECKED_THUMB], 'background', 'light').color)).toBe('#ffffff');
    expect(toHex(cascadeColor(rules, [TRACK], 'background', 'light').color)).toBe('#ddd9e4');
    expect(toHex(cascadeColor(rules, [THUMB], 'background', 'light').color)).toBe('#ffffff');
  });
});

/* ------------------------------------------------ jetons ajoutés par la story */

describe.each(THEMES)('jetons de la story, thème %s', (theme) => {
  const tokens = themeTokens(rules, theme);

  it('--ct-color-on-nav vaut #ffffff dans les deux thèmes', () => {
    expect(tokens['--ct-color-on-nav']).toBe('#ffffff');
  });

  it.each(['--ct-color-switch-on', '--ct-color-switch-on-thumb', '--ct-color-switch-off', '--ct-color-switch-off-thumb'])('%s est défini', (token) => {
    expect(tokens[token], token).toBeDefined();
  });

  it('Toast et bouton principal des projets utilisent --ct-color-on-nav', () => {
    expect(declOf(rules, '.ct-toast', 'color', theme)).toBe('var(--ct-color-on-nav)');
    expect(declOf(rules, '.ct-toast__action:focus-visible', 'outline', theme)).toContain('var(--ct-color-on-nav)');
    expect(declOf(rules, '.ct-projects__button--primary', 'color', theme)).toBe('var(--ct-color-on-nav)');
  });
});

/* ---------------------- désactivé et éteint distinguables entre eux (critère 20) */

describe('interrupteur désactivé et interrupteur éteint distinguables entre eux (critère 20)', () => {
  const switchCss = readFileSync(join(SRC_DIR, 'ui', 'Switch.css'), 'utf8');

  it('curseur : pointer à l’état actif, not-allowed à l’état désactivé', () => {
    expect(declOf(rules, '.ct-switch', 'cursor', 'light')).toBe('pointer');
    expect(declOf(rules, '.ct-switch:disabled', 'cursor', 'light')).toBe('not-allowed');
  });

  it('pouce creux à l’état désactivé : fond transparent, bordure de 2 px (jeton du texte, ou du pouce activé)', () => {
    expect(declOf(rules, '.ct-switch:disabled .ct-switch__thumb', 'background', 'light')).toBe('transparent');
    expect(declOf(rules, '.ct-switch:disabled .ct-switch__thumb', 'border', 'light')).toBe('2px solid var(--ct-color-text)');
    expect(declOf(rules, ".ct-switch[data-checked='true']:disabled .ct-switch__thumb", 'border-color', 'light')).toBe('var(--ct-color-switch-on-thumb)');
  });

  it('Switch.css ne contient ni littéral de couleur ni repli de var()', () => {
    const code = switchCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(code).not.toMatch(/var\(--[\w-]+\s*,/);
  });

  describe.each(THEMES)('thème %s : écart de piste entre état actif et état désactivé', (theme) => {
    it.each([
      ['éteint', [TRACK]],
      ['activé', [TRACK, CHECKED_TRACK]],
    ] as const)('piste %s : écart d’au moins 1,15:1 (opacité composée sur la surface)', (state, selectors) => {
      const track = cascadeColor(rules, selectors, 'background', theme).color;
      const opacity = Number.parseFloat(declOf(rules, '.ct-switch:disabled', 'opacity', theme));
      const dimmed = compose(track, opacity, surface(theme).color);
      const gap = contrastOf(track, dimmed);
      expect(gap, `piste ${state} (${names[theme]}) : ${toHex(track)} contre ${toHex(dimmed)} = ${fmt(gap)}:1 (minimum 1,15:1)`).toBeGreaterThanOrEqual(1.15);
    });
  });
});

/* ------------------------------------------------------------ cohérence */

describe('cohérence des thèmes sur toutes les feuilles', () => {
  it('le bloc prefers-color-scheme et data-theme="dark" portent les mêmes jetons dans chaque fichier', () => {
    expect(systemDarkMismatches(rules)).toEqual([]);
  });

  it('aucun jeton défini dans deux portées avec des valeurs différentes, aucun jeton de :root dans un @media', () => {
    expect(tokenScopeIssues(rules)).toEqual([]);
  });
});

/* ------------------------------------------------------------ (c) inventaire */

describe('inventaire des jetons de couleur', () => {
  const used = new Set<string>();
  for (const theme of THEMES) {
    for (const p of analyzeRules(rules, theme).pairs) p.tokens.forEach((t) => used.add(t));
    for (const rel of RELATIONS) measure(rel, theme).tokens.forEach((t) => used.add(t));
    for (const [a, b] of [...TOKEN_PAIRS, ...GRAPHIC_TOKEN_PAIRS, ...FOCUS_TOKEN_PAIRS]) {
      for (const token of [a, b]) if (token in themeTokens(rules, theme)) resolveToken(theme, token).tokens.forEach((t) => used.add(t));
    }
  }
  const all = colorTokens(rules);

  it('garde : l’inventaire voit les jetons de toutes les feuilles', () => {
    for (const token of ['--ct-color-bg', '--ct-routine-done', '--ct-stats-bar', '--ct-search-hl', '--ct-ios-pair-bg']) expect(all, token).toContain(token);
  });

  it('chaque jeton de couleur est dans une paire, une relation ou la liste DECORATIFS', () => {
    const unclassified = all.filter((t) => !used.has(t) && !(t in DECORATIFS) && !(t in REPORTES));
    expect(unclassified).toEqual([]);
  });

  it('chaque entrée de DECORATIFS et de REPORTES existe encore, a une raison et n’est que dans une des deux listes', () => {
    const stale = [...Object.keys(DECORATIFS), ...Object.keys(REPORTES)].filter((t) => !all.includes(t));
    expect(stale).toEqual([]);
    expect(Object.keys(DECORATIFS).filter((t) => t in REPORTES)).toEqual([]);
    for (const [token, raison] of [...Object.entries(DECORATIFS), ...Object.entries(REPORTES)]) expect(raison.length, token).toBeGreaterThan(10);
  });
});
