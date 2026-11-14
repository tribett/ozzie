use ozzie_native_auth::credentials::{CredentialStore, MacKeychain};

/// Opt-in: touches only a fresh fictional namespace; no account or provider read.
#[test]
#[ignore = "explicit native Keychain canary, isolated and cleaned"]
fn native_store_get_delete_org_isolation_and_cleanup() {
    let store = MacKeychain {
        service: format!(
            "church.ozzie.canary.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ),
    };
    struct Cleanup<'a>(&'a MacKeychain);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            for org in ["1001", "1002"] {
                let _ = self.0.delete("fictional-workspace", org);
            }
        }
    }
    let _cleanup = Cleanup(&store);
    let result = (|| {
        assert!(store.get("fictional-workspace", "1001")?.is_none());
        store.put("fictional-workspace", "1001", b"fictional-native-canary-a")?;
        store.put("fictional-workspace", "1002", b"fictional-native-canary-b")?;
        assert_eq!(
            store.get("fictional-workspace", "1001")?,
            Some(b"fictional-native-canary-a".to_vec())
        );
        assert_eq!(
            store.get("fictional-workspace", "1002")?,
            Some(b"fictional-native-canary-b".to_vec())
        );
        assert!(store.get("different-workspace", "1001")?.is_none());
        store.delete("fictional-workspace", "1001")?;
        assert!(store.get("fictional-workspace", "1001")?.is_none());
        assert!(store.get("fictional-workspace", "1002")?.is_some());
        store.delete("fictional-workspace", "1002")?;
        store.delete("fictional-workspace", "1002")?;
        assert!(store.get("fictional-workspace", "1002")?.is_none());
        Ok::<(), ozzie_native_auth::credentials::StoreError>(())
    })();
    assert_eq!(result, Ok(()));
}
