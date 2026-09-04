import { useEffect } from "react";
import { installDocumentInteractionGuards } from "./documentInteractionGuards";
import { installDocumentTextEncodingFix } from "./documentTextEncodingFix";

/**
 * Mounts the DOM-global document guards once at app root: the interaction guards
 * (anti context-menu, selection suppression, product press feedback) and the
 * mojibake text-encoding fix. Both remain intrinsically DOM-global; the install
 * functions are idempotent via module-level flags, so this hook only owns their
 * lifecycle from React instead of running them imperatively in main.tsx.
 */
export function useGlobalDocumentGuards() {
  useEffect(() => {
    installDocumentInteractionGuards();
    installDocumentTextEncodingFix();
  }, []);
}
