# pi-tree-editor

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-tree-editor/main/logo.jpg" alt="pi-tree-editor logo" width="250" />
</p>

Safely edit Pi conversation history through the native `/tree` selector.

> Conversation surgery preserves the original session branch and changes conversation context only. It does not restore files, Git state, tool side effects, or other external state.

## Compatibility

- Tested against Pi 0.84.1
- Future Pi versions are accepted when the required native capabilities match; incompatible hooks fail closed and leave native `/tree` available
- Node.js 22.19.0 or later for package development

## Installation

### From GitHub

```bash
pi install git:github.com/arcanemachine/pi-tree-editor
```

### From npm

```bash
pi install npm:@arcanemachine/pi-tree-editor
```

### From a local clone

```bash
pi install /path/to/pi-tree-editor
```

For local development, load the source entrypoint directly:

```bash
pi -e /path/to/pi-tree-editor/src/index.ts
```

## Native `/tree` editor

Open Pi's native tree with `/tree`, then press `Tab` to enter edit mode. The selector keeps its native navigation, search, folding, filtering, labels, and copy behavior.

Edit mode shows its key help persistently:

```text
S review & save · E edit · D remove · A after · Shift+A before · U undo
Escape confirms exit · Tab stays in edit mode until saved or discarded
```

### Editing controls

- `E` — edit a supported text block inline.
- `D` — stage or unstage removal of a logical unit.
- `A` — insert a visible context note after the selected unit.
- `Shift+A` — insert a visible context note before the selected unit.
- `U` — undo the latest staged operation.
- `S` — open the in-tree review screen.
- `Escape` — cancel inline input, keep editing from a review/confirmation screen, or open the unsaved-exit confirmation.

Inline input uses `Enter` to stage a change and `Escape` to cancel the input. The review screen uses `A` to apply and `B` or `Escape` to return to editing. The unsaved-exit screen uses `D` to discard changes and exit; `K` or `Escape` keeps editing. No key silently applies or discards staged work.

Use `/tree-editor status` to inspect hook availability and actionable compatibility failures.

## Safety and semantics

All edits use append-only, same-session copy-on-write reconstruction:

- Existing entries and the original branch are never modified or deleted.
- The corrected conversation becomes a new alternate branch with fresh entry IDs.
- Assistant tool calls and all corresponding results are indivisible.
- Provider reasoning/thinking blocks, images, and opaque blocks are preserved.
- Compaction references are validated before applying changes.
- A non-context audit entry records the reconstruction.
- Caught failures return to the original branch and leave partial alternate entries unreachable.
- Persistence is incremental and therefore not crash-atomic during an in-progress reconstruction.

V1 does not edit tool arguments/results or reasoning blocks, rewrite JSONL, rewind filesystem state, or generate summaries with an LLM.

## Development

```bash
npm install --ignore-scripts --workspaces=false
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

`npm run format:check` verifies formatting without changing files. Use `npm run format` only for deliberate package-wide normalization. Automated tests use in-memory or isolated session fixtures.

## License

MIT
