use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreError {
    Locked,
    Denied,
    Unavailable,
}

/// Only -25300 (errSecItemNotFound) is absence. No raw OS messages escape.
pub fn classify_status(status: i32) -> StoreError {
    match status {
        -25308 | -25315 => StoreError::Locked,
        -25293 | -128 | -34018 => StoreError::Denied,
        _ => StoreError::Unavailable,
    }
}
pub trait CredentialStore: Send + Sync {
    fn put(&self, workspace: &str, organization: &str, value: &[u8]) -> Result<(), StoreError>;
    fn get(&self, workspace: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError>;
    fn delete(&self, workspace: &str, organization: &str) -> Result<(), StoreError>;
    /// Every saved (workspace, organization) in this store, from item attributes only: no secret is
    /// read, so nothing is decrypted. A store that can't list says so (`Unavailable`, the default),
    /// and callers fall back to the slots they already know.
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        Err(StoreError::Unavailable)
    }
}

/// Security.framework calls directly; no subprocess, argv, env or files.
/// The production service name is fixed by the consumer. Tests use a fresh namespace.
pub struct MacKeychain {
    pub service: String,
}
impl MacKeychain {
    fn account(&self, workspace: &str, organization: &str) -> Result<String, StoreError> {
        if workspace.is_empty() || organization.is_empty() || self.service.is_empty() {
            return Err(StoreError::Unavailable);
        }
        serde_json::to_string(&(workspace, organization)).map_err(|_| StoreError::Unavailable)
    }
}
#[cfg(target_os = "macos")]
impl CredentialStore for MacKeychain {
    fn put(&self, workspace: &str, organization: &str, value: &[u8]) -> Result<(), StoreError> {
        let account = self.account(workspace, organization)?;
        security_framework::passwords::set_generic_password(&self.service, &account, value)
            .map_err(|e| classify_status(e.code()))
    }
    fn get(&self, workspace: &str, organization: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let account = self.account(workspace, organization)?;
        match security_framework::passwords::get_generic_password(&self.service, &account) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(error) => Err(classify_status(error.code())),
        }
    }
    fn delete(&self, workspace: &str, organization: &str) -> Result<(), StoreError> {
        let account = self.account(workspace, organization)?;
        match security_framework::passwords::delete_generic_password(&self.service, &account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(classify_status(error.code())),
        }
    }
    /// This service's items by their account attribute alone (`kSecReturnAttributes`, never
    /// `kSecReturnData`). Accounts that aren't a (workspace, organization) pair are skipped.
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        if self.service.is_empty() {
            return Err(StoreError::Unavailable);
        }
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(&self.service)
            .load_attributes(true)
            .limit(Limit::All)
            // Listing never asks the person anything: an item that would need a prompt is skipped.
            .skip_authenticated_items(true)
            .search();
        let items = match found {
            Ok(items) => items,
            Err(error) if error.code() == -25300 => return Ok(Vec::new()),
            Err(error) => return Err(classify_status(error.code())),
        };
        Ok(items
            .iter()
            .filter_map(|item| item.simplify_dict())
            .filter_map(|attributes| own_account(attributes.get("acct")?))
            .collect())
    }
}
#[cfg(not(target_os = "macos"))]
impl CredentialStore for MacKeychain {
    fn put(&self, _: &str, _: &str, _: &[u8]) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Err(StoreError::Unavailable)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
    fn accounts(&self) -> Result<Vec<(String, String)>, StoreError> {
        Err(StoreError::Unavailable)
    }
}

/// An account attribute exactly as `MacKeychain` writes it: the compact JSON pair
/// `["<workspace>","<organization>"]`, both non-empty. Anything else (other spacing, extra fields,
/// another shape) isn't one of Ozzie's items and is ignored when listing (review S, L7).
pub fn own_account(account: &str) -> Option<(String, String)> {
    let (workspace, organization) = serde_json::from_str::<(String, String)>(account).ok()?;
    let canonical = serde_json::to_string(&(&workspace, &organization)).ok()?;
    (!workspace.is_empty() && !organization.is_empty() && canonical == account)
        .then_some((workspace, organization))
}
pub fn read_private(
    store: &dyn CredentialStore,
    workspace: &str,
    organization: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
    Ok(store.get(workspace, organization)?.map(Zeroizing::new))
}
