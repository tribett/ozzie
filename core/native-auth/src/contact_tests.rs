//! Filling in To on a drafted note, over an injected HTTP boundary. Fictional people, `example.org`
//! addresses and `555-01xx` numbers only.
use super::*;
use crate::{
    credentials::{CredentialStore, StoreError},
    oauth::{AuthError, Binding, Provider, Tokens},
    source::{SourcePage, parse_request, project_page, status_error},
    sunday_check::{SundayCapture, load_recording, save_recording},
};
use serde_json::json;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::AtomicUsize,
};

const SECRET: &str = "fictional-native-secret-canary";
const PEOPLE: &str = "https://api.planningcenteronline.com/people/v2/people";
const EMAILS: &str =
    "include=emails&fields[Person]=child,emails&fields[Email]=address,primary,blocked";
const NUMBERS: &str = "include=phone_numbers&fields[Person]=child,phone_numbers&fields[PhoneNumber]=number,primary,location";
/// Riley Example, a fictional volunteer the check showed.
const RILEY: &str = "50";
const ADDRESS: &str = "riley.example@example.org";
const NUMBER: &str = "+1 (312) 555-0101";
const PEOPLE_SCOPE: &str = "services-and-operations";
/// Each fragment of the address and the number that must never be in a reply.
const FRAGMENTS: &[&str] = &[
    "riley", "example", ".org", "%40", "@", "312", "555", "0101", "5550101",
];

fn stored(scopes: &str) -> Vec<u8> {
    format!(
        r#"{{"client_id":"fictional-client","organization":"1001","tokens":{{"access_token":"{SECRET}","refresh_token":"fictional-refresh-canary","token_type":"bearer","expires_in":7200}},"scopes":"{scopes}"}}"#
    )
    .into_bytes()
}
/// The saved sign-in. A refresh may save it again (`refreshed`); nothing else is written.
struct Store(Mutex<Vec<u8>>, AtomicUsize);
impl CredentialStore for Store {
    fn put(&self, _: &str, _: &str, value: &[u8]) -> Result<(), StoreError> {
        *self.0.lock().unwrap() = value.to_vec();
        Ok(())
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.1.fetch_add(1, Ordering::SeqCst);
        Ok(Some(self.0.lock().unwrap().clone()))
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        panic!("addressing a note never deletes credentials")
    }
}
/// Planning Center's identity check, counted, optionally slow.
struct Identity(AtomicUsize, u64);
impl Provider for Identity {
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        assert_eq!(access, SECRET);
        self.0.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(self.1));
        Ok("1001".into())
    }
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no sign-in is ever started from here")
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        Ok(Tokens {
            access_token: SECRET.into(),
            refresh_token: Some("fictional-refresh-canary".into()),
            token_type: "bearer".into(),
            expires_in: 7200,
        })
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("no revoke")
    }
}
struct Connection {
    auth: Arc<AuthController>,
    store: Arc<Store>,
    identity: Arc<Identity>,
}
fn connection(scopes: &str, slow_identity_ms: u64) -> Connection {
    let store = Arc::new(Store(Mutex::new(stored(scopes)), AtomicUsize::new(0)));
    let identity = Arc::new(Identity(AtomicUsize::new(0), slow_identity_ms));
    let auth = AuthController::new(
        Binding {
            workspace: "local:1001".into(),
            organization: "1001".into(),
            client_id: "fictional-client".into(),
        },
        store.clone(),
        identity.clone(),
        Arc::new(|| 0),
    )
    .unwrap();
    Connection {
        auth: Arc::new(auth),
        store,
        identity,
    }
}
fn controller(scopes: &str) -> Arc<AuthController> {
    connection(scopes, 0).auth
}

/// Answers every read with one raw reply (or error), after `stall` ms, and records each URL.
struct Answer {
    reply: Result<Value, SourceError>,
    stall: u64,
    seen: Mutex<Vec<String>>,
}
impl Answer {
    fn new(reply: Result<Value, SourceError>) -> Arc<Self> {
        Self::slow(reply, 0)
    }
    fn slow(reply: Result<Value, SourceError>, stall: u64) -> Arc<Self> {
        Arc::new(Self {
            reply,
            stall,
            seen: Mutex::new(Vec::new()),
        })
    }
    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}
impl SourceHttp for Answer {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        assert_eq!(access, SECRET);
        self.seen.lock().unwrap().push(request.url());
        std::thread::sleep(Duration::from_millis(self.stall));
        let raw = self.reply.clone()?;
        project_page(
            request,
            &serde_json::to_vec(&raw).unwrap(),
            &Default::default(),
        )
    }
}
fn http(answer: &Arc<Answer>) -> MakeHttp {
    let answer = answer.clone();
    Box::new(move || Ok(answer as Arc<dyn SourceHttp + Send + Sync>))
}

/// A check's capture naming `people`, each linked by its plan's people (a `team_members` read), as
/// a check would record them.
fn capture(organization: &str, people: &[&str]) -> SundayCapture {
    let rows: Vec<Value> = people
        .iter()
        .enumerate()
        .map(|(n, id)| {
            json!({"id": (9000 + n).to_string(), "type": "PlanPerson", "attributes": {"status": "C"},
                   "relationships": {"person": {"data": {"id": id, "type": "Person"}}}})
        })
        .collect();
    let read = json!({"collection": "team_members", "offset": 0, "checked_at": "2026-11-20T15:00:30.000Z",
                      "outcome": "ok", "body": {"data": rows}});
    let mut capture = unlinked(organization, people);
    capture.reads = vec![serde_json::from_value(read).unwrap()];
    capture
}
/// The same names with no read linking anyone, as a recording written by hand could hold.
fn unlinked(organization: &str, people: &[&str]) -> SundayCapture {
    SundayCapture {
        version: 1,
        kind: "live".into(),
        organization: organization.into(),
        service_type_id: "10".into(),
        plan_id: "20".into(),
        started_at: "2026-11-20T15:00:00.000Z".into(),
        completed_at: "2026-11-20T15:01:00.000Z".into(),
        reads: Vec::new(),
        names: people
            .iter()
            .map(|id| ((*id).to_owned(), format!("Fictional Person {id}")))
            .collect(),
        labels: BTreeMap::new(),
        kids_teams: Vec::new(),
        forms: None,
        checkins_event: None,
    }
}
fn checked(people: &[&str]) -> CheckedPeople {
    let checked = CheckedPeople::default();
    checked.remember(&capture("1001", people));
    checked
}

fn email(id: &str, address: Value, primary: bool, blocked: bool) -> Value {
    json!({"type": "Email", "id": id,
           "attributes": {"address": address, "primary": primary, "blocked": blocked, "location": "Home", "verified": true,
                          "created_at": "2020-01-01T00:00:00Z"},
           "relationships": {"person": {"data": {"type": "Person", "id": RILEY}}},
           "links": {"self": "https://api.planningcenteronline.com/people/v2/emails/1"}})
}
fn phone(id: &str, number: Value, primary: bool, location: Value) -> Value {
    json!({"type": "PhoneNumber", "id": id,
           "attributes": {"number": number, "primary": primary, "location": location, "carrier": "fictional-carrier-canary",
                          "e164": "+13125550199", "national": "(312) 555-0199"},
           "relationships": {"person": {"data": {"type": "Person", "id": RILEY}}}})
}
/// Riley's People record as Planning Center would send it, with things never asked for alongside.
fn record(child: Value, link: &str, rows: Vec<Value>) -> Value {
    let ids: Vec<Value> = rows
        .iter()
        .map(|row| json!({"type": row["type"], "id": row["id"]}))
        .collect();
    json!({
        "data": {"type": "Person", "id": RILEY,
                 "attributes": {"child": child, "name": "Riley Canary-Name", "birthdate": "2001-02-03", "medical_notes": "care-canary"},
                 "relationships": {link: {"data": ids}, "households": {"data": [{"type": "Household", "id": "9"}]}},
                 "links": {"self": "https://api.planningcenteronline.com/people/v2/people/50"}},
        "included": rows,
        "meta": {"can_include": ["emails", "phone_numbers"], "parent": {"type": "Organization", "id": "1001"}},
        "links": {"self": "https://api.planningcenteronline.com/people/v2/people/50"},
    })
}
fn mail(rows: Vec<Value>) -> Value {
    record(json!(false), "emails", rows)
}
fn messages(rows: Vec<Value>) -> Value {
    record(json!(false), "phone_numbers", rows)
}
fn mail_reply() -> Value {
    mail(vec![email("801", json!(ADDRESS), true, false)])
}
fn messages_reply() -> Value {
    messages(vec![phone("901", json!(NUMBER), true, json!("Mobile"))])
}
fn request(kind: ContactKind, person: &str) -> SourceRequest {
    let binding = Binding {
        workspace: "local:1001".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    };
    SourceRequest::capture_at(
        &binding,
        "",
        "",
        kind.collection(),
        &Target::people_person(person),
        1,
        0,
    )
    .unwrap()
}
/// What the rules choose from one reply, through the same projection a live read takes.
fn chosen(kind: ContactKind, reply: Value) -> Result<String, NoRecipient> {
    let page = project_page(
        &request(kind, RILEY),
        &serde_json::to_vec(&reply).unwrap(),
        &Default::default(),
    )
    .map_err(|_| NoRecipient::CouldNotRead)?;
    choose(page.body(), RILEY, kind).map(|r| r.value.to_string())
}
/// One read of Riley, as the draft command makes it.
fn read_as(
    auth: &Arc<AuthController>,
    people: &CheckedPeople,
    turns: &Turns,
    kind: ContactKind,
    answer: &Arc<Answer>,
    limit: Duration,
) -> Result<String, NoRecipient> {
    let auth = auth.clone();
    read_recipient_with(
        people,
        turns,
        RILEY,
        kind,
        move || Some(auth),
        http(answer),
        limit,
    )
    .map(|r| r.value.to_string())
}
fn read(
    auth: &Arc<AuthController>,
    people: &CheckedPeople,
    kind: ContactKind,
    answer: &Arc<Answer>,
) -> Result<String, NoRecipient> {
    read_as(auth, people, &Turns::default(), kind, answer, OPEN_DEADLINE)
}

#[test]
fn the_contact_reads_are_two_exact_get_urls_with_the_people_version() {
    let http = NativeSourceHttp::new().unwrap();
    for (kind, query) in [(ContactKind::Email, EMAILS), (ContactKind::Mobile, NUMBERS)] {
        let request = request(kind, RILEY);
        let url = format!("{PEOPLE}/50?{query}");
        assert_eq!(request.url(), url);
        let built = http.build(&request, SECRET).unwrap();
        assert_eq!(built.method(), reqwest::Method::GET);
        assert!(built.body().is_none());
        assert_eq!(built.url().as_str(), url);
        assert_eq!(built.headers()["x-pco-api-version"], "2025-11-10");
        assert_eq!(request.collection.product(), Product::People);
    }
}

