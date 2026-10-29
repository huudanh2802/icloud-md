import { test } from "node:test";
import assert from "node:assert/strict";
import { planEmbedRepresentations } from "./embedPushEdit.js";
import { renderMarkdownTable } from "./markdownTable.js";
import { OBJECT_REPLACEMENT_CHARACTER, type EmbedSlot } from "./noteAttachments.js";
import { formatEmbedMarker } from "./unknownContent.js";

const NO_TRACKED_FILES = new Map<string, string>();
const NOTE_DIR = "Notes";

const GALLERY_SLOT: EmbedSlot = {
  kind: "attachment",
  ref: { attachmentIdentifier: "GALLERY-1", typeUti: "com.apple.notes.gallery" },
};
const GALLERY_MARKER = formatEmbedMarker({ attachmentIdentifier: "GALLERY-1", typeUti: "com.apple.notes.gallery" });
const UNKNOWN_SLOT: EmbedSlot = { kind: "unknown", typeUti: undefined };
const UNKNOWN_MARKER = formatEmbedMarker({});
const TABLE_SLOT: EmbedSlot = {
  kind: "attachment",
  ref: { attachmentIdentifier: "TABLE-1", typeUti: "com.apple.notes.table" },
};

function expectOk(result: ReturnType<typeof planEmbedRepresentations>) {
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectRefusal(result: ReturnType<typeof planEmbedRepresentations>, pattern: RegExp) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.reason, pattern);
}

test("a verbatim marker maps back to its placeholder; edits around it survive", () => {
  const localText = `Title\nedited intro\n${GALLERY_MARKER}\nedited outro`;
  const plan = expectOk(planEmbedRepresentations(localText, [GALLERY_SLOT], NO_TRACKED_FILES, NOTE_DIR));
  assert.equal(plan.reconstructedBodyText, `Title\nedited intro\n${OBJECT_REPLACEMENT_CHARACTER}\nedited outro`);
  assert.deepEqual(plan.tables, []);
});

test("an unknown slot's marker round-trips the same way", () => {
  const localText = `Note\n${UNKNOWN_MARKER}\n`;
  const plan = expectOk(planEmbedRepresentations(localText, [UNKNOWN_SLOT], NO_TRACKED_FILES, NOTE_DIR));
  assert.equal(plan.reconstructedBodyText, `Note\n${OBJECT_REPLACEMENT_CHARACTER}\n`);
});

test("markers and table blocks interleave in document order", () => {
  const table = renderMarkdownTable([["A", "B"]]);
  const localText = `Title\n${GALLERY_MARKER}\nbetween\n${table}\nafter`;
  const plan = expectOk(planEmbedRepresentations(localText, [GALLERY_SLOT, TABLE_SLOT], NO_TRACKED_FILES, NOTE_DIR));
  assert.equal(
    plan.reconstructedBodyText,
    `Title\n${OBJECT_REPLACEMENT_CHARACTER}\nbetween\n${OBJECT_REPLACEMENT_CHARACTER}\nafter`,
  );
  assert.equal(plan.tables.length, 1);
  assert.equal(plan.tables[0]?.ref.attachmentIdentifier, "TABLE-1");
  assert.deepEqual(plan.tables[0]?.block.grid, [["A", "B"]]);
});

test("a table that pull couldn't decode is marker-represented, not table-represented", () => {
  const marker = formatEmbedMarker({ attachmentIdentifier: "TABLE-1", typeUti: "com.apple.notes.table" });
  const localText = `Prose\n${marker}\nmore prose`;
  const plan = expectOk(planEmbedRepresentations(localText, [TABLE_SLOT], NO_TRACKED_FILES, NOTE_DIR));
  assert.equal(plan.reconstructedBodyText, `Prose\n${OBJECT_REPLACEMENT_CHARACTER}\nmore prose`);
  assert.deepEqual(plan.tables, []);
});

test("a deleted marker refuses the push", () => {
  expectRefusal(
    planEmbedRepresentations("Just prose, marker gone", [GALLERY_SLOT], NO_TRACKED_FILES, NOTE_DIR),
    /marker.*missing/i,
  );
});

test("an edited marker refuses the push", () => {
  const edited = GALLERY_MARKER.replace(">gallery<", ">my gallery<");
  expectRefusal(
    planEmbedRepresentations(`Text\n${edited}`, [GALLERY_SLOT], NO_TRACKED_FILES, NOTE_DIR),
    /edited or is out of order/,
  );
});

test("a duplicated marker refuses the push", () => {
  const localText = `A\n${GALLERY_MARKER}\nB\n${GALLERY_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [GALLERY_SLOT], NO_TRACKED_FILES, NOTE_DIR), /nothing behind it/);
});

test("reordered markers refuse the push", () => {
  const otherSlot: EmbedSlot = {
    kind: "attachment",
    ref: { attachmentIdentifier: "GALLERY-2", typeUti: "com.apple.notes.gallery" },
  };
  const otherMarker = formatEmbedMarker({ attachmentIdentifier: "GALLERY-2", typeUti: "com.apple.notes.gallery" });
  const localText = `A\n${otherMarker}\nB\n${GALLERY_MARKER}`;
  expectRefusal(
    planEmbedRepresentations(localText, [GALLERY_SLOT, otherSlot], NO_TRACKED_FILES, NOTE_DIR),
    /edited or is out of order/,
  );
});

test("a hand-added marker with nothing behind it refuses the push", () => {
  const localText = `Only prose\n${UNKNOWN_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [], NO_TRACKED_FILES, NOTE_DIR), /nothing behind it/);
});

