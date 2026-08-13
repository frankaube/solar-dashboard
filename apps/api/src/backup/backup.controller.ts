import { BadRequestException, Body, Controller, Get, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BackupSchedule, BackupService } from './backup.service';
import { destinationCatalogue, findDestinationKind } from './destinations';
import { FREQUENCIES, findFrequency, normaliseHour } from './schedule';

@Controller('backup')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get('status')
  status(): Promise<object> {
    return this.backup.status();
  }

  /** What the app can back up to, and what each destination needs. */
  @Get('destinations')
  destinations(): object {
    return destinationCatalogue();
  }

  @Get('config')
  config(): Promise<object> {
    return this.backup.config();
  }

  /**
   * Try a destination without saving it.
   *
   * Returns 200 with ok:false for a destination that does not work — the request was
   * well formed and "that bucket rejects the key" is the useful answer, not an
   * exception the client has to unwrap.
   */
  @Post('test')
  test(@Body() body: { kind?: string; config?: Record<string, string> }): Promise<object> {
    if (!body?.kind) throw new BadRequestException('kind is required');
    return this.backup.test(body.kind, body.config ?? {});
  }

  @Put('config')
  async save(
    @Body()
    body: {
      enabled?: string[];
      configs?: Record<string, Record<string, string>>;
      schedule?: BackupSchedule;
      keep?: number;
      hour?: number;
    },
  ): Promise<object> {
    const enabled = body?.enabled ?? [];
    if (!Array.isArray(enabled)) throw new BadRequestException('enabled must be an array');
    for (const kind of enabled) {
      if (!findDestinationKind(kind)) {
        throw new BadRequestException(`Unknown destination: ${kind}`);
      }
    }
    const schedule = body.schedule ?? 'daily';
    // Against the registry, not a hardcoded list — otherwise adding a frequency means
    // remembering to widen a validation the compiler cannot point you at.
    if (!findFrequency(schedule)) {
      throw new BadRequestException(`Unknown frequency: ${schedule}`);
    }
    await this.backup.saveConfig({
      enabled,
      configs: body.configs ?? {},
      schedule,
      keep: Number(body.keep) || 14,
      hour: normaliseHour(body.hour),
    });
    return this.backup.status();
  }

  /** How often backups can be taken, and which of those honour a preferred hour. */
  @Get('frequencies')
  frequencies(): object {
    return FREQUENCIES;
  }

  @Post('run')
  run(): Promise<object> {
    return this.backup.runNow();
  }

  /**
   * Begin the Google Drive consent flow.
   *
   * The redirect URI is derived from the Host header the browser used rather than
   * configured, so it matches whatever port the dashboard is actually published on
   * without anyone having to tell it. Google only accepts http on loopback, so a session
   * that reached us by LAN address is refused here with the reason, rather than by
   * Google with "redirect_uri_mismatch" after the user has already signed in.
   *
   * These two routes are GETs that change state, which the API_TOKEN write guard does
   * not cover — an OAuth callback arrives as a browser navigation and cannot carry a
   * bearer token. What actually constrains them: `start` refuses unless an OAuth client
   * has already been saved through the guarded PUT, the callback requires an unexpired
   * single-use nonce that only `start` issues, and the loopback rule means Google
   * redirects to the visitor's own machine — so a code obtained from elsewhere on the
   * network never reaches this server.
   */
  @Get('oauth/google/start')
  async googleStart(@Req() req: Request, @Res() res: Response): Promise<void> {
    const host = req.headers.host ?? '';
    if (!isLoopbackHost(host)) {
      res
        .status(400)
        .send(
          page(
            'Connect from the machine running the dashboard',
            `Google only allows an insecure redirect back to <code>localhost</code>, so this has to be done at <code>http://localhost:8080/settings/backup</code> on the host itself — not at <code>${escapeHtml(host)}</code>. If the dashboard runs on another machine, forward the port first: <code>ssh -L 8080:localhost:8080 user@host</code>.`,
          ),
        );
      return;
    }
    try {
      res.redirect(await this.backup.driveAuthUrl(googleRedirectUri(host)));
    } catch (error) {
      res.status(400).send(page('Cannot connect yet', escapeHtml((error as Error).message)));
    }
  }

  /** Where Google sends the browser back. Ends by returning the user to Settings. */
  @Get('oauth/google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (error || !code) {
      res.status(400).send(page('Not connected', escapeHtml(error || 'Google sent no code.')));
      return;
    }
    try {
      await this.backup.driveCallback(code, state, googleRedirectUri(req.headers.host ?? ''));
      // Straight back to the tab they started from, not the top of Settings.
      res.redirect('/settings/backup?connected=gdrive');
    } catch (cause) {
      res.status(400).send(page('Could not finish connecting', escapeHtml((cause as Error).message)));
    }
  }

  @Post('oauth/google/disconnect')
  async googleDisconnect(): Promise<object> {
    await this.backup.driveDisconnect();
    return this.backup.status();
  }
}

function googleRedirectUri(host: string): string {
  return `http://${host}/api/backup/oauth/google/callback`;
}

function isLoopbackHost(host: string): boolean {
  const name = host.split(':')[0].toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
  );
}

/**
 * A plain page for the OAuth detours.
 *
 * These two routes are the only ones a browser lands on directly rather than through the
 * app, so a JSON error body would show as raw text at a URL the user did not choose to
 * visit. Whatever went wrong, it should be readable and offer the way back.
 */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#222}
code{background:#f2f2f2;padding:.1em .35em;border-radius:3px;font-size:.9em}a{color:#0a58ca}</style>
<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p><p><a href="/settings/backup">Back to Settings</a></p>`;
}