#[test]
fn a_contact_read_names_one_person_and_nothing_else_and_never_reaches_the_stdin_protocol() {
    let binding = Binding {
        workspace: "local:1001".into(),
        organization: "1001".into(),
        client_id: "fictional-client".into(),
    };
    for collection in [Collection::PersonEmails, Collection::PersonPhoneNumbers] {
        let make = |service_type: &str, plan: &str, target: Target, offset: u64| {
            SourceRequest::capture_at(&binding, service_type, plan, collection, &target, 1, offset)
                .err()
        };
        let invalid = Some(SourceError::InvalidRequest);
        assert_eq!(make("", "", Target::people_person("50"), 0), None);
        // No plan, no other id, no paging, and exactly one person.
        assert_eq!(make("10", "20", Target::people_person("50"), 0), invalid);
        assert_eq!(make("10", "", Target::people_person("50"), 0), invalid);
        assert_eq!(make("", "", Target::default(), 0), invalid);
        assert_eq!(make("", "", Target::person("50"), 0), invalid);
        assert_eq!(make("", "", Target::groups_person("50"), 0), invalid);
        assert_eq!(make("", "", Target::people_person("50"), 1), invalid);
        let mut two = Target::people_person("50");
        two.team_id = Some("70".into());
        assert_eq!(make("", "", two, 0), invalid);
        for bad in [
            "050",
            "5x",
            "50/../51",
            "50?include=addresses",
            " 50",
            "",
            "50&fields[Person]=name",
        ] {
            assert_eq!(
                make("", "", Target::people_person(bad), 0),
                invalid,
                "{bad}"
            );
        }
        // The stdin protocol can't name it.
        let text = format!(
            r#"{{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"","plan_id":"","collection":"{}","per_page":1,"offset":0}}"#,
            collection.label()
        );
        assert_eq!(
            parse_request(text.as_bytes()).err(),
            Some(SourceError::InvalidRequest)
        );
    }
}

/// Only the person's child flag, their rows' ids and each row's chosen fields survive the projection:
/// the name, birthdate, notes, households, links, location, carrier and every other field are dropped.
#[test]
fn the_projection_keeps_only_what_choosing_needs() {
    let page = project_page(
        &request(ContactKind::Email, RILEY),
        &serde_json::to_vec(&mail_reply()).unwrap(),
        &Default::default(),
    )
    .unwrap();
    assert_eq!(
        page.body(),
        &json!({
            "data": {"id": "50", "type": "Person", "attributes": {"child": false},
                     "relationships": {"emails": {"data": [{"id": "801", "type": "Email"}]}}},
            "included": [{"id": "801", "type": "Email", "attributes": {"address": ADDRESS, "primary": true, "blocked": false}}],
            "meta": {},
            "links": {},
        })
    );
    assert!(page.labels().is_empty());
    let page = project_page(
        &request(ContactKind::Mobile, RILEY),
        &serde_json::to_vec(&messages_reply()).unwrap(),
        &Default::default(),
    )
    .unwrap();
    assert_eq!(
        page.body()["included"],
        json!([{"id": "901", "type": "PhoneNumber", "attributes": {"number": NUMBER, "primary": true, "location": "Mobile"}}])
    );
    let text = page.body().to_string();
    for canary in [
        "Canary-Name",
        "2001-02-03",
        "care-canary",
        "fictional-carrier-canary",
        "Household",
        "e164",
    ] {
        assert!(!text.contains(canary), "{canary}");
    }
}

#[test]
fn mail_gets_the_primary_address_not_marked_blocked_and_never_a_guess() {
    let other = "riley.other@example.org";
    let cases = [
        // The primary one.
        (
            vec![
                email("801", json!(other), false, false),
                email("802", json!(ADDRESS), true, false),
            ],
            Ok(ADDRESS),
        ),
        // No primary, only one: that one.
        (
            vec![email("801", json!(ADDRESS), false, false)],
            Ok(ADDRESS),
        ),
        // A blocked primary isn't used; the one address left is.
        (
            vec![
                email("801", json!(other), true, true),
                email("802", json!(ADDRESS), false, false),
            ],
            Ok(ADDRESS),
        ),
        // Several, none primary: Ozzie doesn't choose.
        (
            vec![
                email("801", json!(other), false, false),
                email("802", json!(ADDRESS), false, false),
            ],
            Err(NoRecipient::MoreThanOne),
        ),
        // A blocked primary and two others: still a choice Ozzie won't make.
        (
            vec![
                email("801", json!(ADDRESS), true, true),
                email("802", json!(other), false, false),
                email("803", json!("x@example.org"), false, false),
            ],
            Err(NoRecipient::MoreThanOne),
        ),
        // Two marked primary.
        (
            vec![
                email("801", json!(other), true, false),
                email("802", json!(ADDRESS), true, false),
            ],
            Err(NoRecipient::MoreThanOne),
        ),
        // None, only blocked ones, or only empty ones: nothing usable on file.
        (vec![], Err(NoRecipient::NoneOnFile)),
        (
            vec![email("801", json!(ADDRESS), true, true)],
            Err(NoRecipient::NoneOnFile),
        ),
        (
            vec![
                email("801", Value::Null, true, false),
                email("802", json!(""), false, false),
            ],
            Err(NoRecipient::NoneOnFile),
        ),
        // The chosen one isn't one plain address.
        (
            vec![email(
                "801",
                json!("riley.example@example.org\r\nBcc: other@example.org"),
                true,
                false,
            )],
            Err(NoRecipient::CouldNotRead),
        ),
    ];
    for (rows, expected) in cases {
        let label = serde_json::to_string(&rows).unwrap();
        assert_eq!(
            chosen(ContactKind::Email, mail(rows)),
            expected.map(str::to_owned),
            "{label}"
        );
    }
}

#[test]
fn messages_gets_the_primary_mobile_number_and_never_a_guess() {
    let mobile =
        |id: &str, number: &str, primary: bool| phone(id, json!(number), primary, json!("Mobile"));
    let home =
        |id: &str, number: &str, primary: bool| phone(id, json!(number), primary, json!("Home"));
    let cases = [
        (
            vec![
                home("901", "312-555-0102", false),
                mobile("902", NUMBER, true),
            ],
            Ok("+13125550101"),
        ),
        // The primary number is a home phone: the one mobile is used.
        (
            vec![
                home("901", "312-555-0102", true),
                mobile("902", NUMBER, false),
            ],
            Ok("+13125550101"),
        ),
        // Planning Center's spelling of the location doesn't matter.
        (
            vec![phone(
                "901",
                json!("(312) 555-0103"),
                false,
                json!(" MOBILE "),
            )],
            Ok("3125550103"),
        ),
        (
            vec![
                mobile("901", NUMBER, false),
                mobile("902", "312.555.0104", false),
            ],
            Err(NoRecipient::MoreThanOne),
        ),
        (
            vec![
                mobile("901", NUMBER, true),
                mobile("902", "312.555.0104", true),
            ],
            Err(NoRecipient::MoreThanOne),
        ),
        // No mobile number: a home, work or unlabelled one is never texted.
        (
            vec![
                home("901", NUMBER, true),
                phone("902", json!(NUMBER), false, json!("Work")),
                phone("903", json!(NUMBER), false, Value::Null),
            ],
            Err(NoRecipient::NoneOnFile),
        ),
        (vec![], Err(NoRecipient::NoneOnFile)),
        (vec![mobile("901", "", true)], Err(NoRecipient::NoneOnFile)),
        (
            vec![mobile("901", "312-555-0101 ext 2", true)],
            Err(NoRecipient::CouldNotRead),
        ),
    ];
    for (rows, expected) in cases {
        let label = serde_json::to_string(&rows).unwrap();
        assert_eq!(
            chosen(ContactKind::Mobile, messages(rows)),
            expected.map(str::to_owned),
            "{label}"
        );
    }
}

#[test]
fn a_child_is_never_addressed_nor_anyone_whose_record_doesnt_say() {
    for (kind, link, row) in [
        (
            ContactKind::Email,
            "emails",
            email("801", json!(ADDRESS), true, false),
        ),
        (
            ContactKind::Mobile,
            "phone_numbers",
            phone("901", json!(NUMBER), true, json!("Mobile")),
        ),
    ] {
        assert_eq!(
            chosen(kind, record(json!(true), link, vec![row.clone()])),
            Err(NoRecipient::Child)
        );
        // Unstated or not a plain yes or no: the record is refused, never read as "not a child".
        for unsure in [Value::Null, json!("false"), json!(0)] {
            assert_eq!(
                chosen(kind, record(unsure.clone(), link, vec![row.clone()])),
                Err(NoRecipient::CouldNotRead),
                "{unsure}"
            );
        }
        let mut missing = record(json!(false), link, vec![row.clone()]);
        missing["data"]["attributes"]
            .as_object_mut()
            .unwrap()
            .remove("child");
        assert_eq!(chosen(kind, missing), Err(NoRecipient::CouldNotRead));
    }
}

#[test]
fn only_the_persons_own_linked_rows_are_used() {
    let row = email("801", json!(ADDRESS), true, false);
    // Another person's record.
    let mut other = mail(vec![row.clone()]);
    other["data"]["id"] = json!("51");
    assert_eq!(
        chosen(ContactKind::Email, other),
        Err(NoRecipient::CouldNotRead)
    );
    // A row the record doesn't link, a linked row that isn't there, a row twice, no links at all.
    let mut extra = mail(vec![row.clone()]);
    extra["included"].as_array_mut().unwrap().push(email(
        "802",
        json!("riley.other@example.org"),
        false,
        false,
    ));
    let mut missing = mail(vec![row.clone()]);
    missing["included"] = json!([]);
    let mut twice = mail(vec![row.clone()]);
    twice["included"].as_array_mut().unwrap().push(row.clone());
    let mut unlinked_rows = mail(vec![row.clone()]);
    unlinked_rows["data"]["relationships"]
        .as_object_mut()
        .unwrap()
        .remove("emails");
    let mut no_links = mail(vec![row.clone()]);
    no_links["data"]
        .as_object_mut()
        .unwrap()
        .remove("relationships");
    // Linked as something else.
    let mut wrong_type = mail(vec![row.clone()]);
    wrong_type["data"]["relationships"]["emails"]["data"][0]["type"] = json!("PhoneNumber");
    // A parent that isn't this church.
    let mut parent = mail(vec![row.clone()]);
    parent["meta"]["parent"] = json!({"type": "Organization", "id": "1002"});
    let mut errors = mail(vec![row.clone()]);
    errors["errors"] = json!([{"status": "403"}]);
    for (what, reply) in [
        ("extra", extra),
        ("missing", missing),
        ("twice", twice),
        ("unlinked", unlinked_rows),
        ("no links", no_links),
        ("wrong type", wrong_type),
        ("parent", parent),
        ("errors", errors),
    ] {
        assert_eq!(
            chosen(ContactKind::Email, reply),
            Err(NoRecipient::CouldNotRead),
            "{what}"
        );
    }
    // Phone numbers in a Mail read (and the reverse) are never read as addresses.
    let mut crossed = mail(vec![row.clone()]);
    crossed["included"] = json!([phone("801", json!(NUMBER), true, json!("Mobile"))]);
    assert_eq!(
        chosen(ContactKind::Email, crossed),
        Err(NoRecipient::CouldNotRead)
    );
}

