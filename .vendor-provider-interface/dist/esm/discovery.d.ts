import type { CantonWalletProvider } from './provider.js';
/**
 * Event-based wallet discovery, modeled on EIP-6963.
 *
 * Motivation: a single global injection (`window.cantonWallet`) does
 * not compose with multiple wallets on the same page. The event pattern
 * lets every installed wallet announce itself independently, and lets
 * the dApp discover all of them without collision.
 *
 * Flow:
 *
 *   1. dApp dispatches `canton:requestProvider` on `window`.
 *   2. Each installed wallet responds by dispatching
 *      `canton:announceProvider` with its provider and metadata.
 *   3. dApp listens for `canton:announceProvider`, collects entries,
 *      and presents them to the user.
 *
 * Wallets SHOULD also announce proactively on page load, since the dApp
 * may register its listener before dispatching the request.
 *
 * Event names are intentionally string literals, not exported constants —
 * this package ships types only, with no runtime surface.
 */
/**
 * Metadata describing a wallet. Surfaced in dApp UI (connect modals etc).
 */
export interface CantonWalletInfo {
    /** Display name, human-readable. */
    readonly name: string;
    /**
     * Data URI or https URL; SHOULD be a square image with minimum
     * resolution 96×96 (192×192 recommended for retina rendering).
     */
    readonly icon: string;
    /**
     * Identifies a single announcement. A wallet MAY re-announce with a
     * new uuid on reload.
     */
    readonly uuid: string;
    /**
     * Reverse-DNS wallet identifier (e.g. `app.zoff`). Stable across
     * announcements and across versions of the same wallet.
     */
    readonly rdns: string;
}
/**
 * Detail carried by a `canton:announceProvider` event.
 */
export interface CantonWalletAnnounceDetail {
    readonly info: CantonWalletInfo;
    readonly provider: CantonWalletProvider;
}
/**
 * Type of the `canton:announceProvider` event. Consumers register via:
 *
 * ```ts
 * window.addEventListener('canton:announceProvider', (e) => {
 *   const { info, provider } = (e as CantonWalletAnnounceEvent).detail;
 * });
 * ```
 */
export interface CantonWalletAnnounceEvent extends CustomEvent<CantonWalletAnnounceDetail> {
    readonly type: 'canton:announceProvider';
}
/**
 * Type of the `canton:requestProvider` event. No payload.
 */
export interface CantonWalletRequestEvent extends Event {
    readonly type: 'canton:requestProvider';
}
//# sourceMappingURL=discovery.d.ts.map