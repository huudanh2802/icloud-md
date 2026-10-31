/**
 * Splices a brand-new file-attachment embed onto the end of a note document.
 *
 * Generalizes `integration/plantTable.ts`'s `buildTableEmbedInsertion`/
 * `isolatePlaceholderRun` (which plants a *table* embed for the live test
 * suite) to any UTI, since the wiring is identical either way: a U+FFFC
 * placeholder in its own length-1 attribute run carrying `attachmentInfo`.
 * That table-planting code is verified against real captured Apple traffic
 * (entry 48 of a 2026-07-16 HAR capture) - see this file's header there for
 * the three-part argument that it isn't just testing our own codec against
 * itself. This module reuses the same `applyTextEdit`/attribute-run-split
 * primitives `push` already uses for every other note edit; only the
 * "give the new U+FFFC its own attachmentInfo run" step is new, and it's the
 * one piece of this feature verified live rather than against a capture -
 * see dev notes, 2026-09-16.
 */
import { clone, create, isFieldSet } from "@bufbuild/protobuf";
import { AttachmentInfoSchema, AttributeRunSchema, ParagraphStyleSchema } from "./gen/topotext_pb.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import {
  applyTextEdit,
  encodeNoteDocument,
  parseNoteDocument,
  validateDocumentInvariants,
  type NoteDocument,
} from "./noteDocument.js";

/** Apple's paragraph-style enum for Body - the plain-prose style every
 * captured embed (table or otherwise) sits in. */
const BODY_PARAGRAPH_STYLE = 3;
const PS_STYLE_FIELD = ParagraphStyleSchema.fields.find((f) => f.localName === "style")!;

export interface AttachmentEmbedInsertion {
  /** The note document with the embed spliced in, uncompressed. */
  raw: Uint8Array;
  oldText: string;
  newText: string;
  placeholderIndex: number;
}

export interface AttachmentPlaceholder {
  /** This attachment's U+FFFC character offset in `newText`. */
  placeholderIndex: number;
  attachmentId: string;
  typeUti: string;
}

/**
 * The general form `push` uses: `newText` is the fully reconciled target
 * body (already containing a U+FFFC at each new attachment's position,
 * mixed in with whatever else changed in the same edit), diffed against the
 * note's current document via the same `applyTextEdit` every other push
 * edit goes through. Each `placeholders` entry then gets its own run
 * isolated and stamped with its attachment reference - `newText.length`
 * unchanged by that step, so computing each placeholder's offset in
 * `newText` up front (before this call) stays valid throughout.
 */
export function spliceAttachmentEmbeds(
  originalRaw: Uint8Array,
  newText: string,
  placeholders: readonly AttachmentPlaceholder[],
  replicaId: Uint8Array,
): Uint8Array {
  const doc = parseNoteDocument(originalRaw);
  const changed = applyTextEdit(doc, newText, { replicaId });
  if (!changed && placeholders.length > 0) {
    throw new Error("spliceAttachmentEmbeds: applyTextEdit reported no change despite new attachments");
  }
  isolateAttachmentPlaceholders(doc, placeholders);
  validateDocumentInvariants(doc);
  return encodeNoteDocument(doc);
}

/**
 * The create-path counterpart: `doc` already has its final text (from
 * `buildInitialNoteDocument`, whose text already includes each
 * placeholder's U+FFFC - there's no prior remote document to diff against
 * for a brand-new note), so this just isolates each placeholder's run
 * in place rather than deriving it from an `applyTextEdit` diff.
 */
export function isolateAttachmentPlaceholders(doc: NoteDocument, placeholders: readonly AttachmentPlaceholder[]): void {
  for (const placeholder of placeholders) {
    isolateAttachmentPlaceholderRun(doc, placeholder.placeholderIndex, placeholder.attachmentId, placeholder.typeUti);
  }
}

/**
 * Appends one new file-attachment embed to the end of `originalRaw`'s
 * visible text, in its own paragraph after a blank line - the same
 * placement `buildTableEmbedInsertion` uses, matching what Apple's own
 * client produced when a user inserted an embed at the end of a note.
 */
export function buildAttachmentEmbedInsertion(
  originalRaw: Uint8Array,
  attachmentId: string,
  typeUti: string,
  replicaId: Uint8Array,
): AttachmentEmbedInsertion {
  const doc = parseNoteDocument(originalRaw);
  const oldText = doc.text;
  if (oldText === "") {
    throw new Error("buildAttachmentEmbedInsertion: refusing to attach to an empty note");
  }

  const separator = oldText.endsWith("\n") ? "\n" : "\n\n";
  const placeholderIndex = oldText.length + separator.length;
  const newText = `${oldText}${separator}${OBJECT_REPLACEMENT_CHARACTER}\n`;

  if (!applyTextEdit(doc, newText, { replicaId })) {
    throw new Error("buildAttachmentEmbedInsertion: applyTextEdit reported no change");
  }
  isolateAttachmentPlaceholderRun(doc, placeholderIndex, attachmentId, typeUti);
  validateDocumentInvariants(doc);

  return { raw: encodeNoteDocument(doc), oldText, newText, placeholderIndex };
}

/**
 * Gives the placeholder character its own length-1 attribute run and hangs
 * the attachment reference off it - see `plantTable.ts`'s
 * `isolatePlaceholderRun` for the full rationale (`applyTextEdit` never
 * grows a run that already carries `attachmentInfo`, so the placeholder
 * arrives sharing a run with the newlines around it; this splits it out).
 */
function isolateAttachmentPlaceholderRun(doc: NoteDocument, placeholderIndex: number, attachmentId: string, typeUti: string): void {
  const out = [];
  let offset = 0;
  let attached = false;

  for (const run of doc.attributeRuns) {
    const start = offset;
    const end = offset + run.length;
    offset = end;

    if (placeholderIndex < start || placeholderIndex >= end) {
      out.push(run);
      continue;
    }

    const before = placeholderIndex - start;
    const after = end - (placeholderIndex + 1);
    if (before > 0) {
      const head = clone(AttributeRunSchema, run);
      head.length = before;
      out.push(head);
    }

    const placeholder = clone(AttributeRunSchema, run);
    placeholder.length = 1;
    // A paragraphStyle without its style field set (e.g. carrying only an
    // indent) is Body - reading .style there gives proto3's default 0, which
    // would wrongly look like Title (same rule as noteFormat's paragraphKindOf).
    const ps = placeholder.paragraphStyle;
    const style = ps && isFieldSet(ps, PS_STYLE_FIELD) ? ps.style : undefined;
    if (style !== undefined && style !== BODY_PARAGRAPH_STYLE) {
      throw new Error(
        `isolateAttachmentPlaceholderRun: the embed would land in a paragraph of style ${style}; ` +
          "attach to a note whose last line is plain prose",
      );
    }
    placeholder.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: attachmentId, typeUTI: typeUti });
    out.push(placeholder);

    if (after > 0) {
      const tail = clone(AttributeRunSchema, run);
      tail.length = after;
      out.push(tail);
    }
    attached = true;
  }

  if (!attached) {
    throw new Error(`isolateAttachmentPlaceholderRun: no attribute run covers offset ${placeholderIndex}`);
  }
  doc.attributeRuns = out;
}
