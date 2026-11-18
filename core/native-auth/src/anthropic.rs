//! Claude through Anthropic's own Messages API (`POST https://api.anthropic.com/v1/messages`), for the church's own
//! Anthropic key. Anthropic calls its OpenAI-compatible layer "not considered a long-term or production-ready
//! solution", so Ozzie speaks Messages to it (provider research, 2026-11-17).
//!
//! Ozzie builds every request in Chat Completions form and checks it there (names, contact details, the request
//! shape); only then is it translated here, at the one place a request leaves (`model::Exchange`), and the reply is
//! translated back before any check reads it. Nothing is added: the same text, the same tools, the same token cap.
//! Thinking is turned off (`thinking: {type: "disabled"}`, accepted by Haiku 5.5 at its default effort), so a tool
//! turn never needs thinking blocks passed back, and `temperature` is never sent (Haiku 5.5 refuses a non-default
//! one). The key goes in Anthropic's own `x-api-key` header, chosen with this wire (`own_key::key_header`), with
//! `anthropic-version`.
use serde_json::{Map, Value, json};

/// The version header every Messages request carries (providers.json `api_version`).
pub const VERSION_HEADER: &str = "anthropic-version";
/// The header a Console key travels in, whatever its kind.
pub const KEY_HEADER: &str = "x-api-key";

