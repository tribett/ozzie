use super::*;
use crate::test_support::{FakeB1, FakeClock, NOW, ok};
use serde_json::json;

fn get() -> Get {
    let read = crate::b1::Read::Church(crate::capture::Id::new("CHUfict01").unwrap());
    Get::new(&read, crate::http::Auth::Bearer(crate::test_support::key()))
}

/// A pacer shared by two runs keeps the gap between them; a fresh one doesn't know the other run's requests.
#[test]
fn a_shared_pacer_keeps_the_gap_across_runs() {
    let clock = FakeClock::at(NOW);
    let fake = FakeB1::empty(clock.clone());
    fake.set("/membership/churches/CHUfict01", ok(json!({})));
    let limits = Limits {
        min_gap: Duration::from_secs(2),
        ..LIMITS
    };
    let decode = crate::project::decoder(ReadError::Refused);
    let pacer = Pacer::new();
    for _ in 0..3 {
        let mut run = Run::paced(&fake, &*clock, limits, Some(&pacer));
        run.send(get(), &decode).unwrap();
    }
    let at: Vec<Duration> = fake.calls().iter().map(|c| c.at).collect();
    assert!(
        at.windows(2).all(|w| w[1] - w[0] >= Duration::from_secs(2)),
        "{at:?}"
    );
    // Without one, each run starts at once.
    let before = clock.elapsed();
    Run::new(&fake, &*clock, limits)
        .send(get(), &decode)
        .unwrap();
    assert!(fake.calls().last().unwrap().at - before < Duration::from_secs(2));
}

/// The ceiling: at most `per_minute` request starts in any 60 s, waiting for the oldest to leave the window.
#[test]
fn at_most_per_minute_requests_in_any_sixty_seconds() {
    let clock = FakeClock::at(NOW);
    let fake = FakeB1::empty(clock.clone());
    fake.set("/membership/churches/CHUfict01", ok(json!({})));
    let limits = Limits {
        min_gap: Duration::from_millis(100),
        per_minute: Some(3),
        budget: Duration::from_secs(600),
        ..LIMITS
    };
    let decode = crate::project::decoder(ReadError::Refused);
    let pacer = Pacer::new();
    for _ in 0..7 {
        let mut run = Run::paced(&fake, &*clock, limits, Some(&pacer));
        run.send(get(), &decode).unwrap();
    }
    let at: Vec<Duration> = fake.calls().iter().map(|c| c.at).collect();
    for (i, start) in at.iter().enumerate() {
        let within = at[i..]
            .iter()
            .filter(|t| **t - *start < Duration::from_secs(60))
            .count();
        assert!(within <= 3, "{at:?}");
    }
    assert!(at[3] - at[0] >= Duration::from_secs(60));
}

/// An `Http` that answers `{}` and notes when each request was sent, on the real clock.
struct Stamps {
    origin: std::time::Instant,
    at: std::sync::Mutex<Vec<Duration>>,
}
impl Http for Stamps {
    fn get(&self, _request: &Get) -> Result<Reply, ReadError> {
        self.at.lock().unwrap().push(self.origin.elapsed());
        Ok(Reply::new(200, b"{}".to_vec()))
    }
}
fn sorted(stamps: &Stamps) -> Vec<Duration> {
    let mut at = stamps.at.lock().unwrap().clone();
    at.sort();
    at
}

/// Review E, M3: runs on several threads sharing one pacer, on the real clock. Each start is reserved under the
/// lock, so starts are one gap apart (less only what the OS adds waking a thread) whatever the interleaving.
#[test]
fn a_shared_pacer_holds_the_gap_across_threads_on_the_real_clock() {
    let clock = SystemClock::new();
    let stamps = Stamps {
        origin: std::time::Instant::now(),
        at: std::sync::Mutex::new(Vec::new()),
    };
    let limits = Limits {
        min_gap: Duration::from_millis(100),
        ..LIMITS
    };
    let pacer = Pacer::new();
    let decode = crate::project::decoder(ReadError::Refused);
    std::thread::scope(|s| {
        for _ in 0..3 {
            s.spawn(|| {
                Run::paced(&stamps, &clock, limits, Some(&pacer))
                    .send(get(), &decode)
                    .unwrap();
            });
        }
    });
    let at = sorted(&stamps);
    assert_eq!(at.len(), 3);
    for pair in at.windows(2) {
        assert!(pair[1] - pair[0] >= Duration::from_millis(90), "{at:?}");
    }
}

