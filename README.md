# pi-tree-editor

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-tree-editor/main/logo.jpg" alt="pi-tree-editor logo" width="250" />
</p>

## Intro

`pi-tree-editor` is a [Pi](https://pi.dev) extension for editing conversation history from Pi's native `/tree` selector.

Stage changes, review them, and apply them to a new conversation branch. The original branch stays available and unchanged.

> Like this extension? See [my other Pi extensions](https://github.com/arcanemachine/pi-projects).

## Why?

Conversation context sometimes needs correction. You may want to:

- fix an earlier user or assistant message;
- remove an answer, reasoning block, message, or tool exchange;
- add a missing user message, assistant message, or context note;
- keep useful context while removing something misleading.

`pi-tree-editor` does this inside the familiar tree interface instead of replacing it with a separate transcript editor.

> This extension changes conversation context only. It does not restore files, Git state, processes, or other effects of earlier tool calls.

## Installation

Install from npm:

```bash
pi install npm:@arcanemachine/pi-tree-editor
```

Try it for one run without installing:

```bash
pi -e npm:@arcanemachine/pi-tree-editor
```

You can also install from GitHub or a local clone:

```bash
pi install git:github.com/arcanemachine/pi-tree-editor
pi install /path/to/pi-tree-editor
```

For development, load the source entry point directly:

```bash
pi -e /path/to/pi-tree-editor/src/index.ts
```

## Usage

1. Open `/tree`.
2. Press `Tab` to enter tree-editor mode.
3. Select a tree item and stage your changes.
4. Press `Ctrl+S` to review and apply them.

| Key       | Action                                              |
| --------- | --------------------------------------------------- |
| `e`       | Edit the selected item or content block             |
| `d`       | Remove the selected block, message, or logical unit |
| `a`       | Insert after the selected item                      |
| `Shift+A` | Insert before the selected item                     |
| `u`       | Unstage changes for the selected item               |
| `r`       | Show or hide reasoning previews in editor mode      |
| `Ctrl+S`  | Review and save staged changes                      |
| `Escape`  | Go back one level or leave the current flow         |

Uppercase aliases also work for `e`, `d`, `u`, and `r`; `Shift+A` is its own action. Plain `s` remains native tree search input; `Ctrl+S` is the only save shortcut.

### Edit and remove

Press `e` to edit a supported block. For assistant messages, the chooser lists reasoning blocks first and answer blocks second. Distinct blocks in the same message can be edited independently.

Press `d` on a compound assistant message to choose a reasoning block, an answer block, or the entire message. Tool calls and their results remain one indivisible unit.

Reasoning previews are hidden by default in both normal and editor modes. Press `r` in editor mode to show or hide them for the current visit. Staged reasoning markers remain visible when previews are hidden.

### Insert

Press `a` or `Shift+A`, then choose:

1. User
2. Assistant
3. Context note

The default is User. The staged message appears as a selectable virtual row before anything is written to the session. Use `e` to revise it or `u` to unstage it.

Synthetic assistant messages use the active model identity and contain plain answer text only. If Pi cannot provide the required model identity, assistant insertion is unavailable.

### Stage and save

Changes remain in memory until you save. Re-editing the same block replaces its earlier staged value, while compatible changes to different blocks can coexist. Whole-unit removal supersedes changes inside that unit.

Press `Ctrl+S` to open the save menu. `Yes` is the default; `Cancel` returns to the tree with the staged changes intact.

Escape from a nested editor or confirmation returns to the previous menu. Escape from a top-level chooser returns to the tree. Leaving `/tree` with staged changes offers three choices: save and return to the conversation, keep editing, or abandon the staged changes.

Multiline text uses Pi's native editor. Use `Shift+Enter` or `Ctrl+J` for a newline. Unchanged text preserves its original whitespace and newline form.

## What can be edited

Supported text includes:

- user messages;
- ordinary assistant answer blocks;
- eligible assistant reasoning blocks;
- visible custom messages and context notes;
- compaction summaries;
- branch summaries.

A compound assistant message can keep, edit, or remove individual answer and reasoning blocks as long as at least one content block remains. You can remove the entire message instead when no content should remain.

Images and untouched content blocks keep their original order and data. Tool arguments, tool results, redacted reasoning, malformed content, and unknown provider blocks cannot be edited internally. A complete tool exchange can still be removed as one logical unit.

## Provider-signed content

Some providers sign answer or reasoning blocks so they can verify them in later requests. Changing signed content while keeping its signature can make the next provider request fail.

An unsigned answer block remains editable when a different recognized block is signed. Reasoning editing is stricter: the message must be recognized, tool-free, non-redacted, and free of other signed answer or reasoning blocks.

Selecting a directly signed answer or reasoning block opens a safe-default confirmation. If you continue, the extension creates an unsigned copy by removing only the selected block's signature. Removing a signed block uses the same explicit warning. Other blocks and signatures remain unchanged.

An unsigned copy may break provider continuity. The original branch remains available if the edited branch cannot continue. Signed tool calls, redacted reasoning, malformed signatures, and unknown provider content remain protected without an override.

## How changes are applied

All changes use append-only, same-session, copy-on-write reconstruction:

- Existing entries and session JSONL are never rewritten or deleted.
- Staged rows do not enter the session before confirmation.
- The unchanged prefix is retained.
- The affected suffix is copied to a new branch with fresh entry IDs.
- Parent links, tool exchanges, compaction references, images, opaque content, and untouched signatures are preserved and validated.
- A content-free audit entry records IDs, operation types, lengths, counts, and warnings—not message text or signature values.
- The original branch remains unchanged and accessible.

If applying a change fails, the extension returns to the original branch when possible. Persistence uses Pi's normal incremental append operations, so reconstruction is not crash-atomic.

## Compatibility and fallback

Tested with Pi 0.84.1. Compatibility is based on the native capabilities the extension uses rather than a strict Pi version allowlist.

If those capabilities are unavailable or a runtime hook fails, the extension warns once and leaves native `/tree` available without partial augmentation.

## Development

Node.js 22.19.0 or later is required for package development.

```bash
npm install --ignore-scripts --workspaces=false
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

## License

MIT
