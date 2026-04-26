import { describe, expect, it } from 'vitest';
import { ZoffProvider } from '../provider.js';
import { ZoffWalletError } from '../errors.js';
import { SUPPORTED_NETWORKS } from '../config.js';

describe('ZoffProvider.init() — network bind', () => {
  it('accepts mainnet (added in 0.1.0-rc.3)', async () => {
    const provider = new ZoffProvider();
    await expect(
      provider.init({ appName: 'test', network: 'mainnet' })
    ).resolves.toBeUndefined();
    expect(SUPPORTED_NETWORKS).toContain('mainnet');
    // Touch ZoffWalletError so the import isn't pruned now that the
    // mainnet-rejection assertion is gone.
    expect(ZoffWalletError.name).toBe('ZoffWalletError');
  });

  it('rejects testnet with INVALID_COMMAND in v0.1.x', async () => {
    const provider = new ZoffProvider();
    await expect(
      provider.init({ appName: 'test', network: 'testnet' })
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });

  it('accepts devnet', async () => {
    const provider = new ZoffProvider();
    await expect(
      provider.init({ appName: 'test', network: 'devnet' })
    ).resolves.toBeUndefined();
    expect(SUPPORTED_NETWORKS).toContain('devnet');
  });

  it('methods called before init() throw INVALID_COMMAND', async () => {
    const provider = new ZoffProvider();
    await expect(provider.connect()).rejects.toMatchObject({
      code: 'INVALID_COMMAND',
    });
  });

  it('methods that need a connection throw NOT_CONNECTED after init() but before connect()', async () => {
    const provider = new ZoffProvider();
    await provider.init({ appName: 'test', network: 'devnet' });
    await expect(provider.getHoldings()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    await expect(provider.getAccount!()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    await expect(
      provider.prepareTransfer({
        recipient: 'r',
        amount: '1',
        instrument: { instrumentAdmin: 'a', instrumentId: 'Amulet' },
      })
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
