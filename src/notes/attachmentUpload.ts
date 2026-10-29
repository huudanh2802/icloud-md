/**
 * Uploads a brand-new local attachment file and creates the CloudKit
 * Attachment/Media record pair for it - the write-side counterpart of
 * `attachmentSync.ts`'s download path. Unlike everything else `push`
 * writes, there was no captured reference traffic for this: it's modeled
 * on the two-phase asset upload Apple documents publicly for
 * api.apple-cloudkit.com (this project's private endpoint uses the same
 * `database/1/<container>/<env>/<db>/<operation>` URL family throughout),
 * and verified live end-to-end against a throwaway test note - upload,
 * Media/Attachment record creation, note-body splice, re-pull round trip,
 * and rendering correctly in the real Notes app on another device
 * (dev notes, 2026-09-16).
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createZoneRecord,
  requestAssetUploadTokens,
  uploadAssetBytes,
  type CloudKitDatabase,
  type CloudKitZoneID,
} from "../cloudkit/databaseClient.js";
import type { IcloudSession } from "../session.js";

export interface NewAttachmentUpload {
  attachmentId: string;
  typeUti: string;
}

export interface UploadNewAttachmentOptions {
  session: IcloudSession;
  ckdatabasewsUrl: string;
  dsid: string;
  database: CloudKitDatabase;
  zoneID: CloudKitZoneID;
  /** The owning note's CloudKit recordName. */
  noteId: string;
  /** Whether `noteId` already exists server-side at upload time. An update
   * to an existing note does (the attachment gets uploaded before the note
   * itself is touched); a brand-new note doesn't yet - its recordName is
   * generated client-side up front so the attachment can reference the
   * right id, but the Note record itself isn't created until afterward.
   * `VALIDATE` requires the target to already exist (verified live: it
   * otherwise rejects the create with "broken validating reference"), so
   * this controls whether the Note reference uses that or `NONE`. */
  noteAlreadyExists: boolean;
  absoluteFilePath: string;
  filename: string;
  typeUti: string;
}

/**
 * Uploads one local image file and creates its Media + Attachment record
 * pair, Media first (an Attachment referencing a Media record that doesn't
 * exist yet is a state this project's own read path treats as
 * unrenderable - the same ordering reasoning as `plantTableOnNote`).
 * Returns the new attachmentId for splicing into the note body via
 * `attachmentInsert.ts`.
 */
export async function uploadNewAttachment(options: UploadNewAttachmentOptions): Promise<NewAttachmentUpload> {
  const bytes = await readFile(options.absoluteFilePath);

  const tokens = await requestAssetUploadTokens(options.session, options.ckdatabasewsUrl, options.dsid, options.database, [
    { recordType: "Media", fieldName: "Asset" },
  ]);
  const token = tokens[0];
  if (!token) {
    throw new Error("assets/upload returned no upload token");
  }
  const uploaded = await uploadAssetBytes(token.url, bytes, options.filename);

  const mediaResult = await createZoneRecord(
    "Media",
    options.session,
    options.ckdatabasewsUrl,
    options.dsid,
    options.database,
    options.zoneID,
    token.recordName,
    {
      Asset: { value: uploaded },
      FilenameEncrypted: { value: Buffer.from(options.filename, "utf-8").toString("base64") },
    },
  );
  if (!mediaResult.ok) {
    throw new Error(
      `Could not create the Media record for "${options.filename}": ${mediaResult.reason ?? mediaResult.serverErrorCode}`,
    );
  }

  const attachmentId = randomUUID();
  const attachmentResult = await createZoneRecord(
    "Attachment",
    options.session,
    options.ckdatabasewsUrl,
    options.dsid,
    options.database,
    options.zoneID,
    attachmentId,
    {
      CreationDate: { value: Date.now() },
      Note: {
        value: {
          action: options.noteAlreadyExists ? "VALIDATE" : "NONE",
          recordName: options.noteId,
          zoneID: { zoneName: options.zoneID.zoneName },
        },
      },
      Media: { value: { action: "DELETE_SELF", recordName: token.recordName, zoneID: { zoneName: options.zoneID.zoneName } } },
      UTIEncrypted: { value: Buffer.from(options.typeUti, "utf-8").toString("base64") },
      UTI: { value: options.typeUti },
      MinimumSupportedNotesVersion: { value: 2 },
      TitleEncrypted: { value: Buffer.from(options.filename, "utf-8").toString("base64") },
      MergeableDataEncrypted: { value: null },
      MergeableDataAsset: { value: null },
      EncryptedValues: { value: null },
      EncryptedValuesAsset: { value: null },
    },
  );
  if (!attachmentResult.ok) {
    throw new Error(
      `Could not create the Attachment record for "${options.filename}": ` +
        `${attachmentResult.reason ?? attachmentResult.serverErrorCode}`,
    );
  }

  return { attachmentId, typeUti: options.typeUti };
}
