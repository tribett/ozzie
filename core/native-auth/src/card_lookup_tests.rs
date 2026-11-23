//! Looking up the name on a visitor card in Planning Center People, over an injected HTTP boundary.
//! Fictional people and fictional cards only.
use super::*;
use crate::{
    credentials::{CredentialStore, StoreError},
    oauth::{
        AskedToWait, AuthError, Binding, OrganizationDiagnostic, OrganizationFailure, Provider,
        Tokens, UserInfoReason,
    },
    source::{NAME_CHARS, SourcePage, project_page},
};
use serde_json::json;
use std::sync::atomic::AtomicUsize;

const SECRET: &str = "fictional-native-secret-canary";
const SEARCH: &str = "https://api.planningcenteronline.com/people/v2/people";
const PEOPLE_SCOPE: &str = "services-and-operations";
const CHURCH: &str = "1001";
/// A fictional card's name, and the fictional people a test church holds.
const CARD: &str = "Riley Fictional";

fn stored(scopes: &str) -> Vec<u8> {
    format!(
        r#"{{"client_id":"fictional-client","organization":"1001","tokens":{{"access_token":"{SECRET}","refresh_token":"fictional-refresh-canary","token_type":"bearer","expires_in":7200}},"scopes":"{scopes}"}}"#
    )
    .into_bytes()
}
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
        panic!("a card lookup never deletes credentials")
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
        binding(),
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
fn binding() -> Binding {
    Binding {
        workspace: "local:1001".into(),
        organization: CHURCH.into(),
        client_id: "fictional-client".into(),
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

/// A person as Planning Center's People list would send one, with much never asked for alongside.
fn person(id: &str, name: &str) -> Value {
    json!({"type": "Person", "id": id,
           "attributes": {"name": name, "first_name": "Riley", "last_name": "Fictional", "birthdate": "2001-02-03",
                          "medical_notes": "care-canary", "child": false, "gender": "gender-canary", "status": "active",
                          "membership": "membership-canary", "avatar": "https://example.org/avatar-canary.png"},
           "relationships": {"primary_campus": {"data": {"type": "PrimaryCampus", "id": "7"}},
                             "households": {"data": [{"type": "Household", "id": "9"}]}},
           "links": {"self": format!("{SEARCH}/{id}")}})
}
/// The search's page: `rows`, Planning Center's total, and things never asked for alongside (an
/// included email, a next link spelled however Planning Center spells it).
fn page(rows: Vec<Value>, total: usize) -> Value {
    json!({
        "data": rows,
        "included": [{"type": "Email", "id": "801", "attributes": {"address": "riley.fictional@example.org"}}],
        "meta": {"total_count": total, "count": total.min(MAX_PEOPLE), "can_include": ["emails", "households"],
                 "parent": {"type": "Organization", "id": CHURCH},
                 "next": {"offset": 5}},
        "links": {"self": format!("{SEARCH}?where%5Bsearch_name%5D=Riley+Fictional"),
                  "next": format!("{SEARCH}?fields%5BPerson%5D=name&offset=5&per_page=5&where%5Bsearch_name%5D=Riley+Fictional")},
    })
}
fn one() -> Value {
    page(vec![person("50", "Riley Fictional")], 1)
}
fn request(name: &str) -> SourceRequest {
    SourceRequest::capture_at(
        &binding(),
        "",
        "",
        Collection::PeopleNameSearch,
        &Target::name_search(SearchName::new(name).unwrap()),
        NAME_SEARCH_PAGE,
        0,
    )
    .unwrap()
}
/// What a reply says, through the same projection a live read takes.
fn said(reply: Value) -> Result<Found, NotLookedUp> {
    let page = project_page(
        &request(CARD),
        &serde_json::to_vec(&reply).unwrap(),
        &Default::default(),
    )
    .map_err(|_| NotLookedUp::CouldNotCheck)?;
    found(page.body())
}
fn people(found: &Found) -> Vec<(String, String)> {
    match found {
        Found::People { people } => people.iter().map(|p| (p.id.clone(), p.name.clone())).collect(),
        _ => Vec::new(),
    }
}
/// One lookup, as the desktop command makes it.
fn look_as(
    auth: &Arc<AuthController>,
    lookups: &CardLookups,
    turns: &Turns,
    church: &str,
    name: &str,
    answer: &Arc<Answer>,
    limit: Duration,
) -> Result<Found, NotLookedUp> {
    let auth = auth.clone();
    look_up_with(
        lookups,
        turns,
        church,
        name,
        move || Some(auth),
        http(answer),
        limit,
    )
}
fn look(auth: &Arc<AuthController>, name: &str, answer: &Arc<Answer>) -> Result<Found, NotLookedUp> {
    look_as(
        auth,
        &CardLookups::default(),
        &Turns::default(),
        CHURCH,
        name,
        answer,
        LOOKUP_DEADLINE,
    )
}
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

#[test]
fn the_lookup_is_one_exact_get_of_the_name_search_with_the_people_version() {
    let http = NativeSourceHttp::new().unwrap();
    for (name, value) in [
        ("Riley Fictional", "Riley%20Fictional"),
        ("Flo901 Visitor", "Flo901%20Visitor"),
        // Accents, an apostrophe (both kinds), a hyphen and a period, each percent-encoded or kept.
        ("José O'Brien-Smith Jr.", "Jos%C3%A9%20O%27Brien-Smith%20Jr."),
        ("Ana O\u{2019}Neil", "Ana%20O%E2%80%99Neil"),
    ] {
        let request = request(name);
        let url = format!("{SEARCH}?where[search_name]={value}&fields[Person]=name&per_page=5&offset=0");
        assert_eq!(request.url(), url, "{name}");
        let built = http.build(&request, SECRET).unwrap();
        assert_eq!(built.method(), reqwest::Method::GET);
        assert!(built.body().is_none());
        assert_eq!(built.url().as_str(), url);
        assert_eq!(built.headers()["x-pco-api-version"], "2025-11-10");
        assert_eq!(request.collection.product(), Product::People);
        // Nothing but the name search, the one field and one short page: no include, no other filter.
        assert!(!url.contains("include"), "{url}");
        let query = url.split_once('?').unwrap().1;
        let keys: Vec<&str> = query.split('&').map(|p| p.split_once('=').unwrap().0).collect();
        assert_eq!(keys, ["where[search_name]", "fields[Person]", "per_page", "offset"]);
    }
    assert_eq!(NAME_SEARCH_PAGE, 5);
    assert_eq!(MAX_PEOPLE, 5);
}

#[test]
fn only_a_plain_name_is_ever_sent() {
    // Whitespace collapses to single spaces; nothing else is repaired.
    let request = request("  Riley \t  Fictional \n");
    assert!(request.url().contains("where[search_name]=Riley%20Fictional&"));
    for good in [
        "Riley Fictional",
        "Flo901 Visitor",
        "Zoë",
        "Mary-Jane Watson",
        "J. R. Example",
        "O’Neil",
        "李小龍",
        "a b c d e f",
    ] {
        assert!(SearchName::new(good).is_some(), "{good}");
    }
    let long = "a".repeat(NAME_CHARS + 1);
    let longest = "a".repeat(NAME_CHARS);
    assert!(SearchName::new(&longest).is_some());
    for bad in [
        "",
        " ",
        "R",
        "5550101",
        "555 0101",
        "R2",
        long.as_str(),
        "a b c d e f g",
        "riley@example.org",
        "Riley%",
        "Riley_Fictional",
        "Riley & Sam",
        "Riley=1",
        "Riley[0]",
        "Riley, Sam",
        "Riley/Sam",
        "Riley#Sam",
        "Riley?",
        "Riley+Sam",
        "\"Riley\"",
        "Riley\u{0}Fictional",
        "Riley\u{202E}Fictional",
        "Riley\u{200B}Fictional",
        "<b>Riley</b>",
        "Riley;Sam",
    ] {
        assert!(SearchName::new(bad).is_none(), "{bad:?}");
    }
    // Its Debug form withholds the name.
    let debug = format!("{:?}", SearchName::new(CARD).unwrap());
    assert!(!debug.contains("Riley"), "{debug}");
    assert!(!format!("{:?}", Target::name_search(SearchName::new(CARD).unwrap())).contains("Riley"));
}

/// Privacy review L1: a name with a phone number in it (part of one, or one written in words with
/// digits) never goes out. Every word holds a letter, and the whole name at most three digits.
#[test]
fn a_name_never_carries_part_of_a_phone_number() {
    for good in ["Flo901 Visitor", "Ann 3rd", "Riley2 Fictional", "J.R. Example"] {
        assert!(SearchName::new(good).is_some(), "{good}");
    }
    for bad in [
        "Ann 555 0101",
        "Ann 5550101",
        "Ann 555-0101",
        "Ann 555.0101",
        "Room 12",
        "Ann 7",
        "Flo9012 Visitor",
        "Ann12 Bo34",
        "Ann - Example",
        "Ann . Example",
    ] {
        assert!(SearchName::new(bad).is_none(), "{bad:?}");
    }
    assert_eq!(crate::source::NAME_DIGITS, 3);
}

#[test]
fn the_name_search_names_a_card_and_nothing_else_and_never_reaches_the_stdin_protocol() {
    let make = |service_type: &str, plan: &str, target: Target, per_page: u16, offset: u64| {
        SourceRequest::capture_at(
            &binding(),
            service_type,
            plan,
            Collection::PeopleNameSearch,
            &target,
            per_page,
            offset,
        )
        .err()
    };
    let name = || Target::name_search(SearchName::new(CARD).unwrap());
    let invalid = Some(SourceError::InvalidRequest);
    assert_eq!(make("", "", name(), 5, 0), None);
    assert_eq!(make("", "", name(), 1, 0), None);
    // No plan, no other id, no paging, at most five, and always a name.
    assert_eq!(make("10", "20", name(), 5, 0), invalid);
    assert_eq!(make("10", "", name(), 5, 0), invalid);
    assert_eq!(make("", "", name(), 6, 0), invalid);
    assert_eq!(make("", "", name(), 100, 0), invalid);
    assert_eq!(make("", "", name(), 5, 5), invalid);
    assert_eq!(make("", "", Target::default(), 5, 0), invalid);
    let mut two = name();
    two.people_person_id = Some("50".into());
    assert_eq!(make("", "", two, 5, 0), invalid);
    // No other read takes a name.
    let other = SourceRequest::capture_at(
        &binding(),
        "",
        "",
        Collection::PeopleBackgroundChecks,
        &Target {
            name_search: SearchName::new(CARD),
            ..Target::people_person("50")
        },
        100,
        0,
    );
    assert_eq!(other.err(), invalid);
    // The stdin protocol can't name it, and a request written as JSON never carries a name.
    let text = r#"{"version":1,"workspace":"local:1001","organization":"1001","client_id":"fictional-client","service_type_id":"","plan_id":"","collection":"people_name_search","per_page":5,"offset":0}"#;
    assert_eq!(
        crate::source::parse_request(text.as_bytes()).err(),
        invalid
    );
    let with = text.replace(r#""offset":0}"#, r#""offset":0,"name_search":"Riley"}"#);
    assert_ne!(with, text);
    assert!(crate::source::parse_request(with.as_bytes()).is_err());
    let written = serde_json::to_string(&request(CARD)).unwrap();
    assert!(!written.contains("Riley"), "{written}");
}

#[test]
fn the_projection_keeps_only_each_persons_id_and_name() {
    let reply = page(vec![person("50", "Riley Fictional"), person("51", "Riley Fictionalson")], 2);
    let projected = project_page(
        &request(CARD),
        &serde_json::to_vec(&reply).unwrap(),
        &Default::default(),
    )
    .unwrap();
    let body = projected.body().clone();
    assert_eq!(
        body["data"],
        json!([
            {"id": "50", "type": "Person", "attributes": {"name": "Riley Fictional"}},
            {"id": "51", "type": "Person", "attributes": {"name": "Riley Fictionalson"}},
        ])
    );
    // No included row, no next link (never followed), only the counts.
    assert!(body.get("included").is_none());
    assert_eq!(body["meta"], json!({"count": 2, "total_count": 2}));
    assert_eq!(body["links"], json!({}));
    let wire = projected.envelope().to_string();
    for canary in [
        "care-canary",
        "2001-02-03",
        "gender-canary",
        "membership-canary",
        "avatar-canary",
        "example.org",
        "Household",
        "PrimaryCampus",
        "first_name",
        "child",
    ] {
        assert!(!wire.contains(canary), "{canary}");
    }
    // What the page is told: ids and names, nothing more.
    let told = serde_json::to_value(found(projected.body()).unwrap()).unwrap();
    assert_eq!(
        told,
        json!({"result": "people", "people": [{"id": "50", "name": "Riley Fictional"}, {"id": "51", "name": "Riley Fictionalson"}]})
    );
    // When Planning Center names the list's parent, another church's is refused. A second check only: the
    // guarantee is the identity check before every search (review L6), which `verify_source` makes.
    let mut elsewhere = one();
    elsewhere["meta"]["parent"]["id"] = json!("2002");
    assert_eq!(said(elsewhere), Err(NotLookedUp::CouldNotCheck));
}

#[test]
fn one_several_none_or_more_and_never_a_guess() {
    assert_eq!(
        people(&said(one()).unwrap()),
        [("50".to_owned(), "Riley Fictional".to_owned())]
    );
    let five: Vec<Value> = (0..5)
        .map(|n| person(&(50 + n).to_string(), &format!("Riley Fictional {n}")))
        .collect();
    assert_eq!(people(&said(page(five.clone(), 5)).unwrap()).len(), 5);
    assert_eq!(said(page(Vec::new(), 0)), Ok(Found::NoOne));
    let mut no_meta = page(Vec::new(), 0);
    no_meta.as_object_mut().unwrap().remove("meta");
    assert_eq!(said(no_meta), Ok(Found::NoOne));
    // More than five: no one's name is kept.
    let more = said(page(five.clone(), 12)).unwrap();
    assert_eq!(more, Found::More);
    assert_eq!(serde_json::to_value(&more).unwrap(), json!({"result": "more"}));
    assert_eq!(
        serde_json::to_value(Found::NoOne).unwrap(),
        json!({"result": "no-one"})
    );
    // A page that contradicts itself is refused.
    let named = |name: Value| {
        let mut row = person("50", "x");
        row["attributes"]["name"] = name;
        page(vec![row], 1)
    };
    let mut wrong_type = one();
    wrong_type["data"][0]["type"] = json!("Household");
    let mut odd_id = one();
    odd_id["data"][0]["id"] = json!("50a");
    let six: Vec<Value> = (0..6).map(|n| person(&(50 + n).to_string(), "Riley")).collect();
    let mut full_without_total = page(five.clone(), 5);
    full_without_total["meta"].as_object_mut().unwrap().remove("total_count");
    for (label, reply) in [
        ("no name", named(Value::Null)),
        ("empty name", named(json!(""))),
        ("blank name", named(json!("  \n "))),
        ("number name", named(json!(7))),
        ("the same person twice", page(vec![person("50", "Riley"), person("50", "Riley")], 2)),
        ("another type", wrong_type),
        ("an odd id", odd_id),
        ("six rows", page(six, 6)),
        ("a total below the rows", page(vec![person("50", "Riley"), person("51", "Riley")], 1)),
        ("a short page that says more", page(vec![person("50", "Riley")], 3)),
        ("a full page with no total", full_without_total),
        ("no data", json!({"meta": {"total_count": 0}})),
        ("errors", json!({"errors": [{"title": "Forbidden"}]})),
    ] {
        assert_eq!(said(reply), Err(NotLookedUp::CouldNotCheck), "{label}");
    }
    // A name is shown in display form: no control or direction character, one line, bounded.
    let shown = people(&said(named(json!("Riley\u{202E}\n  Fictional\u{0}"))).unwrap());
    assert_eq!(shown[0].1, "Riley Fictional");
    let long = people(&said(named(json!("R".repeat(400)))).unwrap());
    assert!(long[0].1.chars().count() <= 120 && long[0].1.ends_with('…'));
}

#[test]
fn a_lookup_reads_the_one_search_and_says_what_it_found() {
    let auth = controller(PEOPLE_SCOPE);
    let answer = Answer::new(Ok(one()));
    assert_eq!(
        people(&look(&auth, "  Riley   Fictional ", &answer).unwrap()),
        [("50".to_owned(), "Riley Fictional".to_owned())]
    );
    assert_eq!(
        answer.seen(),
        [format!(
            "{SEARCH}?where[search_name]=Riley%20Fictional&fields[Person]=name&per_page=5&offset=0"
        )]
    );
}

#[test]
fn nothing_is_read_for_a_name_that_isnt_plain_or_a_church_that_isnt_the_cards() {
    let connection = connection(PEOPLE_SCOPE, 0);
    let turns = Turns::default();
    // Another reader holds the turn: a bad name is refused before the turn is even asked for.
    let held = turns.take_now(Reader::Check).unwrap();
    for (church, name) in [
        (CHURCH, "riley@example.org"),
        (CHURCH, "R"),
        (CHURCH, ""),
        ("", CARD),
        ("10x", CARD),
    ] {
        let answer = Answer::new(Ok(one()));
        let connected = AtomicBool::new(false);
        let result = look_up_with(
            &CardLookups::default(),
            &turns,
            church,
            name,
            || {
                connected.store(true, Ordering::SeqCst);
                Some(connection.auth.clone())
            },
            http(&answer),
            LOOKUP_DEADLINE,
        );
        assert_eq!(result, Err(NotLookedUp::InvalidName), "{name:?} {church:?}");
        assert!(!connected.load(Ordering::SeqCst));
        assert!(answer.seen().is_empty());
    }
    drop(held);
    // The church Ozzie is connected to isn't the cards' church: nothing is read, not even an identity.
    let answer = Answer::new(Ok(one()));
    assert_eq!(
        look_as(
            &connection.auth,
            &CardLookups::default(),
            &turns,
            "2002",
            CARD,
            &answer,
            LOOKUP_DEADLINE
        ),
        Err(NotLookedUp::ChurchChanged)
    );
    assert!(answer.seen().is_empty());
    assert_eq!(connection.identity.0.load(Ordering::SeqCst), 0);
    // Not connected.
    let answer = Answer::new(Ok(one()));
    assert_eq!(
        look_up_with(
            &CardLookups::default(),
            &turns,
            CHURCH,
            CARD,
            || None,
            http(&answer),
            LOOKUP_DEADLINE
        ),
        Err(NotLookedUp::NotConnected)
    );
    assert!(answer.seen().is_empty());
    assert!(settled(&turns));
}

#[test]
fn a_sign_in_without_people_is_not_allowed_and_nothing_is_searched_or_started() {
    for scopes in ["services", "services+check-ins+registrations"] {
        let auth = controller(scopes);
        let answer = Answer::new(Ok(one()));
        assert_eq!(look(&auth, CARD, &answer), Err(NotLookedUp::NotAllowed));
        assert!(answer.seen().is_empty(), "{scopes}");
        // `Identity` panics on any sign-in or renewal: none was started.
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
    let answer = Answer::new(Ok(one()));
    assert_eq!(look(&known.auth, CARD, &answer), Err(NotLookedUp::NotAllowed));
    assert!(answer.seen().is_empty());
    assert_eq!(known.store.1.load(Ordering::SeqCst), keychain);
    assert_eq!(known.identity.0.load(Ordering::SeqCst), identity);
}

#[test]
fn planning_center_errors_and_timeouts_say_it_couldnt_check() {
    let auth = controller(PEOPLE_SCOPE);
    for (error, expected) in [
        (SourceError::Denied, NotLookedUp::NotAllowed),
        // Planning Center asking Ozzie to wait is `busy`, with the wait (review L2: `planning_center_s_retry_after_…`).
        (SourceError::RateLimited(Some(20)), NotLookedUp::Busy),
        (SourceError::RateLimited(None), NotLookedUp::Busy),
        (SourceError::ProviderFailure, NotLookedUp::CouldNotCheck),
        (SourceError::Timeout, NotLookedUp::CouldNotCheck),
        (SourceError::InvalidResponse, NotLookedUp::CouldNotCheck),
        (SourceError::Oversized, NotLookedUp::CouldNotCheck),
        (SourceError::Rejected, NotLookedUp::CouldNotCheck),
    ] {
        let answer = Answer::new(Err(error));
        assert_eq!(look(&auth, CARD, &answer), Err(expected), "{error:?}");
        assert_eq!(answer.seen().len(), 1);
    }
}

#[test]
fn past_the_deadline_it_couldnt_check_and_the_turn_comes_back() {
    // The identity check stalls: the GET never goes out.
    let slow = connection(PEOPLE_SCOPE, 600);
    let turns = Turns::default();
    let answer = Answer::new(Ok(one()));
    let started = Instant::now();
    assert_eq!(
        look_as(
            &slow.auth,
            &CardLookups::default(),
            &turns,
            CHURCH,
            CARD,
            &answer,
            Duration::from_millis(150)
        ),
        Err(NotLookedUp::CouldNotCheck)
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(settled(&turns));
    assert!(answer.seen().is_empty(), "cancelled before the GET");
    // The GET itself stalls: given up at the deadline; a late answer is dropped.
    let auth = controller(PEOPLE_SCOPE);
    let answer = Answer::slow(Ok(one()), 600);
    assert_eq!(
        look_as(
            &auth,
            &CardLookups::default(),
            &turns,
            CHURCH,
            CARD,
            &answer,
            Duration::from_millis(150)
        ),
        Err(NotLookedUp::CouldNotCheck)
    );
    assert!(settled(&turns));
}

#[test]
fn cancel_stops_a_lookup_under_way_and_its_answer_is_dropped() {
    let auth = controller(PEOPLE_SCOPE);
    let lookups = CardLookups::default();
    let turns = Turns::default();
    let answer = Answer::slow(Ok(one()), 300);
    let result = std::thread::scope(|scope| {
        let looking = scope.spawn(|| {
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE)
        });
        // Once the GET is out, the cards are discarded.
        let until = Instant::now() + Duration::from_secs(2);
        while answer.seen().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        lookups.cancel();
        looking.join().unwrap()
    });
    assert_eq!(result, Err(NotLookedUp::Cancelled));
    assert!(settled(&turns));
    // A lookup waiting for the turn when the cards are discarded never reads at all.
    let held = turns.take_now(Reader::Check).unwrap();
    let answer = Answer::new(Ok(one()));
    let result = std::thread::scope(|scope| {
        let looking = scope.spawn(|| {
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE)
        });
        std::thread::sleep(Duration::from_millis(100));
        lookups.cancel();
        std::thread::sleep(Duration::from_millis(50));
        drop(held);
        looking.join().unwrap()
    });
    assert_eq!(result, Err(NotLookedUp::Cancelled));
    assert!(answer.seen().is_empty());
    // After a cancel, the next lookup (a new set of cards) goes ahead.
    let answer = Answer::new(Ok(one()));
    assert!(look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE).is_ok());
}

#[test]
fn never_beside_a_check_and_a_note_or_change_hears_planning_center_is_being_read() {
    let auth = controller(PEOPLE_SCOPE);
    // A check (or a change, or a note) holds the turn: after `TURN_WAIT`, busy, and nothing read.
    for holder in [Reader::Check, Reader::Change, Reader::Note] {
        let turns = Turns::default();
        let held = turns.take_now(holder).unwrap();
        let answer = Answer::new(Ok(one()));
        let started = Instant::now();
        assert_eq!(
            look_as(&auth, &CardLookups::default(), &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE),
            Err(NotLookedUp::Busy),
            "{holder:?}"
        );
        assert!(started.elapsed() >= TURN_WAIT);
        assert!(answer.seen().is_empty());
        drop(held);
    }
    // While a lookup reads, it holds the turn as the picker's brief read does: a note or a change
    // is told someone is reading, never that another note or change is under way.
    let turns = Turns::default();
    let answer = Answer::slow(Ok(one()), 300);
    std::thread::scope(|scope| {
        let looking = scope.spawn(|| {
            look_as(&auth, &CardLookups::default(), &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE)
        });
        let until = Instant::now() + Duration::from_secs(2);
        while answer.seen().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(turns.take_now(Reader::Note).err(), Some(Reader::Picker));
        assert_eq!(turns.take_now(Reader::Change).err(), Some(Reader::Picker));
        // A check waits for it.
        assert!(turns.take(Reader::Check, Duration::from_secs(2)).is_ok());
        assert!(looking.join().unwrap().is_ok());
    });
    assert_eq!(TURN_WAIT, Duration::from_secs(2));
}

/// Privacy review L2: Planning Center's Retry-After is honoured. Its 429 makes the lookup `busy` with
/// the wait it asked for (20 s when it names none, at most `LONGEST_WAIT`), and every lookup until
/// then is refused the same way before the turn is taken or anything is read.
#[test]
fn planning_center_s_retry_after_holds_every_lookup_until_it_has_passed() {
    let auth = controller(PEOPLE_SCOPE);
    for (asked, waits) in [(Some(30), 30), (None, 20), (Some(9_000), 300)] {
        let lookups = CardLookups::default();
        let turns = Turns::default();
        let answer = Answer::new(Err(SourceError::RateLimited(asked)));
        assert_eq!(
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE),
            Err(NotLookedUp::Busy)
        );
        let told = lookups.refused(NotLookedUp::Busy);
        assert_eq!(told.reason(), NotLookedUp::Busy);
        let wait = told.wait_seconds().unwrap();
        assert!(wait <= waits && wait + 2 >= waits, "{asked:?}: {wait}");
        // Until then nothing goes out, not even for the turn. The lookup's thread answers before it lets go of the turn,
        // so wait for that first (flaky without it; third privacy pass of 0.9.1).
        assert!(settled(&turns), "the turn was never let go");
        let held = turns.take_now(Reader::Check).unwrap();
        let next = Answer::new(Ok(one()));
        let started = Instant::now();
        assert_eq!(
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &next, LOOKUP_DEADLINE),
            Err(NotLookedUp::Busy)
        );
        assert!(started.elapsed() < TURN_WAIT);
        assert!(next.seen().is_empty());
        drop(held);
        // Once it has passed, lookups go ahead again.
        lookups.waited_until(Instant::now());
        assert!(look_as(&auth, &lookups, &turns, CHURCH, CARD, &next, LOOKUP_DEADLINE).is_ok());
        assert_eq!(lookups.refused(NotLookedUp::Busy).wait_seconds(), None);
    }
    assert_eq!(LONGEST_WAIT, Duration::from_secs(300));
    // The page is told the reason and the wait, and nothing else.
    let lookups = CardLookups::default();
    assert_eq!(
        serde_json::to_value(lookups.refused(NotLookedUp::CouldNotCheck)).unwrap(),
        json!({"reason": "could-not-check"})
    );
    lookups.wait_for(Some(30), Instant::now());
    assert_eq!(
        serde_json::to_value(lookups.refused(NotLookedUp::Busy)).unwrap(),
        json!({"reason": "busy", "wait_seconds": 30})
    );
}

