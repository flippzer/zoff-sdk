/**
 * @zoffwallet/sdk — devnet end-to-end smoke.
 *
 * Demonstrates the full canonical CantonWalletProvider surface against a
 * real devnet wallet:
 *
 *   discover (EIP-6963)
 *     → init({ network: 'devnet' })
 *     → connect()                              // popup approval
 *     → getHoldings() / getActiveContracts()
 *     → prepareTransfer(...)
 *     → submitAndWaitForTransaction(prepared)  // popup approval
 *
 * Run in a browser. The SDK is browser-only — `window`, `crypto`, and
 * cross-origin popups are required. Bundle this module with your dApp
 * and call `runEndToEnd()` from a click handler so the popup is
 * triggered by a user gesture.
 *
 * Used as the rc.1 dry-run install verification: `npm pack` the SDK,
 * install the .tgz alongside `@zoffwallet/provider-interface@^0.1.2` in
 * a fresh dApp shell, and call this from a button click.
 */
import type {
  CantonWalletAnnounceEvent,
  CantonWalletInfo,
  CantonWalletProvider,
} from '@zoffwallet/provider-interface';
import { ZoffProvider } from '../src/index.js';

interface DiscoveredProvider {
  readonly info: CantonWalletInfo;
  readonly provider: CantonWalletProvider;
}

/**
 * Discover wallets via the canonical `canton:announceProvider` /
 * `canton:requestProvider` event pair. Resolves with the first
 * provider whose `rdns === 'app.zoff'`. Times out after 1s.
 */
function discoverZoffProvider(timeoutMs = 1_000): Promise<DiscoveredProvider> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAnnounce = (e: Event): void => {
      const evt = e as CantonWalletAnnounceEvent;
      if (evt.detail.info.rdns !== 'app.zoff' || settled) return;
      settled = true;
      window.removeEventListener('canton:announceProvider', onAnnounce);
      resolve(evt.detail);
    };
    window.addEventListener('canton:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('canton:requestProvider'));
    setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('canton:announceProvider', onAnnounce);
      reject(new Error('No Zoff provider announced within timeout'));
    }, timeoutMs);
  });
}

export async function runEndToEnd(opts: {
  recipient: string;
  amount: string;
  instrumentAdmin: string;
  instrumentId?: string;
}): Promise<void> {
  // In production, the SDK is loaded by a wallet extension or the dApp
  // itself. Construction here proves the example self-contains.
  new ZoffProvider();

  const { info, provider } = await discoverZoffProvider();
  console.log('Discovered:', info.name, info.rdns, info.uuid);

  await provider.init({ appName: 'sdk-smoke', network: 'devnet' });

  const { partyId, authToken } = await provider.connect();
  console.log('Connected:', partyId, '(token len)', authToken.length);

  const holdings = await provider.getHoldings();
  console.log('Holdings:', holdings.length);

  const prepared = await provider.prepareTransfer({
    recipient: opts.recipient,
    amount: opts.amount,
    instrument: {
      instrumentAdmin: opts.instrumentAdmin,
      instrumentId: opts.instrumentId ?? 'Amulet',
    },
  });

  const result = await provider.submitAndWaitForTransaction(prepared);
  console.log(
    'Submitted:',
    result.updateId,
    'completionOffset:',
    result.completionOffset
  );
}
