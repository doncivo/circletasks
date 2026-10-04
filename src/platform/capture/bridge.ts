import {
  BLURRED_EVENT,
  CAPTURE_WINDOW_LABEL,
  CONTEXT_EVENT,
  CONTEXT_REQUEST_EVENT,
  DONE_EVENT,
  HIDE_COMMAND,
  MAIN_WINDOW_LABEL,
  RESIZE_COMMAND,
  SETUP_ERROR_COMMAND,
  SHOWN_EVENT,
  SUBMIT_EVENT,
  SUBMIT_TIMEOUT_MS,
} from './events';
import type {
  CaptureContextSnapshot,
  CaptureMainBridge,
  CaptureOutcome,
  CaptureReply,
  CaptureSubmit,
  CaptureTransport,
  CaptureWindowBridge,
} from './types';

/** Identifiants gardés pour l'idempotence. */
const SEEN_LIMIT = 100;
const noop = (): void => undefined;
let counter = 0;
const newRequestId = (): string => `capture-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asSubmit(value: unknown): CaptureSubmit | null {
  if (!isObject(value) || typeof value['requestId'] !== 'string' || typeof value['text'] !== 'string') return null;
  const ignored = Array.isArray(value['ignored']) ? value['ignored'].filter((key): key is string => typeof key === 'string') : [];
  return { requestId: value['requestId'], text: value['text'], ignored };
}

function asOutcome(value: unknown): CaptureOutcome | null {
  if (!isObject(value) || typeof value['requestId'] !== 'string') return null;
  if (value['ok'] === true && typeof value['title'] === 'string') return { requestId: value['requestId'], ok: true, title: value['title'] };
  if (value['ok'] === false) {
    const error = value['error'];
    return { requestId: value['requestId'], ok: false, error: error === 'title-empty' || error === 'no-space' ? error : 'failed' };
  }
  return null;
}

function asContext(value: unknown): CaptureContextSnapshot | null {
  if (!isObject(value) || !Array.isArray(value['spaces']) || !Array.isArray(value['projects'])) return null;
  return value as unknown as CaptureContextSnapshot;
}

/** Pont de la mini-fenêtre au-dessus d'un transport. `timeoutMs` : délai d'attente de la réponse (réglable en test). */
export function createWindowBridge(transport: CaptureTransport, timeoutMs: number = SUBMIT_TIMEOUT_MS): CaptureWindowBridge {
  // Envoi resté sans réponse (délai dépassé) : s'il est renvoyé tel quel, il garde son identifiant et l'hôte ne le traite qu'une fois.
  let unanswered: { readonly signature: string; readonly requestId: string } | null = null;
  return {
    onShown: (handler) => transport.listen(SHOWN_EVENT, () => handler()),
    onBlurred: (handler) => transport.listen(BLURRED_EVENT, () => handler()),
    onContext: (handler) =>
      transport.listen(CONTEXT_EVENT, (payload) => {
        const context = asContext(payload);
        if (context) handler(context);
      }),
    requestContext: () => transport.emit(MAIN_WINDOW_LABEL, CONTEXT_REQUEST_EVENT, null).catch(() => undefined),
    submit: async (request) => {
      const signature = JSON.stringify([request.text, request.ignored]);
      const requestId = unanswered?.signature === signature ? unanswered.requestId : newRequestId();
      unanswered = null;
      return new Promise<CaptureReply>((resolve) => {
        let stop: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (reply: CaptureReply): void => {
          if (timer !== null) clearTimeout(timer);
          stop?.();
          resolve(reply);
        };
        // Écoute avant l'envoi : une réponse immédiate ne se perd pas.
        transport
          .listen(DONE_EVENT, (payload) => {
            const outcome = asOutcome(payload);
            if (!outcome || outcome.requestId !== requestId) return;
            finish(outcome.ok ? { ok: true, title: outcome.title } : { ok: false, error: outcome.error });
          })
          .then(async (unlisten) => {
            stop = unlisten;
            timer = setTimeout(() => {
              unanswered = { signature, requestId };
              finish({ ok: false, error: 'failed' });
            }, timeoutMs);
            await transport.emit(MAIN_WINDOW_LABEL, SUBMIT_EVENT, { requestId, text: request.text, ignored: request.ignored });
          })
          .catch(() => finish({ ok: false, error: 'failed' }));
      });
    },
    hide: () => transport.invoke(HIDE_COMMAND).then(noop, noop),
    resize: (height) => transport.invoke(RESIZE_COMMAND, { height }).then(noop, noop),
  };
}

/** Pont de la fenêtre principale au-dessus d'un transport. */
export function createMainBridge(transport: CaptureTransport): CaptureMainBridge {
  // Requêtes déjà reçues (en cours ou terminées) : un renvoi du même identifiant ne crée jamais une seconde tâche, il reçoit la même réponse.
  const seen = new Map<string, Promise<CaptureReply>>();
  return {
    onSubmit: (handler) =>
      transport.listen(SUBMIT_EVENT, (payload) => {
        const request = asSubmit(payload);
        if (!request) return;
        let reply = seen.get(request.requestId);
        if (!reply) {
          reply = handler(request).catch((): CaptureReply => ({ ok: false, error: 'failed' }));
          seen.set(request.requestId, reply);
          if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value as string);
        }
        void reply
          .then((done) => transport.emit(CAPTURE_WINDOW_LABEL, DONE_EVENT, { requestId: request.requestId, ...done }))
          .catch(() => undefined);
      }),
    setupError: async () => {
      try {
        const error = await transport.invoke(SETUP_ERROR_COMMAND);
        return typeof error === 'string' ? error : null;
      } catch {
        return null;
      }
    },
    publishContext: (context) => transport.emit(CAPTURE_WINDOW_LABEL, CONTEXT_EVENT, context).catch(() => undefined),
    onContextRequest: (handler) => transport.listen(CONTEXT_REQUEST_EVENT, () => handler()),
  };
}
