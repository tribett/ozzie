use super::*;

#[test]
fn a_default_build_is_the_real_app_with_the_real_names() {
    // The feature is off unless a build asks for it; `cargo test` (as the release's checks run it) is the real app.
    if cfg!(feature = "test-copy") {
        return;
    }
    assert_eq!(APP_IDENTIFIER, "church.ozzie.desktop");
    assert_eq!(APP_IDENTIFIER, REAL_APP_IDENTIFIER);
    assert_eq!(
        this_builds_services(),
        [
            "church.ozzie.planning-center.v1",
            "church.ozzie.model.v1",
            "church.ozzie.phone-notice.v1",
            "church.ozzie.source-links.v1",
            "church.ozzie.calendar-links.v1",
        ]
    );
    assert_eq!(this_builds_services(), REAL_SERVICES[..5]);
}

#[test]
fn the_test_copy_names_every_service_with_its_prefix_and_none_is_a_real_name() {
    if !cfg!(feature = "test-copy") {
        return;
    }
    assert_eq!(APP_IDENTIFIER, "church.ozzie.desktop.test");
    for (name, real) in this_builds_services().iter().zip(REAL_SERVICES) {
        assert_eq!(name.strip_prefix(TEST_COPY_KEYCHAIN_PREFIX), Some(real));
        assert!(
            !REAL_SERVICES.contains(name),
            "{name} is one of the real app's names"
        );
        // The macro and the developer tool's name for it agree.
        assert_eq!(test_copy_service(real).as_deref(), Some(*name));
    }
}

#[test]
fn the_prefix_can_never_make_a_real_name() {
    assert_eq!(TEST_COPY_KEYCHAIN_PREFIX, "church.ozzie.desktop.test/");
    assert_eq!(
        TEST_COPY_KEYCHAIN_PREFIX,
        format!("{TEST_COPY_APP_IDENTIFIER}/")
    );
    assert_ne!(TEST_COPY_APP_IDENTIFIER, REAL_APP_IDENTIFIER);
    // Every real name starts `church.ozzie.` and has no slash; every test copy name has one.
    for real in REAL_SERVICES {
        assert!(real.starts_with("church.ozzie.") && !real.contains('/'));
        assert!(!real.starts_with(TEST_COPY_KEYCHAIN_PREFIX));
        let test = test_copy_service(real).unwrap();
        assert!(!REAL_SERVICES.contains(&test.as_str()));
        assert_ne!(test, real);
    }
    // Distinct real names stay distinct.
    let mut tests: Vec<String> = REAL_SERVICES
        .iter()
        .map(|r| test_copy_service(r).unwrap())
        .collect();
    tests.sort();
    tests.dedup();
    assert_eq!(tests.len(), REAL_SERVICES.len());
    // A name is never prefixed twice, and an empty one is no name.
    assert_eq!(
        test_copy_service("church.ozzie.desktop.test/church.ozzie.model.v1"),
        None
    );
    assert_eq!(test_copy_service(""), None);
}

#[test]
fn every_keychain_service_in_this_crate_goes_through_the_macro() {
    // A service name written as a bare literal would stay the real app's name in the test copy. Only this file and the
    // tools that are never part of the app (bin/) may spell a real name.
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bare = Vec::new();
    for entry in std::fs::read_dir(&src).unwrap() {
        let file = entry.unwrap().path();
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        if !name.ends_with(".rs") || name.ends_with("_tests.rs") || name.starts_with("variant") {
            continue;
        }
        let text = std::fs::read_to_string(&file).unwrap();
        for line in text.lines() {
            let code = line.split("//").next().unwrap_or("");
            if code.contains("\"church.ozzie.") && !code.contains("keychain_service!(") {
                bare.push(format!("{name}: {}", line.trim()));
            }
        }
    }
    assert!(bare.is_empty(), "bare Keychain names: {bare:#?}");
}
