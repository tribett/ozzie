//! Native authority and verified receipt. No production attempt issuer is supplied.
use sha2::Digest;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SundayRefusal {
    NotReady,
    Retired,
    Poisoned,
    Busy,
    Contended,
    ControllerMismatch,
    ReceiptMismatch,
    BindingMismatch,
    ScopeMismatch,
    Cancelled,
    TimedOut,
    RevisionExhausted,
    InvalidWord,
    EntropyUnavailable,
}
pub(crate) const REV: u64 = (1 << 40) - 1;
pub(crate) const CANCEL: u64 = 1 << 55;
pub(crate) const RETIRED: u64 = 1 << 56;
pub(crate) const POISON: u64 = 1 << 57;
pub(crate) fn known_word(word: u64) -> Result<(), SundayRefusal> {
    if word >> 58 != 0 || (word >> 47) & 15 > 12 || (word >> 51) & 15 == 15 {
        Err(SundayRefusal::InvalidWord)
    } else {
        Ok(())
    }
}
pub(crate) fn outstanding(word: u64) -> bool {
    matches!((word >> 47) & 15, 1..=4 | 11 | 12)
}
// Nonzero-sized allocations provide identity independently of counters or binding equality.
// The non-Clone proof never escapes a failed constructor. Withdrawal is one-way;
// a live controller cannot be replaced or withdrawn by any production caller.
pub(crate) struct ControllerInstance(Arc<u8>, Arc<u8>, Arc<AtomicBool>);
pub(crate) struct VerifiedCredentialReceipt {
    controller: Arc<u8>,
    workspace: String,
    organization: String,
    client: String,
    digest: [u8; 32],
    credential: Arc<u8>,
    cell: Arc<u8>,
    arm: u64,
}
impl VerifiedCredentialReceipt {
    pub(crate) fn new(
        controller: &ControllerInstance,
        scope: (&str, &str, &str),
        bytes: &[u8],
    ) -> Self {
        Self {
            controller: controller.0.clone(),
            workspace: scope.0.into(),
            organization: scope.1.into(),
            client: scope.2.into(),
            digest: sha2::Sha256::digest(bytes).into(),
            credential: Arc::new(0),
            cell: Arc::new(0),
            arm: 0,
        }
    }
    pub(crate) fn matches_bytes(&self, bytes: &[u8]) -> bool {
        self.digest == <[u8; 32]>::from(sha2::Sha256::digest(bytes))
    }
    pub(crate) fn matches_binding(&self, scope: (&str, &str, &str)) -> bool {
        self.workspace == scope.0 && self.organization == scope.1 && self.client == scope.2
    }
}
pub(crate) struct Publication {
    current: Option<(Arc<u8>, Arc<AtomicBool>)>,
    receipt: Option<Arc<VerifiedCredentialReceipt>>,
}
pub struct SundayAuthority {
    identity: Arc<u8>,
    pub(crate) word: AtomicU64,
    publication: Mutex<Publication>,
    #[cfg(test)]
    fail_arm: std::sync::atomic::AtomicBool,
}
pub enum RetireReason {
    AuthorityChanged,
    ExplicitCancel,
}
pub struct RetiredTag {
    authority: Arc<u8>,
    word: u64,
}
/// Opaque future registered-attempt identity. No production constructor exists.
pub struct SundayAttemptHandle {
    authority: Arc<SundayAuthority>,
    word: u64,
}
impl SundayAuthority {
    pub fn new() -> Result<Self, SundayRefusal> {
        let mut entropy = zeroize::Zeroizing::new([0u8; 32]);
        getrandom::fill(entropy.as_mut()).map_err(|_| SundayRefusal::EntropyUnavailable)?;
        Ok(Self {
            identity: Arc::new(0),
            word: AtomicU64::new(RETIRED),
            #[cfg(test)]
            fail_arm: std::sync::atomic::AtomicBool::new(false),
            publication: Mutex::new(Publication {
                current: None,
                receipt: None,
            }),
        })
    }
    pub(crate) fn publication(&self) -> Result<MutexGuard<'_, Publication>, SundayRefusal> {
        self.publication.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => SundayRefusal::Contended,
            std::sync::TryLockError::Poisoned(_) => SundayRefusal::Poisoned,
        })
    }
    fn current(p: &Publication, c: &ControllerInstance) -> Result<(), SundayRefusal> {
        if !c.2.load(SeqCst)
            && p.current
                .as_ref()
                .is_some_and(|(id, _)| Arc::ptr_eq(id, &c.0))
        {
            Ok(())
        } else {
            Err(SundayRefusal::ControllerMismatch)
        }
    }
    pub(crate) fn attach(&self) -> Result<ControllerInstance, SundayRefusal> {
        let mut p = self.publication()?;
        let word = self.word.load(SeqCst);
        known_word(word)?;
        if word & POISON != 0 {
            return Err(SundayRefusal::Poisoned);
        }
        if outstanding(word) || word & RETIRED == 0 {
            return Err(SundayRefusal::Busy);
        }
        if p.current
            .as_ref()
            .is_some_and(|(_, withdrawn)| !withdrawn.load(SeqCst))
        {
            return Err(SundayRefusal::ControllerMismatch);
        }
        let displaced = p.current.take();
        let id = Arc::new(0);
        let withdrawn = Arc::new(AtomicBool::new(false));
        p.current = Some((id.clone(), withdrawn.clone()));
        let controller = ControllerInstance(id, self.identity.clone(), withdrawn);
        drop(p);
        drop(displaced);
        Ok(controller)
    }
    pub(crate) fn withdraw(&self, controller: &ControllerInstance) {
        if !Arc::ptr_eq(&self.identity, &controller.1) || self.word.load(SeqCst) & RETIRED == 0 {
            return;
        }
        // Only constructor failure can withdraw. The slot shares this one-way
        // metadata, so a failed try-lock cannot strand a dead reservation.
        controller.2.store(true, SeqCst);
        if let Ok(mut p) = self.publication()
            && p.current
                .as_ref()
                .is_some_and(|(id, _)| Arc::ptr_eq(id, &controller.0))
        {
            let removed = p.current.take();
            drop(p);
            drop(removed);
        }
    }
    pub fn retire(&self, reason: RetireReason) -> Result<RetiredTag, SundayRefusal> {
        let mut old = self.word.load(SeqCst);
        loop {
            known_word(old)?;
            let cause = if matches!(reason, RetireReason::ExplicitCancel) {
                1
            } else {
                2
            };
            let mut next = old | RETIRED;
            if matches!(reason, RetireReason::ExplicitCancel) {
                next |= CANCEL;
            }
            if outstanding(old) && (old >> 51) & 15 == 0 {
                next |= cause << 51;
            }
            if old & REV == REV {
                next |= POISON;
            } else {
                next = (next & !REV) | ((old & REV) + 1);
            }
            match self.word.compare_exchange(old, next, SeqCst, SeqCst) {
                Ok(_) if old & REV == REV => return Err(SundayRefusal::RevisionExhausted),
                Ok(_) => {
                    return Ok(RetiredTag {
                        authority: self.identity.clone(),
                        word: next,
                    });
                }
                Err(now) => old = now,
            }
        }
    }
    pub(crate) fn retire_controller(
        &self,
        c: &ControllerInstance,
        reason: RetireReason,
    ) -> Result<RetiredTag, SundayRefusal> {
        if !Arc::ptr_eq(&self.identity, &c.1) || c.2.load(SeqCst) {
            return Err(SundayRefusal::ControllerMismatch);
        }
        // Scope is proven without publication/State locks. Only constructor failure
        // may withdraw this non-Clone proof, before any controller is published.
        let tag = self.retire(reason)?;
        let p = self.publication()?;
        Self::current(&p, c)?;
        Ok(tag)
    }
    pub(crate) fn check_writer(
        &self,
        c: &ControllerInstance,
        tag: &RetiredTag,
    ) -> Result<(), SundayRefusal> {
        if !Arc::ptr_eq(&tag.authority, &self.identity) {
            return Err(SundayRefusal::ControllerMismatch);
        }
        let word = self.word.load(SeqCst);
        known_word(word)?;
        if word & POISON != 0 {
            return Err(SundayRefusal::Poisoned);
        }
        if word != tag.word {
            return Err(SundayRefusal::Retired);
        }
        if outstanding(word) {
            return Err(SundayRefusal::Busy);
        }
        let publication = self.publication()?;
        Self::current(&publication, c)
    }
    pub fn issue_cancel(&self, attempt: &SundayAttemptHandle) -> Result<(), SundayRefusal> {
        if !std::ptr::eq(self, Arc::as_ptr(&attempt.authority)) {
            return Err(SundayRefusal::ControllerMismatch);
        }
        let mut old = self.word.load(SeqCst);
        loop {
            known_word(old)?;
            // Compare revision, attempt and phase; flags/cause may have changed concurrently.
            if old & ((1 << 51) - 1) != attempt.word & ((1 << 51) - 1) {
                return Err(SundayRefusal::NotReady);
            }
            let next = old | CANCEL | if (old >> 51) & 15 == 0 { 1 << 51 } else { 0 };
            match self.word.compare_exchange(old, next, SeqCst, SeqCst) {
                Ok(_) => return Ok(()),
                Err(now) => old = now,
            }
        }
    }
    pub(crate) fn publish<'a>(
        &'a self,
        c: &ControllerInstance,
        tag: &RetiredTag,
        mut receipt: VerifiedCredentialReceipt,
    ) -> Result<
        (
            MutexGuard<'a, Publication>,
            Option<Arc<VerifiedCredentialReceipt>>,
        ),
        SundayRefusal,
    > {
        if !Arc::ptr_eq(&tag.authority, &self.identity) {
            return Err(SundayRefusal::ControllerMismatch);
        }
        let mut p = self.publication()?;
        Self::current(&p, c)?;
        if !Arc::ptr_eq(&receipt.controller, &c.0) {
            return Err(SundayRefusal::ControllerMismatch);
        }
        known_word(tag.word)?;
        if tag.word & POISON != 0 {
            return Err(SundayRefusal::Poisoned);
        }
        if outstanding(tag.word) || tag.word & RETIRED == 0 {
            return Err(SundayRefusal::Busy);
        }
        if tag.word & REV == REV {
            drop(p);
            self.retire(RetireReason::AuthorityChanged)?;
            return Err(SundayRefusal::RevisionExhausted);
        }
        if self.word.load(SeqCst) != tag.word {
            return Err(SundayRefusal::Retired);
        }
        receipt.arm = ((tag.word & !REV) | ((tag.word & REV) + 1)) & !RETIRED;
        let receipt = Arc::new(receipt);
        let mut displaced = p.receipt.replace(receipt.clone());
        #[cfg(test)]
        if self.fail_arm.load(SeqCst) {
            self.retire(RetireReason::AuthorityChanged)?;
        }
        if self
            .word
            .compare_exchange(tag.word, receipt.arm, SeqCst, SeqCst)
            .is_err()
        {
            let own = if p
                .receipt
                .as_ref()
                .is_some_and(|r| Arc::ptr_eq(&r.cell, &receipt.cell))
            {
                // Keep the prior receipt as a disconnect target; withdraw only our cell.
                std::mem::replace(&mut p.receipt, displaced.take())
            } else {
                None
            };
            drop(p);
            drop(own);
            drop(displaced);
            return Err(SundayRefusal::Retired);
        }
        Ok((p, displaced))
    }
    pub(crate) fn check_page(
        &self,
        permit: &crate::sunday_read::SundayPagePermit,
        c: &ControllerInstance,
        request: &crate::source::SourceRequest,
    ) -> Result<Arc<VerifiedCredentialReceipt>, SundayRefusal> {
        permit.check(self, request)?;
        let word = self.word.load(SeqCst);
        known_word(word)?;
        if word & CANCEL != 0 {
            return Err(SundayRefusal::Cancelled);
        }
        if word & POISON != 0 {
            return Err(SundayRefusal::Poisoned);
        }
        if word & RETIRED != 0 {
            return Err(SundayRefusal::Retired);
        }
        if word != permit.word() || (word >> 47) & 15 != 2 {
            return Err(SundayRefusal::NotReady);
        }
        let p = self.publication()?;
        Self::current(&p, c)?;
        let receipt = p.receipt.as_ref().ok_or(SundayRefusal::NotReady)?;
        if !permit.matches_receipt(receipt) || !Arc::ptr_eq(&receipt.controller, &c.0) {
            return Err(SundayRefusal::ReceiptMismatch);
        }
        if receipt.arm & REV != word & REV {
            return Err(SundayRefusal::ReceiptMismatch);
        }
        Ok(receipt.clone())
    }
    #[cfg(test)]
    pub(crate) fn fixture_refuse_arm(&self) {
        self.fail_arm.store(true, SeqCst);
    }
    #[cfg(test)]
    pub(crate) fn fixture_receipt_identity_drift(&self, case: u8) {
        let mut p = self.publication().unwrap();
        let old = p.receipt.as_ref().unwrap();
        p.receipt = Some(Arc::new(VerifiedCredentialReceipt {
            controller: old.controller.clone(),
            workspace: old.workspace.clone(),
            organization: old.organization.clone(),
            client: old.client.clone(),
            digest: old.digest,
            credential: if case == 1 {
                Arc::new(0)
            } else {
                old.credential.clone()
            },
            cell: if case == 0 {
                Arc::new(0)
            } else {
                old.cell.clone()
            },
            arm: old.arm + u64::from(case == 2),
        }));
    }
    #[cfg(test)]
    pub(crate) fn fixture_has_receipt(&self) -> bool {
        self.publication().unwrap().receipt.is_some()
    }
    #[cfg(test)]
    pub(crate) fn fixture_clear_receipt(&self) {
        self.publication().unwrap().receipt = None;
    }
    #[cfg(test)]
    pub(crate) fn fixture_running(&self) {
        let old = self.word.load(SeqCst);
        self.word.store((old & !(15 << 47)) | (2 << 47), SeqCst);
    }
    #[cfg(test)]
    pub(crate) fn fixture_receipt(&self) -> Arc<VerifiedCredentialReceipt> {
        self.publication()
            .unwrap()
            .receipt
            .as_ref()
            .unwrap()
            .clone()
    }
}
impl VerifiedCredentialReceipt {
    pub(crate) fn same_cell(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.cell, &other.cell) && Arc::ptr_eq(&self.credential, &other.credential)
    }
}
#[cfg(test)]
#[path = "sunday_tests.rs"]
mod sunday_tests;
