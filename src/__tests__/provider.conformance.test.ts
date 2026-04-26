import { describe, expect, it } from 'vitest';
import { ZoffProvider } from '../provider.js';

describe('ZoffProvider — CantonWalletProvider interface conformance', () => {
  const provider = new ZoffProvider();

  it('exposes the required identity surface', () => {
    expect(typeof provider.walletName).toBe('string');
    expect(provider.walletName.length).toBeGreaterThan(0);
    expect(typeof provider.walletVersion).toBe('string');
    expect(provider.walletVersion.length).toBeGreaterThan(0);
    expect(Array.isArray(provider.supportedNetworks)).toBe(true);
    expect(provider.supportedNetworks.length).toBeGreaterThan(0);
  });

  it('exposes partyId as a synchronous accessor returning null pre-connect', () => {
    expect(provider.partyId).toBeNull();
  });

  it('exposes every required CantonWalletProvider method', () => {
    expect(typeof provider.init).toBe('function');
    expect(typeof provider.connect).toBe('function');
    expect(typeof provider.disconnect).toBe('function');
    expect(typeof provider.isConnected).toBe('function');
    expect(typeof provider.getHoldings).toBe('function');
    expect(typeof provider.getActiveContracts).toBe('function');
    expect(typeof provider.prepareTransfer).toBe('function');
    expect(typeof provider.submitAndWaitForTransaction).toBe('function');
    expect(typeof provider.submitTransaction).toBe('function');
    expect(typeof provider.onTransactionUpdate).toBe('function');
  });

  it('exposes the optional methods committed in the rc.1 plan', () => {
    expect(typeof provider.signMessage).toBe('function');
    expect(typeof provider.getAccount).toBe('function');
  });

  it('isConnected() returns false on a fresh instance', () => {
    expect(provider.isConnected()).toBe(false);
  });

  it('disconnect() is idempotent and resolves on a non-connected provider', async () => {
    await expect(provider.disconnect()).resolves.toBeUndefined();
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });
});
