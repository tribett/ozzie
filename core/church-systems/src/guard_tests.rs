//! The read-only rule, checked on real requests: every read of every system, as the production builders make them, and
//! `allowed` (which `NativeHttp` runs on each request just before sending it) refusing anything else. This file builds wrong requests on purpose, so the source scan in http_tests.rs leaves it out by name.
use super::*;
use crate::capture::Date;
use crate::test_support::{breeze_key, genesis_key, id, key};
use crate::{b1, breeze, genesis};

/// Every read of every system, built by the production builder, with the host and path it must have.
fn every_request(http: &NativeHttp) -> Vec<(reqwest::blocking::Request, &'static str, String)> {
    let day = Date::parse("2026-11-22").unwrap();
    let mut out = Vec::new();
    let b1_reads = [
        b1::Read::Church(id("CHUfict01")),
        b1::Read::PlansByIds(vec![id("PLAfict01")]),
        b1::Read::Plan(id("PLAfict01")),
        b1::Read::Overview {
            start: day,
            end: day,
        },
        b1::Read::Positions(id("PLAfict01")),
        b1::Read::Assignments(id("PLAfict01")),
        b1::Read::Times(id("PLAfict01")),
        b1::Read::PlanTimes(vec![id("PLAother")]),
        b1::Read::Blockouts,
        b1::Read::TeamMembers(vec![id("GRPworship")]),
        b1::Read::Names(vec![id("PERavery")]),
        b1::Read::Groups,
        b1::Read::Events,
        b1::Read::Forms,
        b1::Read::Lookup(id("cedarhollow")),
    ];
    for read in &b1_reads {
        let get = Get::new(read, Auth::Bearer(key()));
        out.push((
            http.build(&get).unwrap(),
            b1::HOST,
            get.url().path().to_owned(),
        ));
    }
    let host = breeze::church_host(&id("cedarhollow")).unwrap();
    let breeze_reads = [
        breeze::Read::Account,
        breeze::Read::Events {
            start: day,
            end: day,
        },
        breeze::Read::Event(id("4401")),
        breeze::Read::Volunteers(id("4401")),
        breeze::Read::Roles(id("4401")),
        breeze::Read::People,
        breeze::Read::Tags,
        breeze::Read::Forms,
    ];
    for read in &breeze_reads {
        let get = Get::new(
            &breeze::At { host: &host, read },
            Auth::ApiKey(breeze_key()),
        );
        out.push((
            http.build(&get).unwrap(),
            "cedarhollow.breezechms.com",
            get.url().path().to_owned(),
        ));
    }
    let genesis_reads = [
        genesis::Read::Me,
        genesis::Read::Groups,
        genesis::Read::Events { from: day, to: day },
        genesis::Read::Forms,
        genesis::Read::Submissions(id("FRMfall")),
    ];
    for read in &genesis_reads {
        let get = Get::new(read, Auth::Bearer(genesis_key()));
        out.push((
            http.build(&get).unwrap(),
            genesis::HOST,
            get.url().path().to_owned(),
        ));
    }
    out
}

#[test]
fn every_read_of_every_system_is_a_bodiless_get_with_only_its_headers() {
    let http = NativeHttp::new().unwrap();
    let requests = every_request(&http);
    assert_eq!(requests.len(), 15 + 8 + 5);
    for (built, host, path) in &requests {
        assert_eq!(built.method().as_str(), "GET", "{path}");
        assert!(built.body().is_none(), "{path}");
        assert_eq!(built.url().scheme(), "https");
        assert_eq!(built.url().host_str(), Some(*host));
        assert_eq!(built.url().port(), None);
        assert_eq!(built.url().path(), path);
        for name in built.headers().keys() {
            assert!(
                ["accept", "authorization", "api-key"].contains(&name.as_str()),
                "{path}: {name}"
            );
        }
        assert_eq!(allowed(built), Ok(()), "{path}");
    }
}

/// No POST is let through at all: not to any system's host, not to an address one of its reads uses, with or without
/// a form body or an auth header.
#[test]
fn no_post_is_allowed_to_any_system() {
    let client = reqwest::blocking::Client::new();
    let b1_base = format!("https://{}", b1::HOST);
    let genesis_base = format!("https://{}/functions/v1/public-api/v1", genesis::HOST);
    let breeze_host = "https://cedarhollow.breezechms.com";
    for (address, auth) in [
        (
            format!("{b1_base}/membership/groups"),
            ("authorization", "Bearer x"),
        ),
        (
            format!("{b1_base}/doing/plans"),
            ("authorization", "Bearer x"),
        ),
        (
            format!("{breeze_host}/api/tags/list_tags"),
            ("api-key", "x"),
        ),
        (format!("{breeze_host}/api/people"), ("api-key", "x")),
        (format!("{genesis_base}/me"), ("authorization", "Bearer x")),
        (
            format!("{genesis_base}/groups"),
            ("authorization", "Bearer x"),
        ),
    ] {
        let with_form = client
            .post(address.as_str())
            .header("accept", "application/json")
            .header("content-type", "application/x-www-form-urlencoded")
            .body("x")
            .build()
            .unwrap();
        assert_eq!(allowed(&with_form), Err(ReadError::Refused), "{address}");
        let with_auth = client
            .post(address.as_str())
            .header("accept", "application/json")
            .header(auth.0, auth.1)
            .build()
            .unwrap();
        assert_eq!(allowed(&with_auth), Err(ReadError::Refused), "{address}");
        let bare = client.post(address.as_str()).build().unwrap();
        assert_eq!(allowed(&bare), Err(ReadError::Refused), "{address}");
    }
}

