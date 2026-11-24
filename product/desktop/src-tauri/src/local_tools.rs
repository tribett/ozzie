//! On-device helpers: Today's spoken briefing (macOS `say`), visitor-card text recognition (Ozzie's
//! own Apple Vision helper, or a locally installed Tesseract if that helper can't run) and speaking
//! a question into Ask (Ozzie's own on-device speech helper). Each runs as a child process under
//! its own sandbox profile with an empty environment. Text, image bytes and transcripts travel only
//! over pipes and live only in memory for one call: no temporary files, no recordings, no logs.
//! Errors are closed codes that never carry card, briefing or spoken content.
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

pub(crate) const SANDBOX: &str = "/usr/bin/sandbox-exec";

/// Tesseract parses untrusted images, so it gets nothing beyond running itself and reading its
/// own install. Everything else is denied: no network, no file writes, no other programs, no
/// system services (no mach-lookup at all), no reads of the home folder or anywhere else.
/// Verified 2026-11-13 on macOS 27.2 / Tesseract 5.5.4 (Homebrew): output byte-identical to an
/// unsandboxed run on a synthetic card.
pub const TESSERACT_POLICY: &str = r#"(version 1)
(deny default)
; Run the recognizer itself. Homebrew's /opt/homebrew/bin/tesseract is a link into its Cellar.
(allow process-exec (literal "/opt/homebrew/bin/tesseract") (regex #"^/opt/homebrew/Cellar/tesseract/[^/]+/bin/tesseract$"))
(allow file-read*
  ; The working directory is /, which it reads once at start (it aborts otherwise).
  (literal "/")
  ; Its program, the libraries it links (opt/ links into the Cellar) and its English language data.
  (literal "/opt/homebrew/bin/tesseract")
  (subpath "/opt/homebrew/Cellar")
  (subpath "/opt/homebrew/opt")
  (subpath "/opt/homebrew/share/tessdata"))
"#;

/// `say` needs the Mac's audio and speech services, so it gets exactly those and nothing else:
/// no network, no file writes, no other programs, no reads of the home folder. Logging,
/// analytics, preferences and notification services are denied. Each mach-lookup below was
/// found necessary by removing it and hearing playback stop (2026-11-13, macOS 27.2).
pub const SAY_POLICY: &str = r#"(version 1)
(deny default)
; Run the speech tool itself.
(allow process-exec (literal "/usr/bin/say"))
(allow file-read*
  ; Directory lookups on the way to system files (contents of /System/Volumes/Data are not readable).
  (literal "/") (literal "/etc") (literal "/var") (literal "/usr") (literal "/usr/bin") (literal "/usr/bin/say")
  (literal "/System") (literal "/System/Volumes") (literal "/System/Volumes/Data") (literal "/System/Volumes/Preboot")
  ; System frameworks, the speech voice assets and the shared library cache.
  (subpath "/System/Library") (subpath "/System/Cryptexes") (subpath "/System/iOSSupport")
  (subpath "/System/Volumes/Preboot/Cryptexes")
  ; System libraries, Unicode and language data, time zone data.
  (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/var/db/timezone")
  ; The Mac-wide language and region settings (not the user's own preferences).
  (literal "/Library/Preferences/.GlobalPreferences.plist"))
(allow mach-lookup
  ; Audio output. Without it, say waits forever.
  (global-name "com.apple.audio.audiohald")
  ; Finds the speech synthesizer audio unit.
  (global-name "com.apple.audio.AudioComponentRegistrar")
  ; Finds the system voice extension and starts it.
  (global-name "com.apple.pluginkit.pkd")
  (global-name "com.apple.runningboard")
  ; The system voice itself (Apple's speech synthesis extension).
  (xpc-service-name "com.apple.ax.MauiTTSSupport.MauiAUSP")
  (xpc-service-name "com.apple.ax.MauiTTSSupport.MauiAUSP.apple-extension-service"))
"#;

/// The rules both runs of Ozzie's card reader share. A macro so the two policies stay literal text.
/// Parameters, filled in by `CardReader::command`: HELPER, the reader itself; APP, Ozzie.app (or
/// the reader's folder in a development build); MODEL_CACHE and METAL_CACHE, the two folders
/// Apple's recognizer keeps its compiled models in.
macro_rules! card_reader_rules {
    () => {
        r#"(version 1)
(deny default)
; Run the reader itself: Ozzie's own program, signed with Ozzie.
(allow process-exec (literal (param "HELPER")))
(allow file-read*
  ; The working directory, and Ozzie.app, which the reader looks itself up in.
  (literal "/") (subpath (param "APP"))
  ; Directory lookups on the way to system files (contents of /System/Volumes/Data are not readable).
  (literal "/System") (literal "/System/Volumes") (literal "/System/Volumes/Data") (literal "/System/Volumes/Preboot")
  ; System frameworks, Apple's text recognition models that come with macOS, the shared library cache.
  (subpath "/System/Library") (subpath "/System/Cryptexes") (subpath "/System/iOSSupport")
  (subpath "/System/Volumes/Preboot/Cryptexes")
  ; System libraries, Unicode and language data.
  (subpath "/usr/lib") (subpath "/usr/share")
  ; The recognizer's compiled models.
  (subpath (param "MODEL_CACHE")) (subpath (param "METAL_CACHE")))
; Folder lookups on the way to those (the per-user cache folder is reached through /var).
(allow file-read-metadata (literal "/var")
  (path-ancestors (param "APP")) (path-ancestors (param "MODEL_CACHE")) (path-ancestors (param "METAL_CACHE")))
; Kernel facts such as the processor and memory size.
(allow sysctl-read)
; The graphics processor and the Neural Engine, as Apple's own app sandbox grants them for
; recognition models; the system service that loads models onto the Neural Engine; and the lookup
; of this person's cache folder.
(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient" "IOSurfaceRootUserClient"
  "AppleVirtIONeuralEngineDeviceUserClient" "H11ANEInDirectPathClient" "H1xANELoadBalancerDirectPathClient"))
(allow mach-lookup (global-name "com.apple.appleneuralengine" "com.apple.bsd.dirhelper"))
"#
    };
}

/// Reading a card. Ozzie's Vision reader parses untrusted photos, so beyond the rules above it gets
/// nothing: no network, no file writes at all, no other programs, no home folder. The compiled
/// models are read-only here. Verified 2026-11-14 on macOS 27.2 in an app bundle and a development
/// folder: text identical to an unsandboxed run on the fictional cards; without the GPU client it
/// silently reads nothing, without the Neural Engine or /usr/share it fails. PNG and JPEG photos are
/// read under this policy; a HEIC under `CARD_HEIC_READER_POLICY`.
pub const CARD_READER_POLICY: &str = card_reader_rules!();

/// Reading a HEIC card (an iPhone photo): the reading policy and one rule more, used only when the
/// photo is a HEIC by its bytes (`card_image_kind`). Verified 2026-11-16 on macOS 27.2: without the
/// rule a HEIC decodes to an empty picture with no error (the reader refuses it as unreadable); with
/// it, the same text as the PNG of the same card. The IOSurface accelerator a HEIC decode also asks
/// for wasn't needed and stays denied.
pub const CARD_HEIC_READER_POLICY: &str = concat!(
    card_reader_rules!(),
    r#"; HEIC only. ImageIO decodes HEVC only through Apple's video decoder service, which runs in Apple's own sandbox, not
; this one. That sandbox is broader than the reader's: it can read files the reader can't, though it has no network and
; can't write. What is handed to it is the photo the leader chose, nothing else. Allowed by the owner's decision of
; 2026-11-16; PNG and JPEG cards, and preparing on the practice picture, never get this rule.
(allow mach-lookup (xpc-service-name "com.apple.coremedia.videodecoder"))
"#
);

/// Preparing, once per launch: the same reader on Ozzie's fixed practice picture (never a card)
/// may also compile Apple's models into their two cache folders and let the Neural Engine service
/// read them. The first time on a Mac, and after a macOS update, this takes a minute or two.
pub const CARD_PREPARE_POLICY: &str = concat!(
    card_reader_rules!(),
    r#"; Preparing only: write the compiled models, and let the Neural Engine service read them.
(allow file-write* (subpath (param "MODEL_CACHE")) (subpath (param "METAL_CACHE")))
(allow file-issue-extension
  (require-all (extension-class "com.apple.app-sandbox.read") (subpath (param "MODEL_CACHE"))))
"#
);

/// Listening for a spoken question. The microphone and on-device speech recognition need many
/// system services (audio, privacy permissions, the recognizer), so this starts from allow and
/// takes away what matters: no network, no file writes (nothing can be recorded or kept), and no
/// other programs. The helper itself also insists on on-device recognition.
pub const LISTEN_POLICY: &str = r#"(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny process-fork)
(deny process-exec)
(allow process-exec (literal (param "HELPER")))
"#;

const SAY: &str = "/usr/bin/say";
/// A fixed voice and rate; the webview can't choose either. 170 words per minute matches
/// `SPOKEN_WORDS_PER_MINUTE` in core/src/spoken-briefing.ts.
const VOICE: &str = "Samantha";
const RATE: &str = "170";
/// About three minutes of speech; the briefing script stays near two.
pub const MAX_SPEECH_CHARS: usize = 4000;
const MAX_PLAYBACK: Duration = Duration::from_secs(300);

/// Ozzie's own helpers (helpers/*.swift), built by build.rs, bundled beside Ozzie's program and
/// signed with it: Ozzie.app/Contents/MacOS in the app, target/<profile> in a development build.
pub const CARD_READER: &str = "ozzie-card-reader";
pub const LISTENER: &str = "ozzie-listen";
/// Ozzie's bundle identifier (tauri.conf.json; the test copy's own in the test copy). Inside Ozzie.app, Apple's
/// recognizer names its model caches after it; in a development build, after the reader's file name.
const BUNDLE_ID: &str = ozzie_native_auth::variant::APP_IDENTIFIER;
/// A Homebrew Tesseract, used only when Ozzie's own reader can't run on this Mac.
const TESSERACT: &str = "/opt/homebrew/bin/tesseract";
/// Same per-image limit as the card review lifecycle.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Largest picture the recognizer decodes, in pixels: a small file can declare a huge image, and
/// decoding it would take far more memory than its bytes suggest. A phone photo is about 12 MP.
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;
/// Recognized text beyond this is refused, never truncated.
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
/// The Vision reader's pieces of text with their boxes, as JSON lines (the text itself is at most
/// MAX_TEXT_BYTES; the reader refuses more).
const MAX_PIECES_BYTES: usize = 64 * 1024;
const RECOGNITION_TIMEOUT: Duration = Duration::from_secs(30);
/// Preparing compiles Apple's models the first time: about two minutes at most observed.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(300);
/// Ozzie's fixed practice picture: two printed lines ("Ozzie is getting ready / to read cards on
/// this Mac"), rendered once with Core Text. No person, no card.
const PRACTICE_PICTURE: &[u8] = include_bytes!("../helpers/practice.png");

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalToolError {
    InvalidInput,
    Busy,
    Unavailable,
    Failed,
    Timeout,
    TooMuchText,
    /// The review closed while its card was being read; the text was thrown away.
    Cancelled,
    /// The photo is a type the reader opens, but it decoded to nothing (or not at all): never shown as a blank card.
    Unreadable,
    /// A picture of more than MAX_IMAGE_PIXELS (a 48-megapixel iPhone photo, say).
    TooManyPixels,
}

/// `not-available` when this Mac has no local recognizer; the page then offers empty fields.
/// `unclearLines`: the lines of `text` (from 0) holding a piece the reader couldn't read clearly;
/// the page flags any field read from them for a person to check. A Tesseract reports none.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum CardText {
    Read {
        text: String,
        #[serde(rename = "unclearLines")]
        unclear_lines: Vec<usize>,
    },
    NotAvailable,
}

/// Whether this Mac can read card text: Ozzie's Vision reader (prepared) or a Tesseract.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CardReaderStatus {
    Ready,
    NotAvailable,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Playback {
    Finished,
    Stopped,
}

/// Plain speech only: no control characters, no `[[...]]` embedded speech commands that could
/// change the voice, rate or volume, and no `<`, `>` or `&`, so nothing reads as SSML-like markup.
pub fn speech_text(text: &str) -> Result<String, LocalToolError> {
    if text.chars().count() > MAX_SPEECH_CHARS {
        return Err(LocalToolError::InvalidInput);
    }
    let clean: String = text
        .chars()
        .map(|c| match c {
            '\n' => '\n',
            '[' | ']' | '<' | '>' | '&' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    if clean.trim().is_empty() {
        return Err(LocalToolError::InvalidInput);
    }
    Ok(clean)
}

fn sandboxed(policy: &str, locale: &str, argv: &[&str]) -> Command {
    let mut command = Command::new(SANDBOX);
    command
        .arg("-p")
        .arg(policy)
        .args(argv)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", locale)
        .current_dir("/")
        .stdin(Stdio::piped())
        .stderr(Stdio::null());
    command
}

/// One of Ozzie's own helpers under `policy`, whose parameters (`-D NAME=path`) are paths known
/// only at run time. HOME is passed so the recognizers find this person's cache folders without
/// a directory-service lookup; nothing else of Ozzie's environment is.
pub(crate) fn sandboxed_helper(
    policy: &str,
    locale: &str,
    params: &[(&str, &Path)],
    helper: &Path,
    args: &[&str],
    home: Option<&Path>,
) -> Command {
    let mut command = Command::new(SANDBOX);
    command.arg("-p").arg(policy);
    for (name, value) in params {
        let mut define = OsString::from(format!("{name}="));
        define.push(value.as_os_str());
        command.arg("-D").arg(define);
    }
    command
        .arg(helper)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", locale)
        .current_dir("/")
        .stdin(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(home) = home {
        command.env("HOME", home);
    }
    command
}

/// One of Ozzie's helpers beside `program` (Ozzie's own executable), as a real path: the sandbox
/// matches paths after links are resolved.
fn helper_beside(program: &Path, name: &str) -> Option<PathBuf> {
    let path = program.parent()?.join(name).canonicalize().ok()?;
    path.is_file().then_some(path)
}
pub(crate) fn helper(name: &str) -> Option<PathBuf> {
    helper_beside(&std::env::current_exe().ok()?.canonicalize().ok()?, name)
}
pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .and_then(|home| home.canonicalize().ok())
}

/// The per-user cache folder macOS gives every program (/private/var/folders/…/C).
fn darwin_user_cache_dir() -> Option<PathBuf> {
    unsafe extern "C" {
        fn confstr(name: i32, buf: *mut std::ffi::c_char, len: usize) -> usize;
    }
    const CS_DARWIN_USER_CACHE_DIR: i32 = 65538;
    let mut buf = vec![0u8; 1024];
    // SAFETY: confstr writes at most `len` bytes, NUL-terminated, into the buffer it is given.
    let len = unsafe { confstr(CS_DARWIN_USER_CACHE_DIR, buf.as_mut_ptr().cast(), buf.len()) };
    if len == 0 || len > buf.len() {
        return None;
    }
    buf.truncate(len - 1);
    let path = PathBuf::from(String::from_utf8(buf).ok()?);
    path.canonicalize().ok()
}

/// Where Ozzie's Vision reader runs from and where Apple's recognizer keeps its compiled models.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardReader {
    helper: PathBuf,
    /// Ozzie.app, or the reader's folder in a development build.
    app: PathBuf,
    home: PathBuf,
    model_cache: PathBuf,
    metal_cache: PathBuf,
}
impl CardReader {
    /// Inside Ozzie.app the recognizer names its caches after Ozzie's bundle identifier; a
    /// development build's reader (not in an app) after its own file name. The model cache sits in
    /// ~/Library/Caches, the graphics cache in the per-user cache folder.
    pub fn at(helper: PathBuf, home: PathBuf, darwin_cache: &Path) -> Option<CardReader> {
        let folder = helper.parent()?;
        let contents = folder.parent();
        let bundle = contents.and_then(Path::parent).filter(|app| {
            folder.file_name() == Some("MacOS".as_ref())
                && contents.and_then(Path::file_name) == Some("Contents".as_ref())
                && app.extension() == Some("app".as_ref())
        });
        let (app, id) = match bundle {
            Some(app) => (app.to_path_buf(), BUNDLE_ID.to_string()),
            None => (
                folder.to_path_buf(),
                helper.file_name()?.to_str()?.to_string(),
            ),
        };
        Some(CardReader {
            model_cache: home
                .join("Library/Caches")
                .join(&id)
                .join("com.apple.e5rt.e5bundlecache"),
            metal_cache: darwin_cache.join(&id).join("com.apple.metal"),
            helper,
            app,
            home,
        })
    }
    fn find() -> Option<CardReader> {
        CardReader::at(helper(CARD_READER)?, home()?, &darwin_user_cache_dir()?)
    }
    fn command(&self, policy: &str) -> Command {
        sandboxed_helper(
            policy,
            "C",
            &[
                ("HELPER", &self.helper),
                ("APP", &self.app),
                ("MODEL_CACHE", &self.model_cache),
                ("METAL_CACHE", &self.metal_cache),
            ],
            &self.helper,
            &[],
            Some(&self.home),
        )
    }
}

/// One piece of text the Vision reader found, with Vision's confidence in it (0 to 1) and its box
/// (0 to 1 from the top left).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
struct Piece {
    t: String,
    c: f64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// A piece read with this confidence or less is unclear. Vision's accurate reader reported only
/// 0.3, 0.5 or 1.0 on Ozzie's fictional cards, and its 0.5 readings were already garbled. Many
/// misreadings still come back at 1.0, so a clear piece is never proof the reading is right.
const UNCLEAR_AT_OR_BELOW: f64 = 0.5;

/// A card's recognized text, and the lines of it (from 0) holding a piece read unclearly.
#[derive(Debug, PartialEq, Eq)]
pub struct CardLines {
    pub text: String,
    pub unclear: Vec<usize>,
}

/// Puts the Vision reader's pieces of text back into lines, top to bottom and left to right, so a
/// printed label and the handwriting beside it read as one line ("Name: Alex Harbor") the way the
/// card-field suggestions (core/src/card-fields.ts) expect. A piece joins a line when its height
/// overlaps every piece already on it by at least half of the shorter one, so one tall piece can't
/// pull in the row below. A gap of more than twice the taller line's height before the next line
/// is kept as an empty line, so printed words far below a request never read as more of it. A
/// line is unclear when any of its pieces is. Nothing is repaired or reworded; malformed output
/// from the reader is a failure, never a guess.
pub fn card_lines(out: &[u8]) -> Result<CardLines, LocalToolError> {
    let mut pieces = Vec::new();
    for line in out.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
        let piece: Piece = serde_json::from_slice(line).map_err(|_| LocalToolError::Failed)?;
        let sane = |v: f64| v.is_finite() && (-0.01..=1.01).contains(&v);
        if ![piece.x, piece.y, piece.w, piece.h].into_iter().all(sane)
            || piece.h <= 0.0
            || !(0.0..=1.0).contains(&piece.c)
        {
            return Err(LocalToolError::Failed);
        }
        let text = piece.t.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            pieces.push(Piece { t: text, ..piece });
        }
    }
    pieces.sort_by(|a, b| (a.y + a.h / 2.0).total_cmp(&(b.y + b.h / 2.0)));
    let same_row =
        |a: &Piece, b: &Piece| (a.y + a.h).min(b.y + b.h) - a.y.max(b.y) >= 0.5 * a.h.min(b.h);
    let mut rows: Vec<(f64, f64, Vec<Piece>)> = Vec::new();
    for piece in pieces {
        let (top, bottom) = (piece.y, piece.y + piece.h);
        match rows.last_mut() {
            Some((row_top, row_bottom, row)) if row.iter().all(|p| same_row(p, &piece)) => {
                *row_top = row_top.min(top);
                *row_bottom = row_bottom.max(bottom);
                row.push(piece);
            }
            _ => rows.push((top, bottom, vec![piece])),
        }
    }
    let mut lines: Vec<String> = Vec::new();
    let mut unclear = Vec::new();
    let mut above: Option<(f64, f64)> = None;
    for (top, bottom, mut row) in rows {
        if let Some((above_bottom, above_height)) = above
            && top - above_bottom > 2.0 * above_height.max(bottom - top)
        {
            lines.push(String::new());
        }
        above = Some((bottom, bottom - top));
        if row.iter().any(|p| p.c <= UNCLEAR_AT_OR_BELOW) {
            unclear.push(lines.len());
        }
        row.sort_by(|a, b| a.x.total_cmp(&b.x));
        lines.push(row.into_iter().map(|p| p.t).collect::<Vec<_>>().join(" "));
    }
    let text = lines.join("\n");
    if text.len() > MAX_TEXT_BYTES {
        return Err(LocalToolError::TooMuchText);
    }
    Ok(CardLines { text, unclear })
}

/// One playback at a time. A new briefing stops the one before it.
#[derive(Default)]
pub struct Speech {
    current: Mutex<Option<(u64, Child)>>,
    generation: AtomicU64,
}
impl Speech {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(u64, Child)>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Speaks `text` on stdin and waits until it ends or is stopped.
    pub fn speak(&self, text: &str) -> Result<Playback, LocalToolError> {
        let text = speech_text(text)?;
        if !Path::new(SAY).is_file() || !Path::new(SANDBOX).is_file() {
            return Err(LocalToolError::Unavailable);
        }
        // UTF-8 so accented names are read as written when names are on.
        let mut command = sandboxed(
            SAY_POLICY,
            "en_US.UTF-8",
            &[SAY, "-v", VOICE, "-r", RATE, "-f", "-"],
        );
        command.stdout(Stdio::null());
        self.play(command, text.as_bytes(), MAX_PLAYBACK)
    }
    fn play(
        &self,
        mut command: Command,
        input: &[u8],
        limit: Duration,
    ) -> Result<Playback, LocalToolError> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut current = self.lock();
            if let Some((_, mut previous)) = current.take() {
                let _ = previous.kill();
                let _ = previous.wait();
            }
            let mut child = command.spawn().map_err(|_| LocalToolError::Unavailable)?;
            // At most a few kilobytes: fits the pipe buffer, so this never waits on the child.
            let written = child.stdin.take().map(|mut stdin| stdin.write_all(input));
            if !matches!(written, Some(Ok(()))) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(LocalToolError::Failed);
            }
            if self.generation.load(Ordering::SeqCst) != generation {
                // Stopped while starting.
                let _ = child.kill();
                let _ = child.wait();
                return Ok(Playback::Stopped);
            }
            *current = Some((generation, child));
        }
        let started = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let mut current = self.lock();
            let Some((owner, child)) = current.as_mut() else {
                return Ok(Playback::Stopped);
            };
            if *owner != generation {
                return Ok(Playback::Stopped);
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    current.take();
                    return if status.success() {
                        Ok(Playback::Finished)
                    } else {
                        Err(LocalToolError::Failed)
                    };
                }
                Ok(None) if started.elapsed() < limit => {}
                _ => {
                    if let Some((_, mut child)) = current.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    return Ok(Playback::Stopped);
                }
            }
        }
    }
    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some((_, mut child)) = self.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Runs a fixed command with `input` on stdin and returns stdout, bounded in size and time.
