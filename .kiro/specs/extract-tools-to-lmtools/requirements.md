# Requirements Document

## Introduction

LLIMEdit ships a starter tool file, `default.lmtools`, that gives the LLM agent read/write access to the document buffer. Today that file is split awkwardly: its `schema` field holds the JSON tool definitions, but its `implementation` field is only a thin dispatcher that forwards every call to `ctx.editorTools.executeTool(name, args, ctx)`. The real per-tool logic lives in the JavaScript harness (`src/editor_tools.js`) as compiled-in functions and a `switch`-based `executeTool` dispatcher.

This split defeats the purpose of the tool editor as a learning tool. A user who opens `default.lmtools` to learn how to author custom tools sees only a forwarding stub in the implementation pane, not the actual logic. The goal of this feature is to extract every tool implementation out of `src/editor_tools.js` and into the `implementation` field of `default.lmtools`, so that opening the default tools file shows real, editable, runnable tool functions on the left (implementation) and their matching JSON schemas on the right (schema). After extraction, `src/editor_tools.js` retains only the harness glue needed to apply tool results to the on-screen buffer (buffer mutation, caret moves, span selection) and to build request previews — it contains no per-tool logic.

This is purely an internal refactor of where tool logic lives and how it is accessed. The observable behavior of the agent loop, the document tools, and the editor side effects must remain unchanged.

## Glossary

- **LLIMEdit**: The application as a whole (Tauri shell, Rust backend, HTML/JS frontend).
- **Document_Buffer**: The in-memory text content shown in the editor textarea that the document tools read and mutate.
- **Tool_File**: A `.lmtool`/`.lmtools` JSON document with the shape `{ version, implementation, schema }`, where `implementation` is a JavaScript source string and `schema` is an array of OpenAI-compatible function tool definitions.
- **Default_Tools_File**: The repository starter Tool_File at `default.lmtools`.
- **Tool_Implementation**: The JavaScript source string stored in the `implementation` field of a Tool_File, defining the executable behavior of one or more Document_Tools.
- **Tool_Schema**: The array of function tool definitions stored in the `schema` field of a Tool_File.
- **Document_Tool**: One of the buffer-editing tools `get_document`, `goto_line`, `insert_text`, `replace_line`, `replace_span`, `delete_lines`, `delete_span`, plus the legacy variants `replace_range` and `delete_range`.
- **Tool_Result**: The object returned by executing a Document_Tool, carrying an `ok` flag, an optional `new_text` field for mutating tools, a `changed` flag, and tool-specific metadata (e.g. `line`, `start_column`, `deleted_lines`).
- **Tool_Editor**: The two-pane editor in `src/tool_editor.js` that loads, displays, edits, and saves a Tool_File.
- **Implementation_Pane**: The left pane of the Tool_Editor, which holds the JavaScript Tool_Implementation.
- **Schema_Pane**: The right pane of the Tool_Editor, which holds the JSON Tool_Schema.
- **Tool_Runtime**: The Tool_Editor subsystem that compiles the Tool_Implementation into a callable function and invokes it for a named Document_Tool (today implemented as `executeCustomTool`).
- **Editor_Tools_Module**: The JavaScript harness file `src/editor_tools.js`.
- **Side_Effect_Application**: The harness step that writes a Tool_Result into the Document_Buffer and updates the caret or selection (today `applyToolSideEffects`, `applyMutatingResult`, `applyGotoLine`, `applyLineColumnSpan`).
- **Text_Geometry_Utility**: A tool-agnostic helper that converts between text and line/column positions (line splitting, joining, column resolution, line/column-to-index conversion) used by Side_Effect_Application.
- **Agent_Loop**: The multi-turn tool-use loop in `src/agent.js` (`runAgent`) that sends Tool_Schema definitions to the model and executes returned tool calls.
- **Schema_Accessor**: The exported function that returns the Tool_Schema array of the loaded Tool_File, renamed `getAgentToolSchemas`.
- **Function_Accessor**: The exported function that returns the callable Document_Tool functions defined by the loaded Tool_Implementation, named `getAgentToolFunctions`.

