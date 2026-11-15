import { invoke } from "@tauri-apps/api/core";
import { connection, type ConnectionStatus } from "./connection.js";
import { model } from "./model.js";
import { sundaySource, type Settings } from "./sunday-source.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { acceptModelReply, buildRewordRequest, templateDraft } from "../../../core/src/draft-request.js";
import { acceptAskReply, AskSession, buildAskContext, prepareAsk, restoreAnswer } from "../../../core/src/ask.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { BACKGROUND_CHECKS, kidsTeams } from "../../../core/src/kids-rules.js";
import type { TaskOutcome } from "../../../core/src/harness/contract.js";
import { ASK_SKILL, type HarnessData } from "../../../core/src/harness/index.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { agentStep, buildHarnessData, createAppHarness, procedures, type LedgerRecorder, type LoopChoice } from "./harness-bridge.js";
import type { ModelStep } from "../../../core/src/harness/contract.js";
import { parseRequest } from "../../../core/src/harness/responsibilities.js";
import type { Runner } from "./responsibility-runner.js";

/**
 * Debug builds only (OZZIE_DEV_AUTOPILOT=1): runs the live flow through the real code paths and
 * reports each step to the developer's terminal. Lines carry counts and codes only, never names.
 */
const log = (line: string) => invoke("dev_log", { line }).catch(() => undefined);
const code = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e) ?? "unknown").slice(0, 160);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What the harness steps need from the app: its ledger recorder and the loop chosen for this debug build. */
export interface AutopilotHarness { recorder: LedgerRecorder; loop: LoopChoice }
const toolCount = (o: TaskOutcome) => o.events.filter(e => e.type === "tool").length;
const stepCount = (o: TaskOutcome) => o.events.filter(e => e.type === "model").length;

/**
 * Ask Ozzie and the Sunday ready procedure through the real harness and native agent_step, recorded in
 * the ledger like the app's own tasks. Lines carry status, codes and counts only: never question or answer text.
 */
async function harnessSteps(settings: Settings, rules: SundayRules, status: ConnectionStatus, capture: SundayCapture, show: (c: SundayCapture) => void, opts: AutopilotHarness) {
  const { recorder, loop } = opts;
  const skills = await procedures();
  const dataFor = (c: SundayCapture): HarnessData =>
    buildHarnessData({ capture: c, fictional: false, rules, decisions: [], status, configured: true, now: new Date().toISOString() }, refresh);
  const refresh = async (): Promise<HarnessData> => {
    const next = await recorder.check(() => sundaySource.check(settings.serviceTypeId, settings.planId), "manual");
    show(next);
    return dataFor(next);
  };
  // Debug only: the final reply's shape (answer kind and fact count, or the refusal code) — never its content.
  let shape = "-";
  const base = agentStep();
  const step: ModelStep = async (request, signal) => {
    try {
      const reply = await base(request, signal);
      if (!reply.tool_calls.length) {
        try { const j = JSON.parse(reply.content.trim().replace(/^```(?:json)?\s*|\s*```$/gu, "")) as { answer?: unknown; facts?: unknown };
          shape = `${typeof j.answer === "string" ? j.answer.replace(/[^a-z-]/gu, "") : "?"}:${Array.isArray(j.facts) ? j.facts.length : 0}`; }
        catch { shape = `unparsed:${reply.content.length}`; }
      }
      return reply;
    } catch (e) { shape = `refused:${String((e as { code?: unknown }).code ?? "?").replace(/[^a-z-]/gu, "")}`; throw e; }
  };
  const h = createAppHarness({ workspace_id: settings.organization || "this-mac", data: dataFor(capture), skills, session: new HarnessSession(), loop, recorder, step });
  await log(`harness: runtime=${loop}`);
  for (const question of ["Who could cover the open Greeter spot this Sunday?", "What still needs a decision before Sunday?"]) {
    const observer = recorder.task("ask", ASK_SKILL);
    const result = await h.ask(question, { onEvent: observer.onEvent });
    if (!result.ok) { await log("harness: ask status=refused code=- tools=0 steps=0 chars=0"); continue; }
    const o = result.outcome;
    const chars = o.status === "verified" && o.answer ? h.restore(o.answer).length : 0;
    await log(`harness: ask status=${o.status} code=${o.code ?? "-"} tools=${toolCount(o)} steps=${stepCount(o)} chars=${chars}`);
  }
  const observer = recorder.task("skill", "sunday-ready");
  const ready = await h.runSkill("sunday-ready", { onEvent: observer.onEvent });
  await log(`harness: skill sunday-ready status=${ready.status} code=${ready.code ?? "-"} tools=${toolCount(ready)} steps=${stepCount(ready)} shape=${shape}`);
  await recorder.idle();
  const rows = await recorder.list(50);
  await log(rows ? `ledger: tasks=${rows.length} last=${rows[0]?.state ?? "-"}` : "ledger: unavailable");
}

