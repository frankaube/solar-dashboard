import { describe, expect, it } from 'vitest';
import {
  DESTINATION_KINDS,
  extractS3Error,
  findDestinationKind,
  parseListObjects,
} from '../src/backup/destinations';
import { BackupService, stamp } from '../src/backup/backup.service';

/** Just enough Prisma for the settings reads and writes the service does. */
function fakePrisma(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        rows.set(where.key, update.value);
        return { key: where.key, value: update.value };
      },
    },
  };
}

describe('the destination registry', () => {
  it('offers a local folder, an S3-compatible store and Google Drive', () => {
    expect(DESTINATION_KINDS.map((d) => d.id).sort()).toEqual(['gdrive', 'local', 's3']);
  });

  it('builds nothing from an empty config, so a blank form cannot half-configure', () => {
    for (const kind of DESTINATION_KINDS) {
      expect(kind.create({}), kind.id).toBeNull();
    }
  });

  it('requires every S3 credential, not just some of them', () => {
    const s3 = findDestinationKind('s3')!;
    const full = {
      endpoint: 'https://s3.example.com',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
    };
    expect(s3.create(full)).not.toBeNull();
    for (const missing of Object.keys(full)) {
      const partial = { ...full, [missing]: '' };
      expect(s3.create(partial), `missing ${missing}`).toBeNull();
    }
  });

  it('adds the trailing slash a prefix needs', () => {
    /*
      Without it, prefix "solar" turns key "solar-2026.db" into "solarsolar-2026.db" —
      the backup uploads fine, lands somewhere unexpected, and the retention listing
      then never matches it, so nothing is ever pruned.
    */
    const s3 = findDestinationKind('s3')!;
    const dest = s3.create({
      endpoint: 'https://s3.example.com',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      prefix: 'solar',
    })!;
    expect(dest.describe()).toBe('b/solar');
  });

  it('accepts an absent prefix', () => {
    const s3 = findDestinationKind('s3')!;
    const dest = s3.create({
      endpoint: 'https://s3.example.com',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })!;
    expect(dest.describe()).toBe('b');
  });

  it('gives every field a label, since the UI renders them blind', () => {
    for (const kind of DESTINATION_KINDS) {
      for (const field of kind.fields) {
        expect(field.label, `${kind.id}.${field.key}`).toBeTruthy();
      }
    }
  });
});

describe('parseListObjects', () => {
  const xml = `<?xml version="1.0"?><ListBucketResult>
    <Contents><Key>solar/solar-20260728-0300.db</Key><Size>5275648</Size>
      <LastModified>2026-07-28T03:00:00.000Z</LastModified></Contents>
    <Contents><Key>solar/solar-20260729-0300.db</Key><Size>5300000</Size>
      <LastModified>2026-07-29T03:00:00.000Z</LastModified></Contents>
    <Contents><Key>solar/notes.txt</Key><Size>12</Size>
      <LastModified>2026-07-27T03:00:00.000Z</LastModified></Contents>
  </ListBucketResult>`;

  it('reads names, sizes and dates', () => {
    const found = parseListObjects(xml, 'solar/');
    expect(found).toHaveLength(2);
    expect(found[0].name).toBe('solar-20260729-0300.db');
    expect(found[0].sizeBytes).toBe(5300000);
  });

  it('returns newest first, because retention deletes from the end', () => {
    /*
      Sorted the wrong way, pruning would delete the newest backups and keep the
      oldest — and would look like it was working right up until a restore.
    */
    const found = parseListObjects(xml, 'solar/');
    expect(found[0].modifiedAt.getTime()).toBeGreaterThan(found[1].modifiedAt.getTime());
  });

  it('ignores files that are not ours', () => {
    // Someone else's bucket contents must never be candidates for deletion.
    expect(parseListObjects(xml, 'solar/').map((f) => f.name)).not.toContain('notes.txt');
  });

  it('handles an empty listing', () => {
    expect(parseListObjects('<ListBucketResult></ListBucketResult>', 'solar/')).toEqual([]);
  });
});

describe('extractS3Error', () => {
  it('pulls the message out of the XML a store returns', () => {
    const body = `<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>`;
    expect(extractS3Error(body)).toBe(
      'SignatureDoesNotMatch: The request signature we calculated does not match',
    );
  });

  it('falls back to the raw body rather than swallowing it', () => {
    // "HTTP 403" alone leaves an owner nothing to act on.
    expect(extractS3Error('something unexpected')).toBe('something unexpected');
  });
});

