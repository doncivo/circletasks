// Tests des scripts de publication PC (D-03 critères 10 et 11). Aucun secret : paires Ed25519 jetables.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sans déclaration de types
import { checkVersion } from './check-version.mjs';

const dir = resolve(__dirname);
const script = (name: string): string => join(dir, name);
let tmp = '';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ct-release-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(name: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');

describe('make-latest-json', () => {
  const exe = (): string => {
    const p = join(tmp, 'CircleTasks_1.2.3_x64-setup.exe');
    writeFileSync(p, 'exe');
    return p;
  };
  const sig = (content: string): string => {
    const p = join(tmp, 'x.sig');
    writeFileSync(p, content);
    return p;
  };
  const base = 'https://github.com/doncivo/circletasks-releases/releases/download/v1.2.3';

  it('produit le format updater Tauri 2 complet', () => {
    const out = execFileSync(process.execPath, [script('make-latest-json.mjs'), '1.2.3', exe(), sig('SIGNATURE\n'), base, 'Notes'], {
      encoding: 'utf8',
    });
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['notes', 'platforms', 'pub_date', 'version']);
    expect(json['version']).toBe('1.2.3');
    expect(json['notes']).toBe('Notes');
    expect(new Date(json['pub_date'] as string).toISOString()).toBe(json['pub_date']);
    const platforms = json['platforms'] as Record<string, { signature: string; url: string }>;
    expect(Object.keys(platforms)).toEqual(['windows-x86_64']);
    expect(platforms['windows-x86_64']?.signature).toBe('SIGNATURE');
    expect(platforms['windows-x86_64']?.url).toBe(`${base}/CircleTasks_1.2.3_x64-setup.exe`);
  });

  it('utilise des notes par défaut et tolère une barre finale dans l’URL de base', () => {
    const out = JSON.parse(
      execFileSync(process.execPath, [script('make-latest-json.mjs'), '1.2.3', exe(), sig('S'), `${base}/`], { encoding: 'utf8' }),
    ) as { notes: string; platforms: Record<string, { url: string }> };
    expect(out.notes).toBe('CircleTasks 1.2.3');
    expect(out.platforms['windows-x86_64']?.url).toBe(`${base}/CircleTasks_1.2.3_x64-setup.exe`);
  });

  it('échoue : signature vide, argument manquant, version invalide, exe absent', () => {
    expect(run('make-latest-json.mjs', ['1.2.3', exe(), sig('  \n'), base]).status).toBe(1);
    expect(run('make-latest-json.mjs', ['1.2.3', exe(), sig('S')]).status).toBe(1);
    expect(run('make-latest-json.mjs', ['1.2', exe(), sig('S'), base]).status).toBe(1);
    expect(run('make-latest-json.mjs', ['1.2.3', join(tmp, 'absent.exe'), sig('S'), base]).status).toBe(1);
  });
});

describe('check-version', () => {
  function repo(pkg: string, conf: string, cargo: string): string {
    const root = mkdtempSync(join(tmp, 'repo-'));
    mkdirSync(join(root, 'src-tauri'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: pkg }));
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: conf }));
    writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), `[package]\nname = "x"\nversion = "${cargo}"\n`);
    return root;
  }

  it('accepte des versions identiques et un tag conforme', () => {
    expect(checkVersion(repo('1.0.0', '1.0.0', '1.0.0'), 'v1.0.0')).toEqual({ version: '1.0.0', errors: [] });
  });
  it('refuse un tag non conforme', () => {
    expect(checkVersion(repo('1.0.0', '1.0.0', '1.0.0'), 'v1.0.1').errors).toHaveLength(1);
    expect(checkVersion(repo('1.0.0', '1.0.0', '1.0.0'), '1.0.0').errors).toHaveLength(1);
  });
  it('refuse des versions divergentes', () => {
    expect(checkVersion(repo('1.0.1', '1.0.0', '1.0.0')).errors).toHaveLength(1);
    expect(checkVersion(repo('1.0.0', '1.0.0', '1.0.2')).errors).toHaveLength(1);
    expect(checkVersion(repo('1.0.0', '1.0', '1.0')).errors.length).toBeGreaterThan(0);
  });
  it('le dépôt réel est cohérent', () => {
    expect(checkVersion(resolve(dir, '..', '..')).errors).toEqual([]);
  });
});

