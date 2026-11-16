// Settings › Planning Center: People forms, Check-Ins and Registrations, each its own choice. Check-Ins and
// Registrations each sign in again and ask Planning Center for that product only when the person chooses it;
// a connection made before keeps working and these simply aren't read until allowed. People forms use the
// People access already asked for with rooms, follow-ups and group events; which forms to watch is chosen on
// Church rules. Ozzie only reads, and only counts and names of forms, rooms and signups (on this Mac).
import { granted, moreOf, operationsGranted, type ConnectionStatus, type MoreProducts } from "./connection.js";
import type { ConnectionControl } from "./planning-center-forms.js";

export const MORE_COPY = {
  forms: {
    title: "People forms",
    body: "Ozzie can tell you how many new submissions came in on the People forms you choose, and who sent them. It never reads the answers people gave.",
  },
  checkIns: {
    title: "Check-Ins",
    body: "Ozzie can read how many checked in to each room at last Sunday's times (regular, guest and volunteer, as Planning Center counts them), so you can compare a room with your kids rules. Counts only: it never reads children's names or who checked in.",
    on: "Also read Check-Ins counts", off: "Stop reading Check-Ins counts",
  },
  registrations: {
    title: "Registrations",
    body: "Ozzie can list upcoming signups, how many registered against the limit, and when registration closes. Counts only: it never reads who registered.",
    on: "Also read signup counts", off: "Stop reading signup counts",
  },
} as const;

/** What each choice's status line says, from what Planning Center granted (null until the connection was checked). */
export function moreStatus(status: Pick<ConnectionStatus, "scopes"> | null): { forms: string; checkIns: string; registrations: string } {
  const g = granted(status);
  if (!g) {
    const unknown = "What's allowed shows here once the connection has been checked.";
    return { forms: unknown, checkIns: unknown, registrations: unknown };
  }
  return {
    forms: g.operations ? "People is allowed. Choose which forms to watch on Church rules." : "Needs People: turn on rooms, follow-ups and group events above.",
    checkIns: g.checkIns ? "Allowed: Ozzie reads Check-Ins counts on each check." : "Not connected for this yet.",
    registrations: g.registrations ? "Allowed: Ozzie reads signup counts on each check." : "Not connected for this yet.",
  };
}

export function MoreFromPlanningCenter({ status, control }: { status: ConnectionStatus | null; control: ConnectionControl }) {
  const { canSignIn, working, pending, run } = control;
  const g = granted(status);
  const lines = moreStatus(status);
  // Signing in again asks for everything already allowed, with this one choice changed.
  const ask = (change: MoreProducts) => { void run(() => control.signIn(operationsGranted(status), { ...moreOf(status), ...change }), "more"); };
  const choice = (key: "checkIns" | "registrations") => {
    const on = g?.[key] === true, copy = MORE_COPY[key];
    return <div className="more-choice" key={key}>
      <h4 className="bold">{copy.title}</h4>
      <p className="find-body">{copy.body}</p>
      <p className="checkline granted">{lines[key]}</p>
      <div className="row form-actions">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!canSignIn || working || pending} onClick={() => ask({ [key]: !on })}>{on ? copy.off : copy.on}</button>
      </div>
    </div>;
  };
  return <section className="find" aria-labelledby="more-pco-title">
    <h3 id="more-pco-title" className="settings-t">Forms, check-ins and signups</h3>
    <p className="find-body">Each of these is its own choice. Check-Ins and Registrations sign in again and ask Planning Center for that access; Planning Center grants it as read-and-write, and Ozzie only reads. Until you allow one, Ozzie simply doesn't read it.</p>
    <div className="more-choice">
      <h4 className="bold">{MORE_COPY.forms.title}</h4>
      <p className="find-body">{MORE_COPY.forms.body}</p>
      <p className="checkline granted">{lines.forms}</p>
    </div>
    {choice("checkIns")}
    {choice("registrations")}
    {control.problem?.from === "more" && <p role="alert" className="problem">{control.problem.text}</p>}
  </section>;
}
