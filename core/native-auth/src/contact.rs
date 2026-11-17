//! Filling in To on a drafted note (owner decisions, 2026-11-16 night; audit item 19): when the
//! leader opens a note prepared for one person in Mail or Messages, Ozzie reads that person's email
//! address or mobile number from Planning Center and uses it only to address the new, unsent message
//! on this Mac. It is a new kind of personal data and a new read, so the whole rule is here:
//!
//! 1. **The detail never reaches the page.** The page names the person only by the Planning Center
//!    id the Sunday check it was shown already holds, and that id must be a person the reads of a
//!    check this session handed the page link to, for the church Ozzie is connected to now
//!    (`CheckedPeople`): the page can't ask about anyone else. The detail is read, chosen and checked
//!    here, and the address is built here too (`address`) and handed to the desktop app only as an
//!    `Address` it can do one thing with: `open`, which passes it to the function that opens it on
//!    this Mac and to nothing else. The reply is made here (`Opened`): the app's name, from a second
//!    function that is told only Mail or Messages and never sees the address (`AppName`), whether the
//!    note was addressed, and when not, a closed reason (`NoRecipient`). `Recipient` and `Address`
//!    have no Serialize, Clone or Display, and their Debug forms withhold the value.
//! 2. **It is never kept.** Read once for one open, used, dropped: no cache between opens, no file,
//!    no task ledger entry, no recording (a Sunday check never makes this read, and a recording that
//!    held one could not be saved or loaded), no copy for other AI apps or Siri, no notice, nothing
//!    logged, never a model. The chosen value and the address built from it are held in `Zeroizing`
//!    memory; the parsed reply and the operating system's own copy of the opened address are not
//!    wiped (the same as every other read's names). Only the draft-opening command reaches this
//!    module, checked on both crates' sources by tests.
//! 3. **One allowlisted GET, read-only, least data.** The person's own People record, through the
//!    same verified, GET-only source path as every other read (source.rs), after the same
//!    organization check, with sparse fieldsets so only what choosing needs comes back:
//!
//!    `/people/v2/people/{id}?include=emails&fields[Person]=child,emails&fields[Email]=address,primary,blocked`
//!    `/people/v2/people/{id}?include=phone_numbers&fields[Person]=child,phone_numbers&fields[PhoneNumber]=number,primary,location`
//!
//!    Mail reads only email addresses and Messages only phone numbers. It needs the People scope,
//!    which a leader grants with Calendar and Groups; a sign-in without it is `not-allowed`, the
//!    contact read is never sent, and no sign-in is started from here. When this session has already
//!    verified the sign-in, that is known before the Keychain or Planning Center is asked anything.
//! 4. **Never beside a check, one at a time, briefly.** The read takes the connection's turn
//!    (`sunday_check::Turns`), the one the Sunday check and setup's picker take, without waiting: if a
//!    check or the picker holds it, nothing is read (`busy-with-a-check`), and a check that starts
//!    meanwhile waits for the read instead of failing. One note is addressed at a time
//!    (`busy-with-another-note`), at most `READS_PER_MINUTE` a minute (`too-many-just-now`), and each
//!    gets `OPEN_DEADLINE` from the click: past it the read is cancelled and the note opens with no
//!    one in To (`could-not-read`). The read's own thread keeps the turn until it stops: a request
//!    already under way runs to its own time limit (Planning Center's identity check 15 s, the GET
//!    5 s), so in the worst case the turn is held about 23 s from the click. A Sunday check, which
//!    waits 30 s for the turn, still runs; setup's picker, which waits 10 s, can answer busy.
//!    Bounding the identity check by the deadline would mean a time limit per call in the shared
//!    sign-in client (provider.rs), which every sign-in and check uses; it is left as it is.
//! 5. **Choosing, never guessing.** A person Planning Center lists as a child is never addressed, nor
//!    one whose record doesn't say. Mail: of the addresses not marked blocked, the primary one; with
//!    no primary, the only one; with several and none primary, none (`more-than-one`). Messages: the
//!    same rule over the numbers whose location is Mobile. What comes back is checked before use: an
//!    email address must be one plain address (`email_address`), a number digits with an optional
//!    leading `+` once spaces, dashes, dots and brackets are taken out (`mobile_number`); anything
//!    else is `could-not-read`. The rows used are exactly the ones the person's own record links.
//!    The address built must name exactly that one recipient (`recipients`).
//! 6. **Plain words are the page's.** Native returns codes only; the page puts the person's name in
//!    from what it already shows and says what happened in plain English. Tests use fictional people,
//!    `example.org` addresses and `555-01xx` numbers only.
//!
//! Deliberately not done: no caching between opens, no bulk or list read, no address book, no read
//! for anyone the leader didn't open a note for, no other contact kind, no write of any kind.
use crate::{
    oauth::{AuthController, numeric_id},
    source::{
        Collection, NativeSourceHttp, Product, SourceError, SourceHttp, SourceRequest, Target,
    },
    sunday_check::{Reader, SundayCapture, Turns},
};
use serde_json::Value;
use std::{
    collections::{BTreeSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

/// From the click to the note opening: past this the read is cancelled and the note opens with no
/// one in To.
pub const OPEN_DEADLINE: Duration = Duration::from_secs(8);
/// Reads that may go out in any one minute, so a page stuck in a loop can't wear out the church's
/// Planning Center allowance.
pub const READS_PER_MINUTE: usize = 10;
/// The most people remembered for one church in one session; past it, only the newest check's.
pub const MAX_CHECKED_PEOPLE: usize = 5_000;
const MINUTE: Duration = Duration::from_secs(60);
const RETRY_EVERY: Duration = Duration::from_millis(25);
/// Planning Center's own word for a mobile phone's location.
const MOBILE: &str = "mobile";

/// Which detail a note is addressed with: Mail an email address, Messages a mobile number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContactKind {
    Email,
    Mobile,
}
impl ContactKind {
    fn collection(self) -> Collection {
        match self {
            Self::Email => Collection::PersonEmails,
            Self::Mobile => Collection::PersonPhoneNumbers,
        }
    }
    /// The person's link to their rows, and the rows' type.
    fn rows(self) -> (&'static str, &'static str) {
        match self {
            Self::Email => ("emails", "Email"),
            Self::Mobile => ("phone_numbers", "PhoneNumber"),
        }
    }
}

/// Why the note opened with no one in To. Closed codes that carry nothing about the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoRecipient {
    /// Planning Center has no usable address (or mobile number) for the person.
    NoneOnFile,
    /// The sign-in doesn't include People, Planning Center refused the read (401 or 403), or this
    /// Mac's Keychain refused Ozzie its saved sign-in. A locked Keychain is `could-not-read`.
    NotAllowed,
    /// The read didn't finish (no connection, a locked Keychain, a timeout, the deadline, an error),
    /// or what came back wasn't one plain address or number.
    CouldNotRead,
    /// Several addresses (or mobile numbers) and none marked primary: Ozzie doesn't choose.
    MoreThanOne,
    /// Planning Center lists the person as a child.
    Child,
    /// The person isn't one of the people a Sunday check handed to the page this session (a live
    /// check or a loaded recording) links to by name through its plan, team assignments or chosen
    /// forms, nor a team leader it shows, for the church Ozzie is connected to now; or nobody has
    /// been checked yet.
    NotInThisCheck,
    /// The Sunday check or setup's picker was reading Planning Center: nothing was read.
    BusyWithACheck,
    /// Another note was still being addressed: nothing was read.
    BusyWithAnotherNote,
    /// `READS_PER_MINUTE` reads already went out to Planning Center in the minute before, whether or
    /// not they filled in To: nothing was read.
    TooManyJustNow,
}