#[test]
fn hostile_email_values_are_refused_and_plain_ones_are_encoded_for_the_address() {
    let long_local = format!("{}@example.org", "a".repeat(65));
    let long_label = format!("riley@{}.example.org", "a".repeat(64));
    let long_total = format!("riley@{}.example.org", vec!["a".repeat(60); 5].join("."));
    for hostile in [
        "riley.example@example.org\r\nBcc: other@example.org",
        "riley.example@example.org\n",
        "riley.example@example.org\r",
        " riley.example@example.org",
        "riley.example@example.org ",
        "riley.example@example.org,other@example.org",
        "riley.example@example.org;other@example.org",
        "riley.example@example.org?cc=other@example.org",
        "riley.example@example.org&bcc=other@example.org",
        "riley.example@example.org%0Abcc:other@example.org",
        "riley%0A@example.org",
        "riley%40other@example.org",
        "riley#frag@example.org",
        "riley.example@example.org#frag",
        "Riley Example <riley.example@example.org>",
        "\"riley example\"@example.org",
        "riley(comment)@example.org",
        "riley:x@example.org",
        "riley\\@example.org",
        "riley@@example.org",
        "riley@other@example.org",
        "riley@example",
        "@example.org",
        "riley@",
        "riley",
        "riley@.example.org",
        "riley@example..org",
        "riley@example.org.",
        ".riley@example.org",
        "riley.@example.org",
        "ri..ley@example.org",
        "riley@-example.org",
        "riley@example-.org",
        "riley@exa_mple.example.org",
        "riley@127.0.0.1",
        "riley@[127.0.0.1]",
        "rïley@example.org",
        "riley@exämple.example.org",
        "riley@example.org\u{202E}",
        "riley@example.org\0",
        "riley\t@example.org",
        "riley@exa mple.example.org",
        "mailto:riley@example.org",
        "javascript:alert(1)//@example.org",
        "",
        &long_local,
        &long_label,
        &long_total,
    ] {
        assert!(Recipient::email(hostile).is_none(), "{hostile:?}");
    }
    for (plain, part) in [
        (ADDRESS, ADDRESS),
        (
            "riley.example+sunday@example.org",
            "riley.example+sunday@example.org",
        ),
        ("o'riley@example.org", "o%27riley@example.org"),
        (
            "riley/team=a@sub.example.org",
            "riley%2Fteam%3Da@sub.example.org",
        ),
        (
            "R1ley_Ex-ample~x@EXAMPLE.org",
            "R1ley_Ex-ample~x@EXAMPLE.org",
        ),
        (
            "riley!$*^`{|}@example.org",
            "riley%21%24%2A%5E%60%7B%7C%7D@example.org",
        ),
        (
            "r@xn--exmple-cua.example.org",
            "r@xn--exmple-cua.example.org",
        ),
    ] {
        let recipient = Recipient::email(plain).unwrap_or_else(|| panic!("{plain}"));
        assert_eq!(recipient.kind(), ContactKind::Email);
        assert_eq!(*recipient.url_part(), part, "{plain}");
    }
}

#[test]
fn hostile_phone_values_are_refused_and_plain_ones_are_digits() {
    for hostile in [
        "312-555-0101 ext 2",
        "+1 (312) 555-0101 x2",
        "1-555-SUNDAY",
        "+1 312 555 0101\n",
        "+1\u{00A0}312 555 0101",
        "+1/312/555/0101",
        "++13125550101",
        "1+3125550101",
        "+03125550101",
        "555-01",
        "1234567890123456",
        "+1 312 555 0101&body=Hi",
        "+1 312 555 0101,+1 312 555 0102",
        "+1 312 555 0101;+1 312 555 0102",
        "+1 312 555 0101?body=Hi",
        "tel:+13125550101",
        "٣١٢٥٥٥٠١٠١",
        "",
        "   ",
        "+",
        "+1 312 555 0101\u{202E}",
        &"1".repeat(65),
    ] {
        assert!(Recipient::mobile(hostile).is_none(), "{hostile:?}");
    }
    for (plain, digits) in [
        (NUMBER, "+13125550101"),
        ("312.555.0101", "3125550101"),
        ("(312) 555-0101", "3125550101"),
        ("+44 555 0101", "+445550101"),
        ("555-0101", "5550101"),
    ] {
        let recipient = Recipient::mobile(plain).unwrap_or_else(|| panic!("{plain}"));
        assert_eq!(recipient.kind(), ContactKind::Mobile);
        assert_eq!(*recipient.url_part(), digits, "{plain}");
    }
}

#[test]
fn a_read_goes_out_only_for_someone_a_check_of_this_church_showed() {
    let auth = controller(PEOPLE_SCOPE);
    // Nothing shown yet, someone else, another church's check, or names no read links.
    let nobody = CheckedPeople::default();
    let others = checked(&["51", "52"]);
    let elsewhere = CheckedPeople::default();
    elsewhere.remember(&capture("1002", &[RILEY]));
    let named_only = CheckedPeople::default();
    named_only.remember(&unlinked("1001", &[RILEY]));
    for people in [&nobody, &others, &elsewhere, &named_only] {
        let answer = Answer::new(Ok(mail_reply()));
        assert_eq!(
            read(&auth, people, ContactKind::Email, &answer),
            Err(NoRecipient::NotInThisCheck)
        );
        assert!(answer.seen().is_empty());
    }
    for bad in ["050", "50 ", "", "50/../51"] {
        let answer = Answer::new(Ok(mail_reply()));
        let auth = auth.clone();
        assert_eq!(
            read_recipient_with(
                &checked(&[RILEY]),
                &Turns::default(),
                bad,
                ContactKind::Email,
                move || Some(auth),
                http(&answer),
                OPEN_DEADLINE
            )
            .err(),
            Some(NoRecipient::NotInThisCheck),
            "{bad:?}"
        );
        assert!(answer.seen().is_empty());
    }
    // Checks this session showed for the same church add up; one of another church starts again.
    let people = checked(&["51"]);
    people.remember(&capture("1001", &[RILEY]));
    assert!(people.holds("1001", "51") && people.holds("1001", RILEY));
    assert!(!people.holds("1002", RILEY));
    people.remember(&capture("1002", &["52"]));
    assert!(!people.holds("1001", RILEY) && !people.holds("1001", "51"));
    assert!(people.holds("1002", "52"));
    // No connection: nothing read.
    let answer = Answer::new(Ok(mail_reply()));
    assert_eq!(
        read_recipient_with(
            &checked(&[RILEY]),
            &Turns::default(),
            RILEY,
            ContactKind::Email,
            || None,
            http(&answer),
            OPEN_DEADLINE
        )
        .err(),
        Some(NoRecipient::CouldNotRead)
    );
    assert!(answer.seen().is_empty());
    // Shown, connected to that church: one exact GET.
    let answer = Answer::new(Ok(mail_reply()));
    assert_eq!(
        read(&auth, &checked(&[RILEY]), ContactKind::Email, &answer),
        Ok(ADDRESS.into())
    );
    assert_eq!(answer.seen(), [format!("{PEOPLE}/50?{EMAILS}")]);
}

/// A capture whose answered `team_leaders` read for team 70 shows `leaders` (one `TeamLeader` row
/// each), beside a plan linking `people`.
fn with_leaders(people: &[&str], leaders: &[&str]) -> SundayCapture {
    let mut capture = capture("1001", people);
    let rows: Vec<Value> = leaders
        .iter()
        .enumerate()
        .map(|(n, id)| {
            json!({"id": (8500 + n).to_string(), "type": "TeamLeader", "attributes": {},
                   "relationships": {"people": {"data": {"id": id, "type": "Person"}}, "team": {"data": {"id": "70", "type": "Team"}}}})
        })
        .collect();
    capture.reads.push(
        serde_json::from_value(
            json!({"collection": "team_leaders", "team_id": "70", "offset": 0,
            "checked_at": "2026-11-20T15:00:40.000Z", "outcome": "ok", "body": {"data": rows}}),
        )
        .unwrap(),
    );
    capture
}

/// Review G, L-e: a team's leader the check shows only as leader (it keeps no name for them, and
/// the page still offers them a note) can be addressed, read exactly as the page reads leaders; a
/// leaders read that didn't answer, a link to anything but a Person and a row that isn't a
/// `TeamLeader` add nobody; leaders count toward the bound.
#[test]
fn a_team_leader_the_check_shows_can_be_addressed() {
    let capture = with_leaders(&[RILEY], &["52"]);
    assert!(!capture.names.contains_key("52"));
    let people = CheckedPeople::default();
    people.remember(&capture);
    assert!(people.holds("1001", RILEY) && people.holds("1001", "52"));
    let auth = controller(PEOPLE_SCOPE);
    let mut reply = mail_reply();
    reply["data"]["id"] = json!("52");
    let answer = Answer::new(Ok(reply));
    let a = auth.clone();
    assert_eq!(
        read_recipient_with(
            &people,
            &Turns::default(),
            "52",
            ContactKind::Email,
            move || Some(a),
            http(&answer),
            OPEN_DEADLINE
        )
        .map(|r| r.value.to_string()),
        Ok(ADDRESS.into())
    );
    assert_eq!(answer.seen(), [format!("{PEOPLE}/52?{EMAILS}")]);
    // A child leader is still never addressed.
    let mut child = record(
        json!(true),
        "emails",
        vec![email("801", json!(ADDRESS), true, false)],
    );
    child["data"]["id"] = json!("52");
    let a = auth.clone();
    assert_eq!(
        read_recipient_with(
            &people,
            &Turns::default(),
            "52",
            ContactKind::Email,
            move || Some(a),
            http(&Answer::new(Ok(child))),
            OPEN_DEADLINE
        )
        .err(),
        Some(NoRecipient::Child)
    );
    // Both link spellings the page reads (`people`, `person`), one or a list.
    let mut spelled = with_leaders(&[], &[]);
    spelled.reads[1].body = Some(json!({"data": [
        {"id": "8501", "type": "TeamLeader", "relationships": {"person": {"data": {"id": "53", "type": "Person"}}}},
        {"id": "8502", "type": "TeamLeader", "relationships": {"people": {"data": [{"id": "54", "type": "Person"}, {"id": "55", "type": "Person"}]}}},
    ]}));
    let people = CheckedPeople::default();
    people.remember(&spelled);
    assert!(["53", "54", "55"].iter().all(|id| people.holds("1001", id)));
    // What adds nobody.
    let mut cases = Vec::new();
    for outcome in ["denied", "provider-failure", "truncated"] {
        let mut c = with_leaders(&[], &["56"]);
        c.reads[1].outcome = outcome.into();
        cases.push(c);
    }
    let mut no_team = with_leaders(&[], &["56"]);
    no_team.reads[1].team_id = None;
    cases.push(no_team);
    let mut team_link = with_leaders(&[], &["56"]);
    team_link.reads[1].body.as_mut().unwrap()["data"][0]["relationships"]["people"]["data"]["type"] =
        json!("Team");
    cases.push(team_link);
    let mut not_a_leader = with_leaders(&[], &["56"]);
    not_a_leader.reads[1].body.as_mut().unwrap()["data"][0]["type"] = json!("PlanPerson");
    cases.push(not_a_leader);
    let mut odd_id = with_leaders(&[], &["056"]);
    odd_id.reads[1].collection = "team_leaders".into();
    cases.push(odd_id);
    let mut other_read = with_leaders(&[], &["56"]);
    other_read.reads[1].collection = "person_blockouts".into();
    cases.push(other_read);
    for case in cases {
        let people = CheckedPeople::default();
        people.remember(&case);
        assert!(!people.holds("1001", "56") && !people.holds("1001", "056"));
    }
    // The bound counts leaders too.
    let many: Vec<String> = (1..=MAX_CHECKED_PEOPLE + 10)
        .map(|n| (1000 + n).to_string())
        .collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    let people = CheckedPeople::default();
    people.remember(&with_leaders(&[RILEY], &refs));
    let held = many.iter().filter(|id| people.holds("1001", id)).count()
        + usize::from(people.holds("1001", RILEY));
    assert_eq!(held, MAX_CHECKED_PEOPLE);
}

