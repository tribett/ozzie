//! Calendar arithmetic on whole days, with no time zone: the own-key route's UTC month (model.rs) and a plan's
//! weekday from Planning Center's local wall-clock date (sunday_picker.rs). Howard Hinnant's civil-date algorithms.

/// (year, month 1–12, day 1–31) of a day counted from 1970-01-01.
pub fn date_of_day(day: u64) -> (i64, u32, u32) {
    let z = day as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}
/// Days from 1970-01-01 to a date, or None for a date that doesn't exist or comes before 1970.
pub fn day_of_date(y: i64, m: u32, d: u32) -> Option<u64> {
    let length = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => return None,
    };
    if !(1..=length).contains(&d) {
        return None;
    }
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    u64::try_from(era * 146_097 + doe - 719_468).ok()
}
/// The month a day falls in, as one number that grows by one each month (year × 12 + month − 1).
pub fn month_of_day(day: u64) -> u64 {
    let (y, m, _) = date_of_day(day);
    (y.max(0) as u64) * 12 + u64::from(m) - 1
}
/// The first day of the month after the one `day` falls in, as `YYYY-MM-01`.
pub fn next_month_start(day: u64) -> String {
    let (y, m, _) = date_of_day(day);
    let (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    format!("{y:04}-{m:02}-01")
}
/// A `YYYY-MM-DD` date (anything after it ignored, as in `2026-11-23T09:00:00Z`) as a day count.
pub fn day_of_text(text: &str) -> Option<u64> {
    let date = text.get(..10)?;
    let b = date.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |s: &str| -> Option<u32> {
        s.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| s.parse().ok())
            .flatten()
    };
    day_of_date(
        i64::from(digits(&date[..4])?),
        digits(&date[5..7])?,
        digits(&date[8..10])?,
    )
}
pub const WEEKDAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
/// The weekday of a day count (1970-01-01 was a Thursday).
pub fn weekday(day: u64) -> &'static str {
    WEEKDAYS[((day + 3) % 7) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_and_name_their_weekday() {
        assert_eq!(date_of_day(0), (1970, 1, 1));
        assert_eq!(weekday(0), "thursday");
        let advent = day_of_text("2026-11-23T09:00:00Z").unwrap();
        assert_eq!(date_of_day(advent), (2026, 11, 23));
        assert_eq!(weekday(advent), "monday");
        assert_eq!(weekday(day_of_text("2026-11-22").unwrap()), "sunday");
        assert_eq!(weekday(day_of_text("2026-11-19").unwrap()), "thursday");
        assert_eq!(weekday(day_of_text("2028-02-29").unwrap()), "tuesday");
        for day in [0, 59, 365, 10_957, 20_000, 20_454, 30_000] {
            let (y, m, d) = date_of_day(day);
            assert_eq!(day_of_date(y, m, d), Some(day));
        }
        for bad in [
            "2026-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-11-31",
            "26-11-01",
            "2026/11/01",
            "1969-12-31",
            "abcd-ef-gh",
        ] {
            assert_eq!(day_of_text(bad), None, "{bad}");
        }
    }

    #[test]
    fn months_count_up_and_say_when_the_next_one_starts() {
        let nov = day_of_text("2026-11-30").unwrap();
        let dec = day_of_text("2026-12-01").unwrap();
        assert_eq!(month_of_day(dec), month_of_day(nov) + 1);
        assert_eq!(
            month_of_day(day_of_text("2026-11-01").unwrap()),
            month_of_day(nov)
        );
        assert_eq!(next_month_start(nov), "2026-12-01");
        assert_eq!(
            next_month_start(day_of_text("2026-12-17").unwrap()),
            "2027-01-01"
        );
        assert_eq!(
            month_of_day(day_of_text("2027-01-01").unwrap()),
            month_of_day(dec) + 1
        );
    }
}
