# Inference Settings Audit

Cross-checks the controls drawn in `designs/LLIMEdit-design.pen` against the
runtime UI (`src/inference_panel.js`, `src/settings_modal.js`), the persisted
schema (`src-tauri/src/settings.rs`), and the request body the Rust client
sends to LM Studio (`src-tauri/src/llm_client.rs::apply_inference_settings`).

The reference for the LM Studio side is the
[`LLMPredictionConfigInput`](https://lmstudio.ai/docs/typescript/api-reference/llm-prediction-config-input)
TypeScript SDK page plus the OpenAI-compatibility
[Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
and [Structured Output](https://lmstudio.ai/docs/developer/openai-compat/structured-output)
pages. The default `api_url` ships as
`http://localhost:1234/v1/chat/completions`, so the OpenAI-compatible
`/v1/chat/completions` endpoint is the one we hit at runtime.

Shared wire-format logic is mirrored in `src/lm_studio_inference.js` for unit
and smoke tests so JS tests exercise the same payload shape as production Rust.

## Verdict at a glance

| Control                      | In design | In UI | Persisted | Sent to LM Studio | Status |
| ---------------------------- | --------- | ----- | --------- | ----------------- | ------ |
| System Prompt                | ✅        | ✅    | `system_prompt`               | as `messages[0]` (system role) | OK |
| Temperature                  | ✅        | ✅    | `temperature`                 | `temperature`                  | OK |
| Limit Response Length toggle | ✅        | ✅    | `limit_response_length`       | gates `max_tokens`             | OK |
| Max Tokens                   | ✅        | ✅    | `max_tokens`                  | `max_tokens` (when toggle on)  | OK |
| Context Overflow             | ✅        | ✅    | `context_overflow_policy`     | `lmstudio.context_overflow_policy` | ✅ fixed |
| Stop Strings                 | ✅        | ✅    | `stop_strings`                | `stop` (split on `,` / `\n`)   | OK |
| Top K Sampling               | ✅        | ✅    | `top_k`                       | `top_k` (when `> 0`)           | OK |
| Repeat Penalty (toggle + #)  | ✅        | ✅    | `repeat_penalty_enabled`, `repeat_penalty` | `repeat_penalty` (when enabled) | OK |
| Presence Penalty (toggle + #)| ✅        | ✅    | `presence_penalty_enabled`, `presence_penalty` | `presence_penalty` (when enabled) | OK |
| Top P Sampling (toggle + #)  | ✅        | ✅    | `top_p_enabled`, `top_p`      | `top_p` (when enabled)         | OK |
| Min P Sampling (toggle + #)  | ✅        | ✅    | `min_p_enabled`, `min_p`      | `min_p` (when enabled)         | ⚠ best-effort |
| Structured Output (toggle + JSON) | ✅   | ✅    | `structured_output_enabled`, `structured_output` | `response_format` (json_schema) | OK |

Settings Modal (`AI Settings`):

| Control       | In design | In UI | Persisted     | Status |
| ------------- | --------- | ----- | ------------- | ------ |
| API URL       | ✅        | ✅    | `api_url`     | OK |
| Model + Load  | ✅        | ✅    | `model`       | OK |
| Tab → Spaces  | ✅        | ✅    | `tab_spaces`  | OK |

Every inference control from the design is wired panel/modal → `api.saveSettings`
→ `Settings` → `apply_inference_settings`. The only soft dependency is `min_p`
(undocumented on OpenAI-compat docs but honored in practice).

## Where each field flows

1. UI element in `src/inference_panel.js` (each row carries an explicit `id`,
   e.g. `inference-temperature`, `inference-top-k`, etc.).
2. `readInferenceValues()` collects them into a flat object.
3. Debounced `persistInferenceSettings()` merges the snapshot with the cached
   settings and calls `api.saveSettings(...)`.
4. The Rust `Settings` struct (`src-tauri/src/settings.rs`) declares each field
   with `#[serde(default = …)]`, validates ranges in `validate()` /
   `validate_field()`, and persists to `settings.json`.
5. `llm_client::build_body()` constructs the OpenAI-compatible body for both
   `call_blocking` and `start_stream`. `apply_inference_settings()` is the one
   place every inference parameter is appended.

## What the Rust client actually sends

From `apply_inference_settings` in `src-tauri/src/llm_client.rs`, the body
includes (in addition to `model`, `messages`, `temperature`, `stream`):

```jsonc
{
  "max_tokens":        <s.max_tokens>,        // only if limit_response_length
  "stop":              [<parsed stop strings>], // only if non-empty
  "top_k":             <s.top_k>,             // only if > 0
  "repeat_penalty":    <s.repeat_penalty>,    // only if enabled
  "presence_penalty":  <s.presence_penalty>,  // only if enabled
  "top_p":             <s.top_p>,             // only if enabled
  "min_p":             <s.min_p>,             // only if enabled
  "response_format":   { "type": "json_schema", "json_schema": { … } }, // only if enabled and JSON parses
  "lmstudio": { "context_overflow_policy": "truncateMiddle" | "rollingWindow" | "stopAtLimit" }
}
```

## Mapping to LM Studio's documented surface

The OpenAI-compatible Chat Completions endpoint
([docs](https://lmstudio.ai/docs/developer/openai-compat/chat-completions))
explicitly lists these as supported payload parameters:

> `model`, `top_p`, `top_k`, `messages`, `temperature`, `max_tokens`, `stream`,
> `stop`, `presence_penalty`, `frequency_penalty`, `logit_bias`,
> `repeat_penalty`, `seed`.

The TypeScript SDK
([`LLMPredictionConfigInput`](https://lmstudio.ai/docs/typescript/api-reference/llm-prediction-config-input))
adds `minPSampling`, `topPSampling`, `topKSampling`, `repeatPenalty`,
`stopStrings`, `contextOverflowPolicy`, `structured`, plus `xtc*`, `cpuThreads`,
and `draftModel`.

Field-by-field cross-check against what we send:

- `temperature`, `max_tokens`, `top_p`, `top_k`, `stop`, `presence_penalty`,
  `repeat_penalty`, `response_format` — listed verbatim by the OpenAI-compat
  endpoint. **Sent correctly.**
- `min_p` — not on the OpenAI-compat supported list, but `minPSampling` is on
  the SDK list. LM Studio generally honors `min_p` on `/v1/chat/completions`
  in practice, but it is undocumented there — treat as best-effort.
- `lmstudio.context_overflow_policy` — LM Studio extension object on the chat
  completions body. The HTTP key is **snake_case** (`context_overflow_policy`);
  enum values are **camelCase** (`truncateMiddle`, `rollingWindow`,
  `stopAtLimit`). Community reports and LM Studio bug tracker
  ([#532](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/532))
  show this shape on native REST endpoints; it is not listed on the OpenAI-compat
  docs page but is the format lmstudio-js uses when serializing prediction
  config. **Previously we sent the wrong camelCase key
  (`contextOverflowPolicy`); fixed to snake_case.**

## Fixes applied (2026-05)

1. **`context_overflow_policy` key** — Rust `apply_inference_settings` and
   `src/lm_studio_inference.js` now emit
   `lmstudio.context_overflow_policy` instead of
   `lmstudio.contextOverflowPolicy`.
2. **Shared body builder** — `src/lm_studio_inference.js` mirrors Rust so unit
   tests (`src/__tests__/lm_studio_inference.test.js`) and smoke helpers
   (`src/__tests__/smoke/helpers/lm_studio_client.js`) assert the same wire
   format as production.
3. **Smoke coverage** — When `LLM_SMOKE=1`, `lm_studio_smoke.test.js` captures
   the last `/v1/chat/completions` body and asserts inference fields
   (`stop`, `top_k`, penalties, `lmstudio.context_overflow_policy`, etc.).

## Remaining soft dependencies

### `min_p` is undocumented on the OpenAI-compat endpoint

It works today, but the only authoritative listing is the TypeScript SDK.
If LM Studio tightens the OpenAI-compat parser, `min_p` could be dropped
silently. Code comments in Rust and JS document this.

### Context overflow on `/v1/chat/completions`

The extension object is not on the OpenAI-compat supported-parameter list.
Some LM Studio builds may only honor it on native REST paths
(`POST /api/v0/chat/completions`). We send it on `/v1/chat/completions`
because that is the configured default URL; verify with `lms log stream` or
the smoke test's captured request body when debugging a specific LM Studio
version.

### Defaults shown in the design are presentational

The design shows Temperature `0.8` and Max Tokens `2048`; runtime defaults are
Temperature `0.2` and Max Tokens `2048`.

## Items unrelated to LM Studio parameters

- The chat panel's model picker → `#chat-model-picker` / `chat:model-changed`. ✅
- Tab → Spaces → `#settings-tab-spaces` with values `2` and `4`. ✅
- Load models → `#settings-fetch-models` / `api.listModels`. ✅
- Status bar model label → `#status-model`. ✅

## Summary

Every inference control in the design has a real input, persisted field, and
code path in `apply_inference_settings`. The main bug found in audit —
wrong camelCase key for context overflow — is fixed. `min_p` and the
`lmstudio` extension block remain best-effort on `/v1/chat/completions` per
LM Studio's published OpenAI-compat surface.
