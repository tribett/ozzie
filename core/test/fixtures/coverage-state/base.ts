import type { CoverageInput } from "../../../src/coverage.js";
import type { CoverageAccess, CoverageState, CoverageTransition } from "../../../src/coverage-state.js";
import { createCoverageState, transitionCoverage } from "../../../src/coverage-state.js";
import { coverageFixture } from "../coverage/base.js";

/** Fictional fixed data only; no authenticated provider recording. */
export const access: CoverageAccess = {
  allowed: true, authorization_id: "authorization-a",
  scope: { workspace_id: "workspace-a", service_type_id: "service-a", plan_id: "plan-a", sunday: "2026-11-22" },
};
export function observation(need = 1): CoverageInput {
  const input = coverageFixture();
  input.positions[0]!.remaining_need.value = need;
  return input;
}
export function stateOf(result: CoverageTransition): CoverageState {
  if (!result.state) throw new Error(`Expected authorized state: ${result.code}`);
  return result.state;
}
export function refresh(state: CoverageState, input = observation(), current = access): CoverageState {
  const generation = state.generation + 1, request_id = `request-${generation}`;
  const pending = stateOf(transitionCoverage(state, current, { type: "refresh-requested", scope: current.scope,
    request_id, generation, origin: generation % 2 ? "on-demand" : "automatic" }));
  return stateOf(transitionCoverage(pending, current, { type: "observation-received", scope: current.scope,
    request_id, generation, input }));
}
export function resolved(choice: "intentional-exception" | "covered-outside-pco" = "intentional-exception"): CoverageState {
  const state = refresh(stateOf(createCoverageState(access)));
  return stateOf(transitionCoverage(state, access, { type: "disposition-recorded", scope: access.scope,
    finding_id: state.findings[0]!.id, choice, reason: "Fictional private decision", actor_id: "leader-a",
    recorded_at: "2026-11-22T12:01:00Z" }));
}
