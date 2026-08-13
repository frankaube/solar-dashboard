import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  driveAuthUrl,
  driveRedirectUri,
  extractGoogleError,
} from '../src/backup/google-drive';
import { findDestinationKind } from '../src/backup/destinations';
import { BackupService } from '../src/backup/backup.service';

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

describe('the Drive consent URL', () => {
  const url = new URL(driveAuthUrl('client-1', driveRedirectUri(8080), 'nonce-1'));
  const param = (key: string): string | null => url.searchParams.get(key);

  it('asks for offline access, or there is no refresh token to schedule with', () => {
    expect(param('access_type')).toBe('offline');
  });

  it('forces the consent screen on every connect', () => {
    /*
      Without prompt=consent, authorising a second time returns an access token and no
      refresh token — the destination then works for one hour and cannot renew itself.
    */
    expect(param('prompt')).toBe('consent');
  });

  it('requests only drive.file', () => {
    // Per-file access: the app sees nothing in Drive it did not create, so a retention
    // prune has no way to reach anything else. It is also a non-sensitive scope, which
    // is what keeps this out of Google's verification review.
    expect(param('scope')).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('carries the nonce and the exact redirect back', () => {
    expect(param('state')).toBe('nonce-1');
    expect(param('redirect_uri')).toBe('http://localhost:8080/api/backup/oauth/google/callback');
  });

  it('points the redirect at loopback, which is the only http Google accepts', () => {
    expect(driveRedirectUri(3001)).toMatch(/^http:\/\/localhost:3001\//);
  });
});

describe('extractGoogleError', () => {
  it('explains invalid_grant instead of repeating it', () => {
    /*
      This is the seven-day Testing-mode expiry, and it is the single most likely way for
      a Drive backup to stop. "invalid_grant" tells an owner nothing; naming the cause and
      the fix turns a dead destination into a two-minute console change.
    */
    const message = extractGoogleError(
      400,
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired' }),
    );
    expect(message).toContain('Testing');
    expect(message).toContain('7 days');
  });

  it('reads the OAuth endpoint error shape', () => {
    expect(
      extractGoogleError(401, JSON.stringify({ error: 'invalid_client', error_description: 'bad' })),
    ).toBe('invalid_client: bad');
  });

  it('reads the Drive endpoint error shape', () => {
    expect(
      extractGoogleError(403, JSON.stringify({ error: { code: 403, message: 'Rate exceeded' } })),
    ).toBe('Rate exceeded');
  });

  it('falls back to the body rather than inventing a reason', () => {
    expect(extractGoogleError(502, '<html>bad gateway</html>')).toContain('bad gateway');
  });
});

describe('the Drive destination', () => {
  const gdrive = findDestinationKind('gdrive')!;

  it('is not usable until it has been authorised', () => {
    // Client ID and secret alone are a configured app, not a connected account.
    expect(gdrive.create({ clientId: 'a', clientSecret: 'b' })).toBeNull();
    expect(gdrive.create({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' })).not.toBeNull();
  });

  it('hides the field the connect flow writes, so the form cannot show a blank for it', () => {
    const token = gdrive.fields.find((f) => f.key === 'refreshToken')!;
    expect(token.hidden).toBe(true);
    expect(token.secret).toBe(true);
  });

  it('names a folder when none was given', () => {
    const dest = gdrive.create({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' })!;
    expect(dest.describe()).toContain('Solar Dashboard backups');
  });
});

describe('the connect flow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('will not start without an OAuth client saved', async () => {
    const service = new BackupService(fakePrisma() as never);
    await expect(service.driveAuthUrl(driveRedirectUri(8080))).rejects.toThrow(/client ID/i);
  });

  it('refuses a callback whose nonce it never issued', async () => {
    /*
      The callback is a GET, so the API token guard does not cover it. The nonce is what
      stops an unsolicited callback from writing a token — pointing the backups at
      somebody else's Drive.
    */
    const service = new BackupService(
      fakePrisma({
        'backup.gdrive.clientId': 'a',
        'backup.gdrive.clientSecret': 'b',
      }) as never,
    );
    await expect(service.driveCallback('code', 'never-issued', 'http://x')).rejects.toThrow(
      /expired/i,
    );
  });

  it('spends a nonce once', async () => {
    const prisma = fakePrisma({
      'backup.gdrive.clientId': 'a',
      'backup.gdrive.clientSecret': 'b',
    });
    const service = new BackupService(prisma as never);
    const state = new URL(await service.driveAuthUrl('http://x')).searchParams.get('state')!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ refresh_token: 'rt-1' }), { status: 200 })),
    );

    await service.driveCallback('code', state, 'http://x');
    expect(prisma.rows.get('backup.gdrive.refreshToken')).toBe('rt-1');

    // Replaying the same callback must not be able to overwrite it.
    await expect(service.driveCallback('code', state, 'http://x')).rejects.toThrow(/expired/i);
  });

  it('drops the authorisation when the OAuth client is swapped', async () => {
    /*
      A refresh token belongs to the client that issued it. Keeping it across a client
      change leaves a destination that reads as connected and dies at 3 AM.
    */
    const prisma = fakePrisma({
      'backup.gdrive.clientId': 'old-client',
      'backup.gdrive.clientSecret': 'b',
      'backup.gdrive.refreshToken': 'rt-old',
    });
    const service = new BackupService(prisma as never);
    await service.saveConfig({
      enabled: ['gdrive'],
      configs: { gdrive: { clientId: 'new-client' } },
      schedule: 'daily',
      keep: 14,
    });
    expect(prisma.rows.get('backup.gdrive.refreshToken')).toBe('');
  });

  it('keeps the authorisation when only the folder is renamed', async () => {
    const prisma = fakePrisma({
      'backup.gdrive.clientId': 'same',
      'backup.gdrive.clientSecret': 'b',
      'backup.gdrive.refreshToken': 'rt-keep',
    });
    const service = new BackupService(prisma as never);
    await service.saveConfig({
      enabled: ['gdrive'],
      configs: { gdrive: { clientId: 'same', folder: 'Elsewhere' } },
      schedule: 'daily',
      keep: 14,
    });
    expect(prisma.rows.get('backup.gdrive.refreshToken')).toBe('rt-keep');
  });
});
