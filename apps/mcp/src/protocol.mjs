/**
 * The Model Context Protocol, in as much of it as a read-only tool server needs.
 *
 * MCP over stdio is JSON-RPC 2.0, one message per line, on stdin and stdout. A server that
 * exposes tools and nothing else — no resources, no prompts, no sampling, no completion —
 * answers exactly four methods: `initialize`, `tools/list`, `tools/call` and `ping`, plus
 * the `notifications/initialized` the client sends and expects no reply to.
 *
 * That is small enough to implement against the specification rather than pull a
 * dependency for, and doing so keeps this a single directory of plain .mjs files that runs
 * anywhere Node runs, with no install step on the machine the assistant happens to be on.
 * The trade is that protocol drift is ours to handle, which is what `negotiate` is for.
 *
 * The one rule that matters more than any of the above: stdout carries protocol and
 * nothing else. A stray console.log corrupts the stream and the client disconnects with an
 * error that names none of this. Diagnostics go to stderr.
 */

/**
 * Versions this speaks, newest first.
 *
 * The handshake is a negotiation, not an assertion: the client names a version, and the
 * server answers with the one it will actually use. Echoing back a version we recognise is
 * the cooperative answer; naming our newest when we do not recognise theirs lets a client
 * from the future decide for itself whether it can still talk to us, rather than being
 * told a version we invented on the spot.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiate(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
export const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** A tool result the model can see and react to — not a transport failure. */
export const toolText = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  isError,
});

/**
 * Answer one parsed message.
 *
 * Returns null for anything that must not be replied to — notifications, and responses the
 * client sent us. Replying to a notification is a protocol violation that some clients
 * treat as fatal.
 *
 * `deps.callTool(name, args)` returns a tool-result object. It is expected to report its
 * own failures as `isError: true` content rather than throwing: a dashboard that is
 * unreachable is something the model should be told about in words, not a JSON-RPC error
 * that it never sees.
 */
export async function handle(message, deps) {
  if (Array.isArray(message)) {
    // Batching was removed from MCP in 2025-06-18 and this never supported it.
    return failure(null, ErrorCode.INVALID_REQUEST, 'Batch requests are not supported');
  }
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') {
    return failure(null, ErrorCode.INVALID_REQUEST, 'Not a JSON-RPC 2.0 message');
  }
  // A response, not a request: this server issues no requests, so there is nothing to match.
  if (message.method === undefined) return null;

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (isNotification) {
    // Notifications get no reply, whatever they are. Unknown ones are ignored by design —
    // that is how the protocol adds them without breaking older servers.
    return null;
  }

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: negotiate(params?.protocolVersion),
        capabilities: {
          // No listChanged: the tool set is fixed at build time and never varies at runtime.
          tools: {},
        },
        serverInfo: deps.serverInfo,
        instructions: deps.instructions,
      });

    case 'ping':
      return result(id, {});

    case 'tools/list':
      // No pagination: nine tools fit in one response and always will.
      return result(id, { tools: deps.tools });

    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') {
        return failure(id, ErrorCode.INVALID_PARAMS, 'tools/call requires a tool name');
      }
      if (!deps.tools.some((tool) => tool.name === name)) {
        return failure(id, ErrorCode.INVALID_PARAMS, `Unknown tool: ${name}`);
      }
      try {
        return result(id, await deps.callTool(name, params?.arguments ?? {}));
      } catch (error) {
        /*
          A throw that escapes callTool is a bug in this server, not a failed lookup.
          Reported as an error result rather than a JSON-RPC error so the model sees it and
          can say something useful, instead of the client swallowing it silently.
        */
        return result(id, toolText(`The tool "${name}" failed unexpectedly: ${error?.message ?? error}`, true));
      }
    }

    default:
      return failure(id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * Parse one line and answer it, keeping parse failures inside the protocol.
 *
 * A malformed line has no id to answer with, which JSON-RPC says to report against a null
 * id. Doing that rather than crashing keeps one bad line from killing a session.
 *
 * The leading byte-order mark is stripped first. Windows PowerShell prepends one
 * (`ef bb bf`) to anything it pipes into a native command, so the one-liner this project's
 * own guide gives for testing the server by hand fails there with "Invalid JSON" — an
 * error that points at the message rather than at the shell that mangled it. A BOM carries
 * no meaning inside a stream that is already known to be UTF-8, so ignoring one is not
 * interpreting anything ambiguous; it is declining to fail over a byte that says nothing.
 */
export async function handleLine(line, deps) {
  let message;
  try {
    // Written as an escape, not the character itself: a literal BOM in source is invisible
    // and the next person to touch this line would have no way to see it was there.
    message = JSON.parse(line.replace(/^\uFEFF/, ''));
  } catch {
    return failure(null, ErrorCode.PARSE_ERROR, 'Invalid JSON');
  }
  return handle(message, deps);
}
