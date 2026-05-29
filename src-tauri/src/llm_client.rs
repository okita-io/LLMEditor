// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — llm_client.rs
//
// LLM_Client surface for the non-streaming `call_llm` Tauri command (Task
// 13). Two public items live here:
//
//   - `build_body(text, &Settings, stream: bool) -> serde_json::Value`:
//     constructs the OpenAI-compatible chat-completions request body
//     exactly per design.md. The `stream` flag is forwarded as the JSON
//     `"stream"` field so this single helper serves both `call_blocking`
//     (Task 13, `stream:false`) and the future `start_stream` task
//     (Task 15, `stream:true`).
//
//   - `call_blocking(text, &Settings) -> Result<String, LlmError>`:
//     posts a non-streaming request, awaits the JSON, and returns
//     `choices[0].message.content`. Errors map onto the same `LlmError`
//     variants used by the streaming path (Req 14.1, 14.3, 14.4, 14.5)
//     so the `Status_Bar` reason text is identical regardless of which
//     command surfaced the failure.
//
// The `reqwest::Client` is built exactly once per process via
// `std::sync::OnceLock`. The configuration is the design-pinned set of
// connection-tuning options:
//
//   - `connect_timeout(5s)` — Req 14.1, surfaces as `LlmError::ConnectionFailed`.
//   - `pool_idle_timeout(None)` — keep idle connections alive for the life
//     of the process so streaming reconnects skip the TCP handshake.
//   - `tcp_nodelay(true)` — every SSE chunk is small; disable Nagle so
//     tokens reach the WebView with minimal latency.
//   - `redirect::Policy::limited(3)` — bounded so a misconfigured
//     LM Studio cannot tarpit us into an infinite redirect loop.
//
// Building the client once-per-process matters: `reqwest::Client` owns a
// connection pool, and constructing it per call would defeat keep-alive.
//
// References:
// - Requirements:
//     12.1 — `messages` ends with the user message (selection or full buffer).
//     12.2 — `messages` user-message content equals the resolved text.
//     12.4 — body fields: `model`, `messages`, `temperature`, `max_tokens`, `stream`.
//     12.5 — non-empty `system_prompt` prepends a `system` role message.
//     14.1 — connect timeout maps to `"connection failed"`.
//     14.3 — non-200 maps to a string containing the decimal status.
//     14.4 — unparseable response maps to `"invalid response"`.
//     14.5 — mid-stream / mid-call connection drop maps to `"connection lost"`.
//     15.3 — `call_llm(text, settings)` Tauri command on the public surface.
// - design.md:
//     "llm_client.rs" public-API and request-body snippets.
//     "Backend error catalog" — exact `Status_Bar` reason strings.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::LlmError;
use crate::settings::Settings;

// -----------------------------------------------------------------------------
// Process-wide reqwest::Client
// -----------------------------------------------------------------------------

/// One `reqwest::Client` per process. `OnceLock` keeps the build call
/// behind a single happens-before edge without pulling in `once_cell`.
///
/// The closure inside `get_or_init` runs at most once. If the build ever
/// fails (an extremely unlikely event on a stock rustls toolchain — the
/// constructor's documented failure modes are TLS init issues), we fall
/// back to `reqwest::Client::new()` so the rest of the call surface still
/// produces an `LlmError` rather than a panic. The resulting (default)
/// client has no `connect_timeout`; in that degenerate path we'd lose the
/// 5s budget, but the caller's `is_connect`/`is_timeout` mapping still
/// fires correctly for `LlmError::ConnectionFailed` once the OS errors out.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .pool_idle_timeout(None)
            .tcp_nodelay(true)
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Public accessor for the shared HTTP client, used by `commands::list_models`.
pub fn http_client_ref() -> &'static reqwest::Client {
    http_client()
}

// -----------------------------------------------------------------------------
// build_body (Req 12.1, 12.2, 12.4, 12.5)
// -----------------------------------------------------------------------------

/// Construct the request body for `call_llm` / `stream_llm`.
///
/// Layout (in order):
///
///   - `model`        — `s.model` verbatim.
///   - `messages`     — system message prepended iff `s.system_prompt` is
///                      non-empty (Req 12.5), followed by the single user
///                      message carrying `text` (Req 12.1, 12.2).
///   - `temperature`  — `s.temperature`.
///   - `max_tokens`   — `s.max_tokens`.
///   - `stream`       — forwarded from the caller; `false` for `call_blocking`,
///                      `true` for `start_stream`.
///
/// The function is a pure transformation over its two arguments — no IO,
/// no side effects — so the unit tests below cover every documented
/// invariant deterministically.
pub fn build_body(text: &str, s: &Settings, stream: bool) -> Value {
    let mut messages: Vec<Value> = Vec::with_capacity(2);
    if !s.system_prompt.is_empty() {
        messages.push(json!({ "role": "system", "content": s.system_prompt }));
    }
    messages.push(json!({ "role": "user", "content": text }));

    let mut body = serde_json::Map::new();
    body.insert("model".into(), json!(s.model));
    body.insert("messages".into(), json!(messages));
    body.insert("temperature".into(), json!(s.temperature));
    body.insert("stream".into(), json!(stream));
    apply_inference_settings(&mut body, s);
    Value::Object(body)
}

/// Append LM Studio inference parameters to a chat-completions body.
///
/// OpenAI-compatible fields (`top_k`, `top_p`, `repeat_penalty`, …) are sent
/// at the top level per LM Studio's `/v1/chat/completions` docs. LM
/// Studio-specific knobs use the documented `lmstudio` extension object; HTTP
/// keys are snake_case (`context_overflow_policy`) while enum values are
/// camelCase (`truncateMiddle`, …) per lmstudio-js shared types.
///
/// `min_p` is not on the OpenAI-compat supported-parameter list but is
/// honored by LM Studio's v1 server in practice — best-effort only.
///
/// `context_overflow_policy` is persisted in settings for the UI but is not
/// sent on the wire: LM Studio's HTTP API currently rejects every
/// `lmstudio.context_overflow_policy` value with HTTP 400 (see
/// lmstudio-ai/lmstudio-bug-tracker#532).
fn apply_inference_settings(body: &mut serde_json::Map<String, Value>, s: &Settings) {
    if s.limit_response_length {
        body.insert("max_tokens".into(), json!(s.max_tokens));
    }

    let stops = parse_stop_strings(&s.stop_strings);
    if !stops.is_empty() {
        body.insert("stop".into(), json!(stops));
    }

    if s.top_k > 0 {
        body.insert("top_k".into(), json!(s.top_k));
    }

    if s.repeat_penalty_enabled {
        body.insert("repeat_penalty".into(), json!(s.repeat_penalty));
    }

    if s.presence_penalty_enabled {
        body.insert("presence_penalty".into(), json!(s.presence_penalty));
    }

    if s.top_p_enabled {
        body.insert("top_p".into(), json!(s.top_p));
    }

    if s.min_p_enabled {
        body.insert("min_p".into(), json!(s.min_p));
    }

    if s.structured_output_enabled {
        if let Some(response_format) = build_response_format(&s.structured_output) {
            body.insert("response_format".into(), response_format);
        }
    }

    // Reasoning toggle. The frontend gates the user-visible checkbox on the
    // active model's `capabilities.reasoning` so this branch can fire
    // unconditionally — non-reasoning models silently ignore the field. We
    // only send the off-switch ("minimal" effort) because forcing reasoning
    // on a model that doesn't support it has no effect, while disabling
    // reasoning on a thinking model is the user-meaningful action.
    if !s.reasoning_enabled {
        body.insert("reasoning_effort".into(), json!("minimal"));
    }

    if s.seed > 0 {
        body.insert("seed".into(), json!(s.seed));
    }
}

