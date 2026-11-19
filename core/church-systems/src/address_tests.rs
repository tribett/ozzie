use super::*;

fn b1(text: &str) -> Option<String> {
    church_address(System::B1, text).map(|id| id.as_str().to_owned())
}
fn breeze(text: &str) -> Option<String> {
    church_address(System::Breeze, text).map(|id| id.as_str().to_owned())
}

#[test]
fn a_b1_address_is_the_name_before_b1_church() {
    for text in [
        "cedarhollow",
        "  CedarHollow  ",
        "cedarhollow.b1.church",
        "cedarhollow.b1.church.",
        "https://cedarhollow.b1.church",
        "https://cedarhollow.b1.church/",
        "http://CEDARHOLLOW.b1.church/sermons?x=1#top",
    ] {
        assert_eq!(b1(text).as_deref(), Some("cedarhollow"), "{text}");
    }
    assert_eq!(b1("grace-2").as_deref(), Some("grace-2"));
}

#[test]
fn a_breeze_address_is_its_subdomain() {
    for text in [
        "cedarhollow",
        "cedarhollow.breezechms.com",
        "https://cedarhollow.breezechms.com/dashboard",
        " CEDARHOLLOW.BREEZECHMS.COM ",
    ] {
        assert_eq!(breeze(text).as_deref(), Some("cedarhollow"), "{text}");
    }
}

#[test]
fn anything_that_isnt_one_church_label_is_refused() {
    for text in [
        "",
        "   ",
        "-grace",
        "grace-",
        "xn--grce-pqa",
        "grace church",
        "grace_church",
        "grace.b1.church.evil.com",
        "grace.evil.com",
        "a.b",
        "grâce",
        &"a".repeat(64),
        "https://",
        "https:///path",
        "user@grace.b1.church",
        "grace:443",
    ] {
        assert_eq!(b1(text), None, "b1 {text}");
        assert_eq!(breeze(text), None, "breeze {text}");
    }
    // Another system's domain is not stripped.
    assert_eq!(b1("grace.breezechms.com"), None);
    assert_eq!(breeze("grace.b1.church"), None);
}

#[test]
fn route_words_and_breezes_own_subdomains_are_refused() {
    // B1: an address that is one of its route words would reach another route.
    for word in ["lookup", "LOOKUP", "upcoming", "search", "all"] {
        assert_eq!(b1(word), None, "{word}");
    }
    // Breeze: its own subdomains are never a church.
    for word in ["www", "api", "app"] {
        assert_eq!(breeze(word), None, "{word}");
    }
}

#[test]
fn genesis_needs_no_address() {
    assert_eq!(church_address(System::Genesis, "cedarhollow"), None);
}
