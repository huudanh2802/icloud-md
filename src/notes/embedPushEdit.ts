/**
 * Pure logic behind `push`'s embed-bearing note path (Step 1 of the
 * formatting plan, 2026-07-17): matches a note's embed slots (see
 * `decodeNoteEmbedSlots`) against their local representations - inline embed
 * markers and rendered markdown table blocks - and reconstructs the "true"
 * body text (U+FFFC placeholders) that `TextDataEncrypted` actually stores.
 *
 * The policy: every marker must survive **verbatim**, in document order.
 * Edits around markers are fine; a deleted, edited, duplicated, or
 * reordered marker refuses the push with a reason naming what went wrong.
 * The network/fs orchestration lives in `src/commands/push.ts`.
 */

import path from "node:path";
import { findMarkdownTableBlocks, type MarkdownTableBlock } from "./markdownTable.js";
import {
  formatAttachmentMarkdown,
  isTableUti,
  OBJECT_REPLACEMENT_CHARACTER,
  type AttachmentReference,
  type EmbedSlot,
} from "./noteAttachments.js";
import { formatEmbedMarker, parseEmbedMarkers } from "./unknownContent.js";

/** One table slot matched to its local markdown block, in document order -
 * what `push`'s table-attachment update loop consumes. */
export interface MatchedTableBlock {
  ref: AttachmentReference;
  block: MarkdownTableBlock;
}

export type EmbedRepresentationPlan =
  | {
      ok: true;
      /** `localText` with every marker and table block replaced by U+FFFC -
       * the desired body text, comparable against the remote note's own. */
      reconstructedBodyText: string;
      /** Table slots in document order (may be empty). */
      tables: MatchedTableBlock[];
      /** Tracked file attachments whose reference was missing/edited and
       * got dropped rather than refused - only ever non-empty when the
       * caller passed `allowAttachmentRemoval`. The caller should drop
       * these from `state.attachments` once the push actually lands. */
      removedAttachmentIds: string[];
    }
  | { ok: false; reason: string };

interface LocalRepresentation {
  /** Character range [start, end) in `localText` this representation spans. */
  start: number;
  end: number;
  table?: MatchedTableBlock | undefined;
}

/**
 * Locates each embed slot's local representation and verifies the
 * marker-survival policy. A slot is marker-represented when it's `unknown`
 * (pull always wrote a marker) or when its attachment id appears among the
 * local markers (pull couldn't render it - an undecodable table, an
 * unresolvable file chain, an unsupported kind). An identified table slot
 * without a marker expects a markdown table block; a resolved (non-table)
 * file attachment - present in `trackedFileAttachments`, keyed by
 * attachmentIdentifier to its vault-root-relative file path from
 * `state.attachments` - expects its exact `formatAttachmentMarkdown`
 * rendering to still be present verbatim: editing an existing attachment's
 * *file* still has no write path and refuses, but merely leaving it alone
 * (the common case - typing elsewhere, or pasting a new image) is not an
 * edit to it and is spliced back to a placeholder like any other slot.
 *
 * `allowAttachmentRemoval` is an explicit, caller-opted-in escape hatch
 * (default behavior is unchanged: refuse): when a tracked file attachment's
 * reference can't be found, treat it as the user having deleted it from the
 * note - drop the slot instead of refusing, so it simply doesn't reappear in
 * `reconstructedBodyText` and the ordinary text diff downstream removes its
 * U+FFFC like any other deleted character. This can't tell an intentional
 * deletion from something else having eaten the reference, which is exactly
 * why it stays opt-in rather than the default.
 */