describe('stored credentials', () => {
  const stored = {
    'backup.enabled': 's3',
    'backup.s3.endpoint': 'https://s3.example.com',
    'backup.s3.bucket': 'solar',
    'backup.s3.accessKeyId': 'AKIASTORED',
    'backup.s3.secretAccessKey': 'shhh',
  };
  it('keeps a secret the form left blank', async () => {
    /*
      Editing the bucket name and pressing Save must not wipe the access key. The UI
      cannot resend a secret it was never given, so a blank one means "unchanged" — and
      treating it as "" would break the destination on the next scheduled run, hours
      after the edit that caused it.
    */
    const prisma = fakePrisma({ ...stored });
    const service = new BackupService(prisma as never);
    await service.saveConfig({
      enabled: ['s3'],
      configs: { s3: { bucket: 'other', secretAccessKey: '' } },
      schedule: 'daily',
      keep: 14,
    });
    expect(prisma.rows.get('backup.s3.secretAccessKey')).toBe('shhh');
    expect(prisma.rows.get('backup.s3.bucket')).toBe('other');
  });

  it('does replace a secret that was actually retyped', async () => {
    const prisma = fakePrisma({ ...stored });
    const service = new BackupService(prisma as never);
    await service.saveConfig({
      enabled: ['s3'],
      configs: { s3: { secretAccessKey: 'rotated' } },
      schedule: 'daily',
      keep: 14,
    });
    expect(prisma.rows.get('backup.s3.secretAccessKey')).toBe('rotated');
  });

  it('reports secrets as set without ever returning them', async () => {
    // The response goes to a browser. It may say a key exists; it may not say what it is.
    const service = new BackupService(fakePrisma({ ...stored }) as never);
    const config = await service.config();
    expect(config.kinds.s3.secretsSet.secretAccessKey).toBe(true);
    expect(JSON.stringify(config)).not.toContain('shhh');
    expect(config.kinds.s3.values.bucket).toBe('solar');
  });

  it('tests a saved destination without making you retype the key', async () => {
    // Pointed at a closed local port so the call fails instantly and offline: what is
    // under test is that it got as far as trying, not what the store answered.
    const prisma = fakePrisma({ ...stored, 'backup.s3.endpoint': 'http://127.0.0.1:1' });
    const service = new BackupService(prisma as never);
    const result = await service.test('s3', { bucket: 'solar' });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBe('Missing required fields');
    expect(result.error).toMatch(/ECONNREFUSED|connect/i);
  });

  it('still refuses a destination with nothing stored and nothing typed', async () => {
    const service = new BackupService(fakePrisma() as never);
    expect(await service.test('s3', {})).toEqual({ ok: false, error: 'Missing required fields' });
  });

  it('clamps retention rather than accepting zero', async () => {
    // keep=0 would prune every backup immediately after writing one.
    const prisma = fakePrisma();
    const service = new BackupService(prisma as never);
    await service.saveConfig({
      enabled: ['local'],
      configs: { local: { dir: '/backups' } },
      schedule: 'daily',
      keep: 0,
    });
    expect(prisma.rows.get('backup.keep')).toBe('1');
  });
});

describe('more than one destination', () => {
  it('keeps a pre-upgrade single destination switched on', async () => {
    /*
      Older installs stored one `backup.kind`. Reading the new list and finding nothing
      would switch backups off at the exact moment someone upgraded — the worst possible
      way to learn this feature changed shape.
    */
    const service = new BackupService(fakePrisma({ 'backup.kind': 'local' }) as never);
    expect(await service.enabledKinds()).toEqual(['local']);
  });

  it('prefers the explicit list once one has been saved', async () => {
    const service = new BackupService(
      fakePrisma({ 'backup.kind': 'local', 'backup.enabled': 's3,gdrive' }) as never,
    );
    expect(await service.enabledKinds()).toEqual(['s3', 'gdrive']);
  });

  it('can be switched off entirely without falling back to the old value', async () => {
    // An empty list is a decision, not an absence — it must not resurrect backup.kind.
    const service = new BackupService(
      fakePrisma({ 'backup.kind': 'local', 'backup.enabled': '' }) as never,
    );
    expect(await service.enabledKinds()).toEqual([]);
  });

  it('drops a destination the registry no longer knows', async () => {
    const service = new BackupService(fakePrisma({ 'backup.enabled': 'local,dropbox' }) as never);
    expect(await service.enabledKinds()).toEqual(['local']);
  });

  it('keeps the run state of each destination apart', async () => {
    /*
      The whole point of two destinations is that they fail independently. Sharing one
      timestamp would mean a card that succeeded stopped a bucket that failed from
      retrying — or worse, the reverse.
    */
    const prisma = fakePrisma({
      'backup.state.local.lastOk': '1',
      'backup.state.local.lastAttemptAt': '2026-07-29T06:00:00.000Z',
      'backup.state.s3.lastOk': '0',
      'backup.state.s3.lastError': 'bucket unreachable',
      'backup.state.s3.lastAttemptAt': '2026-07-29T06:00:01.000Z',
      'backup.enabled': 'local,s3',
      'backup.local.dir': '/backups',
      'backup.s3.endpoint': 'http://127.0.0.1:1',
      'backup.s3.bucket': 'b',
      'backup.s3.accessKeyId': 'k',
      'backup.s3.secretAccessKey': 's',
    });
    const status = await new BackupService(prisma as never).status();
    const local = status.destinations.find((d) => d.kind === 'local')!;
    const s3 = status.destinations.find((d) => d.kind === 's3')!;
    expect(local.lastOk).toBe(true);
    expect(local.lastError).toBeNull();
    expect(s3.lastOk).toBe(false);
    expect(s3.lastError).toBe('bucket unreachable');
  });
});

describe('backup filenames', () => {
  it('sort chronologically as plain strings', () => {
    /*
      Retention and listing both rely on ordering. A format that sorts wrong would
      prune the wrong files, so the stamp is year-first and zero-padded.
    */
    const a = stamp(new Date('2026-07-28T18:00:00Z'));
    const b = stamp(new Date('2026-07-29T18:00:00Z'));
    const c = stamp(new Date('2026-08-01T18:00:00Z'));
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it('uses local time, so the name matches the day its owner would call it', () => {
    // 01:30Z on the 16th is still the evening of the 15th at UTC-4.
    expect(stamp(new Date('2026-07-16T01:30:00Z'))).toMatch(/^20260715-/);
  });

  it('never emits hour 24', () => {
    // Some ICU builds render midnight as "24", which would sort after 23 on the
    // wrong day and read as nonsense in a filename.
    expect(stamp(new Date('2026-07-15T03:00:00Z'))).toMatch(/-00\d\d$/);
  });
});