/// Review Y, L2: only people the capture's own reads link are remembered, and never more than the
/// bound, a new church's included.
#[test]
fn only_linked_people_are_remembered_up_to_a_bound() {
    // The reviewer's recording written by hand: 20,000 names and no read linking any of them.
    let dir = Scratch::new("planted");
    let completed = "2026-11-20T15:02:00.000Z";
    let name = format!(
        "sunday-1001-20-{}.json",
        crate::sunday_check::parse_rfc3339(completed).unwrap()
    );
    let ids: Vec<String> = (0..20_000u64)
        .map(|n| (90_000_000 + n).to_string())
        .collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut text = serde_json::to_value(unlinked("1001", &refs)).unwrap();
    text["completed_at"] = json!(completed);
    std::fs::write(dir.0.join(&name), serde_json::to_vec(&text).unwrap()).unwrap();
    let loaded = load_recording(&dir.0, "1001", &name).unwrap();
    assert!(loaded.reads.is_empty());
    let people = checked(&[RILEY]);
    people.remember(&loaded);
    assert_eq!(ids.iter().filter(|id| people.holds("1001", id)).count(), 0);
    assert!(people.holds("1001", RILEY));
    // A name the reads don't link is left out; one they link without a name too.
    let mut partly = capture("1001", &["60", "61"]);
    partly
        .names
        .insert("62".into(), "Fictional Person 62".into());
    partly.names.remove("61");
    let people = CheckedPeople::default();
    people.remember(&partly);
    assert!(people.holds("1001", "60"));
    assert!(!people.holds("1001", "61") && !people.holds("1001", "62"));
    // A link that isn't to a Person isn't one.
    let mut team = capture("1001", &["63"]);
    team.reads[0].body.as_mut().unwrap()["data"][0]["relationships"]["person"]["data"]["type"] =
        json!("Team");
    let people = CheckedPeople::default();
    people.remember(&team);
    assert!(!people.holds("1001", "63"));
    // The bound holds for a first capture, a new church's and an added one.
    let many: Vec<String> = (1..=MAX_CHECKED_PEOPLE + 10)
        .map(|n| (1000 + n).to_string())
        .collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    let big = capture("1002", &refs);
    let people = checked(&[RILEY]);
    people.remember(&big);
    let held = many.iter().filter(|id| people.holds("1002", id)).count();
    assert_eq!(held, MAX_CHECKED_PEOPLE);
    // Past the bound only the newest check's people are held.
    people.remember(&capture("1002", &[RILEY]));
    assert!(people.holds("1002", RILEY));
    assert_eq!(many.iter().filter(|id| people.holds("1002", id)).count(), 0);
}

#[test]
fn a_sign_in_without_people_is_not_allowed_and_nothing_is_read_or_started() {
    for scopes in ["services", "services+check-ins+registrations"] {
        let auth = controller(scopes);
        for kind in [ContactKind::Email, ContactKind::Mobile] {
            let answer = Answer::new(Ok(mail_reply()));
            assert_eq!(
                read(&auth, &checked(&[RILEY]), kind, &answer),
                Err(NoRecipient::NotAllowed)
            );
            assert!(answer.seen().is_empty(), "{scopes}");
        }
        // `Identity` panics on any sign-in or revoke: none was started.
    }
    // Once this session has verified the sign-in, that it lacks People is known without asking the
    // Keychain or Planning Center anything.
    let known = connection("services", 0);
    known.auth.refresh().unwrap();
    assert!(known.auth.status().unwrap().scopes.is_some());
    let (keychain, identity) = (
        known.store.1.load(Ordering::SeqCst),
        known.identity.0.load(Ordering::SeqCst),
    );
    let answer = Answer::new(Ok(mail_reply()));
    assert_eq!(
        read(&known.auth, &checked(&[RILEY]), ContactKind::Email, &answer),
        Err(NoRecipient::NotAllowed)
    );
    assert!(answer.seen().is_empty());
    assert_eq!(known.store.1.load(Ordering::SeqCst), keychain);
    assert_eq!(known.identity.0.load(Ordering::SeqCst), identity);
}

#[test]
fn planning_center_errors_and_timeouts_open_the_note_without_a_recipient() {
    let auth = controller(PEOPLE_SCOPE);
    for (error, expected) in [
        (SourceError::Denied, NoRecipient::NotAllowed),
        (SourceError::ProviderFailure, NoRecipient::CouldNotRead),
        (SourceError::Timeout, NoRecipient::CouldNotRead),
        (SourceError::InvalidResponse, NoRecipient::CouldNotRead),
        (SourceError::Oversized, NoRecipient::CouldNotRead),
        (
            SourceError::RateLimited(Some(20)),
            NoRecipient::CouldNotRead,
        ),
        (SourceError::Rejected, NoRecipient::CouldNotRead),
        (SourceError::Locked, NoRecipient::CouldNotRead),
        (SourceError::Cancelled, NoRecipient::CouldNotRead),
    ] {
        for kind in [ContactKind::Email, ContactKind::Mobile] {
            let answer = Answer::new(Err(error));
            assert_eq!(
                read(&auth, &checked(&[RILEY]), kind, &answer),
                Err(expected),
                "{error:?}"
            );
            assert_eq!(answer.seen().len(), 1);
        }
    }
    // How Planning Center's statuses read for this request: refused is not-allowed, the rest a failure.
    let request = request(ContactKind::Email, RILEY);
    for (status, expected) in [
        (401, NoRecipient::NotAllowed),
        (403, NoRecipient::NotAllowed),
        (404, NoRecipient::CouldNotRead),
        (429, NoRecipient::CouldNotRead),
        (500, NoRecipient::CouldNotRead),
    ] {
        assert_eq!(
            status_error(&request, status, None).map(refused),
            Some(expected),
            "{status}"
        );
    }
    // The Keychain: refusing is not-allowed, locked is could-not-read (the doc says so).
    assert_eq!(refused(SourceError::Denied), NoRecipient::NotAllowed);
    assert_eq!(refused(SourceError::Locked), NoRecipient::CouldNotRead);
}

/// Waits until nobody holds the turn (the read's own thread has finished), up to two seconds.
fn settled(turns: &Turns) -> bool {
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        if turns.take_now(Reader::Note).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Review Y, L3: one deadline for the whole open. A read that stalls is given up at the deadline, the
/// note opens with no one in To, the read is cancelled (no GET goes out after it) and the turn comes
/// back once its thread is done.
#[test]
fn past_the_deadline_the_note_opens_without_a_recipient_and_the_read_is_cancelled() {
    // Planning Center's identity check stalls: the GET never goes out.
    let slow = connection(PEOPLE_SCOPE, 600);
    let turns = Turns::default();
    let answer = Answer::new(Ok(mail_reply()));
    let started = Instant::now();
    assert_eq!(
        read_as(
            &slow.auth,
            &checked(&[RILEY]),
            &turns,
            ContactKind::Email,
            &answer,
            Duration::from_millis(150)
        ),
        Err(NoRecipient::CouldNotRead)
    );
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(140) && took < Duration::from_millis(500),
        "{took:?}"
    );
    assert!(settled(&turns));
    assert!(answer.seen().is_empty(), "cancelled before the GET");
    // The GET itself stalls: given up at the deadline; a late answer is dropped.
    let auth = controller(PEOPLE_SCOPE);
    let turns = Turns::default();
    let answer = Answer::slow(Ok(mail_reply()), 600);
    let started = Instant::now();
    assert_eq!(
        read_as(
            &auth,
            &checked(&[RILEY]),
            &turns,
            ContactKind::Email,
            &answer,
            Duration::from_millis(150)
        ),
        Err(NoRecipient::CouldNotRead)
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(settled(&turns));
    assert_eq!(answer.seen().len(), 1);
    assert_eq!(OPEN_DEADLINE, Duration::from_secs(8));
}

/// Review Y, M1: never beside the Sunday check or setup's picker. While either holds the turn,
/// nothing is read and nobody is asked for the connection.
#[test]
fn while_a_check_or_the_picker_reads_nothing_is_read() {
    let auth = controller(PEOPLE_SCOPE);
    for holder in [Reader::Check, Reader::Picker] {
        let turns = Turns::default();
        let held = turns.take(holder, Duration::ZERO).unwrap();
        let answer = Answer::new(Ok(mail_reply()));
        let asked = AtomicBool::new(false);
        let started = Instant::now();
        let a = auth.clone();
        assert_eq!(
            read_recipient_with(
                &checked(&[RILEY]),
                &turns,
                RILEY,
                ContactKind::Email,
                || {
                    asked.store(true, Ordering::SeqCst);
                    Some(a)
                },
                http(&answer),
                OPEN_DEADLINE
            )
            .err(),
            Some(NoRecipient::BusyWithACheck),
            "{holder:?}"
        );
        assert!(started.elapsed() < Duration::from_millis(50), "never waits");
        assert!(!asked.load(Ordering::SeqCst) && answer.seen().is_empty());
        drop(held);
        assert_eq!(
            read_as(
                &auth,
                &checked(&[RILEY]),
                &turns,
                ContactKind::Email,
                &answer,
                OPEN_DEADLINE
            ),
            Ok(ADDRESS.into())
        );
    }
}

/// Review Y, L4: one note at a time (the second opens at once, unaddressed, `busy-with-another-note`)
/// and at most `READS_PER_MINUTE` reads a minute (`too-many-just-now`), neither reading anything.
#[test]
fn one_note_at_a_time_and_a_few_a_minute() {
    let auth = controller(PEOPLE_SCOPE);
    let people = checked(&[RILEY]);
    let turns = Turns::default();
    let slow = Answer::slow(Ok(mail_reply()), 400);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            read_as(
                &auth,
                &people,
                &turns,
                ContactKind::Email,
                &slow,
                OPEN_DEADLINE,
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        let second = Answer::new(Ok(mail_reply()));
        let started = Instant::now();
        assert_eq!(
            read_as(
                &auth,
                &people,
                &turns,
                ContactKind::Email,
                &second,
                OPEN_DEADLINE
            ),
            Err(NoRecipient::BusyWithAnotherNote)
        );
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(second.seen().is_empty());
        assert_eq!(first.join().unwrap(), Ok(ADDRESS.into()));
    });
    // The rate: `READS_PER_MINUTE` go out, the next doesn't.
    let people = checked(&[RILEY]);
    let answer = Answer::new(Ok(mail_reply()));
    for _ in 0..READS_PER_MINUTE {
        assert_eq!(
            read(&auth, &people, ContactKind::Email, &answer),
            Ok(ADDRESS.into())
        );
    }
    assert_eq!(
        read(&auth, &people, ContactKind::Email, &answer),
        Err(NoRecipient::TooManyJustNow)
    );
    assert_eq!(answer.seen().len(), READS_PER_MINUTE);
    // A minute after a read, its place is free again.
    let pace = CheckedPeople::default();
    let now = Instant::now();
    for _ in 0..READS_PER_MINUTE {
        assert!(pace.pace(now));
    }
    assert!(!pace.pace(now + Duration::from_secs(59)));
    assert!(pace.pace(now + MINUTE));
    assert_eq!(READS_PER_MINUTE, 10);
}