## Requirements

### Requirement 1: Tool Implementations Reside in the Tool File

**User Story:** As a user learning to author custom tools, I want the default tools' implementation code to live inside `default.lmtools`, so that opening the file shows me the actual tool logic I can study and modify.

#### Acceptance Criteria

1. THE Default_Tools_File SHALL store, in the implementation field, JavaScript source that defines, for each of the names `get_document`, `goto_line`, `insert_text`, `replace_line`, `replace_span`, `delete_lines`, and `delete_span`, a callable implementation that the Tool_Runtime can invoke by that name to return a Tool_Result.
2. THE Default_Tools_File SHALL store, in the implementation field, JavaScript source that defines, for each of the legacy names `replace_range` and `delete_range`, a callable implementation that the Tool_Runtime can invoke by that name to return a Tool_Result.
3. THE Default_Tools_File SHALL store, in the schema field, exactly seven function tool definitions, one for each of `get_document`, `goto_line`, `insert_text`, `replace_line`, `replace_span`, `delete_lines`, and `delete_span`, where each definition's tool name equals the corresponding Document_Tool name.
4. WHEN a Document_Tool is invoked by name, THE Tool_Runtime SHALL compute the Tool_Result using only the Tool_Implementation loaded from the Tool_File.
5. WHEN a Document_Tool is invoked by name, THE Tool_Runtime SHALL NOT delegate computation of the Tool_Result to the Editor_Tools_Module dispatcher.
6. WHEN the Default_Tools_File is parsed, THE Tool_Editor SHALL produce exactly one Tool_Implementation string and exactly one Tool_Schema array.

### Requirement 2: Editor Tools Module Contains No Tool Logic

**User Story:** As a developer maintaining LLIMEdit, I want all per-tool logic removed from the JavaScript harness, so that the harness holds only glue code and the Tool_File is the single source of truth for tool behavior.

#### Acceptance Criteria

1. WHEN the Editor_Tools_Module is asked to produce the Tool_Result for any Document_Tool, including the legacy `replace_range` and `delete_range` variants, THE Editor_Tools_Module SHALL obtain that Tool_Result solely from the Tool_Runtime executing the Tool_Implementation loaded from the Tool_File.
2. THE Editor_Tools_Module SHALL define no function that computes the transformed Document_Buffer text or the Tool_Result of any named Document_Tool, including `get_document`, `goto_line`, `insert_text`, `replace_line`, `replace_span`, `delete_lines`, `delete_span`, and the legacy `replace_range` and `delete_range` variants.
3. WHEN the Editor_Tools_Module receives an invocation naming a Document_Tool, THE Editor_Tools_Module SHALL route that invocation to the Tool_Runtime.
4. THE Editor_Tools_Module SHALL retain the Side_Effect_Application helpers that write a Tool_Result's `new_text` field into the Document_Buffer.
5. THE Editor_Tools_Module SHALL retain the Side_Effect_Application helpers that move the caret or selection in response to a Tool_Result.
6. THE Editor_Tools_Module SHALL retain every Text_Geometry_Utility that its Side_Effect_Application helpers call directly or transitively.
7. WHILE a retained Side_Effect_Application helper calls a Text_Geometry_Utility directly or transitively, THE Editor_Tools_Module SHALL retain that Text_Geometry_Utility.

### Requirement 3: Renamed Tool Accessors

**User Story:** As a developer, I want clearly named accessors for tool schemas and tool functions, so that the schema source and the implementation source are accessed through parallel, self-describing APIs.

#### Acceptance Criteria

