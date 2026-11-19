// Read-only connections to other church systems (B1 Church, Breeze, Genesis): the capture native code hands
// the page, the Sunday check built from it where the system can supply one, and the "also read" facts.
export {
  ASSIGNMENT_STATUSES, BUSY_ANSWERS, MAX, parseSystemCapture, parseSystemCaptureText, READ_ERRORS, READ_OUTCOMES, READS, readsFor, REFUSALS, SYSTEM_IDS, SYSTEMS,
  type AssignmentStatus, type BusyAnswer, type CapturePart, type CaptureRefusal, type ParsedCapture, type ReadOutcome, type SystemAssignment,
  type SystemBlockout, type SystemBusy, type SystemCapture, type SystemEvent, type SystemForm, type SystemGroup, type SystemId,
  type SystemInfo, type SystemPosition, type SystemRead, type SystemService, type SystemTeamMember, untimed,
} from "./types.js";
export {
  completenessOf, COVERAGE_REFUSALS, systemCaptureToCoverage, ZONE_CONFIRMATION_SCOPE, type CoverageRefusal, type SystemCoverage, type SystemLeadRules, type SystemRules,
} from "./coverage.js";
export {
  B1_KEY_BOXES, cannotSee, FACT_READS, howToConnect, NEWEST_ONLY, noRoles, notSharedNotice, notSharedYet, NULL_COUNTS, numbersNotShared, onServiceWithoutRole, readProblem,
  sharedLabel, systemFacts, toConfirm, unknownNeed,
  waitingForZone, whyNullSentence, type EventFact, type FactOutcome, type FormFact, type GroupFact, type NullCount,
  type PartRead, type SystemFacts,
} from "./facts.js";
export { labelsOf, namesOf, placeholderScope } from "./placeholders.js";
export { buildSystemBrief, type SystemBrief, type SystemBriefRules } from "./brief.js";
export { fictionalB1, fictionalBreeze } from "./fictional.js";
export { recordSystemCheck, steadyBrief, systemServing } from "./changes.js";
export { systemHarnessCapture } from "./harness.js";
export { CAPTURE_PARTS, PART_NAMES, PARTIAL_BY_DESIGN, unreadParts } from "./reads.js";
