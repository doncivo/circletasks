import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * N-02 critère 9, N-04 critère 7 : à l'ordre 1, aucune notification n'est émise ni planifiée, et le PC n'expose aucune planification
 * de rappel (l'envoi est sur l'iPhone, ordre 5). Les modules rappels, tâches, réglages et la plateforme n'importent aucun plugin
 * de notification.
 */
function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesOf(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Rappels : aucune notification émise (ordre 1)', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dirs = ['features/reminders', 'features/tasks', 'features/settings', 'domain', 'platform'].map((d) => join(src, d));

  it('aucun fichier n’importe un plugin de notification ni n’appelle l’API Notification', () => {
    const files = dirs.flatMap(sourcesOf);
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/plugin-notification|new Notification\(|Notification\.requestPermission|sendNotification|scheduleNotification/);
    }
  });

  it('le module platform du PC n’expose aucune planification de rappel', () => {
    for (const file of sourcesOf(join(src, 'platform', 'desktop'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/schedule(Reminder|Notification)|planif/i);
    }
  });
});
