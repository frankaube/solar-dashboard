import { describe, expect, it } from 'vitest';
import {
  DtuCommand,
  announcedFrameLength,
  crc16Modbus,
  decodeFrame,
  encodeFrame,
} from '../src/hoymiles/protocol';

describe('crc16Modbus', () => {
  it('matches the CRC-16/MODBUS check value for "123456789"', () => {
    expect(crc16Modbus(Buffer.from('123456789', 'ascii'))).toBe(0x4b37);
  });

  it('returns the init value for empty input', () => {
    expect(crc16Modbus(Buffer.alloc(0))).toBe(0xffff);
  });
});

describe('frame encode/decode', () => {
  const payload = Buffer.from([0x08, 0x01, 0x10, 0x02, 0x18, 0x03]);

  it('round-trips a frame', () => {
    const frame = encodeFrame(DtuCommand.RealDataNew, 42, payload);
    const decoded = decodeFrame(frame);
    expect(decoded.command).toBe(DtuCommand.RealDataNew);
    expect(decoded.sequence).toBe(42);
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it('announces total length as payload + 10-byte header', () => {
    const frame = encodeFrame(DtuCommand.AppInfoData, 1, payload);
    expect(announcedFrameLength(frame)).toBe(payload.length + 10);
    expect(announcedFrameLength(frame.subarray(0, 5))).toBeNull();
  });

  it('rejects a corrupted payload', () => {
    const frame = encodeFrame(DtuCommand.RealDataNew, 7, payload);
    frame[frame.length - 1] ^= 0xff;
    expect(() => decodeFrame(frame)).toThrow(/CRC mismatch/);
  });

  it('rejects a frame with the wrong magic', () => {
    const frame = encodeFrame(DtuCommand.RealDataNew, 7, payload);
    frame[0] = 0x00;
    expect(() => decodeFrame(frame)).toThrow(/magic/);
  });

  it('rejects a truncated frame', () => {
    const frame = encodeFrame(DtuCommand.RealDataNew, 7, payload);
    expect(() => decodeFrame(frame.subarray(0, frame.length - 2))).toThrow(/Incomplete/);
  });
});
