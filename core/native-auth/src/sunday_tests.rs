use super::*;
use std::sync::atomic::Ordering;
#[test]
fn sunday_retirement_advances_the_single_word_without_admitting_work() {
    let a = SundayAuthority::new().unwrap();
    assert_eq!(a.word.load(Ordering::SeqCst), 1u64 << 56);
    a.retire(RetireReason::AuthorityChanged).unwrap();
    assert_eq!(a.word.load(Ordering::SeqCst), (1u64 << 56) | 1);
}

#[test]
fn sunday_closed_word_refuses_reserved_phase_cause_and_poison_on_overflow() {
    for word in [1 << 58, 13 << 47, 14 << 47, 15 << 47, 15 << 51] {
        let a = SundayAuthority::new().unwrap();
        a.word.store(word, Ordering::SeqCst);
        assert_eq!(
            a.retire(RetireReason::AuthorityChanged).err(),
            Some(SundayRefusal::InvalidWord)
        );
        assert_eq!(a.word.load(Ordering::SeqCst), word);
    }
    let a = SundayAuthority::new().unwrap();
    a.word.store(REV | (2 << 47), Ordering::SeqCst);
    assert_eq!(
        a.retire(RetireReason::AuthorityChanged).err(),
        Some(SundayRefusal::RevisionExhausted)
    );
    assert_eq!(
        a.word.load(Ordering::SeqCst),
        REV | (2 << 47) | (2 << 51) | RETIRED | POISON
    );
}
#[test]
fn sunday_cancel_latches_without_rewriting_first_cause_or_terminal_phase() {
    let a = Arc::new(SundayAuthority::new().unwrap());
    a.word
        .store((127 << 40) | (2 << 47) | (5 << 51) | 9, Ordering::SeqCst);
    let handle = SundayAttemptHandle {
        authority: a.clone(),
        word: a.word.load(Ordering::SeqCst),
    };
    a.issue_cancel(&handle).unwrap();
    assert_eq!(
        a.word.load(Ordering::SeqCst),
        (127 << 40) | (2 << 47) | (5 << 51) | 9 | CANCEL
    );
    a.retire(RetireReason::AuthorityChanged).unwrap();
    assert_eq!(
        a.word.load(Ordering::SeqCst),
        (127 << 40) | (2 << 47) | (5 << 51) | 10 | CANCEL | RETIRED
    );
}
#[test]
fn sunday_stale_publication_never_withdraws_newer_receipt_and_constructor_never_arms() {
    let a = SundayAuthority::new().unwrap();
    let c = a.attach().unwrap();
    assert!(a.publication().unwrap().receipt.is_none());
    let first = a
        .retire_controller(&c, RetireReason::AuthorityChanged)
        .unwrap();
    let second = a
        .retire_controller(&c, RetireReason::AuthorityChanged)
        .unwrap();
    let receipt = VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"fictional");
    let (guard, old) = a.publish(&c, &second, receipt).unwrap();
    drop(guard);
    drop(old);
    let cell = a.fixture_receipt();
    let stale = VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"stale");
    assert_eq!(
        a.publish(&c, &first, stale).err(),
        Some(SundayRefusal::Retired)
    );
    assert!(cell.same_cell(&a.fixture_receipt()));
    let held = a.publication().unwrap();
    assert_eq!(
        a.retire_controller(&c, RetireReason::AuthorityChanged)
            .err(),
        Some(SundayRefusal::Contended)
    );
    drop(held);
}

#[test]
fn sunday_arm_cas_losing_to_retirement_withdraws_only_its_installed_cell() {
    let a = SundayAuthority::new().unwrap();
    let c = a.attach().unwrap();
    let first = a
        .retire_controller(&c, RetireReason::AuthorityChanged)
        .unwrap();
    a.fail_arm.store(true, Ordering::SeqCst);
    assert_eq!(
        a.publish(
            &c,
            &first,
            VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"fictional")
        )
        .err(),
        Some(SundayRefusal::Retired)
    );
    assert!(!a.fixture_has_receipt());
    a.fail_arm.store(false, Ordering::SeqCst);
    let next = a
        .retire_controller(&c, RetireReason::AuthorityChanged)
        .unwrap();
    let (guard, old) = a
        .publish(
            &c,
            &next,
            VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"newer"),
        )
        .unwrap();
    drop(guard);
    drop(old);
    let newer = a.fixture_receipt();
    assert_eq!(
        a.publish(
            &c,
            &first,
            VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"stale")
        )
        .err(),
        Some(SundayRefusal::Retired)
    );
    assert!(newer.same_cell(&a.fixture_receipt()));
}