/// Planning Center's identity check answering 429 with `0` as its Retry-After, counted.
struct AsksToWait(Option<u16>, AtomicUsize);
impl Provider for AsksToWait {
    fn organization(&self, access: &str) -> Result<String, AuthError> {
        self.organization_detailed(access).map_err(|failure| failure.error)
    }
    fn organization_detailed(&self, access: &str) -> Result<String, OrganizationFailure> {
        assert_eq!(access, SECRET);
        self.1.fetch_add(1, Ordering::SeqCst);
        Err(OrganizationFailure {
            error: AuthError::ProviderFailure,
            diagnostic: OrganizationDiagnostic::userinfo(UserInfoReason::ProviderFailure),
            asked_to_wait: Some(AskedToWait(self.0)),
        })
    }
    fn exchange(&self, _: &str, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("no sign-in is ever started from here")
    }
    fn refresh(&self, _: &str, _: &str) -> Result<Tokens, AuthError> {
        panic!("not due")
    }
    fn revoke(&self, _: &str, _: &str, _: &str) -> Result<(), AuthError> {
        panic!("no revoke")
    }
}
fn asks_to_wait(retry_after: Option<u16>) -> (Arc<AuthController>, Arc<AsksToWait>) {
    let identity = Arc::new(AsksToWait(retry_after, AtomicUsize::new(0)));
    let store = Arc::new(Store(Mutex::new(stored(PEOPLE_SCOPE)), AtomicUsize::new(0)));
    let auth = AuthController::new(binding(), store, identity.clone(), Arc::new(|| 0)).unwrap();
    (Arc::new(auth), identity)
}

