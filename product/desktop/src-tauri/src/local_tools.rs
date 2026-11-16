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
/// silently reads nothing, without the Neural Engine or /usr/share it fails.
pub const CARD_READER_POLICY: &str = card_reader_rules!();

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
/// Ozzie's bundle identifier (tauri.conf.json). Inside Ozzie.app, Apple's recognizer names its
/// model caches after it; in a development build, after the reader's file name.
const BUNDLE_ID: &str = "church.ozzie.desktop";
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

/// Ozzie's helpers say why they stopped with an exit code (sysexits): 69 this Mac can't do it,
/// 74 too much text. Anything else, including a crash, is a plain failure.
fn exit_error(code: Option<i32>) -> LocalToolError {
    match code {
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
/// The two kinds of photo the card reader opens (helpers/card-reader.swift: public.png and
/// public.jpeg only), told apart by their bytes, never by a file name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardImageKind {
    Png,
    Jpeg,
}
/// PNG or JPEG within the review's size limit, checked before any process starts: by signature,
/// and by the picture size its header declares (never zero, at most MAX_IMAGE_PIXELS).
pub fn card_image_kind(image: &[u8]) -> Option<CardImageKind> {
    if image.is_empty() || image.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let (kind, (width, height)) = match png_size(image) {
        Some(size) => (CardImageKind::Png, size),
        None => (CardImageKind::Jpeg, jpeg_size(image)?),
    };
    (width > 0 && height > 0 && width.saturating_mul(height) <= MAX_IMAGE_PIXELS).then_some(kind)
}
pub fn card_image_ok(image: &[u8]) -> bool {
    card_image_kind(image).is_some()
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
        if !card_image_ok(&image) {
            return Err(LocalToolError::InvalidInput);
        }
        // A review that closes while the reader is still being prepared drops this card.
        let since = self.generation.load(Ordering::SeqCst);
        match self.recognizer() {
            Recognizer::Vision(reader) => {
                let out = self.read_with(
                    reader.command(CARD_READER_POLICY),
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
    if !card_image_ok(image) {
        return Err(LocalToolError::InvalidInput);
    }
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
        // Preparing is reading plus writing the two model caches, and nothing else.
        let extra = CARD_PREPARE_POLICY
            .strip_prefix(CARD_READER_POLICY)
            .unwrap();
        let extra = rules(extra);
        assert_eq!(
            extra,
            "(allow file-write* (subpath (param \"MODEL_CACHE\")) (subpath (param \"METAL_CACHE\"))) \
             (allow file-issue-extension \
             (require-all (extension-class \"com.apple.app-sandbox.read\") (subpath (param \"MODEL_CACHE\"))))"
        );
        assert!(!extra.contains("network"));
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
        assert_eq!(
            app.model_cache,
            PathBuf::from(
                "/fictional-home/Library/Caches/church.ozzie.desktop/com.apple.e5rt.e5bundlecache"
            )
        );
        assert_eq!(
            app.metal_cache,
            PathBuf::from("/fictional-cache/C/church.ozzie.desktop/com.apple.metal")
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
        let read = |path: &Path| {
            let image = std::fs::read(path).unwrap();
            assert!(card_image_ok(&image));
            let out = cards
                .read_with(
                    reader.command(CARD_READER_POLICY),
                    image,
                    RECOGNITION_TIMEOUT,
                    MAX_PIECES_BYTES,
                    cards.generation.load(Ordering::SeqCst),
                )
                .unwrap();
            card_lines(&out).unwrap()
        };
        let CardLines {
            text: labeled,
            unclear,
        } = read(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("helpers/fixtures/fictional-labeled-card.png"),
        );
        // Clean print reads clearly: nothing on it is flagged.
        assert_eq!(unclear, Vec::<usize>::new());
        for line in [
            "Name: Alex Harbor",
            "Phone: 202-555-0142",
            "Email: alex.harbor@example.org",
            "Prayer request: Please call me about the orientation.",
        ] {
            assert!(labeled.lines().any(|l| l == line), "{line}");
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
