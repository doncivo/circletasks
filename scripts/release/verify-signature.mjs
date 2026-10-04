/* global process, console */
// Vérifie hors ligne la signature minisign d'un installeur avec la clé publique de tauri.conf.json
// (plugins.updater.pubkey). Aucune dépendance : node:crypto uniquement.
// Usage : node scripts/release/verify-signature.mjs <installeur.exe> <installeur.exe.sig> <version> [tauri.conf.json]
//
// Vérifié : algorithme de la clé (« Ed »), ID de clé identique dans la clé publique et la signature,
// signature Ed25519 du fichier (préhachage BLAKE2b-512 pour « ED », message brut pour « Ed »),
// signature globale Ed25519 sur (signature || commentaire de confiance), et présence de
// « version:<version> » dans le commentaire de confiance (champs séparés par des tabulations).
// Non vérifié : l'horodatage et le nom de fichier du commentaire de confiance.
import { Buffer } from 'node:buffer';
import { createHash,createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const b64 = (s) => Buffer.from(s.trim(), 'base64');

function minisignText(base64Text) {
  return b64(base64Text).toString('utf8').split(/\r?\n/);
}

/** Décode la clé publique minisign (contenu base64 du .pub, tel que dans tauri.conf.json). */
export function decodePublicKey(pubkeyB64) {
  const lines = minisignText(pubkeyB64);
  const raw = lines[1] ? b64(lines[1]) : Buffer.alloc(0);
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') {
    throw new Error('clé publique minisign invalide (attendu : algorithme Ed, id 8 octets, clé 32 octets)');
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

/**
 * Vérifie une signature minisign (contenu base64 du .sig Tauri) sur `data`.
 * Lève une Error au premier défaut, renvoie le commentaire de confiance sinon.
 */
export function verifyMinisign({ pubkeyB64, sigB64, data, version }) {
  const pub = decodePublicKey(pubkeyB64);
  const lines = minisignText(sigB64);
  if (lines.length < 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment: ')) {
    throw new Error('fichier de signature minisign mal formé');
  }
  const sigRaw = b64(lines[1]);
  const globalSig = b64(lines[3]);
  if (sigRaw.length !== 74 || globalSig.length !== 64) throw new Error('longueur de signature inattendue');
  const algo = sigRaw.toString('latin1', 0, 2);
  if (algo !== 'ED' && algo !== 'Ed') throw new Error(`algorithme de signature inconnu : ${algo}`);
  if (!sigRaw.subarray(2, 10).equals(pub.keyId)) throw new Error('ID de clé différent de la clé publique de tauri.conf.json');
  const signature = sigRaw.subarray(10);

  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pub.key.toString('base64url') },
    format: 'jwk',
  });
  const message = algo === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, key, signature)) throw new Error('signature Ed25519 du fichier invalide');

  const trusted = lines[2].slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([signature, Buffer.from(trusted, 'utf8')]), key, globalSig)) {
    throw new Error('signature globale (commentaire de confiance) invalide');
  }
  if (version !== undefined && !trusted.split('\t').includes(`version:${version}`)) {
    throw new Error(`le commentaire de confiance ne contient pas version:${version} (« ${trusted} »)`);
  }
  return trusted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [exePath, sigPath, version, confArg] = process.argv.slice(2);
  if (!exePath || !sigPath || !version) {
    console.error('Usage : verify-signature.mjs <exe> <sig> <version> [tauri.conf.json]');
    process.exit(1);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const conf = JSON.parse(readFileSync(confArg ?? resolve(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  try {
    const trusted = verifyMinisign({
      pubkeyB64: conf.plugins.updater.pubkey,
      sigB64: readFileSync(sigPath, 'utf8'),
      data: readFileSync(exePath),
      version,
    });
    console.log(`Signature valide (${trusted})`);
  } catch (e) {
    console.error(`::error::Vérification de la signature : ${e.message}`);
    process.exit(1);
  }
}
