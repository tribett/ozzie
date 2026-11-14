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