/// One checked email address or mobile number, for one open. Deliberately not Clone, Serialize or
/// Display; its Debug form never shows the value.
pub struct Recipient {
    kind: ContactKind,
    value: Zeroizing<String>,
}
impl std::fmt::Debug for Recipient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.kind {
            ContactKind::Email => "Recipient(Email, withheld)",
            ContactKind::Mobile => "Recipient(Mobile, withheld)",
        })
    }
}
impl Recipient {
    /// `text` as the recipient of a note opened in Mail, only when it is one plain email address
    /// (`email_address`).
    pub fn email(text: &str) -> Option<Self> {
        Some(Self {
            kind: ContactKind::Email,
            value: email_address(text)?,
        })
    }
    /// `text` as the recipient of a note opened in Messages, only when it reads as one phone number
    /// (`mobile_number`).
    pub fn mobile(text: &str) -> Option<Self> {
        Some(Self {
            kind: ContactKind::Mobile,
            value: mobile_number(text)?,
        })
    }
    pub fn kind(&self) -> ContactKind {
        self.kind
    }
    /// The recipient as it goes into the address: an email address percent-encoded as RFC 6068
    /// allows (letters, digits, `-._~`, `+` and its one `@` as they are, every other byte as `%XX`),
    /// or a number as an optional `+` and digits. Written into memory sized for the longest result,
    /// so no partial copy is left unwiped.
    fn url_part(&self) -> Zeroizing<String> {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        let mut out = Zeroizing::new(String::with_capacity(self.value.len() * 3));
        for byte in self.value.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~+@".contains(&byte) {
                out.push(char::from(byte));
            } else {
                out.push('%');
                out.push(char::from(HEX[usize::from(byte >> 4)]));
                out.push(char::from(HEX[usize::from(byte & 0x0F)]));
            }
        }
        out
    }
}

