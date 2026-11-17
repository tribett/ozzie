use ozzie_native_auth::lifetime::Lifetime;
#[test]
fn cancellation_invalidates_transition_without_waiting_for_it_to_finish() {
    let lifetime = Lifetime::default();
    let (guard, generation) = lifetime.enter().unwrap();
    assert!(lifetime.current(generation));
    assert!(lifetime.enter().is_none());
    lifetime.cancel();
    assert!(!lifetime.current(generation));
    drop(guard);
    let (_next_guard, next_generation) = lifetime.enter().unwrap();
    assert!(lifetime.current(next_generation));
}
#[test]
fn a_bounded_wait_takes_the_transition_once_it_is_free_or_gives_up() {
    use std::time::{Duration, Instant};
    let lifetime = Lifetime::default();
    // Free: taken at once.
    let (guard, _) = lifetime.enter_within(Duration::from_secs(5)).unwrap();
    // Held past the wait: nothing, after the wait.
    let started = Instant::now();
    assert!(lifetime.enter_within(Duration::from_millis(100)).is_none());
    assert!(started.elapsed() >= Duration::from_millis(100));
    // Freed while waiting: taken then.
    std::thread::scope(|scope| {
        let waiting = scope.spawn(|| {
            lifetime
                .enter_within(Duration::from_secs(5))
                .map(|(_, g)| g)
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(!waiting.is_finished());
        drop(guard);
        assert!(waiting.join().unwrap().is_some());
    });
}
#[test]
fn a_transition_that_panicked_never_leaves_every_later_one_busy() {
    // Review N, 7: the lock guards no data, only whose turn it is, so a transition that panicked
    // while holding it leaves nothing behind: the next one goes ahead.
    let lifetime = std::sync::Arc::new(Lifetime::default());
    let held = lifetime.clone();
    let panicked = std::thread::spawn(move || {
        let _turn = held.enter().unwrap();
        panic!("a fictional fault mid-transition");
    })
    .join();
    assert!(panicked.is_err());
    let (turn, generation) = lifetime.enter().expect("not busy after a panic");
    assert!(lifetime.current(generation));
    // Still one at a time.
    assert!(lifetime.enter().is_none());
    drop(turn);
    assert!(
        lifetime
            .enter_within(std::time::Duration::from_millis(100))
            .is_some()
    );
}