/**
 * Debug builds only (OZZIE_DEV_KIDS_TEAMS, validated natively as `team_id:min` pairs): the autopilot run marks these
 * teams as kids teams on top of the saved Church rules. Nothing is saved; release builds never send a value.
 */
export function devKidsRules(rules: SundayRules, spec: string | undefined): SundayRules {
  if (!spec) return rules;
  const kidsTeams = spec.split(",").flatMap(pair => {
    const [team_id, min] = pair.split(":");
    return team_id && min ? [{ team_id, min_confirmed: Number(min) }] : [];
  });
  return kidsTeams.length ? { ...rules, kidsTeams } : rules;
}

export async function runAutopilot(settings: Settings, rules: SundayRules, operations: boolean, show: (c: SundayCapture) => void, harness?: AutopilotHarness) {
  try {
    await log("start");
    let status: ConnectionStatus | null = await connection.status();
    if (status?.state !== "connected") {
      try { status = await connection.refresh(settings.clientId, settings.organization, true); }
      catch (e) { await log(`saved connection unusable: ${code(e)}`); }
    }
    if (status?.state !== "connected") {
      await log("connecting: browser sign-in opened");
      await connection.connect(settings.clientId, settings.organization, true);
      for (let i = 0; i < 150 && status?.state !== "connected" && status?.state !== "failed" && status?.state !== "expired"; i++) {
        await wait(2000);
        status = await connection.status();
      }
    }
    if (operations && status?.state === "connected" && status.scopes !== "services-and-operations") {
      await log("connecting with rooms, follow-ups and group events: browser sign-in opened");
      await connection.connect(settings.clientId, settings.organization, true, true);
      status = await connection.status();
      for (let i = 0; i < 150 && status?.state !== "connected" && status?.state !== "failed" && status?.state !== "expired"; i++) {
        await wait(2000);
        status = await connection.status();
      }
    }
    await log(`connection: ${status?.state ?? "none"} org=${status?.organization ?? "-"} scopes=${status?.scopes ?? "-"}`);
    if (status?.state !== "connected") return;

    // The setup picker's two read-only lists: counts and outcomes only, never a name or title.
    try {
      const types = await sundaySource.serviceTypes();
      const plans = settings.serviceTypeId ? await sundaySource.upcomingPlans(settings.serviceTypeId) : null;
      await log(`picker: service_types=${types.items.length} more=${types.more} upcoming_plans=${plans ? plans.items.length : "-"} ` +
        `more=${plans ? plans.more : "-"} has_current_plan=${plans ? plans.items.some(p => p.id === settings.planId) : "-"}`);
    } catch (e) { await log(`picker: error ${code(e)}`); }

    const route = await model.setRoute("managed");
    await log(`model: configured=${route.configured} route=${route.route}`);

    const read = () => sundaySource.check(settings.serviceTypeId, settings.planId, rules);
    const capture = harness ? await harness.recorder.check(read, "manual") : await read();
    show(capture);
    const ops = sundayOperations(capture, rules);
    await log(`operations: ${ops ? `findings=${ops.result?.findings.map(f => f.kind + ":" + f.certainty).join(",") || "none"} group_meetings=${ops.group_meetings.length} not_checked=${ops.not_checked.length}` : "none"}`);
    const outcomes = capture.reads.reduce<Record<string, number>>((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] ?? 0) + 1 }), {});
    await log(`check: reads=${capture.reads.length} outcomes=${JSON.stringify(outcomes)} names=${Object.keys(capture.names).length}`);
    const brief = buildSundayBrief(capture, rules, new Date().toISOString());
    await log(`brief: status=${brief.status} findings=${brief.findings.map(f => f.kind + (f.people ? `[s${f.people.suggestions.length}/c${f.people.conflicts.length}/u${f.people.unverified.length}/x${f.people.left_out.length}]` : "")).join(",")}`);
    // Kids rules: counts and fixed states only, never a name, id or a background check's details.
    const checks = capture.reads.filter(r => r.collection === BACKGROUND_CHECKS);
    const kidsFound = brief.findings.filter(f => f.kind === "too-few-confirmed" || f.kind === "background-check");
    await log(`kids: teams=${kidsTeams(rules).length} background_reads=${checks.length} outcomes=${JSON.stringify(checks.reduce<Record<string, number>>((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] ?? 0) + 1 }), {}))} ` +
      `rows=${checks.reduce((n, r) => n + (Array.isArray(r.body?.data) ? r.body.data.length : 0), 0)} findings=${kidsFound.map(f => `${f.kind}:${f.tone}${f.check ? `:${f.check}` : ""}`).join(",") || "none"} ` +
      `not_checked=${brief.not_checked.filter(l => /kids|background/i.test(l)).length}`);

    // Same-data fallback: the latest saved recording for this org and plan must load and give the same findings.
    const saved = (await sundaySource.recordings(settings.organization)).filter(r => r.plan_id === settings.planId);
    if (saved[0]) {
      const recording = await sundaySource.loadRecording(settings.organization, saved[0].path_id);
      const again = buildSundayBrief(recording, rules, new Date().toISOString());
      const same = JSON.stringify(again.findings) === JSON.stringify(brief.findings);
      await log(`recording: saved=${saved.length} kind=${recording.kind} reads=${recording.reads.length} same_findings=${same}`);
    } else await log("recording: none saved");

    // Ask Ozzie through the real route: log only whether each question passed every check, never text.
    if (route.configured) {
      const session = new AskSession();
      const context = buildAskContext(session, { brief, names: capture.names, organization: capture.organization, decisions: [] });
      for (const question of ["Who could cover the open Greeter spot this Sunday?", "What still needs a decision before Sunday?"]) {
        if (!context) { await log("ask: no context"); break; }
        const prepared = prepareAsk(session, context, question);
        if (!prepared.ok) { await log("ask: refused before sending"); continue; }
        try {
          const reply = await model.ask(prepared.asked.request);
          const answer = restoreAnswer(acceptAskReply(reply, prepared.asked), "");
          await log(`ask: ok chars=${JSON.stringify(answer).length}`);
        } catch (e) { await log(`ask: refused ${code(e)}`); }
      }
    }

    const need = brief.findings.find(f => f.kind === "needs-people" && f.people?.suggestions.length);
    if (!need || !route.configured) await log("reword: skipped");
    else {
      const ctx = { finding: need, person_id: need.people!.suggestions[0]!.person_id };
      const draft = templateDraft(ctx, capture.names);
      try {
        const reply = await model.reword(buildRewordRequest(draft, "warmer", capture.names));
        const next = acceptModelReply(reply, draft, capture.names);
        await log(`reword: ok chars=${next.text.length} volunteer_label=${next.text.includes("[Volunteer A]")}`);
      } catch (e) { await log(`reword: refused ${code(e)}`); }
    }

    if (harness) await harnessSteps(settings, rules, status, capture, show, harness);
  } catch (e) {
    await log(`error: ${code(e)}`);
  } finally {
    await log("done");
  }
}

