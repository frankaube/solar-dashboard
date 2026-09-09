import { BackupDestination, StoredBackup } from './destinations';

/**
 * Google Drive as a backup destination. Three API quirks shape this file:
 *
 * 1. `multipart` upload is capped at 5 MB, so uploads must be resumable.
 * 2. Refresh tokens are revoked after 7 days while the consent screen is in "Testing".
 * 3. Scope is `drive.file`: only files this app created are visible, bounding a prune.
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
 * Loopback only: Google requires https for every redirect URI except localhost, and rejects
 * raw IPs, so connecting happens on the host or through a tunnel.
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
    // `offline` asks for a refresh token; `consent` forces the screen even on a re-connect,
    // without which a re-authorisation returns an access token and no refresh token.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

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
   * The folder id, found or created. Under `drive.file` the search only sees folders this
   * app created, so a user's unrelated folder of the same name is never matched.
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

    // One PUT: at ~5 MB chunking buys nothing.
    const upload = await fetch(session, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-sqlite3', 'Content-Length': String(data.length) },
      body: new Uint8Array(data),
    });
    if (!upload.ok) throw new Error(extractGoogleError(upload.status, await upload.text()));

    // Drive allows same-named files in one folder where a filesystem and S3 overwrite.
    // Older namesakes go after the new one is stored, never before.
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