export function planEmbedRepresentations(
  localText: string,
  slots: readonly EmbedSlot[],
  trackedFileAttachments: ReadonlyMap<string, string>,
  noteDir: string,
  allowAttachmentRemoval = false,
): EmbedRepresentationPlan {
  const markers = parseEmbedMarkers(localText);
  const markerIds = new Set(
    markers.map((marker) => marker.attachmentIdentifier).filter((id): id is string => id !== undefined),
  );
  const tableBlocks = findMarkdownTableBlocks(localText);
  const lineStartOffsets = computeLineStartOffsets(localText);

  const representations: LocalRepresentation[] = [];
  const removedAttachmentIds: string[] = [];
  let markerCursor = 0;
  let tableCursor = 0;
  let fileSearchCursor = 0;

  for (const slot of slots) {
    const markerContent =
      slot.kind === "unknown" ? { typeUti: slot.typeUti } : markerIds.has(slot.ref.attachmentIdentifier) ? slot.ref : undefined;

    if (markerContent === undefined && slot.kind === "attachment") {
      if (isTableUti(slot.ref.typeUti)) {
        const block = tableBlocks[tableCursor];
        if (!block) {
          return {
            ok: false,
            reason: `can't tell which table(s) changed (found ${tableBlocks.length} table-shaped block(s) locally, expected more)`,
          };
        }
        tableCursor += 1;
        representations.push({
          start: lineStartOffsets[block.startLine] ?? localText.length,
          // The block's last line ends either just before the next line's
          // start or at the end of the text (no trailing newline).
          end: block.endLine < lineStartOffsets.length ? (lineStartOffsets[block.endLine] ?? localText.length + 1) - 1 : localText.length,
          table: { ref: slot.ref, block },
        });
        continue;
      }
      const trackedFile = trackedFileAttachments.get(slot.ref.attachmentIdentifier);
      if (trackedFile !== undefined) {
        const linkPath = path.posix.relative(noteDir, trackedFile);
        const expectedMarkdown = formatAttachmentMarkdown(slot.ref, linkPath);
        const index = localText.indexOf(expectedMarkdown, fileSearchCursor);
        if (index === -1) {
          if (allowAttachmentRemoval) {
            removedAttachmentIds.push(slot.ref.attachmentIdentifier);
            continue;
          }
          return {
            ok: false,
            reason:
              `the attachment reference for "${path.posix.basename(linkPath)}" is missing or was edited - ` +
              "an existing attachment's file can't be edited through this tool; leave its reference exactly as " +
              'pull wrote it, or run "restore" to discard the edit',
          };
        }
        fileSearchCursor = index + expectedMarkdown.length;
        representations.push({ start: index, end: index + expectedMarkdown.length });
        continue;
      }
      return {
        ok: false,
        reason:
          `the embed marker for "${slot.ref.typeUti}" (${slot.ref.attachmentIdentifier}) is missing - ` +
          "markers must be left exactly as this tool wrote them",
      };
    }

    // Marker-represented. The next unconsumed marker must be exactly what
    // pull would have written for this slot - anything else is an edited,
    // reordered, or missing marker.
    const expected = formatEmbedMarker(markerContent ?? {});
    const marker = markers[markerCursor];
    if (!marker) {
      return {
        ok: false,
        reason: `an embed marker is missing (expected ${expected}) - markers must be left exactly as this tool wrote them`,
      };
    }
    markerCursor += 1;
    if (marker.text !== expected) {
      return {
        ok: false,
        reason:
          `an embed marker was edited or is out of order (found ${marker.text}, expected ${expected}) - ` +
          "markers must be left exactly as this tool wrote them",
      };
    }
    representations.push({ start: marker.start, end: marker.end });
  }

  const extraMarker = markers[markerCursor];
  if (extraMarker) {
    return {
      ok: false,
      reason: `found an embed marker with nothing behind it (${extraMarker.text}) - this tool can't create embeds; remove it`,
    };
  }
  if (tableCursor < tableBlocks.length) {
    return {
      ok: false,
      reason:
        `can't tell which table(s) changed (found ${tableBlocks.length} table-shaped block(s) locally, ` +
        `expected ${tableCursor})`,
    };
  }

  // Document-order sanity: each representation must start after the previous
  // one ends (also catches a marker and a table block overlapping).
  let previousEnd = -1;
  for (const representation of representations) {
    if (representation.start < previousEnd) {
      return {
        ok: false,
        reason: "embed markers and tables appear out of document order - markers must stay where this tool wrote them",
      };
    }
    previousEnd = representation.end;
  }

  // Splice each representation back down to its placeholder, right to left
  // so earlier offsets stay valid.
  let reconstructed = localText;
  for (const representation of [...representations].reverse()) {
    reconstructed =
      reconstructed.slice(0, representation.start) + OBJECT_REPLACEMENT_CHARACTER + reconstructed.slice(representation.end);
  }

  return {
    ok: true,
    reconstructedBodyText: reconstructed,
    tables: representations.flatMap((representation) => (representation.table ? [representation.table] : [])),
    removedAttachmentIds,
  };
}

function computeLineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}
