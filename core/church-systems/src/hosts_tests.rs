//! No AI request may go to a church system: every host Ozzie reads a system from is one native-auth refuses as an
//! AI address (core/native-auth model.rs `church_system_host`), whatever the route.
use crate::{Hosts, System, b1, breeze, genesis};
use ozzie_native_auth::model::church_system_host;

#[test]
fn every_system_host_is_refused_as_an_ai_address() {
    for system in System::all() {
        match system.hosts() {
            Hosts::Fixed(hosts) => {
                for host in hosts {
                    assert!(church_system_host(host), "{host}");
                    assert!(church_system_host(&format!("{host}.")), "{host}.");
                    assert!(church_system_host(&host.to_uppercase()), "{host}");
                }
            }
            Hosts::ChurchSubdomainOf(suffix) => {
                assert_eq!(suffix, breeze::SUFFIX);
                for church in ["cedarhollow", "grace-2", "x"] {
                    let host = format!("{church}.{suffix}");
                    assert!(church_system_host(&host), "{host}");
                }
                assert!(church_system_host(suffix));
            }
        }
    }
    assert!(church_system_host(b1::HOST));
    assert!(church_system_host(genesis::HOST));
}
