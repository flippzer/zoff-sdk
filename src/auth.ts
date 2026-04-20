/**
 * JWT minter for Keycloak password-grant flow against the DevNet realm.
 *
 * The `app-provider-unsafe` client on Toiki's DevNet is a PUBLIC client:
 * no `client_secret` is used, despite what the historical handover file
 * suggests. Real JWT `aud` is `["https://canton.network.global", "account"]`,
 * NOT the client name. See Signal briefing 2026-04-20 for the clarifications
 * this module encodes.
 *
 * Bootstrap JWTs are short-lived (~5 min), so this minter mints on demand
 * and caches until near-expiry — never commits a live token anywhere.
 */
import { walletError } from './errors.js';
import type { KeycloakPasswordGrantConfig } from './config.js';

interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly token_type: string;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

/**
 * Safety margin subtracted from Keycloak's advertised `expires_in` so we
 * re-mint comfortably before the token actually expires. 30s covers typical
 * clock skew plus a slow round-trip.
 */
const EXPIRY_SAFETY_MS = 30_000;

/**
 * Mints and caches short-lived Keycloak access tokens for a fixed user.
 *
 * Intended as a plumbing primitive used by both the `ZoffProvider` (Phase 3
 * gRPC submit auth) and the daml-script smoke harness (Phase 2 path 1).
 */
export class JwtMinter {
  private cached: CachedToken | null = null;

  constructor(private readonly config: KeycloakPasswordGrantConfig) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached !== null && this.cached.expiresAtMs > now) {
      return this.cached.accessToken;
    }
    const minted = await this.mint();
    this.cached = minted;
    return minted.accessToken;
  }

  /** Force a fresh mint. Useful when an auth failure suggests a stale cache. */
  async refresh(): Promise<string> {
    this.cached = null;
    return this.getToken();
  }

  private async mint(): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.clientId,
      username: this.config.username,
      password: this.config.password,
      scope: this.config.scope ?? 'openid',
    });

    let response: Response;
    try {
      response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw walletError(
        'VALIDATOR_ERROR',
        `Keycloak token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { tokenUrl: this.config.tokenUrl }
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw walletError(
        'VALIDATOR_ERROR',
        `Keycloak token endpoint returned ${response.status}: ${text}`,
        { tokenUrl: this.config.tokenUrl, status: response.status }
      );
    }

    const data = (await response.json()) as Partial<TokenResponse>;
    if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
      throw walletError(
        'VALIDATOR_ERROR',
        'Keycloak token response missing access_token or expires_in',
        { tokenUrl: this.config.tokenUrl }
      );
    }

    return {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + data.expires_in * 1000 - EXPIRY_SAFETY_MS,
    };
  }
}