/// A Chat Completions body as Ozzie builds it, as a Messages request: system text lifted to `system`, a tool call
/// to a `tool_use` block, each run of tool results to one user turn of `tool_result` blocks, tools to Anthropic's
/// form, the token cap to `max_tokens`. Anything else (temperature, reasoning, gateway options) is left out.
pub fn to_messages(chat: &Value) -> Value {
    let mut system: Vec<&str> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    for message in chat["messages"].as_array().map_or(&[][..], Vec::as_slice) {
        let content = message["content"].as_str().unwrap_or("");
        match message["role"].as_str() {
            Some("system") => system.push(content),
            Some("user") => messages.push(json!({"role": "user", "content": content})),
            Some("assistant") => {
                let mut blocks: Vec<Value> = Vec::new();
                if !content.is_empty() {
                    blocks.push(json!({"type": "text", "text": content}));
                }
                for call in message["tool_calls"]
                    .as_array()
                    .map_or(&[][..], Vec::as_slice)
                {
                    let input = call["function"]["arguments"]
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({}));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call["id"],
                        "name": call["function"]["name"],
                        "input": input,
                    }));
                }
                // An assistant turn with no text and no calls carries nothing, and Anthropic refuses empty content:
                // it isn't sent (a placeholder would put words in the model's mouth).
                if !blocks.is_empty() {
                    messages.push(json!({"role": "assistant", "content": blocks}));
                }
            }
            Some("tool") => {
                let result = json!({
                    "type": "tool_result",
                    "tool_use_id": message["tool_call_id"],
                    "content": content,
                });
                // Tool results that follow one another answer one assistant turn: one user turn holds them all.
                let joined = messages.last_mut().is_some_and(|last| {
                    let results = last["role"] == "user"
                        && last["content"].as_array().is_some_and(|blocks| {
                            blocks.iter().all(|b| b["type"] == "tool_result")
                        });
                    if results && let Some(blocks) = last["content"].as_array_mut() {
                        blocks.push(result.clone());
                    }
                    results
                });
                if !joined {
                    messages.push(json!({"role": "user", "content": [result]}));
                }
            }
            _ => {}
        }
    }
    let mut body = Map::new();
    body.insert("model".into(), chat["model"].clone());
    let cap = chat
        .get("max_tokens")
        .or_else(|| chat.get("max_completion_tokens"))
        .cloned()
        .unwrap_or(Value::Null);
    body.insert("max_tokens".into(), cap);
    if !system.is_empty() {
        body.insert("system".into(), json!(system.join("\n\n")));
    }
    body.insert("messages".into(), Value::Array(messages));
    if let Some(tools) = chat["tools"].as_array().filter(|tools| !tools.is_empty()) {
        let tools: Vec<Value> = tools
            .iter()
            .map(|tool| {
                let mut out = json!({
                    "name": tool["function"]["name"],
                    "input_schema": tool["function"]["parameters"],
                });
                // `description` is optional for Anthropic, and never sent as null.
                if let Some(description) = tool["function"]["description"].as_str() {
                    out["description"] = json!(description);
                }
                out
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
        body.insert("tool_choice".into(), json!({"type": "auto"}));
    }
    body.insert("thinking".into(), json!({"type": "disabled"}));
    Value::Object(body)
}

/// A Messages reply in the Chat Completions form every reader of a reply expects: the text blocks joined as the
/// message's content, each `tool_use` as a tool call (its input as JSON text), the stop reason as a finish reason,
/// and the token counts. Thinking blocks and anything else are dropped. Anything that isn't a Messages reply
/// becomes a reply with no message, which the readers refuse.
pub fn from_messages(reply: &Value) -> Value {
    let Some(blocks) = reply["content"].as_array() else {
        return json!({"choices": []});
    };
    let text: String = blocks
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    let calls: Vec<Value> = blocks
        .iter()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| {
            json!({
                "id": b["id"],
                "type": "function",
                "function": {
                    "name": b["name"],
                    "arguments": serde_json::to_string(&b["input"]).unwrap_or_else(|_| "{}".into()),
                },
            })
        })
        .collect();
    let finish = match reply["stop_reason"].as_str() {
        Some("tool_use") => "tool_calls",
        Some("max_tokens") => "length",
        _ => "stop",
    };
    let mut message = json!({"role": "assistant", "content": text});
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    let mut converted = json!({"choices": [{"message": message, "finish_reason": finish}]});
    if let (Some(input), Some(output)) = (
        reply["usage"]["input_tokens"].as_u64(),
        reply["usage"]["output_tokens"].as_u64(),
    ) {
        converted["usage"] = json!({"prompt_tokens": input, "completion_tokens": output});
    }
    converted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rewording_request_becomes_a_messages_request_with_nothing_added() {
        let chat = json!({
            "model": "claude-haiku-5-5",
            "messages": [
                {"role": "system", "content": "You help a church volunteer coordinator word a short note."},
                {"role": "user", "content": "Make it warmer.\n\nNote:\nHi [Volunteer A], could you help?"},
            ],
            "max_tokens": 120,
            "temperature": 0.4,
            "reasoning_effort": "low",
        });
        assert_eq!(
            to_messages(&chat),
            json!({
                "model": "claude-haiku-5-5",
                "max_tokens": 120,
                "system": "You help a church volunteer coordinator word a short note.",
                "messages": [{"role": "user", "content": "Make it warmer.\n\nNote:\nHi [Volunteer A], could you help?"}],
                "thinking": {"type": "disabled"},
            })
        );
    }

    #[test]
    fn a_tool_turn_keeps_its_calls_and_results_paired_in_anthropics_form() {
        let chat = json!({
            "model": "claude-haiku-5-5",
            "max_completion_tokens": 600,
            "messages": [
                {"role": "system", "content": "Answer from the facts."},
                {"role": "user", "content": "Who could help with [Role]?"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call_1_0", "type": "function", "function": {"name": "sunday_open_needs", "arguments": "{}"}},
                    {"id": "call_1_1", "type": "function", "function": {"name": "sunday_who_could_help", "arguments": "{\"role\":\"[Role]\"}"}},
                ]},
                {"role": "tool", "tool_call_id": "call_1_0", "content": "{\"needs\":1}"},
                {"role": "tool", "tool_call_id": "call_1_1", "content": "{\"people\":[\"[Person 1]\"]}"},
            ],
            "tools": [{"type": "function", "function": {"name": "sunday_open_needs", "description": "Lists open roles.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": false}}}],
            "tool_choice": "auto",
        });
        let body = to_messages(&chat);
        assert_eq!(body["max_tokens"], 600);
        assert_eq!(body["system"], "Answer from the facts.");
        assert_eq!(
            body["messages"],
            json!([
                {"role": "user", "content": "Who could help with [Role]?"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call_1_0", "name": "sunday_open_needs", "input": {}},
                    {"type": "tool_use", "id": "call_1_1", "name": "sunday_who_could_help", "input": {"role": "[Role]"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1_0", "content": "{\"needs\":1}"},
                    {"type": "tool_result", "tool_use_id": "call_1_1", "content": "{\"people\":[\"[Person 1]\"]}"},
                ]},
            ])
        );
        assert_eq!(
            body["tools"],
            json!([{"name": "sunday_open_needs", "description": "Lists open roles.",
                "input_schema": {"type": "object", "properties": {}, "additionalProperties": false}}])
        );
        assert_eq!(body["tool_choice"], json!({"type": "auto"}));
        assert!(body.get("temperature").is_none() && body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn an_empty_assistant_turn_is_dropped_and_a_tool_without_description_sends_none() {
        let chat = json!({
            "model": "claude-haiku-5-5", "max_tokens": 50,
            "messages": [
                {"role": "user", "content": "First."},
                {"role": "assistant", "content": ""},
                {"role": "user", "content": "Second."},
            ],
            "tools": [{"type": "function", "function": {"name": "sunday_overview", "description": null, "parameters": {"type": "object"}}}],
        });
        let body = to_messages(&chat);
        // Anthropic refuses an assistant turn with no content; it carried nothing, so it isn't sent.
        assert_eq!(
            body["messages"],
            json!([{"role": "user", "content": "First."}, {"role": "user", "content": "Second."}])
        );
        assert_eq!(
            body["tools"],
            json!([{"name": "sunday_overview", "input_schema": {"type": "object"}}])
        );
    }

    #[test]
    fn a_messages_reply_reads_as_the_chat_completion_every_check_expects() {
        // Text, with a thinking block left out.
        let reply = json!({
            "id": "msg_fictional", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
            "content": [{"type": "thinking", "thinking": "Riley is free, so I'll suggest Riley.", "signature": "fictional"}, {"type": "text", "text": "Hi [Volunteer A], "}, {"type": "text", "text": "could you help?"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 41, "output_tokens": 9},
        });
        assert_eq!(
            from_messages(&reply),
            json!({"choices": [{"message": {"role": "assistant", "content": "Hi [Volunteer A], could you help?"}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 41, "completion_tokens": 9}})
        );
        // The thinking block's text never reaches a reader (review A6).
        assert!(!from_messages(&reply).to_string().contains("Riley"));
        // A tool call, its input as JSON text.
        let reply = json!({
            "content": [{"type": "tool_use", "id": "toolu_fictional", "name": "sunday_who_could_help", "input": {"role": "[Role]"}}],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 300, "output_tokens": 20},
        });
        let converted = from_messages(&reply);
        assert_eq!(converted["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(converted["choices"][0]["message"]["content"], "");
        assert_eq!(
            converted["choices"][0]["message"]["tool_calls"],
            json!([{"id": "toolu_fictional", "type": "function", "function": {"name": "sunday_who_could_help", "arguments": "{\"role\":\"[Role]\"}"}}])
        );
        // Cut off at the cap; and anything that isn't a Messages reply has no message to read.
        assert_eq!(
            from_messages(&json!({"content": [], "stop_reason": "max_tokens"}))["choices"][0]["finish_reason"],
            "length"
        );
        assert_eq!(
            from_messages(&json!({"type": "error", "error": {"type": "overloaded_error"}})),
            json!({"choices": []})
        );
        assert_eq!(
            from_messages(&json!({"choices": [{"message": {"content": "x"}}]})),
            json!({"choices": []})
        );
    }
}
