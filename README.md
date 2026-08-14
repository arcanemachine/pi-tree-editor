# pi-tree-editor

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-tree-editor/main/logo.jpg" alt="pi-tree-editor logo" width="250" />
</p>

Safely edit Pi conversation history from the native `/tree` selector. Stage edits, review them in a compact save menu, and apply them as a new conversation branch without changing files or other external state.

## Installation and compatibility

Install from GitHub:

```bash
pi install git:github.com/arcanemachine/pi-tree-editor
```

Or install a local clone:

```bash
pi install /path/to/pi-tree-editor
```

For development, load the source entrypoint directly:

```bash
pi -e /path/to/pi-tree-editor/src/index.ts
```

Tested against Pi 0.84.1. Compatible future Pi versions must provide the required native `/tree` capabilities. Node.js 22.19.0 or later is required for package development.

## Use `/tree`

Open `/tree`, then press `Tab` to enter tree-editor mode. Native tree navigation, search, filtering, folding, labels, and copy behavior remain available.

```text
ctrl+s save · e edit · d remove · a insert · Shift+A insert before · u unstage
```

- `a` / `Shift+A` first opens a selector-local role menu in this exact order: `User` (default), `Assistant`, `Context note`. Escape returns to the tree without staging. After choosing a role, enter the text in selector-local input.
- User and assistant inserts become actual staged virtual tree rows immediately before or after the selected logical unit. Rows participate in native filtering, selection, vertical viewport, horizontal viewport, and geometry. `e` edits a selected staged row and `u` unstages it. Source-only actions on a staged row are refused clearly.
- Assistant inserts are available only when the active model exposes its `api`, `provider`, and `id`; inserted assistant messages are plain synthetic messages with zero usage and a stopped completion, with no reasoning, signatures, tools, or stale metadata.
- `e` edits a supported source text block inline. `d` stages or unstages removal of a logical unit. Tool calls and all corresponding results remain indivisible.
- `u` unstages the selected source action or staged inserted row. Staged actions use latest-wins semantics per logical unit.
- `ctrl+s` is the sole save shortcut in edit mode. It opens a save menu showing the staged item count; `Yes` applies (default), and `Cancel` keeps editing. Plain `s` remains native tree search behavior. Ctrl+Enter is not a save alias.
- Escape cancels an active inline field or numbered chooser first. With no staged changes it exits `/tree`; with staged changes it opens `Save changes to N staged item(s)?` (defaulting to the first option):
  - `Yes. Return to conversation` applies the staged changes.
  - `No. Return to tree and continue making changes` keeps editing with staged changes.
  - `No. Return to conversation and abandon staged changes` discards staged changes and exits.

Inserted text and source edits support multiline input through Pi's native `Editor`. Plain Enter stages the text exactly; Escape cancels. Use Shift+Enter or Ctrl+J for a newline. Unchanged prefills preserve their exact whitespace and newline form, including CRLF and CR-only text.

## What can be edited

`e` edits supported text blocks in user, assistant, custom-message, compaction, and branch-summary entries. Multiple text blocks are chosen individually. User images and untouched opaque/provider content remain byte-for-byte unchanged. Unsigned assistant reasoning blocks are eligible; provider-signed, redacted, tool-associated, and unsupported assistant content is read-only. Blank reasoning removes only that block when another assistant content block remains.

## Safety model

Edits use append-only, same-session, copy-on-write reconstruction:

- Existing entries, the original branch, the session tree, and JSONL are never modified or deleted.
- Display-only staged rows are fresh in-memory nodes; no staged insert is appended before confirmation.
- Only the affected suffix is reconstructed; the unchanged prefix is retained.
- The reconstructed suffix receives fresh entry IDs on a new alternate branch.
- Unedited reasoning/thinking blocks, images, opaque blocks, provider/model identity, and compaction references are preserved and validated.
- A non-context audit entry records the reconstruction, including inserted role and text length rather than duplicate content.
- Failures return to the original branch; partial alternate entries remain unreachable.
- Persistence is incremental, so an in-progress reconstruction is not crash-atomic.

This extension does not restore files or Git state, edit tool arguments/results, rewrite JSONL, or call an LLM to summarize content.

## Graceful fallback

If native capabilities are missing or a hook cannot be installed, pi-tree-editor warns once with an actionable reason and leaves Pi's native `/tree` behavior available unchanged. Unsupported assistant insertion identity and unsafe virtual-row capabilities fail closed without mutating the session.

## Development

```bash
npm install --ignore-scripts --workspaces=false
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

Tests use in-memory or isolated session fixtures.

## License

MIT