test("a tracked file attachment whose markdown survives verbatim is preserved, not refused", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  const tracked = new Map([["FILE-1", "Notes/attachments/photo.jpeg"]]);
  const localText = "edited intro\n![photo.jpeg](attachments/photo.jpeg)\nedited outro";
  const plan = expectOk(planEmbedRepresentations(localText, [fileSlot], tracked, NOTE_DIR));
  assert.equal(plan.reconstructedBodyText, `edited intro\n${OBJECT_REPLACEMENT_CHARACTER}\nedited outro`);
});

test("editing a tracked file attachment's own markdown refuses the push", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  const tracked = new Map([["FILE-1", "Notes/attachments/photo.jpeg"]]);
  const localText = "![a different caption](attachments/photo.jpeg)";
  expectRefusal(planEmbedRepresentations(localText, [fileSlot], tracked, NOTE_DIR), /attachment reference.*missing/);
});

test("deleting a tracked file attachment's reference refuses the push", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  const tracked = new Map([["FILE-1", "Notes/attachments/photo.jpeg"]]);
  expectRefusal(planEmbedRepresentations("Just prose now", [fileSlot], tracked, NOTE_DIR), /attachment reference.*missing/);
});

test("with allowAttachmentRemoval, a missing tracked reference is dropped instead of refused", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  const tracked = new Map([["FILE-1", "Notes/attachments/photo.jpeg"]]);
  const plan = expectOk(planEmbedRepresentations("Just prose now", [fileSlot], tracked, NOTE_DIR, true));
  assert.equal(plan.reconstructedBodyText, "Just prose now");
  assert.deepEqual(plan.removedAttachmentIds, ["FILE-1"]);
});

test("with allowAttachmentRemoval, an unrelated table refusal still refuses (removal isn't a blanket bypass)", () => {
  expectRefusal(
    planEmbedRepresentations("prose only", [TABLE_SLOT], NO_TRACKED_FILES, NOTE_DIR, true),
    /can't tell which table/,
  );
});

test("without allowAttachmentRemoval (the default), a missing tracked reference still refuses", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  const tracked = new Map([["FILE-1", "Notes/attachments/photo.jpeg"]]);
  expectRefusal(planEmbedRepresentations("Just prose now", [fileSlot], tracked, NOTE_DIR), /attachment reference.*missing/);
});

test("a hand-typed reference to a genuinely untracked file still refuses with the missing-marker reason", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  expectRefusal(planEmbedRepresentations("prose only", [fileSlot], NO_TRACKED_FILES, NOTE_DIR), /marker.*is missing/);
});

test("an extra hand-typed table block refuses the push", () => {
  const table = renderMarkdownTable([["A"]]);
  const extra = renderMarkdownTable([["B"]]);
  const localText = `${table}\nprose\n${extra}`;
  expectRefusal(planEmbedRepresentations(localText, [TABLE_SLOT], NO_TRACKED_FILES, NOTE_DIR), /can't tell which table/);
});

test("a missing table block refuses the push", () => {
  expectRefusal(planEmbedRepresentations("prose only", [TABLE_SLOT], NO_TRACKED_FILES, NOTE_DIR), /can't tell which table/);
});

test("a table-only note reconstructs exactly like the old table path did", () => {
  const table = renderMarkdownTable([["Only", "Content"]]);
  const plan = expectOk(planEmbedRepresentations(table, [TABLE_SLOT], NO_TRACKED_FILES, NOTE_DIR));
  assert.equal(plan.reconstructedBodyText, OBJECT_REPLACEMENT_CHARACTER);
});

test("two tables reconstruct in document order", () => {
  const first = renderMarkdownTable([["First"]]);
  const second = renderMarkdownTable([["Second", "Table"]]);
  const secondSlot: EmbedSlot = {
    kind: "attachment",
    ref: { attachmentIdentifier: "TABLE-2", typeUti: "com.apple.notes.table" },
  };
  const localText = `Intro\n${first}\nMiddle\n${second}\nOutro`;
  const plan = expectOk(planEmbedRepresentations(localText, [TABLE_SLOT, secondSlot], NO_TRACKED_FILES, NOTE_DIR));
  assert.equal(
    plan.reconstructedBodyText,
    `Intro\n${OBJECT_REPLACEMENT_CHARACTER}\nMiddle\n${OBJECT_REPLACEMENT_CHARACTER}\nOutro`,
  );
  assert.deepEqual(
    plan.tables.map((t) => t.ref.attachmentIdentifier),
    ["TABLE-1", "TABLE-2"],
  );
});
