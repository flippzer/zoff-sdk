/**
 * Tests for `ZoffProvider.withTestingTransport({autoApprove: true})` —
 * the headless CI smoke harness for the popup-approval flows.
 *
 * Mock fetch globally so the HTTPS-direct routes (`prepareTransfer`,
 * `getHoldings`, `getActiveContracts`) don't actually reach out — the
 * point of these tests is the popup transport, not the HTTP layer
 * (covered by `http.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoffProvider } from '../provider.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ZoffProvider.withTestingTransport — connect', () => {
  it('auto-approves connect with default fixtures', async () => {
    const provider = ZoffProvider.withTestingTransport({ autoApprove: true });
    await provider.init({ appName: 'test', network: 'devnet' });

    const result = await provider.connect();

    expect(result.partyId).toMatch(/^TestParty::1220.*test$/);
    expect(result.authToken).toBe('test-auth-token');
    expect(provider.isConnected()).toBe(true);
    expect(provider.partyId).toBe(result.partyId);
  });

  it('auto-approves connect with custom party fixture', async () => {
    const provider = ZoffProvider.withTestingTransport({
      autoApprove: true,
      party: {
        partyId: 'CustomParty::1220custom',
        authToken: 'custom-jwt',
      },
    });
    await provider.init({ appName: 'test', network: 'devnet' });

    const result = await provider.connect();

    expect(result.partyId).toBe('CustomParty::1220custom');
    expect(result.authToken).toBe('custom-jwt');
  });

  it('the response network matches init({network}) — no NETWORK_MISMATCH from fixture', async () => {
    // The fake auto-approve window dispatches with the same network the
    // SDK was initialized with, so the `response.network !== this._network`
    // guard never trips. This test pins that.
    const provider = ZoffProvider.withTestingTransport({ autoApprove: true });
    await provider.init({ appName: 'test', network: 'devnet' });
    await expect(provider.connect()).resolves.toBeDefined();
  });
});

describe('ZoffProvider.withTestingTransport — submit', () => {
  it('auto-approves submitAndWaitForTransaction with default fixtures', async () => {
    const provider = ZoffProvider.withTestingTransport({ autoApprove: true });
    await provider.init({ appName: 'test', network: 'devnet' });
    await provider.connect();

    const result = await provider.submitAndWaitForTransaction({
      commands: [{ create: { templateId: 'T', createArguments: {} } }],
      actAs: provider.partyId!,
    });

    expect(result.updateId).toBe('test-transaction-id');
    expect(result.completionOffset).toBe('1');
  });

  it('auto-approves submitTransaction and emits a synthetic COMMITTED update', async () => {
    const provider = ZoffProvider.withTestingTransport({
      autoApprove: true,
      submit: { transactionId: 'specific-test-id', completionOffset: 99 },
    });
    await provider.init({ appName: 'test', network: 'devnet' });
    await provider.connect();

    const updates: Array<{
      readonly commandId: string;
      readonly submissionId: string;
      readonly status?: string;
    }> = [];
    provider.onTransactionUpdate((u) => updates.push(u));

    const { submissionId } = await provider.submitTransaction({
      commands: [{ exercise: { templateId: 'T', contractId: 'c', choice: 'X', choiceArgument: {} } }],
      actAs: provider.partyId!,
    });

    expect(submissionId).toBe('specific-test-id');
    // queueMicrotask drain
    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe('COMMITTED');
    expect(updates[0]?.submissionId).toBe('specific-test-id');
  });

  it('still rejects empty commands with INVALID_COMMAND', async () => {
    // Auto-approve doesn't bypass canonical-contract validation —
    // the empty-commands check runs in the SDK before the popup ever
    // opens.
    const provider = ZoffProvider.withTestingTransport({ autoApprove: true });
    await provider.init({ appName: 'test', network: 'devnet' });
    await provider.connect();

    await expect(
      provider.submitTransaction({ commands: [], actAs: provider.partyId! })
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });
});

describe('ZoffProvider.withTestingTransport — signMessage', () => {
  it('auto-approves signMessage with default signature', async () => {
    const provider = ZoffProvider.withTestingTransport({ autoApprove: true });
    await provider.init({ appName: 'test', network: 'devnet' });
    await provider.connect();

    const { signature } = await provider.signMessage!('hello');
    expect(signature).toBe('00'.repeat(64));
  });

  it('auto-approves signMessage with custom signature fixture', async () => {
    const provider = ZoffProvider.withTestingTransport({
      autoApprove: true,
      sign: { signature: 'deadbeef' },
    });
    await provider.init({ appName: 'test', network: 'devnet' });
    await provider.connect();

    const { signature } = await provider.signMessage!('hello');
    expect(signature).toBe('deadbeef');
  });
});

describe('ZoffProvider.withTestingTransport — full canonical flow against mocked fetch', () => {
  beforeEach(() => {
    // Mock the HTTPS-direct routes (prepareTransfer hits /sdk/build-transfer-commands).
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/sdk/build-transfer-commands')) {
        return new Response(
          JSON.stringify({
            commands: [{ create: { templateId: 'T', createArguments: {} } }],
            disclosedContracts: [],
            synchronizerId: 'sync',
            actAs: 'TestParty::1220...test',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/sdk/holdings/')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in test: ${u}`);
    }) as typeof fetch;
  });

  it('runs init → connect → getHoldings → prepareTransfer → submit end-to-end with no popup', async () => {
    const provider = ZoffProvider.withTestingTransport({ autoApprove: true });
    await provider.init({ appName: 'ci-smoke', network: 'devnet' });

    const { partyId } = await provider.connect();
    expect(partyId).toBeDefined();

    const holdings = await provider.getHoldings();
    expect(Array.isArray(holdings)).toBe(true);

    const prepared = await provider.prepareTransfer({
      recipient: 'Recipient::1220x',
      amount: '1.0',
      instrument: { instrumentAdmin: 'DSO::1220y', instrumentId: 'Amulet' },
    });
    expect(prepared.synchronizerId).toBe('sync');

    const result = await provider.submitAndWaitForTransaction(prepared);
    expect(result.updateId).toBe('test-transaction-id');
  });
});