fn parse_stop_strings(raw: &str) -> Vec<String> {
    raw.split(|c| c == ',' || c == '\n')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn build_response_format(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parsed: Value = serde_json::from_str(trimmed).ok()?;
    if parsed.get("json_schema").is_some() {
        return Some(parsed);
    }
    if parsed.get("type").and_then(|v| v.as_str()) == Some("json_schema") {
        return Some(parsed);
    }

    Some(json!({
        "type": "json_schema",
        "json_schema": {
            "name": "structured_output",
            "strict": true,
            "schema": parsed,
        }
    }))
}

// -----------------------------------------------------------------------------
// call_blocking (Req 15.3, 14.1, 14.3, 14.4, 14.5)
// -----------------------------------------------------------------------------

/// POST a non-streaming chat-completions request to `settings.api_url` and
/// return `choices[0].message.content`.
///
/// Error mapping matches the streaming path so the `Status_Bar` reason is
/// the same regardless of which command produced it:
///
///   - Connect timeout / connect failure (`is_connect()` or `is_timeout()`)
///     → `LlmError::ConnectionFailed`           ("connection failed")
///   - HTTP status != 200
///     → `LlmError::HttpStatus(code)`           ("HTTP {code}")
///   - JSON parse failure or missing/empty `choices` array
///     → `LlmError::InvalidResponse`            ("invalid response")
///   - Any other request error (mid-flight body drop, reset, etc.)
///     → `LlmError::ConnectionLost`             ("connection lost")
///
/// The classification order matters: `is_connect()` and `is_timeout()` are
/// both checked before the connection-lost fallback so a 5s connect-timeout
/// surfaces `"connection failed"` rather than `"connection lost"`. The
/// post-status read failures (a server that prematurely closes the body)
/// fall through to `ConnectionLost`.
pub async fn call_blocking(text: &str, settings: &Settings) -> Result<String, LlmError> {
    let body = build_body(text, settings, false);

    let response = http_client()
        .post(&settings.api_url)
        .json(&body)
        .send()
        .await
        .map_err(map_request_error)?;

    let status = response.status();
    if !status.is_success() {
        return Err(LlmError::HttpStatus(status.as_u16()));
    }

    // Body deserialization failure during the JSON read can be either a
    // bona fide parse failure or a mid-flight connection drop. `reqwest`'s
    // `json::<Value>()` collapses both into a single error, so we
    // re-classify here: if the underlying error reports a connection
    // problem (`is_connect`, `is_timeout`, `is_request`, `is_body`), it's
    // `ConnectionLost`; otherwise it's `InvalidResponse` (Req 14.4 vs 14.5).
    let envelope: Value = response
        .json::<Value>()
        .await
        .map_err(classify_body_error)?;

    extract_first_choice_content(&envelope).ok_or(LlmError::InvalidResponse)
}

/// Pull `choices[0].message.content` out of the chat-completions envelope.
///
/// Returns `None` when the envelope is missing `choices`, the array is
/// empty, the first entry has no `message.content`, or the content is not
/// a JSON string. The caller maps `None` onto `LlmError::InvalidResponse`
/// (Req 14.4); keeping the JSON traversal in a separate pure function
/// makes the success path of `call_blocking` linear and lets the unit
/// tests below exercise every malformed-shape branch without standing up
/// an HTTP server.
fn extract_first_choice_content(envelope: &Value) -> Option<String> {
    let choices = envelope.get("choices")?.as_array()?;
    let first = choices.first()?;
    let content = first.get("message")?.get("content")?.as_str()?;
    Some(content.to_string())
}

// -----------------------------------------------------------------------------
// Agent turn (tool use, non-streaming)
// -----------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

/// One function call requested by the model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCallOut {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Non-streaming chat completion result for the frontend agent loop.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTurnResponse {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCallOut>,
    pub finish_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

/// Build a chat-completions body with `tools` for the agent loop.
pub fn build_agent_body(messages: &[Value], s: &Settings, custom_tools: &[Value]) -> Value {
    let mut body = serde_json::Map::new();
    body.insert("model".into(), json!(s.model));
    body.insert("messages".into(), json!(messages));
    body.insert("temperature".into(), json!(s.temperature));
    body.insert("stream".into(), json!(false));
    body.insert(
        "tools".into(),
        crate::editor_tools::merge_tool_definitions(custom_tools),
    );
    apply_inference_settings(&mut body, s);
    Value::Object(body)
}

// -----------------------------------------------------------------------------
// agent_stream — SSE accumulator for streaming agent turns
// -----------------------------------------------------------------------------

mod agent_stream {
    use std::collections::BTreeMap;

    use serde::Deserialize;

    use super::{AgentTurnResponse, ToolCallOut};

    #[derive(Default)]
    struct PartialToolCall {
        id: String,
        name: String,
        arguments: String,
    }

    pub struct AgentStreamAccumulator {
        content: String,
        reasoning: String,
        tool_calls: BTreeMap<usize, PartialToolCall>,
        finish_reason: Option<String>,
    }

    impl AgentStreamAccumulator {
        pub fn new() -> Self {
            Self {
                content: String::new(),
                reasoning: String::new(),
                tool_calls: BTreeMap::new(),
                finish_reason: None,
            }
        }

        pub fn into_response(self) -> AgentTurnResponse {
            let tool_calls = self
                .tool_calls
                .into_values()
                .filter(|tc| !tc.id.is_empty() && !tc.name.is_empty())
                .map(|tc| ToolCallOut {
                    id: tc.id,
                    name: tc.name,
                    arguments: tc.arguments,
                })
                .collect();

            let content = if self.content.is_empty() {
                None
            } else {
                Some(self.content)
            };

            let reasoning = if self.reasoning.is_empty() {
                None
            } else {
                Some(self.reasoning)
            };

            AgentTurnResponse {
                content,
                tool_calls,
                finish_reason: self.finish_reason,
                reasoning,
            }
        }
    }

    pub enum AgentStreamEvent {
        ReasoningToken(String),
    }

    #[derive(Deserialize)]
    struct ChunkEnvelope {
        choices: Vec<ChunkChoice>,
    }

    #[derive(Deserialize)]
    struct ChunkChoice {
        delta: ChunkDelta,
        finish_reason: Option<String>,
    }

    #[derive(Deserialize, Default)]
    struct ChunkDelta {
        content: Option<String>,
        reasoning: Option<String>,
        reasoning_content: Option<String>,
        tool_calls: Option<Vec<ToolCallDelta>>,
    }

    #[derive(Deserialize)]
    struct ToolCallDelta {
        index: Option<usize>,
        id: Option<String>,
        function: Option<ToolCallFunctionDelta>,
    }

    #[derive(Deserialize)]
    struct ToolCallFunctionDelta {
        name: Option<String>,
        arguments: Option<String>,
    }

    pub fn find_double_newline(buf: &[u8]) -> Option<usize> {
        buf.windows(2).position(|w| w == b"\n\n")
    }

    pub fn extract_data_payload(record: &str) -> Option<&str> {
        let trimmed = record.trim();
        if trimmed.is_empty() {
            return None;
        }
        trimmed.strip_prefix("data:").map(str::trim_start)
    }

    pub fn push_chunk(
        acc: &mut AgentStreamAccumulator,
        payload: &str,
    ) -> Result<Vec<AgentStreamEvent>, ()> {
        let env: ChunkEnvelope = serde_json::from_str(payload).map_err(|_| ())?;
        let choice = env.choices.into_iter().next().ok_or(())?;

        if let Some(fr) = choice.finish_reason {
            acc.finish_reason = Some(fr);
        }

        let delta = choice.delta;
        let mut events = Vec::new();

        for fragment in [delta.reasoning, delta.reasoning_content] {
            if let Some(text) = fragment {
                if !text.is_empty() {
                    acc.reasoning.push_str(&text);
                    events.push(AgentStreamEvent::ReasoningToken(text));
                }
            }
        }

        if let Some(content) = delta.content {
            if !content.is_empty() {
                acc.content.push_str(&content);
            }
        }

        if let Some(tool_calls) = delta.tool_calls {
            for tc in tool_calls {
                let index = tc.index.unwrap_or(0);
                let entry = acc.tool_calls.entry(index).or_default();
                if let Some(id) = tc.id {
                    entry.id = id;
                }
                if let Some(function) = tc.function {
                    if let Some(name) = function.name {
                        entry.name = name;
                    }
                    if let Some(args) = function.arguments {
                        entry.arguments.push_str(&args);
                    }
                }
            }
        }

        Ok(events)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn push_chunk_accumulates_reasoning_content_and_tools() {
            let mut acc = AgentStreamAccumulator::new();
            let events = push_chunk(
                &mut acc,
                r#"{"choices":[{"delta":{"reasoning_content":"think "}}]}"#,
            )
            .expect("chunk");
            assert_eq!(events.len(), 1);
            assert!(matches!(
                events[0],
                AgentStreamEvent::ReasoningToken(ref s) if s == "think "
            ));

            push_chunk(
                &mut acc,
                r#"{"choices":[{"delta":{"content":"done","tool_calls":[{"index":0,"id":"c1","function":{"name":"get_document","arguments":"{}"}}]}}]}"#,
            )
            .expect("chunk");

            let response = acc.into_response();
            assert_eq!(response.reasoning.as_deref(), Some("think "));
            assert_eq!(response.content.as_deref(), Some("done"));
            assert_eq!(response.tool_calls.len(), 1);
            assert_eq!(response.tool_calls[0].name, "get_document");
        }
    }
}

/// Parse `choices[0].message` for assistant text and/or tool calls.
pub fn extract_agent_turn_response(envelope: &Value) -> Option<AgentTurnResponse> {
    let choice = envelope.get("choices")?.as_array()?.first()?;
    let message = choice.get("message")?;
    let content = match message.get("content") {
        Some(Value::Null) | None => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let reasoning = message
        .get("reasoning")
        .or_else(|| message.get("reasoning_content"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let finish_reason = choice
        .get("finish_reason")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let tool_calls = message
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|tc| {
                    let id = tc.get("id")?.as_str()?.to_string();
                    let function = tc.get("function")?;
                    let name = function.get("name")?.as_str()?.to_string();
                    let arguments = function.get("arguments")?.as_str()?.to_string();
                    Some(ToolCallOut {
                        id,
                        name,
                        arguments,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(AgentTurnResponse {
        content,
        tool_calls,
        finish_reason,
        reasoning,
    })
}

/// POST a streaming tool-enabled chat turn to LM Studio, emitting reasoning
/// fragments to the frontend as they arrive, then return the assembled turn.
pub async fn agent_turn(
    app: &tauri::AppHandle,
    messages: Vec<Value>,
    settings: &Settings,
    custom_tools: &[Value],
) -> Result<AgentTurnResponse, LlmError> {
    match agent_turn_streaming(app, messages.clone(), settings, custom_tools).await {
        Ok(response) => Ok(response),
        Err(LlmError::HttpStatus(_)) | Err(LlmError::InvalidResponse) => {
            agent_turn_blocking(messages, settings, custom_tools).await
        }
        Err(err) => Err(err),
    }
}

async fn agent_turn_streaming(
    app: &tauri::AppHandle,
    messages: Vec<Value>,
    settings: &Settings,
    custom_tools: &[Value],
) -> Result<AgentTurnResponse, LlmError> {
    use futures_util::StreamExt;

    use crate::events::emit_llm_reasoning_token;

    let mut body = build_agent_body(&messages, settings, custom_tools);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".into(), json!(true));
    }

    let response = http_client()
        .post(&settings.api_url)
        .json(&body)
        .send()
        .await
        .map_err(map_request_error)?;

    let status = response.status();
    if !status.is_success() {
        return Err(LlmError::HttpStatus(status.as_u16()));
    }

    let mut byte_stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut acc = agent_stream::AgentStreamAccumulator::new();

    while let Some(chunk) = byte_stream.next().await {
        let bytes = chunk.map_err(|_| LlmError::ConnectionLost)?;
        buffer.extend_from_slice(&bytes);

        while let Some(idx) = agent_stream::find_double_newline(&buffer) {
            let record = std::str::from_utf8(&buffer[..idx])
                .map_err(|_| LlmError::InvalidResponse)?
                .to_string();
            buffer.drain(..idx + 2);

            if let Some(payload) = agent_stream::extract_data_payload(&record) {
                if payload == "[DONE]" {
                    return Ok(acc.into_response());
                }

                let events = agent_stream::push_chunk(&mut acc, payload)
                    .map_err(|_| LlmError::InvalidResponse)?;
                for event in events {
                    let agent_stream::AgentStreamEvent::ReasoningToken(fragment) = event;
                    let _ = emit_llm_reasoning_token(app, &fragment);
                }
            }
        }
    }

    if !buffer.is_empty() {
        if let Ok(record) = std::str::from_utf8(&buffer) {
            if let Some(payload) = agent_stream::extract_data_payload(record) {
                if payload != "[DONE]" {
                    let events = agent_stream::push_chunk(&mut acc, payload)
                        .map_err(|_| LlmError::InvalidResponse)?;
                    for event in events {
                        let agent_stream::AgentStreamEvent::ReasoningToken(fragment) = event;
                        let _ = emit_llm_reasoning_token(app, &fragment);
                    }
                }
            }
        }
    }

    Ok(acc.into_response())
}

async fn agent_turn_blocking(
    messages: Vec<Value>,
    settings: &Settings,
    custom_tools: &[Value],
) -> Result<AgentTurnResponse, LlmError> {
    let body = build_agent_body(&messages, settings, custom_tools);

    let response = http_client()
        .post(&settings.api_url)
        .json(&body)
        .send()
        .await
        .map_err(map_request_error)?;

    let status = response.status();
    if !status.is_success() {
        return Err(LlmError::HttpStatus(status.as_u16()));
    }

    let envelope: Value = response
        .json::<Value>()
        .await
        .map_err(classify_body_error)?;

    extract_agent_turn_response(&envelope).ok_or(LlmError::InvalidResponse)
}

/// Map a `reqwest::Error` from `send()` onto an `LlmError`.
///
/// `send()` covers the full request lifecycle through the response
/// headers: connect, TLS handshake, request write, and response status
/// line. A connect-side failure (connect refused, DNS failure, TLS
/// handshake) is the design-mandated `"connection failed"`; the 5s
/// `connect_timeout` surfaces here as `is_timeout()` (the timer fires
/// before any bytes leave the host). Anything else at this stage is a
/// dropped/reset connection mid-handshake or mid-write — Req 14.5's
/// `"connection lost"`.
fn map_request_error(err: reqwest::Error) -> LlmError {
    if err.is_connect() || err.is_timeout() {
        LlmError::ConnectionFailed
    } else {
        LlmError::ConnectionLost
    }
}

/// Map a `reqwest::Error` from `json()` (post-200 body read) onto an
/// `LlmError`.
///
/// `json()` is "decode the body bytes as JSON". Two failure modes:
///   - the body was received in full but is not valid JSON for the
///     chat-completions shape — `LlmError::InvalidResponse` (Req 14.4).
///   - the connection dropped mid-body, leaving truncated bytes behind —
///     surfaced by `reqwest` as `is_body()` / `is_request()` /
///     `is_timeout()` and mapped to `LlmError::ConnectionLost` (Req 14.5).
fn classify_body_error(err: reqwest::Error) -> LlmError {
    if err.is_body() || err.is_request() || err.is_timeout() || err.is_connect() {
        LlmError::ConnectionLost
    } else {
        LlmError::InvalidResponse
    }
}

// -----------------------------------------------------------------------------
// SSE parser (Task 14, Req 13.1, 14.4)
// -----------------------------------------------------------------------------

/// Stateful Server-Sent-Events parser for the OpenAI streaming chat
/// completions wire format used by LM Studio.
///
/// The parser is designed to be fed the raw byte chunks produced by
/// `reqwest::Response::bytes_stream()` exactly as they arrive — a single
/// network read may carry multiple SSE records, half a record, or a
/// fraction of a multi-byte UTF-8 character mid-record. The parser
/// accumulates bytes into an internal `Vec<u8>` and surfaces zero or more
/// `SseEvent`s per `push()` call once full records (terminated by `\n\n`)
/// land in the buffer.
///
/// Wire format (per design.md "SSE parser is intentionally minimal"):
///
/// ```text
/// data: {"choices":[{"delta":{"content":"hello"}}]}\n\n
/// data: [DONE]\n\n
/// ```
///
/// Per design step 1–6:
///   1. Append incoming bytes to an accumulator.
///   2. Split on `\n\n` to extract one record per slot.
///   3. Strip the leading `data:` prefix (and any space that follows).
///   4. `[DONE]` payload → `SseEvent::Done`.
///   5. Otherwise parse with `serde_json::from_str::<ChunkEnvelope>` and
///      pull `choices[0].delta.content`. Emit only when present and
///      non-empty.
///   6. Any deserialization failure (or non-UTF-8 record bytes) aborts
///      with `InvalidResponse`, which the streaming task maps onto
///      `LlmError::InvalidResponse` → `"invalid response"` (Req 14.4).
///
/// UTF-8 boundary handling: `\n` is the ASCII byte `0x0A`, which never
/// participates in a multi-byte UTF-8 sequence (continuation bytes are
/// `0x80..=0xBF`, leading bytes `0xC0..=0xFD`). So the first `\n\n` we
/// find in the byte buffer never lands inside a multi-byte character —
/// the bytes before it are guaranteed to end on a code-point boundary,
/// and `std::str::from_utf8` succeeds the moment a full record's bytes
/// are present. Partial multi-byte sequences at the end of a chunk
/// simply remain in the buffer until the next chunk completes them
/// before the next separator.
///
/// `\n\n` inside JSON string values: the JSON serialization rules
/// require control characters in strings to be escaped (`\n` is the
/// two-byte sequence `\` + `n`, NOT raw `0x0A`). Compliant OpenAI
/// servers therefore never produce raw `\n\n` inside a JSON string, so
/// byte-splitting on `\n\n` cannot land mid-record for any well-formed
/// stream. Pathological non-compliant servers that emit raw control
/// characters inside JSON strings are treated as protocol violations:
/// the resulting JSON parse failure abort with `InvalidResponse`,
/// matching the Req 14.4 surface.
pub mod sse_parser {
    use serde::Deserialize;

    /// Streaming SSE parser. Construct with `new()`, feed bytes with
    /// `push()`, and consume the trailing partial record (if any) with
    /// `finish()`.
    pub struct SseParser {
        /// Byte accumulator. Use `Vec<u8>` rather than `String` so a
        /// chunk that lands mid-multi-byte-character can be deferred to
        /// the next `push()` without invoking `String::from_utf8_lossy`
        /// (which would silently drop invalid bytes — Req 14.4 wants a
        /// hard parse failure on bad UTF-8).
        buffer: Vec<u8>,
        /// Set to `true` once `[DONE]` has been emitted. Subsequent
        /// `push()` calls short-circuit so a misbehaving server cannot
        /// inject tokens after the terminal sentinel.
        done: bool,
    }

    /// Events surfaced by the parser. The streaming task converts each
    /// `Token` into a `tauri://llm-token` emit and `Done` into a clean
    /// `tauri://llm-complete` (no error) per Req 13.1 / 14.6.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum SseEvent {
        /// A non-empty `delta.content` fragment ready for emission.
        Token(String),
        /// The `[DONE]` sentinel was received.
        Done,
    }

    /// Parser-level error. Carries no payload because Req 14.4 pins the
    /// surfaced reason to the literal string `"invalid response"`; the
    /// streaming task maps this into `LlmError::InvalidResponse` whose
    /// `Display` produces that exact string.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct InvalidResponse;

    /// `data:` payload envelope. Only `choices[0].delta.content` is
    /// consumed; `id`, `role`, `finish_reason`, and any other fields are
    /// intentionally ignored to keep the parser lenient against minor
    /// schema drift across OpenAI-compatible servers.
    #[derive(Deserialize)]
    struct ChunkEnvelope {
        choices: Vec<ChunkChoice>,
    }

    #[derive(Deserialize)]
    struct ChunkChoice {
        /// `delta` is required by the OpenAI streaming schema. A missing
        /// or null `delta` triggers a parse failure → `InvalidResponse`,
        /// which is the design-mandated surface for malformed envelopes.
        delta: ChunkDelta,
    }

    #[derive(Deserialize)]
    struct ChunkDelta {
        /// First chunk usually has `{"role":"assistant"}` and no
        /// `content`; final chunk carries `finish_reason` with empty
        /// delta. Both should be silently dropped without emitting a
        /// `Token`. `content: ""` (present but empty) is also dropped.
        content: Option<String>,
    }

    impl SseParser {
        /// Construct a fresh parser with an empty buffer.
        pub fn new() -> Self {
            Self {
                buffer: Vec::new(),
                done: false,
            }
        }

        /// Feed a chunk of bytes from `Response::bytes_stream()`.
        ///
        /// Returns the events extracted by completing one or more
        /// records. Bytes that don't form a complete record are buffered
        /// for the next call. After `[DONE]` has been observed, further
        /// calls are no-ops and return an empty `Vec`.
        ///
        /// Errors:
        ///   - `InvalidResponse` if a record contains invalid UTF-8.
        ///   - `InvalidResponse` if a `data:` payload (other than
        ///     `[DONE]`) does not parse as a `ChunkEnvelope`.
        pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, InvalidResponse> {
            if self.done {
                return Ok(Vec::new());
            }
            self.buffer.extend_from_slice(chunk);

            let mut events = Vec::new();
            while let Some(idx) = find_double_newline(&self.buffer) {
                // `\n` is ASCII (0x0A) and cannot appear inside a UTF-8
                // continuation byte, so `buffer[..idx]` is guaranteed to
                // end on a code-point boundary even when the chunk
                // carrying the separator was preceded by a partial
                // multi-byte character.
                let record = std::str::from_utf8(&self.buffer[..idx])
                    .map_err(|_| InvalidResponse)?
                    .to_string();
                self.buffer.drain(..idx + 2);

                if let Some(event) = parse_record(&record)? {
                    let is_done = matches!(event, SseEvent::Done);
                    events.push(event);
                    if is_done {
                        // Drop any bytes after `[DONE]`; a compliant
                        // server doesn't emit anything past it and a
                        // misbehaving one shouldn't be able to inject
                        // tokens through the parser.
                        self.buffer.clear();
                        self.done = true;
                        break;
                    }
                }
            }
            Ok(events)
        }

        /// Force-flush any buffered bytes at end-of-stream. The remaining
        /// bytes are treated as one final record. Returns events
        /// extracted from that record, if any.
        ///
        /// The streaming task calls this only when the upstream byte
        /// stream has cleanly ended without producing the expected
        /// trailing `\n\n`; a partial record left in the buffer is more
        /// likely a server quirk than a real event, but processing it
        /// keeps the parser symmetric with `push()`.
        pub fn finish(self) -> Result<Vec<SseEvent>, InvalidResponse> {
            if self.done || self.buffer.is_empty() {
                return Ok(Vec::new());
            }
            let record = std::str::from_utf8(&self.buffer).map_err(|_| InvalidResponse)?;
            let mut events = Vec::new();
            if let Some(event) = parse_record(record)? {
                events.push(event);
            }
            Ok(events)
        }
    }

    impl Default for SseParser {
        fn default() -> Self {
            Self::new()
        }
    }

    /// Find the byte offset of the first `\n\n` occurrence, or `None` if
    /// the buffer doesn't contain one yet.
    fn find_double_newline(buf: &[u8]) -> Option<usize> {
        // `windows(2)` is allocation-free and runs in O(n).
        buf.windows(2).position(|w| w == b"\n\n")
    }

    /// Parse a single SSE record (the bytes between consecutive `\n\n`
    /// separators) into an optional `SseEvent`.
    ///
    /// Returns:
    ///   - `Ok(None)` for empty records, comment-only records (lines
    ///     starting with `:`), and records whose only `data:` payload is
    ///     `delta.content == None || ""` (Req 14.6 says only non-empty
    ///     fragments are emitted).
    ///   - `Ok(Some(SseEvent::Done))` for the `[DONE]` sentinel.
    ///   - `Ok(Some(SseEvent::Token(...)))` for a non-empty content
    ///     fragment.
    ///   - `Err(InvalidResponse)` for any payload that fails to parse as
    ///     a `ChunkEnvelope`.
    fn parse_record(record: &str) -> Result<Option<SseEvent>, InvalidResponse> {
        // Trim whole-record whitespace so trailing `\r` from `\r\n\r\n`
        // separators (which we don't split on, but which servers may
        // emit) and stray surrounding spaces don't confuse the
        // prefix-strip step.
        let trimmed = record.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        // SSE allows multiline records (`event:`, `id:`, `retry:`, plus
        // multiple `data:` lines that get joined with `\n`). OpenAI only
        // emits single-line `data: ...` records, so the simple prefix
        // check covers every real-world case. Anything else is a comment
        // (`:` lines) or out-of-band metadata we silently drop.
        let payload = match trimmed.strip_prefix("data:") {
            Some(rest) => rest.trim_start(),
            None => return Ok(None),
        };

        if payload == "[DONE]" {
            return Ok(Some(SseEvent::Done));
        }

        let env: ChunkEnvelope = serde_json::from_str(payload).map_err(|_| InvalidResponse)?;
        let content = env
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.delta.content)
            .unwrap_or_default();
        if content.is_empty() {
            Ok(None)
        } else {
            Ok(Some(SseEvent::Token(content)))
        }
    }

    // ---- Tests -----------------------------------------------------------

    #[cfg(test)]
    mod tests {
        use super::*;

        fn one_event(content: &str) -> String {
            format!(
                "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n",
                serde_json::to_string(content).unwrap()
            )
        }

        /// Two well-formed records arriving in a single `push()` call
        /// surface in order, in the same `Vec`.
        #[test]
        fn push_emits_multiple_events_from_one_chunk() {
            let mut p = SseParser::new();
            let payload = format!("{}{}", one_event("hello"), one_event(" world"));
            let events = p.push(payload.as_bytes()).unwrap();
            assert_eq!(
                events,
                vec![
                    SseEvent::Token("hello".into()),
                    SseEvent::Token(" world".into()),
                ]
            );
        }

        /// A single record split across two reads is reassembled across
        /// `push()` boundaries: nothing emits on the first half, the
        /// token emits when the trailing `\n\n` lands in the second.
        #[test]
        fn single_event_split_across_two_reads() {
            let mut p = SseParser::new();
            let full = one_event("ping");
            let mid = full.len() / 2;
            let first = p.push(full[..mid].as_bytes()).unwrap();
            assert!(first.is_empty());
            let second = p.push(full[mid..].as_bytes()).unwrap();
            assert_eq!(second, vec![SseEvent::Token("ping".into())]);
        }

        /// One read carries 1.5 records, the next completes the second.
        /// First read emits one event; second read emits the rest.
        #[test]
        fn multiple_events_split_across_two_reads() {
            let mut p = SseParser::new();
            let combined = format!("{}{}", one_event("alpha"), one_event("beta"));
            let cut = combined.find("beta").unwrap();
            let first = p.push(combined[..cut].as_bytes()).unwrap();
            assert_eq!(first, vec![SseEvent::Token("alpha".into())]);
            let second = p.push(combined[cut..].as_bytes()).unwrap();
            assert_eq!(second, vec![SseEvent::Token("beta".into())]);
        }

        /// `[DONE]` produces `SseEvent::Done` and locks the parser:
        /// further bytes are ignored.
        #[test]
        fn done_sentinel_terminates_stream() {
            let mut p = SseParser::new();
            let payload = format!("{}data: [DONE]\n\n", one_event("hi"));
            let events = p.push(payload.as_bytes()).unwrap();
            assert_eq!(
                events,
                vec![SseEvent::Token("hi".into()), SseEvent::Done]
            );
            // Anything after [DONE] is dropped on the floor.
            let after = p.push(one_event("nope").as_bytes()).unwrap();
            assert!(after.is_empty());
        }

        /// Leading and trailing whitespace inside a record is tolerated:
        /// `data:` works with or without a space after the colon, and a
        /// stray `\r` in front of `\n\n` (from `\r\n\r\n`-style framing)
        /// doesn't break the parse.
        #[test]
        fn whitespace_in_records_is_tolerated() {
            let mut p = SseParser::new();
            let payload = "data:{\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\r\n\n\
                           data:   {\"choices\":[{\"delta\":{\"content\":\"y\"}}]}\n\n";
            let events = p.push(payload.as_bytes()).unwrap();
            assert_eq!(
                events,
                vec![
                    SseEvent::Token("x".into()),
                    SseEvent::Token("y".into()),
                ]
            );
        }

        /// Malformed JSON in a `data:` payload aborts the stream with
        /// `InvalidResponse`; this is the source of the Req 14.4
        /// `"invalid response"` Status_Bar reason.
        #[test]
        fn malformed_json_returns_invalid_response() {
            let mut p = SseParser::new();
            let payload = "data: {not json}\n\n";
            let err = p.push(payload.as_bytes()).unwrap_err();
            assert_eq!(err, InvalidResponse);
        }

        /// A multi-byte character split across two chunks is reassembled
        /// once the second chunk arrives. The character `é` is encoded
        /// as `0xC3 0xA9`; if the first chunk ends on `0xC3`, the parser
        /// must defer UTF-8 validation until the next chunk lands.
        #[test]
        fn partial_utf8_split_across_chunks_is_buffered() {
            let mut p = SseParser::new();
            let full = one_event("café");
            let bytes = full.as_bytes();
            // Find the byte index of the first 0xC3 (start of `é`) and
            // split the stream right between `0xC3` and `0xA9`.
            let cut = bytes.iter().position(|&b| b == 0xC3).unwrap() + 1;
            assert_eq!(bytes[cut - 1], 0xC3);
            assert_eq!(bytes[cut], 0xA9);

            let first = p.push(&bytes[..cut]).unwrap();
            assert!(first.is_empty(), "no events until char completes");
            let second = p.push(&bytes[cut..]).unwrap();
            assert_eq!(second, vec![SseEvent::Token("café".into())]);
        }

        /// Records that don't begin with `data:` (SSE comments, `event:`
        /// lines from non-OpenAI servers, blank framing) are silently
        /// dropped so they don't pollute the token stream.
        #[test]
        fn non_data_lines_are_ignored() {
            let mut p = SseParser::new();
            let payload = format!(
                ": this is a heartbeat comment\n\n{}event: ping\n\n{}",
                one_event("kept"),
                one_event("also-kept"),
            );
            let events = p.push(payload.as_bytes()).unwrap();
            assert_eq!(
                events,
                vec![
                    SseEvent::Token("kept".into()),
                    SseEvent::Token("also-kept".into()),
                ]
            );
        }

        /// A `delta` with no `content` (the typical first chunk that
        /// only carries `{"role":"assistant"}`) is silently dropped, and
        /// an explicit empty `content: ""` likewise produces no event.
        #[test]
        fn empty_or_missing_content_is_skipped() {
            let mut p = SseParser::new();
            let payload = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
                           data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n\n\
                           data: {\"choices\":[{\"delta\":{\"content\":\"actual\"}}]}\n\n";
            let events = p.push(payload.as_bytes()).unwrap();
            assert_eq!(events, vec![SseEvent::Token("actual".into())]);
        }

        /// JSON-escaped newlines inside a string value are encoded over
        /// the wire as the two-byte sequence `\n` (backslash + 'n'), not
        /// as raw `0x0A`. Splitting on raw `\n\n` therefore can't land
        /// inside the JSON string, and the record stays intact.
        #[test]
        fn newlines_inside_json_strings_dont_split_records() {
            let mut p = SseParser::new();
            // Build a JSON envelope whose `content` is `hello\n\nworld`.
            // `serde_json::to_string` produces `"hello\\n\\nworld"`,
            // i.e. `hello\n\nworld` over the wire — no raw `0x0A`.
            let event = one_event("hello\n\nworld");
            assert!(
                !event[..event.len() - 2].contains("\n\n"),
                "wire payload (excluding terminator) must not contain raw \\n\\n"
            );
            let events = p.push(event.as_bytes()).unwrap();
            assert_eq!(
                events,
                vec![SseEvent::Token("hello\n\nworld".into())]
            );
        }

        /// `finish()` flushes any trailing record that lacks a `\n\n`
        /// terminator. This covers servers that close the stream without
        /// the final blank line.
        #[test]
        fn finish_flushes_trailing_record_without_terminator() {
            let mut p = SseParser::new();
            // Push a record without the trailing `\n\n`.
            let partial = "data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}";
            let mid = p.push(partial.as_bytes()).unwrap();
            assert!(mid.is_empty());
            let tail = p.finish().unwrap();
            assert_eq!(tail, vec![SseEvent::Token("tail".into())]);
        }

        /// `finish()` after `[DONE]` returns no events and ignores any
        /// post-sentinel bytes the upstream might have buffered.
        #[test]
        fn finish_after_done_returns_empty() {
            let mut p = SseParser::new();
            let _ = p.push(b"data: [DONE]\n\n").unwrap();
            assert_eq!(p.finish().unwrap(), Vec::<SseEvent>::new());
        }

        /// Invalid UTF-8 inside a record returns `InvalidResponse`. We
        /// build a record whose pre-`\n\n` bytes contain an invalid
        /// continuation byte (`0xC3` followed by `0x20`, which is not a
        /// valid continuation) so `std::str::from_utf8` fails.
        #[test]
        fn invalid_utf8_record_returns_invalid_response() {
            let mut p = SseParser::new();
            let mut bytes = b"data: ".to_vec();
            bytes.push(0xC3); // start of a 2-byte UTF-8 sequence...
            bytes.push(0x20); // ...but `0x20` (space) is not a continuation byte.
            bytes.extend_from_slice(b"\n\n");
            let err = p.push(&bytes).unwrap_err();
            assert_eq!(err, InvalidResponse);
        }
    }
}

// -----------------------------------------------------------------------------
// start_stream (Task 15, Req 13.1, 13.5, 13.7, 14.1, 14.2, 14.3, 14.4, 14.5,
//                       14.6, 14.7, 15.4, 15.8)
// -----------------------------------------------------------------------------

use futures_util::StreamExt;
use tauri::{AppHandle, Manager};
use tokio::time::{sleep_until, Instant};
use tokio_util::sync::CancellationToken;

use crate::events::{emit_llm_complete, emit_llm_token};
use crate::state::AppState;

use self::sse_parser::{SseEvent, SseParser};

/// Idle-timeout budget per Req 14.2: 60s of no incoming bytes before we
/// abort the stream with `"stream timed out"`. Pinned as a constant so
/// the value is documented next to the loop logic rather than buried in
/// a magic literal.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Drive the streaming LLM pipeline to its terminal `tauri://llm-complete`
/// emit and release the `StreamRegistry` slot.
///
/// Ownership: the future owns `text`, `settings`, and `cancel`, plus the
/// `reqwest::Response` and `bytes_stream()` it constructs internally. The
/// caller (`commands::stream_llm`) hands these in by value after acquiring
/// the registry slot, then `tokio::spawn`s this function so the command
/// itself returns within Req 15.4's 200ms budget.
///
/// Three priority-ordered terminal arms (Req 13.5, 13.7, 14.6, "Stream
/// error semantics" in design.md):
///
///   1. Connect-phase failure or non-200 status — detected synchronously
///      before entering the loop. `is_connect()`/`is_timeout()` →
///      `"connection failed"` (Req 14.1); other send errors →
///      `"connection lost"` (Req 14.5); non-200 status → `"HTTP {code}"`
///      (Req 14.3).
///
///   2. In-loop `tokio::select!` over three arms:
///      - `cancel.cancelled()` — clean completion, `error: None`
///        (Req 13.7). Within 1s of the token firing the terminal emit
///        lands; the surrounding race only exits the select arm, the
///        emit happens immediately after `break`.
///      - `sleep_until(last_byte_at + IDLE_TIMEOUT)` — `"stream timed
///        out"` (Req 14.2). `last_byte_at` is reset on every successful
///        chunk read, so a still-flowing stream cannot trip this arm.
///      - `bytes_stream().next()` — feed bytes into the parser.
///        - `Some(Ok(bytes))` → parse → emit each `Token`; on `Done`,
///          break with clean completion.
///        - `Some(Err(_))` → mid-stream connection drop → `"connection
///          lost"` (Req 14.5).
///        - `None` → EOF without `[DONE]` → `"connection lost"`
///          (per the "Stream error semantics" arm 5).
///        - parser → `InvalidResponse` → `"invalid response"` (Req 14.4).
///
///   3. Whatever the terminal arm: `emit_llm_complete(...)` fires once,
///      then `StreamRegistry::release()` is called unconditionally so the
///      next Send to Model is accepted (Req 14.6 trailing sentence).
///
/// `app.state::<AppState>()` is the canonical way to recover the managed
/// state from inside a spawned task; the registry's `release()` is
/// idempotent on a missing slot, so even a pathological cancellation race
/// cannot deadlock or double-release.
///
/// Tokens emitted before a terminal failure are NOT rolled back (Req
/// 14.7); the frontend keeps whatever was already spliced into the
/// buffer, and the stream-`Edit_Group` is committed by the frontend on
/// the terminal `tauri://llm-complete` arm (Req 13.9, 18.7–18.10).
pub async fn start_stream(
    app: AppHandle,
    text: String,
    settings: Settings,
    cancel: CancellationToken,
) {
    // RAII guard so the registry slot is released even if `run_stream`
    // panics. `tokio::spawn` catches the panic at the task boundary, but
    // the panic still skips any post-await statement here — so a plain
    // `app.state::<AppState>().stream.release()` after the await would
    // leave the registry permanently occupied and block every future
    // Send to Model. Stuffing the release into `Drop` makes it run on
    // both the happy and the unwinding path.
    let _guard = ReleaseOnDrop::new(app.clone());
    run_stream(&app, text, settings, cancel).await;
}

/// RAII guard that releases the `StreamRegistry` slot when dropped.
///
/// Held by `start_stream` so the slot is freed on every exit path: clean
/// completion, error, cancellation, or panic. `release()` itself is
/// idempotent — clearing an already-empty slot is a no-op (`Mutex<Option>`
/// → `*slot = None`) — so wrapping it in `Drop` is purely additive.
struct ReleaseOnDrop {
    app: AppHandle,
}

impl ReleaseOnDrop {
    fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.app.state::<AppState>().stream.release();
    }
}

/// Inner driver that emits exactly one `tauri://llm-complete` and
/// returns. Split out from `start_stream` so the unconditional
/// `release()` in the wrapper cannot be skipped by an early `return`.
async fn run_stream(
    app: &AppHandle,
    text: String,
    settings: Settings,
    cancel: CancellationToken,
) {
    // 1. Build the request body with `stream: true` and POST it. Failures
    //    here are connect-phase errors (DNS/connect/TLS/handshake) or the
    //    5s connect_timeout; both surface as the design's
    //    `"connection failed"` reason (Req 14.1) when `is_connect()` or
    //    `is_timeout()` matches. Anything else at this stage is a dropped
    //    connection mid-handshake or mid-write — Req 14.5's
    //    `"connection lost"`.
    let body = build_body(&text, &settings, true);
    let response = match http_client()
        .post(&settings.api_url)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            let reason = if err.is_connect() || err.is_timeout() {
                LlmError::ConnectionFailed.to_string()
            } else {
                LlmError::ConnectionLost.to_string()
            };
            let _ = emit_llm_complete(app, Some(reason));
            return;
        }
    };

    // 2. HTTP-level status check. Non-200 surfaces as `"HTTP {code}"`
    //    verbatim (Req 14.3). Detected synchronously before entering the
    //    loop so the `Status_Bar` reason carries the decimal status from
    //    the very first emit, with no token events in between.
    let status = response.status();
    if !status.is_success() {
        let reason = LlmError::HttpStatus(status.as_u16()).to_string();
        let _ = emit_llm_complete(app, Some(reason));
        return;
    }

    // 3. Drain the body as an SSE stream. `bytes_stream()` yields
    //    `Result<Bytes, reqwest::Error>` chunks. Pin it on the stack so
    //    `tokio::select!` can poll it across arm visits.
    let mut stream = response.bytes_stream();
    let mut parser = SseParser::new();
    let mut last_byte_at = Instant::now();

    // Terminal reason. `None` is the clean-completion sentinel (cancel
    // or `[DONE]`); `Some(reason)` carries any error-arm reason. The
    // `loop`/`break` shape lets every arm pick its reason in one place
    // and emit-and-release outside the loop.
    let reason: Option<String> = loop {
        tokio::select! {
            // Bias toward cancel first: on a near-simultaneous cancel +
            // chunk arrival, prefer the cancel so the user-visible
            // outcome matches the action the user just took. `select!`'s
            // default is random; `biased` makes the priority explicit.
            biased;

            // Arm 1: cooperative cancellation (Req 13.7).
            //
            // The `Status_Bar` ends a cancelled stream silently — no
            // error reason is rendered (Req 14.6 only fires for failure
            // arms). The token has already been observed by the streaming
            // task at this point; dropping `stream`/`response` on `break`
            // closes the connection underneath us.
            _ = cancel.cancelled() => {
                break None;
            }

            // Arm 2: idle timeout (Req 14.2).
            //
            // `sleep_until` is recreated each iteration with the latest
            // `last_byte_at`; on a fast-flowing stream the deadline
            // advances faster than the timer fires, so this arm never
            // wins. On a stalled stream (server hung, network silent)
            // the 60s budget elapses and we abort with `"stream timed
            // out"`.
            _ = sleep_until(last_byte_at + IDLE_TIMEOUT) => {
                break Some(LlmError::StreamTimedOut.to_string());
            }

            // Arm 3: next chunk from the body stream.
            //
            // `next()` resolves to:
            //   - `None`            — EOF without `[DONE]`, treat as a
            //                         dropped connection (Req 14.5,
            //                         "Stream error semantics" arm 5).
            //   - `Some(Err(_))`    — mid-stream connection drop
            //                         (Req 14.5, arm 4).
            //   - `Some(Ok(bytes))` — feed the parser; emit each token,
            //                         break cleanly on `Done`, abort
            //                         with `"invalid response"` on a
            //                         parse failure (Req 14.4).
            chunk = stream.next() => {
                match chunk {
                    None => {
                        break Some(LlmError::ConnectionLost.to_string());
                    }
                    Some(Err(_e)) => {
                        break Some(LlmError::ConnectionLost.to_string());
                    }
                    Some(Ok(bytes)) => {
                        // Reset the idle-timeout deadline against the
                        // current monotonic clock; the next `select!`
                        // iteration recreates `sleep_until` with this
                        // fresh value.
                        last_byte_at = Instant::now();

                        let events = match parser.push(&bytes) {
                            Ok(evs) => evs,
                            Err(_) => {
                                break Some(LlmError::InvalidResponse.to_string());
                            }
                        };

                        let mut hit_done = false;
                        for ev in events {
                            match ev {
                                SseEvent::Token(fragment) => {
                                    // A failed `emit_llm_token` is a
                                    // WebView-dispatch hiccup, not a
                                    // protocol error. Log the underlying
                                    // `tauri::Error` and keep streaming
                                    // — dropping the connection over a
                                    // transient IPC failure would lose
                                    // the rest of the response and
                                    // surface `"connection lost"` even
                                    // though the upstream was healthy.
                                    if let Err(e) = emit_llm_token(app, &fragment) {
                                        log::warn!(
                                            "failed to emit tauri://llm-token: {e}"
                                        );
                                    }
                                }
                                SseEvent::Done => {
                                    hit_done = true;
                                    break;
                                }
                            }
                        }

                        if hit_done {
                            break None;
                        }
                    }
                }
            }
        }
    };

    // Single terminal emit (Req 13.5). Release happens in the outer
    // `start_stream` wrapper via `ReleaseOnDrop`, which fires on both the
    // happy and the unwinding path so a panic mid-stream still clears
    // the registry slot and lets the user retry.
    if let Err(e) = emit_llm_complete(app, reason) {
        log::warn!("failed to emit tauri://llm-complete: {e}");
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{ContextOverflowPolicy, Settings};
    use serde_json::json;

    fn settings_with_prompt(system_prompt: &str) -> Settings {
        Settings {
            system_prompt: system_prompt.into(),
            temperature: 0.4,
            max_tokens: 256,
            ..Settings::default()
        }
    }

    // ---- build_body -------------------------------------------------------

    /// Empty `system_prompt` → no system message; `messages` contains only
    /// the user message (Req 12.1, 12.5 negative side).
    #[test]
    fn build_body_omits_system_message_when_prompt_empty() {
        let s = settings_with_prompt("");
        let body = build_body("hello", &s, false);

        let messages = body.get("messages").and_then(|v| v.as_array()).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "hello");
    }

    /// Non-empty `system_prompt` → system message prepended, user message
    /// last (Req 12.1, 12.5).
    #[test]
    fn build_body_prepends_system_message_when_prompt_non_empty() {
        let s = settings_with_prompt("you are a helpful assistant");
        let body = build_body("ping", &s, true);

        let messages = body.get("messages").and_then(|v| v.as_array()).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "you are a helpful assistant");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "ping");
    }

    /// Every settings-driven field in the body is preserved exactly
    /// (Req 12.4).
    #[test]
    fn build_body_preserves_model_temperature_max_tokens_and_stream() {
        let mut s = settings_with_prompt("");
        s.model = "test-model".into();
        s.temperature = 1.5;
        s.max_tokens = 7777;

        let body_stream_true = build_body("anything", &s, true);
        assert_eq!(body_stream_true["model"], "test-model");
        assert!((body_stream_true["temperature"].as_f64().unwrap() - 1.5).abs() < f64::EPSILON);
        assert_eq!(body_stream_true["max_tokens"], 7777);
        assert_eq!(body_stream_true["stream"], true);

        let body_stream_false = build_body("anything", &s, false);
        assert_eq!(body_stream_false["stream"], false);
    }

    /// User-message content equals the supplied `text` verbatim regardless
    /// of code-point complexity. Mirrors the Req 12.2 "exact" wording.
    #[test]
    fn build_body_user_message_content_equals_text_verbatim() {
        let s = settings_with_prompt("");
        let text = "héllo 𝕏\nworld";
        let body = build_body(text, &s, false);
        let messages = body.get("messages").and_then(|v| v.as_array()).unwrap();
        assert_eq!(messages.last().unwrap()["content"], text);
    }

    /// Top-level body always includes core keys plus LM Studio inference params.
    #[test]
    fn build_body_includes_core_and_inference_keys() {
        let s = settings_with_prompt("sys");
        let body = build_body("user", &s, false);
        let obj = body.as_object().expect("body is an object");
        assert!(obj.contains_key("model"));
        assert!(obj.contains_key("messages"));
        assert!(obj.contains_key("temperature"));
        assert!(obj.contains_key("stream"));
        assert!(obj.contains_key("max_tokens"));
        assert!(obj.contains_key("top_k"));
        assert!(obj.contains_key("repeat_penalty"));
        assert!(obj.contains_key("top_p"));
        assert!(obj.contains_key("min_p"));
        assert!(!obj.contains_key("lmstudio"));
    }

    #[test]
    fn build_body_omits_lmstudio_context_overflow_extension() {
        let mut s = settings_with_prompt("");
        s.context_overflow_policy = ContextOverflowPolicy::RollingWindow;
        let body = build_body("user", &s, false);
        assert!(body.get("lmstudio").is_none());
    }

    #[test]
    fn build_body_omits_max_tokens_when_limit_disabled() {
        let mut s = settings_with_prompt("");
        s.limit_response_length = false;
        let body = build_body("user", &s, false);
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn build_body_omits_reasoning_effort_by_default() {
        // `Settings::default()` has `reasoning_enabled: true`, so we omit
        // the field and let the model use its own default reasoning mode.
        let s = settings_with_prompt("");
        let body = build_body("user", &s, false);
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn build_body_sets_reasoning_effort_minimal_when_disabled() {
        let mut s = settings_with_prompt("");
        s.reasoning_enabled = false;
        let body = build_body("user", &s, false);
        assert_eq!(body["reasoning_effort"], "minimal");
    }

    #[test]
    fn build_body_omits_seed_when_zero() {
        let s = settings_with_prompt("");
        let body = build_body("user", &s, false);
        assert!(body.get("seed").is_none());
    }

    #[test]
    fn build_body_includes_seed_when_positive() {
        let mut s = settings_with_prompt("");
        s.seed = 424242;
        let body = build_body("user", &s, false);
        assert_eq!(body["seed"], 424242);
    }

    #[test]
    fn build_body_includes_stop_strings_and_structured_output() {
        let mut s = settings_with_prompt("");
        s.stop_strings = "END,\nSTOP".into();
        s.structured_output_enabled = true;
        s.structured_output = r#"{"type":"object","properties":{"answer":{"type":"string"}}}"#
            .into();
        let body = build_body("user", &s, false);
        assert_eq!(body["stop"], json!(["END", "STOP"]));
        assert_eq!(body["response_format"]["type"], "json_schema");
    }

    // ---- extract_first_choice_content ------------------------------------

    #[test]
    fn extract_returns_content_for_well_formed_envelope() {
        let env = json!({
            "choices": [
                { "message": { "role": "assistant", "content": "hi there" } }
            ]
        });
        assert_eq!(
            extract_first_choice_content(&env).as_deref(),
            Some("hi there")
        );
    }

    #[test]
    fn extract_returns_none_when_choices_missing() {
        let env = json!({});
        assert!(extract_first_choice_content(&env).is_none());
    }

    #[test]
    fn extract_returns_none_when_choices_empty() {
        let env = json!({ "choices": [] });
        assert!(extract_first_choice_content(&env).is_none());
    }

    #[test]
    fn extract_returns_none_when_message_or_content_missing() {
        let env = json!({ "choices": [ { "message": {} } ] });
        assert!(extract_first_choice_content(&env).is_none());

        let env = json!({ "choices": [ {} ] });
        assert!(extract_first_choice_content(&env).is_none());
    }

    #[test]
    fn extract_returns_none_when_content_is_not_a_string() {
        let env = json!({
            "choices": [ { "message": { "content": 42 } } ]
        });
        assert!(extract_first_choice_content(&env).is_none());
    }

    // ---- build_agent_body / extract_agent_turn_response -------------------

    #[test]
    fn build_agent_body_includes_tools_and_messages() {
        let s = settings_with_prompt("");
        let messages = vec![json!({"role": "user", "content": "edit line 1"})];
        let body = build_agent_body(&messages, &s, &[]);
        assert_eq!(body["stream"], false);
        assert!(body.get("tools").and_then(|v| v.as_array()).is_some());
        assert_eq!(body["messages"], json!(messages));
    }

    #[test]
    fn build_agent_body_passes_tools_from_frontend() {
        let s = settings_with_prompt("");
        let messages = vec![json!({"role": "user", "content": "run greet"})];
        let tools_input = vec![
            json!({
                "type": "function",
                "function": {
                    "name": "replace_line",
                    "description": "Replace a line",
                    "parameters": { "type": "object", "properties": {} }
                }
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "greet",
                    "description": "Say hello",
                    "parameters": { "type": "object", "properties": {} }
                }
            }),
        ];
        let body = build_agent_body(&messages, &s, &tools_input);
        let tools = body["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools.last().unwrap()["function"]["name"], "greet");
    }

    #[test]
    fn extract_agent_turn_parses_content_and_tool_calls() {
        let env = json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "replace_line",
                            "arguments": "{\"line\":1,\"text\":\"hi\"}"
                        }
                    }]
                }
            }]
        });
        let parsed = extract_agent_turn_response(&env).expect("parsed");
        assert!(parsed.content.is_none());
        assert_eq!(parsed.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].name, "replace_line");
        assert_eq!(parsed.tool_calls[0].id, "call_1");
    }

    #[test]
    fn extract_agent_turn_parses_assistant_text() {
        let env = json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "Done editing."
                }
            }]
        });
        let parsed = extract_agent_turn_response(&env).expect("parsed");
        assert_eq!(parsed.content.as_deref(), Some("Done editing."));
        assert!(parsed.tool_calls.is_empty());
    }

    // ---- http_client ------------------------------------------------------

    /// `http_client()` is process-wide and returns the same pointer on
    /// repeat calls — the connection pool depends on this.
    #[test]
    fn http_client_returns_same_instance_on_repeat_calls() {
        let a = http_client() as *const _;
        let b = http_client() as *const _;
        assert_eq!(a, b);
    }
}
