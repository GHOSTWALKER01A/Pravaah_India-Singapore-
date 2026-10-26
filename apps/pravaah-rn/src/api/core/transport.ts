/**
 * The wire under `ApiClient` — two transports, one response shape.
 *
 * ## Why multipart does not go through `fetch`
 *
 * Since SDK 56 the global `fetch` on iOS and Android is `expo/fetch`, not React Native's
 * XHR-backed polyfill. `expo/fetch` serialises a `FormData` body itself, and it accepts only
 * strings, `Blob`s and expo-file-system `File`s as parts. React Native's own file shape —
 * `{ uri, name, type }`, which every upload in this app uses — makes it throw
 * `Unsupported FormDataPart implementation` before a byte is sent. That throw lands in the
 * client's network-failure branch, so a selfie upload would have reported "Can't reach the
 * server" on a perfectly good connection.
 *
 * Wrapping each photo in an expo-file-system `File` would satisfy `expo/fetch`, but it reads
 * the whole file into JS memory via `bytes()` — exactly the cost `claims.service.ts` documents
 * choosing to avoid. `XMLHttpRequest` is still React Native's native networking stack, it
 * streams `{ uri }` parts straight from disk, and Expo does not replace it. So JSON rides
 * `fetch`, multipart rides XHR, and both come back as a {@link TransportResponse}.
 *
 * ## Why every request has a deadline
 *
 * Neither transport times out by default. On a mobile network the common failure is not a
 * refusal but a connection that stalls — a lift, a tunnel, a captive portal — and without a
 * deadline the spinner simply never stops. A timeout is reported as `status: 0` like any
 * other transport failure, because it means the same thing to a caller: the request may or
 * may not have reached the server (`disclose-screen.tsx` depends on exactly that reading).
 */

/** Everything the client needs from a response, independent of which transport produced it. */
export interface TransportResponse {
  status: number;
  ok: boolean;
  /** The raw body. Parsed by the caller, so an empty 204 or an HTML proxy page cannot throw here. */
  text: string;
}

/** Why a request produced no HTTP response at all. */
export type TransportFailureKind = 'NETWORK' | 'TIMEOUT';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

interface SendOptions {
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

/**
 * JSON (or empty) body over `fetch`, with a deadline.
 *
 * The timer is cleared in `finally` on every path. The body is read INSIDE the deadline too:
 * a server can send headers promptly and then stall mid-body, and that stall is as much a hang
 * as one before the headers.
 */
export async function sendJson(
  url: string,
  body: string | undefined,
  { method, headers, timeoutMs }: SendOptions,
): Promise<TransportResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (error) {
    if (timedOut) {
      throw new TransportError('TIMEOUT', `Request timed out after ${timeoutMs} ms`);
    }
    throw new TransportError(
      'NETWORK',
      error instanceof Error ? error.message : 'Network request failed',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A `FormData` body over `XMLHttpRequest` — see the file header for why not `fetch`.
 *
 * `Content-Type` must NOT be set by the caller: XHR writes
 * `multipart/form-data; boundary=...` itself, and a hand-set header would carry no boundary.
 */
export function sendMultipart(
  url: string,
  form: FormData,
  { method, headers, timeoutMs }: SendOptions,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.timeout = timeoutMs;
    xhr.responseType = 'text';

    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'content-type') continue;
      xhr.setRequestHeader(name, value);
    }

    xhr.onload = () => {
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        text: typeof xhr.responseText === 'string' ? xhr.responseText : '',
      });
    };
    xhr.onerror = () => {
      reject(new TransportError('NETWORK', 'Network request failed'));
    };
    xhr.ontimeout = () => {
      reject(new TransportError('TIMEOUT', `Upload timed out after ${timeoutMs} ms`));
    };
    xhr.onabort = () => {
      reject(new TransportError('NETWORK', 'Upload was aborted'));
    };

    xhr.send(form);
  });
}
