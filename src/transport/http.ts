/**
 * `HttpClient` — fetch wrapper for the canton-wallet backend.
 *
 * Translates HTTP failures into canonical {@link WalletError} instances
 * per the mapping table in {@link mapBackendError}. Bearer auth is the
 * SDK's only auth flow — anonymous backend calls are not supported. The
 * auth token is read on every request via the configured `authToken()`
 * accessor, so the provider can rotate it (e.g. after `disconnect`)
 * without rebuilding the client.
 *
 * The class takes an optional `fetchImpl` for tests; production paths
 * use the global `fetch`.
 */
import type { WalletErrorCode } from '@zoffwallet/provider-interface';
import { walletError, ZoffWalletError } from '../errors.js';

export interface HttpClientConfig {
  /**
   * Backend origin (no trailing slash). E.g.
   * `https://api.devnet.zoff.app`. Resolved by the provider from
   * `NETWORK_TO_BACKEND_ORIGIN` at init time, or overridden via
   * `ZoffProviderOptions.backendOrigin` for local dev.
   */
  readonly backendOrigin: string;
  /**
   * Accessor for the current Bearer token. Called on every request so
   * the provider can rotate the token without rebuilding the client.
   * Returning `null` makes the request anonymous (no `Authorization`
   * header) — backend routes that require auth will respond 401, which
   * maps to `WalletError { code: 'NOT_CONNECTED' }`.
   */
  readonly authToken: () => string | null;
  /**
   * Fetch override for tests. Defaults to the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

interface BackendErrorBody {
  readonly error?: string;
  readonly code?: string;
  readonly message?: string;
}

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  async post<TResponse>(path: string, body: unknown): Promise<TResponse> {
    return this.request<TResponse>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async get<TResponse>(path: string): Promise<TResponse> {
    return this.request<TResponse>(path, { method: 'GET' });
  }

  private async request<TResponse>(
    path: string,
    init: RequestInit
  ): Promise<TResponse> {
    const url = `${this.config.backendOrigin}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((init.headers ?? {}) as Record<string, string>),
    };

    const token = this.config.authToken();
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const fetchImpl = this.config.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers });
    } catch (err) {
      throw walletError(
        'VALIDATOR_ERROR',
        `Network error reaching backend: ${err instanceof Error ? err.message : String(err)}`,
        { url, cause: 'fetch_failed' }
      );
    }

    if (!response.ok) {
      let bodyText = '';
      let bodyJson: BackendErrorBody | null = null;
      try {
        bodyText = await response.text();
        if (bodyText.length > 0) {
          bodyJson = JSON.parse(bodyText) as BackendErrorBody;
        }
      } catch {
        // Non-JSON body. Fall through with bodyText only.
      }
      throw mapBackendError(response.status, bodyJson, bodyText, path);
    }

    return (await response.json()) as TResponse;
  }
}

/**
 * Map HTTP status + backend error body to a canonical {@link WalletError}.
 *
 * The canton-wallet backend's `LedgerError` codes are
 * `NOT_FOUND | PERMISSION_DENIED | INVALID_ARGUMENT | ABORTED | INTERNAL`,
 * serialized as `{ error: <message>, code: <code> }` with HTTP status
 * mapped per `node-client.ts#mapStatusToCode`. Auth routes use
 * `code: 'UNAUTHORIZED'` on 401; rate-limit responses use 429.
 *
 * The mapping below is HTTP-status-first because the status is the most
 * reliable signal: a 401 always means auth, a 429 always means rate
 * limit. The backend code is preserved in `details.backendCode` for
 * tooling that wants finer-grained discrimination, but per the canonical
 * contract callers MUST discriminate on `code`, not `details`.
 */
function mapBackendError(
  status: number,
  body: BackendErrorBody | null,
  rawBody: string,
  path: string
): ZoffWalletError {
  const backendCode = body?.code;
  const backendMessage =
    body?.error ?? body?.message ?? rawBody ?? `Request failed: HTTP ${status}`;

  let canonicalCode: WalletErrorCode;
  if (status === 401) canonicalCode = 'NOT_CONNECTED';
  else if (status === 429) canonicalCode = 'RATE_LIMITED';
  else if (status === 408 || status === 504) canonicalCode = 'TIMEOUT';
  else if (status === 400 || backendCode === 'INVALID_ARGUMENT')
    canonicalCode = 'INVALID_COMMAND';
  else if (status >= 500) canonicalCode = 'VALIDATOR_ERROR';
  else canonicalCode = 'UNKNOWN';

  const details: Record<string, unknown> = { backendStatus: status, path };
  if (backendCode !== undefined) details['backendCode'] = backendCode;

  return walletError(canonicalCode, backendMessage, details);
}
