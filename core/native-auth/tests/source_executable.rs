use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};
const REQUEST: &str = r#"{"version":1,"workspace":"fictional-workspace","organization":"1001","client_id":"fictional-client","service_type_id":"10","plan_id":"20","collection":"needed_positions","per_page":100,"offset":0}"#;
fn helper(input: &str, eof: bool) -> Value {
    helper_args(input, eof, &["--no-credentials"])
}
fn helper_args(input: &str, eof: bool, args: &[&str]) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ozzie-source-reader"))
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(input.as_bytes()).unwrap();
    stdin.flush().unwrap();
    if eof {
        drop(stdin);
    }
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let status = child.wait().unwrap();
    assert!(status.success());
    let mut stderr = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr).unwrap();
    assert!(stderr.is_empty());
    serde_json::from_str(&line).unwrap()
}
#[test]
fn actual_executable_has_only_sanitized_protocol_and_no_credential_fallback() {
    assert_eq!(
        helper("{\"url\":\"secret-name-care-canary\"}\n", false),
        json!({"version":1,"ok":false,"code":"denied","reason":"invalid-request"})
    );
    assert_eq!(
        helper(&format!("{REQUEST}\n"), false),
        json!({"version":1,"ok":false,"code":"unverified","reason":"missing-credentials"})
    );
    assert_eq!(helper(&format!("{REQUEST}\n"), true)["reason"], "cancelled");
}

#[test]
fn actual_helper_rejects_oversize_duplicate_and_production_mode_malformed_input() {
    assert_eq!(
        helper(&format!("{}\n", " ".repeat(4097)), false)["reason"],
        "oversized"
    );
    assert_eq!(
        helper(
            &format!(
                "{}\n",
                REQUEST.replace("\"offset\":0", "\"offset\":0,\"offset\":1")
            ),
            false
        )["reason"],
        "invalid-request"
    );
    assert_eq!(
        helper_args(
            "{\"url\":\"fictional-secret-name-care-canary\"}\n",
            false,
            &[]
        )["reason"],
        "invalid-request"
    );
    assert_eq!(
        helper_args(
            "",
            false,
            &["--fixture-secret=fictional-secret-name-care-canary"]
        )["reason"],
        "invalid-request"
    );
}