1. THE LLIMEdit SHALL provide a Schema_Accessor named `getAgentToolSchemas` that returns the Tool_Schema array of the loaded Tool_File, and that returns an empty array when no Tool_File is loaded.
2. THE LLIMEdit SHALL provide a Function_Accessor named `getAgentToolFunctions` that returns one callable function for each Document_Tool defined by the loaded Tool_Implementation, and that returns no callable functions when no Tool_Implementation is loaded.
3. WHEN the Agent_Loop builds a model request, THE Agent_Loop SHALL obtain the tool definitions exclusively from `getAgentToolSchemas`.
4. WHEN the Tool_Runtime executes a Document_Tool, THE Tool_Runtime SHALL obtain the executable function for that tool's name from the Function_Accessor.
5. IF the Function_Accessor provides no executable function for the Document_Tool name the Tool_Runtime is invoking, THEN THE Tool_Runtime SHALL return a Tool_Result that reports the tool as having no available implementation and sets `changed` to false.
6. WHERE a call site previously referenced the prior `getAgentTools` accessor, THE LLIMEdit SHALL route that call site to `getAgentToolSchemas`.
7. IF a call site references the removed `getAgentTools` accessor after the rename, THEN THE LLIMEdit SHALL fail with an error indicating the accessor is undefined rather than silently returning default tool definitions.

### Requirement 4: Two-Pane Display of the Default Tools

**User Story:** As a user, I want the implementation functions on the left and the matching schema on the right when I open the default tools file, so that I can see each tool's code alongside its declaration.

#### Acceptance Criteria

1. WHEN the user opens the Default_Tools_File in the Tool_Editor, THE Tool_Editor SHALL display the Tool_Implementation from the implementation field in the Implementation_Pane.
2. WHEN the user opens the Default_Tools_File in the Tool_Editor, THE Tool_Editor SHALL display the Tool_Schema from the schema field in the Schema_Pane.
3. THE Tool_Editor SHALL position the Implementation_Pane to the left of the Schema_Pane.
4. WHEN the user opens the Default_Tools_File or the Schema_Pane content changes, THE Tool_Editor SHALL update the displayed tool status to reflect the current Schema_Pane content.
5. WHEN the Schema_Pane holds valid JSON containing N entries that are each a semantically valid function tool definition with a tool name unique among those entries, where N is 1 or greater, THE Tool_Editor SHALL display a status that reports a count of N tools.
6. WHEN the Schema_Pane is empty or holds valid JSON containing no tool definition entries, THE Tool_Editor SHALL display a status that reports a count of 0 tools.
7. IF the Schema_Pane holds text that is not valid JSON, THEN THE Tool_Editor SHALL display, instead of a tool count, an error status indicating that the Schema_Pane content is not valid JSON.
8. IF the Schema_Pane holds valid JSON in which any entry is not a semantically valid function tool definition or shares a tool name with another entry, THEN THE Tool_Editor SHALL display, instead of a tool count, an error status identifying the invalid tool definitions, including any duplicate tool names.

### Requirement 5: Editing and Testing Tools Against the Model

**User Story:** As a user, I want to edit the implementation and schema of the default tools and then run them with the LLM, so that I can customize tool behavior and verify it interactively.

#### Acceptance Criteria

1. WHILE a Tool_File is loaded in the Tool_Editor, THE Tool_Editor SHALL accept user edits to the Implementation_Pane contents.
2. WHILE a Tool_File is loaded in the Tool_Editor, THE Tool_Editor SHALL accept user edits to the Schema_Pane contents.
3. WHEN the user saves the loaded Tool_File, THE Tool_Editor SHALL write the current Implementation_Pane contents to the implementation field and the current Schema_Pane contents to the schema field of the Tool_File.
4. WHEN the user changes the Implementation_Pane or Schema_Pane contents, THE Tool_Editor SHALL update the in-editor tool state used for Document_Tool execution and model requests to match the changed contents before the next Document_Tool execution or model request, without requiring an explicit save.
5. WHEN the Agent_Loop executes a Document_Tool after the user has edited the Implementation_Pane without saving, THE Tool_Runtime SHALL run the Tool_Implementation built from the current Implementation_Pane contents.
6. WHEN the Agent_Loop builds a request to the model, THE Agent_Loop SHALL send the tool definitions from the current Schema_Pane contents, including unsaved edits, to the model.
7. WHEN the model returns a tool call for a Document_Tool, THE Agent_Loop SHALL apply the resulting Tool_Result to the Document_Buffer.
8. IF the current Schema_Pane contents are not valid JSON tool definitions, THEN THE Tool_Editor SHALL retain the most recently valid tool definitions in the in-editor tool state used for Document_Tool execution and model requests.