/// Privacy review L-c: Planning Center's 429 on the identity check before the search is honoured the
/// way the search's own is: the lookup is `busy` with the wait it asked for (20 s when it names none,
/// at most `LONGEST_WAIT`), and until then no lookup asks again, not even the identity check. Never
/// `could-not-check`, which moved the page on to the next name and up to 30 identity checks a minute.
#[test]
fn planning_center_s_wait_on_the_identity_check_holds_lookups_as_the_search_s_does() {
    for (asked, waits) in [(Some(30), 30), (None, 20), (Some(9_000), 300)] {
        let (auth, identity) = asks_to_wait(asked);
        let lookups = CardLookups::default();
        let turns = Turns::default();
        let answer = Answer::new(Ok(one()));
        assert_eq!(
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE),
            Err(NotLookedUp::Busy)
        );
        assert!(answer.seen().is_empty(), "the search never went out");
        let wait = lookups.refused(NotLookedUp::Busy).wait_seconds().unwrap();
        assert!(wait <= waits && wait + 2 >= waits, "{asked:?}: {wait}");
        assert!(settled(&turns));
        for _ in 0..5 {
            assert_eq!(
                look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE),
                Err(NotLookedUp::Busy)
            );
        }
        assert_eq!(identity.1.load(Ordering::SeqCst), 1);
        assert!(answer.seen().is_empty());
    }
    // Only a card's lookup waits on it: every other reader's identity check fails as it always has.
    let (auth, _) = asks_to_wait(Some(30));
    assert_eq!(
        auth.verify_source(&AtomicBool::new(false)).err(),
        Some(SourceError::ProviderFailure)
    );
    assert_eq!(
        auth.verify_source_or_wait(&AtomicBool::new(false)).err(),
        Some(SourceError::RateLimited(Some(30)))
    );
}