/// The child is killed on timeout, excess output or cancellation. Nothing is written anywhere.
pub(crate) fn run_bounded(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
    max_out: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, LocalToolError> {
    command.stdout(Stdio::piped());
    let mut child = command.spawn().map_err(|_| LocalToolError::Unavailable)?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(LocalToolError::Failed);
    };
    // Writing and reading run side by side so a large image can't deadlock the pipes.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let overflow = Arc::new(AtomicBool::new(false));
    let (sent, received) = mpsc::channel();
    {
        let overflow = overflow.clone();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let read = stdout.take(max_out as u64 + 1).read_to_end(&mut out);
            if out.len() > max_out {
                overflow.store(true, Ordering::SeqCst);
            }
            let _ = sent.send(read.map(|_| out));
        });
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        if overflow.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LocalToolError::TooMuchText);
        }
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LocalToolError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(LocalToolError::Timeout);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(LocalToolError::Failed);
            }
        }
    };
    let _ = writer.join();
    let remaining = deadline.saturating_duration_since(Instant::now());
    let out = match received.recv_timeout(remaining.max(Duration::from_millis(100))) {
        Ok(Ok(out)) => out,
        Ok(Err(_)) => return Err(LocalToolError::Failed),
        Err(_) => return Err(LocalToolError::Timeout),
    };
    if out.len() > max_out {
        return Err(LocalToolError::TooMuchText);
    }
    if !status.success() {
        return Err(exit_error(status.code()));
    }
    Ok(out)
}

/// Ozzie's helpers say why they stopped with an exit code (sysexits): 66 the card reader's photo
/// decoded to nothing, 69 this Mac can't do it, 74 too much text. Anything else, including a crash,
/// is a plain failure.
fn exit_error(code: Option<i32>) -> LocalToolError {
    match code {
        Some(66) => LocalToolError::Unreadable,
        Some(69) => LocalToolError::Unavailable,
        Some(74) => LocalToolError::TooMuchText,
        _ => LocalToolError::Failed,
    }
}

/// Width and height a PNG declares in its first chunk, which must be IHDR.
fn png_size(image: &[u8]) -> Option<(u64, u64)> {
    if !image.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) || image.get(12..16)? != b"IHDR" {
        return None;
    }
    let word = |at: usize| -> Option<u64> {
        Some(u64::from(u32::from_be_bytes(
            image.get(at..at + 4)?.try_into().ok()?,
        )))
    };
    Some((word(16)?, word(20)?))
}
/// Width and height from a JPEG's first start-of-frame segment, walking segments by their
/// lengths. No frame before the scan, or a segment running past the end, is no size.
fn jpeg_size(image: &[u8]) -> Option<(u64, u64)> {
    if !image.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut at = 2;
    loop {
        if *image.get(at)? != 0xFF {
            return None;
        }
        // Fill bytes before a marker.
        while *image.get(at + 1)? == 0xFF {
            at += 1;
        }
        let marker = *image.get(at + 1)?;
        at += 2;
        match marker {
            // Markers without a length.
            0x01 | 0xD0..=0xD7 => continue,
            // End of image or start of scan before any frame.
            0xD8..=0xDA => return None,
            _ => {}
        }
        let length = usize::from(u16::from_be_bytes(image.get(at..at + 2)?.try_into().ok()?));
        if length < 2 {
            return None;
        }
        // Every start-of-frame except DHT (C4), JPG (C8) and DAC (CC).
        if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let frame = image.get(at + 2..at + 7)?;
            let height = u64::from(u16::from_be_bytes([frame[1], frame[2]]));
            let width = u64::from(u16::from_be_bytes([frame[3], frame[4]]));
            return Some((width, height));
        }
        at += length;
    }
}
/// The ISO-BMFF boxes laid end to end in `data`, as (type, body). None if one is malformed or runs
/// past the end (a truncated file), or as soon as there are more than `limit` of them.
fn bmff_boxes_at_most(data: &[u8], limit: usize) -> Option<Vec<([u8; 4], &[u8])>> {
    let mut boxes = Vec::new();
    let mut at = 0usize;
    while at < data.len() {
        if boxes.len() >= limit {
            return None;
        }
        let size = u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?);
        let kind: [u8; 4] = data.get(at + 4..at + 8)?.try_into().ok()?;
        let (header, size) = match size {
            0 => (8, data.len() - at),
            1 => (
                16,
                usize::try_from(u64::from_be_bytes(
                    data.get(at + 8..at + 16)?.try_into().ok()?,
                ))
                .ok()?,
            ),
            n => (8, usize::try_from(n).ok()?),
        };
        if size < header || size > data.len() - at {
            return None;
        }
        boxes.push((kind, &data[at + header..at + size]));
        at += size;
    }
    Some(boxes)
}
/// Most items a HEIC may hold: its pictures, tiles, thumbnails and details. A 48-megapixel iPhone
/// photo has about 200.
const MAX_HEIC_ITEMS: usize = 1024;
/// The HEIF brands a HEIC photo starts with, as its file type's major brand: HEVC still pictures
/// (heic; heix, heim, heis for extended, multi-layer and scalable ones) and the general still
/// picture brand (mif1, which ImageIO reports as public.heif). Not a sequence (msf1, hevc, hevx:
/// ImageIO says public.heics), AVIF (avif) or video (isom, mp42, qt).
const HEIC_BRANDS: [&[u8; 4]; 5] = [b"heic", b"heix", b"heim", b"heis", b"mif1"];
/// Width and height of a HEIC photo's primary picture, from its own boxes: the file type first, with
/// a HEIC brand; a `meta` box for pictures (`pict`) naming the primary item, which must be HEVC
/// (`hvc1`) or a grid of tiles (`grid`, how iPhones store photos); and that item's `ispe`, its size.
/// A HEIC holding several pictures (a burst, a Live Photo's still with its others) gives the primary
/// one's size, the picture the reader reads; but every item in it is held to its own rules first
/// (each HEVC picture to its parameters, each grid to its tiles, a tone map to two pictures) and all
/// of them together to MAX_HEIC_FILE_PIXELS, and the file may say what it holds only once.
fn heic_size(image: &[u8]) -> Option<(u64, u64)> {
    let full = |body: &[u8]| -> Option<(u8, u32)> {
        let head = body.get(..4)?;
        Some((head[0], u32::from_be_bytes([0, head[1], head[2], head[3]])))
    };
    let u16_at = |b: &[u8], at: usize| -> Option<u32> {
        Some(u32::from(u16::from_be_bytes(
            b.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let u32_at = |b: &[u8], at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
    };
    let top = bmff_boxes_at_most(image, 64)?;
    let (kind, ftyp) = top.first()?;
    if kind != b"ftyp" || !HEIC_BRANDS.iter().any(|b| ftyp.get(..4) == Some(&b[..])) {
        return None;
    }
    // One of each box that says what the file holds: a second `meta` (or a second item list,
    // reference list or property list inside it) could show ImageIO a different file from this one.
    let once = |boxes: &[([u8; 4], &[u8])], names: &[&[u8; 4]]| {
        names
            .iter()
            .all(|name| boxes.iter().filter(|(k, _)| k == *name).count() <= 1)
    };
    if !once(&top, &[b"meta"]) {
        return None;
    }
    let meta = top.iter().find(|(k, _)| k == b"meta")?.1;
    let children = bmff_boxes_at_most(meta.get(4..)?, 64)?;
    if !once(
        &children,
        &[
            b"hdlr", b"pitm", b"iinf", b"iloc", b"iref", b"iprp", b"idat",
        ],
    ) {
        return None;
    }
    let child = |name: &[u8; 4]| children.iter().find(|(k, _)| k == name).map(|(_, b)| *b);
    if child(b"hdlr")?.get(8..12)? != b"pict" {
        return None;
    }
    let pitm = child(b"pitm")?;
    let primary = match full(pitm)?.0 {
        0 => u16_at(pitm, 4)?,
        _ => u32_at(pitm, 4)?,
    };
    // Every item and its type, from the item information: at most MAX_HEIC_ITEMS of them, declared or
    // present, before anything is decoded (review Z, L2: a small file of 65,025 items that all point
    // at one tile cost half a minute and 650 MB a card).
    let iinf = child(b"iinf")?;
    let (declared, entries) = if full(iinf)?.0 == 0 {
        (u16_at(iinf, 4)?, 6)
    } else {
        (u32_at(iinf, 4)?, 8)
    };
    if declared as usize > MAX_HEIC_ITEMS {
        return None;
    }
    let infes: Vec<&[u8]> = bmff_boxes_at_most(iinf.get(entries..)?, MAX_HEIC_ITEMS)?
        .into_iter()
        .filter(|(k, _)| k == b"infe")
        .map(|(_, infe)| infe)
        .collect();
    if infes.len() > MAX_HEIC_ITEMS {
        return None;
    }
    let items = infes
        .into_iter()
        .map(|infe| {
            let (id, kind_at) = match full(infe)?.0 {
                2 => (u16_at(infe, 4)?, 8),
                3 => (u32_at(infe, 4)?, 10),
                _ => return None,
            };
            Some((id, infe.get(kind_at..kind_at + 4)?))
        })
        .collect::<Option<Vec<(u32, &[u8])>>>()?;
    // Looked up by number, each item once (an item numbered twice is no photo).
    let types: std::collections::HashMap<u32, &[u8]> = items.iter().copied().collect();
    if types.len() != items.len() {
        return None;
    }
    let type_of = |id: u32| types.get(&id).copied();
    // Each item's properties: `ipco` lists them, `ipma` gives each item its own by number (from 1).
    let iprp = bmff_boxes_at_most(child(b"iprp")?, 64)?;
    if !once(&iprp, &[b"ipco", b"ipma"]) {
        return None;
    }
    let properties = bmff_boxes_at_most(
        iprp.iter().find(|(k, _)| k == b"ipco")?.1,
        MAX_HEIC_REFERENCES,
    )?;
    let ipma = iprp.iter().find(|(k, _)| k == b"ipma")?.1;
    let (version, flags) = full(ipma)?;
    let (id_len, index_len) = (
        if version < 1 { 2 } else { 4 },
        if flags & 1 == 1 { 2 } else { 1 },
    );
    let associations = usize::try_from(u32_at(ipma, 4)?).ok()?;
    if associations > MAX_HEIC_ITEMS {
        return None;
    }
    let mut at = 8;
    let mut associated: std::collections::HashMap<u32, Vec<u32>> =
        std::collections::HashMap::with_capacity(associations);
    for _ in 0..associations {
        let id = if id_len == 2 {
            u16_at(ipma, at)?
        } else {
            u32_at(ipma, at)?
        };
        let count = usize::from(*ipma.get(at + id_len)?);
        at += id_len + 1;
        let indexes = (0..count)
            .map(|i| {
                let at = at + i * index_len;
                Some(if index_len == 2 {
                    u16_at(ipma, at)? & 0x7fff
                } else {
                    u32::from(*ipma.get(at)? & 0x7f)
                })
            })
            .collect::<Option<Vec<u32>>>()?;
        at += count * index_len;
        if associated.insert(id, indexes).is_some() {
            return None;
        }
    }
    // An item's one property of `kind`, by its number: None for an item with two (review G, L-1:
    // ImageIO takes an item's last `hvcC`, this check took its first).
    let only = |id: u32, kind: &[u8; 4]| -> Option<usize> {
        let mut found = associated.get(&id)?.iter().filter_map(|&index| {
            let at = usize::try_from(index).ok()?.checked_sub(1)?;
            (properties.get(at)?.0 == *kind).then_some(at)
        });
        let first = found.next()?;
        found.next().is_none().then_some(first)
    };
    // An item's own size: its `ispe`.
    let size_of = |id: u32| -> Option<(u64, u64)> {
        let ispe = properties.get(only(id, b"ispe")?)?.1;
        Some((u64::from(u32_at(ispe, 4)?), u64::from(u32_at(ispe, 8)?)))
    };
    // An HEVC picture's coded size, from the sequence parameters in its `hvcC`, held to its `ispe`:
    // cropped to exactly that, coded at most 63 more each way (coding-block padding). Review F, L-1:
    // tiles claiming 196 by 196 that were each an 8192 by 8192 picture cost the reader 27 s and the
    // page's own picture 74 s. A picture that isn't a tile may also be coded at up to 255 each way,
    // whatever it says: Apple codes a small picture at no less than 160 by 64 (a 24 by 24 one is
    // coded 160 by 64), and so little costs nothing. One `hvcC` shared by many tiles, as Apple writes
    // them, is read once.
    let parsed: std::cell::RefCell<std::collections::HashMap<usize, Option<HevcSize>>> =
        Default::default();
    let coded_of = |id: u32, tile: bool| -> Option<(u64, u64)> {
        let index = only(id, b"hvcC")?;
        let known = parsed.borrow().get(&index).copied();
        let sps = match known {
            Some(sps) => sps,
            None => {
                let sps = hevc_size(properties.get(index)?.1);
                parsed.borrow_mut().insert(index, sps);
                sps
            }
        }?;
        let (width, height) = size_of(id)?;
        let padded = |coded: u64, shown: u64| coded < shown + 64 || (!tile && coded <= 255);
        (sps.cropped == (width, height)
            && padded(sps.coded.0, width)
            && padded(sps.coded.1, height))
        .then_some(sps.coded)
    };
    let size = size_of(primary)?;
    if !matches!(type_of(primary)?, b"hvc1" | b"grid") {
        return None;
    }
    // Every item, not only the primary, is held to the rules (review F, L-2: an alpha picture that was
    // a grid naming one tile 65,025 times held the reader for its 30 s): HEVC pictures to their
    // parameters, grids to theirs, a tone map (an HDR gain map's) to two pictures of the file. Exif
    // and XMP (`mime`) details are never decoded. Any other kind of item is no photo.
    // References parsed once (review G, L-2: parsed again for every grid and tone map, a file of
    // 1,020 tone maps and 600,000 filler references took seconds a check).
    let refs = heic_reference_map(&children)?;
    if items.iter().filter(|(_, kind)| *kind == b"tmap").count() > MAX_HEIC_TONE_MAPS {
        return None;
    }
    let mut tiles: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut pixels: u64 = 0;
    let tile_coded = |id: u32| coded_of(id, true);
    for &(id, kind) in &items {
        match kind {
            // HEVC pictures are held to their parameters below, once it is known which are tiles.
            b"hvc1" => {}
            b"grid" => {
                let (canvas, named) = heic_grid_fits(
                    image,
                    &children,
                    &refs,
                    id,
                    size_of(id)?,
                    &type_of,
                    &size_of,
                    &tile_coded,
                )?;
                pixels = pixels.checked_add(canvas)?;
                tiles.extend(named);
            }
            b"tmap" => {
                let inputs = refs.get(&(*b"dimg", id))?;
                if inputs.len() != 2
                    || inputs[0] == inputs[1]
                    || inputs.contains(&id)
                    || !inputs
                        .iter()
                        .all(|&i| matches!(type_of(i), Some(b"hvc1" | b"grid")))
                {
                    return None;
                }
                let (width, height) = size_of(id)?;
                pixels = pixels.checked_add(width.checked_mul(height)?)?;
            }
            b"Exif" | b"mime" => {}
            _ => return None,
        }
    }
    for &(id, kind) in &items {
        if kind == b"hvc1" && !tiles.contains(&id) {
            let (width, height) = coded_of(id, false)?;
            pixels = pixels.checked_add(width.checked_mul(height)?)?;
        }
    }
    // Too much in all is no photo, unless the photo alone is already over the limit: then it is
    // refused as too many pixels (review G, L-3: a 48-megapixel Portrait photo with its mattes is
    // about 138 megapixels in all).
    let over = size.0.checked_mul(size.1)? > MAX_IMAGE_PIXELS;
    (pixels <= MAX_HEIC_FILE_PIXELS || over).then_some(size)
}
/// Tone maps in one file: Apple writes one, for its HDR gain map.
const MAX_HEIC_TONE_MAPS: usize = 4;
/// References in one file, all told; one item may name at most MAX_HEIC_ITEMS.
const MAX_HEIC_REFERENCES: usize = 4096;
/// A file's item references (`iref`), by kind and the item that makes them, read once. None when
/// they are malformed, an item makes the same kind of reference twice, one names more than
/// MAX_HEIC_ITEMS items, or there are more than MAX_HEIC_REFERENCES of them or of the boxes that
/// hold them (read no further than that).
/// Item references by kind and the item that makes them.
type HeicReferences = std::collections::HashMap<([u8; 4], u32), Vec<u32>>;
fn heic_reference_map(children: &[([u8; 4], &[u8])]) -> Option<HeicReferences> {
    let mut map = HeicReferences::new();
    let Some((_, iref)) = children.iter().find(|(k, _)| k == b"iref") else {
        return Some(map);
    };
    let id_len = if *iref.first()? == 0 { 2 } else { 4 };
    let id_at = |b: &[u8], at: usize| -> Option<u32> {
        if id_len == 2 {
            Some(u32::from(u16::from_be_bytes(
                b.get(at..at + 2)?.try_into().ok()?,
            )))
        } else {
            Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
        }
    };
    let mut total = 0usize;
    for (kind, reference) in bmff_boxes_at_most(iref.get(4..)?, MAX_HEIC_REFERENCES)? {
        let from = id_at(reference, 0)?;
        let count = usize::from(u16::from_be_bytes(
            reference.get(id_len..id_len + 2)?.try_into().ok()?,
        ));
        total += count;
        if count > MAX_HEIC_ITEMS || total > MAX_HEIC_REFERENCES {
            return None;
        }
        let to = (0..count)
            .map(|i| id_at(reference, id_len + 2 + i * id_len))
            .collect::<Option<Vec<u32>>>()?;
        if map.insert((kind, from), to).is_some() {
            return None;
        }
    }
    Some(map)
}
/// Every picture a HEIC's items decode to, all told (the photo, its HDR gain map and tone map, a
/// portrait's depth and mattes, a thumbnail): three times the limit for the photo alone.
const MAX_HEIC_FILE_PIXELS: u64 = 3 * MAX_IMAGE_PIXELS;
/// The coded and the cropped (shown) size of an HEVC picture, from its sequence parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HevcSize {
    coded: (u64, u64),
    cropped: (u64, u64),
}
/// Reads bits from an HEVC parameter set (its emulation-prevention bytes already removed).
struct Bits<'a> {
    data: &'a [u8],
    at: usize,
}
impl Bits<'_> {
    fn bit(&mut self) -> Option<u64> {
        let byte = *self.data.get(self.at / 8)?;
        let bit = (byte >> (7 - self.at % 8)) & 1;
        self.at += 1;
        Some(u64::from(bit))
    }
    fn bits(&mut self, count: u32) -> Option<u64> {
        (0..count).try_fold(0u64, |value, _| Some((value << 1) | self.bit()?))
    }
    fn skip(&mut self, count: usize) -> Option<()> {
        self.at = self.at.checked_add(count)?;
        (self.at <= self.data.len().checked_mul(8)?).then_some(())
    }
    /// An unsigned exponential-Golomb number, refused past 32 leading zeros.
    fn ue(&mut self) -> Option<u64> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 32 {
                return None;
            }
        }
        Some((1u64 << zeros) - 1 + self.bits(zeros)?)
    }
}
/// The size an HEVC picture is coded at and shown at, from the one sequence parameter set (NAL unit
/// type 33) in its `hvcC` configuration (ISO/IEC 14496-15), read only as far as the conformance
/// window (ITU-T H.265 7.3.2.2). None when there is no such set, more than one, or it doesn't parse.
fn hevc_size(hvcc: &[u8]) -> Option<HevcSize> {
    if *hvcc.first()? != 1 {
        return None;
    }
    // Apple's decoder reads every parameter set in the configuration by its own NAL unit header,
    // not by the label of the array it is in (review G, L-1: a small SPS in the SPS array beside a
    // big SPS in the PPS or SEI array). So: arrays only of VPS (32), SPS (33), PPS (34) and SEI
    // (39, 40); every unit of the type its array says, of layer 0 and a valid temporal id (0 for a
    // parameter set); one SPS, at most one VPS, eight PPS and eight SEI, none over 1,024 bytes.
    let arrays = *hvcc.get(22)?;
    let mut at = 23usize;
    let mut sps: Option<&[u8]> = None;
    let mut counts = [0usize; 64];
    for _ in 0..arrays {
        let nal_type = *hvcc.get(at)? & 0x3F;
        if !matches!(nal_type, 32 | 33 | 34 | 39 | 40) {
            return None;
        }
        let count = u16::from_be_bytes(hvcc.get(at + 1..at + 3)?.try_into().ok()?);
        at += 3;
        for _ in 0..count {
            let length = usize::from(u16::from_be_bytes(hvcc.get(at..at + 2)?.try_into().ok()?));
            let unit = hvcc.get(at + 2..at.checked_add(2 + length)?)?;
            at += 2 + length;
            let header = unit.get(..2)?;
            let own_type = (header[0] >> 1) & 0x3F;
            let layer = ((header[0] & 1) << 5) | (header[1] >> 3);
            let temporal = header[1] & 7;
            let parameter_set = nal_type != 39 && nal_type != 40;
            if header[0] & 0x80 != 0
                || own_type != nal_type
                || layer != 0
                || temporal == 0
                || (parameter_set && temporal != 1)
                || length > 1024
            {
                return None;
            }
            counts[usize::from(nal_type)] += 1;
            if nal_type == 33 {
                sps = Some(unit);
            }
        }
    }
    if counts[33] != 1 || counts[32] > 1 || counts[34] > 8 || counts[39] + counts[40] > 8 {
        return None;
    }
    let unit = sps?;
    // The NAL unit header (two bytes, type 33), then the payload without emulation-prevention bytes.
    if (unit.get(..2)?[0] >> 1) & 0x3F != 33 {
        return None;
    }
    let mut payload = Vec::with_capacity(unit.len());
    let mut zeros = 0;
    for &byte in &unit[2..] {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        payload.push(byte);
    }
    let mut bits = Bits {
        data: &payload,
        at: 0,
    };
    // sps_video_parameter_set_id, sps_max_sub_layers_minus1, sps_temporal_id_nesting_flag.
    bits.skip(4)?;
    let sub_layers = usize::try_from(bits.bits(3)?).ok()?;
    bits.skip(1)?;
    // profile_tier_level(1, sub_layers): the general profile (88 bits) and level (8), each sub-layer's
    // two present flags, padding to eight, then each present sub-layer profile (88) and level (8).
    bits.skip(96)?;
    let mut present = Vec::with_capacity(sub_layers);
    for _ in 0..sub_layers {
        present.push((bits.bit()? == 1, bits.bit()? == 1));
    }
    if sub_layers > 0 {
        bits.skip(2 * (8 - sub_layers))?;
    }
    for (profile, level) in present {
        if profile {
            bits.skip(88)?;
        }
        if level {
            bits.skip(8)?;
        }
    }
    let _sps_id = bits.ue()?;
    let chroma = bits.ue()?;
    let separate_planes = match chroma {
        0..=2 => false,
        3 => bits.bit()? == 1,
        _ => return None,
    };
    let width = bits.ue()?;
    let height = bits.ue()?;
    if width == 0 || height == 0 {
        return None;
    }
    // The conformance window, in chroma samples (H.265 Table 6-1: SubWidthC, SubHeightC).
    let (sub_w, sub_h) = match (chroma, separate_planes) {
        (1, _) => (2, 2),
        (2, _) => (2, 1),
        _ => (1, 1),
    };
    let (mut crop_w, mut crop_h) = (0u64, 0u64);
    if bits.bit()? == 1 {
        crop_w = bits.ue()?.checked_add(bits.ue()?)?.checked_mul(sub_w)?;
        crop_h = bits.ue()?.checked_add(bits.ue()?)?.checked_mul(sub_h)?;
    }
    Some(HevcSize {
        coded: (width, height),
        cropped: (width.checked_sub(crop_w)?, height.checked_sub(crop_h)?),
    })
    .filter(|s| s.cropped.0 > 0 && s.cropped.1 > 0)
}
/// Whether a HEIC's grid (the photo, or any other picture in the file) is what it says: tiles that
/// are all HEVC pictures of one size, coded at one size, at most MAX_HEIC_ITEMS of them, each named
/// once in the grid's one `dimg` reference; and the grid's own description (rows, columns and output
/// size, read from the grid item's data) matching them. The tiles must cover the output with less
/// than one tile to spare each way, so what is decoded is the picture and at most a tile's border
/// around it, and never more than twice MAX_IMAGE_PIXELS (review of 960b1010: one tile named 65,025
/// times, or tiles far larger than the output, were the same half-minute, 650 MB decode the item
/// limit stopped). Gives back the pixels its tiles decode to, as coded, and the tiles it names.
#[allow(clippy::too_many_arguments)]
fn heic_grid_fits<'a>(
    image: &[u8],
    children: &[([u8; 4], &[u8])],
    refs: &HeicReferences,
    grid_id: u32,
    (width, height): (u64, u64),
    type_of: &dyn Fn(u32) -> Option<&'a [u8]>,
    size_of: &dyn Fn(u32) -> Option<(u64, u64)>,
    coded_of: &dyn Fn(u32) -> Option<(u64, u64)>,
) -> Option<(u64, Vec<u32>)> {
    let child = |name: &[u8; 4]| children.iter().find(|(k, _)| k == name).map(|(_, b)| *b);
    let u16_at = |b: &[u8], at: usize| -> Option<u64> {
        Some(u64::from(u16::from_be_bytes(
            b.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let u32_at = |b: &[u8], at: usize| -> Option<u64> {
        Some(u64::from(u32::from_be_bytes(
            b.get(at..at + 4)?.try_into().ok()?,
        )))
    };
    let u64_at = |b: &[u8], at: usize| -> Option<u64> {
        Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
    };
    let uint = |b: &[u8], at: usize, size: usize| -> Option<u64> {
        match size {
            0 => Some(0),
            4 => u32_at(b, at),
            8 => u64_at(b, at),
            _ => None,
        }
    };
    // The tiles: exactly one `dimg` reference from the grid, naming each tile once.
    let named = refs.get(&(*b"dimg", grid_id))?.clone();
    let count = named.len();
    if count == 0 || count > MAX_HEIC_ITEMS {
        return None;
    }
    let mut ids = named.clone();
    // Each an HEVC picture with its own size, all the same and none empty, all coded alike.
    let (tile_w, tile_h) = size_of(ids[0])?;
    if tile_w == 0 || tile_h == 0 {
        return None;
    }
    let (coded_w, coded_h) = coded_of(ids[0])?;
    for &id in &ids {
        if type_of(id)? != b"hvc1"
            || size_of(id)? != (tile_w, tile_h)
            || coded_of(id)? != (coded_w, coded_h)
        {
            return None;
        }
    }
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    // The grid's description, from its item's data: in this file (`mdat`, construction method 0) or
    // in the meta box (`idat`, method 1), as `iloc` says; one extent, nowhere else.
    let iloc = child(b"iloc")?;
    let version = *iloc.first()?;
    if version > 2 {
        return None;
    }
    let sizes = |byte: u8| -> Option<(usize, usize)> {
        let (high, low) = (usize::from(byte >> 4), usize::from(byte & 0xF));
        matches!(high, 0 | 4 | 8).then_some(())?;
        Some((high, low))
    };
    let (offset_size, length_size) = sizes(*iloc.get(4)?)?;
    let (base_size, index_size) = sizes(*iloc.get(5)?)?;
    let index_size = if version == 0 { 0 } else { index_size };
    if !matches!(length_size, 0 | 4 | 8) || !matches!(index_size, 0 | 4 | 8) {
        return None;
    }
    let (entries, mut at) = if version < 2 {
        (u16_at(iloc, 6)?, 8)
    } else {
        (u32_at(iloc, 6)?, 10)
    };
    if usize::try_from(entries).ok()? > MAX_HEIC_ITEMS {
        return None;
    }
    let item_len = if version < 2 { 2 } else { 4 };
    let mut found = None;
    for _ in 0..entries {
        let id = if item_len == 2 {
            u16_at(iloc, at)?
        } else {
            u32_at(iloc, at)?
        };
        at += item_len;
        let method = if version >= 1 {
            let method = u16_at(iloc, at)? & 0xF;
            at += 2;
            method
        } else {
            0
        };
        let data_reference = u16_at(iloc, at)?;
        at += 2;
        let base = uint(iloc, at, base_size)?;
        at += base_size;
        let extents = usize::try_from(u16_at(iloc, at)?).ok()?;
        at += 2;
        let extent_len = index_size + offset_size + length_size;
        if id == u64::from(grid_id) {
            if found.is_some() || data_reference != 0 || extents != 1 {
                return None;
            }
            let offset = uint(iloc, at + index_size, offset_size)?;
            let length = uint(iloc, at + index_size + offset_size, length_size)?;
            found = Some((method, base.checked_add(offset)?, length));
        }
        at = at.checked_add(extents.checked_mul(extent_len)?)?;
        iloc.get(..at)?;
    }
    let (method, start, length) = found?;
    let source = match method {
        0 => image,
        1 => child(b"idat")?,
        _ => return None,
    };
    let start = usize::try_from(start).ok()?;
    let end = start.checked_add(usize::try_from(length).ok()?)?;
    let grid = source.get(start..end)?;
    // ISO/IEC 23008-12 ImageGrid: version 0, flags (bit 0: 32-bit sizes), rows and columns less one,
    // the output width and height.
    if *grid.first()? != 0 {
        return None;
    }
    let (rows, columns) = (u64::from(*grid.get(2)?) + 1, u64::from(*grid.get(3)?) + 1);
    let (out_w, out_h) = if grid.get(1)? & 1 == 1 {
        (u32_at(grid, 4)?, u32_at(grid, 8)?)
    } else {
        (u16_at(grid, 4)?, u16_at(grid, 6)?)
    };
    if rows * columns != count as u64 || (out_w, out_h) != (width, height) {
        return None;
    }
    // The tiles cover the output, with less than one tile to spare each way.
    let canvas_w = tile_w.checked_mul(columns)?;
    let canvas_h = tile_h.checked_mul(rows)?;
    if canvas_w < out_w
        || canvas_h < out_h
        || canvas_w - tile_w >= out_w
        || canvas_h - tile_h >= out_h
    {
        return None;
    }
    // What the tiles decode to, as coded, is at most a quarter more than the picture (Apple's grids
    // spare 1 to 5 per cent), 4 megapixels besides (a small picture in a few large tiles), and one row
    // and one column of tiles of at most 512 (review G, L-4: a long, thin strip such as 16,000 by
    // 100 spares most of its one row of 512 tiles), and never twice the pixel limit: two 8192 by
    // 4320 tiles over a picture of 8193 by 4320 took the reader 2.9 s and 630 MB.
    let decoded = coded_w
        .checked_mul(coded_h)?
        .checked_mul(u64::try_from(count).ok()?)?;
    let output = out_w.checked_mul(out_h)?;
    let row_and_column = coded_h
        .min(512)
        .checked_mul(coded_w.checked_mul(columns)?)?
        .checked_add(coded_w.min(512).checked_mul(coded_h.checked_mul(rows)?)?)?;
    let allowed = output
        .checked_add(output / 4)?
        .checked_add(1 << 22)?
        .checked_add(row_and_column)?;
    if decoded > allowed || canvas_w.checked_mul(canvas_h)? > 2 * MAX_IMAGE_PIXELS {
        return None;
    }
    Some((decoded, named))
}
/// The three kinds of photo the card reader opens (helpers/card-reader.swift: public.png,
/// public.jpeg, and public.heic or public.heif), told apart by their bytes, never by a file name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardImageKind {
    Png,
    Jpeg,
    Heic,
}
/// Why a photo isn't one the card reader opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardImageProblem {
    /// Not a PNG, JPEG or HEIC by its bytes, outside the review's size limit, or declaring no size.
    NotAPhoto,
    /// A picture of more than MAX_IMAGE_PIXELS, such as a 48-megapixel iPhone photo (review Z, I3).
    TooManyPixels,
}
/// PNG, JPEG or HEIC within the review's size limit, checked before any process starts: by
/// signature (a HEIC by its file type box and primary picture), and by the picture size its header
/// declares (never zero, at most MAX_IMAGE_PIXELS).
pub fn card_image_check(image: &[u8]) -> Result<CardImageKind, CardImageProblem> {
    if image.is_empty() || image.len() > MAX_IMAGE_BYTES {
        return Err(CardImageProblem::NotAPhoto);
    }
    let size = if let Some(size) = png_size(image) {
        Some((CardImageKind::Png, size))
    } else if image.starts_with(&[0xFF, 0xD8]) {
        jpeg_size(image).map(|size| (CardImageKind::Jpeg, size))
    } else {
        heic_size(image).map(|size| (CardImageKind::Heic, size))
    };
    match size {
        Some((kind, (width, height))) if width > 0 && height > 0 => {
            if width.saturating_mul(height) <= MAX_IMAGE_PIXELS {
                Ok(kind)
            } else {
                Err(CardImageProblem::TooManyPixels)
            }
        }
        _ => Err(CardImageProblem::NotAPhoto),
    }
}
/// The kind alone, for tests.
#[cfg(test)]
pub fn card_image_kind(image: &[u8]) -> Option<CardImageKind> {
    card_image_check(image).ok()
}
#[cfg(test)]
pub fn card_image_ok(image: &[u8]) -> bool {
    card_image_kind(image).is_some()
}
impl From<CardImageProblem> for LocalToolError {
    fn from(problem: CardImageProblem) -> Self {
        match problem {
            CardImageProblem::NotAPhoto => LocalToolError::InvalidInput,
            CardImageProblem::TooManyPixels => LocalToolError::TooManyPixels,
        }
    }
}
/// The policy a card of `kind` is read under: Apple's video decoder service only for a HEIC.
pub fn reading_policy(kind: CardImageKind) -> &'static str {
    match kind {
        CardImageKind::Png | CardImageKind::Jpeg => CARD_READER_POLICY,
        CardImageKind::Heic => CARD_HEIC_READER_POLICY,
    }
}

/// What reads card text on this Mac, decided once per launch by `Cards::recognizer`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Recognizer {
    Vision(CardReader),
    Tesseract,
    None,
}

