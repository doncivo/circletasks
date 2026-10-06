import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Seconde revue de Y-04, point 2 : un tampon (`stamper.next()`) est pris **juste avant** l'écriture qui l'utilise, sans aucune attente
 * entre les deux. Sinon la coupure d'une publication (dernier hlc réservé, puis dernier numéro de la file, `publisher.ts`) peut tomber
 * entre le tampon et l'écriture : l'écriture a un hlc inférieur à la coupure mais une entrée de file plus récente que la lecture, et elle
 * est ensuite retirée comme déjà publiée (coche de routine perdue). Contrôle statique de tous les repositories SQL : après chaque
 * `stamper.next()`, la première expression `await` est l'écriture (`await db.execute(`) : aucune lecture ni autre attente entre les deux
 * (les paramètres de l'écriture peuvent être préparés entre les deux, sans attendre).
 */

const DIR = join(__dirname, '..', '..', '..', '..', 'src', 'db', 'repositories', 'sql');

/** Fin de l'instruction qui commence à `from` (premier `;` hors parenthèses, crochets et accolades). */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth <= 0) return i;
  }
  return text.length;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function violations(): { readonly checked: number; readonly found: Finding[] } {
  const found: Finding[] = [];
  let checked = 0;
  for (const name of readdirSync(DIR).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const text = readFileSync(join(DIR, name), 'utf8');
    for (const match of text.matchAll(/stamper\.next\(\)/g)) {
      checked += 1;
      const next = text.indexOf('await ', match.index);
      const awaited = next < 0 ? '' : text.slice(next, statementEnd(text, next));
      if (!awaited.startsWith('await db.execute(')) found.push({ file: name, line: text.slice(0, match.index).split('\n').length, text: awaited.slice(0, 120) });
    }
  }
  return { checked, found };
}

describe('tampon pris juste avant l’écriture (seconde revue de Y-04, point 2)', () => {
  it('dans tous les repositories SQL, la première attente après un tampon est une écriture', () => {
    const { checked, found } = violations();
    expect(checked).toBeGreaterThan(30);
    expect(found).toEqual([]);
  });
});