### Requirement 6: Agent Loop Behavior Preserved

**User Story:** As a user, I want the agent to keep editing my document exactly as before, so that moving tool code into the Tool_File does not change how the assistant behaves.

#### Acceptance Criteria

1. WHEN the model returns one or more tool calls for Document_Tools, THE Agent_Loop SHALL execute each tool call through the Tool_Runtime in the order returned and obtain a Tool_Result for each.
2. WHEN a Document_Tool execution returns a Tool_Result whose `ok` flag is true and whose `changed` flag is true, THE Agent_Loop SHALL set the Document_Buffer content to the Tool_Result's `new_text` value.
3. WHEN a Document_Tool execution returns a Tool_Result whose `changed` flag is not true, THE Agent_Loop SHALL leave the Document_Buffer content unchanged.
4. IF the model requests a tool name that is absent from the loaded Tool_File, THEN THE Agent_Loop SHALL produce a Tool_Result that reports the tool name as unknown, sets `changed` to false, and leaves the Document_Buffer content unchanged.
5. IF a tool call carries arguments that are not valid JSON, THEN THE Agent_Loop SHALL produce a Tool_Result that reports invalid tool arguments, sets `changed` to false, and leaves the Document_Buffer content unchanged.
6. WHEN the Agent_Loop displays the document preview that accompanies a tool call, THE Agent_Loop SHALL show 1-based line-numbered content reflecting the Document_Buffer state at the moment the tool call is issued.

### Requirement 7: Editor Side Effects Preserved

**User Story:** As a user, I want the caret moves and buffer updates that follow each tool call to keep working, so that the document reflects tool results and the cursor lands where I expect.

#### Acceptance Criteria

1. WHEN a mutating Document_Tool Tool_Result whose `ok` flag is true and that carries a string `new_text` field is applied, THE Side_Effect_Application SHALL set the Document_Buffer content to exactly that `new_text` value.
2. WHEN a `goto_line` Tool_Result whose `ok` flag is true is applied, THE Side_Effect_Application SHALL place the caret at column 1 (the first character) of the 1-based line identified in the Tool_Result, with no text selected.
3. WHEN a `replace_span` or `delete_span` Tool_Result whose `ok` flag is true is applied, THE Side_Effect_Application SHALL select the text on the 1-based identified line from the 1-based inclusive `start_column` through the 1-based inclusive `end_column`, extending the selection to the end of the line when `end_column` exceeds the line length.
4. WHEN a mutating Tool_Result is applied during an agent edit, THE Side_Effect_Application SHALL record the Document_Buffer change on the agent undo group such that a single undo operation restores the Document_Buffer to its exact content immediately before the Tool_Result was applied.
5. IF a Tool_Result whose `ok` flag is not true is applied, THEN THE Side_Effect_Application SHALL leave the Document_Buffer content, the caret position, and the selection unchanged.
6. IF a mutating Document_Tool Tool_Result whose `ok` flag is true is applied but its `new_text` field is absent or not a string, THEN THE Side_Effect_Application SHALL leave the Document_Buffer content unchanged.

### Requirement 8: Tool File Round-Trip and Result Equivalence

**User Story:** As a developer, I want guarantees that the extracted tools behave identically to the originals and that the Tool_File survives a save/load cycle, so that the refactor is provably behavior-preserving.

#### Acceptance Criteria

