import { Buffer } from 'node:buffer';

export const DTU_PORT = 10081;
export const FRAME_HEADER_LENGTH = 10;
/** Fixed value every request payload must carry — protocol quirk inherited from the vendor app. */
export const REQUEST_TIME_OFFSET = 28800;
/** The DTU misbehaves when requests arrive closer together than this. */
export const MIN_REQUEST_SPACING_MS = 2000;

const FRAME_MAGIC = Buffer.from('HM', 'ascii');

export enum DtuCommand {
  AppInfoData = 0xa301,
  RealDataNew = 0xa311,
}

/** CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF), as used by the DTU frame header. */
export function crc16Modbus(data: Buffer): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

export interface DtuFrame {
  command: number;
  sequence: number;
  payload: Buffer;
}

/**
 * Frame layout (both directions):
 * "HM" | command u16BE | sequence u16BE | crc16(payload) u16BE | total length u16BE | payload
 */
export function encodeFrame(command: DtuCommand, sequence: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(FRAME_HEADER_LENGTH + payload.length);
  FRAME_MAGIC.copy(frame, 0);
  frame.writeUInt16BE(command, 2);
  frame.writeUInt16BE(sequence & 0xffff, 4);
  frame.writeUInt16BE(crc16Modbus(payload), 6);
  frame.writeUInt16BE(frame.length, 8);
  payload.copy(frame, FRAME_HEADER_LENGTH);
  return frame;
}

/** Total frame length announced by a (possibly partial) buffer, or null while the header is incomplete. */
export function announcedFrameLength(buffer: Buffer): number | null {
  return buffer.length >= FRAME_HEADER_LENGTH ? buffer.readUInt16BE(8) : null;
}

export function decodeFrame(buffer: Buffer): DtuFrame {
  if (buffer.length < FRAME_HEADER_LENGTH) {
    throw new Error(`Frame too short: ${buffer.length} bytes`);
  }
  if (!buffer.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC)) {
    throw new Error('Frame does not start with "HM" magic');
  }
  const totalLength = buffer.readUInt16BE(8);
  if (buffer.length < totalLength) {
    throw new Error(`Incomplete frame: announced ${totalLength}, received ${buffer.length}`);
  }
  const payload = Buffer.from(buffer.subarray(FRAME_HEADER_LENGTH, totalLength));
  const expectedCrc = buffer.readUInt16BE(6);
  const actualCrc = crc16Modbus(payload);
  if (actualCrc !== expectedCrc) {
    throw new Error(`CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`);
  }
  return {
    command: buffer.readUInt16BE(2),
    sequence: buffer.readUInt16BE(4),
    payload,
  };
}
