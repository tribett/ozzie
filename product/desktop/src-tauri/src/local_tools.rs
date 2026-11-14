//! On-device helpers for Today's spoken briefing (macOS `say`) and visitor-card text
//! recognition (the locally installed Tesseract). Each runs as a child process under its own
//! deny-by-default sandbox profile with an empty environment. Text and image bytes travel only
//! over pipes and live only in memory for one call: no temporary files, no recordings, no logs.
//! Errors are closed codes that never carry card or briefing content.
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

const SANDBOX: &str = "/usr/bin/sandbox-exec";

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

const SAY: &str = "/usr/bin/say";
/// A fixed voice and rate; the webview can't choose either. 170 words per minute matches
/// `SPOKEN_WORDS_PER_MINUTE` in core/src/spoken-briefing.ts.
const VOICE: &str = "Samantha";
const RATE: &str = "170";
/// About three minutes of speech; the briefing script stays near two.
pub const MAX_SPEECH_CHARS: usize = 4000;
const MAX_PLAYBACK: Duration = Duration::from_secs(300);

const TESSERACT: &str = "/opt/homebrew/bin/tesseract";
/// Same per-image limit as the card review lifecycle.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Largest picture the recognizer decodes, in pixels: a small file can declare a huge image, and
/// decoding it would take far more memory than its bytes suggest. A phone photo is about 12 MP.
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;
/// Recognized text beyond this is refused, never truncated.
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
const RECOGNITION_TIMEOUT: Duration = Duration::from_secs(30);

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
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum CardText {
    Read { text: String },
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
fn run_bounded(
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
        return Err(LocalToolError::Failed);
    }
    Ok(out)
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
/// PNG or JPEG within the review's size limit, checked before any process starts: by signature,
/// and by the picture size its header declares (never zero, at most MAX_IMAGE_PIXELS).
pub fn card_image_ok(image: &[u8]) -> bool {
    if image.is_empty() || image.len() > MAX_IMAGE_BYTES {
        return false;
    }
    png_size(image)
        .or_else(|| jpeg_size(image))
        .is_some_and(|(width, height)| {
            width > 0 && height > 0 && width.saturating_mul(height) <= MAX_IMAGE_PIXELS
        })
}

/// One card at a time. The image goes to Tesseract on stdin and the text comes back on stdout.
/// `cancel` (the review closed, or Ozzie is quitting) kills the reading in progress.
#[derive(Default)]
pub struct Cards {
    busy: AtomicBool,
    generation: AtomicU64,
}
struct Reading<'a>(&'a AtomicBool);
impl Drop for Reading<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Cards {
    pub fn read(&self, image: Vec<u8>) -> Result<CardText, LocalToolError> {
        if !card_image_ok(&image) {
            return Err(LocalToolError::InvalidInput);
        }
        if !Path::new(TESSERACT).is_file() || !Path::new(SANDBOX).is_file() {
            return Ok(CardText::NotAvailable);
        }
        self.read_with(
            sandboxed(TESSERACT_POLICY, "C", &[TESSERACT, "stdin", "stdout"]),
            image,
            RECOGNITION_TIMEOUT,
        )
    }
    fn read_with(
        &self,
        command: Command,
        image: Vec<u8>,
        timeout: Duration,
    ) -> Result<CardText, LocalToolError> {
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
        let generation = self.generation.load(Ordering::SeqCst);
        let cancelled = || self.generation.load(Ordering::SeqCst) != generation;
        let out = run_bounded(command, image, timeout, MAX_TEXT_BYTES, &cancelled)?;
        if cancelled() {
            return Err(LocalToolError::Cancelled);
        }
        Ok(CardText::Read {
            text: String::from_utf8_lossy(&out).into_owned(),
        })
    }
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct LocalTools {
    speech: Arc<Speech>,
    cards: Arc<Cards>,
}
impl LocalTools {
    /// App exit: no briefing keeps talking and no card keeps being read after Ozzie closes.
    pub fn stop(&self) {
        self.speech.stop();
        self.cards.cancel();
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

#[cfg(test)]
mod tests {
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
        assert_eq!(
            cards.read_with(plain(&["/bin/sleep", "5"]), vec![], Duration::from_secs(10)),
            Err(LocalToolError::Cancelled)
        );
        canceller.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        // The next card isn't refused because of the old one.
        assert_eq!(
            cards.read_with(
                plain(&["/bin/cat"]),
                b"Name: Fictional".to_vec(),
                Duration::from_secs(5)
            ),
            Ok(CardText::Read {
                text: "Name: Fictional".into()
            })
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
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }
    /// A JPEG with an APP0 segment, then a baseline frame declaring `width` x `height`.
    fn jpeg(marker: u8, width: u16, height: u16) -> Vec<u8> {
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
    fn a_second_card_waits_its_turn() {
        let cards = Cards::default();
        cards.busy.store(true, Ordering::SeqCst);
        let started = Instant::now();
        assert_eq!(
            cards.read_with(plain(&["/bin/cat"]), vec![], Duration::from_secs(5)),
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
    /// Runs the installed recognizer under TESSERACT_POLICY on a generated fictional card.
    #[test]
    #[ignore]
    fn reads_a_synthetic_card_with_the_installed_recognizer() {
        let path = std::env::var("OZZIE_SYNTHETIC_CARD").expect("OZZIE_SYNTHETIC_CARD");
        let image = std::fs::read(path).unwrap();
        match Cards::default().read(image).unwrap() {
            CardText::Read { text } => assert!(text.contains("Name:")),
            CardText::NotAvailable => panic!("recognizer not installed"),
        }
    }
}
