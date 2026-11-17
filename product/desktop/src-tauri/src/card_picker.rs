//! "Choose card photos" on the Visitor cards page: Ozzie's own Mac open panel, offering only the
//! picture types the card reader opens (helpers/card-reader.swift: PNG, JPEG and HEIC, the format
//! an iPhone saves photos in). The page asks
//! for the panel and gets back photos, never a path, and it cannot name a file for this Mac to
//! read: the command takes no arguments. The panel's filter is a convenience; what keeps anything
//! else out is the check here on every chosen file before its bytes go anywhere: a regular file
//! (not a link, folder, package or device), opened without following links, within the review's
//! limits, and a PNG, JPEG or HEIC by its own bytes with a sensible picture size. The reader checks the
//! bytes again before it runs. Photos live only in memory for this one call: nothing is saved,
//! logged or kept here after they are handed to the page.
use crate::local_tools::{CardImageKind, CardImageProblem, MAX_IMAGE_BYTES, card_image_check};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Same limits as the card review (core/src/card-review/lifecycle.ts): at most 8 photos at a
/// time, 8 MB each and 24 MB together.
pub const MAX_CARDS: usize = 8;
pub const MAX_BATCH_BYTES: usize = 24 * 1024 * 1024;
/// What the panel offers, as Uniform Type Identifiers: the reader's own types (public.heif is a
/// HEIC whose file names only the general picture brand).
pub const CARD_PHOTO_TYPES: [&str; 4] = ["public.png", "public.jpeg", "public.heic", "public.heif"];

/// Closed codes only; never a file name, path or anything from a photo.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CardPickError {
    /// A panel is already open.
    Busy,
    /// The panel couldn't be shown on this Mac.
    Unavailable,
    TooMany,
    /// One photo is over 8 MB.
    TooLarge,
    /// The photos are over 24 MB together.
    TooMuchTogether,
    /// Not a PNG, JPEG or HEIC by its bytes (or not a plain file at all).
    NotAPhoto,
    /// A picture of more than 40 million pixels (a 48-megapixel iPhone photo, say).
    TooManyPixels,
    /// It couldn't be opened or changed while being read.
    Unreadable,
}

/// One chosen photo: a plain file, not followed through a link, read within the limit, and a PNG,
/// JPEG or HEIC by its bytes. A file swapped for another between the check and the read is refused.
pub fn read_card_photo(path: &Path) -> Result<(CardImageKind, Vec<u8>), CardPickError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let before = std::fs::symlink_metadata(path).map_err(|_| CardPickError::Unreadable)?;
    // A link, folder (a package is one), pipe, socket or device is never a card photo.
    if !before.file_type().is_file() {
        return Err(CardPickError::NotAPhoto);
    }
    if before.len() > MAX_IMAGE_BYTES as u64 {
        return Err(CardPickError::TooLarge);
    }
    // No following a link put in its place, and never waiting on a pipe put in its place.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| CardPickError::Unreadable)?;
    let opened = file.metadata().map_err(|_| CardPickError::Unreadable)?;
    if !opened.file_type().is_file() || opened.dev() != before.dev() || opened.ino() != before.ino()
    {
        return Err(CardPickError::Unreadable);
    }
    if opened.len() > MAX_IMAGE_BYTES as u64 {
        return Err(CardPickError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CardPickError::Unreadable)?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(CardPickError::TooLarge);
    }
    let kind = card_image_check(&bytes).map_err(|problem| match problem {
        CardImageProblem::NotAPhoto => CardPickError::NotAPhoto,
        CardImageProblem::TooManyPixels => CardPickError::TooManyPixels,
    })?;
    Ok((kind, bytes))
}

