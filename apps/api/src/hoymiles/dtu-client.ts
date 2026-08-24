import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import * as protobuf from 'protobufjs';
import { isPackaged, resourcePath } from '../common/lite';
import {
  DTU_PORT,
  DtuCommand,
  MIN_REQUEST_SPACING_MS,
  REQUEST_TIME_OFFSET,
  announcedFrameLength,
  decodeFrame,
  encodeFrame,
} from './protocol';
import { RawAppInfo, RawRealData, toDataSourceInfo, toSystemSnapshot } from './scaling';
import { DataSourceInfo, InverterDataSource, SystemSnapshot } from './types';

const REQUEST_TIMEOUT_MS = 10_000;
/** Safety cap; real responses report 3-4 pages for this system size. */
const MAX_PAGES = 16;
const PROTO_FILES = ['RealDataNew.proto', 'APPInfomationData.proto'];

function loadProtoRoot(): protobuf.Root {
  const protoDir = isPackaged ? resourcePath('protos') : join(__dirname, 'protos');
  const root = new protobuf.Root();
  for (const file of PROTO_FILES) {
    protobuf.parse(readFileSync(join(protoDir, file), 'utf8'), root, {
      keepCase: false,
    });
  }
  return root;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Local client for Hoymiles DTUs (protobuf over TCP, port 10081, unencrypted).
 * One connection per request/response, paginated via ap/cp, ≥2 s between requests.
 */
export class HoymilesDtuClient implements InverterDataSource {
  private sequence = 0;
  private lastRequestAt = 0;
  private readonly realDataRequest: protobuf.Type;
  private readonly realDataResponse: protobuf.Type;
  private readonly appInfoRequest: protobuf.Type;
  private readonly appInfoResponse: protobuf.Type;

  constructor(
    private host: string,
    private readonly port: number = DTU_PORT,
  ) {
    const root = loadProtoRoot();
    // "ResDTO" is what the app SENDS and "ReqDTO" what it RECEIVES — naming inherited from the vendor protos.
    this.realDataRequest = root.lookupType('RealDataNewResDTO');
    this.realDataResponse = root.lookupType('RealDataNewReqDTO');
    this.appInfoRequest = root.lookupType('APPInfoDataResDTO');
    this.appInfoResponse = root.lookupType('APPInfoDataReqDTO');
  }

  getHost(): string {
    return this.host;
  }

  setHost(host: string): void {
    this.host = host;
  }

  async fetchSnapshot(): Promise<SystemSnapshot> {
    return toSystemSnapshot(await this.fetchRealData());
  }

  async fetchInfo(): Promise<DataSourceInfo> {
    const payload = this.appInfoRequest.encode(
      this.appInfoRequest.create({
        timeYmdHms: Buffer.from(formatTimestamp(new Date()), 'utf8'),
        offset: REQUEST_TIME_OFFSET,
        time: Math.floor(Date.now() / 1000),
      }),
    ).finish();
    const responsePayload = await this.roundTrip(DtuCommand.AppInfoData, Buffer.from(payload));
    const raw = this.decodeResponse<RawAppInfo>(this.appInfoResponse, responsePayload);
    return toDataSourceInfo(raw);
  }

  private async fetchRealData(): Promise<RawRealData> {
    const first = await this.fetchRealDataPage(0);
    const combined: RawRealData = {
      ...first,
      sgsData: [...(first.sgsData ?? [])],
      pvData: [...(first.pvData ?? [])],
    };
    const pageCount = Math.min(first.ap ?? 1, MAX_PAGES);
    for (let page = 1; page < pageCount; page++) {
      const next = await this.fetchRealDataPage(page);
      combined.sgsData!.push(...(next.sgsData ?? []));
      combined.pvData!.push(...(next.pvData ?? []));
      if (Number(next.dtuPower ?? 0) > 0) {
        combined.dtuPower = next.dtuPower;
        combined.dtuDailyEnergy = next.dtuDailyEnergy;
      }
    }
    return combined;
  }

  private async fetchRealDataPage(page: number): Promise<RawRealData> {
    const payload = this.realDataRequest.encode(
      this.realDataRequest.create({
        timeYmdHms: Buffer.from(formatTimestamp(new Date()), 'utf8'),
        cp: page,
        offset: REQUEST_TIME_OFFSET,
        time: Math.floor(Date.now() / 1000),
      }),
    ).finish();
    const responsePayload = await this.roundTrip(DtuCommand.RealDataNew, Buffer.from(payload));
    return this.decodeResponse<RawRealData>(this.realDataResponse, responsePayload);
  }

  private decodeResponse<T>(type: protobuf.Type, payload: Buffer): T {
    const message = type.decode(payload);
    return type.toObject(message, { longs: String, defaults: true }) as T;
  }

  private async roundTrip(command: DtuCommand, requestPayload: Buffer): Promise<Buffer> {
    const sinceLast = Date.now() - this.lastRequestAt;
    if (sinceLast < MIN_REQUEST_SPACING_MS) {
      await delay(MIN_REQUEST_SPACING_MS - sinceLast);
    }
    this.sequence = (this.sequence + 1) & 0xffff;
    const frame = encodeFrame(command, this.sequence, requestPayload);

    const response = await new Promise<Buffer>((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let received = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`DTU ${this.host}:${this.port} timed out after ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      const finish = (err: Error | null, result?: Buffer): void => {
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(result!);
      };
      socket.on('error', (err) => finish(err));
      socket.on('connect', () => socket.write(frame));
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const expected = announcedFrameLength(received);
        if (expected !== null && received.length >= expected) {
          finish(null, received);
        }
      });
      socket.on('close', () => finish(new Error('Connection closed before a full frame arrived')));
    });

    this.lastRequestAt = Date.now();
    return decodeFrame(response).payload;
  }
}
