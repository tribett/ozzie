import { invoke } from "@tauri-apps/api/core";
import { connection, type ConnectionStatus } from "./connection.js";
import { model } from "./model.js";
import { sundaySource, type Settings } from "./sunday-source.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { acceptModelReply, buildRewordRequest, templateDraft } from "../../../core/src/draft-request.js";
import { acceptAskReply, AskSession, buildAskContext, prepareAsk, restoreAnswer } from "../../../core/src/ask.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";

/**
 * Debug builds only (OZZIE_DEV_AUTOPILOT=1): runs the live flow through the real code paths and
 * reports each step to the developer's terminal. Lines carry counts and codes only, never names.
 */
const log = (line: string) => invoke("dev_log", { line }).catch(() => undefined);
const code = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e) ?? "unknown").slice(0, 160);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function runAutopilot(settings: Settings, rules: SundayRules, operations: boolean, show: (c: SundayCapture) => void) {
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

    const route = await model.setRoute("managed");
    await log(`model: configured=${route.configured} route=${route.route}`);

    const capture = await sundaySource.check(settings.serviceTypeId, settings.planId);
    show(capture);
    const ops = sundayOperations(capture, rules);
    await log(`operations: ${ops ? `findings=${ops.result?.findings.map(f => f.kind + ":" + f.certainty).join(",") || "none"} group_meetings=${ops.group_meetings.length} not_checked=${ops.not_checked.length}` : "none"}`);
    const outcomes = capture.reads.reduce<Record<string, number>>((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] ?? 0) + 1 }), {});
    await log(`check: reads=${capture.reads.length} outcomes=${JSON.stringify(outcomes)} names=${Object.keys(capture.names).length}`);
    const brief = buildSundayBrief(capture, rules, new Date().toISOString());
    await log(`brief: status=${brief.status} findings=${brief.findings.map(f => f.kind + (f.people ? `[s${f.people.suggestions.length}/c${f.people.conflicts.length}/u${f.people.unverified.length}/x${f.people.left_out.length}]` : "")).join(",")}`);

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
    if (!need || !route.configured) { await log("reword: skipped"); return; }
    const ctx = { finding: need, person_id: need.people!.suggestions[0]!.person_id };
    const draft = templateDraft(ctx, capture.names);
    try {
      const reply = await model.reword(buildRewordRequest(draft, "warmer", capture.names));
      const next = acceptModelReply(reply, draft, capture.names);
      await log(`reword: ok chars=${next.text.length} volunteer_label=${next.text.includes("[Volunteer A]")}`);
    } catch (e) { await log(`reword: refused ${code(e)}`); }
  } catch (e) {
    await log(`error: ${code(e)}`);
  } finally {
    await log("done");
  }
}