/// An email address Ozzie will put in To: one plain `local@domain`, ASCII, at most 254 bytes. The
/// local part is dot-separated runs of letters, digits and ``!$'*+-/=^_`{|}~`` (no quotes, no
/// spaces, none of `"(),:;<>@[\]` and none of `#%&?`, which could end the address in a URL); the
/// domain is at least two dot-separated labels of letters, digits and inner hyphens, the last not
/// all digits. Anything else, with no repair (not even trimming), is refused.
fn email_address(text: &str) -> Option<Zeroizing<String>> {
    if !(3..=254).contains(&text.len()) || !text.is_ascii() {
        return None;
    }
    let (local, domain) = text.split_once('@')?;
    let atom = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!$'*+-/=^_`{|}~".contains(&b))
    };
    let label = |part: &str| {
        (1..=63).contains(&part.len())
            && !part.starts_with('-')
            && !part.ends_with('-')
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let labels: Vec<&str> = domain.split('.').collect();
    let plain = local.len() <= 64
        && local.split('.').all(atom)
        && domain.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|part| label(part))
        && labels
            .last()
            .is_some_and(|tld| !tld.bytes().all(|b| b.is_ascii_digit()));
    plain.then(|| Zeroizing::new(text.to_owned()))
}

/// A mobile number Ozzie will put in To: spaces, dashes, dots and brackets taken out, then an
/// optional leading `+` (not followed by `0`) and 7 to 15 ASCII digits, as Messages reads it.
/// Letters (an extension, a word), other separators and anything else are refused.
fn mobile_number(text: &str) -> Option<Zeroizing<String>> {
    if text.len() > 64 {
        return None;
    }
    let mut kept = Zeroizing::new(String::with_capacity(text.len()));
    for c in text.chars() {
        if !matches!(c, ' ' | '-' | '.' | '(' | ')') {
            kept.push(c);
        }
    }
    let digits = kept.strip_prefix('+').unwrap_or(&kept);
    let plain = (7..=15).contains(&digits.len())
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !(kept.starts_with('+') && digits.starts_with('0'));
    plain.then_some(kept)
}

