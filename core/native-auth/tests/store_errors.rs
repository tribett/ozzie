use ozzie_native_auth::credentials::{StoreError, classify_status};
#[test]
fn os_status_codes_are_distinct_and_never_encoded_as_absence() {
    assert_eq!(classify_status(-25308), StoreError::Locked);
    assert_eq!(classify_status(-25315), StoreError::Locked);
    assert_eq!(classify_status(-25293), StoreError::Denied);
    assert_eq!(classify_status(-128), StoreError::Denied);
    assert_eq!(classify_status(-34018), StoreError::Denied);
    assert_eq!(classify_status(-25294), StoreError::Unavailable);
    assert_eq!(classify_status(-25291), StoreError::Unavailable);
    assert_eq!(classify_status(-1), StoreError::Unavailable);
}
