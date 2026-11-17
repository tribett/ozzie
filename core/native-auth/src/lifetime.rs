use std::sync::{
    Mutex, MutexGuard, TryLockError,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

/// Serializes changes of native consumers; cancellation invalidates a transition
/// even before its newly constructed controller has been installed.
#[derive(Default)]
pub struct Lifetime {
    transition: Mutex<()>,
    generation: AtomicU64,
}
impl Lifetime {
    pub fn enter(&self) -> Option<(MutexGuard<'_, ()>, u64)> {
        let lock = match self.transition.try_lock() {
            Ok(lock) => lock,
            // The lock guards no data, only whose turn it is: a transition that panicked while
            // holding it leaves nothing behind here, so the next one goes ahead instead of every
            // later one answering busy until Ozzie restarts (review N, 7). What a transition
            // changes is kept, and checked, by `connections` under its own lock.
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return None,
        };
        Some((lock, self.generation.load(Ordering::SeqCst)))
    }
    /// `enter`, waiting up to `wait` for a transition under way to finish; nothing past that.
    pub fn enter_within(&self, wait: Duration) -> Option<(MutexGuard<'_, ()>, u64)> {
        let started = Instant::now();
        loop {
            if let Some(entered) = self.enter() {
                return Some(entered);
            }
            if started.elapsed() >= wait {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
}