/// The review's mutation: a read's request turned into a POST after it was built (an alias of the method type and a
/// method change), and its relatives. `allowed` refuses each, whatever produced it.
#[test]
fn a_changed_request_is_refused_when_sent() {
    use reqwest::Method as Verb;
    let http = NativeHttp::new().unwrap();
    let get = Get::new(&b1::Read::Groups, Auth::Bearer(key()));
    let original = http.build(&get).unwrap();
    assert_eq!(allowed(&original), Ok(()));

    for verb in [
        Verb::POST,
        Verb::PUT,
        Verb::PATCH,
        Verb::DELETE,
        Verb::HEAD,
        Verb::OPTIONS,
    ] {
        let mut changed = http.build(&get).unwrap();
        *changed.method_mut() = verb.clone();
        assert_eq!(allowed(&changed), Err(ReadError::Refused), "{verb}");
    }
    // A body on a GET.
    let mut with_body = http.build(&get).unwrap();
    *with_body.body_mut() = Some(b"x".to_vec().into());
    assert_eq!(allowed(&with_body), Err(ReadError::Refused));
    // Another header, two auth headers, none.
    let mut extra = http.build(&get).unwrap();
    extra
        .headers_mut()
        .insert("x-http-method-override", "DELETE".parse().unwrap());
    assert_eq!(allowed(&extra), Err(ReadError::Refused));
    let mut both = http.build(&get).unwrap();
    both.headers_mut().insert("api-key", "x".parse().unwrap());
    assert_eq!(allowed(&both), Err(ReadError::Refused));
    let mut none = http.build(&get).unwrap();
    none.headers_mut().remove("authorization");
    assert_eq!(allowed(&none), Err(ReadError::Refused));
    // Another host, scheme or port; a Breeze address that isn't one label under its domain.
    let client = reqwest::blocking::Client::new();
    for address in [
        &"https://example.com/doing/plans".to_owned(),
        &"http://api.churchapps.org/doing/plans".to_owned(),
        &format!("https://{}:{}/doing/plans", b1::HOST, 8443),
        &"https://user@api.churchapps.org/doing/plans".to_owned(),
        &"https://a.b.breezechms.com/api/people".to_owned(),
        &"https://breezechms.com/api/people".to_owned(),
    ] {
        let req = client
            .get(address.as_str())
            .header("accept", "application/json")
            .header("authorization", "Bearer x")
            .build()
            .unwrap();
        assert_eq!(allowed(&req), Err(ReadError::Refused), "{address}");
    }
}

/// `NativeHttp::get` sends nothing that `allowed` refuses: a refused request comes back `refused` before any
/// connection is made (an address no system uses would otherwise be tried).
#[test]
fn native_http_refuses_before_connecting() {
    let http = NativeHttp::new().unwrap();
    let get = Get::new(&b1::Read::Groups, Auth::Bearer(key()));
    let mut changed = http.build(&get).unwrap();
    *changed.method_mut() = reqwest::Method::POST;
    let started = std::time::Instant::now();
    assert_eq!(
        http.dispatch(changed, Duration::from_secs(5)).unwrap_err(),
        ReadError::Refused
    );
    assert!(started.elapsed() < Duration::from_millis(500));
}

