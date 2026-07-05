use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub(crate) fn optional_proto_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn optional_proto_u16(value: u32) -> Option<u16> {
    if value == 0 {
        None
    } else {
        Some(value.min(u32::from(u16::MAX)) as u16)
    }
}

pub(crate) fn optional_proto_usize(value: u32) -> Option<usize> {
    (value > 0).then_some(value as usize)
}

pub(crate) fn now_unix_seconds() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
}

pub(crate) fn now_unix_millis() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

pub(crate) fn chat_run_ledger_now() -> (Instant, i64) {
    (Instant::now(), now_unix_millis())
}

pub(crate) fn string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("gateway chat event {key} is required"))
}

pub(crate) fn required_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    string_field(object, key)
}

pub(crate) fn required_raw_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("gateway chat event {key} is required"))
}

pub(crate) fn optional_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn optional_number_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<i64> {
    object.get(key).and_then(Value::as_i64)
}
