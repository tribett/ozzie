import { useEffect, useId, useState } from "react";
import { keychainCommand, managedNotice, managedProblem, model, noPlan, offlineLine, planName, routeBadge, routeProblem, routeStatusLine, usageLine, type ModelStatus } from "./model.js";
import { Icon } from "./icons.js";

type Route = "managed" | "own" | "local";
const routes: { id: Route; title: string; body: string }[] = [
  { id: "managed", title: "Ozzie managed", body: "Through ozzie.church, with zero data retention required on every request. Your church's plan includes a monthly allowance of AI help, and nothing charges itself." },
  { id: "own", title: "Your own AI provider", body: "Any OpenAI-compatible service, with your key in this Mac's Keychain under an account named for the provider's address, such as “own-provider:api.example.com”. A key saved for one address is never sent to another." },
  { id: "local", title: "A model on this Mac", body: "Ollama or LM Studio running locally. Nothing leaves this Mac." },
];
/** Ozzie managed before this Mac is connected: an account is needed, and managed plans aren't open to everyone yet. */
const NEEDS_ACCOUNT = "Needs an Ozzie managed account. Managed plans are coming soon.";
const COMING_SOON = "Managed plans through ozzie.church are coming soon. You can connect this Mac later under Settings.";

/** What the chosen route still needs, in plain words, with the Terminal command that saves its key when one is missing. */
export function SetupNeeds({ status }: { status: ModelStatus | null }) {
  if (!status || !status.setup || status.setup === "ready" || status.setup === "no-route" || !status.key_account) return null;
  const command = keychainCommand(status.key_account);
  return <div className="panel-info" role="note"><Icon name="info" /><div className="stack-tight">
    {status.setup === "own-key-not-bound"
      ? <p>Your provider's key is saved under the old Keychain account “own-provider”, which isn't tied to an address, so Ozzie won't use it. Save it again under “{status.key_account}”.</p>
      : <p>Ozzie needs this route's key in this Mac's Keychain, under the account “{status.key_account}”.</p>}
    <p>In Terminal, run this command. It asks for the key at a hidden prompt, so the key is never typed on the command line and Ozzie never sees it:</p>
    <p className="mono"><code>{command}</code></p>
    <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void navigator.clipboard?.writeText(command); }}>Copy command</button></div>
  </div></div>;
}

/**
 * Ozzie managed on this Mac, under its row: the church's plan and usage in plain words, the notice at three quarters,
 * nine tenths or paused, where the numbers came from when ozzie.church couldn't be reached, and a connection that has
 * ended. Nothing when this Mac isn't connected.
 */
export function ManagedDetails({ status }: { status: ModelStatus | null }) {
  if (status?.managed === "reconnect") {
    return <div className="route-fields"><div className="panel-warn" role="note"><Icon name="info" small />
      <p>This Mac's connection to Ozzie managed has ended, so AI help through ozzie.church is off. Connect again to keep using it.</p></div></div>;
  }
  if (status?.managed !== "connected") return null;
  const account = status.account;
  if (!account) return <div className="route-fields"><p className="route-d">This Mac is connected. Ozzie couldn't check this month's usage just now.</p></div>;
  const notice = managedNotice(account);
  return <div className="route-fields">
    {/* With no plan the usage line says so itself ("No plan right now…"), so no plan name before it. */}
    <p className="route-d">{!noPlan(account) && <><strong>{planName(account.plan)} plan.</strong> </>}{usageLine(account)}</p>
    {account.offline && <p className="route-d">{offlineLine(account)}</p>}
    {notice && <div className={account.warning === "paused" ? "panel-warn" : "panel-info"} role="status"><Icon name="info" small /><p>{notice}</p></div>}
  </div>;
}

/**
 * AI help: rewording drafts and Ask Ozzie use AI; both send placeholders like [Volunteer A] or [Person 1] instead of the names Ozzie
 * read from Planning Center. Each route is one row with its actions; your own provider's address and model show only
 * under that row, and Ozzie managed's plan and usage under its own. `preview` (first-run setup): Ozzie managed shows as
 * coming soon unless this Mac is already connected.
 */
