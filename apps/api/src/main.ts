import 'reflect-metadata';
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

/*
  mDNS moved to MdnsService.

  It lived here as a local variable: started once, unreachable afterwards, and renameable
  only by editing an env file on the machine. Owned by a service it can be changed from
  Settings — which matters the moment two of these share a LAN and both answer for
  `solar-dashboard.local`. Nest's shutdown hooks send the goodbye packet now.
*/

/**
 * Say which timezone the daily figures are bucketed by.
 *
 * Every "today", "this month" and best-day record depends on it, and getting it wrong
 * produces numbers that look perfectly normal while being attributed to the wrong day.
 * That is only debuggable if the app states its answer, so it is logged once at start
 * — and loudly when a configured value had to be rejected.
 */
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
  /*
    The usage-import route takes a file, not JSON.

    Registered before the global prefix so the path matches what Express actually sees, and
    scoped to that one route so nothing else loses its parsed body. A spreadsheet is a zip
    and a CSV may be any encoding; both have to arrive as bytes, and the default JSON parser
    would reject the first and mangle the second.
  */
  app.use(
    '/api/utility-usage',
    raw({ type: () => true, limit: '12mb' }),
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

}

void bootstrap();
