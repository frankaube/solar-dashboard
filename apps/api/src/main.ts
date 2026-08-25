import 'reflect-metadata';
import { notifyReady } from './common/watchdog';
import 'dotenv/config';
import { isPackaged, prepareLiteEnvironment, runLiteMigrations } from './common/lite';

prepareLiteEnvironment();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { raw } from 'express';
import { AppModule } from './app.module';
import { SITE_TIMEZONE_RESOLUTION } from './common/localdate';

import type { NextFunction, Request, Response } from 'express';

const DEFAULT_PORT = 3001;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** When API_TOKEN is set, mutating requests must carry `Authorization: Bearer <token>`. */
function writeGuard(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (READ_METHODS.has(req.method) || req.headers.authorization === `Bearer ${token}`) {
      next();
      return;
    }
    res.status(401).json({ message: 'API token required for write operations' });
  };
}

// mDNS lives in MdnsService so the hostname is settable from Settings — two of these on one
// LAN would otherwise both answer for `solar-dashboard.local`.

/** A wrong zone attributes normal-looking numbers to the wrong day, so it is stated at start. */
function announceTimeZone(): void {
  const { timeZone, source, rejected } = SITE_TIMEZONE_RESOLUTION;
  if (rejected) {
    Logger.error(
      `SITE_TIMEZONE "${rejected}" is not a valid IANA zone — falling back to ${timeZone}. Daily totals will be bucketed by ${timeZone} until this is fixed.`,
      'TimeZone',
    );
    return;
  }
  if (source === 'fallback') {
    Logger.warn(
      `No timezone configured — bucketing daily totals by ${timeZone}. Set SITE_TIMEZONE (e.g. America/Toronto) or your day boundaries will not match your utility's.`,
      'TimeZone',
    );
    return;
  }
  Logger.log(`Daily totals bucketed by ${timeZone} (from ${source})`, 'TimeZone');
}

async function bootstrap(): Promise<void> {
  announceTimeZone();
  if (isPackaged) {
    await runLiteMigrations();
  }
  const app = await NestFactory.create(AppModule);
  // Before the global prefix so the path matches what Express sees, and scoped to this route
  // so nothing else loses its parsed body. A spreadsheet is a zip and a CSV may be any
  // encoding; the JSON parser would reject the first and mangle the second.
  app.use(
    '/api/utility-usage',
    raw({ type: () => true, limit: '12mb' }),
  );
  // Pasted block or saved file: JSON still goes to the JSON parser, everything else arrives
  // as bytes — otherwise a text/plain upload reaches the controller as an empty object.
  app.use(
    '/api/readings/cloud-import',
    raw({
      type: (req) => !/json/i.test(req.headers['content-type'] ?? ''),
      limit: '4mb',
    }),
  );
  app.setGlobalPrefix('api');
  app.enableCors();
  app.enableShutdownHooks();
  const apiToken = process.env.API_TOKEN;
  if (apiToken) {
    app.use(writeGuard(apiToken));
  }
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
  // After the port is open: systemd holds dependent units, and the watchdog counts from here.
  notifyReady();

}

void bootstrap();
