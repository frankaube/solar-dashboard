import { describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  handle,
  handleLine,
  negotiate,
  toolText,
} from '../src/protocol.mjs';

/*
  These pin the handshake, because a handshake that is subtly wrong does not fail loudly —
  the client disconnects with a message that names none of this, and the server looks fine
  from the inside.
*/

const deps = {
  serverInfo: { name: 'solar-dashboard', version: '0.1.0' },
  instructions: 'Every figure must come from a tool call.',
  tools: [{ name: 'get_current_status', description: 'now', inputSchema: { type: 'object' } }],
  callTool: vi.fn(async () => toolText('Producing now: 4,180 W')),
};

describe('initialize', () => {
  it('echoes a version it knows', async () => {
    const response = await handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      deps,
    );
    expect(response.result.protocolVersion).toBe('2024-11-05');
    expect(response.result.capabilities.tools).toEqual({});
    expect(response.result.serverInfo.name).toBe('solar-dashboard');
  });

  it('names its own newest for a version it does not know', async () => {
    /*
      A client from the future gets to decide for itself whether it can still talk to us.
      Echoing back a version we have never heard of would be asserting support we do not
      have.
    */
    const response = await handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
      deps,
    );
    expect(response.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('negotiates the same way for a missing version', () => {
    expect(negotiate(undefined)).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe('requests', () => {
  it('lists tools', async () => {
    const response = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    expect(response.result.tools[0].name).toBe('get_current_status');
  });

  it('answers ping with an empty result', async () => {
    expect(await handle({ jsonrpc: '2.0', id: 3, method: 'ping' }, deps)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {},
    });
  });

  it('calls a tool and returns its text', async () => {
    const response = await handle(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_current_status', arguments: {} } },
      deps,
    );
    expect(response.result.content[0].text).toContain('4,180 W');
    expect(response.result.isError).toBe(false);
  });

  it('rejects an unknown method', async () => {
    const response = await handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, deps);
    expect(response.error.code).toBe(ErrorCode.METHOD_NOT_FOUND);
  });

  it('rejects an unknown tool as a protocol error, not a result', async () => {
    const response = await handle(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'turn_off_the_pump' } },
      deps,
    );
    expect(response.error.code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it('reports a thrown tool as an error result the model can see', async () => {
    /*
      A crash inside a tool is a bug here, not a failed lookup. Returned as content rather
      than a JSON-RPC error so the model can say something useful instead of the client
      swallowing it.
    */
    const response = await handle(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_current_status' } },
      { ...deps, callTool: async () => { throw new Error('boom'); } },
    );
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('boom');
  });
});

describe('things that must not be answered', () => {
  it('says nothing to a notification', async () => {
    // Replying to a notification is a protocol violation some clients treat as fatal.
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, deps)).toBeNull();
  });

  it('says nothing to a response', async () => {
    expect(await handle({ jsonrpc: '2.0', id: 9, result: {} }, deps)).toBeNull();
  });
});

describe('malformed input', () => {
  it('answers a bad line inside the protocol rather than dying', async () => {
    // One bad line must not end the session.
    const response = await handleLine('{ not json', deps);
    expect(response.error.code).toBe(ErrorCode.PARSE_ERROR);
    expect(response.id).toBeNull();
  });

  it('rejects a batch, which MCP removed', async () => {
    const response = await handleLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]', deps);
    expect(response.error.code).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('rejects something that is not JSON-RPC at all', async () => {
    expect((await handleLine('{"hello":"world"}', deps)).error.code).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('ignores a leading byte-order mark', async () => {
    /*
      Windows PowerShell prepends ef bb bf to anything it pipes into a native command, so
      the hand-testing one-liner in the guide fails there with "Invalid JSON" — an error
      naming the message rather than the shell that mangled it. A BOM says nothing inside a
      stream already known to be UTF-8, so refusing over one is refusing over noise.
    */
    const bom = String.fromCharCode(0xfeff);
    const response = await handleLine(`${bom}{"jsonrpc":"2.0","id":1,"method":"ping"}`, deps);
    expect(response.result).toEqual({});
  });
});

describe('the stdout invariant', () => {
  it('serialises a multi-line report as one line', async () => {
    /*
      stdio framing is one JSON object per line. A rendered report is full of newlines, and
      the only thing keeping it a single protocol message is that JSON.stringify escapes
      them. Worth a test, because the failure is a corrupted stream rather than an
      exception.
    */
    const response = await handle(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_current_status' } },
      { ...deps, callTool: async () => toolText('line one\nline two\nline three') },
    );
    expect(JSON.stringify(response).includes('\n')).toBe(false);
  });
});
