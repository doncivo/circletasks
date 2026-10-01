import { describe, expect, it, vi } from 'vitest';
import type { WriteStamper } from '../../domain/hlc';
import type { SqlExecutor } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { NotImplementedError, createDataAccess, createPendingRepositories, type Repositories } from './dataAccess';
import { RepositoryError } from './common';

const stamper: WriteStamper = { next: () => ({ at: '' as never, deviceId: '' as never, hlc: '' as never }) };

describe('DataAccess', () => {
  it('lie les repositories au driver, puis au tx dans une transaction', async () => {
    const driver = await openSqliteWasmDriver();
    const executors: SqlExecutor[] = [];
    const factory = vi.fn((executor: SqlExecutor) => {
      executors.push(executor);
      return createPendingRepositories(executor, stamper);
    });
    const data = createDataAccess(driver, stamper, factory);
    expect(executors[0]).toBe(driver);
    const result = await data.transaction(async (repos: Repositories) => {
      expect(repos).toBeDefined();
      return 42;
    });
    expect(result).toBe(42);
    expect(executors).toHaveLength(2);
    expect(executors[1]).not.toBe(driver);
    expect(factory).toHaveBeenLastCalledWith(executors[1], stamper);
    await driver.close();
  });

  it('les repositories en attente nomment la méthode manquante', async () => {
    const repos = createPendingRepositories({} as SqlExecutor, stamper);
    await expect(repos.tasks.listForDay('2026-10-01' as never, 'all')).rejects.toThrow(NotImplementedError);
    await expect(repos.settings.get('device.id')).rejects.toThrow(/settings\.get/);
  });

  it('RepositoryError porte le code, l’entité et l’id', () => {
    const error = new RepositoryError('not-found', 'task', 'abc');
    expect(error).toMatchObject({ name: 'RepositoryError', code: 'not-found', entity: 'task', entityId: 'abc' });
  });
});
