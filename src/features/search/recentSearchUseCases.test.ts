import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer, type AppContainer } from '../app/container';
import { onRecentSearchesChanged } from './recentSearchEvents';
import { createRecentSearchUseCases } from './recentSearchUseCases';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000b4');

describe('cas d’usage des recherches récentes (RC-04)', () => {
  let db: TestDb;
  let container: AppContainer;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
  });
  afterEach(() => db.close());

  it('enregistre, remonte les doublons, retire, et écrit dans le réglage local (critères 3, 4, 5, 6)', async () => {
    const useCases = createRecentSearchUseCases(container);
    expect(await useCases.load()).toEqual([]);
    expect(await useCases.record('notaire')).toEqual(['notaire']);
    expect(await useCases.record('sport')).toEqual(['sport', 'notaire']);
    expect(await useCases.record('NOTAIRE')).toEqual(['NOTAIRE', 'sport']);
    expect(await useCases.record('a')).toEqual(['NOTAIRE', 'sport']);
    expect(await useCases.remove('sport')).toEqual(['NOTAIRE']);
    expect(await db.data.repos.settings.get('search.recent')).toEqual(['NOTAIRE']);
    expect(await createRecentSearchUseCases(container).load()).toEqual(['NOTAIRE']);
  });

  it('ne réécrit pas le réglage quand la liste ne change pas, et prévient les abonnés quand elle change', async () => {
    const useCases = createRecentSearchUseCases(container);
    let changes = 0;
    onRecentSearchesChanged(container.data, () => {
      changes += 1;
    });
    await useCases.record('notaire');
    expect(changes).toBe(1);
    await useCases.record('x');
    await useCases.remove('inconnu');
    expect(changes).toBe(1);
  });

  it('« Effacer » vide la liste et pousse une commande annulable qui la restitue sans écraser les recherches faites depuis (critère 5)', async () => {
    const useCases = createRecentSearchUseCases(container);
    await useCases.record('notaire');
    await useCases.record('sport');
    expect(await useCases.clear()).toEqual([]);
    const snapshot = container.undo.getSnapshot();
    expect(snapshot.top).toMatchObject({ kind: 'search', count: 1 });
    await useCases.record('loyer');
    expect((await container.undo.undoLast()).status).toBe('undone');
    expect(await useCases.load()).toEqual(['loyer', 'sport', 'notaire']);
  });

  it('effacer une liste vide ne pousse aucune commande', async () => {
    const useCases = createRecentSearchUseCases(container);
    expect(await useCases.clear()).toEqual([]);
    expect(container.undo.getSnapshot().size).toBe(0);
  });

  it('ne rejette jamais : une base qui échoue rend null', async () => {
    const useCases = createRecentSearchUseCases(container);
    await db.close();
    expect(await useCases.load()).toBeNull();
    expect(await useCases.record('notaire')).toBeNull();
    expect(await useCases.clear()).toBeNull();
    db = await openTestDb(DEVICE);
  });
});
