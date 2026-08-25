import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PvoutputService } from '../src/pvoutput/pvoutput.service';

/*
  Consent rules and failure handling, not the HTTP: this is the only part of the app that
  sends data to a third-party server.
*/

/** A settings table that behaves like the real one, in a Map. */
function fakePrisma(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      upsert: async ({ where, create, update }: any) => {
        rows.set(where.key, (rows.has(where.key) ? update : create).value);
      },
      // Prisma accepts both `{ key: 'x' }` and `{ key: { in: [...] } }`; the fake must too,
      // or callers using the simpler form fail inside the fake.
      deleteMany: async ({ where }: { where: { key: string | { in: string[] } } }) => {
        const keys = typeof where.key === 'string' ? [where.key] : where.key.in;
        for (const key of keys) rows.delete(key);
      },
    },
    dtuReading: { aggregate: async () => ({ _max: { dailyEnergy: 0, totalPower: 0 } }) },
  };
}

const snapshot = {
  takenAt: new Date(),
  totalPower: 10_450,
  dailyEnergyWh: 41_200,
};

const make = (seed: Record<string, string> = {}, snap: unknown = snapshot) => {
  const prisma = fakePrisma(seed);
  const collector = { getLastSnapshot: () => snap };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma, service: new PvoutputService(prisma as any, collector as any) };
};

describe('consent', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends nothing at all by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service } = make();
    const result = await service.testUpload();
    expect(result.ok).toBe(false);
    // The assertion that matters in this whole file.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends nothing when credentials exist but the switch is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service } = make({ 'pvoutput.apiKey': 'k', 'pvoutput.systemId': '1' });
    await service.testUpload();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to switch on without credentials', async () => {
    // Not a safety gate — nothing would be sent either way. Enabled with no key leaves the
    // switch reading "uploading" while nothing is.
    const { service } = make();
    await expect(service.save({ enabled: true })).rejects.toThrow(/API key/i);
    expect((await service.status()).enabled).toBe(false);
  });

  it('allows switching on once a key and id are stored', async () => {
    const { service } = make();
    await service.save({ apiKey: 'k', systemId: '1' });
    await service.save({ enabled: true });
    const status = await service.status();
    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
  });
});

