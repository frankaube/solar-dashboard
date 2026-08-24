import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_NOTIFICATIONS, NotifierService } from '../src/alerts/notifier.service';

/*
  The log exists because `send` used to resolve a webhook and return early when there was
  none — which on a default install is always. Every notification was composed and dropped,
  including the sunset daily summary, which appears nowhere else in the app.

  So the test that carries the feature is the one where nothing is configured.
*/

function fakePrisma(settings: Record<string, string> = {}) {
  const rows: any[] = [];
  let nextId = 1;
  return {
    rows,
    setting: {
      findUnique: async ({ where }: any) =>
        settings[where.key] === undefined ? null : { key: where.key, value: settings[where.key] },
    },
    notification: {
      create: async ({ data }: any) => {
        const row = { id: nextId++, deliveredAt: null, error: null, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      findMany: async ({ skip = 0, take, orderBy }: any) => {
        const sorted = [...rows].sort((a, b) =>
          orderBy?.raisedAt === 'desc' ? +b.raisedAt - +a.raisedAt : +a.raisedAt - +b.raisedAt,
        );
        return sorted.slice(skip, take === undefined ? undefined : skip + take);
      },
      deleteMany: async ({ where }: any) => {
        for (const id of where.id.in) {
          const i = rows.findIndex((r) => r.id === id);
          if (i >= 0) rows.splice(i, 1);
        }
      },
    },
  };
}

const make = (settings?: Record<string, string>) => {
  const prisma = fakePrisma(settings);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma, notifier: new NotifierService(prisma as any) };
};

describe('with no webhook configured — the default install', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('records the notification instead of dropping it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { prisma, notifier } = make();
    await notifier.send('The array made 76.8 kWh today.', { title: '☀️ Solar day wrap' });

    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].body).toContain('76.8 kWh');
    expect(prisma.rows[0].title).toBe('☀️ Solar day wrap');
    // Nothing to send it to, so nothing was attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves both delivery columns null, which means nowhere to send it', async () => {
    /*
      Undelivered with no error is a distinct state from undelivered with one: the first
      is "you have not set up a webhook", the second is "your webhook is broken". Collapsing
      them would put a red mark against every install that simply reads the log.
    */
    const { prisma, notifier } = make();
    await notifier.send('anything');
    expect(prisma.rows[0].deliveredAt).toBeNull();
    expect(prisma.rows[0].error).toBeNull();
  });
});

describe('with a webhook', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('marks what got through', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const { prisma, notifier } = make({ notifyWebhookUrl: 'solar-topic' });
    await notifier.send('hello');
    expect(prisma.rows[0].deliveredAt).not.toBeNull();
    expect(prisma.rows[0].error).toBeNull();
  });

  it('keeps the reason against the row when delivery fails', async () => {
    /*
      A webhook that has returned 404 for a fortnight is otherwise invisible — every alert
      looks raised, the phone is simply silent, and nothing connects the two.
    */
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);
    const { prisma, notifier } = make({ notifyWebhookUrl: 'gone' });
    await notifier.send('hello');
    expect(prisma.rows[0].deliveredAt).toBeNull();
    expect(prisma.rows[0].error).toContain('404');
  });

  it('still records when the network throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const { prisma, notifier } = make({ notifyWebhookUrl: 'https://example.invalid/hook' });
    await notifier.send('hello');
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].error).toContain('ENOTFOUND');
  });
});

describe('history', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('comes back newest first', async () => {
    const { notifier } = make();
    await notifier.send('first');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await notifier.send('second');
    const rows = await notifier.history(10);
    expect(rows[0].body).toBe('second');
    expect(rows[1].body).toBe('first');
  });

  it('will not hand back more than it keeps, whatever it is asked for', async () => {
    const { notifier } = make();
    await notifier.send('one');
    expect(await notifier.history(10_000)).toHaveLength(1);
    // A nonsense limit must not become an unbounded query against the table.
    expect((await notifier.history(0)).length).toBeLessThanOrEqual(KEEP_NOTIFICATIONS);
  });
});
