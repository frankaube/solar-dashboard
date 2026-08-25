import { describe, expect, it } from 'vitest';
import { headerSafe } from '../src/alerts/notifier.service';

/*
  Alert titles begin with an emoji by design ("☀️ Solar day wrap"), but an HTTP header value
  is a ByteString, so fetch throws before the request leaves the process. The failure is
  invisible from the app: alerts appear in the UI whether or not they got out.
*/

describe('headerSafe', () => {
  it('leaves an ordinary title exactly as it was', () => {
    // An encoded word is unreadable to anything that does not decode it, so ASCII titles
    // must pass through untouched.
    expect(headerSafe('Solar day wrap')).toBe('Solar day wrap');
    expect(headerSafe('Inverter 3 offline (2 failed polls)')).toBe(
      'Inverter 3 offline (2 failed polls)',
    );
  });

  it('encodes a title that would throw, and keeps the emoji', () => {
    // Stripping the emoji would also stop the throw; RFC 2047 encoding keeps it instead.
    const encoded = headerSafe('☀️ Solar day wrap');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const base64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe('☀️ Solar day wrap');
  });

  it('produces something a header can actually carry', () => {
    // Every byte of the result must be printable ASCII, or the throw only moves.
    for (const title of ['⚠️ Collector cannot reach the DTU', '✅ Resolved', '🔋 Battery low', 'é']) {
      expect(headerSafe(title)).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  it('handles the empty string without inventing an encoded word', () => {
    expect(headerSafe('')).toBe('');
  });

  it('encodes accented Latin, which is also outside a ByteString header in practice', () => {
    expect(headerSafe('Journée ensoleillée')).toMatch(/^=\?UTF-8\?B\?/);
  });
});