/// This session's state for filling in To: the people the Sunday checks it handed the page link
/// to (a live check or a loaded recording), for the one church they were read from, and when the
/// last reads went out. Ids and times only, held in memory: never saved or shown. A check of
/// another church starts it again.
#[derive(Clone, Default)]
pub struct CheckedPeople(Arc<Mutex<Session>>);
#[derive(Default)]
struct Session {
    checked: Option<Checked>,
    reads: VecDeque<Instant>,
}
struct Checked {
    organization: String,
    people: BTreeSet<String>,
}
/// The people a capture's reads link to by name, the way the check chooses whom it names: everyone
/// on the plan, the people its team assignments link, and who submitted a chosen form. A name with
/// no such link (one a hand-written recording adds) is never someone a note can be addressed to.
fn linked_people(capture: &SundayCapture) -> BTreeSet<&str> {
    let mut linked = BTreeSet::new();
    for read in &capture.reads {
        if !matches!(
            read.collection.as_str(),
            "team_members" | "team_position_assignments" | "people_form_submissions"
        ) {
            continue;
        }
        let rows = read.body.as_ref().and_then(|body| body["data"].as_array());
        for row in rows.into_iter().flatten() {
            linked.extend(person_ids(&row["relationships"]["person"]["data"]));
        }
    }
    linked
}
/// The team leaders a capture shows, the way the Sunday page reads them (core/src/sunday-brief.ts
/// `teamLeaders`): from each answered `team_leaders` read of a team, every `TeamLeader` row's
/// `people` and `person` links. The check keeps no name for a leader who is only a leader; the page
/// still offers a note to them, so they are people a check showed.
fn team_leaders(capture: &SundayCapture) -> BTreeSet<&str> {
    let mut leaders = BTreeSet::new();
    for read in &capture.reads {
        if read.collection != "team_leaders" || read.team_id.is_none() || read.outcome != "ok" {
            continue;
        }
        let rows = read.body.as_ref().and_then(|body| body["data"].as_array());
        for row in rows.into_iter().flatten() {
            if row["type"] != "TeamLeader" {
                continue;
            }
            for key in ["people", "person"] {
                leaders.extend(person_ids(&row["relationships"][key]["data"]));
            }
        }
    }
    leaders
}
/// The Person ids one link names: one identity, or a list of them.
fn person_ids(link: &Value) -> Vec<&str> {
    match link {
        Value::Array(links) => links.iter().filter_map(person_id).collect(),
        _ => person_id(link).into_iter().collect(),
    }
}
fn person_id(link: &Value) -> Option<&str> {
    let id = link["id"].as_str()?;
    (link["type"] == "Person" && numeric_id(id)).then_some(id)
}
impl CheckedPeople {
    /// Adds, for its church, the people a capture names whom its own reads link to, and the team
    /// leaders it shows (named or not); at most `MAX_CHECKED_PEOPLE` in all.
    pub fn remember(&self, capture: &SundayCapture) {
        let linked = linked_people(capture);
        let mut ids: BTreeSet<&str> = capture
            .names
            .keys()
            .map(String::as_str)
            .filter(|id| linked.contains(id))
            .collect();
        ids.extend(team_leaders(capture));
        let ids: Vec<String> = ids
            .into_iter()
            .take(MAX_CHECKED_PEOPLE)
            .map(str::to_owned)
            .collect();
        let mut session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match session.checked.as_mut() {
            Some(checked)
                if checked.organization == capture.organization
                    && checked.people.len() + ids.len() <= MAX_CHECKED_PEOPLE =>
            {
                checked.people.extend(ids);
            }
            _ => {
                session.checked = Some(Checked {
                    organization: capture.organization.clone(),
                    people: ids.into_iter().collect(),
                });
            }
        }
    }
    /// Whether `person` is one of those people and they were read from `organization`.
    pub fn holds(&self, organization: &str, person: &str) -> bool {
        numeric_id(person)
            && self
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .checked
                .as_ref()
                .is_some_and(|checked| {
                    checked.organization == organization && checked.people.contains(person)
                })
    }
    /// Counts one read at `now` if fewer than `READS_PER_MINUTE` went out in the minute before it.
    fn pace(&self, now: Instant) -> bool {
        let mut session = self.0.lock().unwrap_or_else(|e| e.into_inner());
        while session
            .reads
            .front()
            .is_some_and(|&at| now.saturating_duration_since(at) >= MINUTE)
        {
            session.reads.pop_front();
        }
        if session.reads.len() >= READS_PER_MINUTE {
            return false;
        }
        session.reads.push_back(now);
        true
    }
}

