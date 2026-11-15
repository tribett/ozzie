//! Which church Ozzie last used on this Mac, kept natively across launches (review S3, M1 and L1).
//!
//! A saved sign-in becomes the church in use only through a fresh browser sign-in, an answer to
//! "Switch Ozzie to this church?", or a check of the church Ozzie last used (`connections`). This
//! record says which church that is, so neither the page's settings naming another church nor a
//! relaunch can make a sign-in Ozzie found current, and the person's own church is never the one
//! asked about as found. It also lists the churches Ozzie was still signing out of when it was
//! written, so a launch after Ozzie closed partway reports them as not signed out yet.
//!
//! Non-secret: organization numbers, and the registration as the page keeps it (empty for Ozzie's
//! own, else the public client ID typed under Advanced). Kept in the app's data folder, readable by
//! this user only. A program able to write there could also plant sign-ins in the Keychain; this
//! record keeps the page's settings from choosing the church, not a determined local program.
use crate::oauth::numeric_id;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::PathBuf;

/// The most churches a record lists as still being signed out of.
const MAX_LEAVING: usize = 64;
/// A record is a few hundred bytes; anything much larger isn't one.
const MAX_BYTES: u64 = 16 * 1024;

/// The church Ozzie uses, and the churches it was still signing out of.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsedChurch {
    pub organization: String,
    /// Empty for Ozzie's own registration, else the public client ID typed under Advanced.
    pub client_id: String,
    /// Churches the person chose to leave whose sign-ins weren't signed out of yet, sorted.
    #[serde(default)]
    pub leaving: Vec<String>,
}
impl UsedChurch {
    /// Whether a record read back is one Ozzie could have written.
    pub fn valid(&self) -> bool {
        numeric_id(&self.organization)
            && self.client_id.len() <= 256
            && !self.client_id.chars().any(char::is_control)
            && self.leaving.len() <= MAX_LEAVING
            && self
                .leaving
                .iter()
                .all(|o| numeric_id(o) && *o != self.organization)
    }
}

/// Where the record lives.
pub trait UseHistory: Send + Sync {
    /// The church last used, when one was recorded and reads back whole and valid.
    fn load(&self) -> Option<UsedChurch>;
    /// Records `used`. A failure leaves the earlier record; the next change writes again.
    fn save(&self, used: &UsedChurch) -> io::Result<()>;
}

/// The record as a small file in the app's data folder, replaced whole on every write.
pub struct UseFile {
    path: PathBuf,
}
impl UseFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}
impl UseHistory for UseFile {
    fn load(&self) -> Option<UsedChurch> {
        let mut bytes = Vec::new();
        std::fs::File::open(&self.path)
            .ok()?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_BYTES {
            return None;
        }
        let used: UsedChurch = serde_json::from_slice(&bytes).ok()?;
        used.valid().then_some(used)
    }
    fn save(&self, used: &UsedChurch) -> io::Result<()> {
        if !used.valid() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a record"));
        }
        let dir = self
            .path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no folder"))?;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(dir)?;
        let text = serde_json::to_vec(used).map_err(io::Error::other)?;
        let partial = self.path.with_extension("partial");
        let _ = std::fs::remove_file(&partial);
        let mut options = OpenOptions::new();
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let written = options
            .write(true)
            .create_new(true)
            .open(&partial)
            .and_then(|mut file| {
                file.write_all(&text)?;
                file.sync_all()
            });
        if let Err(error) = written.and_then(|()| std::fs::rename(&partial, &self.path)) {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own under the system's temporary folder, removed afterwards.
    struct Folder(PathBuf);
    impl Folder {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ozzie-in-use-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            Self(dir)
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn used(organization: &str, client_id: &str, leaving: &[&str]) -> UsedChurch {
        UsedChurch {
            organization: organization.into(),
            client_id: client_id.into(),
            leaving: leaving.iter().map(|o| o.to_string()).collect(),
        }
    }

    #[test]
    fn a_record_reads_back_as_written_and_is_replaced_whole() {
        let folder = Folder::new("round-trip");
        let file = UseFile::new(folder.0.join("app").join("church-in-use.json"));
        assert_eq!(file.load(), None, "nothing recorded yet");
        file.save(&used("1001", "", &[])).unwrap();
        assert_eq!(file.load(), Some(used("1001", "", &[])));
        file.save(&used("2002", "fictional-own-client", &["1001"]))
            .unwrap();
        assert_eq!(
            file.load(),
            Some(used("2002", "fictional-own-client", &["1001"]))
        );
        assert!(!folder.0.join("app").join("church-in-use.partial").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(folder.0.join("app").join("church-in-use.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_record_that_is_damaged_or_not_ozzies_reads_as_none() {
        let folder = Folder::new("damaged");
        std::fs::create_dir_all(&folder.0).unwrap();
        let path = folder.0.join("church-in-use.json");
        let file = UseFile::new(path.clone());
        for text in [
            "",
            "{",
            "[]",
            r#"{"organization":"01001","client_id":""}"#,
            r#"{"organization":"1001","client_id":"a\nb"}"#,
            r#"{"organization":"1001","client_id":"","leaving":["1001"]}"#,
            r#"{"organization":"1001","client_id":"","leaving":["x"]}"#,
            r#"{"client_id":""}"#,
        ] {
            std::fs::write(&path, text).unwrap();
            assert_eq!(file.load(), None, "{text:?}");
        }
        std::fs::write(&path, vec![b' '; (MAX_BYTES + 1) as usize]).unwrap();
        assert_eq!(file.load(), None);
        // A record written by an older build without `leaving` still reads.
        std::fs::write(&path, r#"{"organization":"1001","client_id":""}"#).unwrap();
        assert_eq!(file.load(), Some(used("1001", "", &[])));
        // Nothing invalid is ever written.
        assert!(file.save(&used("1001", "", &["1001"])).is_err());
        assert_eq!(file.load(), Some(used("1001", "", &[])));
    }
}
