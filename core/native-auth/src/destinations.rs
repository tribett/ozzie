//! Where Ozzie's native code sends AI requests: a closed list (onboarding spec lane N5/N6/N7; contract "Network
//! destinations"). Planning Center reads keep their own allow-list (source.rs, GET only); ntfy.sh keeps phone_notice.rs.
//!
//! - The three AI companies a church can bring its own key from (providers.json presets), over https.
//! - AI on this Mac: Ollama and LM Studio on 127.0.0.1 only, plain http, never with a key.
//! - Ozzie's AI: ozzie.church (hosted.rs), over https.
//! - "Another AI company": the https address the person typed, confirmed natively by its host before a key goes
//!   (own_key.rs `take_in`), never Planning Center (model.rs `RouteConfig::endpoint`).
//!
//! Separately, pages Ozzie only opens in the person's browser (a company's sign-in or keys page, Ollama's download
//! page) are listed in `BROWSER_PAGE_HOSTS`: Ozzie itself never contacts them.
//!
//! And one download that isn't an AI request: Ollama's own macOS app, only after the person presses "Download Ollama
//! and set it up" (ollama_install.rs), from `APP_DOWNLOAD_HOSTS` over https, nothing about the church in it.

/// The AI companies' API hosts, as providers.json names them.
pub const AI_COMPANY_HOSTS: [&str; 3] = [
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
];
/// AI on this Mac: the only two local addresses ever asked.
pub const THIS_MAC: [&str; 2] = ["http://127.0.0.1:11434", "http://127.0.0.1:1234"];
/// Ozzie's AI.
pub const OZZIE_HOST: &str = "ozzie.church";
/// Ozzie's own pages opened in the browser (open_help_page "ozzie-account", "ozzie-terms"): "See my plan", "Update
/// my card", "Cancel it in my browser", "Read the terms". Fixed addresses, never from the page.
pub const OZZIE_PAGES: [(&str, &str); 2] = [
    ("ozzie-account", "https://ozzie.church/account"),
    ("ozzie-terms", "https://ozzie.church/terms"),
];
/// Opened in the browser only (open_help_page), never requested by Ozzie.
pub const BROWSER_PAGE_HOSTS: [&str; 4] = [
    "platform.openai.com",
    "platform.claude.com",
    "aistudio.google.com",
    "ollama.com",
];
/// Getting Ollama (ollama_install.rs): the hosts its download passes through, https only, exactly.
pub const APP_DOWNLOAD_HOSTS: [&str; 3] = crate::ollama_install::DOWNLOAD_HOSTS;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::host_key_of;

    #[test]
    fn the_presets_this_macs_two_apps_and_ozzie_church_are_the_whole_list() {
        let catalog = crate::own_key::catalog();
        let preset_hosts: Vec<String> = catalog.presets.iter().map(|p| p.host().unwrap()).collect();
        assert_eq!(preset_hosts, AI_COMPANY_HOSTS);
        for p in &catalog.presets {
            assert!(p.base_url.starts_with("https://"), "{}", p.id);
        }
        assert_eq!(
            [crate::local_ai::OLLAMA, crate::local_ai::LM_STUDIO],
            THIS_MAC
        );
        assert!(crate::model::LOCAL_BASE.starts_with(THIS_MAC[0]));
        assert_eq!(
            host_key_of(crate::hosted::HOSTED_BASE).as_deref(),
            Some(OZZIE_HOST)
        );
        assert!(crate::hosted::HOSTED_BASE.starts_with("https://"));
        // The pages opened in the browser are on these hosts and none of them is a request destination.
        let mut pages: Vec<String> = catalog
            .presets
            .iter()
            .flat_map(|p| {
                ["sign-in", "billing", "keys", "settings"]
                    .map(|step| host_key_of(p.page(step).unwrap()).unwrap())
            })
            .chain(host_key_of(&catalog.local.ollama_download))
            .collect();
        pages.sort();
        pages.dedup();
        let mut expected: Vec<String> = BROWSER_PAGE_HOSTS.iter().map(|h| h.to_string()).collect();
        expected.sort();
        assert_eq!(pages, expected);
        for host in BROWSER_PAGE_HOSTS {
            assert!(!AI_COMPANY_HOSTS.contains(&host) && host != OZZIE_HOST);
        }
        // Getting Ollama: its own site and GitHub's release hosts, over https, and never an AI request's destination.
        assert_eq!(
            APP_DOWNLOAD_HOSTS,
            ["ollama.com", "github.com", "release-assets.githubusercontent.com"]
        );
        let policy = crate::ollama_install::Policy::official();
        assert!(policy.https_only);
        assert_eq!(policy.hosts, APP_DOWNLOAD_HOSTS);
        for host in APP_DOWNLOAD_HOSTS {
            assert!(!AI_COMPANY_HOSTS.contains(&host) && host != OZZIE_HOST);
        }
        // Ozzie's own pages are on ozzie.church, https, and open only by their fixed word.
        for (word, url) in OZZIE_PAGES {
            assert!(url.starts_with("https://"));
            assert_eq!(host_key_of(url).as_deref(), Some(OZZIE_HOST));
            assert_eq!(crate::own_key::help_page(word), Some(url));
        }
    }

    #[test]
    fn review_m7_every_address_and_program_in_the_ai_and_paid_code_is_on_the_list_exactly() {
        // Scheme, host and port compared whole (not "starts with"), over the core and app files on the AI path.
        let mut exact: Vec<String> = AI_COMPANY_HOSTS
            .iter()
            .map(|h| format!("https://{h}"))
            .collect();
        exact.extend(THIS_MAC.iter().map(|o| o.to_string()));
        exact.push(format!("https://{OZZIE_HOST}"));
        exact.extend(BROWSER_PAGE_HOSTS.iter().map(|h| format!("https://{h}")));
        exact.extend(APP_DOWNLOAD_HOSTS.iter().map(|h| format!("https://{h}")));
        let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../product/desktop/src-tauri/src");
        let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for path in [
            core.join("own_key.rs"),
            core.join("local_ai.rs"),
            core.join("local_models.rs"),
            core.join("ollama_install.rs"),
            core.join("hosted.rs"),
            core.join("anthropic.rs"),
            app.join("key_sheet.rs"),
            app.join("ai_setup.rs"),
            app.join("ollama_setup.rs"),
        ] {
            let text = std::fs::read_to_string(&path).unwrap();
            let code = text.split("#[cfg(test)]").next().unwrap();
            for (at, _) in code.match_indices("://") {
                let start = code[..at]
                    .rfind(|c: char| !c.is_ascii_alphanumeric())
                    .map_or(0, |i| i + 1);
                let scheme = &code[start..at];
                if scheme != "http" && scheme != "https" {
                    continue;
                }
                let authority: String = code[at + 3..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || ".:-".contains(*c))
                    .collect();
                // A bare scheme (a check like `starts_with("https://")`, or a formatted address) names no host.
                if authority.is_empty() {
                    continue;
                }
                let origin = format!("{scheme}://{authority}");
                // A debug build's own ozzie.church on this Mac (hosted.rs `dev_base`) is checked there; no key.
                let debug_loopback =
                    path.ends_with("hosted.rs") && origin.starts_with("http://127.0.0.1");
                assert!(
                    exact.contains(&origin) || debug_loopback,
                    "{}: {origin}",
                    path.display()
                );
            }
            // The only programs these files start: the browser opener, the memory read, the macOS version read; and,
            // only where Ollama is got (2026-11-18), Apple's unpacker and Gatekeeper's assessment, each with the path
            // of Ozzie's own work folder as its only argument that isn't fixed.
            let getting_ollama = path.ends_with("ollama_install.rs");
            for (at, _) in code.match_indices("Command::new(") {
                let arg = &code[at + "Command::new(".len()..];
                assert!(
                    [
                        "\"/usr/bin/open\"",
                        "\"/usr/sbin/sysctl\"",
                        "\"/usr/bin/sw_vers\""
                    ]
                    .iter()
                    .chain(if getting_ollama {
                        &["\"/usr/bin/unzip\"", "\"/usr/sbin/spctl\""][..]
                    } else {
                        &[][..]
                    })
                    .any(|program| arg.starts_with(program)),
                    "{}: {}",
                    path.display(),
                    &arg[..arg.len().min(40)]
                );
            }
        }
        // main.rs starts only the browser opener.
        let main = std::fs::read_to_string(app.join("main.rs")).unwrap();
        let main = main.split("#[cfg(test)]").next().unwrap();
        for (at, _) in main.match_indices("Command::new(") {
            assert!(main[at + "Command::new(".len()..].starts_with("\"/usr/bin/open\""));
        }
    }

    #[test]
    fn no_other_address_is_written_into_the_ai_setup_code() {
        // Every http(s) address in the AI setup modules' own code is on the list above (test files aside).
        let allowed = |url: &str| {
            let host = host_key_of(url).unwrap_or_default();
            AI_COMPANY_HOSTS.contains(&host.as_str())
                || THIS_MAC.iter().any(|origin| url.starts_with(origin))
                || host == OZZIE_HOST
                || BROWSER_PAGE_HOSTS.contains(&host.as_str())
                || (url.starts_with("https://") && APP_DOWNLOAD_HOSTS.contains(&host.as_str()))
        };
        for (name, source) in [
            ("own_key.rs", include_str!("own_key.rs")),
            ("local_ai.rs", include_str!("local_ai.rs")),
            ("local_models.rs", include_str!("local_models.rs")),
            ("ollama_install.rs", include_str!("ollama_install.rs")),
            ("providers.json", include_str!("providers.json")),
            ("destinations.rs", include_str!("destinations.rs")),
        ] {
            let code = source.split("#[cfg(test)]").next().unwrap();
            for (at, _) in code.match_indices("http") {
                let rest = &code[at..];
                if !(rest.starts_with("http://") || rest.starts_with("https://")) {
                    continue;
                }
                let url: String = rest
                    .chars()
                    .take_while(|c| !c.is_whitespace() && !"\"'`),;".contains(*c))
                    .collect();
                // The user agent's own address names Ozzie's site.
                assert!(allowed(&url), "{name}: {url}");
            }
        }
    }
}
