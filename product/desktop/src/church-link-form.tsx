// "Add a list from a private link" on Lists & notes: the leader names the list and pastes the link Google Sheets (or
// another site) gives for a sheet published as comma-separated values. The link works like a password: it goes to
// native code once, through church-sources.ts, which keeps it in this Mac's Keychain and shows only where it points.
// This form holds it only while it is typed, hidden as a password is, and lets it go once it has been tried, whatever
// the answer. Nothing here talks to native code itself.
import { useId, useState } from "react";
import { MAX_LABEL } from "../../../core/src/sources/types.js";
import type { ChurchSources } from "./church-sources.js";
import { Icon } from "./icons.js";

export const LINK_TITLE = "Add a list from a private link";
export const LINK_HELP = "In Google Sheets choose File › Share › Publish to web, pick the sheet and Comma-separated values, choose Publish, and copy the link. Anyone with that link can read the sheet, so Ozzie keeps it in this Mac's Keychain and shows only where it points.";
/** Beside the link form, before anything is pasted (audit item 26): who can read a published sheet, and the safer way for names. */
export const LINK_WHO_READS = "A published sheet can be read by anyone who has the link. For a list with people's names, use a file on this Mac instead.";
export const LINK_NAME = "Name this list";
export const LINK_ADDRESS = "The sheet's published link";
export const LINK_ADDRESS_HELP = "Ozzie reads it once now to see that it gives back a sheet, then keeps it in this Mac's Keychain. Each time Ozzie reads the list, it asks that address for the sheet and sends nothing about your church. The site in the link, and any site it sends Ozzie on to, sees when it is read, this Mac's internet address and that the request comes from Ozzie.";
export const ADD_THIS_LIST = "Add this list";
export const READING_LINK = "Reading the link…";
export const NOT_NOW = "Not now";

export function LinkForm({ sources, onDone }: { sources: ChurchSources; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const add = async () => {
    setAdding(true);
    setProblem(null);
    const result = await sources.addLink(label, address);
    setAdding(false);
    // The link leaves this form once it has been tried: it is pasted again rather than kept here.
    setAddress("");
    if ("problem" in result) setProblem(result.problem);
    else { setLabel(""); onDone(); }
  };
  return <form className="find church-link-form" aria-labelledby={`${id}-t`} onSubmit={e => { e.preventDefault(); void add(); }}>
    <h2 id={`${id}-t`} className="settings-t">{LINK_TITLE}</h2>
    <p className="panel-info link-who"><Icon name="info" small /><span>{LINK_WHO_READS}</span></p>
    <p className="find-body">{LINK_HELP}</p>
    <div className="own-field">
      <label className="field-l" htmlFor={`${id}-name`}>{LINK_NAME}</label>
      <input id={`${id}-name`} className="input own-name" value={label} maxLength={MAX_LABEL * 2} autoComplete="off" spellCheck={false} placeholder="Snack rota"
        onChange={e => setLabel(e.target.value)} />
    </div>
    <div className="own-field">
      <label className="field-l" htmlFor={`${id}-link`}>{LINK_ADDRESS}</label>
      <input id={`${id}-link`} className="input own-link" type="password" value={address} autoComplete="off" spellCheck={false} placeholder="https://…"
        aria-describedby={`${id}-help`} onChange={e => setAddress(e.target.value)} />
      <p id={`${id}-help`} className="input-help">{LINK_ADDRESS_HELP}</p>
    </div>
    <div className="row form-actions">
      <button type="submit" className="btn btn-primary" disabled={adding || !label.trim() || !address.trim()}>
        {adding ? <><Icon name="spinner" small spin />{READING_LINK}</> : ADD_THIS_LIST}</button>
      <button type="button" className="btn btn-quiet" disabled={adding} onClick={() => { setAddress(""); onDone(); }}>{NOT_NOW}</button>
    </div>
    {problem && <p role="alert" className="problem">{problem}</p>}
  </form>;
}
