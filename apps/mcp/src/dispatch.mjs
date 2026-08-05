/**
 * Running one tool: validate the arguments, fetch what it planned, render the answer.
 *
 * Two kinds of failure, handled differently on purpose.
 *
 * A *required* endpoint that cannot be read fails the whole call, and the model is told in
 * words why. Anything else would hand it an empty object, and an assistant given an empty
 * object answers the question anyway, out of nothing.
 *
 * An *optional* endpoint is one that may legitimately not exist on a given install —
 * there is no wall charger on a house without an EV. Those failures leave their section
 * absent and add a note saying which read failed, so "you have no charger" and "I could
 * not ask about your charger" stay distinguishable. They are not the same answer.
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
