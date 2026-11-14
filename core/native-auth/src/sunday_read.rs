//! Owned native page capability. No production issuer, deserializer, clone or token getter.
use crate::{
    source::{SourceError, SourceRequest},
    sunday::{SundayAuthority, SundayRefusal, VerifiedCredentialReceipt},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq, Eq)]
pub enum SundayReadFailure {
    Refused(SundayRefusal),
    Source(SourceError),
}
impl From<SourceError> for SundayReadFailure {
    fn from(error: SourceError) -> Self {
        Self::Source(error)
    }
}
impl From<SundayRefusal> for SundayReadFailure {
    fn from(error: SundayRefusal) -> Self {
        Self::Refused(error)
    }
}
pub struct SundayPagePermit {
    authority: Arc<SundayAuthority>,
    receipt: Arc<VerifiedCredentialReceipt>,
    request: SourceRequest,
    word: u64,
    admitted: Instant,
    started: Instant,
    deadline: Instant,
    #[cfg(test)]
    clock: Option<Arc<std::sync::Mutex<Instant>>>,
}
impl SundayPagePermit {
    pub(crate) fn word(&self) -> u64 {
        self.word
    }
    pub(crate) fn matches_receipt(&self, receipt: &VerifiedCredentialReceipt) -> bool {
        self.receipt.same_cell(receipt)
    }
    pub(crate) fn check(
        &self,
        authority: &SundayAuthority,
        request: &SourceRequest,
    ) -> Result<(), SundayRefusal> {
        if !std::ptr::eq(authority, Arc::as_ptr(&self.authority)) {
            return Err(SundayRefusal::ControllerMismatch);
        }
        if !self.receipt.matches_binding((
            &request.workspace,
            &request.organization,
            &request.client_id,
        )) {
            return Err(SundayRefusal::BindingMismatch);
        }
        // Validated closed fields; URL covers collection, service, plan, page size and offset.
        if self.request.url() != request.url() {
            return Err(SundayRefusal::ScopeMismatch);
        }
        let now = self.now();
        if self.started < self.admitted
            || self.started > now
            || self.deadline
                != (self.started + Duration::from_secs(9))
                    .min(self.admitted + Duration::from_secs(30))
            || now >= self.deadline
        {
            return Err(SundayRefusal::TimedOut);
        }
        Ok(())
    }
    fn now(&self) -> Instant {
        #[cfg(test)]
        if let Some(clock) = &self.clock {
            return *clock.lock().unwrap();
        }
        Instant::now()
    }
    #[cfg(test)]
    pub(crate) fn fixture_clock(&mut self) -> (Arc<std::sync::Mutex<Instant>>, Instant) {
        let clock = Arc::new(std::sync::Mutex::new(self.started));
        self.clock = Some(clock.clone());
        (clock, self.deadline)
    }
    #[cfg(test)]
    pub(crate) fn fixture_ages(&mut self, admission_age: Duration, page_age: Duration) {
        let now = Instant::now();
        self.admitted = now - admission_age;
        self.started = now - page_age;
        self.deadline =
            (self.started + Duration::from_secs(9)).min(self.admitted + Duration::from_secs(30));
        self.clock = Some(Arc::new(std::sync::Mutex::new(now)));
    }
    #[cfg(test)]
    pub(crate) fn fixture(authority: Arc<SundayAuthority>, request: &SourceRequest) -> Self {
        // Bounded running-word fixture only, never proof of registered attempt admission.
        authority.fixture_running();
        let receipt = authority.fixture_receipt();
        let word = authority.word.load(std::sync::atomic::Ordering::SeqCst);
        let now = Instant::now();
        Self {
            authority,
            receipt,
            request: request.clone(),
            word,
            admitted: now,
            started: now,
            deadline: now + Duration::from_secs(9),
            clock: None,
        }
    }
}