/// Every chosen photo, or none: one that can't be used refuses the whole choice, as the review
/// does, so the person chooses again rather than missing a card.
pub fn read_card_photos(paths: &[PathBuf]) -> Result<Vec<(CardImageKind, Vec<u8>)>, CardPickError> {
    if paths.len() > MAX_CARDS {
        return Err(CardPickError::TooMany);
    }
    let mut photos = Vec::with_capacity(paths.len());
    let mut total = 0usize;
    for path in paths {
        let photo = read_card_photo(path)?;
        total += photo.1.len();
        if total > MAX_BATCH_BYTES {
            return Err(CardPickError::TooMuchTogether);
        }
        photos.push(photo);
    }
    Ok(photos)
}

/// The photos as one binary reply, in the order chosen: per photo one kind byte (1 PNG, 2 JPEG, 3 HEIC)
/// and its length as 4 big-endian bytes, then its bytes. No file names. Nothing chosen is empty.
/// The page reads it with `cardPhotoFiles` (src/cards-page.tsx).
pub fn frame(photos: &[(CardImageKind, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(photos.iter().map(|(_, b)| b.len() + 5).sum());
    for (kind, bytes) in photos {
        out.push(match kind {
            CardImageKind::Png => 1,
            CardImageKind::Jpeg => 2,
            CardImageKind::Heic => 3,
        });
        // At most MAX_IMAGE_BYTES, so it always fits.
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// The panel's types as UTType objects. UTType has no binding among Ozzie's crates; it is part of
/// every macOS Ozzie runs on (14+), loaded with AppKit.
#[cfg(target_os = "macos")]
fn card_photo_types()
-> Result<objc2::rc::Retained<objc2_foundation::NSArray<objc2::runtime::AnyObject>>, CardPickError>
{
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSArray, NSString};
    let ut_type = AnyClass::get(c"UTType").ok_or(CardPickError::Unavailable)?;
    let mut types: Vec<Retained<AnyObject>> = Vec::with_capacity(CARD_PHOTO_TYPES.len());
    for identifier in CARD_PHOTO_TYPES {
        let identifier = NSString::from_str(identifier);
        // SAFETY: +[UTType typeWithIdentifier:] takes an NSString and returns a UTType or nil.
        let found: Option<Retained<AnyObject>> =
            unsafe { msg_send![ut_type, typeWithIdentifier: &*identifier] };
        types.push(found.ok_or(CardPickError::Unavailable)?);
    }
    Ok(NSArray::from_retained_slice(&types))
}

/// The open panel, on the main thread (AppKit requires it): files only, several at once, PNG, JPEG
/// and HEIC offered. `Ok(vec![])` when the person cancels.
#[cfg(target_os = "macos")]
fn run_panel() -> Result<Vec<PathBuf>, CardPickError> {
    use objc2::msg_send;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::{MainThreadMarker, NSString};
    let mtm = MainThreadMarker::new().ok_or(CardPickError::Unavailable)?;
    let types = card_photo_types()?;
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(false);
    panel.setAllowsMultipleSelection(true);
    panel.setTreatsFilePackagesAsDirectories(false);
    panel.setCanCreateDirectories(false);
    panel.setShowsHiddenFiles(false);
    panel.setResolvesAliases(true);
    // SAFETY: -[NSSavePanel setAllowedContentTypes:] takes an NSArray of UTType, which `types` is.
    let _: () = unsafe { msg_send![&*panel, setAllowedContentTypes: &*types] };
    panel.setTitle(Some(&NSString::from_str("Choose card photos")));
    panel.setMessage(Some(&NSString::from_str(
        "Choose PNG, JPEG or HEIC (iPhone) photos of visitor cards: up to 8 at a time, 8 MB each.",
    )));
    panel.setPrompt(Some(&NSString::from_str("Choose")));
    if panel.runModal() != NSModalResponseOK {
        return Ok(Vec::new());
    }
    let urls = panel.URLs();
    if urls.count() > MAX_CARDS {
        return Err(CardPickError::TooMany);
    }
    urls.iter()
        .map(|url| {
            if url.isFileURL() {
                url.to_file_path().ok_or(CardPickError::Unreadable)
            } else {
                Err(CardPickError::Unreadable)
            }
        })
        .collect()
}
#[cfg(not(target_os = "macos"))]
fn run_panel() -> Result<Vec<PathBuf>, CardPickError> {
    Err(CardPickError::Unavailable)
}

/// One panel at a time.
static PICKING: AtomicBool = AtomicBool::new(false);
struct Picking;
impl Picking {
    fn begin() -> Result<Self, CardPickError> {
        PICKING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| CardPickError::Busy)
    }
}
impl Drop for Picking {
    fn drop(&mut self) {
        PICKING.store(false, Ordering::SeqCst);
    }
}

/// "Choose card photos": shows the panel and replies with the checked photos as one binary body
/// (`frame`); an empty body when the person cancels.
#[tauri::command]
pub async fn choose_card_photos(
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, CardPickError> {
    let _picking = Picking::begin()?;
    let (send, receive) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(run_panel());
    })
    .map_err(|_| CardPickError::Unavailable)?;
    let photos = tauri::async_runtime::spawn_blocking(move || {
        let paths = receive.recv().map_err(|_| CardPickError::Unavailable)??;
        read_card_photos(&paths)
    })
    .await
    .map_err(|_| CardPickError::Unavailable)??;
    Ok(tauri::ipc::Response::new(frame(&photos)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_tools::tests::{heic, jpeg, png};

    /// A folder of fictional test files, removed afterwards.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("ozzie-card-picker-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_png_jpeg_or_heic_is_read_by_its_bytes_whatever_its_name() {
        let dir = Scratch::new("kinds");
        let card = png(1200, 800);
        assert_eq!(
            read_card_photo(&dir.file("card.png", &card)),
            Ok((CardImageKind::Png, card.clone()))
        );
        // A photo with a wrong or missing extension is still its own kind.
        assert_eq!(
            read_card_photo(&dir.file("card.txt", &card)).map(|(k, _)| k),
            Ok(CardImageKind::Png)
        );
        let photo = jpeg(0xC0, 4032, 3024);
        assert_eq!(
            read_card_photo(&dir.file("IMG_0001", &photo)).map(|(k, _)| k),
            Ok(CardImageKind::Jpeg)
        );
        // An iPhone photo is a HEIC by its bytes, under any name; a JPEG named like a HEIC is a JPEG.
        let iphone = heic(4032, 3024);
        for name in ["IMG_0002.HEIC", "card.heif", "card.jpg"] {
            assert_eq!(
                read_card_photo(&dir.file(name, &iphone)),
                Ok((CardImageKind::Heic, iphone.clone())),
                "{name}"
            );
        }
        assert_eq!(
            read_card_photo(&dir.file("IMG_0003.HEIC", &photo)).map(|(k, _)| k),
            Ok(CardImageKind::Jpeg)
        );
        // Cut short, a HEIC is no photo.
        assert_eq!(
            read_card_photo(&dir.file("cut.heic", &iphone[..iphone.len() - 1])),
            Err(CardPickError::NotAPhoto)
        );
    }

    #[test]
    fn anything_that_is_not_a_png_jpeg_or_heic_is_refused_even_named_like_one() {
        let dir = Scratch::new("refused");
        for (name, bytes) in [
            (
                "card.png",
                b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
            ),
            ("card.jpg", b"GIF89a\x01\x00\x01\x00".to_vec()),
            ("card.jpeg", b"%PDF-1.7\n".to_vec()),
            // A HEIC file type with nothing after it, a video and an AVIF named like HEIC, and TIFF:
            // none is a picture the card reader opens.
            ("card.heic", b"\0\0\0\x18ftypheic\0\0\0\0mif1heic".to_vec()),
            (
                "clip.heic",
                b"\0\0\0\x18ftypisom\0\0\x02\0isommp41\0\0\0\x08mdat".to_vec(),
            ),
            (
                "movie.heic",
                b"\0\0\0\x14ftypqt  \0\0\0\0qt  \0\0\0\x08mdat".to_vec(),
            ),
            (
                "photo.heic",
                b"\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf".to_vec(),
            ),
            ("card.tiff", b"II*\0\x08\0\0\0".to_vec()),
            ("empty.png", Vec::new()),
            // A signature alone.
            ("header.png", vec![137, 80, 78, 71, 13, 10, 26, 10]),
        ] {
            assert_eq!(
                read_card_photo(&dir.file(name, &bytes)),
                Err(CardPickError::NotAPhoto),
                "{name}"
            );
        }
    }

    /// Review Z, I3: a picture over 40 million pixels, of any kind (a 48-megapixel iPhone photo), is
    /// refused with its own code, not as no photo at all; 40 million exactly is read.
    #[test]
    fn a_picture_over_40_megapixels_is_refused_as_too_many_pixels() {
        let dir = Scratch::new("pixels");
        for (name, bytes) in [
            ("huge.png", png(8000, 5001)),
            ("huge.jpg", jpeg(0xC0, 65_535, 65_535)),
            ("IMG_0004.HEIC", heic(8064, 6048)),
        ] {
            assert_eq!(
                read_card_photo(&dir.file(name, &bytes)),
                Err(CardPickError::TooManyPixels),
                "{name}"
            );
        }
        assert!(read_card_photo(&dir.file("limit.heic", &heic(8000, 5000))).is_ok());
        assert_eq!(
            read_card_photos(&[
                dir.file("card.png", &png(1200, 800)),
                dir.file("big.heic", &heic(8064, 6048))
            ]),
            Err(CardPickError::TooManyPixels)
        );
    }

    #[test]
    fn links_folders_packages_and_pipes_are_never_read() {
        let dir = Scratch::new("special");
        let real = dir.file("card.png", &png(1200, 800));
        let link = dir.0.join("link.png");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(read_card_photo(&link), Err(CardPickError::NotAPhoto));
        // A package looks like one file in the panel but is a folder.
        let package = dir.0.join("Cards.photoslibrary");
        std::fs::create_dir(&package).unwrap();
        assert_eq!(read_card_photo(&package), Err(CardPickError::NotAPhoto));
        let pipe = dir.0.join("pipe.png");
        let made = std::process::Command::new("/usr/bin/mkfifo")
            .arg(&pipe)
            .status()
            .unwrap();
        assert!(made.success());
        // Refused without ever waiting for a writer.
        assert_eq!(read_card_photo(&pipe), Err(CardPickError::NotAPhoto));
        assert_eq!(
            read_card_photo(&dir.0.join("missing.png")),
            Err(CardPickError::Unreadable)
        );
    }

    #[test]
    fn a_photo_over_8_mb_is_refused_before_it_is_read() {
        let dir = Scratch::new("large");
        let mut big = png(1200, 800);
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(
            read_card_photo(&dir.file("big.png", &big)),
            Err(CardPickError::TooLarge)
        );
        let mut limit = png(1200, 800);
        limit.resize(MAX_IMAGE_BYTES, 0);
        assert!(read_card_photo(&dir.file("limit.png", &limit)).is_ok());
    }

    #[test]
    fn a_choice_is_all_good_or_refused_whole_within_the_review_limits() {
        let dir = Scratch::new("batch");
        let card = dir.file("card.png", &png(1200, 800));
        let note = dir.file("notes.png", b"# not a photo");
        assert_eq!(read_card_photos(&[]).map(|p| p.len()), Ok(0));
        assert_eq!(
            read_card_photos(&vec![card.clone(); MAX_CARDS]).map(|p| p.len()),
            Ok(MAX_CARDS)
        );
        assert_eq!(
            read_card_photos(&vec![card.clone(); MAX_CARDS + 1]),
            Err(CardPickError::TooMany)
        );
        assert_eq!(
            read_card_photos(&[card.clone(), note]),
            Err(CardPickError::NotAPhoto)
        );
        // Three photos of 8 MB fit together; a fourth goes over 24 MB.
        let mut full = png(1200, 800);
        full.resize(MAX_IMAGE_BYTES, 0);
        let full = dir.file("full.png", &full);
        assert_eq!(
            read_card_photos(&vec![full.clone(); 3]).map(|p| p.len()),
            Ok(3)
        );
        assert_eq!(
            read_card_photos(&[full.clone(), full.clone(), full, card]),
            Err(CardPickError::TooMuchTogether)
        );
    }

    #[test]
    fn photos_go_back_as_kind_length_and_bytes_with_no_file_names() {
        let a = png(1200, 800);
        let b = jpeg(0xC0, 640, 480);
        let c = heic(4032, 3024);
        let out = frame(&[
            (CardImageKind::Png, a.clone()),
            (CardImageKind::Jpeg, b.clone()),
            (CardImageKind::Heic, c.clone()),
        ]);
        let mut expected = vec![1];
        expected.extend_from_slice(&(a.len() as u32).to_be_bytes());
        expected.extend_from_slice(&a);
        expected.push(2);
        expected.extend_from_slice(&(b.len() as u32).to_be_bytes());
        expected.extend_from_slice(&b);
        expected.push(3);
        expected.extend_from_slice(&(c.len() as u32).to_be_bytes());
        expected.extend_from_slice(&c);
        assert_eq!(out, expected);
        assert!(frame(&[]).is_empty());
    }

    #[test]
    fn the_panel_offers_only_what_the_reader_opens() {
        assert_eq!(
            CARD_PHOTO_TYPES,
            ["public.png", "public.jpeg", "public.heic", "public.heif"]
        );
        let reader = include_str!("../helpers/card-reader.swift");
        assert!(reader.contains(
            r#"let readerTypes: Set<String> = ["public.png", "public.jpeg", "public.heic", "public.heif"]"#
        ));
        assert!(reader.contains("readerTypes.contains(type)"));
    }

    /// On this Mac, without showing anything: every type exists as UTType, describes the PNG, JPEG,
    /// HEIC and HEIF types, and the open panel takes `setAllowedContentTypes:`.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_panel_types_resolve_on_this_mac() {
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2::{msg_send, sel};
        use objc2_foundation::NSString;
        let types = card_photo_types().unwrap();
        assert_eq!(types.count(), 4);
        let identifiers: Vec<String> = types
            .iter()
            .map(|t: objc2::rc::Retained<AnyObject>| {
                // SAFETY: -[UTType identifier] returns an NSString.
                let id: objc2::rc::Retained<NSString> = unsafe { msg_send![&*t, identifier] };
                id.to_string()
            })
            .collect();
        assert_eq!(identifiers, CARD_PHOTO_TYPES);
        let panel = AnyClass::get(c"NSOpenPanel").unwrap();
        assert!(
            panel
                .instance_method(sel!(setAllowedContentTypes:))
                .is_some()
        );
    }

    #[test]
    fn one_panel_at_a_time() {
        let first = Picking::begin().unwrap();
        assert!(matches!(Picking::begin(), Err(CardPickError::Busy)));
        drop(first);
        assert!(Picking::begin().is_ok());
    }

    #[test]
    fn refusals_are_closed_codes() {
        let codes = [
            CardPickError::Busy,
            CardPickError::Unavailable,
            CardPickError::TooMany,
            CardPickError::TooLarge,
            CardPickError::TooMuchTogether,
            CardPickError::NotAPhoto,
            CardPickError::TooManyPixels,
            CardPickError::Unreadable,
        ]
        .map(|e| serde_json::to_string(&e).unwrap());
        assert_eq!(
            codes,
            [
                "\"busy\"",
                "\"unavailable\"",
                "\"too-many\"",
                "\"too-large\"",
                "\"too-much-together\"",
                "\"not-a-photo\"",
                "\"too-many-pixels\"",
                "\"unreadable\"",
            ]
        );
    }
}
