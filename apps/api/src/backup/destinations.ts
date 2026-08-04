import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import * as http from 'node:http';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { amzDate, signRequest } from './s3-sign';
import { DEFAULT_DRIVE_FOLDER, GoogleDriveDestination } from './google-drive';

/**
 * Where backups go.
 *
 * Same registry shape as the battery and inverter vendors: a destination declares the
 * fields it needs and how to build itself, and the UI renders whatever is here. The
 * alternative — a checkbox per destination wired through the settings page — is how
 * the battery page ended up hardcoded to one vendor.
 *
 * Two are enough to cover the ask. A local path covers a USB disk, a NAS, or any
 * network share the host has mounted, which is how "another computer" is actually done
 * in practice. S3-compatible covers Backblaze B2, Wasabi, MinIO, Cloudflare R2 and AWS
 * itself with one implementation, because they all speak the same protocol.
 */

export interface StoredBackup {
  name: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface BackupDestination {
  put(name: string, data: Buffer): Promise<void>;
  list(): Promise<StoredBackup[]>;
  remove(name: string): Promise<void>;
  /** Human description for the UI, e.g. the path or bucket actually in use. */
  describe(): string;
}

export interface DestinationField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  optional?: boolean;
  /** Set by a connect flow rather than typed. The form skips it; the service still stores it. */
  hidden?: boolean;
}

export interface DestinationKind {
  id: string;
  name: string;
  summary: string;
  setupHint: string;
  fields: DestinationField[];
  create(config: Record<string, string>): BackupDestination | null;
}

// ---------------------------------------------------------------------------
// Local directory (also covers a mounted NAS, USB disk or network share)
// ---------------------------------------------------------------------------

const BACKUP_PREFIX = 'solar-';

class LocalDestination implements BackupDestination {
  constructor(private readonly dir: string) {}

  describe(): string {
    return this.dir;
  }

  async put(name: string, data: Buffer): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    /*
      Written to a temporary name and renamed into place. A backup interrupted
      mid-write would otherwise sit in the directory looking like a valid snapshot,
      and be indistinguishable from a good one until the day it is needed. Rename is
      atomic within a filesystem.
    */
    const target = path.join(this.dir, name);
    const temp = `${target}.partial`;
    await fs.writeFile(temp, data);
    await fs.rename(temp, target);
  }

  async list(): Promise<StoredBackup[]> {
    try {
      const names = await fs.readdir(this.dir);
      const out: StoredBackup[] = [];
      for (const name of names) {
        if (!name.startsWith(BACKUP_PREFIX) || name.endsWith('.partial')) continue;
        const stat = await fs.stat(path.join(this.dir, name));
        out.push({ name, sizeBytes: stat.size, modifiedAt: stat.mtime });
      }
      return out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    await fs.rm(path.join(this.dir, name), { force: true });
  }
}

// ---------------------------------------------------------------------------
// S3-compatible
// ---------------------------------------------------------------------------

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

class S3Destination implements BackupDestination {
  constructor(private readonly cfg: S3Config) {}

  describe(): string {
    return `${this.cfg.bucket}/${this.cfg.prefix}`.replace(/\/+$/, '');
  }

  private keyFor(name: string): string {
    return `${this.cfg.prefix}${name}`.replace(/^\/+/, '');
  }

  private request(
    method: string,
    key: string,
    body: Buffer | undefined,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: Buffer }> {
    const url = new URL(this.cfg.endpoint);
    const isHttps = url.protocol === 'https:';
    /*
      Path-style addressing (host/bucket/key) rather than virtual-host style
      (bucket.host/key). MinIO and most self-hosted stores only support path style,
      and every hosted provider still accepts it.
    */
    const requestPath = `/${this.cfg.bucket}/${key}`.replace(/\/+/g, '/');
    const payload = body ?? Buffer.alloc(0);
    const date = amzDate(new Date());

    const headers: Record<string, string> = {
      Host: url.host,
      'X-Amz-Date': date,
      'X-Amz-Content-Sha256': createHash('sha256').update(payload).digest('hex'),
    };
    if (body) headers['Content-Length'] = String(body.length);

    const { authorization } = signRequest({
      method,
      path: requestPath,
      query,
      headers,
      body: payload,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      service: 's3',
      amzDate: date,
    });

    const search = query
      ? `?${Object.keys(query)
          .sort()
          .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
          .join('&')}`
      : '';

    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        {
          host: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: requestPath + search,
          method,
          headers: { ...headers, Authorization: authorization },
          timeout: 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`${url.host} did not respond within 60 s`));
      });
      if (body) req.write(body);
      req.end();
    });
  }

  async put(name: string, data: Buffer): Promise<void> {
    const res = await this.request('PUT', this.keyFor(name), data);
    if (res.status >= 300) {
      throw new Error(`Upload failed: HTTP ${res.status} ${extractS3Error(res.body)}`);
    }
  }

  async list(): Promise<StoredBackup[]> {
    const res = await this.request('GET', '', undefined, {
      'list-type': '2',
      prefix: this.cfg.prefix,
    });
    if (res.status >= 300) {
      throw new Error(`List failed: HTTP ${res.status} ${extractS3Error(res.body)}`);
    }
    return parseListObjects(res.body.toString('utf8'), this.cfg.prefix);
  }

  async remove(name: string): Promise<void> {
    const res = await this.request('DELETE', this.keyFor(name), undefined);
    // 204 is success; 404 means it is already gone, which is the desired end state.
    if (res.status >= 300 && res.status !== 404) {
      throw new Error(`Delete failed: HTTP ${res.status} ${extractS3Error(res.body)}`);
    }
  }
}

