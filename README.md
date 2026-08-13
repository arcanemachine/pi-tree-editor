# pi-tree-editor

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-tree-editor/main/logo.jpg" alt="pi-tree-editor logo" width="250" />
</p>

Safely edit Pi conversation history from the native `/tree` selector. Stage edits, review a compact confirmation menu, and apply them as a new conversation branch without changing files or other external state.

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
s save · e edit · d remove · a after · Shift+A before · u undo
Escape exits directly when unchanged, or opens Cancel / Yes / No when staged
```

- `e` edits a supported text block inline.
- `d` stages or unstages removal of a logical unit.
- `a` inserts a visible context note after the selected unit.
- `Shift+A` inserts a visible context note before the selected unit.
- `u` undoes the latest staged operation.
- `s` opens a save menu showing the staged item count. `Yes` applies (default); `Cancel` keeps editing.
- `Escape` cancels inline input. With no staged changes it exits `/tree`; with staged changes it opens `Cancel / Yes / No` (default `Cancel`): `Cancel` keeps editing, `Yes` applies, and `No` discards and exits.

Command keys are shown lowercase; uppercase aliases remain accepted. Confirmation menus are selector-local: use Up/Down and Enter, or Escape for Cancel. Planning or apply failures leave staged work available for correction or retry.

### Multiline input

Editing a prefill containing CR or LF uses Pi's native multiline `Editor`, so physical terminal rows remain stable and bounded. Plain `Enter` stages the text exactly; `Escape` cancels. Use `Shift+Enter` or `Ctrl+J` for a newline. Unchanged prefills preserve their exact whitespace and newline form, including CRLF and CR-only text; changed text uses the current editor value.

### What can be edited

`e` edits supported text blocks in user, assistant, custom-message, compaction, and branch-summary entries. Tool results and assistant tool-call exchanges are protected from internal edits. `d` operates on logical units, so a tool call and all of its results are removed together. Unsupported structural entries cannot be edited; removal plans that violate structural boundaries fail validation.

## Safety model

Edits use append-only, same-session, copy-on-write reconstruction:

- Existing entries and the original branch are never modified or deleted.
- Only the affected suffix is reconstructed; the unchanged prefix is retained.
- The reconstructed suffix receives fresh entry IDs on a new alternate branch; the unchanged prefix is retained.
- Reasoning/thinking blocks, images, provider metadata, opaque blocks, and compaction references are preserved and validated.
- A non-context audit entry records the reconstruction.
- Failures return to the original branch; partial alternate entries remain unreachable.
- Persistence is incremental, so an in-progress reconstruction is not crash-atomic.

This extension does not restore files or Git state, edit tool arguments/results or reasoning blocks, rewrite JSONL, or call an LLM to summarize content.

## Graceful fallback

If native capabilities are missing or a hook cannot be installed, pi-tree-editor warns once and leaves Pi's native `/tree` behavior available unchanged. Runtime capability failures disable the editor augmentation while continuing to call native `/tree`. Run:

```text
/tree-editor status
```

to inspect hook availability and compatibility details.

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
