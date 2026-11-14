/** The same fictional facts, transcribed independently so the test does not reuse the fixture. */
export function prepared() {
  const binding = { workspace_id: "harbor", account_id: "office" };
  return {
    kind: "fictional-import", host: { ...binding }, ...binding, timezone: "America/New_York",
    imported_at: "2026-11-19T14:00:00Z", evaluated_at: "2026-11-19T14:00:00Z",
    valid_until: "2026-11-20T14:00:00Z",
    scopes: {
      mail: { outcome: "complete", expected_ids: ["MSG-01"] },
      calendar: { outcome: "complete", expected_ids: ["CAL-01"] },
    },
    messages: [{
      ...binding, id: "MSG-01", received_at: "2026-11-19T13:15:00Z",
      subject: "Tonight's room unavailable",
      body: "The fellowship room is unavailable tonight because of a plumbing repair. Please arrange another location for the volunteer orientation scheduled for 7:00 p.m. I have not contacted the volunteers.",
    }],
    events: [{
      ...binding, id: "CAL-01", modified_at: "2026-11-18T21:00:00Z",
      title: "Volunteer orientation", start_at: "2026-11-20T00:00:00Z", end_at: "2026-11-20T01:00:00Z",
      location: "Fellowship room", status: "confirmed",
    }],
    assertions: [{
      kind: "location-unavailable", message_id: "MSG-01", event_id: "CAL-01",
      anchor: { start: 0, end: 72, quote: "The fellowship room is unavailable tonight because of a plumbing repair." },
      not_contacted: { start: 159, end: 195, quote: "I have not contacted the volunteers." },
    }],
  };
}
