/**
 * Running one tool: validate the arguments, fetch what it planned, render the answer.
 *
 * A *required* endpoint that cannot be read fails the whole call, with the reason in words;
 * an empty object would be answered from nothing. An *optional* endpoint may legitimately
 * not exist on an install — no wall charger without an EV — so its failure leaves the section
 * absent plus a note, keeping "you have no charger" and "I could not ask" distinguishable.
 */

import { DashboardError } from './dashboard.mjs';
import { toolText } from './protocol.mjs';
import { ArgumentError, findTool } from './tools.mjs';

export function createCallTool({ client, clock = Date.now }) {
  return async function callTool(name, rawArgs) {
    const tool = findTool(name);
    if (!tool) return toolText(`Unknown tool: ${name}`, true);

    let args;
    try {
      args = tool.args ? tool.args(rawArgs ?? {}) : {};
    } catch (error) {
      if (error instanceof ArgumentError) {
        return toolText(`That argument will not work: ${error.message}`, true);
      }
      throw error;
    }

    const specs = tool.plan(args);
    // allSettled, not all: a rejection inside Promise.all leaves its siblings unhandled,
    // and an unhandled rejection in a stdio server is a silent death.
    const settled = await Promise.allSettled(specs.map((spec) => client.get(spec.path)));

    const data = {};
    const notes = [];
    for (const [index, spec] of specs.entries()) {
      const outcome = settled[index];
      if (outcome.status === 'fulfilled') {
        data[spec.key] = outcome.value;
        continue;
      }
      const reason =
        outcome.reason instanceof DashboardError ? outcome.reason.message : String(outcome.reason?.message ?? outcome.reason);
      if (!spec.optional) return toolText(reason, true);
      notes.push(`Note: ${spec.path} could not be read, so that section is missing rather than empty. ${reason}`);
    }

    const body = tool.render(data, clock(), args);
    return toolText(notes.length ? `${body}\n\n${notes.join('\n')}` : body);
  };
}