describe('verify-signature', () => {
  const keyId = randomBytes(8);
  const pair = generateKeyPairSync('ed25519');

  function pubkeyB64(publicKey: KeyObject, id: Buffer = keyId): string {
    const x = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    const raw = Buffer.concat([Buffer.from('Ed'), id, x]);
    return b64(`untrusted comment: minisign public key: TEST\n${raw.toString('base64')}\n`);
  }

  function sigFile(data: Buffer, opts: { algo?: 'ED' | 'Ed'; id?: Buffer; trusted?: string; priv?: KeyObject } = {}): string {
    const algo = opts.algo ?? 'ED';
    const priv = opts.priv ?? pair.privateKey;
    const trusted = opts.trusted ?? 'timestamp:1\tfile:CircleTasks_1.2.3_x64-setup.exe\tversion:1.2.3';
    const message = algo === 'ED' ? createHash('blake2b512').update(data).digest() : data;
    const signature = sign(null, message, priv);
    const raw = Buffer.concat([Buffer.from(algo), opts.id ?? keyId, signature]);
    const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), priv);
    return b64(
      `untrusted comment: signature from tauri secret key\n${raw.toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`,
    );
  }

  function setup(data: Buffer, sigB64: string, pub: string = pubkeyB64(pair.publicKey)): { exe: string; sig: string; conf: string } {
    const exe = join(tmp, 'v.exe');
    const sig = join(tmp, 'v.sig');
    const conf = join(tmp, 'v.conf.json');
    writeFileSync(exe, data);
    writeFileSync(sig, sigB64);
    writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: pub } } }));
    return { exe, sig, conf };
  }

  const data = randomBytes(2048);
  const verifyCli = (f: { exe: string; sig: string; conf: string }, version = '1.2.3'): number | null =>
    run('verify-signature.mjs', [f.exe, f.sig, version, f.conf]).status;

  it('accepte une signature valide (préhachée ED et brute Ed)', () => {
    expect(verifyCli(setup(data, sigFile(data)))).toBe(0);
    expect(verifyCli(setup(data, sigFile(data, { algo: 'Ed' })))).toBe(0);
  });
  it('refuse un mauvais ID de clé', () => {
    expect(verifyCli(setup(data, sigFile(data, { id: randomBytes(8) })))).toBe(1);
  });
  it('refuse une signature signée par une autre clé', () => {
    expect(verifyCli(setup(data, sigFile(data, { priv: generateKeyPairSync('ed25519').privateKey })))).toBe(1);
  });
  it('refuse un installeur ou un commentaire de confiance altéré', () => {
    const altered = Buffer.from(data);
    altered[0] = (altered[0] ?? 0) ^ 1;
    expect(verifyCli(setup(altered, sigFile(data)))).toBe(1);
    const tampered = Buffer.from(sigFile(data), 'base64').toString('utf8').replace('version:1.2.3', 'version:9.9.9');
    expect(verifyCli(setup(data, b64(tampered)))).toBe(1);
  });
  it('refuse une signature altérée', () => {
    const text = Buffer.from(sigFile(data), 'base64').toString('utf8').split('\n');
    const raw = Buffer.from(text[1] ?? '', 'base64');
    raw[20] = (raw[20] ?? 0) ^ 1;
    text[1] = raw.toString('base64');
    expect(verifyCli(setup(data, b64(text.join('\n'))))).toBe(1);
  });
  it('refuse si la version est absente du commentaire de confiance ou différente', () => {
    expect(verifyCli(setup(data, sigFile(data, { trusted: 'timestamp:1\tfile:x.exe' })))).toBe(1);
    expect(verifyCli(setup(data, sigFile(data)), '1.2.4')).toBe(1);
  });
});