/**
 * Pull the useful line out of an S3 error document.
 *
 * These stores answer failures with a wall of XML whose one useful field is `Message`.
 * Surfacing "HTTP 403" alone leaves an owner with nothing to act on, when the body
 * usually says exactly what is wrong.
 */
export function extractS3Error(body: Buffer | string): string {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1];
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(text)?.[1];
  if (message) return code ? `${code}: ${message}` : message;
  return text.slice(0, 200);
}

/** Minimal ListObjectsV2 parse — enough for names, sizes and dates. */
export function parseListObjects(xml: string, prefix: string): StoredBackup[] {
  const out: StoredBackup[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    const name = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    if (!name.startsWith(BACKUP_PREFIX)) continue;
    out.push({
      name,
      sizeBytes: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      modifiedAt: new Date(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? 0),
    });
  }
  return out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export const DESTINATION_KINDS: DestinationKind[] = [
  {
    id: 'local',
    name: 'A folder on this machine or the network',
    summary: 'A USB disk, a NAS, or any share this machine has mounted.',
    setupHint:
      'Give a path the app can write to. To reach another computer, mount its share on the host first, then point here at the mount. In Docker the path must also be mounted into the container — add it under volumes in docker-compose.yml.',
    fields: [
      {
        key: 'dir',
        label: 'Folder',
        placeholder: '/backups',
        help: 'Created if it does not exist.',
      },
    ],
    create(config) {
      const dir = config.dir?.trim();
      return dir ? new LocalDestination(dir) : null;
    },
  },
  {
    id: 's3',
    name: 'S3-compatible storage',
    summary: 'Backblaze B2, Wasabi, Cloudflare R2, MinIO, or AWS S3.',
    setupHint:
      'Works with any store that speaks the S3 API. Create a bucket and an access key with write permission on it. Your keys are stored on this machine and used only to upload backups.',
    fields: [
      {
        key: 'endpoint',
        label: 'Endpoint URL',
        placeholder: 'https://s3.us-west-002.backblazeb2.com',
        help: 'From your provider. For AWS it is https://s3.<region>.amazonaws.com.',
      },
      { key: 'bucket', label: 'Bucket', placeholder: 'solar-backups' },
      { key: 'region', label: 'Region', placeholder: 'us-east-1' },
      { key: 'accessKeyId', label: 'Access key ID', secret: true },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true },
      {
        key: 'prefix',
        label: 'Folder inside the bucket',
        placeholder: 'solar/',
        optional: true,
        help: 'Optional. Leave blank to store at the top level.',
      },
    ],
    create(config) {
      const { endpoint, bucket, accessKeyId, secretAccessKey } = config;
      if (!endpoint?.trim() || !bucket?.trim() || !accessKeyId?.trim() || !secretAccessKey?.trim()) {
        return null;
      }
      const prefix = (config.prefix ?? '').trim();
      return new S3Destination({
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        region: (config.region ?? '').trim() || 'us-east-1',
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        // A prefix without a trailing slash would silently prepend to the filename.
        prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
      });
    },
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    summary: 'Backups in a folder of your own Drive.',
    setupHint:
      'Needs an OAuth client you create once at console.cloud.google.com — enable the Drive API, add an OAuth client of type "Web application", and set its redirect URI to the address shown below. Publish the consent screen to Production: while it is in Testing, Google revokes the authorisation after 7 days and backups stop.',
    fields: [
      {
        key: 'clientId',
        label: 'OAuth client ID',
        placeholder: '1234567890-abc.apps.googleusercontent.com',
      },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
      {
        key: 'folder',
        label: 'Folder name in Drive',
        placeholder: DEFAULT_DRIVE_FOLDER,
        optional: true,
        help: 'Created on the first backup. The app can only see files it created itself.',
      },
      // Written by the connect flow. Never typed, so the form does not render it.
      { key: 'refreshToken', label: 'Authorisation', secret: true, hidden: true },
    ],
    create(config) {
      const { clientId, clientSecret, refreshToken } = config;
      if (!clientId?.trim() || !clientSecret?.trim() || !refreshToken?.trim()) return null;
      return new GoogleDriveDestination({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        refreshToken: refreshToken.trim(),
        folder: (config.folder ?? '').trim() || DEFAULT_DRIVE_FOLDER,
      });
    },
  },
];

export function findDestinationKind(id: string | null | undefined): DestinationKind | undefined {
  return DESTINATION_KINDS.find((kind) => kind.id === id);
}

export function destinationCatalogue(): Array<Omit<DestinationKind, 'create'>> {
  return DESTINATION_KINDS.map(({ create: _create, ...rest }) => rest);
}