/// Privacy review L3: a change a person confirmed waits for a card lookup that holds the
/// connection's turn (never for a check), so it isn't refused as if a check were running.
#[test]
fn a_change_waits_for_a_lookup_never_for_a_check() {
    let auth = controller(PEOPLE_SCOPE);
    let lookups = CardLookups::default();
    let turns = Turns::default();
    let answer = Answer::slow(Ok(one()), 300);
    std::thread::scope(|scope| {
        let looking = scope.spawn(|| {
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE)
        });
        let until = Instant::now() + Duration::from_secs(2);
        while answer.seen().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(lookups.holding());
        let started = Instant::now();
        let pending = lookups.let_finish(CHANGE_WAITS);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!lookups.holding());
        // The turn is free for the change at once.
        assert!(turns.take_now(Reader::Change).is_ok());
        assert!(looking.join().unwrap().is_ok());
        drop(pending);
    });
    // A check holding the turn is never waited for.
    let held = turns.take_now(Reader::Check).unwrap();
    let started = Instant::now();
    let _pending = lookups.let_finish(CHANGE_WAITS);
    assert!(started.elapsed() < Duration::from_millis(200));
    drop(held);
    // While a change goes ahead, a new lookup is told to wait a moment.
    assert!(lookups.refused(NotLookedUp::Busy).wait_seconds().is_some());
    assert_eq!(CHANGE_WAITS, Duration::from_secs(20));
}