/// One card at a time. The image goes to the recognizer on stdin and its text comes back on
/// stdout. `cancel` (the review closed, or Ozzie is quitting) kills the reading in progress.
#[derive(Default)]
pub struct Cards {
    busy: AtomicBool,
    generation: AtomicU64,
    /// Unset until decided; then what reads cards for the rest of this launch.
    recognizer: Mutex<Option<Recognizer>>,
    /// Ozzie is quitting: stop preparing too.
    closing: AtomicBool,
}
struct Reading<'a>(&'a AtomicBool);
impl Drop for Reading<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Cards {
    /// Ozzie's Vision reader once it has been prepared on the practice picture, otherwise a
    /// Tesseract if one is installed, otherwise nothing. Callers wait while another call prepares.
    /// A preparation cut short (too slow, or Ozzie quitting) is tried again next time; one that
    /// fails leaves the Vision reader out until Ozzie is opened again.
    fn recognizer(&self) -> Recognizer {
        let mut decided = self.recognizer.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(recognizer) = decided.as_ref() {
            return recognizer.clone();
        }
        if !Path::new(SANDBOX).is_file() {
            *decided = Some(Recognizer::None);
            return Recognizer::None;
        }
        let mut again = false;
        if let Some(reader) = CardReader::find() {
            match self.prepare_reader(&reader) {
                Ok(()) => {
                    *decided = Some(Recognizer::Vision(reader.clone()));
                    return Recognizer::Vision(reader);
                }
                Err(LocalToolError::Timeout | LocalToolError::Cancelled) => again = true,
                Err(_) => {}
            }
        }
        let fallback = if Path::new(TESSERACT).is_file() {
            Recognizer::Tesseract
        } else {
            Recognizer::None
        };
        if !again {
            *decided = Some(fallback.clone());
        }
        fallback
    }
    /// Reads the practice picture under CARD_PREPARE_POLICY, the only run that may write Apple's
    /// compiled models. It carries no card, so nothing from a card can reach those folders.
    fn prepare_reader(&self, reader: &CardReader) -> Result<(), LocalToolError> {
        for folder in [&reader.model_cache, &reader.metal_cache] {
            std::fs::create_dir_all(folder).map_err(|_| LocalToolError::Unavailable)?;
        }
        let closing = || self.closing.load(Ordering::SeqCst);
        let out = run_bounded(
            reader.command(CARD_PREPARE_POLICY),
            PRACTICE_PICTURE.to_vec(),
            PREPARE_TIMEOUT,
            MAX_PIECES_BYTES,
            &closing,
        )?;
        // The practice picture has words on it: reading none means the recognizer can't work here.
        if card_lines(&out)?.text.is_empty() {
            return Err(LocalToolError::Failed);
        }
        Ok(())
    }
    /// The Visitor cards page opened: get the reader ready before the first card.
    pub fn prepare(&self) -> CardReaderStatus {
        match self.recognizer() {
            Recognizer::None => CardReaderStatus::NotAvailable,
            _ => CardReaderStatus::Ready,
        }
    }
    pub fn read(&self, image: Vec<u8>) -> Result<CardText, LocalToolError> {
        let kind = card_image_check(&image).map_err(LocalToolError::from)?;
        // A review that closes while the reader is still being prepared drops this card.
        let since = self.generation.load(Ordering::SeqCst);
        match self.recognizer() {
            Recognizer::Vision(reader) => {
                let out = self.read_with(
                    reader.command(reading_policy(kind)),
                    image,
                    RECOGNITION_TIMEOUT,
                    MAX_PIECES_BYTES,
                    since,
                )?;
                let CardLines { text, unclear } = card_lines(&out)?;
                Ok(CardText::Read {
                    text,
                    unclear_lines: unclear,
                })
            }
            Recognizer::Tesseract => {
                let out = self.read_with(
                    sandboxed(TESSERACT_POLICY, "C", &[TESSERACT, "stdin", "stdout"]),
                    image,
                    RECOGNITION_TIMEOUT,
                    MAX_TEXT_BYTES,
                    since,
                )?;
                // Tesseract's plain text carries no confidence, so nothing it reads can be called clear: every line is
                // reported unclear and each suggestion is shown only for the person to check against the card.
                let text = String::from_utf8_lossy(&out).into_owned();
                let unclear_lines = (0..text.lines().count()).collect();
                Ok(CardText::Read {
                    text,
                    unclear_lines,
                })
            }
            Recognizer::None => Ok(CardText::NotAvailable),
        }
    }
    /// Runs one reading of `image`, unless the review closed after `since`.
    fn read_with(
        &self,
        command: Command,
        image: Vec<u8>,
        timeout: Duration,
        max_out: usize,
        since: u64,
    ) -> Result<Vec<u8>, LocalToolError> {
        // A cancelled reading ends within a few milliseconds, so the next review's first card
        // waits briefly for it instead of failing.
        let waited = Instant::now();
        while self.busy.swap(true, Ordering::SeqCst) {
            if waited.elapsed() > Duration::from_secs(1) {
                return Err(LocalToolError::Busy);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _reading = Reading(&self.busy);
        let cancelled = || self.generation.load(Ordering::SeqCst) != since;
        if cancelled() {
            return Err(LocalToolError::Cancelled);
        }
        let out = run_bounded(command, image, timeout, max_out, &cancelled)?;
        if cancelled() {
            return Err(LocalToolError::Cancelled);
        }
        Ok(out)
    }
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.cancel();
    }
}

/// Whether Ozzie can listen for a spoken question. Checking never asks the person anything.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum VoiceStatus {
    /// Ozzie can listen (macOS asks for permission the first time).
    Ready,
    /// This Mac can't recognize speech on the device, or Ozzie's listener isn't here.
    NotAvailable,
    /// The microphone or speech recognition is turned off for Ozzie in System Settings.
    NoPermission { what: Permission },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    Microphone,
    Speech,
}

/// How one listening ended.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Listened {
    /// Everything heard, possibly nothing, for the person to check in the Ask box.
    Heard {
        text: String,
    },
    /// Cancelled (Ask closed, or Ozzie quitting): whatever was heard was thrown away.
    Stopped,
    NotAvailable,
    NoPermission {
        what: Permission,
    },
    NoMicrophone,
}

/// The listener's `--check` report: no permission is asked for. Unreadable output is "not available".
pub fn voice_status(out: &[u8]) -> VoiceStatus {
    #[derive(serde::Deserialize)]
    struct Check {
        #[serde(rename = "onDevice")]
        on_device: bool,
        speech: String,
        microphone: String,
    }
    let Ok(check) = serde_json::from_slice::<Check>(out.trim_ascii()) else {
        return VoiceStatus::NotAvailable;
    };
    let refused = |answer: &str| matches!(answer, "denied" | "restricted");
    if !check.on_device {
        VoiceStatus::NotAvailable
    } else if refused(&check.microphone) {
        VoiceStatus::NoPermission {
            what: Permission::Microphone,
        }
    } else if refused(&check.speech) {
        VoiceStatus::NoPermission {
            what: Permission::Speech,
        }
    } else {
        VoiceStatus::Ready
    }
}

/// One line from the listener: words so far, all the words, or how it stopped.
#[derive(Debug, PartialEq, serde::Deserialize)]
#[serde(untagged)]
enum ListenerLine {
    Final {
        r#final: String,
    },
    Words {
        text: String,
    },
    Status {
        status: String,
        what: Option<Permission>,
    },
}

/// The listener stops listening by itself after 30 seconds; this also covers the time macOS's
/// permission questions stay open the first time.
const LISTEN_LIMIT: Duration = Duration::from_secs(150);
/// The listener's lines: words so far (at most 4 KB of text each), repeated as they grow.
const MAX_LISTENER_LINE: usize = 16 * 1024;
const MAX_LISTENER_OUTPUT: u64 = 4 * 1024 * 1024;

fn listener_command(helper: &Path, args: &[&str]) -> Command {
    sandboxed_helper(
        LISTEN_POLICY,
        "en_US.UTF-8",
        &[("HELPER", helper)],
        helper,
        args,
        home().as_deref(),
    )
}