/// The source client a read uses, made only once a read will go out.
pub(crate) type MakeHttp =
    Box<dyn FnOnce() -> Result<Arc<dyn SourceHttp + Send + Sync>, SourceError> + Send>;

/// Reads `person`'s email address (`Email`) or mobile number (`Mobile`): the connection's turn
/// first, without waiting; then `connect` for this session's connection; then the one GET above,
/// after the organization check, within `OPEN_DEADLINE`. Or nothing read at all, and why.
pub fn read_recipient(
    checked: &CheckedPeople,
    turns: &Turns,
    person: &str,
    kind: ContactKind,
    connect: impl FnOnce() -> Option<Arc<AuthController>>,
) -> Result<Recipient, NoRecipient> {
    let http: MakeHttp = Box::new(|| {
        NativeSourceHttp::new().map(|http| Arc::new(http) as Arc<dyn SourceHttp + Send + Sync>)
    });
    read_recipient_with(checked, turns, person, kind, connect, http, OPEN_DEADLINE)
}

pub(crate) fn read_recipient_with(
    checked: &CheckedPeople,
    turns: &Turns,
    person: &str,
    kind: ContactKind,
    connect: impl FnOnce() -> Option<Arc<AuthController>>,
    http: MakeHttp,
    limit: Duration,
) -> Result<Recipient, NoRecipient> {
    let started = Instant::now();
    // Never beside the check or the picker, and one note at a time: nothing waits for the turn.
    let turn = turns
        .take_now(Reader::Note)
        .map_err(|holder| match holder {
            Reader::Note => NoRecipient::BusyWithAnotherNote,
            Reader::Check | Reader::Picker => NoRecipient::BusyWithACheck,
        })?;
    let auth = connect().ok_or(NoRecipient::CouldNotRead)?;
    // Only someone a check of this church showed, and nothing read otherwise.
    if !checked.holds(&auth.binding().organization, person) {
        return Err(NoRecipient::NotInThisCheck);
    }
    // A sign-in this session verified without People: known without the Keychain or the network.
    if auth
        .status_or_busy()
        .ok()
        .and_then(|status| status.scopes)
        .is_some_and(|scopes| !Product::People.granted(scopes))
    {
        return Err(NoRecipient::NotAllowed);
    }
    if !checked.pace(Instant::now()) {
        return Err(NoRecipient::TooManyJustNow);
    }
    let request = SourceRequest::capture_at(
        auth.binding(),
        "",
        "",
        kind.collection(),
        &Target::people_person(person),
        1,
        0,
    )
    .map_err(|_| NoRecipient::CouldNotRead)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let (send, receive) = mpsc::channel();
    let reading = cancelled.clone();
    let person = person.to_owned();
    std::thread::Builder::new()
        .name("ozzie-to-line".into())
        .spawn(move || {
            // The turn is held while the connection is in use, past the deadline too.
            let _turn = turn;
            let result = http()
                .map_err(|_| NoRecipient::CouldNotRead)
                .and_then(|http| read_one(&auth, &request, &person, kind, &reading, http.as_ref()));
            // After the deadline nobody listens, and a recipient read late is dropped (wiped) here.
            let _ = send.send(result);
        })
        .map_err(|_| NoRecipient::CouldNotRead)?;
    match receive.recv_timeout(limit.saturating_sub(started.elapsed())) {
        Ok(result) => result,
        Err(_) => {
            cancelled.store(true, Ordering::SeqCst);
            Err(NoRecipient::CouldNotRead)
        }
    }
}