describe('the key', () => {
  it('never comes back out', async () => {
    const { service } = make({
      'pvoutput.apiKey': 'super-secret-key',
      'pvoutput.systemId': '4242',
      'pvoutput.enabled': '1',
    });
    const status = await service.status();
    // Not masked, not truncated — absent. Serialised so a nested field cannot hide one.
    expect(JSON.stringify(status)).not.toContain('super-secret-key');
    expect(status.configured).toBe(true);
    // The system id is not a secret and the UI needs it to render the field.
    expect(status.systemId).toBe('4242');
  });

  it('treats a blank key as leave it alone, not as delete it', async () => {
    // The field renders empty because status never returns the secret, so treating empty as
    // a deletion would wipe the key on every Save.
    const { prisma, service } = make({ 'pvoutput.apiKey': 'keep-me', 'pvoutput.systemId': '1' });
    await service.save({ apiKey: '', systemId: '' });
    expect(prisma.rows.get('pvoutput.apiKey')).toBe('keep-me');
  });

  it('forgets both credentials and switches off when asked', async () => {
    const { prisma, service } = make({
      'pvoutput.apiKey': 'k',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.forget();
    expect(prisma.rows.has('pvoutput.apiKey')).toBe(false);
    expect(prisma.rows.has('pvoutput.systemId')).toBe(false);
    expect((await service.status()).enabled).toBe(false);
  });
});

describe('failure handling', () => {
  beforeEach(() => vi.restoreAllMocks());

  const respond = (status: number, body: string) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status,
      headers: { get: () => null },
      text: async () => body,
    } as unknown as Response);

  it('switches itself off on a rejected key, and keeps saying why', async () => {
    // `post` disables the uploader through `save`, so `save` must not clear the error on its
    // way out: the reason has to survive the shutdown.
    respond(401, 'Unauthorized: Invalid System ID');
    const { service } = make({
      'pvoutput.apiKey': 'wrong',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    const result = await service.testUpload();
    expect(result.ok).toBe(false);
    const status = await service.status();
    expect(status.enabled).toBe(false);
    expect(status.lastError).toContain('key or system id');
  });

  it('stays on through a transient failure', async () => {
    respond(503, 'Service Unavailable');
    const { service } = make({
      'pvoutput.apiKey': 'k',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.testUpload();
    const status = await service.status();
    expect(status.enabled).toBe(true);
    expect(status.lastError).toContain('Service Unavailable');
  });

  it('clears the old failure when a new key is entered', async () => {
    respond(401, 'Unauthorized');
    const { service } = make({
      'pvoutput.apiKey': 'wrong',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.testUpload();
    expect((await service.status()).lastError).not.toBeNull();
    await service.save({ apiKey: 'a-better-key' });
    expect((await service.status()).lastError).toBeNull();
  });

  it('says so rather than sending when there is no reading yet', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service } = make(
      { 'pvoutput.apiKey': 'k', 'pvoutput.systemId': '1', 'pvoutput.enabled': '1' },
      null,
    );
    const result = await service.testUpload();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No reading');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('state that survives a restart', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** A second service over the SAME settings table — exactly what a restart is. */
  const restart = (prisma: unknown, snap: unknown = snapshot) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new PvoutputService(prisma as any, { getLastSnapshot: () => snap } as any);

  const ok = () =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      headers: { get: (n: string) => (n === 'X-Rate-Limit-Remaining' ? '47' : null) },
      text: async () => 'OK 200: Added Status',
    } as unknown as Response);

  it('remembers that it has uploaded', async () => {
    ok();
    const { prisma, service } = make({
      'pvoutput.apiKey': 'k',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.testUpload();
    expect((await service.status()).lastUploadAt).not.toBeNull();

    const next = restart(prisma);
    await next.onModuleInit();
    expect((await next.status()).lastUploadAt).not.toBeNull();
  });

  it('remembers the quota, so a restart loop cannot spend freely', async () => {
    // `maySpend` returns true on a null remaining, so a quota lost at boot leaves a restart
    // loop free to spend.
    ok();
    const { prisma, service } = make({
      'pvoutput.apiKey': 'k',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.testUpload();
    expect((await service.status()).rateRemaining).toBe(47);

    const next = restart(prisma);
    await next.onModuleInit();
    expect((await next.status()).rateRemaining).toBe(47);
  });

  it('remembers why it switched itself off', async () => {
    // The card is the only place a rejected key can be fixed, so the reason must survive a
    // restart or the switch is off for no stated reason.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 401,
      headers: { get: () => null },
      text: async () => 'Unauthorized: Invalid System ID',
    } as unknown as Response);
    const { prisma, service } = make({
      'pvoutput.apiKey': 'wrong',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.testUpload();

    const next = restart(prisma);
    await next.onModuleInit();
    const status = await next.status();
    expect(status.enabled).toBe(false);
    expect(status.lastError).toContain('key or system id');
  });

  it('does not resurrect a complaint about credentials that were forgotten', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 401,
      headers: { get: () => null },
      text: async () => 'Unauthorized',
    } as unknown as Response);
    const { prisma, service } = make({
      'pvoutput.apiKey': 'wrong',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.testUpload();
    await service.forget();

    const next = restart(prisma);
    await next.onModuleInit();
    expect((await next.status()).lastError).toBeNull();
  });

  it('clears the stored failure when a new key is entered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 401,
      headers: { get: () => null },
      text: async () => 'Unauthorized',
    } as unknown as Response);
    const { prisma, service } = make({
      'pvoutput.apiKey': 'wrong',
      'pvoutput.systemId': '1',
      'pvoutput.enabled': '1',
    });
    await service.testUpload();
    await service.save({ apiKey: 'a-better-key' });

    const next = restart(prisma);
    await next.onModuleInit();
    expect((await next.status()).lastError).toBeNull();
  });
});
