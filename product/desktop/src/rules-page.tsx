import { useState } from "react";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import type { PositionLabel } from "../../../core/src/sunday-capture.js";
import { roomRules } from "../../../core/src/operations-capture.js";

/**
 * A room's rule, stored with the other rules. "Not shared" is the only room rule, with its setup
 * time; "No rule set" (null) stores nothing, never a "can be shared" rule.
 */
export function withRoomRule(rules: SundayRules, room_id: string, next: { setup_minutes: number } | null): SundayRules {
  return { ...rules, rooms: [...roomRules(rules).filter(r => r.room_id !== room_id), ...(next ? [{ room_id, exclusive: true, setup_minutes: next.setup_minutes }] : [])] };
}

/** Church rules are the church's own settings. Changing one re-checks what was already read; it never reads or writes Planning Center. */
export function RulesPage({ rules, onChange, positions, leaders = {}, names = {}, rooms = [] }: {
  rules: SundayRules; onChange: (r: SundayRules) => void; positions: PositionLabel[];
  /** Team leaders Planning Center lists, by team (null when that read didn't complete). Names resolve on this Mac. */
  leaders?: Record<string, string[] | null>; names?: Record<string, string>;
  /** Rooms Planning Center Calendar listed in the last check. Names are local only. */
  rooms?: { room_id: string; name: string | null }[];
}) {
  const roomRule = (id: string) => roomRules(rules).find(r => r.room_id === id);
  const setRoom = (id: string, next: { setup_minutes: number } | null) => onChange(withRoomRule(rules, id, next));
  const teams = [...new Map(positions.map(p => [p.team_id, positions.filter(x => x.team_id === p.team_id).map(x => x.name)])).entries()];
  // What the person typed, untrimmed, so a space between words survives; the rule itself is stored trimmed.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const leadFor = (team: string) => rules.sundayLeads.find(l => l.team_id === team)?.lead_position ?? "";
  const setLead = (team: string, value: string) => {
    setTyped(t => ({ ...t, [team]: value }));
    onChange({ ...rules, sundayLeads: [...rules.sundayLeads.filter(l => l.team_id !== team), ...(value.trim() ? [{ team_id: team, lead_position: value.trim() }] : [])] });
  };
  const leaderText = (team: string) => {
    const ids = Object.hasOwn(leaders, team) ? leaders[team] : undefined;
    if (ids === undefined) return null;
    if (ids === null) return "This team's leaders couldn't be read from Planning Center.";
    if (!ids.length) return "Planning Center doesn't list a leader for this team.";
    const who = ids.map(id => (Object.hasOwn(names, id) && names[id]) || "someone").join(", ");
    return `Planning Center lists ${who} as ${ids.length === 1 ? "this team's leader" : "this team's leaders"}. That's oversight, not someone scheduled to lead on Sunday.`;
  };
  return <div className="col">
    <p className="eyebrow">Church rules</p>
    <h1 className="h1">How your church wants Sunday checked</h1>
    <p className="lede">These are your church's choices. Changing one updates the Sunday view right away using what was already read. Nothing in Planning Center changes.</p>
    <section className="find">
      <h2 className="h3">Check in after Sundays in a row</h2>
      <p className="find-body">Flag anyone confirmed this many Sundays in a row, so a person can check in. It's about care, not performance.</p>
      <div className="row rule-row">
        <label htmlFor="streak">Sundays in a row</label>
        <input id="streak" type="number" min={0} max={12} value={rules.checkInAfterSundaysInARow}
          onChange={e => onChange({ ...rules, checkInAfterSundaysInARow: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} />
        <span className="small">{rules.checkInAfterSundaysInARow === 0 ? "Off" : `Flag at ${rules.checkInAfterSundaysInARow}`}</span>
      </div>
    </section>
    <section className="find">
      <h2 className="h3">Sunday leads</h2>
      <p className="find-body">If a team should always have a scheduled lead on Sunday, type the lead's position name exactly as it appears in Planning Center. A team leader in Planning Center isn't the same as someone scheduled to lead.</p>
      {teams.length === 0 && <p className="small">Check a Sunday first to see its teams.</p>}
      {teams.map(([team, positionNames]) => <div className="rule-team" key={team}>
        <div className="row rule-row">
          <label htmlFor={`lead-${team}`}>{positionNames.join(", ")} team</label>
          <input id={`lead-${team}`} value={typed[team] ?? leadFor(team)} placeholder="No Sunday lead required" onChange={e => setLead(team, e.target.value)} />
        </div>
        {leaderText(team) && <p className="small rule-note">{leaderText(team)}</p>}
      </div>)}
    </section>
    <section className="find rule-rooms">
      <h2 className="h3">Rooms</h2>
      <p className="find-body">Say which rooms can't hold two things at once, and how much setup time to allow before each booking. Rooms come from Planning Center Calendar; nothing there changes.</p>
      {rooms.length === 0 && <p className="small">Your rooms show here after a Sunday check that includes rooms. Turn that on in Settings.</p>}
      {rooms.map(room => {
        const rule = roomRule(room.room_id), name = room.name ?? "Unnamed room";
        return <div className="row rule-row" key={room.room_id}>
          <label htmlFor={`room-${room.room_id}`}>{name}</label>
          <select id={`room-${room.room_id}`} className="input" value={rule ? "exclusive" : "none"}
            onChange={e => setRoom(room.room_id, e.target.value === "exclusive" ? { setup_minutes: rule?.setup_minutes ?? 0 } : null)}>
            <option value="none">No rule set</option><option value="exclusive">Not shared</option>
          </select>
          <input type="number" min={0} max={240} aria-label={`Setup minutes for ${name}`} value={rule?.setup_minutes ?? 0} disabled={!rule}
            onChange={e => setRoom(room.room_id, { setup_minutes: Math.max(0, Math.min(240, Math.round(Number(e.target.value)) || 0)) })} />
          <span className="small">minutes of setup</span>
        </div>;
      })}
      {rooms.length > 0 && <p className="small">For a room set as not shared, Ozzie counts its setup time before each booking and reads Calendar's own conflict records: an overlap Calendar lists as not yet resolved shows as Room use needs review. Overlaps in a room with no rule set, or that Ozzie can't confirm, show as Worth a look.</p>}
    </section>
  </div>;
}
