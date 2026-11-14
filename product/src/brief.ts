export interface Finding {
  fact: string;
  why_now: string;
  rule: string;
  source: string;
  check_time: string;
  group: "attention" | "review" | "progress";
  uncertain: boolean;
}

export interface BriefScopeCheck {
  scope: string;
  source: string;
  check_time: string;
  // Presentation adds unverified for absent evidence; it is not a provider envelope value.
  completeness: "complete" | "partial" | "stale" | "denied" | "unverified";
}

const GROUP_TITLES = {
  attention: "Needs your attention",
  review: "Ready to review",
  progress: "In progress",
} as const;

const hasCheckTime = (value: string): boolean => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
};
const hasCheckEvidence = (check: BriefScopeCheck) =>
  check.scope.trim() !== "" && check.source.trim() !== "" && hasCheckTime(check.check_time);

/**
 * Deterministic brief composition. No model call: facts, church rules,
 * sources, and check times pass through exactly as checked. Counts are
 * items, never people. Uncertainty is labeled "Worth a look".
 */
export function composeBrief(findings: Finding[], heading: string, checks: readonly BriefScopeCheck[] = []): string {
  const lines: string[] = [`# ${heading}`, ""];
  const complete = checks.length > 0 && checks.every((check) => check.completeness === "complete" && hasCheckEvidence(check));
  if (!complete) {
    lines.push("Some checks couldn't be verified.");
    if (checks.length === 0) lines.push("No scope check evidence was supplied.");
  } else if (findings.length === 0) {
    lines.push(`Nothing needs your attention within the checked scope: ${checks.map((check) => check.scope).join(", ")}.`);
  }
  for (const check of checks) {
    const status = check.completeness === "complete" && !hasCheckEvidence(check) ? "Not verified (check evidence is missing)" : {
      complete: "Checked",
      partial: "Only part of this scope was checked",
      stale: "Last check is out of date",
      denied: "Access unavailable",
      unverified: "Not verified",
    }[check.completeness];
    const time = hasCheckTime(check.check_time) ? `checked ${check.check_time}` : "Check time unavailable";
    lines.push(`${check.scope.trim() || "Unnamed scope"}: ${status}. ${check.source.trim() || "Source unavailable"} · ${time}`);
  }
  for (const group of ["attention", "review", "progress"] as const) {
    const items = findings.filter((f) => f.group === group);
    if (items.length === 0) continue;
    lines.push(`## ${GROUP_TITLES[group]} (${items.length})`, "");
    for (const f of items) {
      lines.push(`- ${f.uncertain ? `Worth a look: ${f.fact}` : f.fact}`);
      lines.push(`  Why now: ${f.why_now}`);
      lines.push(`  Why I flagged this: ${f.rule}`);
      lines.push(`  ${f.source} · checked ${f.check_time}`);
    }
    lines.push("");
  }
  lines.push("Draft only where shown. Nothing has been sent, and nothing here is confirmed in Planning Center unless it says so.");
  return lines.join("\n");
}
