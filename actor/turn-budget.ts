// libfx leaves step budgets to the host. Without this cap, a turn that keeps calling
// tools would run, and bill, until someone stops it. Ported from lib/turn-budget.ts on
// fx0's main branch, which kept the count in Redis; here it is counted from the request.
import type { FxFetch } from "libfx";

export const MAX_TURN_MODEL_STEPS = 64;
export const STEP_LIMIT = `Turn stopped after ${MAX_TURN_MODEL_STEPS} model steps. Send a message to continue.`;

// libfx sends the body as bytes, not a string.
function requestJson(body: unknown): unknown {
  try {
    if (typeof body === "string") return JSON.parse(body);
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body));
  } catch { /* libfx validates its own body */ }
  return null;
}

// Model requests of this turn so far, counting this one: the assistant messages after
// the last user message, plus one. The conversation is the count, so it survives a
// sandbox restart with no state of its own. A steer is a user message, so it resets it.
export function turnModelStep(body: unknown): number {
  const prompt = (body as { prompt?: unknown } | null)?.prompt;
  if (!Array.isArray(prompt)) return 1;
  let steps = 1;
  for (let index = prompt.length - 1; index >= 0; index--) {
    const role = (prompt[index] as { role?: unknown } | null)?.role;
    if (role === "user") break;
    if (role === "assistant") steps++;
  }
  return steps;
}

// The step past the limit fails with fx0's message, which ends the turn with it.
export function stepLimitedFetch(fetch: FxFetch): FxFetch {
  return async (input, init) => {
    const modelRequest = (init.method ?? "GET").toUpperCase() === "POST" && new URL(input).pathname.endsWith("/language-model");
    if (modelRequest && turnModelStep(requestJson(init.body)) > MAX_TURN_MODEL_STEPS) {
      return Response.json({ error: { message: STEP_LIMIT } }, { status: 400 });
    }
    return fetch(input, init);
  };
}
