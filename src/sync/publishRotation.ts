import type { Repositories } from '../db/repositories';
import { parsePublishRotation, type PublishRotation } from '../domain/sync/publishRotation';

// Même clé que META ; ce bloc à la demande ne doit pas extraire les utilitaires du départ dans un bloc partagé.
const KEY = 'publishRotation';
export const readPublishRotation = async (repos: Repositories): Promise<PublishRotation | null> => parsePublishRotation(await repos.sync.getMeta(KEY));
export const savePublishRotation = (repos: Repositories, state: PublishRotation | null): Promise<void> => repos.sync.setMeta(KEY, state === null ? null : JSON.stringify(state));