/// Review C, M1: the guard checks the path, the query names and (for every system) the query values against the
/// system's own closed list of reads, just before sending.
#[test]
fn c_m1_write_paths_extra_queries_and_wrong_hosts_are_refused_when_sent() {
    let client = reqwest::blocking::Client::new();
    let get = |address: String, header: (&str, &str)| {
        client
            .get(address.as_str())
            .header("accept", "application/json")
            .header(header.0, header.1)
            .build()
            .unwrap()
    };
    let bearer = ("authorization", "Bearer x");
    let api_key = ("api-key", "x");
    let breeze_host = "https://cedarhollow.breezechms.com";
    let genesis_base = format!("https://{}/functions/v1/public-api/v1", genesis::HOST);
    let b1_base = format!("https://{}", b1::HOST);
    let refused = [
        // A write path on every system.
        get(
            format!("{breeze_host}/api/people/delete?person_id=1"),
            api_key,
        ),
        get(format!("{breeze_host}/api/events/add?name=x"), api_key),
        get(
            format!("{breeze_host}/api/volunteers/update?instance_id=1"),
            api_key,
        ),
        get(format!("{b1_base}/doing/plans/autofill/PLAfict01"), bearer),
        get(
            format!("{b1_base}/doing/assignments/decline/ASGone"),
            bearer,
        ),
        get(format!("{genesis_base}/contacts"), bearer),
        get(format!("{genesis_base}/giving/summary"), bearer),
        // An extra query name, or a value of the wrong shape.
        get(format!("{b1_base}/doing/plans?ministryId=GRP1"), bearer),
        get(
            format!("{breeze_host}/api/people?details=1&limit=3000"),
            api_key,
        ),
        get(
            format!("{breeze_host}/api/people?details=0&limit=3000&filter_json=x"),
            api_key,
        ),
        get(
            format!("{breeze_host}/api/events?start=2026-11-22&end=soon"),
            api_key,
        ),
        get(
            format!("{breeze_host}/api/volunteers/list?instance_id=1;2"),
            api_key,
        ),
        // A missing query name.
        get(
            format!("{breeze_host}/api/volunteers/list_roles?instance_id=1"),
            api_key,
        ),
        // An allowed path on the wrong system's host.
        get(format!("{b1_base}/api/people?details=0&limit=3000"), bearer),
        get(format!("{breeze_host}/doing/plans"), api_key),
        get(format!("https://{}/doing/plans", genesis::HOST), bearer),
        // L2: Breeze's own subdomains, punycode, and the wrong auth header for the host.
        get(
            "https://www.breezechms.com/api/tags/list_tags".to_owned(),
            api_key,
        ),
        get(
            "https://xn--cdrhollow-x9a.breezechms.com/api/tags/list_tags".to_owned(),
            api_key,
        ),
        get(format!("{b1_base}/membership/groups"), api_key),
        get(format!("{breeze_host}/api/tags/list_tags"), bearer),
    ];
    for req in &refused {
        assert_eq!(allowed(req), Err(ReadError::Refused), "{}", req.url());
    }
    // The same shapes, right: allowed.
    for req in [
        get(
            format!("{breeze_host}/api/people?details=0&limit=3000"),
            api_key,
        ),
        get(format!("{b1_base}/membership/groups"), bearer),
        get(format!("{breeze_host}/api/tags/list_tags"), api_key),
    ] {
        assert_eq!(allowed(&req), Ok(()), "{}", req.url());
    }
}

/// The guard's shapes are every read's: each system's samples hold one of each kind.
#[test]
fn every_kind_of_read_has_a_shape() {
    use std::collections::BTreeSet;
    let b1: BTreeSet<usize> = b1::samples().iter().map(b1::kind).collect();
    assert_eq!(b1, (0..=14).collect());
    let breeze: BTreeSet<usize> = breeze::samples().iter().map(breeze::kind).collect();
    assert_eq!(breeze, (0..=9).collect());
    let genesis: BTreeSet<usize> = genesis::samples().iter().map(genesis::kind).collect();
    assert_eq!(genesis, (0..=4).collect());
}

/// The real `get`, every read of every system: each is let through by `allowed` and fails only at
/// connecting (every host resolves to this Mac's loopback, where nothing answers). A request changed between building
/// and sending would come back `refused` instead.
#[test]
fn the_real_client_sends_every_read_past_the_guard() {
    let http = NativeHttp::loopback();
    let day = Date::parse("2026-11-22").unwrap();
    let mut gets: Vec<Get> = Vec::new();
    for read in b1::samples() {
        gets.push(Get::new(&read, Auth::Bearer(key())));
    }
    let host = breeze::church_host(&id("cedarhollow")).unwrap();
    for read in breeze::samples() {
        gets.push(Get::new(
            &breeze::At {
                host: &host,
                read: &read,
            },
            Auth::ApiKey(breeze_key()),
        ));
    }
    for read in genesis::samples() {
        gets.push(Get::new(&read, Auth::Bearer(genesis_key())));
    }
    let _ = day;
    for get in &gets {
        let error = http.get(get).unwrap_err();
        assert!(
            matches!(error, ReadError::Unreachable | ReadError::Timeout),
            "{}: {error}",
            get.url()
        );
    }
}

/// Review D, L1: B1 declares `/membership/churches/lookup/` before `/:id`, so a church id of `lookup` (any case) would
/// reach another route. Refused by the builder and the guard.
#[test]
fn b1_lookup_is_a_route_word_not_an_id() {
    let client = reqwest::blocking::Client::new();
    for word in ["lookup", "LOOKUP", "Lookup"] {
        let req = client
            .get(format!("https://{}/membership/churches/{word}", b1::HOST))
            .header("accept", "application/json")
            .header("authorization", "Bearer x")
            .build()
            .unwrap();
        assert_eq!(allowed(&req), Err(ReadError::Refused), "{word}");
        assert!(!b1::path_word_ok(word), "{word}");
    }
    assert!(b1::path_word_ok("CHUfict01"));
}
