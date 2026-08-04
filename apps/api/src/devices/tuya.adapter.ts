import { Socket } from 'node:net';
import {
  CMD,
  TUYA_CONTROL_PORT,
  TuyaVersion,
  buildControl,
  buildQuery,
  decode,
  findSwitchDp,
  isPlausibleLocalKey,
  isSupportedVersion,
  parseResponse,
} from './tuya-protocol';

/**
 * Talking to a Tuya switch over the LAN, once its local key is known.
 *
 * Everything here needs that key, which only Tuya's cloud will issue — see the panel in
 * Settings for the procedure. Without it a plug can still be discovered and listed, and
 * that asymmetry is worth stating plainly rather than leaving people to infer it from a
 * control that does nothing.
 *
 * Deliberately not a persistent connection. These devices accept one connection at a
 * time and drop it after a short idle, so a pool would spend most of its life
 * reconnecting, and would lock out the vendor's own app while it held the socket.
 */

const TIMEOUT_MS = 4_000;

export interface TuyaTarget {
  host: string;
  deviceId: string;
  localKey: string;
  version: string;
}

export interface TuyaState {
  on: boolean | null;
  /** Every datapoint the device returned, for the "what else does it report" question. */
  dps: Record<string, unknown>;
}

export class TuyaError extends Error {
  constructor(
    message: string,
    /** True when the message is safe and useful to show a user as-is. */
    readonly actionable = true,
  ) {
    super(message);
  }
}

function validate(target: TuyaTarget): TuyaVersion {
  if (!isSupportedVersion(target.version)) {
    throw new TuyaError(
      `This plug speaks protocol ${target.version}, which needs a different handshake. Only 3.1 and 3.3 are supported.`,
    );
  }
  if (!isPlausibleLocalKey(target.localKey)) {
    throw new TuyaError('A local key is exactly 16 characters. Check it was copied whole.');
  }
  return target.version;
}

/**
 * One request, one connection, one answer.
 *
 * Resolves on the first frame carrying readable datapoints. A device often pushes an
 * unsolicited status update before answering, so taking the first frame regardless would
 * return the wrong thing about a third of the time.
 */
function exchange(target: TuyaTarget, frame: Buffer, expectData: boolean): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;
    /*
      Whether the TCP connection was ever established. It is the difference between "there
      is nothing at that address" and "the device is there and rejected us", which have
      completely different fixes — and, tested against a real plug, were both being reported
      with the wrong message.
    */
    let connected = false;

    const finish = (error: Error | null, dps: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(dps);
    };

    socket.setTimeout(TIMEOUT_MS, () =>
      finish(
        new TuyaError(
          connected
            ? 'The plug accepted the connection then went quiet. It handles one connection at a time — close the vendor app and try again.'
            : 'Nothing answered at that address. Check the plug is powered and on this network.',
        ),
        null,
      ),
    );
    socket.on('error', (error: NodeJS.ErrnoException) => {
      /*
        A Tuya device given a frame it cannot decrypt does not reply with an error — it
        resets the connection. So ECONNRESET *after* connecting is, in practice, always a
        wrong key, and reporting it as "read ECONNRESET" sends people to check their
        network instead of their key. Verified against a real plug.
      */
      if (error.code === 'ECONNRESET' && connected) {
        finish(
          new TuyaError('The plug closed the connection without answering, which almost always means the local key is wrong.'),
          null,
        );
        return;
      }
      finish(
        new TuyaError(
          error.code === 'ECONNREFUSED'
            ? 'Nothing is listening on the control port. The plug may have dropped off Wi-Fi.'
            : error.message,
          error.code === 'ECONNREFUSED',
        ),
        null,
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, consumed } = decode(buffer);
      buffer = buffer.subarray(consumed);
      for (const received of frames) {
        if (received.returnCode !== null && received.returnCode !== 0) {
          finish(new TuyaError(`The plug refused the request (code ${received.returnCode}). Usually a wrong local key.`), null);
          return;
        }
        const dps = parseResponse(received.payload, target.localKey);
        if (dps) {
          finish(null, dps);
          return;
        }
      }
      // A control command is acknowledged with an empty payload; nothing more is coming.
      if (!expectData && frames.length > 0) finish(null, null);
    });

    socket.connect(TUYA_CONTROL_PORT, target.host, () => {
      connected = true;
      socket.write(frame);
    });
  });
}

/** Read the current state. Throws a TuyaError whose message is meant for a person. */
export async function readTuya(target: TuyaTarget): Promise<TuyaState> {
  const version = validate(target);
  const dps = await exchange(target, buildQuery(target.deviceId, target.localKey, version), true);
  if (!dps) {
    /*
      Readable frames that decrypt to nothing is the signature of a wrong key: the device
      answered, so it is present and the port is right — the bytes just do not decode.
    */
    throw new TuyaError('Connected, but the reply could not be decrypted. That local key does not match this plug.');
  }
  const switchDp = findSwitchDp(dps);
  return { on: switchDp === null ? null : Boolean(dps[switchDp]), dps };
}

/** Switch it. Reads first, so the right datapoint is used rather than assumed. */
export async function setTuya(target: TuyaTarget, on: boolean): Promise<void> {
  const version = validate(target);
  const current = await readTuya(target);
  const switchDp = findSwitchDp(current.dps) ?? '1';
  await exchange(target, buildControl(target.deviceId, target.localKey, version, { [switchDp]: on }), false);
}