1. FOR ALL Tool_File contents produced by the Tool_Editor, parsing the serialized Tool_File SHALL yield an implementation string character-for-character identical to the in-editor Tool_Implementation and a schema deep-structurally equal to the in-editor Tool_Schema, with tool definitions in the same order and the same fields and values (round-trip property).
2. FOR ALL Document_Tool invocations whose arguments conform to the tool's Tool_Schema over an arbitrary Document_Buffer, the Tool_Result computed by the extracted Tool_Implementation SHALL be deep-equal to the Tool_Result that the pre-extraction Editor_Tools_Module computed for the same buffer and arguments, where deep-equal means equality of the `ok` flag, the `changed` flag, the `new_text` field, and every tool-specific metadata field (model-based equivalence property).
3. FOR ALL mutating Document_Tool Tool_Results whose `changed` flag is true and that carry a `new_text` field, applying the Tool_Result to the Document_Buffer SHALL make the resulting Document_Buffer content character-for-character equal to the `new_text` field (invariant property).
4. FOR ALL Document_Buffer contents, executing `get_document` SHALL leave the Document_Buffer content unchanged and return a Tool_Result whose `changed` flag is false (read-only invariant property).
5. FOR ALL Document_Buffer contents and all `goto_line` arguments carrying an integer line value, the line number reported in the `goto_line` Tool_Result SHALL be within the inclusive range 1 to the maximum of 1 and the Document_Buffer line count (bounds property).

### Requirement 9: Test Fixtures and Chat-Edit Path Updated

**User Story:** As a developer, I want the existing test suite and the apply-from-chat editing path to keep passing after extraction, so that the refactor lands without regressions.

#### Acceptance Criteria

1. WHEN the default tools test fixture is loaded, THE test fixture SHALL supply to the Tool_Editor one Tool_Implementation defining the Document_Tool logic and one Tool_Schema containing the seven function tool definitions for `get_document`, `goto_line`, `insert_text`, `replace_line`, `replace_span`, `delete_lines`, and `delete_span`.
2. WHEN assistant chat text contains tool-shaped JSON edits and the user applies them, THE LLIMEdit SHALL execute those edits through the Tool_Runtime using the loaded Tool_Implementation and SHALL set the Document_Buffer content to the resulting `new_text` when the Tool_Result's `changed` flag is true.
3. IF an applied chat edit names a tool absent from the loaded Tool_File or carries arguments that are not valid JSON, THEN THE LLIMEdit SHALL leave the Document_Buffer content unchanged and indicate the failure.
4. WHEN the LLIMEdit test suite runs after extraction, THE LLIMEdit test suite SHALL complete with zero failing test cases.
5. WHERE a test previously asserted that the Default_Tools_File implementation forwards to `editorTools.executeTool`, THE LLIMEdit SHALL update that test to assert the extracted Tool_Implementation defines the Document_Tool logic directly and contains no forwarding call to `editorTools.executeTool`.

### Requirement 10: Tool Runtime Error Handling

**User Story:** As a user editing tool code, I want clear failures when a tool has no implementation or throws, so that I can diagnose and fix my custom tools.

#### Acceptance Criteria

1. IF the loaded Tool_File's implementation field is absent, null, or contains only whitespace characters, THEN THE Tool_Runtime SHALL return a Tool_Result that sets `ok` to false, reports that the tool has no implementation, sets `changed` to false, and leaves the Document_Buffer content unchanged.
2. IF the Tool_Implementation throws while executing a Document_Tool, THEN THE Tool_Runtime SHALL return a Tool_Result that sets `ok` to false, reports a tool execution error, sets `changed` to false, and leaves the Document_Buffer content unchanged.
3. IF a Document_Tool receives a line argument less than 1 or greater than the Document_Buffer line count, THEN THE Tool_Implementation SHALL clamp the line to the range 1 to the maximum of 1 and the Document_Buffer line count before computing the Tool_Result.
4. IF executing a Document_Tool throws after its line argument has been clamped, THEN THE Tool_Runtime SHALL return a Tool_Result that sets `ok` to false, reports a tool execution error, sets `changed` to false, and leaves the Document_Buffer content unchanged.