/// The verified GET itself, stopped by `cancelled` at the controller's every boundary.
fn read_one(
    auth: &AuthController,
    request: &SourceRequest,
    person: &str,
    kind: ContactKind,
    cancelled: &AtomicBool,
    http: &dyn SourceHttp,
) -> Result<Recipient, NoRecipient> {
    let verified = waiting(cancelled, || auth.verify_source(cancelled)).map_err(refused)?;
    // A sign-in without People is never asked to read it; no new sign-in is started either.
    if !Product::People.granted(verified.scopes()) {
        return Err(NoRecipient::NotAllowed);
    }
    let page = waiting(cancelled, || {
        auth.read_verified_using(&verified, request, cancelled, http)
    })
    .map_err(refused)?;
    choose(page.body(), person, kind)
}

/// Planning Center's refusal (401 or 403) or the Keychain's (`Denied`) is `not-allowed`; every
/// other failure, a locked Keychain among them, is `could-not-read`.
fn refused(error: SourceError) -> NoRecipient {
    match error {
        SourceError::Denied => NoRecipient::NotAllowed,
        _ => NoRecipient::CouldNotRead,
    }
}

/// `attempt` again while the controller answers `Busy` (a status refresh holding it), until the
/// read is cancelled or `OPEN_DEADLINE`. The controller refuses before any credential or network
/// use, so nothing is sent twice.
fn waiting<T>(
    cancelled: &AtomicBool,
    mut attempt: impl FnMut() -> Result<T, SourceError>,
) -> Result<T, SourceError> {
    let started = Instant::now();
    loop {
        match attempt() {
            Err(SourceError::Busy) if started.elapsed() < OPEN_DEADLINE => {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(SourceError::Cancelled);
                }
                std::thread::sleep(RETRY_EVERY);
            }
            result => return result,
        }
    }
}

/// The recipient a projected contact read gives, by the rules above.
pub(crate) fn choose(
    body: &Value,
    person: &str,
    kind: ContactKind,
) -> Result<Recipient, NoRecipient> {
    let record = &body["data"];
    if record["id"].as_str() != Some(person) {
        return Err(NoRecipient::CouldNotRead);
    }
    match record["attributes"]["child"] {
        Value::Bool(false) => {}
        Value::Bool(true) => return Err(NoRecipient::Child),
        _ => return Err(NoRecipient::CouldNotRead),
    }
    let (link, row_type) = kind.rows();
    // The rows used are exactly the ones the record links: none missing, none extra, none twice.
    let linked: Option<BTreeSet<&str>> = record["relationships"][link]["data"]
        .as_array()
        .and_then(|links| links.iter().map(|l| l["id"].as_str()).collect());
    let rows: Vec<&Value> = body["included"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|row| row["type"] == row_type)
        .collect();
    let included: BTreeSet<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
    if linked.as_ref() != Some(&included) || included.len() != rows.len() {
        return Err(NoRecipient::CouldNotRead);
    }
    let attribute = |row: &Value, key: &str| row["attributes"][key].clone();
    let usable: Vec<(&str, bool)> = rows
        .iter()
        .filter(|row| match kind {
            ContactKind::Email => attribute(row, "blocked") != Value::Bool(true),
            ContactKind::Mobile => attribute(row, "location")
                .as_str()
                .is_some_and(|place| place.trim().eq_ignore_ascii_case(MOBILE)),
        })
        .filter_map(|row| {
            let key = match kind {
                ContactKind::Email => "address",
                ContactKind::Mobile => "number",
            };
            let value = row["attributes"][key].as_str().filter(|v| !v.is_empty())?;
            Some((value, attribute(row, "primary") == Value::Bool(true)))
        })
        .collect();
    let primary: Vec<&str> = usable
        .iter()
        .filter(|(_, primary)| *primary)
        .map(|(value, _)| *value)
        .collect();
    let chosen = match (primary.as_slice(), usable.as_slice()) {
        ([one], _) => *one,
        ([_, _, ..], _) => return Err(NoRecipient::MoreThanOne),
        ([], [(one, _)]) => *one,
        ([], []) => return Err(NoRecipient::NoneOnFile),
        ([], _) => return Err(NoRecipient::MoreThanOne),
    };
    match kind {
        ContactKind::Email => Recipient::email(chosen),
        ContactKind::Mobile => Recipient::mobile(chosen),
    }
    .ok_or(NoRecipient::CouldNotRead)
}

