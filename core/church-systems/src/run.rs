//! One run of reads against a church system: paced, counted, inside a budget, stopped by repeated failures, and every
//! read recorded with its outcome and check time (a read that failed or was cut short is recorded, not dropped).
//!
//! - Pacing: at least `Limits::min_gap` between the starts of two requests (250 ms: no more than 4 a second), and, when
//!   the system sets one, at most `Limits::per_minute` request starts in any 60 s. Runs against one system can share a
//!   `Pacer`, so a key check, a picker and a check made one after another keep one gap and one count between them.
//! - At most `Limits::max_requests` requests (40). A read that would pass it isn't sent; the run stops.
//! - The whole run within `Limits::budget` (60 s). A read that would start after it is a `timeout` and the run stops;
//!   each request is given at most what is left.
//! - `Limits::breaker` failures in a row (3) stop the run. A `key-refused` or `rate-limited` stops it at once: going
//!   on would only repeat the refusal or press a system that asked Ozzie to wait.
//! - Once stopped, every read still to come is recorded as `not-requested`.
//!
//! The clock and the HTTP client are passed in, so tests run a whole check on fixed data and a fake clock.
use crate::capture::{Outcome, ReadRecord, ReadWord, Time};
use crate::http::{Get, Http, ReadError, Reply};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Time for a run: a steady count for pacing and the budget, the wall clock for check times, and a way to wait.
pub trait Clock: Send + Sync {
    /// Time since a fixed moment; never goes backwards.
    fn elapsed(&self) -> Duration;
    /// Milliseconds since 1970-01-01T00:00:00Z.
    fn unix_millis(&self) -> i64;
    fn sleep(&self, wait: Duration);
}
/// The real clock.
pub struct SystemClock {
    origin: Instant,
}
impl SystemClock {
    pub fn new() -> SystemClock {
        SystemClock {
            origin: Instant::now(),
        }
    }
}
impl Default for SystemClock {
    fn default() -> Self {
        SystemClock::new()
    }
}
impl Clock for SystemClock {
    fn elapsed(&self) -> Duration {
        self.origin.elapsed()
    }
    fn unix_millis(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
    fn sleep(&self, wait: Duration) {
        std::thread::sleep(wait);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub min_gap: Duration,
    /// At most this many request starts in any 60 s (a system with a per-minute limit); `None`: only the gap.
    pub per_minute: Option<u32>,
    pub max_requests: u32,
    pub budget: Duration,
    pub breaker: u32,
}
pub const LIMITS: Limits = Limits {
    min_gap: Duration::from_millis(250),
    per_minute: None,
    max_requests: 40,
    budget: Duration::from_secs(60),
    breaker: 3,
};

/// Why a request wasn't answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Miss {
    /// Not sent: the run has stopped, or this request would pass the request cap or the budget. The outcome is what
    /// the read is recorded as if nothing of it was read.
    NotSent(Outcome),
    Failed(ReadError),
}
impl Miss {
    pub(crate) fn outcome(self) -> Outcome {
        match self {
            Miss::NotSent(outcome) => outcome,
            Miss::Failed(error) => error.into(),
        }
    }
}

/// The request starts that runs sharing it have made, on their shared clock (`Clock::elapsed`): the last 60 s of them,
/// which is all the gap and the per-minute ceiling need. Runs share one only when they share the clock. It lives in
/// one process: two processes (two runs of the developer tool) can't share one.
#[derive(Debug)]
pub struct Pacer {
    starts: Mutex<VecDeque<Duration>>,
    /// The span the per-minute ceiling counts over: a minute, shorter only in tests on the real clock.
    window: Duration,
    #[cfg(test)]
    log: Mutex<Vec<Duration>>,
}
impl Default for Pacer {
    fn default() -> Self {
        Pacer {
            starts: Mutex::new(VecDeque::new()),
            window: MINUTE,
            #[cfg(test)]
            log: Mutex::new(Vec::new()),
        }
    }
}
impl Pacer {
    pub fn new() -> Pacer {
        Pacer::default()
    }
    #[cfg(test)]
    pub(crate) fn with_window(window: Duration) -> Pacer {
        Pacer {
            window,
            ..Pacer::default()
        }
    }
    /// Every start handed out, in order (tests only).
    #[cfg(test)]
    pub(crate) fn reserved(&self) -> Vec<Duration> {
        self.log.lock().unwrap().clone()
    }
    /// Reserves the next request start at or after `now` for `limits`: at least `min_gap` after the last start, and no
    /// more than `per_minute` starts in any window. The start is worked out and recorded while the lock is held, so
    /// two runs sharing the pacer (on two threads) never get the same slot, whatever the interleaving; the caller
    /// sleeps until it afterwards, outside the lock. Starts are recorded in order, so the queue stays sorted. A start
    /// at or past `deadline` (the end of the caller's budget) isn't handed out or recorded: `None`.
    fn reserve(&self, now: Duration, limits: &Limits, deadline: Duration) -> Option<Duration> {
        let mut starts = self.starts.lock().unwrap_or_else(|e| e.into_inner());
        while starts
            .front()
            .is_some_and(|t| now.saturating_sub(*t) >= self.window)
        {
            starts.pop_front();
        }
        let mut at = now;
        if let Some(last) = starts.back() {
            at = at.max(*last + limits.min_gap);
        }
        if let Some(n) = limits.per_minute.filter(|n| *n > 0).map(|n| n as usize)
            && starts.len() >= n
        {
            at = at.max(starts[starts.len() - n] + self.window);
        }
        if at >= deadline {
            return None;
        }
        starts.push_back(at);
        #[cfg(test)]
        self.log.lock().unwrap_or_else(|e| e.into_inner()).push(at);
        Some(at)
    }
}
const MINUTE: Duration = Duration::from_secs(60);

/// A read's projection: what it gave, and whether only part of it could be kept.
pub(crate) type Projected<T> = (T, bool);

pub(crate) struct Run<'a> {
    http: &'a dyn Http,
    clock: &'a dyn Clock,
    limits: Limits,
    begun: Duration,
    begun_unix: i64,
    own: Pacer,
    shared: Option<&'a Pacer>,
    requests: u32,
    /// Requests that came back with an answer the read accepted.
    answered: u32,
    failures: u32,
    stopped: bool,
    reads: Vec<ReadRecord>,
}
impl<'a> Run<'a> {
    pub(crate) fn new(http: &'a dyn Http, clock: &'a dyn Clock, limits: Limits) -> Run<'a> {
        Run::paced(http, clock, limits, None)
    }
    /// A run whose pacing is shared with other runs through `pacer`; `None`: its own.
    pub(crate) fn paced(
        http: &'a dyn Http,
        clock: &'a dyn Clock,
        limits: Limits,
        pacer: Option<&'a Pacer>,
    ) -> Run<'a> {
        // Whole seconds, so the start written in the capture is never after a check time.
        let begun_unix = clock.unix_millis().div_euclid(1000) * 1000;
        Run {
            http,
            clock,
            limits,
            begun: clock.elapsed(),
            begun_unix,
            own: Pacer::new(),
            shared: pacer,
            requests: 0,
            answered: 0,
            failures: 0,
            stopped: false,
            reads: Vec::new(),
        }
    }
    /// The wall-clock time now, as the run counts it: its start plus the steady time since, so check times never go
    /// backwards when the Mac's clock is changed during a run.
    pub(crate) fn now(&self) -> Time {
        let since = self.clock.elapsed().saturating_sub(self.begun);
        Time::from_unix_millis(self.begun_unix + since.as_millis() as i64)
            .unwrap_or_else(|| self.started_at())
    }
    pub(crate) fn started_at(&self) -> Time {
        Time::from_unix_millis(self.begun_unix).expect("a clock reads a time in years 1 to 9999")
    }

    /// Before any request: refused unsent when the run has stopped or a limit would be passed, otherwise paced and
    /// counted. Gives how long the request may take (what is left of the budget).
    fn gate(&mut self) -> Result<Duration, Miss> {
        if self.stopped {
            return Err(Miss::NotSent(Outcome::NotRequested));
        }
        if self.requests >= self.limits.max_requests {
            self.stopped = true;
            return Err(Miss::NotSent(Outcome::NotRequested));
        }
        let pacer = self.shared.unwrap_or(&self.own);
        // A start past the budget isn't slept toward: the run stops now, as it would after the wait.
        let Some(start) = pacer.reserve(
            self.clock.elapsed(),
            &self.limits,
            self.begun + self.limits.budget,
        ) else {
            self.stopped = true;
            return Err(Miss::NotSent(Outcome::Timeout));
        };
        let now = self.clock.elapsed();
        if start > now {
            self.clock.sleep(start - now);
        }
        let used = self.clock.elapsed().saturating_sub(self.begun);
        if used >= self.limits.budget {
            self.stopped = true;
            return Err(Miss::NotSent(Outcome::Timeout));
        }
        self.requests += 1;
        Ok(self.limits.budget - used)
    }
    /// One GET, through `gate`, its answer checked by `decode` (status, JSON, the system's own rules).
    pub(crate) fn send(
        &mut self,
        get: Get,
        decode: &dyn Fn(&Reply) -> Result<Value, ReadError>,
    ) -> Result<Value, Miss> {
        let left = self.gate()?;
        let reply = self.http.get(&get.with_limit(left)).map_err(Miss::Failed)?;
        let value = decode(&reply).map_err(Miss::Failed)?;
        self.answered += 1;
        Ok(value)
    }
    /// Whether any request of this run has been answered (a system that gives a refusal after a good answer a
    /// different meaning reads it here).
    pub(crate) fn answered(&self) -> bool {
        self.answered > 0
    }
    /// Records how `word` went, at the run's time now, and applies the breaker.
    pub(crate) fn record(&mut self, word: ReadWord, outcome: Outcome) {
        let checked_at = self.now();
        self.reads.push(ReadRecord {
            read: word,
            checked_at,
            outcome,
        });
        match outcome {
            Outcome::Ok | Outcome::Truncated => self.failures = 0,
            Outcome::NotRequested => {}
            Outcome::KeyRefused | Outcome::RateLimited => {
                self.failures += 1;
                self.stopped = true;
            }
            _ => {
                self.failures += 1;
                if self.failures >= self.limits.breaker {
                    self.stopped = true;
                }
            }
        }
    }
    /// Changes `word`'s recorded outcome from `from` to `to` (only that), when what was read later shows it was less
    /// than it seemed. The breaker isn't touched.
    pub(crate) fn amend(&mut self, word: ReadWord, from: Outcome, to: Outcome) {
        for read in self.reads.iter_mut().filter(|r| r.read == word) {
            if read.outcome == from {
                read.outcome = to;
            }
        }
    }
    /// Records a read that wasn't asked because something it depends on failed.
    pub(crate) fn skip(&mut self, word: ReadWord) {
        self.record(word, Outcome::NotRequested);
    }
    /// One read of one request: sent, decoded, projected, recorded. `None` when it failed or wasn't sent; a
    /// projection that fails is `invalid-response` (or its own error), and nothing of that read is kept.
    pub(crate) fn read<T>(
        &mut self,
        word: ReadWord,
        get: Get,
        decode: &dyn Fn(&Reply) -> Result<Value, ReadError>,
        project: impl FnOnce(&Value) -> Result<Projected<T>, ReadError>,
    ) -> Option<T> {
        let result = self
            .send(get, decode)
            .and_then(|value| project(&value).map_err(Miss::Failed));
        match result {
            Ok((value, truncated)) => {
                let outcome = if truncated {
                    Outcome::Truncated
                } else {
                    Outcome::Ok
                };
                self.record(word, outcome);
                Some(value)
            }
            Err(miss) => {
                self.record(word, miss.outcome());
                None
            }
        }
    }
    /// The reads recorded, and the time the run completed.
    pub(crate) fn finish(self) -> (Vec<ReadRecord>, Time) {
        let completed = self.now();
        (self.reads, completed)
    }
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;
