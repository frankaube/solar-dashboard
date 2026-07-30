import { BackupDestination, StoredBackup } from './destinations';

/**
 * Google Drive as a backup destination.
 *
 * Three things about Drive's API shape drive this whole file, and each of them is a
 * silent-failure mode if ignored:
 *
 * 1. Uploads must be resumable. The `multipart` upload type is capped at 5 MB and the
 *    database passed that months ago, so the simple path would have worked in testing
 *    and then started failing on its own as the install aged.
 * 2. Refresh tokens die after seven days while the OAuth consent screen sits in
 *    "Testing". That produces a destination that works all week and quietly stops —
 *    which is why `invalid_grant` gets its own message rather than a raw API error.
 * 3. The scope is `drive.file`: the app can only see files it created itself. That is
 *    both the least alarming thing to ask a user for and a hard guarantee that a
 *    retention prune cannot reach anything else in their Drive.
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const BACKUP_PREFIX = 'solar-';

export const DEFAULT_DRIVE_FOLDER = 'Solar Dashboard backups';

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folder: string;
}

/**
 * The redirect Google will send the browser back to.
 *
 * Loopback only, and not because we chose it: Google requires https for every redirect
 * URI except localhost, and rejects raw IP addresses. So this cannot be
 * `http://10.0.0.5:8080/...` however the dashboard is normally reached — connecting has
 * to happen from the machine running the app, or through a tunnel to it.
 */
export function driveRedirectUri(port: number | string): string {
  return `http://localhost:${port}/api/backup/oauth/google/callback`;
}

export function driveAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    /*
      `offline` asks for a refresh token; `consent` forces the consent screen even on a
      re-connect. Without the second one Google returns only an access token the second
      time you authorise, and the destination would work for an hour and then break with
      no refresh token to recover from.
    */
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Pull the useful sentence out of Google's error shapes — there are two of them. */
export function extractGoogleError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string; errors?: Array<{ message?: string }> };
      error_description?: string;
    };
    const error = parsed.error;
    if (typeof error === 'string') {
      // The OAuth endpoint's shape: {"error":"invalid_grant","error_description":"..."}
      if (error === 'invalid_grant') {
        return 'Google rejected the saved authorisation (invalid_grant). This is what happens when the OAuth consent screen is still in "Testing" — those tokens are revoked after 7 days. Publish it to Production, then reconnect.';
      }
      return parsed.error_description ? `${error}: ${parsed.error_description}` : error;
    }
    // The Drive endpoints' shape: {"error":{"code":403,"message":"..."}}
    if (error?.message) return error.message;
  } catch {
    // Not JSON. Fall through to the raw body, which beats inventing a reason.
  }
  return `HTTP ${status} ${body.slice(0, 200)}`;
}

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(extractGoogleError(response.status, text));
  return JSON.parse(text);
}

/** Swap the one-time code from the callback for a long-lived refresh token. */
export async function exchangeCodeForRefreshToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const token = (await postForm(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })) as { refresh_token?: string };
  if (!token.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.',
    );
  }
  return token.refresh_token;
}

export class GoogleDriveDestination implements BackupDestination {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private folderId: string | null = null;

  constructor(private readonly cfg: DriveConfig) {}

  describe(): string {
    return `Google Drive · ${this.cfg.folder}`;
  }

  private async token(): Promise<string> {
    // 60 s of headroom: a token that expires mid-upload fails the whole 5 MB transfer.
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const refreshed = (await postForm(TOKEN_URL, {
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.cfg.refreshToken,
      grant_type: 'refresh_token',
    })) as { access_token: string; expires_in: number };
    this.accessToken = refreshed.access_token;
    this.accessTokenExpiresAt = Date.now() + refreshed.expires_in * 1000;
    return this.accessToken;
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await this.token()}` },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(extractGoogleError(response.status, text));
    return text ? JSON.parse(text) : null;
  }

  /**
   * The folder id, found or created.
   *
   * Under `drive.file` the search only ever sees folders this app created, so a user's
   * unrelated folder of the same name is invisible here and can never be written into.
   */
  private async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const escaped = this.cfg.folder.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = `mimeType='${FOLDER_MIME}' and name='${escaped}' and trashed=false`;
    const found = (await this.call(
      `/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
    )) as { files?: Array<{ id: string }> };
    if (found.files?.length) {
      this.folderId = found.files[0].id;
      return this.folderId;
    }
    const created = (await this.call('/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.cfg.folder, mimeType: FOLDER_MIME }),
    })) as { id: string };
    this.folderId = created.id;
    return this.folderId;
  }

  async put(name: string, data: Buffer): Promise<void> {
    const parent = await this.folder();
    // Step one: open a resumable session. The bytes do not move yet.
    const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'application/x-sqlite3',
        'X-Upload-Content-Length': String(data.length),
      },
      body: JSON.stringify({ name, parents: [parent] }),
    });
    if (!start.ok) throw new Error(extractGoogleError(start.status, await start.text()));
    const session = start.headers.get('location');
    if (!session) throw new Error('Google did not return an upload session URL');

    // Step two: the bytes, in one PUT. At ~5 MB chunking buys nothing.
    const upload = await fetch(session, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-sqlite3', 'Content-Length': String(data.length) },
      body: new Uint8Array(data),
    });
    if (!upload.ok) throw new Error(extractGoogleError(upload.status, await upload.text()));

    /*
      Drive allows two files with the same name in one folder, where a filesystem and S3
      both overwrite. Backing up twice in the same minute would otherwise leave two
      entries the retention count sees as separate, so older namesakes go — after the new
      one is safely stored, never before.
     */
    const uploaded = (await upload.json()) as { id: string };
    for (const stale of await this.findByName(name)) {
      if (stale.id !== uploaded.id) await this.call(`/files/${stale.id}`, { method: 'DELETE' });
    }
  }

  private async findByName(name: string): Promise<Array<{ id: string }>> {
    const parent = await this.folder();
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = `'${parent}' in parents and name='${escaped}' and trashed=false`;
    const found = (await this.call(
      `/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    )) as { files?: Array<{ id: string }> };
    return found.files ?? [];
  }

  async list(): Promise<StoredBackup[]> {
    const parent = await this.folder();
    const query = `'${parent}' in parents and trashed=false`;
    const found = (await this.call(
      `/files?q=${encodeURIComponent(query)}&fields=files(id,name,size,modifiedTime)&pageSize=1000`,
    )) as { files?: Array<{ name: string; size?: string; modifiedTime: string }> };
    return (found.files ?? [])
      .filter((file) => file.name.startsWith(BACKUP_PREFIX))
      .map((file) => ({
        name: file.name,
        // Drive returns size as a string, and omits it entirely for folders.
        sizeBytes: Number(file.size ?? 0),
        modifiedAt: new Date(file.modifiedTime),
      }))
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  async remove(name: string): Promise<void> {
    for (const file of await this.findByName(name)) {
      await this.call(`/files/${file.id}`, { method: 'DELETE' });
    }
  }
}
