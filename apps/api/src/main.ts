import 'reflect-metadata';
import 'dotenv/config';
import { isPackaged, prepareLiteEnvironment, runLiteMigrations } from './common/lite';

prepareLiteEnvironment();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MdnsResponder } from './devices/mdns-responder';
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

/**
 * Advertise a fixed `.local` name so the dashboard has one URL on every install.
 *
 * Failure here is never fatal. UDP 5353 is shared territory — Docker, Bonjour and
 * printer utilities all sit on it — and losing a convenience name is not a reason to
 * refuse to start the thing someone actually opened.
 */
async function startMdns(port: number): Promise<MdnsResponder | null> {
  if (process.env.MDNS_DISABLE === '1') return null;
  const hostname = process.env.MDNS_HOSTNAME ?? 'solar-dashboard';
  const responder = new MdnsResponder({ hostname, port });
  try {
    await responder.start();
    Logger.log(`Reachable at http://${hostname}.local:${port}`, 'Mdns');
    return responder;
  } catch (error) {
    Logger.warn(
      `Could not advertise ${hostname}.local (${(error as Error).message}) — use the IP address instead.`,
      'Mdns',
    );
    return null;
  }
}

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
  app.setGlobalPrefix('api');
  app.enableCors();
  app.enableShutdownHooks();
  const apiToken = process.env.API_TOKEN;
  if (apiToken) {
    app.use(writeGuard(apiToken));
  }
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);

  const responder = await startMdns(port);
  // Send the goodbye packet on the way out, so the name stops resolving at once
  // rather than pointing at a dead port until the record expires.
  if (responder) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        responder.stop();
        process.exit(0);
      });
    }
  }
}

void bootstrap();