export function AiSettings({ onChange, labelledBy, preview = false }: { onChange: (configured: boolean) => void; labelledBy?: string; preview?: boolean }) {
  const id = useId();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [own, setOwn] = useState({ baseUrl: "", model: "" });
  const [ownOpen, setOwnOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => { model.status().then(setStatus).catch(() => setStatus(null)); }, []);
  const shown = (s: ModelStatus) => { setStatus(s); onChange(s.configured); };
  const choose = (route: Route) => {
    setProblem("");
    model.setRoute(route, route === "own" ? own.baseUrl : undefined, route === "own" ? own.model : undefined)
      .then(s => { shown(s); if (route === "own") setOwnOpen(false); })
      .catch(e => setProblem(routeProblem(e)));
  };
  // Connecting means using it: once connected, Ozzie managed becomes the route.
  const connect = () => {
    setProblem("");
    setConnecting(true);
    model.connect()
      .then(() => model.setRoute("managed").then(shown, e => setProblem(routeProblem(e))), e => setProblem(managedProblem(e)))
      .finally(() => setConnecting(false));
  };
  const disconnect = () => {
    setProblem("");
    model.disconnect().then(shown).catch(e => setProblem(managedProblem(e)));
  };
  const managed = status?.managed;
  const soon = preview && managed !== "connected";
  return <div className="find ai-settings" role="group" aria-labelledby={labelledBy}>
    <p className="find-body">Ozzie can reword a draft note, answer questions about the Sunday it checked, look at who could help with a role from a Sunday card, and write a short summary of what a job you set up found, as often as its plan allows. The AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center, and it never sends anything. Ozzie can't recognise names it never read, so don't type other people's details into a question.</p>
    <p className="bold" role="status">{routeStatusLine(status)}</p>
    <SetupNeeds status={status} />
    <ul className="routes">{routes.map(r => {
      const selected = status?.route === r.id;
      const badge = routeBadge(status, r.id);
      const editing = r.id === "own" && ownOpen;
      const title = r.id === "managed" && soon ? "Ozzie managed (coming soon)" : r.title;
      const body = r.id !== "managed" ? r.body : soon ? COMING_SOON : managed === "connected" ? r.body : `${r.body} ${NEEDS_ACCOUNT}`;
      return <li key={r.id} className={`route${selected ? " is-sel" : ""}`}>
        <div className="route-main">
          <div className="route-text">
            <p className="route-t" id={`${id}-${r.id}`}>{title}{badge && <span className={`badge ${badge.tone === "ok" ? "b-ok" : badge.tone === "look" ? "b-look" : "b-muted"}`}>
              {badge.tone === "ok" && <Icon name="check" small />}{badge.text}</span>}</p>
            <p className="route-d">{body}</p>
          </div>
          {r.id === "own"
            ? <button type="button" className="btn btn-secondary btn-sm" aria-expanded={ownOpen} aria-describedby={`${id}-${r.id}`} onClick={() => setOwnOpen(!ownOpen)}>
              {ownOpen ? "Close" : selected ? "Change provider" : "Set up"}</button>
            : r.id === "managed" ? <ManagedActions status={status} selected={selected} soon={soon} connecting={connecting} describedBy={`${id}-${r.id}`}
              onUse={() => choose("managed")} onConnect={connect} onCancel={() => { void model.cancelConnect().catch(() => undefined); }} onDisconnect={disconnect} />
            : !selected && <button type="button" className="btn btn-secondary btn-sm" aria-describedby={`${id}-${r.id}`} onClick={() => choose(r.id)}>Use this</button>}
        </div>
        {r.id === "managed" && !soon && <ManagedDetails status={status} />}
        {editing && <div className="route-fields">
          <div className="field">
            <label htmlFor="own-url">Provider address</label>
            <input id="own-url" className="input" placeholder="https://…/v1" value={own.baseUrl} autoComplete="off" spellCheck={false} onChange={e => setOwn({ ...own, baseUrl: e.target.value.trim() })} />
          </div>
          <div className="field">
            <label htmlFor="own-model">Model name</label>
            <input id="own-model" className="input" value={own.model} autoComplete="off" spellCheck={false} onChange={e => setOwn({ ...own, model: e.target.value.trim() })} />
          </div>
          <div><button type="button" className="btn btn-primary btn-sm" disabled={!own.baseUrl} onClick={() => choose("own")}>Use this provider</button></div>
        </div>}
      </li>;
    })}</ul>
    {problem && <p role="alert" className="problem">{problem}</p>}
  </div>;
}

/**
 * Ozzie managed's actions, by where this Mac stands: not known yet (choose it, as any route), not connected ("Connect
 * to Ozzie managed"), waiting for the browser ("Cancel"), connected ("Use this" if another route is in use, and
 * "Disconnect this Mac"), or no longer accepted ("Connect again"). Coming soon in first-run setup: none.
 */
export function ManagedActions({ status, selected, soon, connecting, describedBy, onUse, onConnect, onCancel, onDisconnect }: {
  status: ModelStatus | null; selected: boolean; soon: boolean; connecting: boolean; describedBy: string;
  onUse: () => void; onConnect: () => void; onCancel: () => void; onDisconnect: () => void;
}) {
  if (soon) return null;
  if (connecting) {
    return <div className="row form-actions"><span className="small" role="status">Waiting for you to finish in your browser…</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Cancel</button></div>;
  }
  if (!status) return selected ? null : <button type="button" className="btn btn-secondary btn-sm" aria-describedby={describedBy} onClick={onUse}>Use this</button>;
  if (status.managed === "connected") {
    return <div className="row form-actions">
      {!selected && <button type="button" className="btn btn-secondary btn-sm" aria-describedby={describedBy} onClick={onUse}>Use this</button>}
      <button type="button" className="btn btn-quiet btn-sm" aria-describedby={describedBy} onClick={onDisconnect}>Disconnect this Mac</button>
    </div>;
  }
  return <button type="button" className="btn btn-secondary btn-sm" aria-describedby={describedBy} onClick={onConnect}>
    {status.managed === "reconnect" ? "Connect again" : "Connect to Ozzie managed"}</button>;
}