/// One listening at a time. Stop (the person is done) closes the listener's stdin so it finishes
/// the last words; cancel (Ask closed, Ozzie quitting) kills it and drops what it heard.
#[derive(Default)]
pub struct Voice {
    current: Mutex<Option<(u64, Child, Option<ChildStdin>)>>,
    generation: AtomicU64,
}
impl Voice {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(u64, Child, Option<ChildStdin>)>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn check(&self) -> VoiceStatus {
        let Some(helper) = helper(LISTENER).filter(|_| Path::new(SANDBOX).is_file()) else {
            return VoiceStatus::NotAvailable;
        };
        let never = || false;
        match run_bounded(
            listener_command(&helper, &["--check"]),
            Vec::new(),
            Duration::from_secs(10),
            4096,
            &never,
        ) {
            Ok(out) => voice_status(&out),
            Err(_) => VoiceStatus::NotAvailable,
        }
    }
    pub fn listen(&self, on_words: impl Fn(String)) -> Result<Listened, LocalToolError> {
        let Some(helper) = helper(LISTENER).filter(|_| Path::new(SANDBOX).is_file()) else {
            return Ok(Listened::NotAvailable);
        };
        self.listen_with(listener_command(&helper, &[]), LISTEN_LIMIT, on_words)
    }
    fn listen_with(
        &self,
        mut command: Command,
        limit: Duration,
        on_words: impl Fn(String),
    ) -> Result<Listened, LocalToolError> {
        command.stdout(Stdio::piped());
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let stdout = {
            let mut current = self.lock();
            if let Some((_, mut previous, _)) = current.take() {
                let _ = previous.kill();
                let _ = previous.wait();
            }
            let mut child = command.spawn().map_err(|_| LocalToolError::Unavailable)?;
            let stdin = child.stdin.take();
            let Some(stdout) = child.stdout.take() else {
                let _ = child.kill();
                let _ = child.wait();
                return Err(LocalToolError::Failed);
            };
            *current = Some((generation, child, stdin));
            stdout
        };
        let (sent, received) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout.take(MAX_LISTENER_OUTPUT));
            loop {
                let mut line = Vec::new();
                match (&mut lines)
                    .take(MAX_LISTENER_LINE as u64 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) if sent.send(line).is_ok() => {}
                    Ok(_) => break,
                }
            }
        });
        let deadline = Instant::now() + limit;
        let mut ended: Option<Result<Listened, LocalToolError>> = None;
        // Reaps this listening's helper (unless a newer listening has replaced it).
        let end = |result| {
            let mine = self.lock().take_if(|(owner, _, _)| *owner == generation);
            if let Some((_, mut child, _)) = mine {
                let _ = child.kill();
                let _ = child.wait();
            }
            result
        };
        loop {
            if self.generation.load(Ordering::SeqCst) != generation {
                return end(Ok(Listened::Stopped));
            }
            match received.recv_timeout(Duration::from_millis(50)) {
                Ok(line) if line.len() > MAX_LISTENER_LINE => {
                    return end(Err(LocalToolError::TooMuchText));
                }
                Ok(line) => match serde_json::from_slice::<ListenerLine>(line.trim_ascii()) {
                    Ok(ListenerLine::Words { text }) if ended.is_none() => on_words(text),
                    Ok(ListenerLine::Words { .. }) => {}
                    Ok(ListenerLine::Final { r#final }) => {
                        ended.get_or_insert(Ok(Listened::Heard { text: r#final }));
                    }
                    Ok(ListenerLine::Status { status, what }) => match (status.as_str(), what) {
                        ("listening", _) => {}
                        ("not-available", _) => {
                            ended.get_or_insert(Ok(Listened::NotAvailable));
                        }
                        ("no-microphone", _) => {
                            ended.get_or_insert(Ok(Listened::NoMicrophone));
                        }
                        ("no-permission", Some(what)) => {
                            ended.get_or_insert(Ok(Listened::NoPermission { what }));
                        }
                        _ => {
                            ended.get_or_insert(Err(LocalToolError::Failed));
                        }
                    },
                    Err(_) => return end(Err(LocalToolError::Failed)),
                },
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(mpsc::RecvTimeoutError::Timeout) => return end(Err(LocalToolError::Timeout)),
                // The listener closed its output: it has finished.
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if self.generation.load(Ordering::SeqCst) != generation {
            return end(Ok(Listened::Stopped));
        }
        end(ended.unwrap_or(Err(LocalToolError::Failed)))
    }
    /// The person is done speaking: the listener stops the microphone and sends the last words.
    pub fn stop(&self) {
        if let Some((_, _, stdin)) = self.lock().as_mut() {
            stdin.take();
        }
    }
    /// Ask closed or Ozzie is quitting: stop now and keep nothing.
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some((_, mut child, _)) = self.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
pub struct LocalTools {
    speech: Arc<Speech>,
    cards: Arc<Cards>,
    voice: Arc<Voice>,
}
impl LocalTools {
    /// App exit: no briefing keeps talking, no card keeps being read and nothing keeps listening
    /// after Ozzie closes.
    pub fn stop(&self) {
        self.speech.stop();
        self.cards.close();
        self.voice.cancel();
    }
}

#[tauri::command]
pub async fn speak_briefing(
    text: String,
    tools: tauri::State<'_, LocalTools>,
) -> Result<Playback, LocalToolError> {
    let speech = tools.speech.clone();
    tauri::async_runtime::spawn_blocking(move || speech.speak(&text))
        .await
        .map_err(|_| LocalToolError::Failed)?
}

#[tauri::command]
pub fn stop_briefing(tools: tauri::State<'_, LocalTools>) {
    tools.speech.stop();
}

/// The Visitor cards page opened: prepare the reader (a minute or two the first time on a Mac).
#[tauri::command]
pub async fn prepare_card_reader(
    tools: tauri::State<'_, LocalTools>,
) -> Result<CardReaderStatus, LocalToolError> {
    let cards = tools.cards.clone();
    tauri::async_runtime::spawn_blocking(move || cards.prepare())
        .await
        .map_err(|_| LocalToolError::Failed)
}

/// The review closed (finished, discarded, interrupted or left): stop any card being read.
#[tauri::command]
pub fn cancel_card_reading(tools: tauri::State<'_, LocalTools>) {
    tools.cards.cancel();
}

/// The webview sends the image as a raw binary body (no JSON copy of the bytes).
#[tauri::command]
pub async fn read_card_text(
    request: tauri::ipc::Request<'_>,
    tools: tauri::State<'_, LocalTools>,
) -> Result<CardText, LocalToolError> {
    let tauri::ipc::InvokeBody::Raw(image) = request.body() else {
        return Err(LocalToolError::InvalidInput);
    };
    // Checked once, in `Cards::read`, off the async runtime: the check of a crafted file was
    // seconds (review G, L-2).
    let image = image.clone();
    let cards = tools.cards.clone();
    tauri::async_runtime::spawn_blocking(move || cards.read(image))
        .await
        .map_err(|_| LocalToolError::Failed)?
}

/// Ask opened: can Ozzie listen here? Never asks the person for anything.
#[tauri::command]
pub async fn voice_status_check(
    tools: tauri::State<'_, LocalTools>,
) -> Result<VoiceStatus, LocalToolError> {
    let voice = tools.voice.clone();
    tauri::async_runtime::spawn_blocking(move || voice.check())
        .await
        .map_err(|_| LocalToolError::Failed)
}

/// The microphone button in Ask: listens on this Mac and sends the words so far on `on_words`.
/// The words only fill the Ask box; the person checks them and presses Ask themselves.
#[tauri::command]
pub async fn listen_for_question(
    on_words: tauri::ipc::Channel<String>,
    tools: tauri::State<'_, LocalTools>,
) -> Result<Listened, LocalToolError> {
    let voice = tools.voice.clone();
    tauri::async_runtime::spawn_blocking(move || {
        voice.listen(|words| {
            let _ = on_words.send(words);
        })
    })
    .await
    .map_err(|_| LocalToolError::Failed)?
}

/// The person pressed the microphone button again: finish with what was said.
#[tauri::command]
pub fn stop_listening(tools: tauri::State<'_, LocalTools>) {
    tools.voice.stop();
}

/// Ask closed: stop listening and keep nothing.
#[tauri::command]
pub fn cancel_listening(tools: tauri::State<'_, LocalTools>) {
    tools.voice.cancel();
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn plain(argv: &[&str]) -> Command {
        let mut command = Command::new(argv[0]);
        command
            .args(&argv[1..])
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    fn never() -> bool {
        false
    }

    #[test]
    fn both_profiles_deny_by_default_and_allow_no_network_or_writes() {
        for policy in [TESSERACT_POLICY, SAY_POLICY] {
            assert!(policy.starts_with("(version 1)\n(deny default)\n"));
            let rules: Vec<&str> = policy
                .lines()
                .map(str::trim)
                .filter(|l| !l.starts_with(';'))
                .collect();
            let rules = rules.join(" ");
            for forbidden in [
                "allow default",
                "allow network",
                "allow file-write",
                "allow process-fork",
                "allow process*",
                "(subpath \"/Users",
                "(subpath \"/System/Volumes/Data",
                "(subpath \"/private/var/folders",
                "(subpath \"/\")",
            ] {
                assert!(!rules.contains(forbidden), "{forbidden}");
            }
            assert_eq!(rules.matches("(allow process-exec").count(), 1);
        }
        // The recognizer gets no system services at all.
        assert!(!TESSERACT_POLICY.contains("mach-lookup"));
        assert!(SAY_POLICY.contains("(allow process-exec (literal \"/usr/bin/say\"))"));
    }

    #[test]
    fn a_cancelled_reading_is_killed_and_its_text_dropped() {
        let cards = Arc::new(Cards::default());
        let other = cards.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            other.cancel();
        });
        let started = Instant::now();
        let since = cards.generation.load(Ordering::SeqCst);
        assert_eq!(
            cards.read_with(
                plain(&["/bin/sleep", "5"]),
                vec![],
                Duration::from_secs(10),
                64,
                since
            ),
            Err(LocalToolError::Cancelled)
        );
        canceller.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        // The next card isn't refused because of the old one.
        let since = cards.generation.load(Ordering::SeqCst);
        assert_eq!(
            cards.read_with(
                plain(&["/bin/cat"]),
                b"Name: Fictional".to_vec(),
                Duration::from_secs(5),
                64,
                since
            ),
            Ok(b"Name: Fictional".to_vec())
        );
        // A review that closed while the reader was still being prepared never starts its card.
        cards.cancel();
        assert_eq!(
            cards.read_with(
                plain(&["/bin/cat"]),
                b"Name: Fictional".to_vec(),
                Duration::from_secs(5),
                64,
                since
            ),
            Err(LocalToolError::Cancelled)
        );
    }

    #[test]
    fn speech_text_is_bounded_and_plain() {
        assert_eq!(speech_text("Hello.\nSunday."), Ok("Hello.\nSunday.".into()));
        assert_eq!(
            speech_text("[[rate 400]] Quiet\u{7}please"),
            Ok("  rate 400   Quiet please".into())
        );
        assert_eq!(speech_text("   \n "), Err(LocalToolError::InvalidInput));
        // SSML-like markup from a source name never reaches the voice as markup.
        let spoken = speech_text(
            "<speak><prosody rate=\"x-fast\">Greeter</prosody> &amp; <break time=\"9s\"/></speak>",
        )
        .unwrap();
        assert!(!spoken.contains(['<', '>', '&']), "{spoken}");
        assert!(spoken.contains("Greeter"));
        assert_eq!(
            speech_text(&"a".repeat(MAX_SPEECH_CHARS + 1)),
            Err(LocalToolError::InvalidInput)
        );
        assert!(speech_text(&"a".repeat(MAX_SPEECH_CHARS)).is_ok());
    }

    #[test]
    fn playback_finishes_and_a_stop_ends_it_early() {
        let speech = Arc::new(Speech::default());
        assert_eq!(
            speech.play(plain(&["/bin/cat"]), b"done", Duration::from_secs(5)),
            Ok(Playback::Finished)
        );
        let other = speech.clone();
        let started = Instant::now();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            other.stop();
        });
        let result = speech.play(plain(&["/bin/sleep", "5"]), b"", Duration::from_secs(10));
        stopper.join().unwrap();
        assert_eq!(result, Ok(Playback::Stopped));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(speech.lock().is_none());
    }

    #[test]
    fn a_new_playback_stops_the_previous_one() {
        let speech = Arc::new(Speech::default());
        let first = {
            let speech = speech.clone();
            std::thread::spawn(move || {
                speech.play(plain(&["/bin/sleep", "5"]), b"", Duration::from_secs(10))
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        assert_eq!(
            speech.play(plain(&["/bin/cat"]), b"x", Duration::from_secs(5)),
            Ok(Playback::Finished)
        );
        assert_eq!(first.join().unwrap(), Ok(Playback::Stopped));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn playback_is_cut_off_at_its_limit() {
        let speech = Speech::default();
        let started = Instant::now();
        assert_eq!(
            speech.play(plain(&["/bin/sleep", "5"]), b"", Duration::from_millis(200)),
            Ok(Playback::Stopped)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn bounded_run_returns_stdout_and_refuses_failures() {
        assert_eq!(
            run_bounded(
                plain(&["/bin/cat"]),
                b"line one\nline two".to_vec(),
                Duration::from_secs(5),
                64,
                &never
            ),
            Ok(b"line one\nline two".to_vec())
        );
        // A large input is streamed while output is read, so the pipes never deadlock.
        let big = vec![b'x'; 2 * 1024 * 1024];
        assert_eq!(
            run_bounded(
                plain(&["/bin/cat"]),
                big.clone(),
                Duration::from_secs(10),
                big.len(),
                &never
            ),
            Ok(big)
        );
        assert_eq!(
            run_bounded(
                plain(&["/usr/bin/false"]),
                vec![],
                Duration::from_secs(5),
                64,
                &never
            ),
            Err(LocalToolError::Failed)
        );
        assert_eq!(
            run_bounded(
                plain(&["/no/such/tool"]),
                vec![],
                Duration::from_secs(5),
                64,
                &never
            ),
            Err(LocalToolError::Unavailable)
        );
    }

    #[test]
    fn bounded_run_kills_on_timeout_and_on_too_much_output() {
        let started = Instant::now();
        assert_eq!(
            run_bounded(
                plain(&["/bin/sleep", "5"]),
                vec![],
                Duration::from_millis(200),
                64,
                &never
            ),
            Err(LocalToolError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let started = Instant::now();
        assert_eq!(
            run_bounded(
                plain(&["/usr/bin/yes"]),
                vec![],
                Duration::from_secs(5),
                1024,
                &never
            ),
            Err(LocalToolError::TooMuchText)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            run_bounded(
                plain(&["/bin/cat"]),
                vec![b'x'; 65],
                Duration::from_secs(5),
                64,
                &never
            ),
            Err(LocalToolError::TooMuchText)
        );
    }

    /// A PNG's signature and IHDR chunk declaring `width` x `height`.
    pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }
    /// A JPEG with an APP0 segment, then a baseline frame declaring `width` x `height`.
    pub(crate) fn jpeg(marker: u8, width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        bytes.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        bytes.extend_from_slice(&[0xFF, marker, 0x00, 0x11, 8]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        bytes.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
        bytes
    }

    #[test]
    fn only_bounded_png_or_jpeg_reaches_the_recognizer() {
        assert!(card_image_ok(&png(1200, 800)));
        assert!(card_image_ok(&jpeg(0xC0, 4032, 3024)));
        assert!(card_image_ok(&jpeg(0xC2, 1200, 800)));
        assert!(!card_image_ok(&[]));
        assert!(!card_image_ok(b"GIF89a"));
        assert!(!card_image_ok(b"<svg></svg>"));
        // A signature alone, or a header that declares no size, is not a picture to decode.
        assert!(!card_image_ok(&[137, 80, 78, 71, 13, 10, 26, 10, 0]));
        assert!(!card_image_ok(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(!card_image_ok(&png(0, 800)));
        assert!(!card_image_ok(&jpeg(0xC0, 1200, 0)));
        let mut scan_first = jpeg(0xC0, 1200, 800);
        scan_first.splice(2..2, [0xFF, 0xDA, 0x00, 0x02]);
        assert!(!card_image_ok(&scan_first));
        let truncated = jpeg(0xC0, 1200, 800);
        assert!(!card_image_ok(&truncated[..24]));
        // A small file declaring a huge picture is refused before the recognizer runs.
        assert!(card_image_ok(&png(8000, 5000)));
        assert!(!card_image_ok(&png(8000, 5001)));
        assert!(!card_image_ok(&png(u32::MAX, u32::MAX)));
        assert!(!card_image_ok(&jpeg(0xC0, 65_535, 65_535)));
        let mut huge = png(1200, 800);
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(!card_image_ok(&huge));
        assert_eq!(
            Cards::default().read(b"not an image".to_vec()),
            Err(LocalToolError::InvalidInput)
        );
    }

    #[test]
    fn a_card_photo_kind_comes_from_its_bytes() {
        assert_eq!(card_image_kind(&png(1200, 800)), Some(CardImageKind::Png));
        assert_eq!(
            card_image_kind(&jpeg(0xC0, 4032, 3024)),
            Some(CardImageKind::Jpeg)
        );
        // A PNG signature with a broken header is not read again as a JPEG.
        assert_eq!(card_image_kind(&png(0, 800)), None);
        assert_eq!(card_image_kind(b"GIF89a"), None);
        assert_eq!(card_image_kind(&png(8000, 5001)), None);
    }

    #[test]
    fn a_second_card_waits_its_turn() {
        let cards = Cards::default();
        cards.busy.store(true, Ordering::SeqCst);
        let started = Instant::now();
        assert_eq!(
            cards.read_with(plain(&["/bin/cat"]), vec![], Duration::from_secs(5), 64, 0),
            Err(LocalToolError::Busy)
        );
        assert!(started.elapsed() >= Duration::from_secs(1));
    }

    /// Manual (plays a few words aloud): `cargo test speaks_ -- --ignored`.
    /// Exercises SAY_POLICY with the real voice.
    #[test]
    #[ignore]
    fn speaks_a_short_phrase_with_the_macs_voice() {
        let started = Instant::now();
        assert_eq!(
            Speech::default().speak("Here is today's briefing."),
            Ok(Playback::Finished)
        );
        // A blocked voice exits in under half a second; real playback of this phrase takes longer.
        assert!(started.elapsed() > Duration::from_millis(1200));
    }

    /// Manual: `OZZIE_SYNTHETIC_CARD=/path/to/fictional-card.png cargo test -- --ignored`.
    /// Runs the installed Tesseract under TESSERACT_POLICY on a generated fictional card. In tests
    /// Ozzie's Vision reader isn't beside the test program, so this is the fallback path.
    #[test]
    #[ignore]
    fn reads_a_synthetic_card_with_the_installed_recognizer() {
        let path = std::env::var("OZZIE_SYNTHETIC_CARD").expect("OZZIE_SYNTHETIC_CARD");
        let image = std::fs::read(path).unwrap();
        match Cards::default().read(image).unwrap() {
            CardText::Read { text, .. } => assert!(text.contains("Name:")),
            CardText::NotAvailable => panic!("recognizer not installed"),
        }
    }

    #[test]
    fn the_card_reader_never_writes_and_only_preparing_writes_the_model_caches() {
        let rules = |policy: &str| {
            policy
                .lines()
                .map(str::trim)
                .filter(|l| !l.starts_with(';'))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let reading = rules(CARD_READER_POLICY);
        assert!(CARD_READER_POLICY.starts_with("(version 1)\n(deny default)\n"));
        for forbidden in [
            "allow default",
            "network",
            "file-write",
            "file-issue-extension",
            "allow process-fork",
            "allow process*",
            "(subpath \"/Users",
            "(subpath \"/System\")",
            "(subpath \"/System/Volumes/Data",
            "(subpath \"/private",
            "(subpath \"/\")",
            "(param \"HOME\")",
        ] {
            assert!(!reading.contains(forbidden), "{forbidden}");
        }
        assert_eq!(reading.matches("(allow process-exec").count(), 1);
        assert!(reading.contains("(allow process-exec (literal (param \"HELPER\")))"));
        // Preparing is the shared rules plus writing the two model caches, and nothing else; it
        // never gets the video decoder service, which only reading a HEIC card needs.
        let shared = card_reader_rules!();
        let extra = CARD_PREPARE_POLICY.strip_prefix(shared).unwrap();
        assert!(!CARD_PREPARE_POLICY.contains("videodecoder"));
        let extra = rules(extra);
        assert_eq!(
            extra,
            "(allow file-write* (subpath (param \"MODEL_CACHE\")) (subpath (param \"METAL_CACHE\"))) \
             (allow file-issue-extension \
             (require-all (extension-class \"com.apple.app-sandbox.read\") (subpath (param \"MODEL_CACHE\"))))"
        );
        assert!(!extra.contains("network"));
    }

    /// A policy's rules without its comments.
    fn policy_rules(policy: &str) -> String {
        policy
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with(';'))
            .collect::<Vec<_>>()
            .join(" ")
    }
    const VIDEO_DECODER_RULE: &str =
        "(allow mach-lookup (xpc-service-name \"com.apple.coremedia.videodecoder\"))";

    /// Both reading policies, whole and without their comments: any further widening fails here. A
    /// PNG or JPEG card is read under the policy as it was before HEIC; a HEIC card under that and
    /// one rule more, Apple's video decoder service (review Z, L1). The IOSurface accelerator a HEIC
    /// decode also asks for, and every other service, stay denied in both.
    #[test]
    fn both_reading_policies_are_pinned_and_only_heic_gets_the_video_decoder_service() {
        let plain = "(version 1) (deny default) (allow process-exec (literal (param \"HELPER\"))) \
             (allow file-read* (literal \"/\") (subpath (param \"APP\")) (literal \"/System\") \
             (literal \"/System/Volumes\") (literal \"/System/Volumes/Data\") (literal \"/System/Volumes/Preboot\") \
             (subpath \"/System/Library\") (subpath \"/System/Cryptexes\") (subpath \"/System/iOSSupport\") \
             (subpath \"/System/Volumes/Preboot/Cryptexes\") (subpath \"/usr/lib\") (subpath \"/usr/share\") \
             (subpath (param \"MODEL_CACHE\")) (subpath (param \"METAL_CACHE\"))) \
             (allow file-read-metadata (literal \"/var\") (path-ancestors (param \"APP\")) \
             (path-ancestors (param \"MODEL_CACHE\")) (path-ancestors (param \"METAL_CACHE\"))) \
             (allow sysctl-read) \
             (allow iokit-open (iokit-user-client-class \"AGXDeviceUserClient\" \"IOSurfaceRootUserClient\" \
             \"AppleVirtIONeuralEngineDeviceUserClient\" \"H11ANEInDirectPathClient\" \"H1xANELoadBalancerDirectPathClient\")) \
             (allow mach-lookup (global-name \"com.apple.appleneuralengine\" \"com.apple.bsd.dirhelper\"))";
        assert_eq!(policy_rules(CARD_READER_POLICY), plain);
        assert_eq!(
            policy_rules(CARD_HEIC_READER_POLICY),
            format!("{plain} {VIDEO_DECODER_RULE}")
        );
        // The plain policy is the shared rules, byte for byte; the HEIC one adds exactly that rule.
        let shared = card_reader_rules!();
        assert_eq!(CARD_READER_POLICY, shared);
        let added = CARD_HEIC_READER_POLICY.strip_prefix(shared).unwrap();
        assert_eq!(policy_rules(added), VIDEO_DECODER_RULE);
        for policy in [CARD_READER_POLICY, CARD_PREPARE_POLICY] {
            assert!(!policy.contains("videodecoder") && !policy.contains("xpc-service-name"));
        }
        for denied in [
            "IOSurfaceAcceleratorClient",
            "AppleAVD",
            "com.apple.coremedia.videoencoder",
            "com.apple.MTLCompilerService",
            "com.apple.windowserver",
            "com.apple.tccd",
            "network",
        ] {
            assert!(
                !policy_rules(CARD_HEIC_READER_POLICY).contains(denied),
                "{denied}"
            );
        }
        // A comment that names no private document (the public copy has none to point to).
        assert!(!CARD_HEIC_READER_POLICY.contains("docs/"));
    }

    /// Each card is read under the policy its own bytes call for: PNG and JPEG never reach Apple's
    /// video decoder service.
    #[test]
    fn a_png_or_jpeg_card_is_read_without_the_video_decoder_and_only_a_heic_with_it() {
        for (image, policy) in [
            (png(1200, 800), CARD_READER_POLICY),
            (jpeg(0xC0, 4032, 3024), CARD_READER_POLICY),
            (heic(4032, 3024), CARD_HEIC_READER_POLICY),
        ] {
            let kind = card_image_kind(&image).unwrap();
            assert_eq!(reading_policy(kind), policy, "{kind:?}");
            assert_eq!(
                reading_policy(kind).contains(VIDEO_DECODER_RULE),
                kind == CardImageKind::Heic
            );
        }
    }

    /// A grid's own description (ISO/IEC 23008-12 ImageGrid) and where `iloc` says it is: in the
    /// meta box's `idat` (construction method 1, as Apple writes it) or in `mdat` (method 0).
    #[derive(Clone, Copy)]
    struct Layout {
        version: u8,
        rows_less_one: u8,
        columns_less_one: u8,
        output: (u32, u32),
        wide: bool,
        method: u16,
        /// Added to the offset `iloc` gives, to point it somewhere else.
        shift: u32,
    }
    /// An HEVC sequence parameter set's payload (before emulation prevention), as an encoder writes
    /// it: `sub_layers` (0 to 7) sub-layers each with a profile and level, a picture `coded` at that
    /// size and cropped by `crop` (left, right, top, bottom, in chroma samples) in `chroma` format.
    fn sps_payload(coded: (u32, u32), crop: [u32; 4], chroma: u32, sub_layers: u8) -> Vec<u8> {
        let mut bits: Vec<bool> = Vec::new();
        let put = |bits: &mut Vec<bool>, value: u64, count: u32| {
            for i in (0..count).rev() {
                bits.push((value >> i) & 1 == 1);
            }
        };
        let ue = |bits: &mut Vec<bool>, value: u32| {
            let value = u64::from(value) + 1;
            let length = 64 - value.leading_zeros();
            for _ in 1..length {
                bits.push(false);
            }
            for i in (0..length).rev() {
                bits.push((value >> i) & 1 == 1);
            }
        };
        put(&mut bits, 0, 4);
        put(&mut bits, u64::from(sub_layers), 3);
        put(&mut bits, 1, 1);
        // General profile (Main: space 0, tier 0, idc 1, compatible with 1 and 2), its flags, level 4.1.
        put(&mut bits, 0x01, 8);
        put(&mut bits, 0x6000_0000, 32);
        put(&mut bits, 0x9000_0000_0000, 48);
        put(&mut bits, 123, 8);
        for _ in 0..sub_layers {
            put(&mut bits, 0b11, 2);
        }
        if sub_layers > 0 {
            put(&mut bits, 0, 2 * (8 - u32::from(sub_layers)));
        }
        for _ in 0..sub_layers {
            put(&mut bits, 0x01, 8);
            put(&mut bits, 0x6000_0000, 32);
            put(&mut bits, 0, 48);
            put(&mut bits, 120, 8);
        }
        ue(&mut bits, 0);
        ue(&mut bits, chroma);
        if chroma == 3 {
            put(&mut bits, 0, 1);
        }
        ue(&mut bits, coded.0);
        ue(&mut bits, coded.1);
        if crop == [0; 4] {
            put(&mut bits, 0, 1);
        } else {
            put(&mut bits, 1, 1);
            for c in crop {
                ue(&mut bits, c);
            }
        }
        // The rest of a real set (bit depths and so on), then the stop bit.
        put(&mut bits, 0, 24);
        bits.push(true);
        while !bits.len().is_multiple_of(8) {
            bits.push(false);
        }
        bits.chunks(8)
            .map(|b| b.iter().fold(0u8, |v, &bit| (v << 1) | u8::from(bit)))
            .collect()
    }
    /// An `hvcC` holding one SPS NAL unit with `payload`, emulation prevention added.
    fn hvcc_with(payload: &[u8]) -> Vec<u8> {
        let mut nal = vec![0x42, 0x01];
        let mut zeros = 0;
        for &byte in payload {
            if zeros >= 2 && byte <= 3 {
                nal.push(3);
                zeros = 0;
            }
            zeros = if byte == 0 { zeros + 1 } else { 0 };
            nal.push(byte);
        }
        let mut out = vec![
            1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 123, 0xF0, 0, 0xFC, 0xFD, 0xF8, 0xF8, 0,
            0, 0x0F, 1, 0xA1, 0, 1,
        ];
        out.extend_from_slice(&(nal.len() as u16).to_be_bytes());
        out.extend_from_slice(&nal);
        out
    }
    /// A NAL unit: its two-byte header (`kind`, `layer`, temporal id plus one), then `payload`.
    fn nal(kind: u8, layer: u8, temporal: u8, payload: &[u8]) -> Vec<u8> {
        let mut unit = vec![(kind << 1) | (layer >> 5), ((layer & 0x1F) << 3) | temporal];
        unit.extend_from_slice(payload);
        unit
    }
    /// An `hvcC` with these arrays, each a label and its units.
    fn hvcc_arrays(arrays: &[(u8, Vec<Vec<u8>>)]) -> Vec<u8> {
        let mut out = hvcc_with(&[])[..22].to_vec();
        out.push(arrays.len() as u8);
        for (label, units) in arrays {
            out.push(0x80 | label);
            out.extend_from_slice(&(units.len() as u16).to_be_bytes());
            for unit in units {
                out.extend_from_slice(&(unit.len() as u16).to_be_bytes());
                out.extend_from_slice(unit);
            }
        }
        out
    }
    /// The `hvcC` an encoder writes for a picture shown at `size`: coded in blocks of 8, cropped back
    /// (4:2:0 when both sides are even, monochrome otherwise).
    fn hvcc_for(size: (u32, u32)) -> Vec<u8> {
        let coded = (size.0.div_ceil(8) * 8, size.1.div_ceil(8) * 8);
        let even = size.0.is_multiple_of(2) && size.1.is_multiple_of(2);
        let (chroma, unit) = if even { (1, 2) } else { (0, 1) };
        let crop = [0, (coded.0 - size.0) / unit, 0, (coded.1 - size.1) / unit];
        hvcc_with(&sps_payload(coded, crop, chroma, 0))
    }
    /// An item: its number, its type and its size, if it has one.
    type HeicItem = (u16, &'static [u8; 4], Option<(u32, u32)>);
    /// A HEIC's own boxes, as Apple writes them: a file type with `major`, then a `meta` box for
    /// pictures (`handler`) naming the primary item; each item's type, its size (`ispe`) and, for an
    /// HEVC picture, its `hvcC` (each property shared by every item with the same one, as Apple
    /// does); the primary's tiles (one `dimg`, or two with `second_dimg`) and its description
    /// (`layout`), other grids (`more_grids`) and other references (`more_refs`); the descriptions
    /// located by `iloc`; and an `mdat`. `hvcc` replaces every HEVC picture's `hvcC` (None: none at
    /// all). `wide_ipma` uses version 1 (four-byte item numbers) and two-byte property numbers.
    #[derive(Clone)]
    struct Heic {
        major: &'static [u8; 4],
        handler: &'static [u8; 4],
        primary: u16,
        items: Vec<HeicItem>,
        tiles: Vec<u16>,
        second_dimg: bool,
        layout: Option<Layout>,
        more_grids: Vec<(u16, Vec<u16>, Layout)>,
        more_refs: Vec<(&'static [u8; 4], u16, Vec<u16>)>,
        hvcc: Option<Option<Vec<u8>>>,
        item_hvcc: Vec<(u16, Option<Vec<u8>>)>,
        /// More properties (whole boxes) for an item, after its own.
        extra_properties: Vec<(u16, Vec<u8>)>,
        wide_ipma: bool,
    }
    impl Heic {
        fn one(kind: &'static [u8; 4], width: u32, height: u32) -> Self {
            Heic {
                major: b"heic",
                handler: b"pict",
                primary: 1,
                items: vec![(1, kind, Some((width, height)))],
                tiles: Vec::new(),
                second_dimg: false,
                layout: None,
                more_grids: Vec::new(),
                more_refs: Vec::new(),
                hvcc: None,
                item_hvcc: Vec::new(),
                extra_properties: Vec::new(),
                wide_ipma: false,
            }
        }
        fn bytes(&self) -> Vec<u8> {
            fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
                let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
                out.extend_from_slice(kind);
                out.extend_from_slice(body);
                out
            }
            let full =
                |version: u8, flags: u8, body: &[u8]| [&[version, 0, 0, flags][..], body].concat();
            let mut ftyp = self.major.to_vec();
            ftyp.extend_from_slice(&[0; 4]);
            ftyp.extend_from_slice(b"mif1heic");
            let hdlr = full(0, 0, &[&[0; 4][..], self.handler, &[0; 13]].concat());
            let pitm = full(0, 0, &self.primary.to_be_bytes());
            let mut iinf = (self.items.len() as u16).to_be_bytes().to_vec();
            let mut properties: Vec<Vec<u8>> = Vec::new();
            let mut index_of = |property: Vec<u8>| -> u16 {
                (match properties.iter().position(|p| *p == property) {
                    Some(at) => at + 1,
                    None => {
                        properties.push(property);
                        properties.len()
                    }
                }) as u16
            };
            let mut ipma_entries = Vec::new();
            let mut associated = 0u32;
            for (id, kind, size) in &self.items {
                iinf.extend(bx(
                    b"infe",
                    &full(
                        2,
                        0,
                        &[&id.to_be_bytes()[..], &[0, 0], &kind[..], &[0]].concat(),
                    ),
                ));
                let Some((w, h)) = size else { continue };
                let mut indexes = vec![index_of(bx(
                    b"ispe",
                    &full(0, 0, &[w.to_be_bytes(), h.to_be_bytes()].concat()),
                ))];
                if *kind == b"hvc1" {
                    let own = self.item_hvcc.iter().find(|(i, _)| i == id);
                    let hvcc = match (own, &self.hvcc) {
                        (Some((_, chosen)), _) | (None, Some(chosen)) => chosen.clone(),
                        (None, None) => Some(hvcc_for((*w, *h))),
                    };
                    if let Some(hvcc) = hvcc {
                        indexes.push(index_of(bx(b"hvcC", &hvcc)));
                    }
                }
                for (_, property) in self.extra_properties.iter().filter(|(i, _)| i == id) {
                    indexes.push(index_of(property.clone()));
                }
                associated += 1;
                if self.wide_ipma {
                    ipma_entries.extend_from_slice(&u32::from(*id).to_be_bytes());
                } else {
                    ipma_entries.extend_from_slice(&id.to_be_bytes());
                }
                ipma_entries.push(indexes.len() as u8);
                for index in indexes {
                    if self.wide_ipma {
                        ipma_entries.extend_from_slice(&(0x8000 | index).to_be_bytes());
                    } else {
                        ipma_entries.push(0x80 | index as u8);
                    }
                }
            }
            let ipco = properties.concat();
            let ipma = [&associated.to_be_bytes()[..], &ipma_entries].concat();
            let ipma = if self.wide_ipma {
                full(1, 1, &ipma)
            } else {
                full(0, 0, &ipma)
            };
            let iprp = [bx(b"ipco", &ipco), bx(b"ipma", &ipma)].concat();
            let reference = |kind: &[u8; 4], from: u16, to: &[u16]| {
                let mut body = from.to_be_bytes().to_vec();
                body.extend_from_slice(&(to.len() as u16).to_be_bytes());
                for id in to {
                    body.extend_from_slice(&id.to_be_bytes());
                }
                bx(kind, &body)
            };
            let mut refs = Vec::new();
            if !self.tiles.is_empty() {
                refs.extend(reference(b"dimg", self.primary, &self.tiles));
                if self.second_dimg {
                    refs.extend(reference(b"dimg", self.primary, &self.tiles));
                }
            }
            for (id, tiles, _) in &self.more_grids {
                refs.extend(reference(b"dimg", *id, tiles));
            }
            for (kind, from, to) in &self.more_refs {
                refs.extend(reference(kind, *from, to));
            }
            let iref = if refs.is_empty() {
                Vec::new()
            } else {
                bx(b"iref", &full(0, 0, &refs))
            };
            // Each grid's description, and an `iloc` (version 1, four-byte offsets and lengths)
            // with an entry for the first item too, as a real file has one for every item.
            let describe = |l: &Layout| {
                let mut d = vec![
                    l.version,
                    u8::from(l.wide),
                    l.rows_less_one,
                    l.columns_less_one,
                ];
                if l.wide {
                    d.extend_from_slice(&l.output.0.to_be_bytes());
                    d.extend_from_slice(&l.output.1.to_be_bytes());
                } else {
                    d.extend_from_slice(&(l.output.0 as u16).to_be_bytes());
                    d.extend_from_slice(&(l.output.1 as u16).to_be_bytes());
                }
                d
            };
            let described: Vec<(u16, Layout, Vec<u8>)> = self
                .layout
                .map(|l| (self.primary, l))
                .into_iter()
                .chain(self.more_grids.iter().map(|(id, _, l)| (*id, *l)))
                .map(|(id, l)| (id, l, describe(&l)))
                .collect();
            let meta = |mdat_at: u32| {
                if described.is_empty() {
                    return bx(
                        b"meta",
                        &full(
                            0,
                            0,
                            &[
                                bx(b"hdlr", &hdlr),
                                bx(b"pitm", &pitm),
                                bx(b"iinf", &full(0, 0, &iinf)),
                                iref.clone(),
                                bx(b"iprp", &iprp),
                            ]
                            .concat(),
                        ),
                    );
                }
                let mut iloc = vec![0x44, 0x00];
                iloc.extend_from_slice(&(described.len() as u16 + 1).to_be_bytes());
                iloc.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
                let (mut idat, mut mdat) = (Vec::new(), Vec::new());
                for (id, l, d) in &described {
                    let offset = if l.method == 0 {
                        mdat_at + mdat.len() as u32
                    } else {
                        idat.len() as u32
                    } + l.shift;
                    if l.method == 0 {
                        mdat.extend_from_slice(d);
                    } else {
                        idat.extend_from_slice(d);
                    }
                    iloc.extend_from_slice(&id.to_be_bytes());
                    iloc.extend_from_slice(&l.method.to_be_bytes());
                    iloc.extend_from_slice(&[0, 0, 0, 1]);
                    iloc.extend_from_slice(&offset.to_be_bytes());
                    iloc.extend_from_slice(&(d.len() as u32).to_be_bytes());
                }
                let idat = if idat.is_empty() {
                    Vec::new()
                } else {
                    bx(b"idat", &idat)
                };
                bx(
                    b"meta",
                    &full(
                        0,
                        0,
                        &[
                            bx(b"hdlr", &hdlr),
                            bx(b"pitm", &pitm),
                            bx(b"iloc", &full(1, 0, &iloc)),
                            bx(b"iinf", &full(0, 0, &iinf)),
                            iref.clone(),
                            bx(b"iprp", &iprp),
                            idat,
                        ]
                        .concat(),
                    ),
                )
            };
            let ftyp = bx(b"ftyp", &ftyp);
            let mdat_at = (ftyp.len() + meta(0).len() + 8) as u32;
            let mdat: Vec<u8> = described
                .iter()
                .filter(|(_, l, _)| l.method == 0)
                .flat_map(|(_, _, d)| d.clone())
                .collect();
            [ftyp, meta(mdat_at), bx(b"mdat", &mdat)].concat()
        }
    }
    /// A grid as an iPhone writes it: `rows` by `columns` HEVC tiles of `tile` size, each named once,
    /// covering an `output` picture, described in `idat`.
    fn grid_of(rows: u16, columns: u16, tile: (u32, u32), output: (u32, u32)) -> Heic {
        let count = rows * columns;
        Heic {
            primary: count + 1,
            items: (1..=count)
                .map(|id| (id, b"hvc1", Some(tile)))
                .chain([(count + 1, b"grid", Some(output))])
                .collect(),
            tiles: (1..=count).collect(),
            layout: Some(Layout {
                version: 0,
                rows_less_one: (rows - 1) as u8,
                columns_less_one: (columns - 1) as u8,
                output,
                wide: output.0 > 0xFFFF || output.1 > 0xFFFF,
                method: 1,
                shift: 0,
            }),
            wide_ipma: true,
            ..Heic::one(b"hvc1", 1, 1)
        }
    }

    /// A HEIC declaring one HEVC picture of `width` x `height`.
    pub(crate) fn heic(width: u32, height: u32) -> Vec<u8> {
        Heic::one(b"hvc1", width, height).bytes()
    }

    #[test]
    fn a_heic_is_told_by_its_own_boxes_and_its_primary_pictures_size() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        assert_eq!(
            kind(&Heic::one(b"hvc1", 1200, 800)),
            Some(CardImageKind::Heic)
        );
        for major in [b"heix", b"heim", b"heis", b"mif1"] {
            let heic = Heic {
                major,
                ..Heic::one(b"hvc1", 1200, 800)
            };
            assert_eq!(kind(&heic), Some(CardImageKind::Heic), "{major:?}");
        }
        // An iPhone photo: a grid of 512 by 512 tiles, the grid itself the primary picture; its size
        // is the grid's, not its tiles'.
        assert_eq!(
            kind(&grid_of(6, 8, (512, 512), (4032, 3024))),
            Some(CardImageKind::Heic)
        );
        assert_eq!(
            kind(&grid_of(10, 16, (512, 512), (8000, 5000))),
            Some(CardImageKind::Heic)
        );
        assert_eq!(kind(&grid_of(10, 16, (512, 512), (8000, 5001))), None);
        // Several pictures: only the primary one is read, so only its size counts.
        let second = |big: bool| Heic {
            primary: 2,
            items: vec![
                (
                    1,
                    b"hvc1",
                    Some(if big { (640, 160) } else { (9000, 9000) }),
                ),
                (
                    2,
                    b"hvc1",
                    Some(if big { (9000, 9000) } else { (1400, 900) }),
                ),
            ],
            ..Heic::one(b"hvc1", 1, 1)
        };
        assert_eq!(kind(&second(false)), Some(CardImageKind::Heic));
        assert_eq!(kind(&second(true)), None);
    }

    /// Review Z, L2: a small HEIC naming tens of thousands of items (a 255 by 255 grid of one shared
    /// tile cost half a minute and 650 MB) is refused before anything is decoded. A 48-megapixel
    /// iPhone photo has about 200 items; up to 1,024 are read.
    #[test]
    fn a_heic_of_more_than_1024_items_is_refused_before_decoding() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        let bomb = grid_of(255, 255, (16, 16), (4080, 4080)).bytes();
        assert!(bomb.len() < MAX_IMAGE_BYTES);
        assert_eq!(card_image_check(&bomb), Err(CardImageProblem::NotAPhoto));
        // An iPhone-style grid of 192 tiles (16 by 12) is read; 1,023 tiles and the grid are 1,024 items.
        assert_eq!(
            kind(&grid_of(12, 16, (400, 400), (6200, 4600))),
            Some(CardImageKind::Heic)
        );
        assert_eq!(
            kind(&grid_of(33, 31, (200, 200), (6100, 6500))),
            Some(CardImageKind::Heic)
        );
        assert_eq!(kind(&grid_of(32, 32, (192, 192), (6000, 6000))), None);
        // A count that says more than are there is refused too.
        let mut declared = grid_of(6, 8, (512, 512), (4032, 3024)).bytes();
        let at = declared.windows(4).position(|w| w == b"iinf").unwrap() + 8;
        declared[at..at + 2].copy_from_slice(&1025u16.to_be_bytes());
        assert_eq!(card_image_kind(&declared), None);
    }

    /// Review Z, I2: every tile of a grid must be HEVC; a grid of AV1 tiles under a HEIC brand, one
    /// tile of another kind, a tile that isn't there, or a grid naming no tiles is no photo.
    #[test]
    fn a_grid_is_read_only_when_every_tile_is_hevc() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        let iphone = grid_of(6, 8, (512, 512), (4032, 3024));
        assert_eq!(kind(&iphone), Some(CardImageKind::Heic));
        let mut av1 = iphone.clone();
        for item in av1.items.iter_mut().filter(|i| i.1 == b"hvc1") {
            item.1 = b"av01";
        }
        assert_eq!(kind(&av1), None);
        let mut mixed = iphone.clone();
        mixed.items[20].1 = b"av01";
        assert_eq!(kind(&mixed), None);
        let mut absent = iphone.clone();
        absent.tiles[47] = 400;
        assert_eq!(kind(&absent), None);
        let mut untiled = iphone.clone();
        untiled.tiles.clear();
        assert_eq!(kind(&untiled), None);
        // A grid as a tile of itself is not HEVC either.
        let mut itself = iphone;
        itself.tiles[47] = 49;
        assert_eq!(kind(&itself), None);
    }

    /// One tile named 65,025 times in a two-item file was the same half-minute decode as 65,025
    /// items: a grid's one `dimg` reference names at most 1,024 tiles, each once.
    #[test]
    fn a_grid_names_each_tile_once_in_one_reference_and_at_most_1024() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        let mut repeated = grid_of(255, 255, (16, 16), (4080, 4080));
        repeated.items = vec![
            (1, b"hvc1", Some((16, 16))),
            (65026, b"grid", Some((4080, 4080))),
        ];
        repeated.tiles = vec![1; 65025];
        let bytes = repeated.bytes();
        assert!(bytes.len() < 200_000);
        assert_eq!(card_image_check(&bytes), Err(CardImageProblem::NotAPhoto));
        // Within the count, a tile named twice, or a second `dimg` for the grid, is no photo.
        let iphone = grid_of(6, 8, (512, 512), (4032, 3024));
        let mut twice = iphone.clone();
        twice.tiles[47] = 47;
        assert_eq!(kind(&twice), None);
        let mut two_lists = iphone.clone();
        two_lists.second_dimg = true;
        assert_eq!(kind(&two_lists), None);
    }

    /// The grid's own description must match its tiles and its size, and the tiles must cover the
    /// output with less than one tile to spare each way, never decoding more than twice the pixel
    /// limit: tiles far larger than the output, a strip of huge tiles, or tiles of mixed sizes are
    /// no photo. Apple writes the description in `idat`; one in `mdat` and one with 32-bit sizes are
    /// read too.
    #[test]
    fn a_grids_tiles_must_cover_its_output_and_not_much_more() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        let iphone = grid_of(6, 8, (512, 512), (4032, 3024));
        assert_eq!(kind(&iphone), Some(CardImageKind::Heic));
        let edit = |change: &dyn Fn(&mut Heic)| {
            let mut heic = iphone.clone();
            change(&mut heic);
            kind(&heic)
        };
        let layout =
            |change: &dyn Fn(&mut Layout)| edit(&|h: &mut Heic| change(h.layout.as_mut().unwrap()));
        // Where the description is.
        assert_eq!(layout(&|l| l.method = 0), Some(CardImageKind::Heic));
        assert_eq!(layout(&|l| l.wide = true), Some(CardImageKind::Heic));
        assert_eq!(layout(&|l| l.method = 2), None);
        assert_eq!(layout(&|l| l.shift = 1_000_000), None);
        assert_eq!(layout(&|l| l.version = 1), None);
        assert_eq!(edit(&|h| h.layout = None), None);
        // What it says: rows and columns for the tiles named, the grid's own size.
        assert_eq!(layout(&|l| l.rows_less_one = 6), None);
        assert_eq!(layout(&|l| l.columns_less_one = 5), None);
        assert_eq!(layout(&|l| l.output = (4032, 3025)), None);
        // Tiles: each with its own size, all the same, none empty.
        assert_eq!(edit(&|h| h.items[3].2 = None), None);
        assert_eq!(edit(&|h| h.items[3].2 = Some((512, 513))), None);
        let empty = grid_of(6, 8, (0, 512), (4032, 3024));
        assert_eq!(kind(&empty), None);
        // Covering the output, with less than a tile to spare: not too small, no unused column or row.
        assert_eq!(kind(&grid_of(6, 8, (500, 512), (4032, 3024))), None);
        assert_eq!(kind(&grid_of(6, 9, (512, 512), (4032, 3024))), None);
        assert_eq!(kind(&grid_of(7, 8, (512, 512), (4032, 3024))), None);
        assert_eq!(
            kind(&grid_of(6, 8, (504, 504), (4032, 3024))),
            Some(CardImageKind::Heic)
        );
        // Tiles far larger than the output, one or several.
        assert_eq!(kind(&grid_of(1, 1, (60_000, 60_000), (100, 100))), None);
        assert_eq!(kind(&grid_of(2, 2, (9_000, 9_000), (10_000, 10_000))), None);
        // A strip of very wide tiles over a picture within the limit.
        assert_eq!(kind(&grid_of(100, 1, (4_000_000, 1), (40_000, 100))), None);
        // A small picture in one tile, as an encoder may store it, is read.
        assert_eq!(
            kind(&grid_of(1, 1, (512, 512), (300, 200))),
            Some(CardImageKind::Heic)
        );
    }

    /// Review Z, I3: more than 40 million pixels, of any kind, is its own refusal (a 48-megapixel
    /// iPhone photo), not "not a photo"; the reader returns it as `too-many-pixels`.
    #[test]
    fn a_picture_over_40_megapixels_is_too_many_pixels_for_every_kind() {
        for image in [
            png(8000, 5001),
            png(u32::MAX, u32::MAX),
            jpeg(0xC0, 65_535, 65_535),
            heic(8064, 6048),
            grid_of(12, 16, (512, 512), (8064, 6048)).bytes(),
        ] {
            assert_eq!(
                card_image_check(&image),
                Err(CardImageProblem::TooManyPixels)
            );
            assert_eq!(
                Cards::default().read(image),
                Err(LocalToolError::TooManyPixels)
            );
        }
        for image in [png(8000, 5000), jpeg(0xC0, 8000, 5000), heic(8000, 5000)] {
            assert!(card_image_check(&image).is_ok());
        }
        // No size, or none at all, is still no photo.
        for image in [png(0, 800), heic(0, 800), b"GIF89a".to_vec()] {
            assert_eq!(card_image_check(&image), Err(CardImageProblem::NotAPhoto));
        }
        assert_eq!(
            serde_json::to_string(&LocalToolError::TooManyPixels).unwrap(),
            "\"too-many-pixels\""
        );
    }

    /// The coded and shown sizes come out of an `hvcC`'s sequence parameters as an encoder writes
    /// them, with sub-layers, every chroma format, a conformance window and emulation-prevention
    /// bytes; anything else is no size at all.
    #[test]
    fn an_hevc_pictures_size_is_read_from_its_sequence_parameters() {
        let size = |coded: (u32, u32), crop: [u32; 4], chroma: u32, sub_layers: u8| {
            hevc_size(&hvcc_with(&sps_payload(coded, crop, chroma, sub_layers)))
        };
        let both = |w: u64, h: u64, cw: u64, ch: u64| {
            Some(HevcSize {
                coded: (w, h),
                cropped: (cw, ch),
            })
        };
        assert_eq!(
            size((4032, 3024), [0; 4], 1, 0),
            both(4032, 3024, 4032, 3024)
        );
        assert_eq!(hevc_size(&hvcc_for((196, 196))), both(200, 200, 196, 196));
        assert_eq!(hevc_size(&hvcc_for((601, 401))), both(608, 408, 601, 401));
        for sub_layers in 0..=7 {
            assert_eq!(
                size((512, 512), [0, 4, 0, 2], 1, sub_layers),
                both(512, 512, 504, 508)
            );
        }
        // Chroma: 4:2:2 crops rows one by one, 4:4:4 and monochrome both ways one by one.
        assert_eq!(
            size((512, 512), [1, 1, 1, 1], 2, 0),
            both(512, 512, 508, 510)
        );
        assert_eq!(
            size((512, 512), [1, 1, 1, 1], 3, 0),
            both(512, 512, 510, 510)
        );
        assert_eq!(
            size((512, 512), [1, 1, 1, 1], 0, 0),
            both(512, 512, 510, 510)
        );
        // The payload has runs of zero bytes, so its NAL unit carries emulation-prevention bytes.
        assert!(
            hvcc_with(&sps_payload((8192, 8192), [0; 4], 1, 0))
                .windows(3)
                .any(|w| w == [0, 0, 3])
        );
        assert_eq!(
            size((8192, 8192), [0; 4], 1, 0),
            both(8192, 8192, 8192, 8192)
        );
        // No size: no SPS, two, another configuration version, chroma 4, nothing coded, cropped away.
        let good = hvcc_for((512, 512));
        let mut none = good[..23].to_vec();
        none[22] = 0;
        assert_eq!(hevc_size(&none), None);
        let mut two = good.clone();
        two[24..26].copy_from_slice(&2u16.to_be_bytes());
        two.extend_from_slice(&good[26..]);
        assert_eq!(hevc_size(&two), None);
        let mut version = good.clone();
        version[0] = 2;
        assert_eq!(hevc_size(&version), None);
        assert_eq!(size((512, 512), [0; 4], 4, 0), None);
        assert_eq!(size((0, 512), [0; 4], 1, 0), None);
        assert_eq!(size((512, 512), [128, 128, 0, 0], 1, 0), None);
        // Cut short anywhere, it is no size; a number of more than 32 leading zeros is none either.
        for cut in 0..good.len() - 4 {
            assert_eq!(hevc_size(&good[..cut]), None, "{cut}");
        }
        let mut zeros = sps_payload((512, 512), [0; 4], 1, 0);
        zeros.truncate(13);
        zeros.extend_from_slice(&[0x80, 0, 0, 0, 0, 0x01, 0xFF]);
        assert_eq!(hevc_size(&hvcc_with(&zeros)), None);
    }

    /// Review G, L-1: Apple's decoder reads every parameter set in an `hvcC` by the unit's own header,
    /// so a big SPS hidden in the PPS or SEI array, first or last, or in the VPS array, is no
    /// photo; so is any unit not of its array's type, of another layer, with a wrong temporal id,
    /// any other kind of array, two SPS or VPS, nine PPS or SEI, or a unit over 1,024 bytes. What
    /// Apple writes (one VPS, SPS and PPS) is read, and SEI beside them.
    #[test]
    fn an_hevc_configuration_holds_only_what_its_labels_say() {
        let small = &hvcc_for((196, 196))[28..];
        let small_sps = small.to_vec();
        let big_sps = nal(33, 0, 1, &sps_payload((8192, 8192), [0; 4], 1, 0));
        let vps = nal(32, 0, 1, &[0x0C, 0x01, 0xFF, 0xFF]);
        let pps = nal(34, 0, 1, &[0xC1, 0x72]);
        let sei = nal(39, 0, 1, &[0x05, 0x02, 0xAA, 0xBB, 0x80]);
        let size = |arrays: &[(u8, Vec<Vec<u8>>)]| hevc_size(&hvcc_arrays(arrays));
        let shown = Some(HevcSize {
            coded: (200, 200),
            cropped: (196, 196),
        });
        let honest = vec![
            (32, vec![vps.clone()]),
            (33, vec![small_sps.clone()]),
            (34, vec![pps.clone()]),
        ];
        assert_eq!(size(&honest), shown);
        let with = |extra: (u8, Vec<Vec<u8>>)| {
            let mut arrays = honest.clone();
            arrays.push(extra);
            size(&arrays)
        };
        assert_eq!(with((39, vec![sei.clone()])), shown);
        assert_eq!(with((40, vec![nal(40, 0, 3, &[1, 2])])), shown);
        // The reviewer's: the big SPS (and its PPS) in the PPS array, in an SEI array, in the VPS array.
        assert_eq!(with((34, vec![big_sps.clone(), pps.clone()])), None);
        assert_eq!(with((39, vec![big_sps.clone()])), None);
        assert_eq!(with((32, vec![big_sps.clone()])), None);
        // The big SPS labelled PPS and placed first.
        let mut first = vec![(34, vec![big_sps.clone()])];
        first.extend(honest.clone());
        assert_eq!(size(&first), None);
        // Headers: another layer, temporal id 0 or a parameter set's of more than 0, the forbidden bit.
        assert_eq!(with((34, vec![nal(34, 1, 1, &[0xC1])])), None);
        assert_eq!(with((34, vec![nal(34, 0, 0, &[0xC1])])), None);
        assert_eq!(with((34, vec![nal(34, 0, 2, &[0xC1])])), None);
        let mut forbidden = pps.clone();
        forbidden[0] |= 0x80;
        assert_eq!(with((34, vec![forbidden])), None);
        // Other kinds of array: an access unit delimiter, a slice, end of sequence.
        for kind in [35, 1, 19, 36] {
            assert_eq!(with((kind, vec![nal(kind, 0, 1, &[0x50])])), None, "{kind}");
        }
        // How many: no SPS, two, two VPS, nine PPS, nine SEI, a unit over 1,024 bytes.
        assert_eq!(
            size(&[(32, vec![vps.clone()]), (34, vec![pps.clone()])]),
            None
        );
        assert_eq!(with((33, vec![small_sps.clone()])), None);
        assert_eq!(with((32, vec![vps])), None);
        assert_eq!(with((34, vec![pps.clone(); 8])), None);
        assert_eq!(with((39, vec![sei.clone(); 8])), shown);
        assert_eq!(with((39, vec![sei; 9])), None);
        assert_eq!(with((39, vec![nal(39, 0, 1, &[0x05; 1023])])), None);
        assert_eq!(with((39, vec![nal(39, 0, 1, &[0x05; 1022])])), shown);
    }

    /// Review G, L-1: one `hvcC` and one `ispe` an item: ImageIO took a tile's second (big) `hvcC`,
    /// this check its first.
    #[test]
    fn a_picture_with_two_configurations_or_sizes_is_no_photo() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        let big = hvcc_with(&sps_payload((8192, 8192), [0; 4], 1, 0));
        let boxed = |kind: &[u8; 4], body: &[u8]| {
            let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            b.extend_from_slice(kind);
            b.extend_from_slice(body);
            b
        };
        let mut two = grid_of(6, 8, (512, 512), (4032, 3024));
        assert_eq!(kind(&two), Some(CardImageKind::Heic));
        two.extra_properties = (1..=48).map(|id| (id, boxed(b"hvcC", &big))).collect();
        assert_eq!(kind(&two), None);
        let mut single = Heic::one(b"hvc1", 1200, 800);
        single.extra_properties = vec![(1, boxed(b"hvcC", &hvcc_for((1200, 800))))];
        assert_eq!(kind(&single), None);
        let mut sizes = Heic::one(b"hvc1", 1200, 800);
        sizes.extra_properties = vec![(
            1,
            boxed(b"ispe", &[0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0, 0x20, 0]),
        )];
        assert_eq!(kind(&sizes), None);
    }

    /// Review G, L-2: references are read once and bounded: more than 4,096 in all, or one item
    /// making the same kind of reference twice, is no photo, and so are more than four tone maps.
    /// The reviewer's file of 1,020 tone maps and 600,000 filler references took seconds a check.
    #[test]
    fn references_are_bounded_and_tone_maps_few() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        let base = grid_of(6, 8, (512, 512), (4032, 3024));
        // 4,096 references in all: the grid's 48 and 4,048 from Exif (cdsc) items.
        let filler = |references: usize| {
            let mut heic = base.clone();
            let mut left = references - 48;
            let mut id = 50;
            while left > 0 {
                let n = left.min(1024);
                heic.items.push((id, b"Exif", None));
                heic.more_refs.push((b"cdsc", id, vec![49; n]));
                left -= n;
                id += 1;
            }
            heic
        };
        assert_eq!(kind(&filler(4096)), Some(CardImageKind::Heic));
        assert_eq!(kind(&filler(4097)), None);
        let mut twice = base.clone();
        twice.items.push((50, b"Exif", None));
        twice.more_refs = vec![(b"cdsc", 50, vec![49]), (b"cdsc", 50, vec![49])];
        assert_eq!(kind(&twice), None);
        let mut many = base.clone();
        many.items.push((50, b"Exif", None));
        many.more_refs = vec![(b"cdsc", 50, vec![49; 1025])];
        assert_eq!(kind(&many), None);
        // Four tone maps of the photo and another picture are read; five are not.
        let tone_maps = |n: u16| {
            let mut heic = base.clone();
            heic.items.push((50, b"hvc1", Some((1008, 756))));
            for id in 51..51 + n {
                heic.items.push((id, b"tmap", Some((4032, 3024))));
                heic.more_refs.push((b"dimg", id, vec![49, 50]));
            }
            kind(&heic)
        };
        assert_eq!(tone_maps(4), Some(CardImageKind::Heic));
        assert_eq!(tone_maps(5), None);
    }

    /// Review G, L-3: a photo over 40 megapixels is refused as too many pixels even when everything
    /// in the file together is also over the total, as a 48-megapixel Portrait photo with its mattes
    /// is (about 138 megapixels in all).
    #[test]
    fn a_portrait_photo_over_the_limit_is_too_many_pixels() {
        let mut portrait = grid_of(6, 9, (896, 1024), (8064, 6048));
        portrait.items.extend([
            (56, b"hvc1", Some((4032, 3024))),
            (57, b"hvc1", Some((4032, 3024))),
            (58, b"hvc1", Some((4032, 3024))),
            (59, b"hvc1", Some((4032, 3024))),
            (60, b"hvc1", Some((4032, 3024))),
            (61, b"hvc1", Some((4032, 3024))),
            (62, b"hvc1", Some((4032, 3024))),
        ]);
        portrait.more_refs = (56..=62).map(|id| (b"auxl", id, vec![55])).collect();
        assert_eq!(
            card_image_check(&portrait.bytes()),
            Err(CardImageProblem::TooManyPixels)
        );
        // Within the limit, too much in all is still no photo.
        let mut small = grid_of(6, 8, (512, 512), (4032, 3024));
        small
            .items
            .extend((50..=59).map(|id| (id, b"hvc1", Some((4032, 3024)))));
        small.more_refs = (50..=59).map(|id| (b"auxl", id, vec![49])).collect();
        assert_eq!(
            card_image_check(&small.bytes()),
            Err(CardImageProblem::NotAPhoto)
        );
    }

    /// Review G, L-4: a long, thin strip, such as one row of 512 tiles under a 16,000 by 100
    /// picture, may spare a row and a column of tiles of at most 512; tiles larger than the picture
    /// still may not.
    #[test]
    fn a_long_thin_strip_is_read() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        assert_eq!(
            kind(&grid_of(1, 32, (512, 512), (16000, 100))),
            Some(CardImageKind::Heic)
        );
        assert_eq!(
            kind(&grid_of(32, 1, (512, 512), (100, 16000))),
            Some(CardImageKind::Heic)
        );
        assert_eq!(kind(&grid_of(1, 2, (8192, 4320), (8193, 4320))), None);
        assert_eq!(kind(&grid_of(1, 1, (60_000, 60_000), (100, 100))), None);
    }

    /// Review F, L-1: a picture's coded size must be the one it says, cropped to exactly that and
    /// padded by less than 64 each way. 1,023 tiles said 196 by 196 but were each an 8192 by 8192
    /// picture; a single picture said 100 by 100 and was 8192 by 8192.
    #[test]
    fn a_picture_coded_larger_than_it_says_is_no_photo() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        let tiles = grid_of(33, 31, (196, 196), (6076, 6468));
        assert_eq!(kind(&tiles), Some(CardImageKind::Heic));
        let huge = hvcc_with(&sps_payload((8192, 8192), [0; 4], 1, 0));
        let huge_cropped = hvcc_with(&sps_payload((8192, 8192), [0, 3998, 0, 3998], 1, 0));
        for hvcc in [huge.clone(), huge_cropped] {
            let mut bomb = tiles.clone();
            bomb.hvcc = Some(Some(hvcc.clone()));
            assert_eq!(kind(&bomb), None);
            let single = Heic {
                hvcc: Some(Some(hvcc)),
                ..Heic::one(b"hvc1", 196, 196)
            };
            assert_eq!(kind(&single), None);
        }
        // Padding of up to 63 is how encoders code; 64 is not.
        let padded = |pad: u32| Heic {
            hvcc: Some(Some(hvcc_with(&sps_payload(
                (1200 + pad, 800),
                [0, pad, 0, 0],
                0,
                0,
            )))),
            ..Heic::one(b"hvc1", 1200, 800)
        };
        assert_eq!(kind(&padded(63)), Some(CardImageKind::Heic));
        assert_eq!(kind(&padded(64)), None);
        // Cropped to anything but its stated size, no `hvcC`, or an `hvcC` without a size.
        let other = Heic {
            hvcc: Some(Some(hvcc_for((1200, 798)))),
            ..Heic::one(b"hvc1", 1200, 800)
        };
        assert_eq!(kind(&other), None);
        let without = Heic {
            hvcc: Some(None),
            ..Heic::one(b"hvc1", 1200, 800)
        };
        assert_eq!(kind(&without), None);
        let broken = Heic {
            hvcc: Some(Some(vec![1; 23])),
            ..Heic::one(b"hvc1", 1200, 800)
        };
        assert_eq!(kind(&broken), None);
        // A small picture coded at Apple's least (160 by 64 for 24 by 24) is read; a tile so coded is not.
        let small = hvcc_with(&sps_payload((160, 64), [0, 68, 0, 20], 1, 0));
        let one = Heic {
            hvcc: Some(Some(small.clone())),
            ..Heic::one(b"hvc1", 24, 24)
        };
        assert_eq!(kind(&one), Some(CardImageKind::Heic));
        let past = Heic {
            hvcc: Some(Some(hvcc_with(&sps_payload(
                (256, 64),
                [0, 116, 0, 20],
                1,
                0,
            )))),
            ..Heic::one(b"hvc1", 24, 24)
        };
        assert_eq!(kind(&past), None);
        let mut small_tiles = grid_of(2, 2, (24, 24), (48, 48));
        small_tiles.hvcc = Some(Some(small));
        assert_eq!(kind(&small_tiles), None);
        // Every tile of a grid coded alike: one tile coded 512 by 520 among 512 by 512 is no photo.
        let mut mixed = grid_of(6, 8, (512, 512), (4032, 3024));
        mixed.item_hvcc = vec![(
            7,
            Some(hvcc_with(&sps_payload((512, 520), [0, 0, 0, 4], 1, 0))),
        )];
        assert_eq!(kind(&mixed), None);
    }

    /// A file that says what it holds twice could show ImageIO one thing and this check another: a
    /// second `meta`, or a second item list, reference list or property list inside it, is no photo
    /// (review F's crafted files put an honest meta box before a bomb).
    #[test]
    fn a_heic_that_lists_its_contents_twice_is_no_photo() {
        let honest = grid_of(6, 8, (512, 512), (4032, 3024)).bytes();
        assert_eq!(card_image_kind(&honest), Some(CardImageKind::Heic));
        let at = |name: &[u8; 4]| honest.windows(4).position(|w| w == name).unwrap() - 4;
        let length = |start: usize| {
            u32::from_be_bytes(honest[start..start + 4].try_into().unwrap()) as usize
        };
        let meta = at(b"meta");
        let mut twice = honest.clone();
        twice.extend_from_slice(&honest[meta..meta + length(meta)]);
        assert_eq!(card_image_kind(&twice), None);
        for name in [b"iinf", b"iref", b"iloc", b"iprp", b"pitm"] {
            let start = at(name);
            let copy = honest[start..start + length(start)].to_vec();
            let mut doubled = honest.clone();
            doubled.splice(start..start, copy.iter().copied());
            let grown = (length(meta) + copy.len()) as u32;
            doubled[meta..meta + 4].copy_from_slice(&grown.to_be_bytes());
            assert_eq!(card_image_kind(&doubled), None, "{name:?}");
        }
    }

    /// What a grid's tiles decode to stays close to its picture: a quarter more and 4 megapixels
    /// besides. Two 8192 by 4320 tiles over a picture one pixel wider than one of them took the
    /// reader 2.9 s; a small picture in two 512 tiles is read.
    #[test]
    fn a_grid_decodes_to_little_more_than_its_picture() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        assert_eq!(kind(&grid_of(1, 2, (8192, 4320), (8193, 4320))), None);
        assert_eq!(kind(&grid_of(1, 1, (8192, 4320), (1, 1))), None);
        assert_eq!(
            kind(&grid_of(1, 2, (512, 512), (600, 400))),
            Some(CardImageKind::Heic)
        );
        // Apple's own: 896 by 1,024 tiles over 8,064 by 6,048 (too many pixels, but a grid that fits).
        assert_eq!(
            card_image_check(&grid_of(6, 9, (896, 1024), (8064, 6048)).bytes()),
            Err(CardImageProblem::TooManyPixels)
        );
    }

    /// Review F, L-2: every item in the file is held to the rules, not only the photo. An honest
    /// picture with an alpha grid naming one tile 65,025 times held the reader for 30 s. The pictures
    /// an iPhone or ImageIO adds are read: a thumbnail, an alpha or depth picture, portrait mattes, an
    /// HDR gain map as a hidden grid with its tone map (`tmap`), Exif and XMP. Any other kind of item,
    /// or more than three times the pixel limit in all, is no photo.
    #[test]
    fn every_picture_in_the_file_is_held_to_the_rules() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        // The photo (49) and, as ImageIO writes an ISO gain map: a hidden 2016 by 1512 grid of 12
        // tiles (50 to 61, grid 62) and a tone map (63) of the two; then Exif, XMP, a thumbnail
        // (64), an alpha or depth picture (65) and a matte (66).
        let mut iphone = grid_of(6, 8, (512, 512), (4032, 3024));
        iphone
            .items
            .extend((50..=61).map(|id| (id, b"hvc1", Some((504, 504)))));
        iphone.items.extend([
            (62, b"grid", Some((2016, 1512))),
            (63, b"tmap", Some((4032, 3024))),
            (64, b"hvc1", Some((320, 240))),
            (65, b"hvc1", Some((768, 576))),
            (66, b"hvc1", Some((2016, 1512))),
            (67, b"Exif", None),
            (68, b"mime", None),
        ]);
        let gain_map = Layout {
            rows_less_one: 2,
            columns_less_one: 3,
            output: (2016, 1512),
            ..iphone.layout.unwrap()
        };
        iphone.more_grids = vec![(62, (50..=61).collect(), gain_map)];
        iphone.more_refs = vec![
            (b"dimg", 63, vec![49, 62]),
            (b"thmb", 64, vec![49]),
            (b"auxl", 65, vec![49]),
            (b"auxl", 66, vec![49]),
            (b"cdsc", 67, vec![49]),
        ];
        assert_eq!(kind(&iphone), Some(CardImageKind::Heic));
        // The alpha picture a grid naming one tile 65,025 times, beside an honest photo.
        let mut alpha = Heic::one(b"hvc1", 1200, 800);
        alpha.items.extend([
            (2, b"hvc1", Some((16, 16))),
            (3, b"grid", Some((4080, 4080))),
        ]);
        let mut repeated = grid_of(255, 255, (16, 16), (4080, 4080)).layout.unwrap();
        repeated.rows_less_one = 254;
        alpha.more_grids = vec![(3, vec![2; 65025], repeated)];
        alpha.more_refs = vec![(b"auxl", 3, vec![1])];
        assert_eq!(kind(&alpha), None);
        // Any grid is held to the grid rules: a gain map grid whose tiles don't cover it is no photo.
        let mut short = iphone.clone();
        short.more_grids[0].2.output = (2100, 1512);
        short.items.iter_mut().find(|i| i.0 == 62).unwrap().2 = Some((2100, 1512));
        assert_eq!(kind(&short), None);
        // A tone map of two pictures of the file, not itself, not twice the same, not Exif.
        for inputs in [
            vec![49],
            vec![49, 49],
            vec![49, 63],
            vec![49, 67],
            vec![49, 99],
            vec![49, 62, 64],
        ] {
            let mut tone = iphone.clone();
            tone.more_refs[0].2 = inputs.clone();
            assert_eq!(kind(&tone), None, "{inputs:?}");
        }
        let mut lost = iphone.clone();
        lost.more_refs.remove(0);
        assert_eq!(kind(&lost), None);
        // Kinds of item no iPhone or Mac writes: an overlay, an identity, AV1, JPEG, a URI, raw pictures.
        for other in [
            b"iovl", b"iden", b"av01", b"jpeg", b"uri ", b"unci", b"hvt1", b"lhv1",
        ] {
            let mut odd = iphone.clone();
            odd.items.push((70, other, None));
            assert_eq!(kind(&odd), None, "{other:?}");
        }
        // Every picture, all told, within three times the limit: a 9,000 by 9,000 depth picture
        // beside a 40-megapixel photo is too much, 6,000 by 6,000 isn't.
        let all = |side: u32| {
            let mut big = Heic::one(b"hvc1", 8000, 5000);
            big.items.push((2, b"hvc1", Some((side, side))));
            big.more_refs = vec![(b"auxl", 2, vec![1])];
            kind(&big)
        };
        assert_eq!(all(6000), Some(CardImageKind::Heic));
        assert_eq!(all(9000), None);
        // A tone map can't be the photo.
        let mut tone_first = iphone;
        tone_first.primary = 63;
        assert_eq!(kind(&tone_first), None);
    }

    #[test]
    fn video_avif_sequences_and_broken_heics_are_refused() {
        let kind = |h: &Heic| card_image_kind(&h.bytes());
        // Sequences, AVIF and video, by their file type.
        for major in [
            b"msf1", b"hevc", b"hevx", b"avif", b"avis", b"isom", b"mp42", b"qt  ", b"M4V ",
        ] {
            let heic = Heic {
                major,
                ..Heic::one(b"hvc1", 1200, 800)
            };
            assert_eq!(kind(&heic), None, "{major:?}");
        }
        // A HEIF whose primary picture isn't HEVC (AVIF's av01, JPEG inside HEIF, an overlay, Exif).
        for item in [b"av01", b"jpeg", b"iovl", b"iden", b"Exif", b"mime"] {
            assert_eq!(kind(&Heic::one(item, 1200, 800)), None, "{item:?}");
        }
        // Not for pictures, no size, a zero size, a primary item that isn't there.
        assert_eq!(
            kind(&Heic {
                handler: b"vide",
                ..Heic::one(b"hvc1", 1200, 800)
            }),
            None
        );
        assert_eq!(
            kind(&Heic {
                items: vec![(1, b"hvc1", None)],
                ..Heic::one(b"hvc1", 1, 1)
            }),
            None
        );
        assert_eq!(kind(&Heic::one(b"hvc1", 0, 800)), None);
        assert_eq!(
            kind(&Heic {
                primary: 7,
                ..Heic::one(b"hvc1", 1200, 800)
            }),
            None
        );
        // Cut short anywhere, or with its file type box not first.
        let whole = Heic::one(b"hvc1", 1200, 800).bytes();
        for cut in [
            4,
            12,
            24,
            40,
            whole.len() / 2,
            whole.len() - 9,
            whole.len() - 1,
        ] {
            assert_eq!(card_image_kind(&whole[..cut]), None, "{cut}");
        }
        let mut free_first = 8u32.to_be_bytes().to_vec();
        free_first.extend_from_slice(b"free");
        free_first.extend_from_slice(&whole);
        assert_eq!(card_image_kind(&free_first), None);
        // A box declaring more than the file holds, or a 64-bit size running past the end.
        let mut long = whole.clone();
        long[3] = 0xFF;
        assert_eq!(card_image_kind(&long), None);
        let mut huge = 1u32.to_be_bytes().to_vec();
        huge.extend_from_slice(b"ftyp");
        huge.extend_from_slice(&u64::MAX.to_be_bytes());
        huge.extend_from_slice(b"heic");
        assert_eq!(card_image_kind(&huge), None);
        // By its bytes, never its name: a JPEG is a JPEG whatever it is called, and never read as a HEIC.
        assert_eq!(
            card_image_kind(&jpeg(0xC0, 4032, 3024)),
            Some(CardImageKind::Jpeg)
        );
        let mut over = Heic::one(b"hvc1", 1200, 800).bytes();
        over.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(card_image_kind(&over), None);
    }

    /// The fictional labeled card, made a HEIC on this Mac by `sips` (as an iPhone stores a photo:
    /// a grid of HEVC tiles), into a folder removed afterwards.
    #[cfg(target_os = "macos")]
    fn labeled_card_as_heic(name: &str) -> Vec<u8> {
        labeled_card_as_heic_at(name, None)
    }
    /// The same, resized by `sips` to `size` (width, height) first.
    #[cfg(target_os = "macos")]
    fn labeled_card_as_heic_at(name: &str, size: Option<(u32, u32)>) -> Vec<u8> {
        let dir = std::env::temp_dir().join(format!("ozzie-heic-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("card.heic");
        let mut sips = Command::new("/usr/bin/sips");
        if let Some((w, h)) = size {
            sips.args(["-z", &h.to_string(), &w.to_string()]);
        }
        let made = sips
            .args(["-s", "format", "heic"])
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("helpers/fixtures/fictional-labeled-card.png"),
            )
            .arg("--out")
            .arg(&out)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(made.success());
        let bytes = std::fs::read(&out).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        bytes
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_heic_written_by_this_mac_is_a_heic_and_cut_short_is_not() {
        let heic = labeled_card_as_heic("kind");
        assert_eq!(&heic[4..12], b"ftypheic");
        assert_eq!(card_image_kind(&heic), Some(CardImageKind::Heic));
        assert_eq!(heic_size(&heic), Some((1400, 900)));
        for cut in [heic.len() / 3, heic.len() - 1] {
            assert_eq!(card_image_kind(&heic[..cut]), None, "{cut}");
        }
    }

    /// What this Mac writes at every size is read: a small picture coded larger than it shows (24 by
    /// 24 is coded 160 by 64), grids of 512, 640 by 896 and 896 by 1,024 tiles, a long thin strip;
    /// 8,064 by 6,048 is too many pixels, not no photo.
    #[cfg(target_os = "macos")]
    #[test]
    fn heics_this_mac_writes_at_every_size_are_read() {
        for size in [
            (24, 24),
            (64, 64),
            (100, 100),
            (300, 200),
            (1024, 1024),
            (4032, 3024),
            (5712, 4284),
            (16000, 100),
        ] {
            let heic = labeled_card_as_heic_at("sizes", Some(size));
            assert_eq!(
                heic_size(&heic),
                Some((u64::from(size.0), u64::from(size.1))),
                "{size:?}"
            );
        }
        let max = labeled_card_as_heic_at("sizes", Some((8064, 6048)));
        assert_eq!(card_image_check(&max), Err(CardImageProblem::TooManyPixels));
    }

    /// A one-colour PNG, `side` pixels square: signature, IHDR, one stored (uncompressed) deflate
    /// block of white RGB rows, IEND.
    fn flat_png(side: u32) -> Vec<u8> {
        fn crc32(bytes: &[u8]) -> u32 {
            let mut crc = !0u32;
            for &b in bytes {
                crc ^= u32::from(b);
                for _ in 0..8 {
                    crc = if crc & 1 == 1 {
                        (crc >> 1) ^ 0xEDB8_8320
                    } else {
                        crc >> 1
                    };
                }
            }
            !crc
        }
        fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut out = (body.len() as u32).to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(body);
            out.extend_from_slice(&crc32(&[&kind[..], body].concat()).to_be_bytes());
            out
        }
        let row = [&[0u8][..], &vec![0xFF; side as usize * 3]].concat();
        let raw = row.repeat(side as usize);
        let (mut a, mut b) = (1u32, 0u32);
        for &x in &raw {
            a = (a + u32::from(x)) % 65521;
            b = (b + a) % 65521;
        }
        let len = raw.len() as u16;
        let mut zlib = vec![0x78, 0x01, 1];
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(&raw);
        zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
        let ihdr = [
            &side.to_be_bytes()[..],
            &side.to_be_bytes(),
            &[8, 2, 0, 0, 0],
        ]
        .concat();
        [
            vec![137, 80, 78, 71, 13, 10, 26, 10],
            chunk(b"IHDR", &ihdr),
            chunk(b"IDAT", &zlib),
            chunk(b"IEND", &[]),
        ]
        .concat()
    }

    /// The trap a HEIC once fell into: without Apple's video decoder service it decodes to an empty
    /// picture with no error, which would read as a card with no text. The reader refuses any
    /// picture that decodes to one flat colour as unreadable, so a card is never shown as read when it
    /// wasn't. Runs Ozzie's built reader on a HEIC under the plain reading policy (the HEIC one without
    /// that rule), and on a flat PNG; neither gets as far as Apple's recognizer.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_picture_that_decodes_to_nothing_is_unreadable_not_a_blank_card() {
        let reader = CardReader::at(
            built_helper(CARD_READER),
            home().unwrap(),
            &darwin_user_cache_dir().unwrap(),
        )
        .unwrap();
        let heic = labeled_card_as_heic("unreadable");
        let run = |policy: &str, image: Vec<u8>| {
            run_bounded(
                reader.command(policy),
                image,
                RECOGNITION_TIMEOUT,
                MAX_PIECES_BYTES,
                &never,
            )
        };
        assert_eq!(
            run(CARD_READER_POLICY, heic),
            Err(LocalToolError::Unreadable)
        );
        let flat = flat_png(64);
        assert_eq!(card_image_kind(&flat), Some(CardImageKind::Png));
        assert_eq!(
            run(CARD_READER_POLICY, flat),
            Err(LocalToolError::Unreadable)
        );
    }

    /// The reader's source asks ImageIO for a photo's type, width, height and orientation, and its
    /// primary picture: never a dictionary of location, camera or other EXIF details.
    #[test]
    fn the_card_reader_reads_no_location_or_exif_details() {
        let reader = include_str!("../helpers/card-reader.swift");
        for asked in [
            "kCGImagePropertyGPS",
            "kCGImagePropertyExif",
            "kCGImagePropertyTIFF",
            "kCGImagePropertyIPTC",
            "kCGImagePropertyMakerApple",
            "kCGImagePropertyHEIF",
            "CGImageSourceCopyMetadata",
            "CGImageMetadata",
            "kCGImageSourceCreateThumbnail",
        ] {
            assert!(!reader.contains(asked), "{asked}");
        }
        let properties: Vec<&str> = reader
            .match_indices("kCGImageProperty")
            .map(|(at, _)| {
                reader[at..]
                    .split(|c: char| !c.is_alphanumeric())
                    .next()
                    .unwrap()
            })
            .collect();
        for p in &properties {
            assert!(
                [
                    "kCGImagePropertyPixelWidth",
                    "kCGImagePropertyPixelHeight",
                    "kCGImagePropertyOrientation"
                ]
                .contains(p),
                "{p}"
            );
        }
        assert!(reader.contains("CGImageSourceGetPrimaryImageIndex(source)"));
        assert!(!reader.contains("AtIndex(source, 0"));
    }

    #[test]
    fn listening_has_no_network_no_writes_and_no_other_programs() {
        let rules: Vec<&str> = LISTEN_POLICY.lines().map(str::trim).collect();
        assert_eq!(rules[0], "(version 1)");
        // Later rules win, so every denial comes after the allow and nothing allows them back.
        for denied in [
            "(deny network*)",
            "(deny file-write*)",
            "(deny process-fork)",
            "(deny process-exec)",
        ] {
            assert!(rules.contains(&denied), "{denied}");
        }
        let allows: Vec<&&str> = rules.iter().filter(|r| r.starts_with("(allow")).collect();
        assert_eq!(
            allows,
            [
                &"(allow default)",
                &"(allow process-exec (literal (param \"HELPER\")))"
            ]
        );
        assert_eq!(rules[1], "(allow default)");
    }

    #[test]
    fn the_readers_caches_are_named_after_ozzie_in_the_app_and_after_the_reader_in_development() {
        let home = PathBuf::from("/fictional-home");
        let darwin = PathBuf::from("/fictional-cache/C");
        let app = CardReader::at(
            PathBuf::from("/Applications/Ozzie.app/Contents/MacOS/ozzie-card-reader"),
            home.clone(),
            &darwin,
        )
        .unwrap();
        assert_eq!(app.app, PathBuf::from("/Applications/Ozzie.app"));
        // The app's own identifier: the real app's, or in the test copy of Ozzie its own (never the real app's caches).
        let id = ozzie_native_auth::variant::APP_IDENTIFIER;
        if !ozzie_native_auth::variant::IS_TEST_COPY {
            assert_eq!(id, ozzie_native_auth::variant::REAL_APP_IDENTIFIER);
            assert_eq!(
                app.model_cache,
                PathBuf::from(
                    "/fictional-home/Library/Caches/church.ozzie.desktop/com.apple.e5rt.e5bundlecache"
                )
            );
        }
        assert_eq!(
            app.model_cache,
            PathBuf::from(format!(
                "/fictional-home/Library/Caches/{id}/com.apple.e5rt.e5bundlecache"
            ))
        );
        assert_eq!(
            app.metal_cache,
            PathBuf::from(format!("/fictional-cache/C/{id}/com.apple.metal"))
        );
        let dev = CardReader::at(
            PathBuf::from("/work/ozzie/target/debug/ozzie-card-reader"),
            home,
            &darwin,
        )
        .unwrap();
        assert_eq!(dev.app, PathBuf::from("/work/ozzie/target/debug"));
        assert_eq!(
            dev.model_cache,
            PathBuf::from(
                "/fictional-home/Library/Caches/ozzie-card-reader/com.apple.e5rt.e5bundlecache"
            )
        );
        assert_eq!(
            dev.metal_cache,
            PathBuf::from("/fictional-cache/C/ozzie-card-reader/com.apple.metal")
        );
        // A folder that only looks a bit like an app is not one.
        let odd = CardReader::at(
            PathBuf::from("/work/Ozzie.app/MacOS/ozzie-card-reader"),
            PathBuf::from("/fictional-home"),
            &darwin,
        )
        .unwrap();
        assert_eq!(odd.app, PathBuf::from("/work/Ozzie.app/MacOS"));
    }

    fn piece(t: &str, x: f64, y: f64, w: f64, h: f64) -> String {
        piece_read(t, 1.0, x, y, w, h)
    }
    fn piece_read(t: &str, c: f64, x: f64, y: f64, w: f64, h: f64) -> String {
        serde_json::json!({ "t": t, "c": c, "x": x, "y": y, "w": w, "h": h }).to_string()
    }
    fn text_of(out: &[u8]) -> Result<String, LocalToolError> {
        card_lines(out).map(|lines| lines.text)
    }

    #[test]
    fn lines_holding_a_piece_read_unclearly_are_reported_by_number() {
        // Vision's accurate reader reported 0.3, 0.5 or 1.0 on the fictional cards; at 0.5 its
        // text was already garbled ("orden fuld"), so 0.5 counts as unclear.
        let out = [
            piece_read("Name:", 1.0, 0.05, 0.20, 0.10, 0.04),
            piece_read("Alex Harbor", 0.3, 0.30, 0.20, 0.20, 0.04),
            piece_read("Phone:", 1.0, 0.05, 0.30, 0.10, 0.04),
            piece_read("202-555-0142", 0.51, 0.30, 0.30, 0.20, 0.04),
            piece_read("Prayer request:", 1.0, 0.05, 0.40, 0.15, 0.04),
            piece_read("   ", 0.3, 0.05, 0.45, 0.15, 0.04),
            piece_read("orden fuld", 0.5, 0.05, 0.50, 0.30, 0.04),
        ]
        .join("\n");
        assert_eq!(
            card_lines(out.as_bytes()),
            Ok(CardLines {
                text: "Name: Alex Harbor\nPhone: 202-555-0142\nPrayer request:\norden fuld".into(),
                unclear: vec![0, 3],
            })
        );
        // What the Visitor cards page receives: the text and the numbers of its unclear lines.
        assert_eq!(
            serde_json::to_value(CardText::Read {
                text: "Name: Alex Harbor".into(),
                unclear_lines: vec![0],
            })
            .unwrap(),
            serde_json::json!({ "status": "read", "text": "Name: Alex Harbor", "unclearLines": [0] })
        );
    }

    #[test]
    fn a_printed_label_and_the_handwriting_beside_it_read_as_one_line() {
        // Boxes as Apple Vision reported them for helpers/fixtures/fictional-labeled-card.png:
        // out of reading order, the handwriting a little higher than its printed label.
        let out = [
            piece(
                "VISITOR CARD - FICTIONAL TEST SAMPLE C",
                0.0375,
                0.0710,
                0.4667,
                0.0390,
            ),
            piece("Name:", 0.0427, 0.2495, 0.0684, 0.0371),
            piece("Alex Harbor", 0.2834, 0.2402, 0.1528, 0.0369),
            piece("Phone:", 0.0415, 0.3617, 0.0725, 0.0329),
            piece("202-555-0142", 0.2848, 0.3542, 0.1921, 0.0349),
            piece("Email:", 0.0436, 0.4718, 0.0625, 0.0316),
            piece("Prayer request:", 0.0434, 0.5867, 0.1472, 0.0338),
            piece("alex.harbor@example.org", 0.2830, 0.4567, 0.3046, 0.0562),
            piece(
                "Please call me about the orientation.",
                0.2848,
                0.5646,
                0.4479,
                0.0472,
            ),
        ]
        .join("\n");
        assert_eq!(
            text_of(out.as_bytes()),
            Ok("VISITOR CARD - FICTIONAL TEST SAMPLE C\n\
                \n\
                Name: Alex Harbor\n\
                Phone: 202-555-0142\n\
                Email: alex.harbor@example.org\n\
                Prayer request: Please call me about the orientation."
                .into())
        );
    }

    /// Exactly what Ozzie's release card reader printed for the fictional sample cards
    /// docs/prep/card-samples/visitor-d.png and visitor-a.png on 2026-11-15 (invented people,
    /// example.org addresses, 202-555-01xx numbers). core/test/card-fields.test.ts uses the text
    /// these become.
    const SAMPLE_D: &str = r#"{"t":"WELCOME CARD - FICTIONAL TEST SAMPLE D","h":0.029999999999999916,"y":0.05333333311904764,"c":1,"w":0.5833333333333333,"x":0.05833333723809517}
{"h":0.016666666666666607,"y":0.10166666666301172,"w":0.405,"x":0.05666666657858187,"c":1,"t":"Synthetic lettering; not a photograph or real human handwriting."}
{"t":"Name: Casey Brook","h":0.02833333333333332,"y":0.17166666665709462,"c":1,"w":0.25833333333333336,"x":0.07499999991385138}
{"h":0.020961511929829868,"y":0.23618591063637506,"w":0.0785732905069987,"x":0.07488002117957838,"c":1,"t":"Phone:"}
{"t":"Email:","h":0.02358987967173254,"y":0.3022928977484609,"c":1,"w":0.06888889948527019,"x":0.07477852316918016}
{"h":0.023310052553812688,"y":0.23562092486265007,"w":0.1803892135620117,"x":0.186447819062647,"c":1,"t":"202-555-0163"}
{"t":"casey.brook@example.org","h":0.0345891030629476,"y":0.29943987504720404,"c":1,"w":0.29704284667968744,"x":0.18150478196129127}
{"h":0.023333333333333206,"y":0.36999999997916677,"w":0.09666666666666668,"x":0.07499999991666667,"c":1,"t":"Request:"}
{"t":"I would like to help with the food pantry.","h":0.036756350199381504,"y":0.36358919734390627,"c":1,"w":0.4772941080729167,"x":0.21967052125362366}
{"h":0.018333333333333313,"y":0.5383333333285341,"w":0.435,"x":0.05999999988787086,"c":1,"t":"No real person or church is represented. Do not send messages."}"#;
    const SAMPLE_A: &str = r#"{"h":0.023333333333333317,"c":1,"x":0.05666666658333327,"t":"VISITOR CARD — FICTIONAL TEST SAMPLE A","y":0.05666666666306586,"w":0.5533333333333333}
{"h":0.023383557001749655,"c":1,"x":0.05658787554028512,"t":"Synthetic lettering; not a photograph or real human handwriting.","y":0.09670295925612593,"w":0.40678871154785157}
{"h":0.025000000000000022,"c":1,"x":0.08500000052380954,"t":"Alex Harbor","y":0.14833333315476194,"w":0.15333333333333335}
{"h":0.026705525716145817,"c":1,"x":0.08479020870776183,"t":"202-555-0142","y":0.20228512727701908,"w":0.19374809265136717}
{"h":0.03240307490030925,"c":1,"x":0.08640660784731892,"t":"alex.harbor@example.org","y":0.25527555188738926,"w":0.3005670928955078}
{"h":0.03002091089884429,"c":1,"x":0.08660386804040016,"t":"Please call me about the volunteer orientation.","y":0.3200158587485833,"w":0.5668079121907552}
{"h":0.014999999999999902,"c":1,"x":0.06333333769444427,"t":"No real person or church is represented. Do not send messages.","y":0.45499999975000005,"w":0.43166666666666664}
{"h":0.015000000000000013,"c":1,"x":0.06333333323359071,"t":"Sample B has a deliberately ambiguous contact character. Ask; do not guess.","y":0.4849999999971042,"w":0.5166666666666667}"#;

    #[test]
    fn the_release_readers_pieces_of_sample_d_become_one_line_per_label() {
        // The reader returns "Phone:", "Email:" and then their values as separate pieces, out of
        // order. Each label joins the value on its own row, never the row below; the wide gap above
        // the printed footer stays an empty line, so the footer can't read as more of the request.
        assert_eq!(
            card_lines(SAMPLE_D.as_bytes()),
            Ok(CardLines {
                text: "WELCOME CARD - FICTIONAL TEST SAMPLE D\n\
                       Synthetic lettering; not a photograph or real human handwriting.\n\
                       Name: Casey Brook\n\
                       Phone: 202-555-0163\n\
                       Email: casey.brook@example.org\n\
                       Request: I would like to help with the food pantry.\n\
                       \n\
                       No real person or church is represented. Do not send messages."
                    .into(),
                unclear: vec![],
            })
        );
        assert_eq!(
            text_of(SAMPLE_A.as_bytes()),
            Ok("VISITOR CARD \u{2014} FICTIONAL TEST SAMPLE A\n\
                Synthetic lettering; not a photograph or real human handwriting.\n\
                Alex Harbor\n\
                202-555-0142\n\
                alex.harbor@example.org\n\
                Please call me about the volunteer orientation.\n\
                \n\
                No real person or church is represented. Do not send messages.\n\
                Sample B has a deliberately ambiguous contact character. Ask; do not guess."
                .into())
        );
    }

    #[test]
    fn a_tall_piece_never_pulls_the_next_row_into_its_line() {
        // Big loops make "Alex Harbor" twice as tall as its label and reach down toward the phone
        // row. "Phone:" overlaps that tall piece but not the "Name:" label, so it starts its own line.
        let out = [
            piece("Name:", 0.05, 0.200, 0.10, 0.03),
            piece("Alex Harbor", 0.30, 0.190, 0.20, 0.07),
            piece("Phone:", 0.05, 0.243, 0.10, 0.03),
            piece_read("202-555-0142", 0.3, 0.30, 0.245, 0.20, 0.03),
        ]
        .join("\n");
        assert_eq!(
            card_lines(out.as_bytes()),
            Ok(CardLines {
                text: "Name: Alex Harbor\nPhone: 202-555-0142".into(),
                unclear: vec![1],
            })
        );
        // An unclear piece below a wide gap keeps its own line number, counting the empty line.
        let gap = [
            piece("Request:", 0.05, 0.20, 0.10, 0.03),
            piece_read("faint words", 0.5, 0.05, 0.40, 0.20, 0.03),
        ]
        .join("\n");
        assert_eq!(
            card_lines(gap.as_bytes()),
            Ok(CardLines {
                text: "Request:\n\nfaint words".into(),
                unclear: vec![2],
            })
        );
    }

    #[test]
    fn lines_follow_the_card_top_to_bottom_and_left_to_right() {
        // Two lines close together stay two lines; pieces of one line join left to right; a wide gap
        // before the next line is kept as an empty line.
        let out = [
            piece("for my mom", 0.30, 0.205, 0.20, 0.04),
            piece("Please pray", 0.05, 0.20, 0.20, 0.04),
            piece("who is in the hospital.", 0.05, 0.25, 0.30, 0.04),
            piece("  spaced   out  ", 0.05, 0.40, 0.20, 0.04),
            piece("   ", 0.05, 0.50, 0.20, 0.04),
        ]
        .join("\n");
        assert_eq!(
            text_of(out.as_bytes()),
            Ok("Please pray for my mom\nwho is in the hospital.\n\nspaced out".into())
        );
        assert_eq!(text_of(b""), Ok(String::new()));
        assert_eq!(text_of(b"\n\n"), Ok(String::new()));
    }

    #[test]
    fn malformed_or_oversized_reader_output_is_refused_not_guessed() {
        assert_eq!(text_of(b"Name: Alex"), Err(LocalToolError::Failed));
        assert_eq!(
            text_of(b"{\"t\":\"x\",\"c\":1,\"x\":0.1,\"y\":0.1}"),
            Err(LocalToolError::Failed)
        );
        for bad in [f64::NAN, f64::INFINITY, -0.5, 1.5] {
            let line =
                serde_json::json!({ "t": "x", "c": 1.0, "x": bad, "y": 0.1, "w": 0.1, "h": 0.1 })
                    .to_string();
            assert_eq!(
                text_of(line.as_bytes()),
                Err(LocalToolError::Failed),
                "{bad}"
            );
        }
        // A missing or impossible confidence is a failure, never taken as a clear reading.
        let no_confidence = r#"{"t":"x","x":0.1,"y":0.1,"w":0.1,"h":0.1}"#;
        assert_eq!(
            text_of(no_confidence.as_bytes()),
            Err(LocalToolError::Failed)
        );
        for bad in [-0.1, 1.5] {
            assert_eq!(
                text_of(piece_read("x", bad, 0.1, 0.1, 0.1, 0.1).as_bytes()),
                Err(LocalToolError::Failed),
                "{bad}"
            );
        }
        assert_eq!(
            text_of(piece("x", 0.1, 0.1, 0.1, 0.0).as_bytes()),
            Err(LocalToolError::Failed)
        );
        let long = (0..20)
            .map(|i| piece(&"a".repeat(1000), 0.1, f64::from(i) * 0.04, 0.5, 0.03))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(text_of(long.as_bytes()), Err(LocalToolError::TooMuchText));
    }

    #[test]
    fn helper_exit_codes_say_why_without_any_content() {
        assert_eq!(exit_error(Some(66)), LocalToolError::Unreadable);
        assert_eq!(exit_error(Some(69)), LocalToolError::Unavailable);
        assert_eq!(exit_error(Some(74)), LocalToolError::TooMuchText);
        assert_eq!(exit_error(Some(70)), LocalToolError::Failed);
        assert_eq!(exit_error(None), LocalToolError::Failed);
        assert_eq!(
            run_bounded(
                plain(&["/bin/sh", "-c", "exit 69"]),
                vec![],
                Duration::from_secs(5),
                64,
                &never
            ),
            Err(LocalToolError::Unavailable)
        );
    }

    #[test]
    fn the_practice_picture_is_a_small_png_the_reader_accepts() {
        assert!(card_image_ok(PRACTICE_PICTURE));
        assert_eq!(png_size(PRACTICE_PICTURE), Some((640, 160)));
    }

    #[test]
    fn listening_is_ready_unless_this_mac_cant_or_the_person_said_no() {
        let check = |on: bool, speech: &str, microphone: &str| {
            voice_status(
                serde_json::json!({ "onDevice": on, "speech": speech, "microphone": microphone })
                    .to_string()
                    .as_bytes(),
            )
        };
        // macOS hasn't asked yet: ready, and macOS asks on first use.
        assert_eq!(
            check(true, "not-determined", "not-determined"),
            VoiceStatus::Ready
        );
        assert_eq!(check(true, "authorized", "authorized"), VoiceStatus::Ready);
        assert_eq!(
            check(false, "authorized", "authorized"),
            VoiceStatus::NotAvailable
        );
        assert_eq!(
            check(true, "authorized", "denied"),
            VoiceStatus::NoPermission {
                what: Permission::Microphone
            }
        );
        assert_eq!(
            check(true, "restricted", "authorized"),
            VoiceStatus::NoPermission {
                what: Permission::Speech
            }
        );
        assert_eq!(voice_status(b"not json"), VoiceStatus::NotAvailable);
        assert_eq!(voice_status(b""), VoiceStatus::NotAvailable);
    }

    /// A stand-in listener: a shell script that prints `lines` the way ozzie-listen does.
    fn listener(script: &str) -> Command {
        let mut command = plain(&["/bin/sh", "-c", script]);
        command.stdout(Stdio::piped());
        command
    }

    #[test]
    fn the_words_so_far_stream_out_and_the_last_words_are_the_result() {
        let voice = Voice::default();
        let heard = Mutex::new(Vec::new());
        let result = voice.listen_with(
            listener(
                r#"printf '%s\n' '{"status":"listening"}' '{"text":"Who could"}' '{"text":"Who could cover Greeter"}' '{"final":"Who could cover Greeter?"}'"#,
            ),
            Duration::from_secs(5),
            |words| heard.lock().unwrap().push(words),
        );
        assert_eq!(
            result,
            Ok(Listened::Heard {
                text: "Who could cover Greeter?".into()
            })
        );
        assert_eq!(
            *heard.lock().unwrap(),
            ["Who could", "Who could cover Greeter"]
        );
        assert!(voice.lock().is_none());
    }

    #[test]
    fn listening_reports_why_it_could_not_start_in_closed_words() {
        let voice = Voice::default();
        let run =
            |script: &str| voice.listen_with(listener(script), Duration::from_secs(5), |_| {});
        assert_eq!(
            run(r#"echo '{"status":"not-available"}'; exit 69"#),
            Ok(Listened::NotAvailable)
        );
        assert_eq!(
            run(r#"echo '{"status":"no-permission","what":"microphone"}'; exit 77"#),
            Ok(Listened::NoPermission {
                what: Permission::Microphone
            })
        );
        assert_eq!(
            run(r#"echo '{"status":"no-microphone"}'; exit 69"#),
            Ok(Listened::NoMicrophone)
        );
        // Anything unexpected is a failure that carries nothing the listener printed.
        assert_eq!(run("echo 'something else'"), Err(LocalToolError::Failed));
        assert_eq!(
            run(r#"echo '{"status":"odd"}'"#),
            Err(LocalToolError::Failed)
        );
        assert_eq!(run("exit 0"), Err(LocalToolError::Failed));
    }

    #[test]
    fn stop_lets_the_listener_finish_the_last_words() {
        let voice = Arc::new(Voice::default());
        let other = voice.clone();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            other.stop();
        });
        let started = Instant::now();
        // Like ozzie-listen: listens until its stdin closes, then reports what it heard.
        let result = voice.listen_with(
            listener(r#"echo '{"status":"listening"}'; cat > /dev/null; echo '{"final":"Draft a note"}'"#),
            Duration::from_secs(10),
            |_| {},
        );
        stopper.join().unwrap();
        assert_eq!(
            result,
            Ok(Listened::Heard {
                text: "Draft a note".into()
            })
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn cancel_drops_what_was_heard_and_a_time_limit_ends_a_stuck_listener() {
        let voice = Arc::new(Voice::default());
        let other = voice.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            other.cancel();
        });
        let heard = Mutex::new(Vec::new());
        let started = Instant::now();
        let result = voice.listen_with(
            listener(
                r#"echo '{"text":"Private words"}'; sleep 5; echo '{"final":"Private words"}'"#,
            ),
            Duration::from_secs(10),
            |words| heard.lock().unwrap().push(words),
        );
        canceller.join().unwrap();
        assert_eq!(result, Ok(Listened::Stopped));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(voice.lock().is_none());
        let started = Instant::now();
        assert_eq!(
            voice.listen_with(listener("sleep 5"), Duration::from_millis(300), |_| {}),
            Err(LocalToolError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        // Too much on one line is refused, never cut.
        let long = format!(r#"echo '{{"text":"{}"}}'"#, "a".repeat(MAX_LISTENER_LINE));
        assert_eq!(
            voice.listen_with(listener(&long), Duration::from_secs(5), |_| {}),
            Err(LocalToolError::TooMuchText)
        );
    }

    /// Ozzie's helpers as tauri-build placed them for this build: beside the program, which for
    /// tests is one folder up from target/<profile>/deps.
    fn built_helper(name: &str) -> PathBuf {
        let exe = std::env::current_exe().unwrap().canonicalize().unwrap();
        helper_beside(exe.parent().unwrap(), name).expect("build.rs builds the helpers")
    }

    /// Manual (Apple Vision; the first run on a Mac compiles its models for a minute or two):
    /// `cargo test reads_the_fictional -- --ignored`. Prepares Ozzie's Vision reader on the
    /// practice picture under CARD_PREPARE_POLICY, then reads the fictional labeled card under
    /// CARD_READER_POLICY (no writes). Two more fictional sample cards (visitor-a.png and
    /// visitor-b.png) are read too when `OZZIE_CARD_SAMPLES=/path/to/folder` names a folder holding
    /// them; without it those are skipped with a note.
    #[test]
    #[ignore]
    fn reads_the_fictional_cards_with_ozzies_vision_reader() {
        let reader = CardReader::at(
            built_helper(CARD_READER),
            home().unwrap(),
            &darwin_user_cache_dir().unwrap(),
        )
        .unwrap();
        let cards = Cards::default();
        cards.prepare_reader(&reader).unwrap();
        // Each card under the policy its kind calls for, as `Cards::read` chooses: PNG and JPEG
        // without Apple's video decoder service, HEIC with it.
        let read_bytes = |image: Vec<u8>| {
            let kind = card_image_kind(&image).unwrap();
            assert_eq!(
                reading_policy(kind) == CARD_HEIC_READER_POLICY,
                kind == CardImageKind::Heic
            );
            let out = cards
                .read_with(
                    reader.command(reading_policy(kind)),
                    image,
                    RECOGNITION_TIMEOUT,
                    MAX_PIECES_BYTES,
                    cards.generation.load(Ordering::SeqCst),
                )
                .unwrap();
            card_lines(&out).unwrap()
        };
        let read = |path: &Path| read_bytes(std::fs::read(path).unwrap());
        let png_card = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("helpers/fixtures/fictional-labeled-card.png");
        let CardLines {
            text: labeled,
            unclear,
        } = read(&png_card);
        // Clean print reads clearly: nothing on it is flagged.
        assert_eq!(unclear, Vec::<usize>::new());
        let fields = [
            "Name: Alex Harbor",
            "Phone: 202-555-0142",
            "Email: alex.harbor@example.org",
            "Prayer request: Please call me about the orientation.",
        ];
        for line in fields {
            assert!(labeled.lines().any(|l| l == line), "{line}");
        }
        // The labeled lines in the order read, letter case aside: the JPEG's compression once made
        // Vision read the handwritten "Please" as "please" (2026-11-16), a difference a person checks.
        let in_order = |text: &str| -> Vec<String> {
            text.lines()
                .map(str::to_lowercase)
                .filter(|l| fields.iter().any(|f| f.to_lowercase() == *l))
                .collect()
        };
        // The same card as a JPEG, made by this Mac's sips, under the plain policy too.
        let dir = std::env::temp_dir().join(format!("ozzie-jpeg-card-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let jpeg_card = dir.join("card.jpg");
        let made = Command::new("/usr/bin/sips")
            .args(["-s", "format", "jpeg"])
            .arg(&png_card)
            .arg("--out")
            .arg(&jpeg_card)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(made.success());
        let jpeg = std::fs::read(&jpeg_card).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(card_image_kind(&jpeg), Some(CardImageKind::Jpeg));
        assert_eq!(
            in_order(&read_bytes(jpeg).text),
            in_order(&fields.join("\n"))
        );
        // The same card as HEIC photos, under the HEIC policy: as stored, stored sideways with an
        // orientation to turn it upright (as a phone does), and as the primary (second) of two
        // pictures whose first is Ozzie's practice picture. Each gives the PNG's labeled lines, in
        // the same order, and nothing from the other picture. The public copy of Ozzie doesn't carry
        // these three files; they are skipped with a note where they aren't.
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("helpers/fixtures");
        for heic in [
            "fictional-labeled-card.heic",
            "fictional-labeled-card-sideways.heic",
            "fictional-labeled-card-second.heic",
        ] {
            let Ok(image) = std::fs::read(fixtures.join(heic)) else {
                println!("helpers/fixtures/{heic} isn't here: skipped");
                continue;
            };
            assert_eq!(card_image_kind(&image), Some(CardImageKind::Heic));
            let CardLines { text, unclear } = read_bytes(image);
            assert_eq!(in_order(&text), in_order(&fields.join("\n")), "{heic}");
            assert_eq!(unclear, Vec::<usize>::new(), "{heic}");
            assert!(!text.contains("getting ready"), "{heic}");
        }
        // Two more fictional sample cards, read only when OZZIE_CARD_SAMPLES names their folder.
        let Some(samples) = std::env::var_os("OZZIE_CARD_SAMPLES").map(PathBuf::from) else {
            println!("OZZIE_CARD_SAMPLES isn't set: skipped the two fictional sample cards");
            return;
        };
        assert!(samples.is_dir(), "OZZIE_CARD_SAMPLES isn't a folder");
        let a = read(&samples.join("visitor-a.png")).text;
        assert!(a.lines().any(|l| l == "Alex Harbor"));
        assert!(a.lines().any(|l| l == "202-555-0142"));
        assert!(
            a.lines()
                .any(|l| l == "Please call me about the volunteer orientation.")
        );
        // Sample B's deliberately ambiguous oval came back as a confident capital O on 2026-11-14
        // (macOS 27.2), not as uncertain (confidence 1.0, no other candidate): low confidence
        // catches some misreadings, never all, so every field still needs a person to check the photo.
        let b = read(&samples.join("visitor-b.png")).text;
        assert!(b.lines().any(|l| l == "Jordan Field"));
    }

    /// Manual: `cargo test asks_nothing -- --ignored`. Runs the built listener's `--check` under
    /// LISTEN_POLICY; it reports permissions without asking the person anything.
    #[test]
    #[ignore]
    fn the_listener_check_asks_nothing() {
        let helper = built_helper(LISTENER);
        let out = run_bounded(
            listener_command(&helper, &["--check"]),
            Vec::new(),
            Duration::from_secs(10),
            4096,
            &never,
        )
        .unwrap();
        let report: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert!(report["onDevice"].is_boolean());
        assert!(report["microphone"].is_string() && report["speech"].is_string());
    }
}
