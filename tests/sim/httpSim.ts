import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Socle commun des simulateurs d'agendas (ADR 0008) : serveur HTTP local sur 127.0.0.1, port libre, CORS ouvert (le navigateur de
 * dev et Playwright appellent depuis http://localhost:1420 par défaut, E2E_DEV_PORT), injection d'erreurs pour la prochaine requête.
 */

export interface SimRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface SimResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Erreur à servir à la place de la prochaine requête dont le chemin commence par `pathPrefix` (défaut : toutes). */
export interface InjectedFailure {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly pathPrefix?: string;
}

export interface RunningSim {
  readonly baseUrl: string;
  /** Requêtes reçues (méthode + chemin), pour vérifier l'absence de requêtes inutiles (ctag). */
  readonly log: string[];
  failNext(failure: InjectedFailure): void;
  close(): Promise<void>;
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PROPFIND, REPORT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, depth',
  'access-control-expose-headers': 'retry-after, etag, location',
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, result: SimResponse): void {
  response.writeHead(result.status, { ...CORS, ...result.headers });
  response.end(result.body ?? '');
}

export async function startSim(handler: (request: SimRequest, baseUrl: string) => SimResponse | Promise<SimResponse>, port = 0): Promise<RunningSim> {
  const log: string[] = [];
  const failures: InjectedFailure[] = [];
  let baseUrl = '';
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', baseUrl);
      if (request.method === 'OPTIONS') return send(response, { status: 204 });
      log.push(`${request.method ?? 'GET'} ${url.pathname}`);
      const index = failures.findIndex((failure) => url.pathname.startsWith(failure.pathPrefix ?? '/'));
      if (index >= 0) {
        const [failure] = failures.splice(index, 1);
        if (failure) {
          const headers: Record<string, string> = failure.retryAfterSeconds === undefined ? {} : { 'retry-after': String(failure.retryAfterSeconds) };
          return send(response, { status: failure.status, headers, body: '' });
        }
      }
      const body = await readBody(request);
      send(response, await handler({ method: request.method ?? 'GET', url, headers: request.headers, body }, baseUrl));
    })().catch(() => send(response, { status: 500 }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    log,
    failNext: (failure) => void failures.push(failure),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Connexions persistantes du navigateur : sans cela, la fermeture attendrait leur délai d'inactivité.
        server.closeAllConnections();
      }),
  };
}

export const json = (status: number, value: unknown): SimResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
