// The church reads of a Sunday capture as facts with their source and check time: People forms the
// leader watches, last Sunday in Check-Ins, and upcoming Registrations signups. Pure: no I/O, no model.
// These facts are shown in the app on this Mac only. None of them is part of the Sunday brief, so none
// reaches Ask, the agent tools, a briefing sent to an AI, or the copy shared with other AI apps.
export { checkInsFacts, checkInsTarget, CHECK_INS_KIND, CHECK_INS_SOURCE, type CheckInsFacts, type CheckInsTime, type RoomCount, type RoomRuleFact } from "./checkins.js";
export { formsFacts, formTarget, FORMS_KIND, FORMS_SOURCE, type FormFact, type FormsFacts } from "./forms.js";
export { registrationsFacts, signupTarget, REGISTRATIONS_KIND, REGISTRATIONS_SOURCE, type RegistrationsFacts, type SignupFact } from "./registrations.js";
export * from "./rules.js";