#[test]
fn the_detail_is_in_no_reply_error_or_debug_form() {
    let auth = controller(PEOPLE_SCOPE);
    let answer = Answer::new(Ok(mail_reply()));
    let a = auth.clone();
    let recipient = read_recipient_with(
        &checked(&[RILEY]),
        &Turns::default(),
        RILEY,
        ContactKind::Email,
        move || Some(a),
        http(&answer),
        OPEN_DEADLINE,
    )
    .unwrap();
    let shown = format!("{recipient:?} {:#?}", recipient);
    assert!(
        !shown.contains("riley") && !shown.contains("example.org"),
        "{shown}"
    );
    assert_eq!(format!("{recipient:?}"), "Recipient(Email, withheld)");
    let address = address("mailto:?body=Hi", 1024, Ok(recipient)).unwrap();
    assert_eq!(
        format!("{address:?} {address:#?}"),
        "Address(withheld) Address(withheld)"
    );
    let recipient = Recipient::mobile(NUMBER).unwrap();
    assert_eq!(format!("{recipient:?}"), "Recipient(Mobile, withheld)");
    // Every reason the page can hear, closed: none carries anything about the person.
    let codes = [
        NoRecipient::NoneOnFile,
        NoRecipient::NotAllowed,
        NoRecipient::CouldNotRead,
        NoRecipient::MoreThanOne,
        NoRecipient::Child,
        NoRecipient::NotInThisCheck,
        NoRecipient::BusyWithACheck,
        NoRecipient::BusyWithAnotherNote,
        NoRecipient::TooManyJustNow,
    ]
    .map(|code| serde_json::to_string(&code).unwrap());
    assert_eq!(
        codes,
        [
            "\"none-on-file\"",
            "\"not-allowed\"",
            "\"could-not-read\"",
            "\"more-than-one\"",
            "\"child\"",
            "\"not-in-this-check\"",
            "\"busy-with-a-check\"",
            "\"busy-with-another-note\"",
            "\"too-many-just-now\""
        ]
    );
}

// ---- The address and the reply, built here (review Y, L5) ------------------------------------------

#[test]
fn recipients_counts_only_what_the_apps_would_read() {
    for unaddressed in [
        "mailto:?body=Hi",
        "mailto:?subject=Sunday%20%26%20you%3F&body=x%26to%3Dother%40example.org",
        "sms:&body=Hi%0A%26cc%3D",
    ] {
        assert_eq!(recipients(unaddressed), Some(0), "{unaddressed}");
    }
    assert_eq!(
        recipients("mailto:riley.example@example.org?subject=Hi&body=Hi"),
        Some(1)
    );
    assert_eq!(recipients("sms:5550101&body=Hi"), Some(1));
    assert_eq!(recipients("sms:+13125550101&body=Hi"), Some(1));
    // Anything that could name a second recipient, or isn't a note's address, counts as none of it.
    for other in [
        "mailto:a@example.org,b@example.org?body=x",
        "mailto:a@example.org%2Cb@example.org?body=x",
        "mailto:a@example.org%2cb@example.org?body=x",
        "mailto:a@example.org;b@example.org?body=x",
        "mailto:a@example.org%3Bb@example.org?body=x",
        "mailto:a@example.org?to=b@example.org&body=x",
        "mailto:?to=b@example.org&body=x",
        "mailto:?cc=b@example.org&body=x",
        "mailto:a@example.org?bcc=b@example.org&body=x",
        "mailto:a@example.org?body=x&body=y",
        "mailto:a@example.org?body=x#frag",
        "mailto:a@example.org",
        "mailto:a@example.org?subject=x",
        "mailto:a@example.org?body",
        "mailto:a%40b@example.org?body=x",
        "mailto:a@b@example.org?body=x",
        "mailto:a%0Ab@example.org?body=x",
        "mailto:a%0db@example.org?body=x",
        "mailto:a b@example.org?body=x",
        "mailto:<a@example.org>?body=x",
        "MAILTO:a@example.org?body=x",
        "sms:+13125550101&body=x&body=y",
        "sms:+13125550101,+13125550102&body=x",
        "sms:+13125550101;+13125550102&body=x",
        "sms:+13125550101?body=x",
        "sms:+13125550101&subject=x",
        "sms:+13125550101&body=x?y",
        "sms:+13125550101&body=x#y",
        "sms:+1312555010a&body=x",
        "sms:+&body=x",
        "sms:++13125550101&body=x",
        "sms:/+13125550101&body=x",
        "tel:+13125550101&body=x",
        "https://example.org/?body=x",
        "",
    ] {
        assert_eq!(recipients(other), None, "{other}");
    }
}

#[test]
fn the_address_names_exactly_its_one_recipient_or_none_and_why() {
    let to = |url: &str, read: Result<Recipient, NoRecipient>| {
        let address = address(url, 8192, read).unwrap();
        (address.url.to_string(), address.recipients, address.to)
    };
    assert_eq!(
        to("mailto:?body=Hi", Ok(Recipient::email(ADDRESS).unwrap())),
        (format!("mailto:{ADDRESS}?body=Hi"), 1, Ok(()))
    );
    assert_eq!(
        to(
            "mailto:?subject=Sunday&body=Hi",
            Ok(Recipient::email("o'riley+sunday@example.org").unwrap())
        ),
        (
            "mailto:o%27riley+sunday@example.org?subject=Sunday&body=Hi".into(),
            1,
            Ok(())
        )
    );
    assert_eq!(
        to("sms:&body=Hi", Ok(Recipient::mobile(NUMBER).unwrap())),
        ("sms:+13125550101&body=Hi".into(), 1, Ok(()))
    );
    // A recipient of the other kind: unaddressed, could-not-read.
    assert_eq!(
        to("sms:&body=Hi", Ok(Recipient::email(ADDRESS).unwrap())),
        ("sms:&body=Hi".into(), 0, Err(NoRecipient::CouldNotRead))
    );
    assert_eq!(
        to("mailto:?body=Hi", Ok(Recipient::mobile(NUMBER).unwrap())),
        ("mailto:?body=Hi".into(), 0, Err(NoRecipient::CouldNotRead))
    );
    // A reason: unaddressed, that reason.
    assert_eq!(
        to("mailto:?body=Hi", Err(NoRecipient::Child)),
        ("mailto:?body=Hi".into(), 0, Err(NoRecipient::Child))
    );
    // Too long once addressed: no address at all, never cut.
    let body = format!("sms:&body={}", "a".repeat(100));
    assert_eq!(
        address(&body, body.len(), Ok(Recipient::mobile(NUMBER).unwrap())).err(),
        Some(AddressError::TooLong)
    );
    // Only a note's own address with no one in To is ever addressed.
    for not_a_draft in [
        "mailto:other@example.org?body=Hi",
        "mailto:?cc=other@example.org&body=Hi",
        "sms:+13125550102&body=Hi",
        "tel:+13125550101",
        "https://example.org/?body=Hi",
        "mailto:",
        "",
    ] {
        assert_eq!(
            address(not_a_draft, 8192, Err(NoRecipient::Child)).err(),
            Some(AddressError::NotADraft),
            "{not_a_draft}"
        );
    }
    assert_eq!(
        address("mailto:?body=Hi", 4, Err(NoRecipient::Child)).err(),
        Some(AddressError::NotADraft)
    );
}

thread_local! {
    /// What the stand-in opener was handed, on this test's own thread.
    static OPENED: RefCell<Vec<(String, usize)>> = const { RefCell::new(Vec::new()) };
    /// What the stand-in naming function was asked, on this test's own thread.
    static NAMED: RefCell<Vec<ContactKind>> = const { RefCell::new(Vec::new()) };
}
/// Stands in for the Mac's opener: records the address and opens nothing.
fn stand_in(url: &str, recipients: usize) -> Result<(), NotOpened> {
    OPENED.with(|seen| seen.borrow_mut().push((url.to_owned(), recipients)));
    Ok(())
}
fn unopened(_: &str, _: usize) -> Result<(), NotOpened> {
    Err(NotOpened)
}
/// Stands in for the Mac's lookup of the app: told only Mail or Messages.
fn looked_up(kind: ContactKind) -> Option<AppName> {
    NAMED.with(|asked| asked.borrow_mut().push(kind));
    AppName::shown("Spike Email - Mail & Team Chat")
}
fn nameless(_: ContactKind) -> Option<AppName> {
    None
}

