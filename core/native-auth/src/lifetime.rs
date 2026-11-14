use std::sync::{
    Mutex, MutexGuard,
    atomic::{AtomicU64, Ordering},
};

/// Serializes changes of native consumers; cancellation invalidates a transition
/// even before its newly constructed controller has been installed.
#[derive(Default)]
pub struct Lifetime {
    transition: Mutex<()>,
    generation: AtomicU64,
}
impl Lifetime {
    pub fn enter(&self) -> Option<(MutexGuard<'_, ()>, u64)> {
        self.transition
            .try_lock()
            .ok()
            .map(|lock| (lock, self.generation.load(Ordering::SeqCst)))
    }
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
}
