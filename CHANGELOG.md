# Changelog

## 0.1.0

- Add safe copy-on-write conversation editing through Pi's native tree selector.
- Add inline text editing, logical-unit removal, context-note insertion, undo, review, and explicit save/discard flows.
- Preserve original branches, tool exchanges, compaction references, provider metadata, and opaque content.
- Add selector-local help, review, exit confirmation, and multi-block selection without replacing the native tree.
- Keep native long-message navigation and horizontal viewport rendering unchanged.
- Add role-specific staged user, assistant, and context rows with append-only replay and native viewport geometry.
- Allow safe per-block assistant text edits beside signed blocks and provide an explicit unsigned-copy path for directly signed text or reasoning, with provider-continuity warnings.
- Order reasoning choices before answer choices and add selector-local partial assistant block removal with signed-removal confirmations.
