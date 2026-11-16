// Looked up as a map, so a name is never a key into an object (review U: no key made at run time).
const paths: ReadonlyMap<string, string> = new Map(Object.entries({
  flag: "M5 21V4m0 0h11l-2 4 2 4H5",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-6v-5m0-3h.01",
  check: "M5 12.5 10 17 19 7",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-15v5l3 2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  question: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3h.01",
  minus: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 12h8",
  x: "M6 6l12 12M18 6 6 18",
  dot: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  rules: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  table: "M4 5h16v14H4zM4 10h16M4 14.5h16M10 10v9",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5m4-1v5l3 2",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1m2 5a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  spinner: "M12 3a9 9 0 1 0 9 9",
  chev: "m9 6 6 6-6 6",
}));
export function Icon({ name, small, spin }: { name: string; small?: boolean; spin?: boolean }) {
  return <svg className={`ic${small ? " ic-sm" : ""}${spin ? " spin" : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d={paths.get(name) ?? paths.get("dot")} /></svg>;
}