/// One read that waits until the test lets it go (never a timer), telling the test once it is under way.
struct Held {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl SourceHttp for Held {
    fn read(&self, request: &SourceRequest, access: &str) -> Result<SourcePage, SourceError> {
        assert_eq!(access, SECRET);
        if let Some(entered) = self.entered.lock().unwrap().take() {
            entered.send(()).unwrap();
        }
        self.release.lock().unwrap().recv().unwrap();
        project_page(request, &serde_json::to_vec(&one()).unwrap(), &Default::default())
    }
}
/// Waits, at most a few seconds, until `done` says so.
fn until(done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "never happened");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Privacy review L-b: a lookup already waiting for the connection's turn when a change a person
/// confirmed starts waiting takes the turn as the lookup before it lets go, while `holding` reads none.
/// It gives the turn straight back and is `busy`, so the change finds it free, however long its sign-in
/// renewal takes; until the change lets go of its `ChangePending`, no lookup keeps the turn.
#[test]
fn a_lookup_that_takes_the_turn_while_a_change_waits_gives_it_straight_back() {
    let auth = controller(PEOPLE_SCOPE);
    let lookups = CardLookups::default();
    let turns = Turns::default();
    let (entered, under_way) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let first = Arc::new(Held {
        entered: Mutex::new(Some(entered)),
        release: Mutex::new(released),
    });
    let second = Answer::new(Ok(one()));
    std::thread::scope(|scope| {
        // A lookup holds the turn, its read under way.
        let reading = scope.spawn(|| {
            let first = first.clone();
            look_up_with(
                &lookups,
                &turns,
                CHURCH,
                CARD,
                || Some(auth.clone()),
                Box::new(move || Ok(first as Arc<dyn SourceHttp + Send + Sync>)),
                LOOKUP_DEADLINE,
            )
        });
        under_way.recv().unwrap();
        assert!(lookups.holding());
        // The next lookup went out before any change: it waits for the turn.
        let waiting = scope.spawn(|| {
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &second, LOOKUP_DEADLINE)
        });
        until(|| lookups.0.lock().unwrap().under_way.len() == 2);
        // A change a person confirmed starts waiting for the first lookup.
        let change = scope.spawn(|| lookups.let_finish(CHANGE_WAITS));
        until(|| lookups.0.lock().unwrap().pending == 1);
        // The first lookup ends: the waiting one takes the turn, and gives it straight back.
        release.send(()).unwrap();
        assert!(reading.join().unwrap().is_ok());
        assert_eq!(waiting.join().unwrap(), Err(NotLookedUp::Busy));
        assert!(second.seen().is_empty(), "nothing read");
        let pending = change.join().unwrap();
        assert!(!lookups.holding());
        // However long the change's sign-in renewal takes (past the moment new lookups are held back),
        // a new lookup is busy at once, never waiting for the turn, and the change finds the turn free.
        lookups.waited_until(Instant::now());
        let third = Answer::new(Ok(one()));
        let started = Instant::now();
        assert_eq!(
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &third, LOOKUP_DEADLINE),
            Err(NotLookedUp::Busy)
        );
        assert!(started.elapsed() < TURN_WAIT);
        assert!(third.seen().is_empty());
        let turn = turns.take_now(Reader::Change);
        assert!(turn.is_ok());
        // Done (made, refused, or ended any other way): lookups go ahead again.
        drop(turn);
        drop(pending);
        assert_eq!(lookups.0.lock().unwrap().pending, 0);
        assert!(look_as(&auth, &lookups, &turns, CHURCH, CARD, &third, LOOKUP_DEADLINE).is_ok());
    });
    // Two changes waiting at once: lookups wait for both to be done.
    let one_change = lookups.let_finish(CHANGE_WAITS);
    let other = lookups.let_finish(CHANGE_WAITS);
    lookups.waited_until(Instant::now());
    drop(one_change);
    let answer = Answer::new(Ok(one()));
    assert_eq!(
        look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE),
        Err(NotLookedUp::Busy)
    );
    drop(other);
    assert!(look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE).is_ok());
    // A change that panics still lets go.
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _pending = lookups.let_finish(CHANGE_WAITS);
        panic!("a change ended badly");
    }));
    assert!(crashed.is_err());
    assert_eq!(lookups.0.lock().unwrap().pending, 0);
}

