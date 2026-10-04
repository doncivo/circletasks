import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { emptyStateExemptions, emptyStateScreens } from './emptyStateScreens';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('P-06 : registre des écrans à état vide', () => {
  const used = new Set<string>();
  for (const file of sources(join(__dirname, '..'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/<EmptyState[^>]*?\bscreen="(\w+)"/gs)) used.add(match[1] as string);
  }

  it('chaque EmptyState du code est dans le registre, et chaque entrée du registre est utilisée', () => {
    const registered = emptyStateScreens.map((screen) => screen.id).sort();
    expect([...used].sort()).toEqual(registered);
  });

  it('les exemptions documentées (Recherche, Objectif, Agendas, Projets) n’utilisent pas EmptyState et ne chevauchent pas le registre', () => {
    expect([...emptyStateExemptions].sort()).toEqual(['calendars', 'goals', 'projects', 'search']);
    for (const id of emptyStateExemptions) {
      expect(used.has(id)).toBe(false);
      expect(emptyStateScreens.some((screen) => screen.id === id)).toBe(false);
    }
  });

  it('chaque écran du registre a une action nommée', () => {
    for (const screen of emptyStateScreens) expect(t(screen.actionKey).length).toBeGreaterThan(0);
  });
});
