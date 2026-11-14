import { useEffect, useId, useState } from "react";
import { keychainCommand, model, routeProblem, type ModelStatus } from "./model.js";
import { Icon } from "./icons.js";

type Route = "managed" | "own" | "local";
const routes: { id: Route; title: string; body: string }[] = [
  { id: "managed", title: "Ozzie managed", body: "Through Vercel AI Gateway with zero data retention required on every request. Needs the Ozzie gateway key in this Mac's Keychain (account “vercel-ai-gateway”)." },
  { id: "own", title: "Your own AI provider", body: "Any OpenAI-compatible service, with your key in this Mac's Keychain under an account named for the provider's address, such as “own-provider:api.example.com”. A key saved for one address is never sent to another." },
  { id: "local", title: "A model on this Mac", body: "Ollama or LM Studio running locally. Nothing leaves this Mac." },
];

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
 * Wording help and Ask Ozzie use AI; both send placeholders like [Volunteer A] or [Person 1] instead of the names Ozzie
 * read from Planning Center. Each route is one row with one action; your own provider's address and model show only
 * under that row.
 */
export function AiSettings({ onChange, labelledBy }: { onChange: (configured: boolean) => void; labelledBy?: string }) {
  const id = useId();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [own, setOwn] = useState({ baseUrl: "", model: "" });
  const [ownOpen, setOwnOpen] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => { model.status().then(setStatus).catch(() => setStatus(null)); }, []);
  const choose = (route: Route) => {
    setProblem("");
    model.setRoute(route, route === "own" ? own.baseUrl : undefined, route === "own" ? own.model : undefined)
      .then(s => { setStatus(s); onChange(s.configured); if (route === "own") setOwnOpen(false); })
      .catch(e => setProblem(routeProblem(e)));
  };
  return <div className="find ai-settings" role="group" aria-labelledby={labelledBy}>
    <p className="find-body">Ozzie can reword a draft note and answer questions about the Sunday it checked. The AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center, and it never sends anything. Ozzie can't recognise names it never read, so don't type other people's details into a question.</p>
    <p className="bold" role="status">{status?.configured ? `Using: ${status.label}` : status && status.route !== "none" ? `Chosen: ${status.label}. Not ready yet.` : "Not set up. Drafts still work; only rewording and questions are off."}</p>
    <SetupNeeds status={status} />
    <ul className="routes">{routes.map(r => {
      const selected = status?.route === r.id;
      const editing = r.id === "own" && ownOpen;
      return <li key={r.id} className={`route${selected ? " is-sel" : ""}`}>
        <div className="route-main">
          <div className="route-text">
            <p className="route-t" id={`${id}-${r.id}`}>{r.title}{selected && <span className="badge b-ok"><Icon name="check" small />In use</span>}</p>
            <p className="route-d">{r.body}</p>
          </div>
          {r.id === "own"
            ? <button type="button" className="btn btn-secondary btn-sm" aria-expanded={ownOpen} aria-describedby={`${id}-${r.id}`} onClick={() => setOwnOpen(!ownOpen)}>
              {ownOpen ? "Close" : selected ? "Change provider" : "Set up"}</button>
            : !selected && <button type="button" className="btn btn-secondary btn-sm" aria-describedby={`${id}-${r.id}`} onClick={() => choose(r.id)}>Use this</button>}
        </div>
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
