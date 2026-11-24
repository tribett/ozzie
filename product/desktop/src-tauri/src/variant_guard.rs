//! Whether a build's two switches agree: the `test-copy` feature (Keychain names, no Planning Center sign-in; native-auth
//! variant.rs) and the Tauri config's identifier (app data, caches and web view storage; tauri.test-copy.conf.json).
//! Either one alone would mix the copies: the feature alone keeps the real app's data folder, the overlay alone the real
//! app's Keychain names and its sign-in. build.rs fails such a build; main.rs `identity_agrees` stops one at launch. This
//! file is shared by build.rs and the app's tests, so it uses nothing but serde_json.

/// The test copy's identifier (native-auth variant.rs `TEST_COPY_APP_IDENTIFIER`; a test holds them equal).
pub const TEST_COPY_IDENTIFIER: &str = "church.ozzie.desktop.test";

/// The identifier a build's Tauri config names, read as tauri's own build reads it: tauri.conf.json (`base`), with
/// TAURI_CONFIG (`overlay`: what the CLI's `--config` hands the build, as JSON) merged over it.
pub fn identifier_in_use(base: &str, overlay: Option<&str>) -> Result<String, String> {
    let parse = |text: &str, what: &str| -> Result<serde_json::Value, String> {
        match serde_json::from_str::<serde_json::Value>(text) {
            Ok(value) if value.is_object() => Ok(value),
            _ => Err(format!("{what} isn't a Tauri config (a JSON object)")),
        }
    };
    let named = |value: &serde_json::Value, what: &str| -> Result<String, String> {
        value
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("{what} names no identifier"))
    };
    let mut identifier = named(
        &parse(base, "tauri.conf.json")?["identifier"],
        "tauri.conf.json",
    )?;
    let overlay = overlay
        .map(|text| parse(text, "TAURI_CONFIG"))
        .transpose()?;
    if let Some(value) = overlay.as_ref().and_then(|o| o.get("identifier")) {
        identifier = named(value, "TAURI_CONFIG")?;
    }
    Ok(identifier)
}

/// Ok when the `test-copy` feature is on exactly when the identifier is the test copy's.
pub fn switches_agree(test_copy: bool, identifier: &str) -> Result<(), String> {
    match (test_copy, identifier == TEST_COPY_IDENTIFIER) {
        (true, true) | (false, false) => Ok(()),
        (true, false) => Err(format!(
            "the test-copy feature is on but the Tauri config names {identifier}, so this build would keep the real \
             app's data folder: build the test copy with --features test-copy and --config \
             src-tauri/tauri.test-copy.conf.json together (tools/build-test-copy.sh in the private repository)"
        )),
        (false, true) => Err(format!(
            "the Tauri config names {TEST_COPY_IDENTIFIER} but the test-copy feature is off, so this build would use \
             the real app's Keychain names: pass --features test-copy with the overlay, or neither"
        )),
    }
}
