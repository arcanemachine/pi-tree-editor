# Changelog

## Unreleased

- Pause native tree search while tree-editor mode is active, preserving the current query until editor mode is exited.
- Keep native tree navigation, filtering, copying, folding, and label controls available while search is paused.

## 0.1.4

- Clarify that `Tab` exits tree-editor mode when no changes are staged.

## 0.1.3

- Return to a refreshed `/tree` view after saving with `Ctrl+S`, while saves from the exit confirmation return to the conversation.
- Show refreshed conversation content after leaving the post-save tree.

## 0.1.2

- Document the parent Pi extensions project.

## 0.1.1

- Reorganize and simplify the README around product purpose, installation, usage, editing boundaries, and safety.
- Make npm the primary installation path now that the package is published.
- Confirm Pi package and gallery metadata for npm distribution.

## 0.1.0

- Add safe copy-on-write conversation editing through Pi's native tree selector.
- Add inline text editing, logical-unit removal, context-note insertion, undo, review, and explicit save/discard flows.
- Preserve original branches, tool exchanges, compaction references, provider metadata, and opaque content.
- Add selector-local help, review, exit confirmation, and multi-block selection without replacing the native tree.
- Keep native long-message navigation and horizontal viewport rendering unchanged.
- Add role-specific staged user, assistant, and context rows with append-only replay and native viewport geometry.
- Allow safe per-block assistant text edits beside signed blocks and provide an explicit unsigned-copy path for directly signed text or reasoning, with provider-continuity warnings.
- Order reasoning choices before answer choices and add selector-local partial assistant block removal with signed-removal confirmations.
- Make nested edit, delete, and insert menus return one level on Escape or No while top-level chooser cancellation still returns to the tree.
