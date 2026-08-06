import { describe, expect, it } from 'vitest';
import { headerSafe } from '../src/alerts/notifier.service';

/*
  The bug this exists for was found in a live install's own notification log, not in a test.

  Four messages in eighteen had been composed, written to the log, and never delivered. The
  titles begin with an emoji by design — "☀️ Solar day wrap" — and an HTTP header value is a
  ByteString, so fetch threw before the request left the process. Every one of those rows
  looked raised. The phone was simply silent, and nothing on any screen connected the two.

  What makes it worth a test rather than a one-line fix: the failure is invisible from the
  app. Alerts appear in the UI whether or not they got out.
*/

describe('headerSafe', () => {
  it('leaves an ordinary title exactly as it was', () => {
    // An encoded word is unreadable to anything that does not decode it, so it is worth
    // avoiding for the titles — most of them — that never needed it.
    expect(headerSafe('Solar day wrap')).toBe('Solar day wrap');
    expect(headerSafe('Inverter 3 offline (2 failed polls)')).toBe(
      'Inverter 3 offline (2 failed polls)',
    );
  });

  it('encodes a title that would throw, and keeps the emoji', () => {
    /*
      The real one. Stripping the emoji would also stop the throw, but the sun is the fastest
      thing about that message on a phone's lock screen — the point is to get it there, not
      to make the transport comfortable.
    */
    const encoded = headerSafe('☀️ Solar day wrap');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const base64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe('☀️ Solar day wrap');
  });

  it('produces something a header can actually carry', () => {
    // The whole point: every byte of the result has to be inside the printable ASCII range,
    // or the throw simply moves rather than going away.
    for (const title of ['⚠️ Collector cannot reach the DTU', '✅ Resolved', '🔋 Battery low', 'é']) {
      expect(headerSafe(title)).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  it('handles the empty string without inventing an encoded word', () => {
    expect(headerSafe('')).toBe('');
  });

  it('encodes accented Latin, which is also outside a ByteString header in practice', () => {
    // Not hypothetical for this project: it ships in a bilingual province.
    expect(headerSafe('Journée ensoleillée')).toMatch(/^=\?UTF-8\?B\?/);
  });
});