/// The whole reply for every result: addressed in Mail and in Messages, and each reason in both. The
/// opener sees the address; the naming function sees only Mail or Messages, after the opener; the
/// reply holds no fragment of the address.
#[test]
fn every_reply_is_closed_and_holds_no_fragment_of_the_detail() {
    let reasons = [
        (NoRecipient::NoneOnFile, "none-on-file"),
        (NoRecipient::NotAllowed, "not-allowed"),
        (NoRecipient::CouldNotRead, "could-not-read"),
        (NoRecipient::MoreThanOne, "more-than-one"),
        (NoRecipient::Child, "child"),
        (NoRecipient::NotInThisCheck, "not-in-this-check"),
        (NoRecipient::BusyWithACheck, "busy-with-a-check"),
        (NoRecipient::BusyWithAnotherNote, "busy-with-another-note"),
        (NoRecipient::TooManyJustNow, "too-many-just-now"),
    ];
    let app = "Spike Email - Mail & Team Chat";
    for (unaddressed, kind, neutral, recipient) in [
        (
            "mailto:?body=Hi",
            ContactKind::Email,
            "your email app",
            Recipient::email(ADDRESS),
        ),
        (
            "sms:&body=Hi",
            ContactKind::Mobile,
            "your messages app",
            Recipient::mobile(NUMBER),
        ),
    ] {
        OPENED.with(|seen| seen.borrow_mut().clear());
        NAMED.with(|asked| asked.borrow_mut().clear());
        let opened = address(unaddressed, 8192, Ok(recipient.unwrap()))
            .unwrap()
            .open(stand_in, looked_up)
            .unwrap();
        let reply = serde_json::to_string(&opened).unwrap();
        assert_eq!(reply, format!(r#"{{"app":"{app}","result":"addressed"}}"#));
        let handed = OPENED.with(|seen| seen.borrow().clone());
        assert_eq!(handed.len(), 1);
        assert_eq!(handed[0].1, 1);
        assert!(handed[0].0.contains("0101") || handed[0].0.contains(ADDRESS));
        assert_eq!(NAMED.with(|asked| asked.borrow().clone()), [kind]);
        // The app's own name when it can't be read: the neutral one, true whichever app opened.
        let opened = address(unaddressed, 8192, Err(NoRecipient::Child))
            .unwrap()
            .open(stand_in, nameless)
            .unwrap();
        assert_eq!(
            serde_json::to_string(&opened).unwrap(),
            format!(
                r#"{{"app":"{neutral}","result":"opened-without-recipient","reason":"child"}}"#
            )
        );
        for (reason, code) in reasons {
            let opened = address(unaddressed, 8192, Err(reason))
                .unwrap()
                .open(stand_in, looked_up)
                .unwrap();
            let reply = serde_json::to_string(&opened).unwrap();
            assert_eq!(
                reply,
                format!(
                    r#"{{"app":"{app}","result":"opened-without-recipient","reason":"{code}"}}"#
                )
            );
            for fragment in FRAGMENTS {
                assert!(!reply.contains(fragment), "{reply}");
            }
        }
        // Not opened: nothing to reply, and the app isn't looked up.
        NAMED.with(|asked| asked.borrow_mut().clear());
        assert!(
            address(unaddressed, 8192, Err(NoRecipient::Child))
                .unwrap()
                .open(unopened, looked_up)
                .is_err()
        );
        assert!(NAMED.with(|asked| asked.borrow().is_empty()));
    }
    // The reply from an addressed read holds no fragment either.
    let reply = serde_json::to_string(
        &address(
            "mailto:?body=Hi",
            8192,
            Recipient::email(ADDRESS).ok_or(NoRecipient::CouldNotRead),
        )
        .unwrap()
        .open(stand_in, looked_up)
        .unwrap(),
    )
    .unwrap();
    for fragment in FRAGMENTS {
        assert!(!reply.contains(fragment), "{reply}");
    }
}

/// Review F, L-8: an app's own name is said as it is, whatever printable characters it has; only a
/// name that isn't one plain line is refused, and then the neutral name is said instead.
#[test]
fn an_app_name_is_said_as_the_app_names_itself() {
    for plain in [
        "Mail",
        "Messages",
        " Zoho Mail - Desktop ",
        "Airmail 5",
        "Microsoft Outlook",
        "Spike Email - Mail & Team Chat",
        "Mail+ for Gmail",
        "Gmail: Email by Google",
        "Canary Mail 4.2025",
        "Proton Mail / Bridge",
    ] {
        assert_eq!(
            serde_json::to_string(&AppName::shown(plain).unwrap()).unwrap(),
            serde_json::to_string(plain.trim()).unwrap()
        );
    }
    let long = "a".repeat(65);
    for odd in [
        "Mail\nSent",
        "Mail\tSent",
        "Mail\u{2028}Sent",
        "Mail\u{202E}liaM",
        "Mail\u{2066}x",
        "Mail\u{2060}",
        "\u{200B}",
        "\u{FEFF}Mail",
        "",
        "  ",
        &long,
    ] {
        assert_eq!(AppName::shown(odd), None, "{odd:?}");
    }
    assert_eq!(
        serde_json::to_string(&AppName::neutral(ContactKind::Email)).unwrap(),
        "\"your email app\""
    );
    assert_eq!(
        serde_json::to_string(&AppName::neutral(ContactKind::Mobile)).unwrap(),
        "\"your messages app\""
    );
}

/// A scratch folder standing in for the app's data folder.
struct Scratch(PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ozzie-contact-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
/// Every file under `dir`, with its bytes.
fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(next) = todo.pop() {
        for entry in std::fs::read_dir(&next).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                todo.push(path);
            } else {
                files.insert(path.clone(), std::fs::read(&path).unwrap());
            }
        }
    }
    files
}

/// With a saved recording loaded the way the app loads one, every kind of contact read (addressed,
/// each closed reason) leaves the data folder exactly as it was, and no file holds the detail.
#[test]
fn nothing_is_written_to_disk() {
    let dir = Scratch::new("disk");
    let name = save_recording(&dir.0, &capture("1001", &[RILEY])).unwrap();
    let loaded = load_recording(&dir.0, "1001", &name).unwrap();
    let people = CheckedPeople::default();
    people.remember(&loaded);
    assert!(people.holds("1001", RILEY));
    let before = snapshot(&dir.0);
    let auth = controller(PEOPLE_SCOPE);
    let replies = [
        (ContactKind::Email, Ok(mail_reply())),
        (ContactKind::Mobile, Ok(messages_reply())),
        (
            ContactKind::Email,
            Ok(record(
                json!(true),
                "emails",
                vec![email("801", json!(ADDRESS), true, false)],
            )),
        ),
        (ContactKind::Email, Ok(mail(vec![]))),
        (ContactKind::Email, Err(SourceError::Denied)),
        (ContactKind::Mobile, Err(SourceError::Timeout)),
    ];
    for (kind, reply) in replies {
        let _ = read(&auth, &people, kind, &Answer::new(reply));
    }
    let _ = read(
        &controller("services"),
        &people,
        ContactKind::Email,
        &Answer::new(Err(SourceError::Denied)),
    );
    let after = snapshot(&dir.0);
    assert_eq!(before, after);
    for bytes in after.values() {
        let text = String::from_utf8_lossy(bytes);
        assert!(!text.contains(ADDRESS) && !text.contains("555-0101") && !text.contains("5550101"));
    }
}

/// A Sunday check never makes this read, and a recording that held one could neither be saved nor
/// loaded: the recording format has no place for it.
#[test]
fn a_recording_can_never_hold_a_contact_read() {
    let dir = Scratch::new("recording");
    let completed = "2026-11-20T15:02:00.000Z";
    let name = format!(
        "sunday-1001-20-{}.json",
        crate::sunday_check::parse_rfc3339(completed).unwrap()
    );
    for label in ["person_emails", "person_phone_numbers"] {
        let mut text = serde_json::to_value(capture("1001", &[RILEY])).unwrap();
        text["completed_at"] = json!(completed);
        // Written by hand where a recording would be, it loads...
        std::fs::write(dir.0.join(&name), serde_json::to_vec(&text).unwrap()).unwrap();
        assert!(load_recording(&dir.0, "1001", &name).is_ok(), "{label}");
        // ...until it holds a contact read: then it can't load, and can't be saved either.
        text["reads"].as_array_mut().unwrap().push(
            json!({"collection": label, "people_person_id": RILEY, "offset": 0,
            "checked_at": "2026-11-20T15:01:30.000Z", "outcome": "ok",
            "body": {"data": {"id": RILEY, "type": "Person", "attributes": {"child": false}}}}),
        );
        std::fs::write(dir.0.join(&name), serde_json::to_vec(&text).unwrap()).unwrap();
        assert!(load_recording(&dir.0, "1001", &name).is_err(), "{label}");
        let with: SundayCapture = serde_json::from_value(text).unwrap();
        assert_eq!(
            save_recording(&dir.0, &with).map_err(|e| e.kind()),
            Err(std::io::ErrorKind::InvalidData),
            "{label}"
        );
    }
}

// ---- Structure (review Y, L1) ----------------------------------------------------------------------

