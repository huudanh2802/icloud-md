import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { relocateNoteAttachments } from "./push.js";
import type { CloneState } from "../notes/cloneState.js";

async function vault(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "relocate-"));
  await mkdir(path.join(dir, "Notes", "attachments"), { recursive: true });
  await mkdir(path.join(dir, "Archive", "attachments"), { recursive: true });
  return dir;
}

test("a moved note's attachments follow it, renamed on collision with the link rewritten", async () => {
  const dir = await vault();
  await writeFile(path.join(dir, "Notes", "attachments", "a.png"), "A");
  await writeFile(path.join(dir, "Notes", "attachments", "My pic.png"), "PIC");
  await writeFile(path.join(dir, "Archive", "attachments", "My pic.png"), "SOMEONE ELSE'S");
  // The note file itself was already moved by the user.
  await writeFile(path.join(dir, "Archive", "Trip.md"), "Trip\n![a.png](attachments/a.png)\n![My pic.png](attachments/My%20pic.png)\n");
  const state = {
    notes: {},
    attachments: {
      A1: { file: "Notes/attachments/a.png", noteRecordName: "N1" },
      A2: { file: "Notes/attachments/My pic.png", noteRecordName: "N1" },
      OTHER: { file: "Notes/attachments/other.png", noteRecordName: "N2" },
    },
  } as unknown as CloneState;

  await relocateNoteAttachments(dir, state, "N1", "Archive/Trip.md");

  assert.equal(state.attachments!.A1!.file, "Archive/attachments/a.png");
  assert.equal(state.attachments!.A2!.file, "Archive/attachments/My pic 2.png");
  assert.equal(state.attachments!.OTHER!.file, "Notes/attachments/other.png");
  assert.deepEqual((await readdir(path.join(dir, "Notes", "attachments"))).sort(), []);
  assert.equal(await readFile(path.join(dir, "Archive", "attachments", "My pic 2.png"), "utf8"), "PIC");
  assert.equal(await readFile(path.join(dir, "Archive", "attachments", "My pic.png"), "utf8"), "SOMEONE ELSE'S");
  assert.match(await readFile(path.join(dir, "Archive", "Trip.md"), "utf8"), /\(attachments\/My%20pic%202\.png\)/);
});

test("an attachment already moved by hand only has its tracked path updated", async () => {
  const dir = await vault();
  await writeFile(path.join(dir, "Archive", "attachments", "b.png"), "B");
  await writeFile(path.join(dir, "Archive", "Note.md"), "Note\n![b.png](attachments/b.png)\n");
  const state = { notes: {}, attachments: { B1: { file: "Notes/attachments/b.png", noteRecordName: "N1" } } } as unknown as CloneState;
  await relocateNoteAttachments(dir, state, "N1", "Archive/Note.md");
  assert.equal(state.attachments!.B1!.file, "Archive/attachments/b.png");
});
