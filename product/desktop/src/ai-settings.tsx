import { useEffect, useId, useState } from "react";
import { model, modelProblem, type ModelStatus } from "./model.js";
import { Icon } from "./icons.js";

type Route = "managed" | "own" | "local";
const routes: { id: Route; title: string; body: string }[] = [
  { id: "managed", title: "Ozzie managed", body: "Through Vercel AI Gateway with zero data retention required on every request. Needs the Ozzie gateway key in this Mac's Keychain." },
  { id: "own", title: "Your own AI provider", body: "Any OpenAI-compatible service, with your key in this Mac's Keychain (account “own-provider”)." },
  { id: "local", title: "A model on this Mac", body: "Ollama or LM Studio running locally. Nothing leaves this Mac." },
];

/**
 * Wording help and Ask Ozzie use AI; both send placeholders like [Volunteer A] instead of the names Ozzie read. Each route is one row
 * with one action; your own provider's address and model show only under that row.
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
      .catch(e => setProblem(modelProblem(e)));
  };
  return <div className="find ai-settings" role="group" aria-labelledby={labelledBy}>
    <p className="find-body">Ozzie can reword a draft note and answer questions about the Sunday it checked. The AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center, and it never sends anything. Ozzie can't recognise names it never read, so don't type other people's details into a question.</p>
    <p className="bold" role="status">{status?.configured ? `Using: ${status.label}` : "Not set up. Drafts still work; only rewording and questions are off."}</p>
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
