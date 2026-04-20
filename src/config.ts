/**
 * Construction-time config for a {@link ZoffProvider}.
 *
 * Kept separate from `InitConfig` (the dApp-facing init payload from the
 * provider interface). `ZoffProviderConfig` is wallet-implementation
 * plumbing: Keycloak endpoint, ledger-API host/port, the party this
 * provider speaks for. `InitConfig` is the dApp saying "I'm this dApp,
 * targeting this network" — no auth material.
 */

export interface LedgerApiConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
}

export interface KeycloakPasswordGrantConfig {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly username: string;
  readonly password: string;
  /**
   * Scope requested from Keycloak. Defaults to `'openid'` per the DevNet
   * handover. Callers override only if their realm requires a different
   * scope (e.g. `'openid profile'`).
   */
  readonly scope?: string;
}

export interface ZoffProviderConfig {
  readonly ledgerApi: LedgerApiConfig;
  readonly auth: KeycloakPasswordGrantConfig;
  /**
   * Party id this provider acts for. Required — we do not derive it from
   * the JWT. Party IDs on Canton encode the participant fingerprint, so
   * only the deployer knows which party a given Keycloak user should
   * represent.
   */
  readonly partyId: string;
  /**
   * Synchronizer id the provider submits to. Optional: when omitted,
   * implementations SHOULD resolve at runtime via the participant's
   * connected-synchronizer list. The gRPC client (Phase 3) will do that
   * resolution; pre-gRPC the field is currently required upstream of any
   * submit.
   */
  readonly synchronizerId?: string;
}