/// The ceiling too: 4 threads, a 50 ms gap, at most 2 starts in a (shortened, for the test) 400 ms window.
#[test]
fn a_shared_pacer_holds_the_ceiling_across_threads_on_the_real_clock() {
    let clock = SystemClock::new();
    let stamps = Stamps {
        origin: std::time::Instant::now(),
        at: std::sync::Mutex::new(Vec::new()),
    };
    let limits = Limits {
        min_gap: Duration::from_millis(50),
        per_minute: Some(2),
        ..LIMITS
    };
    let pacer = Pacer::with_window(Duration::from_millis(400));
    let decode = crate::project::decoder(ReadError::Refused);
    std::thread::scope(|s| {
        for _ in 0..4 {
            s.spawn(|| {
                Run::paced(&stamps, &clock, limits, Some(&pacer))
                    .send(get(), &decode)
                    .unwrap();
            });
        }
    });
    let at = sorted(&stamps);
    assert_eq!(at.len(), 4);
    for i in 0..at.len() - 2 {
        assert!(at[i + 2] - at[i] >= Duration::from_millis(385), "{at:?}");
    }
}

/// The same on the fake clock: the slots the pacer hands out, one per start, are exactly a gap apart and within the
/// ceiling, whichever thread asked first.
#[test]
fn a_shared_pacer_reserves_each_start_on_the_fake_clock() {
    let clock = FakeClock::at(NOW);
    let fake = FakeB1::empty(clock.clone());
    fake.set("/membership/churches/CHUfict01", ok(json!({})));
    let limits = Limits {
        min_gap: Duration::from_millis(3500),
        per_minute: Some(3),
        budget: Duration::from_secs(600),
        ..LIMITS
    };
    let pacer = Pacer::new();
    let decode = crate::project::decoder(ReadError::Refused);
    std::thread::scope(|s| {
        for _ in 0..6 {
            s.spawn(|| {
                Run::paced(&fake, &*clock, limits, Some(&pacer))
                    .send(get(), &decode)
                    .unwrap();
            });
        }
    });
    let slots = pacer.reserved();
    assert_eq!(slots.len(), 6);
    for pair in slots.windows(2) {
        assert!(
            pair[1] - pair[0] >= Duration::from_millis(3500),
            "{slots:?}"
        );
    }
    for i in 0..slots.len() - 3 {
        assert!(
            slots[i + 3] - slots[i] >= Duration::from_secs(60),
            "{slots:?}"
        );
    }
}

/// A start the pacer can only give past the run's budget isn't slept toward: the run stops at once as `timeout`.
#[test]
fn a_slot_past_the_budget_isnt_waited_for() {
    let clock = FakeClock::at(NOW);
    let fake = FakeB1::empty(clock.clone());
    fake.set("/membership/churches/CHUfict01", ok(json!({})));
    let limits = Limits {
        min_gap: Duration::ZERO,
        per_minute: Some(2),
        budget: Duration::from_secs(5),
        ..LIMITS
    };
    let decode = crate::project::decoder(ReadError::Refused);
    let mut run = Run::new(&fake, &*clock, limits);
    run.send(get(), &decode).unwrap();
    run.send(get(), &decode).unwrap();
    let before = clock.elapsed();
    assert_eq!(
        run.send(get(), &decode).unwrap_err(),
        Miss::NotSent(crate::capture::Outcome::Timeout)
    );
    assert!(clock.elapsed() - before < Duration::from_secs(1));
}
