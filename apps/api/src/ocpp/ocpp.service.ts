import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MeterReading,
  OCPP_SUBPROTOCOL,
  callResult,
  chargePointIdFromPath,
  parseCall,
  parseMeterValues,
  replyFor,
  statusMeansConnected,
} from './ocpp-messages';

/**
 * An OCPP 1.6J central system, read-only.
 *
 * Listens on its own port rather than sharing the HTTP server, because a charge point is
 * configured with a full WebSocket URL anyway and a dedicated port keeps the OCPP
 * handshake away from the app's own routes.
 *
 * The charge point connects to us — `ws://<host>:<OCPP_PORT>/<chargePointId>` — which is
 * the whole reason this is the best charger integration available here. No discovery, no
 * scanning, and it works from inside a bridged container where announcement-based
 * discovery cannot.
 */

const DEFAULT_PORT = 9000;
/** A charge point that has not spoken in this long is treated as gone. */
const STALE_MS = 10 * 60_000;

export interface ChargePoint {
  id: string;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  status: string | null;
  connected: boolean;
  charging: boolean;
  powerW: number | null;
  energyWh: number | null;
  soc: number | null;
  lastSeenAt: Date;
  transactionId: number | null;
}

@Injectable()
export class OcppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcppService.name);
  private server: WebSocketServer | null = null;
  private readonly points = new Map<string, ChargePoint>();

  onModuleInit(): void {
    if (process.env.OCPP_ENABLE !== '1') {
      this.logger.log('OCPP central system off — set OCPP_ENABLE=1 to listen.');
      return;
    }
    const port = Number(process.env.OCPP_PORT) || DEFAULT_PORT;
    this.server = new WebSocketServer({ port, handleProtocols: () => OCPP_SUBPROTOCOL });
    this.server.on('connection', (socket, request) => {
      const id = chargePointIdFromPath(request.url) ?? 'unknown';
      this.logger.log(`Charge point connected: ${id}`);
      this.points.set(id, { ...(this.points.get(id) ?? blank(id)), lastSeenAt: new Date() });
      socket.on('message', (data) => this.onMessage(id, socket, data.toString()));
      socket.on('close', () => this.logger.log(`Charge point disconnected: ${id}`));
      socket.on('error', (error) => this.logger.warn(`${id}: ${error.message}`));
    });
    this.server.on('error', (error) => this.logger.warn(`OCPP server: ${error.message}`));
    this.logger.log(`OCPP 1.6J central system listening on ${port} — point chargers at ws://<host>:${port}/<id>`);
  }

  onModuleDestroy(): void {
    this.server?.close();
  }

  /**
   * Every message gets a reply, whether or not we understood it.
   *
   * A charge point whose CALL goes unanswered retries and eventually drops the link, so
   * silence is worse than an empty acknowledgement.
   */
  private onMessage(id: string, socket: WebSocket, raw: string): void {
    const call = parseCall(raw);
    if (!call) return;
    const point = this.points.get(id) ?? blank(id);
    point.lastSeenAt = new Date();

    switch (call.action) {
      case 'BootNotification':
        point.vendor = str(call.payload.chargePointVendor);
        point.model = str(call.payload.chargePointModel);
        point.firmware = str(call.payload.firmwareVersion);
        this.logger.log(`${id} booted: ${point.vendor ?? '?'} ${point.model ?? '?'}`);
        break;
      case 'StatusNotification':
        point.status = str(call.payload.status);
        point.connected = statusMeansConnected(call.payload.status);
        if (call.payload.status === 'Available') point.charging = false;
        break;
      case 'StartTransaction':
        point.charging = true;
        point.connected = true;
        break;
      case 'StopTransaction':
        point.charging = false;
        point.transactionId = null;
        break;
      case 'MeterValues':
        this.applyReadings(point, parseMeterValues(call.payload));
        break;
      default:
        break;
    }

    this.points.set(id, point);
    socket.send(callResult(call.id, replyFor(call.action, new Date())));
  }

  /**
   * Fold readings in without erasing what a sparser sample did not mention.
   *
   * Charge points send different measurands in different messages — power now, the energy
   * register a minute later — so overwriting the whole record each time would make both
   * values flicker to null between samples.
   */
  private applyReadings(point: ChargePoint, readings: MeterReading[]): void {
    for (const reading of readings) {
      if (reading.powerW !== null) point.powerW = reading.powerW;
      if (reading.energyWh !== null) point.energyWh = reading.energyWh;
      if (reading.soc !== null) point.soc = reading.soc;
      // Power flowing is the most reliable evidence of charging there is; some charge
      // points never send StartTransaction at all.
      if ((reading.powerW ?? 0) > 100) {
        point.charging = true;
        point.connected = true;
      }
    }
  }

  get enabled(): boolean {
    return this.server !== null;
  }

  chargePoints(): ChargePoint[] {
    const now = Date.now();
    return [...this.points.values()].map((point) => ({
      ...point,
      // A point that has gone quiet is reported as not charging rather than frozen on its
      // last known power, which would otherwise read as a car charging forever.
      charging: now - point.lastSeenAt.getTime() < STALE_MS ? point.charging : false,
      powerW: now - point.lastSeenAt.getTime() < STALE_MS ? point.powerW : null,
    }));
  }

  status(): object {
    return {
      enabled: this.enabled,
      port: this.enabled ? Number(process.env.OCPP_PORT) || DEFAULT_PORT : null,
      chargePoints: this.chargePoints(),
    };
  }
}

function blank(id: string): ChargePoint {
  return {
    id,
    vendor: null,
    model: null,
    firmware: null,
    status: null,
    connected: false,
    charging: false,
    powerW: null,
    energyWh: null,
    soc: null,
    lastSeenAt: new Date(),
    transactionId: null,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
