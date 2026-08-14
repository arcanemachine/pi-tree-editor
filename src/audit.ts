import type { SurgeryPlan } from "./surgery/types.js";

export const SURGERY_AUDIT_TYPE = "pi-tree-editor.surgery";
export const SURGERY_RECOVERY_TYPE = "pi-tree-editor.recovery";
export const SURGERY_NOTE_TYPE = "pi-tree-editor.note";

export function auditPreview(plan: SurgeryPlan): string[] {
  const lines = [
    `Reconstruct ${plan.sourcePath.length - plan.removedEntryIds.length} active-path entries`,
    `Remove ${plan.removedEntryIds.length} source entr${plan.removedEntryIds.length === 1 ? "y" : "ies"}`,
    `Change ${plan.editedEntryIds.length} text entr${plan.editedEntryIds.length === 1 ? "y" : "ies"}`,
    `Change ${plan.editedReasoningEntryIds.length} reasoning entr${plan.editedReasoningEntryIds.length === 1 ? "y" : "ies"}`,
    `Remove ${plan.removedReasoningCount} reasoning block${plan.removedReasoningCount === 1 ? "" : "s"}`,
    `Insert ${plan.insertedNoteIds.length} context note${plan.insertedNoteIds.length === 1 ? "" : "s"}`,
    "The original branch remains unchanged.",
  ];
  return plan.warnings.length > 0
    ? [...lines, ...plan.warnings.map((warning) => `Warning: ${warning}`)]
    : lines;
}