/// How many recipients a note's address names, read the way the apps read them: `None` for
/// anything else. Mail (RFC 6068): the `to` before `?` is empty or one address (one `@`, no `,` or
/// `;` in any spelling, nothing but unreserved characters, `+`, `@` and `%XX`), and after it come
/// only `subject` and exactly one `body`, never a `to`, `cc` or `bcc`. Messages: Apple's `sms:`
/// form, an empty or `+`-and-digits number before `&`, then one `body` with no further `&`, `?`
/// or `#`.
pub fn recipients(url: &str) -> Option<usize> {
    if let Some(rest) = url.strip_prefix("mailto:") {
        let (to, headers) = rest.split_once('?')?;
        let mut bodies = 0;
        for header in headers.split('&') {
            match header.split_once('=')?.0 {
                "body" => bodies += 1,
                "subject" => {}
                _ => return None,
            }
        }
        if bodies != 1 || headers.contains('#') {
            return None;
        }
        if to.is_empty() {
            return Some(0);
        }
        let lower = to.to_ascii_lowercase();
        let one = to.bytes().filter(|&b| b == b'@').count() == 1
            && to
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~+@%".contains(&b))
            && !["%40", "%2c", "%3b", "%0a", "%0d", "%00"]
                .iter()
                .any(|spelled| lower.contains(spelled));
        one.then_some(1)
    } else if let Some(rest) = url.strip_prefix("sms:") {
        let (to, body) = rest.split_once('&')?;
        if !body.starts_with("body=") || body.contains(['&', '?', '#']) {
            return None;
        }
        if to.is_empty() {
            return Some(0);
        }
        let digits = to.strip_prefix('+').unwrap_or(to);
        (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(1)
    } else {
        None
    }
}

/// Why no address could be made: the draft's own address isn't one with no one in To
/// (`NotADraft`), or it doesn't fit once addressed (`TooLong`; it is never cut).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressError {
    NotADraft,
    TooLong,
}
/// The address a note opens with, for the opener only: no Serialize, Clone or Display, a Debug form
/// that withholds it, and one use (`open`). It names exactly one recipient when the note was
/// addressed and none otherwise.
pub struct Address {
    url: Zeroizing<String>,
    recipients: usize,
    kind: ContactKind,
    to: Result<(), NoRecipient>,
}
impl std::fmt::Debug for Address {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Address(withheld)")
    }
}
/// The address to open: `unaddressed` (the draft's own `mailto:?…` or `sms:&…` address, no one in
/// To, at most `max_bytes`) with the read's recipient put in after the scheme when there is one, or
/// as it is with the reason. A recipient of the other kind, or one that wouldn't make an address
/// naming exactly that one recipient, leaves To empty (`could-not-read`).
pub fn address(
    unaddressed: &str,
    max_bytes: usize,
    read: Result<Recipient, NoRecipient>,
) -> Result<Address, AddressError> {
    let (scheme, rest) = unaddressed.split_once(':').ok_or(AddressError::NotADraft)?;
    let kind = match scheme {
        "mailto" => ContactKind::Email,
        "sms" => ContactKind::Mobile,
        _ => return Err(AddressError::NotADraft),
    };
    if recipients(unaddressed) != Some(0) || unaddressed.len() > max_bytes {
        return Err(AddressError::NotADraft);
    }
    let without = |reason| {
        Ok(Address {
            url: Zeroizing::new(unaddressed.to_owned()),
            recipients: 0,
            kind,
            to: Err(reason),
        })
    };
    let recipient = match read {
        Ok(recipient) if recipient.kind == kind => recipient,
        Ok(_) => return without(NoRecipient::CouldNotRead),
        Err(reason) => return without(reason),
    };
    let part = recipient.url_part();
    let mut url = Zeroizing::new(String::with_capacity(unaddressed.len() + part.len()));
    url.push_str(scheme);
    url.push(':');
    url.push_str(&part);
    url.push_str(rest);
    if url.len() > max_bytes {
        return Err(AddressError::TooLong);
    }
    if recipients(&url) != Some(1) {
        return without(NoRecipient::CouldNotRead);
    }
    Ok(Address {
        url,
        recipients: 1,
        kind,
        to: Ok(()),
    })
}
/// The opener couldn't open the address (no app for it on this Mac, or the app didn't open).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotOpened;
impl Address {
    /// Hands the address to `opener`, the one function that opens it on this Mac (told how many
    /// recipients it must read with), wipes it, then asks `name` which app this Mac opens Mail's or
    /// Messages' addresses with. `name` is told only which of the two: it is never handed the
    /// address, so the app's name in the reply can't be made from it. `NotOpened` when it didn't
    /// open; the neutral name when the app's own name can't be read.
    pub fn open(
        self,
        opener: fn(&str, usize) -> Result<(), NotOpened>,
        name: fn(ContactKind) -> Option<AppName>,
    ) -> Result<Opened, NotOpened> {
        let Address {
            url,
            recipients,
            kind,
            to,
        } = self;
        opener(&url, recipients)?;
        drop(url);
        let app = name(kind).unwrap_or_else(|| AppName::neutral(kind));
        Ok(Opened::new(app, to))
    }
}