#[test]
fn a_few_dozen_a_minute_at_most() {
    let auth = controller(PEOPLE_SCOPE);
    let lookups = CardLookups::default();
    let turns = Turns::default();
    for n in 0..LOOKUPS_PER_MINUTE {
        let answer = Answer::new(Ok(one()));
        assert!(
            look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE).is_ok(),
            "{n}"
        );
    }
    let answer = Answer::new(Ok(one()));
    assert_eq!(
        look_as(&auth, &lookups, &turns, CHURCH, CARD, &answer, LOOKUP_DEADLINE),
        Err(NotLookedUp::TooManyJustNow)
    );
    assert!(answer.seen().is_empty());
    // The page is told how long until there is room again (review L2).
    let wait = lookups.refused(NotLookedUp::TooManyJustNow).wait_seconds().unwrap();
    assert!((1..=60).contains(&wait), "{wait}");
    // A minute later there is room again.
    assert!(lookups.pace(Instant::now() + MINUTE));
    assert_eq!(LOOKUPS_PER_MINUTE, 30);
}

#[test]
fn every_reply_is_closed_and_no_error_or_debug_form_holds_a_name() {
    let codes: Vec<Value> = [
        NotLookedUp::InvalidName,
        NotLookedUp::NotConnected,
        NotLookedUp::ChurchChanged,
        NotLookedUp::NotAllowed,
        NotLookedUp::Busy,
        NotLookedUp::TooManyJustNow,
        NotLookedUp::CouldNotCheck,
        NotLookedUp::Cancelled,
    ]
    .iter()
    .map(|code| serde_json::to_value(code).unwrap())
    .collect();
    assert_eq!(
        codes,
        [
            "invalid-name",
            "not-connected",
            "church-changed",
            "not-allowed",
            "busy",
            "too-many-just-now",
            "could-not-check",
            "cancelled"
        ]
    );
    let found = said(page(vec![person("50", "Riley Fictional")], 1)).unwrap();
    let debug = format!("{found:?}");
    assert!(!debug.contains("Riley"), "{debug}");
    assert!(debug.contains("50"));
}

