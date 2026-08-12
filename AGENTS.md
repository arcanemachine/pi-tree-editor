# Agent Instructions

## Product boundary

`@arcanemachine/pi-tree-editor` safely edits Pi conversation history through the native `/tree` selector. It preserves the original branch and conversation context only. It must not restore files, Git state, tool side effects, or other external state.

## Safety contracts

- Keep surgery append-only and copy-on-write.
- Never rewrite session JSONL or mutate/delete existing entries.
- Preserve parent links, tool-call/result grouping, compaction references, provider metadata, and opaque content.
- Keep runtime Pi reflection isolated from the pure planner.
- Fail closed when required Pi capabilities are unavailable and leave native `/tree` functional.
- Do not add an LLM-callable tool.

## Package style

Match maintained sibling packages in the Pi superproject:

- source-loaded TypeScript under `src/`;
- `pi.extensions` package metadata and a `pi.image` logo URL;
- optional Pi peer dependencies;
- no unnecessary runtime dependencies;
- Vitest, TypeScript, and Prettier;
- independently installable behavior;
- README with logo, installation, usage, semantics, development, and license sections.

## Validation

Run before completion:

```bash
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

New user-facing UI/session behavior also requires live verification in an isolated Pi session before it is called complete.

## Source control

Commit coherent completed work using Conventional Commits. Stage only package files. Commit the child repository before updating the Pi superproject pointer. Do not push or publish without explicit authorization.