#[test]
fn sunday_equal_retirement_words_from_foreign_authorities_do_not_establish_identity() {
    let a = SundayAuthority::new().unwrap();
    let foreign = SundayAuthority::new().unwrap();
    let c = a.attach().unwrap();
    let own = a.retire(RetireReason::AuthorityChanged).unwrap();
    let other = foreign.retire(RetireReason::AuthorityChanged).unwrap();
    assert_eq!(own.word, other.word);
    assert_eq!(
        a.check_writer(&c, &other).err(),
        Some(SundayRefusal::ControllerMismatch)
    );
    assert_eq!(
        a.publish(
            &c,
            &other,
            VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"fictional")
        )
        .err(),
        Some(SundayRefusal::ControllerMismatch)
    );
    assert!(!a.fixture_has_receipt());
}

#[test]
fn sunday_outstanding_phases_and_poison_refuse_arm_and_attachment() {
    for phase in [1, 2, 3, 4, 11, 12] {
        let a = SundayAuthority::new().unwrap();
        let c = a.attach().unwrap();
        a.word.store(RETIRED | (phase << 47), Ordering::SeqCst);
        let tag = a.retire(RetireReason::AuthorityChanged).unwrap();
        assert_eq!(a.check_writer(&c, &tag).err(), Some(SundayRefusal::Busy));
        assert_eq!(
            a.publish(
                &c,
                &tag,
                VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"fictional")
            )
            .err(),
            Some(SundayRefusal::Busy)
        );
        assert!(!a.fixture_has_receipt());
        let other = SundayAuthority::new().unwrap();
        other.word.store(RETIRED | (phase << 47), Ordering::SeqCst);
        assert_eq!(other.attach().err(), Some(SundayRefusal::Busy));
    }
    let a = SundayAuthority::new().unwrap();
    a.word.store(RETIRED | POISON, Ordering::SeqCst);
    assert_eq!(a.attach().err(), Some(SundayRefusal::Poisoned));
}
#[test]
fn sunday_publication_contention_refuses_without_touching_receipt_or_word() {
    let a = SundayAuthority::new().unwrap();
    let c = a.attach().unwrap();
    let tag = a.retire(RetireReason::AuthorityChanged).unwrap();
    let receipt = VerifiedCredentialReceipt::new(&c, ("w", "1", "c"), b"fictional");
    let guard = a.publication().unwrap();
    let before = a.word.load(Ordering::SeqCst);
    assert_eq!(
        a.publish(&c, &tag, receipt).err(),
        Some(SundayRefusal::Contended)
    );
    assert_eq!(a.word.load(Ordering::SeqCst), before);
    assert!(guard.receipt.is_none());
}

#[test]
fn root_sunday_failed_later_arm_retains_previous_receipt_until_verified_replacement() {
    let authority = SundayAuthority::new().unwrap();
    let controller = authority.attach().unwrap();
    let first = authority
        .retire_controller(&controller, RetireReason::AuthorityChanged)
        .unwrap();
    let (guard, displaced) = authority
        .publish(
            &controller,
            &first,
            VerifiedCredentialReceipt::new(&controller, ("w", "1", "c"), b"fictional-previous"),
        )
        .unwrap();
    drop(guard);
    assert!(displaced.is_none());
    let previous = authority.fixture_receipt();
    let later = authority
        .retire_controller(&controller, RetireReason::AuthorityChanged)
        .unwrap();
    authority.fail_arm.store(true, Ordering::SeqCst);
    assert_eq!(
        authority
            .publish(
                &controller,
                &later,
                VerifiedCredentialReceipt::new(&controller, ("w", "1", "c"), b"fictional-failed"),
            )
            .err(),
        Some(SundayRefusal::Retired)
    );
    assert!(
        authority.fixture_has_receipt(),
        "failed later arm must retain the previous disconnect-target receipt"
    );
    let retained = authority.fixture_receipt();
    assert!(previous.same_cell(&retained));
    assert!(retained.matches_bytes(b"fictional-previous"));
    assert!(authority.word.load(Ordering::SeqCst) & RETIRED != 0);
    authority.fail_arm.store(false, Ordering::SeqCst);
    let final_tag = authority
        .retire_controller(&controller, RetireReason::AuthorityChanged)
        .unwrap();
    let (guard, displaced) = authority
        .publish(
            &controller,
            &final_tag,
            VerifiedCredentialReceipt::new(&controller, ("w", "1", "c"), b"fictional-replacement"),
        )
        .unwrap();
    drop(guard);
    assert!(previous.same_cell(&displaced.unwrap()));
    let replacement = authority.fixture_receipt();
    assert!(!previous.same_cell(&replacement));
    assert!(replacement.matches_bytes(b"fictional-replacement"));
}