/// The name of the app a note opened in, as the reply says it: the app's own name on this Mac
/// (`shown`), looked up by a function that is never handed the address (`Address::open`), or, when
/// that name can't be read, a neutral one that is true whichever app it was (`neutral`).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct AppName(String);
impl AppName {
    /// An app's name (its file name without `.app`) as the reply may say it, any printable
    /// characters ("Spike Email - Mail & Team Chat", "Gmail: Email by Google"): trimmed, one line of
    /// 1 to 64 characters, none of them a control, line or paragraph separator, zero-width or
    /// direction character.
    pub fn shown(name: &str) -> Option<AppName> {
        let name = name.trim();
        let plain = !name.is_empty()
            && name.chars().count() <= 64
            && !name.chars().any(|c| {
                c.is_control()
                    || matches!(c, '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
            });
        plain.then(|| AppName(name.to_owned()))
    }
    /// Said when the app's own name can't be read: "your email app" or "your messages app", true
    /// whichever app this Mac opened.
    pub fn neutral(kind: ContactKind) -> AppName {
        AppName(
            match kind {
                ContactKind::Email => "your email app",
                ContactKind::Mobile => "your messages app",
            }
            .to_owned(),
        )
    }
}
/// Whether the person was put in To.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToLine {
    Addressed,
    OpenedWithoutRecipient,
}
/// What the page is told once a note opened: the app that holds it, whether the person is in To,
/// and when not, why. Made only here, from an `AppName` and a closed reason.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct Opened {
    app: AppName,
    result: ToLine,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<NoRecipient>,
}
impl Opened {
    fn new(app: AppName, to: Result<(), NoRecipient>) -> Self {
        let (result, reason) = match to {
            Ok(()) => (ToLine::Addressed, None),
            Err(reason) => (ToLine::OpenedWithoutRecipient, Some(reason)),
        };
        Self {
            app,
            result,
            reason,
        }
    }
}

#[cfg(test)]
#[path = "contact_tests.rs"]
mod tests;
