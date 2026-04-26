import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../transport/http.js';
import { ZoffWalletError } from '../errors.js';

function makeClient(fetchImpl: typeof fetch, token: string | null = 'tok-123'): HttpClient {
  return new HttpClient({
    backendOrigin: 'https://api.test',
    authToken: () => token,
    fetchImpl,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpClient — WalletError mapping', () => {
  it('maps 401 → NOT_CONNECTED', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { error: 'no token', code: 'UNAUTHORIZED' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      message: 'no token',
    });
  });

  it('maps 429 → RATE_LIMITED', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(429, { error: 'slow down' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps 408 → TIMEOUT', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(408, { error: 'request timeout' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('maps 504 → TIMEOUT', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(504, { error: 'gateway timeout' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('maps 400 → INVALID_COMMAND', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(400, { error: 'bad payload' }));
    const client = makeClient(fetchMock);
    await expect(client.post('/x', {})).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });

  it('maps backendCode INVALID_ARGUMENT → INVALID_COMMAND even on non-400', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(422, { error: 'bad', code: 'INVALID_ARGUMENT' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });

  it('maps 500 → VALIDATOR_ERROR', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { error: 'kaboom' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'VALIDATOR_ERROR' });
  });

  it('maps 503 → VALIDATOR_ERROR', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'VALIDATOR_ERROR' });
  });

  it('maps 418 (unhandled) → UNKNOWN', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(418, { error: 'teapot' }));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'UNKNOWN' });
  });

  it('maps fetch rejection → VALIDATOR_ERROR', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('network down'));
    const client = makeClient(fetchMock);
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'VALIDATOR_ERROR',
      message: expect.stringContaining('network down'),
    });
  });

  it('preserves backendCode + status in details', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(429, { error: 'slow', code: 'RATE_LIMIT' }));
    const client = makeClient(fetchMock);
    try {
      await client.get('/abc');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZoffWalletError);
      const e = err as ZoffWalletError;
      expect(e.details).toEqual({
        backendStatus: 429,
        path: '/abc',
        backendCode: 'RATE_LIMIT',
      });
    }
  });

  it('parses 2xx body as JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { ok: true, value: 42 }));
    const client = makeClient(fetchMock);
    const result = await client.get<{ ok: boolean; value: number }>('/x');
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('attaches Bearer token when authToken returns a string', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, {}));
    const client = makeClient(fetchMock, 'jwt-abc');
    await client.get('/x');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt-abc');
  });

  it('omits Authorization header when authToken returns null', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, {}));
    const client = makeClient(fetchMock, null);
    await client.get('/x');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });
});