/// Structure: this module reads only through the turn and the verified, GET-only source path, and
/// has no other way out: no network client of its own, no file, process, environment, output or
/// log, no task ledger, recording, model or notice.
#[test]
fn this_module_reaches_only_the_guarded_planning_center_get() {
    let own = include_str!("card_lookup.rs");
    let own = &own[..own.find("#[cfg(test)]\n#[path").unwrap()];
    let code: String = own
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for token in [
        "reqwest",
        "std::fs",
        "std::process",
        "std::env",
        "std::io",
        "File",
        "println!",
        "eprintln!",
        "print!",
        "dbg!",
        "log::",
        "tracing",
        "ledger",
        "recording",
        "model",
        "hosted",
        "agent",
        "notify",
        "phone_notice",
        "shared_check",
        "shortcuts",
        "save_",
        "write",
        "change",
        "post",
        "unsafe",
    ] {
        assert!(!code.contains(token), "card_lookup.rs names {token}");
    }
    // Its only reads: the identity check (waiting as Planning Center asks, review L-c) and the one
    // name search, after the turn.
    assert_eq!(code.matches("verify_source_or_wait(").count(), 1);
    assert!(!code.contains("verify_source("));
    assert_eq!(code.matches("read_verified_using(").count(), 1);
    assert_eq!(code.matches("Collection::").count(), 1);
    assert!(code.contains("Collection::PeopleNameSearch"));
    assert!(code.contains("take(Reader::Picker, TURN_WAIT)"));
    // Only the desktop command and lib.rs name it, in this crate.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in std::fs::read_dir(&root).unwrap().flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if !name.ends_with(".rs") || ["card_lookup.rs", "card_lookup_tests.rs", "lib.rs"].contains(&name.as_str()) {
            continue;
        }
        // Code only: a note may say where the lookup is.
        let text: String = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        // The read list itself, and its GET-only test's list of every read.
        if ["source.rs", "source_operations_tests.rs"].contains(&name.as_str()) {
            continue;
        }
        assert!(!text.contains("card_lookup"), "{name} names card_lookup");
        assert!(!text.contains("PeopleNameSearch"), "{name} names the name search");
        assert!(!text.contains("people_name_search"), "{name}");
        assert!(!text.contains("SearchName"), "{name}");
    }
}
