//! Models Ozzie downloads and sets up itself, over a fake Ollama (its lists, its stream, its create and delete) and,
//! for the connection, a real listener on this Mac's loopback. Fictional text only; nothing here reaches the internet.
use super::*;
use crate::local_ai::{LocalFind, Verdict};
use std::sync::Arc;

const GIB: u64 = 1_073_741_824;
/// Ollama 0.40.16's own lines for `qwen3:8b` (measured, 2026-11-18), the download made to move in two steps.
fn qwen3_8b_lines() -> Vec<String> {
    let weights = "sha256:a3de86cd1c132c822487ededd47a324c50491393e6565cd14bafa40d0b8e686f";
    vec![
        r#"{"status":"pulling manifest"}"#.into(),
        format!(r#"{{"status":"pulling a3de86cd1c13","digest":"{weights}","total":5225374496}}"#),
        format!(
            r#"{{"status":"pulling a3de86cd1c13","digest":"{weights}","total":5225374496,"completed":1200000000}}"#
        ),
        format!(
            r#"{{"status":"pulling a3de86cd1c13","digest":"{weights}","total":5225374496,"completed":5225374496}}"#
        ),
        r#"{"status":"pulling ae370d884f10","digest":"sha256:ae370d884f108d16e7cc8fd5259ebc5773a0afa6e078b11f4ed7e39a27e0dfc4","total":1723,"completed":1723}"#.into(),
        r#"{"status":"pulling d18a5cc71b84","digest":"sha256:d18a5cc71b84bc4af394a31116bd3932b42241de70c77d2b76d69a314ec8aa12","total":11338,"completed":11338}"#.into(),
        r#"{"status":"pulling cff3f395ef37","digest":"sha256:cff3f395ef3756ab63e58b0ad1b32bb6f802905cae1472e6a12034e4246fbbdb","total":120,"completed":120}"#.into(),
        r#"{"status":"pulling 05a61d37b084","digest":"sha256:05a61d37b08453e59290add468e3bb2f688e23a01e967fecb0e2fa41218cea76","total":487,"completed":487}"#.into(),
        r#"{"status":"verifying sha256 digest"}"#.into(),
        r#"{"status":"writing manifest"}"#.into(),
        r#"{"status":"removing unused layers"}"#.into(),
        r#"{"status":"success"}"#.into(),
    ]
}

/// One thing the fake stream does: say a line, stay quiet once, or wait.
#[derive(Clone)]
enum Say {
    Line(String),
    Quiet,
    Wait(Duration),
}
/// Ollama on this Mac, as Ozzie sees it: the models it lists, what was created and deleted, its download stream.
#[derive(Default)]
struct Ollama {
    running: bool,
    models: Mutex<Vec<String>>,
    /// Ozzie's copies and the room each was given.
    rooms: Mutex<BTreeMap<String, u64>>,
    stream: Vec<Say>,
    /// The download's answer when it isn't 200.
    stream_status: Option<u16>,
    /// The download adds this model to the list when its stream said success.
    pulled_adds: bool,
    create_status: Option<u16>,
    delete_status: BTreeMap<String, u16>,
    pulls: Mutex<Vec<Value>>,
    posts: Mutex<Vec<(String, Value)>>,
    deletes: Mutex<Vec<Value>>,
    chats: Mutex<u32>,
    /// What "the person" does on another screen as the check begins.
    on_check: Option<Box<dyn Fn() + Send + Sync>>,
    /// How many lines `heard` took before it closed the stream.
    heard_lines: Mutex<usize>,
    closed_early: Mutex<bool>,
}
const CALLED: &str = r#"{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"sunday_open_needs","arguments":"{}"}}]}}]}"#;
const HARBOR: &str = r#"{"choices":[{"message":{"role":"assistant","content":"HARBOR"}}]}"#;
impl Ollama {
    fn up(models: &[&str]) -> Self {
        Self {
            running: true,
            models: Mutex::new(models.iter().map(|m| m.to_string()).collect()),
            ..Self::default()
        }
    }
    fn with_copy(self, name: &str, room: u64) -> Self {
        self.models.lock().unwrap().push(name.into());
        self.rooms.lock().unwrap().insert(name.into(), room);
        self
    }
    fn tags(&self) -> String {
        let rows: Vec<Value> = self
            .models
            .lock()
            .unwrap()
            .iter()
            .map(|m| json!({"name": m, "model": m, "size": 5_225_388_164u64}))
            .collect();
        json!({ "models": rows }).to_string()
    }
}
impl LocalHttp for Ollama {
    fn get(&self, url: &str, _: Duration) -> Result<(u16, Vec<u8>), Failure> {
        assert!(local_ai::loopback_only(url), "{url}");
        // LM Studio isn't on this fake Mac; finding looks for it too.
        if !self.running || !url.starts_with(local_ai::OLLAMA) {
            return Err(Failure::Unreachable);
        }
        let path = &url[local_ai::OLLAMA.len()..];
        match path {
            "/api/version" => Ok((200, br#"{"version":"0.40.16"}"#.to_vec())),
            "/api/tags" => Ok((200, self.tags().into_bytes())),
            "/api/ps" => {
                let rooms = self.rooms.lock().unwrap();
                let rows: Vec<Value> = rooms
                    .iter()
                    .map(|(name, room)| json!({"name": name, "model": name, "context_length": room}))
                    .collect();
                Ok((200, json!({ "models": rows }).to_string().into_bytes()))
            }
            _ => Ok((404, b"{}".to_vec())),
        }
    }
    fn post(&self, url: &str, body: &[u8], _: Duration) -> Result<(u16, Vec<u8>), Failure> {
        assert!(local_ai::loopback_only(url) && url.starts_with(local_ai::OLLAMA), "{url}");
        if !self.running {
            return Err(Failure::Unreachable);
        }
        let value: Value = serde_json::from_slice(body).unwrap();
        let path = url[local_ai::OLLAMA.len()..].to_string();
        self.posts.lock().unwrap().push((path.clone(), value.clone()));
        match path.as_str() {
            "/api/show" => {
                let name = value["model"].as_str().unwrap();
                match self.rooms.lock().unwrap().get(name) {
                    Some(room) => Ok((
                        200,
                        json!({"parameters": format!("num_ctx                        {room}\nstop                           \"<|im_end|>\"\ntemperature                    0.6")})
                            .to_string()
                            .into_bytes(),
                    )),
                    None => Ok((404, format!(r#"{{"error":"model '{name}' not found"}}"#).into_bytes())),
                }
            }
            "/api/create" => {
                if let Some(status) = self.create_status {
                    return Ok((status, br#"{"error":"neither 'from' or 'files' was specified"}"#.to_vec()));
                }
                let name = value["model"].as_str().unwrap().to_string();
                let room = value["parameters"]["num_ctx"].as_u64().unwrap();
                let mut models = self.models.lock().unwrap();
                if !models.contains(&name) {
                    models.push(name.clone());
                }
                self.rooms.lock().unwrap().insert(name, room);
                Ok((200, br#"{"status":"success"}"#.to_vec()))
            }
            "/v1/chat/completions" => {
                let mut chats = self.chats.lock().unwrap();
                *chats += 1;
                if *chats == 1
                    && let Some(meanwhile) = &self.on_check
                {
                    meanwhile();
                }
                Ok((200, if *chats % 2 == 1 { CALLED } else { HARBOR }.as_bytes().to_vec()))
            }
            _ => Ok((404, b"{}".to_vec())),
        }
    }
    fn delete(&self, url: &str, body: &[u8], _: Duration) -> Result<(u16, Vec<u8>), Failure> {
        assert_eq!(url, format!("{}/api/delete", local_ai::OLLAMA));
        if !self.running {
            return Err(Failure::Unreachable);
        }
        let value: Value = serde_json::from_slice(body).unwrap();
        self.deletes.lock().unwrap().push(value.clone());
        let name = value["model"].as_str().unwrap();
        if let Some(status) = self.delete_status.get(name) {
            return Ok((*status, b"{}".to_vec()));
        }
        let mut models = self.models.lock().unwrap();
        match models.iter().position(|m| m == name) {
            Some(at) => {
                models.remove(at);
                self.rooms.lock().unwrap().remove(name);
                Ok((200, Vec::new()))
            }
            None => Ok((404, format!(r#"{{"error":"model '{name}' not found"}}"#).into_bytes())),
        }
    }
}
impl PullHttp for Ollama {
    fn pull(&self, body: &[u8], heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<u16, Failure> {
        if !self.running {
            return Err(Failure::Unreachable);
        }
        let value: Value = serde_json::from_slice(body).unwrap();
        self.pulls.lock().unwrap().push(value.clone());
        for say in &self.stream {
            let go_on = match say {
                Say::Line(line) => {
                    *self.heard_lines.lock().unwrap() += 1;
                    heard(Heard::Line(line.as_bytes()))
                }
                Say::Quiet => heard(Heard::Quiet),
                Say::Wait(wait) => {
                    std::thread::sleep(*wait);
                    true
                }
            };
            // Ollama has the model by the time it says success, whether or not anyone reads on.
            if self.pulled_adds && matches!(say, Say::Line(l) if l.contains("success")) {
                self.models
                    .lock()
                    .unwrap()
                    .push(value["model"].as_str().unwrap().into());
            }
            if !go_on {
                *self.closed_early.lock().unwrap() = true;
                return Ok(self.stream_status.unwrap_or(200));
            }
        }
        Ok(self.stream_status.unwrap_or(200))
    }
}
fn lines(lines: Vec<String>) -> Vec<Say> {
    lines.into_iter().map(Say::Line).collect()
}

struct Dir(std::path::PathBuf);
impl Dir {
    fn new(label: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ozzie-local-models-{label}-{}-{}-{}",
            std::process::id(),
            crate::sunday_check::unix_ms(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
/// A download's steps as the page is told them.
fn steps(id: &str, ollama: &Ollama, cancel: &AtomicBool, stall: Duration) -> (Result<(), End>, Vec<(Phase, u64, u64)>) {
    let mut told = Vec::new();
    let ended = download(id, ollama, cancel, stall, &mut |phase, done, total| told.push((phase, done, total)));
    (ended, told)
}

// ---- The catalogue and Ozzie's copies -------------------------------------------------------------------------------

#[test]
fn the_catalogue_is_providers_jsons_three_and_ozzies_copies_have_fixed_plain_names() {
    let ids: Vec<&str> = entries().iter().map(|(_, m)| m.id.as_str()).collect();
    assert_eq!(ids, ["qwen3:4b", "qwen3:8b", "gpt-oss:20b"]);
    assert_eq!(
        entries().map(|(size, _)| size),
        [Size::Small, Size::Medium, Size::Large]
    );
    assert_eq!(
        ["qwen3:4b", "qwen3:8b", "gpt-oss:20b"].map(setup_name),
        ["ozzie-qwen3:4b", "ozzie-qwen3:8b", "ozzie-gpt-oss:20b"]
    );
    // A tag always, so Ollama lists the copy under exactly this name.
    assert_eq!(setup_name("llama3.2"), "ozzie-llama3.2:latest");
    // Only the catalogue's ids, exactly.
    for id in ["qwen3:8b ", "QWEN3:8B", "qwen3", "llama3.2", "qwen3:8b\"; rm", "", "ozzie-qwen3:8b"] {
        assert!(entry(id).is_none(), "{id}");
    }
    assert!(is_setup_name("ozzie-qwen3:8b") && !is_setup_name("ozzie-qwen3:8b:latest"));
    assert!(!is_setup_name("ozzie-mine:7b") && !is_setup_name("qwen3:8b"));
    // A person reads the model it is a copy of.
    assert_eq!(shown_name("ozzie-qwen3:8b"), "qwen3:8b");
    assert_eq!(shown_name("llama3.2:latest"), "llama3.2:latest");
    // Each copy is a model id every route accepts.
    for (_, m) in entries() {
        assert!(model::RouteConfig::new(model::Route::Local, Some(&App::Ollama.base()), Some(&setup_name(&m.id))).is_ok());
    }
    // A member called Ozzie never stops Ozzie's own copies, which are fixed text; any other model named so is stopped.
    let mut names = NameGuard::default();
    names.remember(["Ozzie Fictional".to_string()].iter());
    assert!(model::model_free_of_names("ozzie-qwen3:8b", &names));
    assert!(!model::model_free_of_names("ozzie-mine:7b", &names));
}

#[test]
fn ozzies_copy_is_named_in_the_ai_line_as_the_model_it_copies() {
    let dir = Dir::new("label");
    model::save_local_checked(&dir.0, &App::Ollama.base(), "ozzie-qwen3:8b", 1, model::route_generation(&dir.0)).unwrap();
    struct NoKeys;
    impl model::ModelKeys for NoKeys {
        fn key(&self, _: &str) -> Result<Option<zeroize::Zeroizing<String>>, crate::credentials::StoreError> {
            Ok(None)
        }
    }
    let status = model::status(&dir.0, &NoKeys);
    assert_eq!(status.label, "AI model on this Mac (qwen3:8b)");
    // The route itself is Ozzie's copy: that is the model with the room.
    assert_eq!(model::load_config(&dir.0).unwrap().model, "ozzie-qwen3:8b");
}

#[test]
fn each_row_says_whether_it_fits_is_downloaded_is_set_up_and_has_room_on_the_disk() {
    let listed = vec![
        ("qwen3:8b".to_string(), Some(5_225_388_164)),
        ("ozzie-qwen3:8b".to_string(), Some(5_225_387_807)),
        ("llama3.2:latest".to_string(), Some(2_019_393_189)),
    ];
    let kept = Kept {
        downloaded: vec!["qwen3:8b".into()],
    };
    let rows = catalogue(Some(listed.as_slice()), 16 * GIB, Some(9_000_000_000), &kept);
    let row = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
    // 16 GB: the medium model is the one for this Mac; the large one is more than half the memory.
    assert_eq!(rows.iter().map(|r| (r.size, r.recommended, r.fits)).collect::<Vec<_>>(), [
        (Size::Small, false, true),
        (Size::Medium, true, true),
        (Size::Large, false, false)
    ]);
    assert_eq!((row("qwen3:8b").downloaded, row("qwen3:8b").set_up, row("qwen3:8b").downloaded_by_ozzie), (true, true, true));
    assert_eq!(row("qwen3:8b").disk, Disk::NotNeeded);
    // 2.5 GB and 3 GB to spare fit in 9 GB free; 13.8 GB doesn't.
    assert_eq!((row("qwen3:4b").downloaded, row("qwen3:4b").disk), (false, Disk::Enough));
    assert_eq!(row("gpt-oss:20b").disk, Disk::NotEnough);
    assert!(!row("qwen3:4b").downloaded_by_ozzie);
    // Free space unknown (Ollama keeps models somewhere Ozzie can't see): not refused for space.
    let rows = catalogue(Some(listed.as_slice()), 16 * GIB, None, &Kept::default());
    assert_eq!(rows[0].disk, Disk::Unknown);
    // Ollama not answering: nothing counts as downloaded.
    let rows = catalogue(None, 16 * GIB, Some(100_000_000_000), &Kept::default());
    assert!(rows.iter().all(|r| !r.downloaded && !r.set_up && r.disk == Disk::Enough));
    // Only Ozzie's copy there (the person deleted the model): its files are in the copy, so it counts as downloaded.
    let rows = catalogue(Some(&[("ozzie-qwen3:4b".to_string(), None)][..]), 8 * GIB, Some(1), &Kept::default());
    assert_eq!((rows[0].downloaded, rows[0].set_up, rows[0].disk), (true, true, Disk::NotNeeded));
    // The exact edge: size plus 3 GB.
    assert_eq!(disk_room(2_500_000_000, Some(5_500_000_000), false), Disk::Enough);
    assert_eq!(disk_room(2_500_000_000, Some(5_499_999_999), false), Disk::NotEnough);
}

#[test]
fn finding_lists_the_catalogue_and_keeps_ozzies_copies_out_of_the_persons_models() {
    let ollama = Ollama::up(&["qwen3:8b", "llama3.2:latest"]).with_copy("ozzie-qwen3:8b", ROOM);
    let found: LocalFind = local_ai::find_with(&ollama, |_| true, 16 * GIB, Some(15_000_000_000), &Kept::default());
    let ids: Vec<&str> = found.apps[0].models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["qwen3:8b", "llama3.2:latest"]);
    assert_eq!(found.free_bytes, Some(15_000_000_000));
    let page = serde_json::to_value(&found).unwrap();
    assert_eq!(page["catalogue"][1]["id"], "qwen3:8b");
    assert_eq!(page["catalogue"][1]["size"], "medium");
    assert_eq!(page["catalogue"][1]["set_up"], true);
    assert_eq!(page["catalogue"][1]["disk"], "not-needed");
    assert_eq!(page["catalogue"][2]["disk"], "not-enough");
    assert_eq!(page["catalogue"][0]["disk"], "enough");
    // Finding is GETs only.
    assert!(ollama.posts.lock().unwrap().is_empty());
    // The plain `find` (Check my setup) still lists the rows, with no disk figure.
    let found = local_ai::find(&ollama, |_| true, 16 * GIB);
    assert_eq!((found.free_bytes, found.catalogue[0].disk), (None, Disk::Unknown));
}

#[test]
fn the_free_space_is_read_where_ollama_keeps_models_and_said_unknown_elsewhere() {
    let dir = Dir::new("free");
    assert!(free_bytes_at(&dir.0).is_some_and(|free| free > 0));
    assert_eq!(free_bytes_at(&dir.0.join("not-there")), None);
    assert_eq!(free_bytes_at(Path::new("bad\0path")), None);
    // As Finder counts it (review L-5): the volume's capacity for important usage, which includes what macOS frees on
    // demand, so never less than statvfs's figure.
    #[cfg(target_os = "macos")]
    {
        let important = important_free(&dir.0).expect("macOS gives the capacity for important usage");
        assert!(important > 0);
        assert!(free_bytes_at(&dir.0).unwrap() >= statvfs_free(&dir.0).unwrap());
        assert_eq!(important_free(&dir.0.join("not-there")), None);
    }
}

// ---- Downloading --------------------------------------------------------------------------------------------------

#[test]
fn a_download_is_ollamas_own_pull_of_a_catalogue_model_told_as_steps_and_bytes() {
    let ollama = Ollama {
        stream: lines(qwen3_8b_lines()),
        ..Ollama::up(&[])
    };
    let (ended, told) = steps("qwen3:8b", &ollama, &AtomicBool::new(false), STALL_WAIT);
    assert_eq!(ended, Ok(()));
    // Only the catalogue id goes, with nothing about the church.
    assert_eq!(*ollama.pulls.lock().unwrap(), [json!({"model": "qwen3:8b", "stream": true})]);
    let phases: Vec<Phase> = told.iter().map(|(p, _, _)| *p).collect();
    assert_eq!(phases.first(), Some(&Phase::Downloading));
    for step in [Phase::Verifying, Phase::Finishing] {
        assert!(phases.contains(&step), "{phases:?}");
    }
    // The bytes only grow, never past the whole, and the whole is at least the catalogue's size.
    assert!(told.windows(2).all(|w| w[0].1 <= w[1].1), "{told:?}");
    assert!(told.iter().all(|(_, done, total)| done <= total && *total >= 5_225_388_164));
    assert_eq!(told.last().unwrap().1, told.last().unwrap().2);
    // Not a catalogue id: nothing is asked.
    let ollama = Ollama::up(&[]);
    let (ended, _) = steps("llama3.2", &ollama, &AtomicBool::new(false), STALL_WAIT);
    assert_eq!(ended, Err(End::NotFound));
    assert!(ollama.pulls.lock().unwrap().is_empty());
}

#[test]
fn each_way_a_download_can_end_has_its_own_closed_word() {
    let ended_with = |stream: Vec<Say>, status: Option<u16>| {
        let ollama = Ollama {
            stream,
            stream_status: status,
            ..Ollama::up(&[])
        };
        steps("qwen3:8b", &ollama, &AtomicBool::new(false), STALL_WAIT).0
    };
    let error = |text: &str| Say::Line(json!({ "error": text }).to_string());
    let start = Say::Line(r#"{"status":"pulling manifest"}"#.into());
    // Go's and Ollama's own words (Ollama's source, v0.40.16): the registry's 404, a full disk, no network.
    for (said, end) in [
        ("pull model manifest: file does not exist", End::NotFound),
        ("write /fictional/blobs/sha256-0000-partial-0: no space left on device", End::NoSpace),
        (
            "pull model manifest: Get \"https://registry.example.invalid/v2/library/qwen3/manifests/8b\": dial tcp: lookup registry.example.invalid: no such host",
            End::Offline,
        ),
        ("Get \"https://registry.example.invalid/v2/\": net/http: TLS handshake timeout", End::Offline),
        ("digest mismatch, file must be downloaded again", End::Failed),
    ] {
        assert_eq!(ended_with(vec![start.clone(), error(said)], None), Err(end), "{said}");
    }
    // An error before anything streamed comes with Ollama's own status.
    assert_eq!(ended_with(vec![error("pull model manifest: file does not exist")], Some(500)), Err(End::NotFound));
    assert_eq!(ended_with(vec![Say::Line(r#"{"oops":true}"#.into())], Some(400)), Err(End::Failed));
    // The stream ended before Ollama said success, or Ollama isn't there: it went away.
    assert_eq!(ended_with(vec![start.clone()], None), Err(End::Stopped));
    let ollama = Ollama::default();
    assert_eq!(steps("qwen3:8b", &ollama, &AtomicBool::new(false), STALL_WAIT).0, Err(End::Stopped));
    // Nothing Ollama wrote is kept: the endings are words of Ozzie's own.
    assert_eq!(serde_json::to_string(&End::NoSpace).unwrap(), r#""no-space""#);
    assert_eq!(serde_json::to_string(&End::NotSetUp).unwrap(), r#""not-set-up""#);
    assert_eq!(serde_json::to_string(&Phase::SettingUp).unwrap(), r#""setting-up""#);
}

#[test]
fn stop_the_download_closes_the_stream_at_once() {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut stream = lines(qwen3_8b_lines()[..3].to_vec());
    // Long enough for the bytes so far to be told (`REPORT_EVERY`), so the person can see them and press Stop.
    stream.extend([Say::Wait(REPORT_EVERY + Duration::from_millis(50)), Say::Quiet, Say::Quiet]);
    stream.extend(lines(qwen3_8b_lines()[3..].to_vec()));
    let ollama = Ollama {
        stream,
        ..Ollama::up(&[])
    };
    // The person presses Stop after the first bytes came.
    let stop = cancel.clone();
    let mut told = Vec::new();
    let ended = download("qwen3:8b", &ollama, &cancel, STALL_WAIT, &mut |phase, done, total| {
        told.push((phase, done, total));
        if done > 0 {
            stop.store(true, Ordering::SeqCst);
        }
    });
    assert_eq!(ended, Err(End::Cancelled));
    assert!(*ollama.closed_early.lock().unwrap());
    // It closed on the next thing Ollama said, quiet or not, long before the end of the stream.
    assert!(*ollama.heard_lines.lock().unwrap() <= 4);
}

#[test]
fn a_download_that_stops_moving_is_said_to_have_stalled_and_one_that_moves_is_not() {
    // Wide margins, so load on the machine can't change the outcome (review L-6): the stalled streams say nothing new for
    // 800 ms against a 500 ms limit (a slow machine only makes that longer), and the moving one moves every 20 ms, 480 ms
    // inside it.
    let stall = Duration::from_millis(500);
    let weights = |done: u64| {
        Say::Line(format!(
            r#"{{"status":"pulling a3de86cd1c13","digest":"sha256:a3de","total":5225374496,"completed":{done}}}"#
        ))
    };
    // Ollama goes on saying the same count, as it does every 60 ms when nothing moves, then nothing at all.
    let mut stream = vec![weights(1_000)];
    for _ in 0..8 {
        stream.extend([Say::Wait(Duration::from_millis(100)), weights(1_000)]);
    }
    let ollama = Ollama {
        stream,
        ..Ollama::up(&[])
    };
    assert_eq!(steps("qwen3:8b", &ollama, &AtomicBool::new(false), stall).0, Err(End::Stalled));
    // Quiet with no step: stalled too (a hung start).
    let mut stream = vec![Say::Line(r#"{"status":"pulling manifest"}"#.into())];
    for _ in 0..8 {
        stream.extend([Say::Wait(Duration::from_millis(100)), Say::Quiet]);
    }
    let ollama = Ollama {
        stream,
        ..Ollama::up(&[])
    };
    assert_eq!(steps("qwen3:8b", &ollama, &AtomicBool::new(false), stall).0, Err(End::Stalled));
    // Bytes that keep coming, however long it takes in all, never stall.
    let mut stream = Vec::new();
    for n in 1..=12u64 {
        stream.extend([Say::Wait(Duration::from_millis(20)), weights(n * 1_000_000)]);
    }
    stream.extend(lines(qwen3_8b_lines()[8..].to_vec()));
    let ollama = Ollama {
        stream,
        ..Ollama::up(&[])
    };
    assert_eq!(steps("qwen3:8b", &ollama, &AtomicBool::new(false), stall).0, Ok(()));
    // Two minutes: Ollama's own retry of a stalled part is 30 seconds, and its check of the files says nothing.
    assert_eq!(STALL_WAIT, Duration::from_secs(120));
}

/// Says each line, then presses Stop (as the person might, a moment too late), then stays quiet once.
struct StopAfter(Vec<String>, Arc<AtomicBool>);
impl PullHttp for StopAfter {
    fn pull(&self, _: &[u8], heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<u16, Failure> {
        for line in &self.0 {
            if !heard(Heard::Line(line.as_bytes())) {
                // Reading stops at success (review M-1): the press lands just after it.
                self.1.store(true, Ordering::SeqCst);
                return Ok(200);
            }
        }
        self.1.store(true, Ordering::SeqCst);
        heard(Heard::Quiet);
        Ok(200)
    }
}

#[test]
fn review_l1_a_stop_that_lands_after_success_leaves_the_download_done_and_ozzies() {
    let cancel = Arc::new(AtomicBool::new(false));
    let pull = StopAfter(qwen3_8b_lines(), cancel.clone());
    assert_eq!(download("qwen3:8b", &pull, &cancel, STALL_WAIT, &mut |_, _, _| {}), Ok(()));
    // The whole job: the model is recorded as Ozzie's, so "Remove this model from this Mac" can delete it; the job ends
    // as stopped, before anything is set up.
    let dir = Dir::new("late-stop");
    let cancel = Arc::new(AtomicBool::new(false));
    let ollama = Ollama::up(&[]);
    let pull = StopAfter(qwen3_8b_lines(), cancel.clone());
    let clock = || 1u64;
    let job = Job { pull: &pull, ..job_with(&dir.0, &ollama, &cancel, 0, &clock) };
    let end = run(&job, &mut |_| {});
    // It ends at setting up, which is how the page knows the download finished and says to press Set up.
    assert_eq!((end.end, end.phase), (Some(End::Cancelled), Phase::SettingUp));
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:8b"]);
    // A Stop before success still stops it.
    let cancel = Arc::new(AtomicBool::new(false));
    let pull = StopAfter(qwen3_8b_lines()[..4].to_vec(), cancel.clone());
    assert_eq!(download("qwen3:8b", &pull, &cancel, STALL_WAIT, &mut |_, _, _| {}), Err(End::Cancelled));
    // A Stop while Ollama checks the files and writes the manifest, after every byte came but before success: stopped,
    // nothing recorded, and it ends at finishing, never setting up, so the page never says the download had finished.
    let dir = Dir::new("finishing-stop");
    let cancel = Arc::new(AtomicBool::new(false));
    let pull = StopAfter(qwen3_8b_lines()[..10].to_vec(), cancel.clone());
    let job = Job { pull: &pull, ..job_with(&dir.0, &ollama, &cancel, 0, &clock) };
    let end = run(&job, &mut |_| {});
    assert_eq!((end.end, end.phase), (Some(End::Cancelled), Phase::Finishing));
    assert_eq!(end.done_bytes, end.total_bytes);
    assert!(kept(&dir.0).downloaded.is_empty());
}

#[test]
fn review_l3_absurd_counts_stay_bounded_and_never_overflow() {
    let pulling = |digest: String, total: u64, done: u64| {
        Say::Line(json!({"status": "pulling x", "digest": digest, "total": total, "completed": done}).to_string())
    };
    // Totals and counts at u64::MAX, twice over: no overflow, and never past what the page reads.
    let ollama = Ollama {
        stream: vec![
            pulling("sha256:a".into(), u64::MAX, u64::MAX),
            pulling("sha256:b".into(), u64::MAX, u64::MAX),
            Say::Line(r#"{"status":"success"}"#.into()),
        ],
        ..Ollama::up(&[])
    };
    let (ended, told) = steps("qwen3:8b", &ollama, &AtomicBool::new(false), STALL_WAIT);
    assert_eq!(ended, Ok(()));
    assert!(!told.is_empty());
    assert!(told.iter().all(|(_, done, total)| done <= total && *total <= MAX_BYTES), "{told:?}");
    // A thousand files named: only the first MAX_FILES are counted, and every sum saturates at MAX_BYTES.
    let mut counts = Counts { files: BTreeMap::new(), at_least: 5_225_388_164 };
    for n in 0..1_000 {
        counts.file(&format!("sha256:{n:04}"), 1_000_000_000, 2_000_000_000);
    }
    assert_eq!(counts.files.len(), MAX_FILES);
    assert_eq!((counts.done(), counts.total()), (MAX_FILES as u64 * 1_000_000_000, MAX_FILES as u64 * 1_000_000_000));
    counts.file("sha256:0000", u64::MAX, u64::MAX);
    counts.file("sha256:0001", u64::MAX, 7);
    assert_eq!((counts.done(), counts.total()), (MAX_BYTES, MAX_BYTES));
    // Through the stream too: a thousand files, no panic, the counts within bounds.
    let mut stream: Vec<Say> = (0..1_000).map(|n| pulling(format!("sha256:{n:04}"), 1_000_000_000, 0)).collect();
    stream.push(Say::Line(r#"{"status":"success"}"#.into()));
    let ollama = Ollama { stream, ..Ollama::up(&[]) };
    let (ended, told) = steps("qwen3:8b", &ollama, &AtomicBool::new(false), STALL_WAIT);
    assert_eq!(ended, Ok(()));
    assert!(told.iter().all(|(_, done, total)| done <= total && *total <= MAX_FILES as u64 * 1_000_000_000));
    // The page reads up to 2^50 (onboarding-bridge.ts); native never says more.
    assert_eq!(MAX_BYTES, 1u64 << 50);
    let page = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../product/desktop/src/onboarding-bridge.ts"),
    )
    .unwrap();
    assert!(page.contains("const MAX_BYTES = 2 ** 50;"));
}

// ---- Setting up ---------------------------------------------------------------------------------------------------

#[test]
fn setting_up_makes_ozzies_copy_with_room_only_when_it_isnt_there_and_only_from_a_listed_model() {
    // Not there: one create, exactly this request (Ollama's current shape, from v0.5.5).
    let ollama = Ollama::up(&["qwen3:8b"]);
    assert_eq!(set_up("qwen3:8b", &ollama), Ok(()));
    let posts = ollama.posts.lock().unwrap().clone();
    assert_eq!(posts.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["/api/show", "/api/create"]);
    assert_eq!(posts[0].1, json!({"model": "ozzie-qwen3:8b"}));
    assert_eq!(
        posts[1].1,
        json!({"model": "ozzie-qwen3:8b", "from": "qwen3:8b", "parameters": {"num_ctx": 8192}, "stream": false})
    );
    assert_eq!(create_body("qwen3:8b"), posts[1].1);
    // There with the right room: nothing is created.
    let ollama = Ollama::up(&["qwen3:8b"]).with_copy("ozzie-qwen3:8b", ROOM);
    assert_eq!(set_up("qwen3:8b", &ollama), Ok(()));
    assert_eq!(ollama.posts.lock().unwrap().len(), 1);
    // There with other room: made again.
    let ollama = Ollama::up(&["qwen3:8b"]).with_copy("ozzie-qwen3:8b", 4096);
    assert_eq!(set_up("qwen3:8b", &ollama), Ok(()));
    assert_eq!(ollama.rooms.lock().unwrap()["ozzie-qwen3:8b"], ROOM);
    // The model isn't listed: never a create, which would make Ollama download it.
    let ollama = Ollama::up(&["llama3.2:latest"]);
    assert_eq!(set_up("qwen3:8b", &ollama), Err(End::NotSetUp));
    assert!(ollama.posts.lock().unwrap().iter().all(|(p, _)| p != "/api/create"));
    // An Ollama that refuses the create (older than its JSON create), or isn't answering.
    let ollama = Ollama {
        create_status: Some(400),
        ..Ollama::up(&["qwen3:8b"])
    };
    assert_eq!(set_up("qwen3:8b", &ollama), Err(End::NotSetUp));
    assert_eq!(set_up("qwen3:8b", &Ollama::default()), Err(End::Stopped));
    // The room read from Ollama's own parameters text (measured shape).
    assert!(has_room("num_ctx                        8192\nrepeat_penalty                 1"));
    assert!(!has_room("num_ctx                        4096") && !has_room("num_ctx_extra 8192") && !has_room(""));
}

// ---- The whole job ------------------------------------------------------------------------------------------------

fn job_with<'a>(dir: &'a Path, ollama: &'a Ollama, cancel: &'a AtomicBool, choices: u64, clock: &'a dyn Fn() -> u64) -> Job<'a> {
    static NAMES: std::sync::LazyLock<NameGuard> = std::sync::LazyLock::new(NameGuard::default);
    Job {
        dir,
        id: "qwen3:8b",
        names: &NAMES,
        http: ollama,
        pull: ollama,
        clock,
        cancel,
        choices,
        stall: STALL_WAIT,
    }
}

#[test]
fn download_and_set_up_downloads_makes_the_copy_checks_it_and_chooses_it() {
    let dir = Dir::new("job");
    let ollama = Ollama {
        stream: lines(qwen3_8b_lines()),
        pulled_adds: true,
        ..Ollama::up(&["llama3.2:latest"])
    };
    let cancel = AtomicBool::new(false);
    let clock = || 1_763_400_000_000u64;
    let mut told = Vec::new();
    let end = run(&job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock), &mut |p| told.push(p.clone()));
    assert_eq!(end.end, Some(End::Done));
    assert_eq!(end.check.map(|c| (c.verdict, c.small_room)), Some((Verdict::Answers, false)));
    assert_eq!((end.done_bytes, end.total_bytes), (end.total_bytes, 5_225_388_164));
    // Each step was told in order, numbers and closed words only.
    let mut phases: Vec<Phase> = told.iter().map(|p| p.phase).collect();
    phases.dedup();
    assert_eq!(
        phases,
        [Phase::Starting, Phase::Downloading, Phase::Verifying, Phase::Finishing, Phase::SettingUp, Phase::Checking]
    );
    assert!(told.iter().all(|p| p.end.is_none() && p.model == "qwen3:8b"));
    // The route is Ozzie's copy, checked; Ozzie recorded that it downloaded the model.
    let route = model::usable_config(&dir.0).unwrap();
    assert_eq!((route.base_url.as_str(), route.model.as_str()), ("http://127.0.0.1:11434/v1", "ozzie-qwen3:8b"));
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:8b"]);
    // The check asked Ozzie's copy, never the model without room.
    let posts = ollama.posts.lock().unwrap();
    let chats: Vec<&Value> = posts.iter().filter(|(p, _)| p == "/v1/chat/completions").map(|(_, b)| b).collect();
    assert_eq!(chats.len(), 2);
    assert!(chats.iter().all(|b| b["model"] == "ozzie-qwen3:8b"));
    let page = serde_json::to_value(&end).unwrap();
    assert_eq!(page["end"], "done");
    assert_eq!(page["check"]["verdict"], "answers");
}

#[test]
fn a_model_the_person_already_has_is_set_up_without_a_download_and_never_recorded_as_ozzies() {
    let dir = Dir::new("theirs");
    let ollama = Ollama::up(&["qwen3:8b"]);
    let cancel = AtomicBool::new(false);
    let clock = || 1u64;
    let end = run(&job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock), &mut |_| {});
    assert_eq!((end.end, end.check.map(|c| c.verdict)), (Some(End::Done), Some(Verdict::Answers)));
    assert!(ollama.pulls.lock().unwrap().is_empty());
    assert!(kept(&dir.0).downloaded.is_empty());
    // Already set up with room: no download and no create, just the check.
    let ollama = Ollama::up(&["qwen3:8b"]).with_copy("ozzie-qwen3:8b", ROOM);
    let end = run(&job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock), &mut |_| {});
    assert_eq!(end.end, Some(End::Done));
    assert!(ollama.posts.lock().unwrap().iter().all(|(p, _)| p != "/api/create"));
    assert!(ollama.pulls.lock().unwrap().is_empty());
}

#[test]
fn a_choice_made_since_the_press_wins_over_the_check_even_after_a_long_download() {
    let dir = Dir::new("since");
    // The person presses Download and set up...
    let pressed = model::route_generation(&dir.0);
    // ...then, while it downloads, chooses No AI for now somewhere else.
    model::route_choice_made(&dir.0);
    let ollama = Ollama {
        stream: lines(qwen3_8b_lines()),
        pulled_adds: true,
        ..Ollama::up(&[])
    };
    let cancel = AtomicBool::new(false);
    let clock = || 1u64;
    let end = run(&job_with(&dir.0, &ollama, &cancel, pressed, &clock), &mut |_| {});
    assert_eq!(end.check.map(|c| c.verdict), Some(Verdict::ChoiceChanged));
    assert!(model::load_config(&dir.0).is_none());
    // A choice made during the check itself wins too.
    let dir = Dir::new("during");
    let at = dir.0.clone();
    let ollama = Ollama {
        on_check: Some(Box::new(move || model::route_choice_made(&at))),
        ..Ollama::up(&["qwen3:8b"])
    };
    let end = run(&job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock), &mut |_| {});
    assert_eq!(end.check.map(|c| c.verdict), Some(Verdict::ChoiceChanged));
}

#[test]
fn a_job_that_ends_early_says_how_and_sets_up_nothing() {
    let clock = || 1u64;
    // Stopped by the person during the download.
    let dir = Dir::new("stopped");
    let cancel = AtomicBool::new(true);
    let ollama = Ollama {
        stream: lines(qwen3_8b_lines()),
        pulled_adds: true,
        ..Ollama::up(&[])
    };
    let end = run(&job_with(&dir.0, &ollama, &cancel, 0, &clock), &mut |_| {});
    assert_eq!((end.end, end.phase), (Some(End::Cancelled), Phase::Starting));
    assert!(ollama.posts.lock().unwrap().iter().all(|(p, _)| p == "/api/show"));
    assert!(kept(&dir.0).downloaded.is_empty() && model::load_config(&dir.0).is_none());
    // Ollama isn't answering.
    let end = run(&job_with(&dir.0, &Ollama::default(), &AtomicBool::new(false), 0, &clock), &mut |_| {});
    assert_eq!(end.end, Some(End::Stopped));
    // The disk filled up: said so, nothing set up.
    let ollama = Ollama {
        stream: vec![Say::Line(json!({"error": "write: no space left on device"}).to_string())],
        ..Ollama::up(&[])
    };
    let end = run(&job_with(&dir.0, &ollama, &AtomicBool::new(false), 0, &clock), &mut |_| {});
    assert_eq!(end.end, Some(End::NoSpace));
    // Downloaded, but the copy couldn't be made: the download is still Ozzie's to remove later.
    let ollama = Ollama {
        stream: lines(qwen3_8b_lines()),
        pulled_adds: true,
        create_status: Some(400),
        ..Ollama::up(&[])
    };
    let end = run(&job_with(&dir.0, &ollama, &AtomicBool::new(false), 0, &clock), &mut |_| {});
    assert_eq!((end.end, end.phase), (Some(End::NotSetUp), Phase::SettingUp));
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:8b"]);
}

#[test]
fn may_start_refuses_plainly_before_anything_is_downloaded() {
    let found = |ollama: &Ollama, memory: u64, free: Option<u64>| local_ai::find_with(ollama, |_| true, memory, free, &Kept::default());
    let ollama = Ollama::up(&[]);
    assert_eq!(may_start(&found(&ollama, 16 * GIB, Some(100_000_000_000)), "qwen3:8b"), Ok(()));
    for id in ["llama3.2", "qwen3:8b; rm", "ozzie-qwen3:8b", ""] {
        assert_eq!(may_start(&found(&ollama, 16 * GIB, None), id), Err(Refusal::NotInCatalogue), "{id}");
    }
    assert_eq!(may_start(&found(&Ollama::default(), 16 * GIB, None), "qwen3:8b"), Err(Refusal::NotRunning));
    assert_eq!(may_start(&found(&ollama, 16 * GIB, None), "gpt-oss:20b"), Err(Refusal::TooBig));
    assert_eq!(may_start(&found(&ollama, 16 * GIB, Some(6_000_000_000)), "qwen3:8b"), Err(Refusal::NoRoom));
    // Already on this Mac: no space is needed.
    let ollama = Ollama::up(&["qwen3:8b"]);
    assert_eq!(may_start(&found(&ollama, 16 * GIB, Some(1)), "qwen3:8b"), Ok(()));
    assert_eq!(serde_json::to_string(&Refusal::NoRoom).unwrap(), r#""no-room""#);
}

// ---- Removing -----------------------------------------------------------------------------------------------------

#[test]
fn removing_deletes_ozzies_copy_and_the_model_only_when_ozzie_downloaded_it() {
    // Ozzie downloaded it and it is the AI in use: both go, and no AI is chosen.
    let dir = Dir::new("remove");
    change_kept(&dir.0, |ids| ids.push("qwen3:8b".into())).unwrap();
    model::save_local_checked(&dir.0, &App::Ollama.base(), "ozzie-qwen3:8b", 1, model::route_generation(&dir.0)).unwrap();
    let before = model::route_generation(&dir.0);
    let ollama = Ollama::up(&["qwen3:8b", "llama3.2:latest"]).with_copy("ozzie-qwen3:8b", ROOM);
    let removal = remove(&dir.0, "qwen3:8b", &ollama).unwrap();
    assert_eq!(removal, Removal { removed: Removed::Removed, route_cleared: true });
    assert_eq!(*ollama.deletes.lock().unwrap(), [json!({"model": "ozzie-qwen3:8b"}), json!({"model": "qwen3:8b"})]);
    assert_eq!(*ollama.models.lock().unwrap(), ["llama3.2:latest"]);
    assert!(kept(&dir.0).downloaded.is_empty());
    assert!(model::load_config(&dir.0).is_none());
    assert_ne!(model::route_generation(&dir.0), before, "clearing the route is a choice");
    // The person got it on their own, and uses it directly: only Ozzie's copy goes; their model and choice stay.
    let dir = Dir::new("theirs");
    model::save_local_checked(&dir.0, &App::Ollama.base(), "qwen3:8b", 1, model::route_generation(&dir.0)).unwrap();
    let ollama = Ollama::up(&["qwen3:8b"]).with_copy("ozzie-qwen3:8b", ROOM);
    let removal = remove(&dir.0, "qwen3:8b", &ollama).unwrap();
    assert_eq!(removal, Removal { removed: Removed::Removed, route_cleared: false });
    assert_eq!(*ollama.deletes.lock().unwrap(), [json!({"model": "ozzie-qwen3:8b"})]);
    assert_eq!(*ollama.models.lock().unwrap(), ["qwen3:8b"]);
    assert_eq!(model::load_config(&dir.0).unwrap().model, "qwen3:8b");
    // Nothing of Ozzie's there.
    let ollama = Ollama::up(&["qwen3:8b"]);
    assert_eq!(remove(&dir.0, "qwen3:8b", &ollama).unwrap().removed, Removed::None);
    // Ollama isn't answering: nothing changed, and the record stays.
    let dir = Dir::new("down");
    change_kept(&dir.0, |ids| ids.push("qwen3:4b".into())).unwrap();
    assert_eq!(remove(&dir.0, "qwen3:4b", &Ollama::default()).unwrap().removed, Removed::Stopped);
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:4b"]);
    // Ollama refuses the model after the copy went: said so; the record stays for another try.
    let ollama = Ollama {
        delete_status: BTreeMap::from([("qwen3:4b".to_string(), 500)]),
        ..Ollama::up(&["qwen3:4b"]).with_copy("ozzie-qwen3:4b", ROOM)
    };
    assert_eq!(remove(&dir.0, "qwen3:4b", &ollama).unwrap().removed, Removed::Failed);
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:4b"]);
    // Only the catalogue's ids: anything else is refused before a request.
    let ollama = Ollama::up(&["llama3.2:latest"]);
    assert_eq!(remove(&dir.0, "llama3.2:latest", &ollama).err(), Some(ModelError::InvalidRequest));
    assert!(ollama.deletes.lock().unwrap().is_empty());
}

#[test]
fn review_l2_a_model_the_person_deleted_and_got_again_themselves_is_never_removed_by_ozzie() {
    let dir = Dir::new("reconcile");
    // Ozzie downloaded qwen3:4b and set it up.
    let ollama = Ollama {
        stream: lines(qwen3_8b_lines()),
        pulled_adds: true,
        ..Ollama::up(&["llama3.2:latest"])
    };
    let clock = || 1u64;
    let cancel = AtomicBool::new(false);
    let job = Job { id: "qwen3:4b", ..job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock) };
    assert_eq!(run(&job, &mut |_| {}).end, Some(End::Done));
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:4b"]);
    // The person deletes it (and Ozzie's copy) in Ollama themselves, keeping a model of their own. Ozzie's AI screen
    // looks: Ollama no longer lists it, so it leaves the record.
    ollama.models.lock().unwrap().retain(|m| m == "llama3.2:latest");
    ollama.rooms.lock().unwrap().clear();
    let found = find(&dir.0, &ollama, |_| true, 8 * GIB, Some(100_000_000_000));
    assert!(!found.catalogue[0].downloaded_by_ozzie);
    assert!(kept(&dir.0).downloaded.is_empty());
    // Later they get qwen3:4b on their own, and set it up through Ozzie: never recorded as Ozzie's download.
    ollama.models.lock().unwrap().push("qwen3:4b".into());
    let job = Job { id: "qwen3:4b", ..job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock) };
    assert_eq!(run(&job, &mut |_| {}).end, Some(End::Done));
    assert!(kept(&dir.0).downloaded.is_empty());
    // Remove takes only Ozzie's copy; their model stays.
    ollama.deletes.lock().unwrap().clear();
    assert_eq!(remove(&dir.0, "qwen3:4b", &ollama).unwrap().removed, Removed::Removed);
    assert_eq!(*ollama.deletes.lock().unwrap(), [json!({"model": "ozzie-qwen3:4b"})]);
    assert!(ollama.models.lock().unwrap().contains(&"qwen3:4b".to_string()));
    // Removing checks the record against Ollama's list itself too: deleted since, it isn't Ozzie's to remove.
    change_kept(&dir.0, |ids| ids.push("qwen3:8b".into())).unwrap();
    let ollama = Ollama::up(&["llama3.2:latest"]).with_copy("ozzie-qwen3:8b", ROOM);
    remove(&dir.0, "qwen3:8b", &ollama).unwrap();
    assert_eq!(*ollama.deletes.lock().unwrap(), [json!({"model": "ozzie-qwen3:8b"})]);
    assert!(kept(&dir.0).downloaded.is_empty());
    // Ollama not answering tells nothing: the record stays as it was.
    change_kept(&dir.0, |ids| ids.push("qwen3:8b".into())).unwrap();
    assert_eq!(kept_now(&dir.0, None).downloaded, ["qwen3:8b"]);
    let _ = find(&dir.0, &Ollama::default(), |_| true, 16 * GIB, None);
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:8b"]);
}

#[test]
fn review_l1_a_list_that_cant_tell_never_forgets_ozzies_own_download() {
    let dir = Dir::new("kept-trust");
    change_kept(&dir.0, |ids| ids.push("qwen3:8b".into())).unwrap();
    let other = |n: usize| (format!("model-{n}:latest"), Some(1_000));
    // A list at the cap was cut (`local_ai::listed` keeps at most MAX_MODELS): the model may be past its end.
    let full: Vec<_> = (0..local_ai::MAX_MODELS).map(other).collect();
    assert_eq!(kept_now(&dir.0, Some(&full)).downloaded, ["qwen3:8b"]);
    // While a download is under way the list may be Ollama's mid-pull view, an empty one too.
    {
        let _busy = InFlight::start(&dir.0);
        assert_eq!(kept_now(&dir.0, Some(&[other(1)])).downloaded, ["qwen3:8b"]);
        assert_eq!(kept_now(&dir.0, Some(&[])).downloaded, ["qwen3:8b"]);
    }
    // A whole list without it, with nothing under way: deleted by the person, so it leaves the record.
    assert_eq!(kept_now(&dir.0, Some(&[other(1)])).downloaded, Vec::<String>::new());
    assert!(kept(&dir.0).downloaded.is_empty());
}

/// Ollama's download stream for qwen3:8b that, partway, has the AI screen look again (`find`) while Ollama lists only
/// `mid_pull`, as it may mid-pull; then the model is there, as after a real pull.
struct FindsMidway<'a> {
    ollama: &'a Ollama,
    dir: &'a Path,
    mid_pull: Vec<String>,
    found: Mutex<Option<LocalFind>>,
}
impl PullHttp for FindsMidway<'_> {
    fn pull(&self, _: &[u8], heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<u16, Failure> {
        for (n, line) in qwen3_8b_lines().iter().enumerate() {
            if n == 3 {
                let before = std::mem::replace(&mut *self.ollama.models.lock().unwrap(), self.mid_pull.clone());
                *self.found.lock().unwrap() = Some(find(self.dir, self.ollama, |_| true, 16 * GIB, Some(100_000_000_000)));
                *self.ollama.models.lock().unwrap() = before;
            }
            if !heard(Heard::Line(line.as_bytes())) {
                break;
            }
        }
        self.ollama.models.lock().unwrap().push("qwen3:8b".into());
        Ok(200)
    }
}

#[test]
fn review_l3_a_look_during_the_jobs_download_never_forgets_ozzies_own_download() {
    // Ozzie downloaded qwen3:4b earlier; now it downloads qwen3:8b, and the person opens the AI screen meanwhile, while
    // Ollama's mid-pull list leaves qwen3:4b out. The job holds the record (`InFlight`) from its own check to its end.
    let dir = Dir::new("in-flight");
    change_kept(&dir.0, |ids| ids.push("qwen3:4b".into())).unwrap();
    let ollama = Ollama::up(&["qwen3:4b"]);
    let pull = FindsMidway { ollama: &ollama, dir: &dir.0, mid_pull: vec!["llama3.2:latest".into()], found: Mutex::new(None) };
    let clock = || 1u64;
    let cancel = AtomicBool::new(false);
    let job = Job { pull: &pull, ..job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock) };
    assert_eq!(run(&job, &mut |_| {}).end, Some(End::Done));
    let found = pull.found.lock().unwrap().take().expect("the screen looked during the download");
    assert!(found.catalogue.iter().find(|row| row.id == "qwen3:4b").unwrap().downloaded_by_ozzie);
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:4b", "qwen3:8b"]);
    // Once the job has ended, a whole list without it is believed again.
    assert_eq!(kept_now(&dir.0, Some(&[("qwen3:8b".into(), None)])).downloaded, ["qwen3:8b"]);
}

#[test]
fn review_l2_an_empty_list_clears_the_record() {
    // Ozzie downloaded qwen3:8b; then the person deleted every model in Ollama, that one and Ozzie's copy included.
    let dir = Dir::new("kept-empty");
    change_kept(&dir.0, |ids| ids.push("qwen3:8b".into())).unwrap();
    let ollama = Ollama::up(&[]);
    assert_eq!(kept_now(&dir.0, Some(&[])).downloaded, Vec::<String>::new());
    assert!(kept(&dir.0).downloaded.is_empty());
    // Through finding too: Ollama answers and lists nothing, so Ozzie's download is gone and leaves the record.
    change_kept(&dir.0, |ids| ids.push("qwen3:8b".into())).unwrap();
    let ours = |found: &LocalFind| found.catalogue.iter().find(|row| row.id == "qwen3:8b").unwrap().downloaded_by_ozzie;
    assert!(!ours(&find(&dir.0, &ollama, |_| true, 16 * GIB, Some(100_000_000_000))));
    assert!(kept(&dir.0).downloaded.is_empty());
    // Later they get qwen3:8b on their own and set it up through Ozzie: never Ozzie's download, so the removal sheet
    // says it stays in Ollama, and removing takes only Ozzie's copy.
    ollama.models.lock().unwrap().push("qwen3:8b".into());
    let clock = || 1u64;
    let cancel = AtomicBool::new(false);
    assert_eq!(run(&job_with(&dir.0, &ollama, &cancel, model::route_generation(&dir.0), &clock), &mut |_| {}).end, Some(End::Done));
    assert!(!ours(&find(&dir.0, &ollama, |_| true, 16 * GIB, Some(100_000_000_000))));
    assert_eq!(remove(&dir.0, "qwen3:8b", &ollama).unwrap().removed, Removed::Removed);
    assert_eq!(*ollama.deletes.lock().unwrap(), [json!({"model": "ozzie-qwen3:8b"})]);
    assert_eq!(*ollama.models.lock().unwrap(), ["qwen3:8b"]);
}

#[test]
fn the_record_of_what_ozzie_downloaded_keeps_catalogue_ids_only() {
    let dir = Dir::new("kept");
    std::fs::write(dir.0.join(KEPT_FILE), br#"{"downloaded":["qwen3:8b","llama3.2:latest","../../x"]}"#).unwrap();
    assert_eq!(kept(&dir.0).downloaded, ["qwen3:8b"]);
    std::fs::write(dir.0.join(KEPT_FILE), b"not json").unwrap();
    assert_eq!(kept(&dir.0), Kept::default());
}

// ---- The real connection ------------------------------------------------------------------------------------------

/// A one-request server on this Mac's loopback: reads the request, then writes `answer` in the pieces given, waiting
/// `pause` between them. Returns the request it read and whether the client closed the connection before the end.
fn serve(pieces: Vec<Vec<u8>>, pause: Duration) -> (SocketAddr, std::thread::JoinHandle<(String, bool)>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") || !request.ends_with(b"}") {
            let n = socket.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..n]);
        }
        let mut closed_early = false;
        for (n, piece) in pieces.into_iter().enumerate() {
            if n > 0 {
                std::thread::sleep(pause);
            }
            if socket.write_all(&piece).is_err() {
                closed_early = true;
                break;
            }
            let _ = socket.flush();
        }
        if !closed_early {
            // Did the client go away? A read returns 0 (or fails) once it closed. macOS refuses the read wait itself
            // (EINVAL) once the client's reset has come, which is the same answer: under load the reset can land between
            // the last write and this line, which made the quiet-connection test fail (review L-6, 2026-11-18).
            // A read that only waited out its timeout is a client still connected, never one that closed (review L-2).
            closed_early = socket.set_read_timeout(Some(Duration::from_millis(1_500))).is_err()
                || match socket.read(&mut buffer) {
                    Ok(0) => true,
                    Ok(_) => false,
                    Err(e) => !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut),
                };
        }
        (String::from_utf8_lossy(&request).into_owned(), closed_early)
    });
    (address, handle)
}
fn chunk(bytes: &[u8]) -> Vec<u8> {
    let mut out = format!("{:x}\r\n", bytes.len()).into_bytes();
    out.extend_from_slice(bytes);
    out.extend_from_slice(b"\r\n");
    out
}

#[test]
fn the_real_connection_reads_ollamas_chunked_stream_line_by_line() {
    let head = b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    let all = qwen3_8b_lines().join("\n") + "\n";
    // Chunks that split lines and a line that spans two chunks, as a real stream may.
    let (a, b) = all.as_bytes().split_at(37);
    let (b, c) = b.split_at(500);
    let mut first = head;
    first.extend(chunk(a));
    let (address, server) = serve(vec![first, chunk(b), [chunk(c), b"0\r\n\r\n".to_vec()].concat()], Duration::from_millis(20));
    let mut got = Vec::new();
    let status = pull_at(address, br#"{"model":"qwen3:8b","stream":true}"#, PULL_POLL, &mut |what| {
        if let Heard::Line(line) = what {
            got.push(String::from_utf8(line.to_vec()).unwrap());
        }
        true
    });
    assert_eq!(status, Ok(200));
    assert_eq!(got, qwen3_8b_lines());
    let (request, _) = server.join().unwrap();
    assert!(request.starts_with("POST /api/pull HTTP/1.1\r\n"), "{request}");
    assert!(request.contains(&format!("\r\nHost: {address}\r\n")));
    assert!(request.contains("\r\nConnection: close\r\n"));
    assert!(request.ends_with("\r\n\r\n{\"model\":\"qwen3:8b\",\"stream\":true}"));
}

#[test]
fn the_real_connection_gives_an_answer_that_isnt_200_as_one_line_with_its_status() {
    let error = r#"{"error":"pull model manifest: file does not exist"}"#;
    let answer = format!("HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{error}", error.len()).into_bytes();
    let (address, server) = serve(vec![answer], Duration::ZERO);
    let mut got = Vec::new();
    let status = pull_at(address, b"{}", PULL_POLL, &mut |what| {
        if let Heard::Line(line) = what {
            got.push(String::from_utf8(line.to_vec()).unwrap());
        }
        true
    });
    assert_eq!(status, Ok(500));
    assert_eq!(got.len(), 1);
    assert_eq!(ended_by(serde_json::from_str::<Value>(&got[0]).unwrap()["error"].as_str().unwrap()), End::NotFound);
    server.join().unwrap();
}

#[test]
fn the_real_connection_says_quiet_while_ollama_is_silent_and_closes_when_told() {
    let head = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    let line = chunk(b"{\"status\":\"verifying sha256 digest\"}\n");
    // Ollama says one line, then nothing for a while.
    let (address, server) = serve(vec![[head, line].concat(), chunk(b"{\"status\":\"late\"}\n")], Duration::from_millis(900));
    let began = Instant::now();
    let mut quiet = 0;
    let status = pull_at(address, b"{}", Duration::from_millis(100), &mut |what| match what {
        Heard::Quiet => {
            quiet += 1;
            quiet < 3
        }
        Heard::Line(_) => true,
    });
    assert_eq!(status, Ok(200));
    assert_eq!(quiet, 3);
    // Closed within the poll, long before the late line, and the server saw the connection close.
    assert!(began.elapsed() < Duration::from_millis(1_700), "{:?}", began.elapsed());
    let (_, closed_early) = server.join().unwrap();
    assert!(closed_early);
}

/// The real connection to a server on this Mac's loopback, for `download`.
struct At(SocketAddr);
impl PullHttp for At {
    fn pull(&self, body: &[u8], heard: &mut dyn FnMut(Heard<'_>) -> bool) -> Result<u16, Failure> {
        pull_at(self.0, body, PULL_POLL, heard)
    }
}

#[test]
fn review_l3_a_hostile_stream_that_dribbles_bytes_without_a_line_still_hears_stop_and_the_stall() {
    // A byte every 30 ms and never a newline: before, no read waited a whole second and no line formed, so neither Stop
    // nor the stall was looked at until 64 KB had come.
    let dribble = |n: usize| {
        let mut pieces = vec![b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"status\":\"pulling manifest\"}\n".to_vec()];
        pieces.extend((0..n).map(|_| b"x".to_vec()));
        pieces
    };
    let (address, server) = serve(dribble(60), Duration::from_millis(30));
    let began = Instant::now();
    let ended = download("qwen3:8b", &At(address), &AtomicBool::new(false), Duration::from_millis(300), &mut |_, _, _| {});
    assert_eq!(ended, Err(End::Stalled));
    assert!(began.elapsed() < Duration::from_millis(1_500), "{:?}", began.elapsed());
    assert!(server.join().unwrap().1, "the connection was closed");
    // Stop pressed while it dribbles: heard on the next read.
    let (address, server) = serve(dribble(60), Duration::from_millis(30));
    let cancel = Arc::new(AtomicBool::new(false));
    let stop = cancel.clone();
    let presser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        stop.store(true, Ordering::SeqCst);
    });
    let began = Instant::now();
    assert_eq!(download("qwen3:8b", &At(address), &cancel, STALL_WAIT, &mut |_, _, _| {}), Err(End::Cancelled));
    assert!(began.elapsed() < Duration::from_millis(1_200), "{:?}", began.elapsed());
    presser.join().unwrap();
    assert!(server.join().unwrap().1);
    // A head that dribbles, too.
    let head: Vec<Vec<u8>> = b"HTTP/1.1 200 OK\r\nX-Slow: yes".iter().map(|b| vec![*b]).collect();
    let (address, server) = serve(head, Duration::from_millis(30));
    let began = Instant::now();
    let ended = download("qwen3:8b", &At(address), &AtomicBool::new(false), Duration::from_millis(300), &mut |_, _, _| {});
    assert_eq!(ended, Err(End::Stalled));
    assert!(began.elapsed() < Duration::from_millis(1_500), "{:?}", began.elapsed());
    let _ = server.join();
}

#[test]
fn review_m1_success_ends_the_download_even_when_the_server_keeps_the_connection_open() {
    // Ollama says nothing after success; a listener that says success and then holds the connection open, sending a
    // newline every 50 ms for six seconds, must not keep the job (and its busy slot) waiting: success ends the reading.
    let mut pieces = vec![
        b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"status\":\"pulling manifest\"}\n{\"status\":\"success\"}\n".to_vec(),
    ];
    pieces.extend((0..120).map(|_| b"\n".to_vec()));
    let (address, server) = serve(pieces, Duration::from_millis(50));
    let began = Instant::now();
    let ended = download("qwen3:8b", &At(address), &AtomicBool::new(false), STALL_WAIT, &mut |_, _, _| {});
    assert_eq!(ended, Ok(()));
    assert!(began.elapsed() < Duration::from_millis(1_500), "{:?}", began.elapsed());
    assert!(server.join().unwrap().1, "the connection was closed");
}

#[test]
fn review_l3_a_chunk_size_line_without_end_is_refused_not_kept() {
    let mut first = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    first.extend(std::iter::repeat_n(b'f', 4_000));
    let (address, server) = serve(vec![first], Duration::ZERO);
    let began = Instant::now();
    assert_eq!(pull_at(address, b"{}", PULL_POLL, &mut |_| true), Err(Failure::Unreachable));
    // Refused as soon as the line is too long, never kept until the server gives up (review L-2).
    assert!(began.elapsed() < Duration::from_secs(1), "{:?}", began.elapsed());
    let _ = server.join();
}

#[test]
fn the_real_connection_goes_only_to_this_macs_loopback() {
    assert_eq!(ollama_address(), Some("127.0.0.1:11434".parse().unwrap()));
    // Nothing listening there: Ollama isn't running.
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    assert_eq!(pull_at(free, b"{}", PULL_POLL, &mut |_| true), Err(Failure::Unreachable));
    // Any other address is refused before a connection is tried.
    let began = Instant::now();
    assert_eq!(pull_at("192.0.2.1:11434".parse().unwrap(), b"{}", PULL_POLL, &mut |_| true), Err(Failure::Unreachable));
    assert!(began.elapsed() < Duration::from_millis(200));
    // One connection in the code, made only after the loopback check; no program is started; no other client.
    let code = include_str!("local_models.rs").split("#[cfg(test)]").next().unwrap();
    assert_eq!(code.matches("TcpStream::connect").count(), 1);
    let check = code.find("if !address.ip().is_loopback()").unwrap();
    assert!(check < code.find("TcpStream::connect").unwrap());
    for absent in ["Command::new", "reqwest", "ToSocketAddrs", "localhost"] {
        assert!(!code.contains(absent), "{absent}");
    }
}

// ---- The page reads these words -----------------------------------------------------------------------------------

/// An enum's variants as serde writes them (kebab-case), read from this crate's source.
fn variants(source: &str, start: &str) -> Vec<String> {
    let body = &source[source.find(start).unwrap_or_else(|| panic!("{start}")) + start.len()..];
    let body = &body[..body.find("\n}").unwrap()];
    body.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("//") && line.ends_with(','))
        .map(|line| {
            let mut word = String::new();
            for (i, c) in line.trim_end_matches(',').chars().enumerate() {
                if c.is_ascii_uppercase() && i > 0 {
                    word.push('-');
                }
                word.push(c.to_ascii_lowercase());
            }
            word
        })
        .collect()
}
/// The quoted words of one closed list in the page's source.
fn page_words(source: &str, start: &str) -> Vec<String> {
    let from = source.find(start).unwrap_or_else(|| panic!("{start}")) + start.len();
    let list = &source[from..];
    let list = &list[..list.find("] as const;").unwrap()];
    list.split('"').skip(1).step_by(2).map(str::to_owned).collect()
}

#[test]
fn every_closed_word_native_gives_for_a_download_is_the_pages_own_list() {
    let page = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../product/desktop/src/onboarding-bridge.ts"),
    )
    .expect("product/desktop/src/onboarding-bridge.ts, the page's side of these words");
    let code = include_str!("local_models.rs");
    for (native, list) in [
        ("pub enum Phase {", "const MODEL_PHASES = ["),
        ("pub enum End {", "const MODEL_ENDS = ["),
        ("pub enum Refusal {", "const DOWNLOAD_REFUSALS = ["),
        ("pub enum Disk {", "const DISK_ROOMS = ["),
        ("pub enum Size {", "const MODEL_SIZES = ["),
        ("pub enum Removed {", "const MODEL_REMOVED = ["),
    ] {
        let (mut native_words, mut page_list) = (variants(code, native), page_words(&page, list));
        native_words.sort();
        page_list.sort();
        assert_eq!(native_words, page_list, "{native}");
    }
    // The words as serde writes them.
    assert_eq!(serde_json::to_string(&Disk::NotEnough).unwrap(), r#""not-enough""#);
    assert_eq!(serde_json::to_string(&Refusal::NotInCatalogue).unwrap(), r#""not-in-catalogue""#);
    assert_eq!(serde_json::to_string(&Removed::Removed).unwrap(), r#""removed""#);
}

/// For a live check by hand against Ollama on this Mac, with a model it already has (`OZZIE_LIVE_MODEL`, default
/// qwen3:8b): Ozzie's own connection pulls it, and closes at once if any line says a byte would still be downloaded,
/// so nothing new comes onto the disk. `cargo test --lib live_pull_of_a_model_already_here -- --ignored --nocapture`
#[test]
#[ignore = "talks to Ollama on this Mac"]
fn live_pull_of_a_model_already_here() {
    let id = std::env::var("OZZIE_LIVE_MODEL").unwrap_or_else(|_| "qwen3:8b".into());
    let began = Instant::now();
    let mut lines = 0;
    let mut wanted_bytes = false;
    let status = NativePull.pull(&serde_json::to_vec(&json!({"model": id, "stream": true})).unwrap(), &mut |what| {
        let Heard::Line(line) = what else { return true };
        lines += 1;
        let value: Value = serde_json::from_slice(line).unwrap();
        println!("{:>6.2}s {}", began.elapsed().as_secs_f64(), String::from_utf8_lossy(line));
        let (total, done) = (value["total"].as_u64(), value["completed"].as_u64().unwrap_or(0));
        wanted_bytes |= total.is_some_and(|total| done < total);
        !wanted_bytes
    });
    println!("STATUS {status:?} LINES {lines} SECONDS {:.2} STOPPED-FOR-BYTES {wanted_bytes}", began.elapsed().as_secs_f64());
    assert!(!wanted_bytes, "Ollama would have downloaded something: closed at once");
}
/// The whole job against Ollama on this Mac for a model it already has, set up and checked into a fresh folder (never
/// the app's own): the steps as the page hears them, and the check's verdict.
/// `cargo test --lib live_job_on_a_model_already_here -- --ignored --nocapture`
#[test]
#[ignore = "talks to Ollama on this Mac"]
fn live_job_on_a_model_already_here() {
    let id = std::env::var("OZZIE_LIVE_MODEL").unwrap_or_else(|_| "qwen3:8b".into());
    let id = entry(&id).expect("a catalogue id").1.id.clone();
    let dir = Dir::new("live");
    let http = local_ai::NativeLocalHttp::new(local_ai::ANSWER_WAIT).unwrap();
    let listed = local_ai::listed(App::Ollama, &http).expect("Ollama answering");
    assert!(listed.iter().any(|(m, _)| local_ai::same_model(m, &id)), "{id} must already be on this Mac: nothing is downloaded here");
    let cancel = AtomicBool::new(false);
    let names = NameGuard::default();
    let began = Instant::now();
    let job = Job { dir: &dir.0, id: &id, names: &names, http: &http, pull: &NativePull, clock: &crate::sunday_check::unix_ms, cancel: &cancel,
        choices: model::route_generation(&dir.0), stall: STALL_WAIT };
    let end = run(&job, &mut |p| println!("{:>6.2}s {}", began.elapsed().as_secs_f64(), serde_json::to_string(p).unwrap()));
    println!("END {:.2}s {}", began.elapsed().as_secs_f64(), serde_json::to_string(&end).unwrap());
    println!("ROUTE {:?}", model::usable_config(&dir.0).map(|c| (c.base_url, c.model)));
    assert_eq!(end.end, Some(End::Done));
}

#[test]
#[ignore = "prints the exact create request for a live check by hand"]
fn live_setup_body() {
    // `cargo test --lib live_setup_body -- --ignored --nocapture`, then send it with curl to /api/create.
    let id = std::env::var("OZZIE_LIVE_MODEL").unwrap_or_else(|_| "qwen3:8b".into());
    println!("CREATE {}", serde_json::to_string(&create_body(&id)).unwrap());
}