/**
 * Debug builds only, after the live flow: a "Keep Sunday covered" responsibility from a typed request,
 * confirmed (the autopilot presses "Looks good — start it" for the developer), its first run, and a
 * limit probe (a second run straight after is refused natively). The runner itself writes the
 * name-free lines: `responsibility: created template=… lifetime=…`, `responsibility: run status=… code=…
 * noticed=<n> drafts=<n>`, `responsibility: begin refused=<code>`. On a normal schedule the probe's
 * responsibility is then stopped; with OZZIE_DEV_FAST_SCHEDULE=1 it is left running for live testing.
 */
export async function responsibilityAutopilot(runner: Runner, zone: () => string, sunday: () => string | null, fast: boolean) {
  try {
    await log("responsibility: start");
    const parsed = parseRequest("Keep an eye on Sunday for me", new Date().toISOString(), zone(), { sunday: sunday() });
    if (parsed.kind !== "plan") { await log(`responsibility: parsed kind=${parsed.kind}`); return; }
    const created = await runner.create(parsed.plan);
    // create queued the first run; this tick waits for it.
    await runner.tick();
    const probe = await runner.runNow(created.id);
    if (probe.status !== "refused") await log(`responsibility: probe status=${probe.status}`);
    if (fast) await log("responsibility: left running on the fast schedule");
    else { await runner.stop(created.id); await log("responsibility: stopped after the probe"); }
  } catch (e) {
    await log(`responsibility: error ${code(e)}`);
  }
}
