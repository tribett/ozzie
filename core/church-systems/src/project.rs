//! What every system module uses to read an answer through a closed projection: the decoder (status, JSON with unique
//! keys, no error object), and field readers that refuse a wrong type or an id that fails `Id` as `invalid-response`.
//! Only the fields a module names are read; the rest of an answer is never looked at.
use crate::capture::{Id, MAX_COUNT};
use crate::http::{ReadError, Reply, parse_json, status_error};
use crate::run::{Miss, Projected};
use serde_json::{Map, Value};

pub(crate) type Row = Map<String, Value>;
/// Things read with the church's own name for each, when it gave one.
pub(crate) type Labelled<T> = Vec<(T, Option<String>)>;
pub(crate) const BAD: ReadError = ReadError::InvalidResponse;

/// An answer as JSON: the status (`unauthorized` for a 401 or 403), then JSON with unique keys, then no `error` or
/// `errors` key on an object answer (B1 sends some errors as a 200 with one, research b1 7; Genesis's error bodies
/// have one too).
pub(crate) fn decoder(unauthorized: ReadError) -> impl Fn(&Reply) -> Result<Value, ReadError> {
    move |reply| {
        if let Some(error) = status_error(reply, unauthorized) {
            return Err(error);
        }
        let value = parse_json(reply.body())?;
        if value
            .as_object()
            .is_some_and(|o| o.contains_key("error") || o.contains_key("errors"))
        {
            return Err(ReadError::Refused);
        }
        Ok(value)
    }
}
/// A request that wasn't answered, as the error a single-answer call (a picker, a key check) gives back.
pub(crate) fn miss_error(miss: Miss) -> ReadError {
    match miss {
        Miss::Failed(error) => error,
        Miss::NotSent(_) => ReadError::Timeout,
    }
}

pub(crate) fn rows(value: &Value) -> Result<&[Value], ReadError> {
    value.as_array().map(Vec::as_slice).ok_or(BAD)
}
pub(crate) fn object(value: &Value) -> Result<&Row, ReadError> {
    value.as_object().ok_or(BAD)
}
/// A required id.
pub(crate) fn id_field(row: &Row, key: &str) -> Result<Id, ReadError> {
    row.get(key)
        .and_then(Value::as_str)
        .and_then(Id::new)
        .ok_or(BAD)
}
/// An optional id: missing, null or empty is none.
pub(crate) fn optional_id(row: &Row, key: &str) -> Result<Option<Id>, ReadError> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Id::new(s).map(Some).ok_or(BAD),
        Some(_) => Err(BAD),
    }
}
/// Optional text: missing, null or empty is none; another type is refused.
pub(crate) fn optional_text<'a>(row: &'a Row, key: &str) -> Result<Option<&'a str>, ReadError> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(BAD),
    }
}
/// An optional whole number from 0 to `MAX_COUNT`, as a JSON number.
pub(crate) fn optional_count(row: &Row, key: &str) -> Result<Option<u32>, ReadError> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_u64()
            .filter(|n| *n <= u64::from(MAX_COUNT))
            .map(|n| Some(n as u32))
            .ok_or(BAD),
        Some(_) => Err(BAD),
    }
}
/// At most `max` of `items`, and whether any were left out.
pub(crate) fn capped<T>(mut items: Vec<T>, max: usize) -> Projected<Vec<T>> {
    let cut = items.len() > max;
    items.truncate(max);
    (items, cut)
}