/// Every path a file names outside its `tests` module, as Rust reads it: each `use` flattened to the
/// path it names (groups opened, `self` and `as` followed), every other path with its first segment
/// put back to the path it was imported from, each macro's name and tokens, and each method call
/// with the function it is made in.
#[derive(Default)]
struct Named {
    within: Vec<String>,
    aliases: BTreeMap<String, String>,
    uses: Vec<String>,
    raw: Vec<(Option<String>, String)>,
    macros: Vec<(String, String)>,
    calls: Vec<(Option<String>, String, String)>,
}
impl Named {
    fn flatten(&mut self, tree: &syn::UseTree, prefix: &str) {
        let original = |name: &str| {
            if name == "self" {
                prefix.trim_end_matches("::").to_owned()
            } else {
                format!("{prefix}{name}")
            }
        };
        match tree {
            syn::UseTree::Path(p) => self.flatten(&p.tree, &format!("{prefix}{}::", p.ident)),
            syn::UseTree::Name(n) => {
                let path = original(&n.ident.to_string());
                let alias = path.rsplit("::").next().unwrap_or_default().to_owned();
                self.aliases.insert(alias, path.clone());
                self.uses.push(path);
            }
            syn::UseTree::Rename(r) => {
                let path = original(&r.ident.to_string());
                self.aliases.insert(r.rename.to_string(), path.clone());
                self.uses.push(path);
            }
            syn::UseTree::Glob(_) => self.uses.push(format!("{prefix}*")),
            syn::UseTree::Group(g) => g.items.iter().for_each(|t| self.flatten(t, prefix)),
        }
    }
    /// Every path, imports included, each as the full path it names.
    fn paths(&self) -> Vec<(Option<String>, String)> {
        let mut all: Vec<(Option<String>, String)> =
            self.uses.iter().map(|u| (None, u.clone())).collect();
        for (within, path) in &self.raw {
            let (first, rest) = path.split_once("::").unwrap_or((path, ""));
            let full = match self.aliases.get(first) {
                Some(original) if rest.is_empty() => original.clone(),
                Some(original) => format!("{original}::{rest}"),
                None => path.clone(),
            };
            all.push((within.clone(), full));
        }
        all
    }
}
impl<'a> syn::visit::Visit<'a> for Named {
    fn visit_item_mod(&mut self, m: &'a syn::ItemMod) {
        if m.ident != "tests" {
            syn::visit::visit_item_mod(self, m);
        }
    }
    fn visit_item_fn(&mut self, f: &'a syn::ItemFn) {
        self.within.push(f.sig.ident.to_string());
        syn::visit::visit_item_fn(self, f);
        self.within.pop();
    }
    fn visit_impl_item_fn(&mut self, f: &'a syn::ImplItemFn) {
        self.within.push(f.sig.ident.to_string());
        syn::visit::visit_impl_item_fn(self, f);
        self.within.pop();
    }
    fn visit_item_use(&mut self, u: &'a syn::ItemUse) {
        let prefix = if u.leading_colon.is_some() { "::" } else { "" };
        self.flatten(&u.tree, prefix);
    }
    fn visit_path(&mut self, p: &'a syn::Path) {
        let joined: Vec<String> = p.segments.iter().map(|s| s.ident.to_string()).collect();
        self.raw
            .push((self.within.last().cloned(), joined.join("::")));
        syn::visit::visit_path(self, p);
    }
    fn visit_macro(&mut self, m: &'a syn::Macro) {
        let name: Vec<String> = m
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        self.macros.push((
            name.join("::"),
            m.tokens.to_string().split_whitespace().collect(),
        ));
        syn::visit::visit_macro(self, m);
    }
    fn visit_expr_method_call(&mut self, call: &'a syn::ExprMethodCall) {
        let receiver = match &*call.receiver {
            syn::Expr::Path(p) => p
                .path
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect::<Vec<_>>()
                .join("::"),
            _ => String::new(),
        };
        self.calls.push((
            self.within.last().cloned(),
            receiver,
            call.method.to_string(),
        ));
        syn::visit::visit_expr_method_call(self, call);
    }
}
fn named(source: &str) -> Named {
    use syn::visit::Visit as _;
    let mut named = Named::default();
    named.visit_file(&syn::parse_file(source).expect("parses"));
    named
}
/// The source files of this crate, by name.
fn sources() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    for dir in [root.clone(), root.join("bin")] {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "rs") {
                let name = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                files.push((name, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}
/// Whether a full path reaches this module: `crate::contact…`, `super::contact…`,
/// `ozzie_native_auth::contact…`, or a bare `contact::…`.
fn reaches_contact(path: &str) -> bool {
    let segments: Vec<&str> = path.split("::").collect();
    segments
        .iter()
        .position(|s| *s == "contact")
        .is_some_and(|at| {
            matches!(
                segments[..at],
                [] | ["crate"] | ["super"] | ["ozzie_native_auth"] | ["", "ozzie_native_auth"]
            ) && (at + 1 < segments.len() || at > 0)
        })
}

/// Structure: in this crate, nothing but this module, its tests, source.rs's allowlist (with its own
/// GET-only test) and the Sunday check's tests of the turn names the contact read; lib.rs only
/// declares it. Imports are read as Rust reads them, so `use crate::{contact as c}` or a glob is
/// caught as plainly as a named path. So no model route, agent step, Ozzie managed, task ledger,
/// recording, check, shared copy for other AI apps or Siri, notice or developer tool can reach it.
#[test]
fn only_this_module_names_the_contact_read() {
    let files = sources();
    assert!(files.len() > 40, "{}", files.len());
    for (name, source) in &files {
        if [
            "contact.rs",
            "contact_tests.rs",
            "source.rs",
            "source_operations_tests.rs",
            "sunday_check_tests.rs",
        ]
        .contains(&name.as_str())
        {
            continue;
        }
        let source = if name == "lib.rs" {
            assert_eq!(source.matches("contact").count(), 1, "lib.rs");
            source.replace("pub mod contact;", "")
        } else {
            source.clone()
        };
        let found = named(&source);
        for (_, path) in found.paths() {
            assert!(!reaches_contact(&path), "{name} reaches {path}");
            for segment in ["PersonEmails", "PersonPhoneNumbers"] {
                assert!(!path.split("::").any(|s| s == segment), "{name}: {path}");
            }
        }
        for (macro_name, tokens) in &found.macros {
            assert!(!tokens.contains("contact::"), "{name}: {macro_name}!");
        }
        for token in [
            "contact::",
            "PersonEmails",
            "PersonPhoneNumbers",
            "person_emails",
            "person_phone_numbers",
            "read_recipient",
            "CheckedPeople",
            "NoRecipient",
            "ContactKind",
        ] {
            assert!(!source.contains(token), "{name} names {token}");
        }
    }
    // The model routes, the agent, managed Ozzie, the ledger and the shared copies are among them.
    for name in [
        "model.rs",
        "agent.rs",
        "hosted.rs",
        "ledger.rs",
        "shared_check.rs",
        "shortcuts_check.rs",
        "sunday_check.rs",
        "phone_notice.rs",
        "name_guard.rs",
        "responsibilities.rs",
        "background.rs",
        "bin/ozzie-dev.rs",
    ] {
        assert!(files.iter().any(|(n, _)| n == name), "{name}");
    }
    // The one test file allowed is compiled only for tests.
    assert!(
        include_str!("sunday_check.rs")
            .contains("#[cfg(test)]\n#[path = \"sunday_check_tests.rs\"]\nmod tests;")
    );
    // The reader catches what plain text would miss.
    let hidden = named("use crate::{contact as c, oauth};\nfn f() { c::read(); }");
    assert!(hidden.paths().iter().any(|(_, p)| reaches_contact(p)));
    let globbed = named("use crate::contact::*;");
    assert!(globbed.paths().iter().any(|(_, p)| reaches_contact(p)));
    assert!(!reaches_contact("contact") && !reaches_contact("self::contact_details"));
}

/// A written-out form of a type, enough to tell one public signature from another.
fn ty(t: &syn::Type) -> String {
    let args = |a: &syn::PathArguments| match a {
        syn::PathArguments::None => String::new(),
        syn::PathArguments::AngleBracketed(g) => format!(
            "<{}>",
            g.args
                .iter()
                .map(|arg| match arg {
                    syn::GenericArgument::Type(t) => ty(t),
                    syn::GenericArgument::Lifetime(_) => "'_".into(),
                    _ => "?".into(),
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
        syn::PathArguments::Parenthesized(p) => format!(
            "({}){}",
            p.inputs.iter().map(ty).collect::<Vec<_>>().join(", "),
            ret(&p.output)
        ),
    };
    let path = |p: &syn::Path| {
        p.segments
            .iter()
            .map(|s| format!("{}{}", s.ident, args(&s.arguments)))
            .collect::<Vec<_>>()
            .join("::")
    };
    let bounds = |b: &syn::punctuated::Punctuated<syn::TypeParamBound, syn::Token![+]>| {
        b.iter()
            .filter_map(|b| match b {
                syn::TypeParamBound::Trait(t) => Some(path(&t.path)),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" + ")
    };
    match t {
        syn::Type::Path(p) => path(&p.path),
        syn::Type::Reference(r) => format!(
            "&{}{}",
            if r.mutability.is_some() { "mut " } else { "" },
            ty(&r.elem)
        ),
        syn::Type::Tuple(t) => format!(
            "({})",
            t.elems.iter().map(ty).collect::<Vec<_>>().join(", ")
        ),
        syn::Type::Slice(s) => format!("[{}]", ty(&s.elem)),
        syn::Type::Array(a) => format!("[{}; _]", ty(&a.elem)),
        syn::Type::ImplTrait(i) => format!("impl {}", bounds(&i.bounds)),
        syn::Type::TraitObject(o) => format!("dyn {}", bounds(&o.bounds)),
        syn::Type::BareFn(f) => format!(
            "fn({}){}",
            f.inputs
                .iter()
                .map(|a| ty(&a.ty))
                .collect::<Vec<_>>()
                .join(", "),
            ret(&f.output)
        ),
        _ => "?".into(),
    }
}
fn ret(output: &syn::ReturnType) -> String {
    match output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, t) => format!(" -> {}", ty(t)),
    }
}
fn signature(owner: &str, sig: &syn::Signature) -> String {
    let inputs: Vec<String> = sig
        .inputs
        .iter()
        .map(|input| match input {
            syn::FnArg::Receiver(r) => match (&r.reference, &r.mutability) {
                (Some(_), Some(_)) => "&mut self".into(),
                (Some(_), None) => "&self".into(),
                _ => "self".into(),
            },
            syn::FnArg::Typed(t) => ty(&t.ty),
        })
        .collect();
    format!(
        "fn {owner}{}({}){}",
        sig.ident,
        inputs.join(", "),
        ret(&sig.output)
    )
}
/// Everything contact.rs makes public, outside its tests: any new public item, field or signature
/// changes this list.
fn public_api() -> Vec<String> {
    let file = syn::parse_file(include_str!("contact.rs")).unwrap();
    let public = |v: &syn::Visibility| matches!(v, syn::Visibility::Public(_));
    let mut api = Vec::new();
    for item in &file.items {
        match item {
            syn::Item::Fn(f) if public(&f.vis) => api.push(signature("", &f.sig)),
            syn::Item::Const(c) if public(&c.vis) => {
                api.push(format!("const {}: {}", c.ident, ty(&c.ty)))
            }
            syn::Item::Static(s) if public(&s.vis) => api.push(format!("static {}", s.ident)),
            syn::Item::Struct(s) if public(&s.vis) => {
                let fields: Vec<String> = s
                    .fields
                    .iter()
                    .filter(|f| public(&f.vis))
                    .map(|f| ty(&f.ty))
                    .collect();
                api.push(format!("struct {} {{{}}}", s.ident, fields.join(", ")));
            }
            syn::Item::Enum(e) if public(&e.vis) => api.push(format!(
                "enum {} {{{}}}",
                e.ident,
                e.variants
                    .iter()
                    .map(|v| v.ident.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            syn::Item::Impl(i) => {
                let owner = ty(&i.self_ty);
                let of = i.trait_.as_ref().map(|(_, path, _)| {
                    path.segments
                        .iter()
                        .map(|s| s.ident.to_string())
                        .collect::<Vec<_>>()
                        .join("::")
                });
                if let Some(of) = of {
                    api.push(format!("impl {of} for {owner}"));
                }
                for inner in &i.items {
                    if let syn::ImplItem::Fn(f) = inner
                        && public(&f.vis)
                    {
                        api.push(signature(&format!("{owner}::"), &f.sig));
                    }
                }
            }
            syn::Item::Use(u) if public(&u.vis) => api.push("pub use".into()),
            syn::Item::Type(t) if public(&t.vis) => api.push(format!("type {}", t.ident)),
            syn::Item::Trait(t) if public(&t.vis) => api.push(format!("trait {}", t.ident)),
            syn::Item::Mod(m) if public(&m.vis) => api.push(format!("mod {}", m.ident)),
            syn::Item::Macro(m) => api.push(format!(
                "macro {}",
                m.mac
                    .path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::")
            )),
            _ => {}
        }
    }
    api
}

/// Review Y, L1: contact.rs's public items, pinned. A new public function (one handing the value
/// back as text, say), field or signature fails here and needs its own review.
#[test]
fn the_public_api_is_exactly_this() {
    assert_eq!(
        public_api(),
        [
            "const OPEN_DEADLINE: Duration",
            "const READS_PER_MINUTE: usize",
            "const MAX_CHECKED_PEOPLE: usize",
            "enum ContactKind {Email, Mobile}",
            "enum NoRecipient {NoneOnFile, NotAllowed, CouldNotRead, MoreThanOne, Child, NotInThisCheck, BusyWithACheck, BusyWithAnotherNote, TooManyJustNow}",
            "struct Recipient {}",
            "impl std::fmt::Debug for Recipient",
            "fn Recipient::email(&str) -> Option<Self>",
            "fn Recipient::mobile(&str) -> Option<Self>",
            "fn Recipient::kind(&self) -> ContactKind",
            "struct CheckedPeople {}",
            "fn CheckedPeople::remember(&self, &SundayCapture)",
            "fn CheckedPeople::holds(&self, &str, &str) -> bool",
            "fn read_recipient(&CheckedPeople, &Turns, &str, ContactKind, impl FnOnce() -> Option<Arc<AuthController>>) -> Result<Recipient, NoRecipient>",
            "fn recipients(&str) -> Option<usize>",
            "enum AddressError {NotADraft, TooLong}",
            "struct Address {}",
            "impl std::fmt::Debug for Address",
            "fn address(&str, usize, Result<Recipient, NoRecipient>) -> Result<Address, AddressError>",
            "struct NotOpened {}",
            "fn Address::open(self, fn(&str, usize) -> Result<(), NotOpened>, fn(ContactKind) -> Option<AppName>) -> Result<Opened, NotOpened>",
            "struct AppName {}",
            "fn AppName::shown(&str) -> Option<AppName>",
            "fn AppName::neutral(ContactKind) -> AppName",
            "enum ToLine {Addressed, OpenedWithoutRecipient}",
            "struct Opened {}",
        ]
    );
}

/// Structure: this module reads only through the turn and the verified, GET-only source path
/// (`verify_source`, then `read_verified_using` on the contact collections), and has no other way
/// out: no network client of its own, no file, no process, no environment, no output, no log, no
/// formatting of a value, no serializing of anything but its closed reply.
#[test]
fn this_module_reaches_only_the_guarded_planning_center_get() {
    let source = include_str!("contact.rs");
    let source = &source[..source.find("#[cfg(test)]\n#[path").unwrap()];
    let found = named(source);
    for (_, path) in found.paths() {
        // By whole segment: any path through these, however it was imported.
        for banned in [
            "reqwest",
            "fs",
            "io",
            "env",
            "process",
            "net",
            "os",
            "File",
            "OpenOptions",
            "Command",
            "log",
            "tracing",
            "Write",
            "Display",
        ] {
            assert!(
                !path.split("::").any(|s| s == banned),
                "contact.rs reaches {path}"
            );
        }
        for banned in ["serde_json::to_", "read_source"] {
            assert!(!path.contains(banned), "contact.rs reaches {path}");
        }
    }
    for (macro_name, tokens) in &found.macros {
        assert!(
            ![
                "write",
                "writeln",
                "print",
                "println",
                "eprint",
                "eprintln",
                "dbg",
                "format_args"
            ]
            .contains(&macro_name.as_str()),
            "contact.rs uses {macro_name}!"
        );
        assert!(
            !tokens.contains(":?"),
            "contact.rs formats a value: {macro_name}!({tokens})"
        );
    }
    assert!(!source.contains("unsafe"));
    // Review G, L-a: no panic or failed-assertion message can carry a value, and nothing of the
    // Objective-C runtime (process-wide state) is reached.
    for (macro_name, tokens) in &found.macros {
        let name = macro_name.rsplit("::").next().unwrap_or_default();
        assert!(
            ![
                "panic",
                "assert",
                "assert_eq",
                "assert_ne",
                "debug_assert_eq",
                "debug_assert_ne",
                "unreachable",
                "todo",
                "unimplemented",
                "msg_send",
                "msg_send_id",
                "class",
                "sel"
            ]
            .contains(&name)
                && !(name == "debug_assert" && tokens.contains(',')),
            "contact.rs uses {macro_name}!"
        );
    }
    for (_, _, method) in &found.calls {
        assert!(
            ![
                "expect",
                "unwrap",
                "expect_err",
                "unwrap_err",
                "unwrap_unchecked"
            ]
            .contains(&method.as_str()),
            "contact.rs calls {method}"
        );
    }
    for (_, path) in found.paths() {
        assert!(!path.starts_with("objc2"), "contact.rs reaches {path}");
    }
    // A page's other forms are never asked for: not its envelope, not its labels.
    for (_, _, method) in &found.calls {
        assert!(
            !["envelope", "labels", "headers"].contains(&method.as_str()),
            "contact.rs calls {method}"
        );
    }
    // The controller is asked for these and nothing else.
    let mut asked: Vec<&str> = found
        .calls
        .iter()
        .filter(|(_, receiver, _)| receiver == "auth")
        .map(|(_, _, method)| method.as_str())
        .collect();
    asked.sort_unstable();
    asked.dedup();
    assert_eq!(
        asked,
        [
            "binding",
            "read_verified_using",
            "status_or_busy",
            "verify_source"
        ]
    );
    // The turn is taken without waiting, by the read itself.
    let turns: Vec<&(Option<String>, String, String)> = found
        .calls
        .iter()
        .filter(|(_, receiver, _)| receiver == "turns")
        .collect();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        (turns[0].0.as_deref(), turns[0].2.as_str()),
        (Some("read_recipient_with"), "take_now")
    );
    // Only the two contact collections are named.
    let collections: BTreeSet<String> = found
        .paths()
        .into_iter()
        .filter_map(|(_, p)| {
            p.strip_prefix("crate::source::Collection::")
                .map(str::to_owned)
        })
        .collect();
    assert_eq!(
        collections,
        BTreeSet::from(["PersonEmails".to_owned(), "PersonPhoneNumbers".to_owned()])
    );
    // Serialize only for the closed reply, and nothing derives Clone or Debug on the value's holders.
    let file = syn::parse_file(source).unwrap();
    for item in &file.items {
        let (name, attrs) = match item {
            syn::Item::Struct(s) => (s.ident.to_string(), &s.attrs),
            syn::Item::Enum(e) => (e.ident.to_string(), &e.attrs),
            _ => continue,
        };
        let derives: Vec<String> = attrs
            .iter()
            .filter(|a| a.path().is_ident("derive"))
            .map(|a| {
                let mut list = Vec::new();
                let _ = a.parse_nested_meta(|m| {
                    list.push(
                        m.path
                            .segments
                            .iter()
                            .map(|s| s.ident.to_string())
                            .collect::<Vec<_>>()
                            .join("::"),
                    );
                    Ok(())
                });
                list.join(",")
            })
            .collect();
        let derives = derives.join(",");
        if derives.contains("Serialize") {
            assert!(
                ["NoRecipient", "AppName", "ToLine", "Opened"].contains(&name.as_str()),
                "{name} derives Serialize"
            );
        }
        if ["Recipient", "Address", "Session", "Checked"].contains(&name.as_str()) {
            assert!(
                !derives.contains("Clone")
                    && !derives.contains("Debug")
                    && !derives.contains("Serialize"),
                "{name} derives {derives}"
            );
        }
    }
}

/// Reads the contact records of one fictional person of the test organization with the developer's
/// saved connection (ozzie-dev's own Keychain item, never the app's) and prints only each reply's
/// shape (keys and kinds, never a value) and the closed result Ozzie would give:
/// `OZZIE_DEV_SHAPES=1 OZZIE_PCO_CLIENT_ID=… OZZIE_PCO_ORG=… OZZIE_LIVE_CONTACT_PERSON=… cargo test -- --ignored live_contact_read_shape --nocapture`.
/// Needs the network, a connection made with `ozzie-dev connect --operations`, and may ask for the
/// Keychain. Never prints or stores a token.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn live_contact_read_shape() {
    use crate::{
        credentials::MacKeychain,
        oauth::system_clock,
        provider::{NativeHttp, PcoProvider},
    };
    assert_eq!(
        std::env::var("OZZIE_DEV_SHAPES").as_deref(),
        Ok("1"),
        "prints shapes only, with OZZIE_DEV_SHAPES=1"
    );
    let setting = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name}"));
    let person = setting("OZZIE_LIVE_CONTACT_PERSON");
    let organization = setting("OZZIE_PCO_ORG");
    assert!(numeric_id(&person) && numeric_id(&organization));
    let auth = Arc::new(
        AuthController::new(
            Binding {
                workspace: format!("local:{organization}"),
                organization: organization.clone(),
                client_id: setting("OZZIE_PCO_CLIENT_ID"),
            },
            Arc::new(MacKeychain {
                service: "church.ozzie.planning-center.dev".into(),
            }),
            Arc::new(PcoProvider(NativeHttp::new().unwrap())),
            system_clock().unwrap(),
        )
        .unwrap(),
    );
    let people = CheckedPeople::default();
    people.remember(&capture(&organization, &[person.as_str()]));
    for kind in [ContactKind::Email, ContactKind::Mobile] {
        let a = auth.clone();
        let result = read_recipient_with(
            &people,
            &Turns::default(),
            &person,
            kind,
            move || Some(a),
            Box::new(|| Ok(Arc::new(Shapes) as Arc<dyn SourceHttp + Send + Sync>)),
            Duration::from_secs(30),
        );
        let said = match result {
            Ok(_) => "addressed".to_owned(),
            Err(reason) => serde_json::to_string(&reason).unwrap(),
        };
        println!("live-contact: {kind:?} -> {said}");
    }
}
/// The real GET, built by the source client, with the reply's shape printed before the projection.
#[cfg(target_os = "macos")]
struct Shapes;
#[cfg(target_os = "macos")]
impl SourceHttp for Shapes {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        use std::io::Read as _;
        let built = NativeSourceHttp::new()?.build(request, access)?;
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .user_agent("Ozzie (https://ozzie.church)")
            .build()
            .map_err(|_| SourceError::ProviderFailure)?;
        let response = client
            .execute(built)
            .map_err(|_| SourceError::ProviderFailure)?;
        let label = request.collection.label();
        let status = response.status().as_u16();
        println!("live-contact: {label} status {status}");
        if let Some(error) = status_error(request, status, None) {
            return Err(error);
        }
        let headers = response
            .headers()
            .iter()
            .filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|v| (k.as_str().to_owned(), v.to_owned()))
            })
            .collect();
        let mut bytes = Zeroizing::new(Vec::new());
        response
            .take((crate::source::MAX_OUTPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| SourceError::ProviderFailure)?;
        let outline = serde_json::from_slice::<Value>(&bytes).map(|v| shape("", &v).to_string());
        println!(
            "live-contact: {label} shape {}",
            outline.unwrap_or_else(|_| "<not json>".into())
        );
        let page = project_page(request, &bytes, &headers);
        println!(
            "live-contact: {label} projection {}",
            page.as_ref().map_or_else(|e| e.reason(), |_| "ok")
        );
        page
    }
}
/// Keys and kinds only: every string, number and flag becomes its kind; only resource `type` names
/// (like `Email`) are kept, as letters.
#[cfg(target_os = "macos")]
fn shape(key: &str, v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), shape(k, v))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().take(3).map(|v| shape(key, v)).collect()),
        Value::String(text) if key == "type" => Value::String(
            text.chars()
                .filter(char::is_ascii_alphabetic)
                .take(40)
                .collect(),
        ),
        Value::String(_) => json!("<text>"),
        Value::Number(_) => json!("<number>"),
        Value::Bool(_) => json!("<flag>"),
        Value::Null => Value::Null,
    }
}
