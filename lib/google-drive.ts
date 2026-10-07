import { Readable } from "stream";

async function getDriveInstance() {
  try {
    const { google } = await import("googleapis");
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );
    if (process.env.GOOGLE_REFRESH_TOKEN) {
      oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    }
    return google.drive({ version: "v3", auth: oauth2 });
  } catch (e) {
    return null;
  }
}

// Drive's query language uses '...' for string literals; a project/product
// name containing an unescaped quote could otherwise break out of the
// literal and manipulate the query (e.g. matching/reusing an unintended
// existing folder) — escape per Drive's own query syntax (\' for a literal
// quote), same idea as any other query-language injection guard.
function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateFolder(drive: any, name: string, parentId?: string): Promise<string> {
  const query = [
    `name='${escapeDriveQueryLiteral(name)}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
    parentId ? `'${escapeDriveQueryLiteral(parentId)}' in parents` : null,
  ].filter(Boolean).join(" and ");

  const res = await drive.files.list({ q: query, fields: "files(id, name)" });

  if (res.data.files?.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
    fields: "id",
  });

  return folder.data.id;
}

export async function uploadToDrive({
  content,
  fileName,
  mimeType,
  projectName,
  outputType,
  existingFileId,
}: {
  content: string | Buffer;
  fileName: string;
  mimeType: string;
  projectName: string;
  outputType: string;
  // If set, updates this file's content in place (same Drive file/link)
  // instead of creating a new one — used for the "replace" path.
  existingFileId?: string | null;
}): Promise<{ fileId: string; webViewLink: string }> {
  // Real-link-or-honest-error — this used to return a plausible-looking
  // but completely non-functional "mock_"/"fallback_" Drive URL whenever
  // credentials were missing or the live call failed, which the caller
  // (app/api/drive/upload/route.ts) returned as an ordinary 200 success
  // and the UI (SaveToDriveButton.tsx) rendered as a green "Saved to
  // Drive" link — confirmed live: a GTM workbook's xlsx_drive_url was
  // literally "https://drive.google.com/file/d/mock_.../view", saved
  // as if it were real, with no way for the user to tell it wasn't a
  // real file until they clicked it and got a dead link. Throwing here
  // instead lets that same route's existing catch block return a real
  // error, and the button's existing error state ("Retry Drive Sync")
  // actually fire — no fake success for a save that didn't happen.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google Drive isn't configured for this environment (missing GOOGLE_CLIENT_ID/GOOGLE_REFRESH_TOKEN) — ask an admin to set it up before saving to Drive.");
  }

  try {
    const drive = await getDriveInstance();
    if (!drive) {
      throw new Error("Google Drive client failed to initialize — check GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN.");
    }

    const stream = Readable.from(typeof content === "string" ? [content] : [content]);

    if (existingFileId) {
      try {
        const updated = await drive.files.update({
          fileId: existingFileId,
          requestBody: { name: fileName },
          media: { mimeType, body: stream },
          fields: "id, webViewLink",
        });
        return { fileId: updated.data.id!, webViewLink: updated.data.webViewLink! };
      } catch (updateErr: any) {
        // The file may have been deleted/moved out from under us in Drive —
        // fall through to creating a fresh one rather than failing outright.
        // Security audit fix — never log the raw error object: googleapis'
        // GaxiosError carries the full outgoing request (incl. the live
        // Bearer access token derived from the one shared GOOGLE_REFRESH_
        // TOKEN this whole app's Drive integration uses) as an enumerable
        // own property, which Node's default console.warn formatting would
        // print in full. Only safe, non-credential fields.
        console.warn("Drive file update failed, creating a new file instead:", {
          message: updateErr?.message,
          status: updateErr?.status || updateErr?.code,
        });
      }
    }

    const rootId = await findOrCreateFolder(drive, "Stylecraft Lens");
    const projId = await findOrCreateFolder(drive, projectName, rootId);
    const outputId = await findOrCreateFolder(drive, outputType, projId);

    const createStream = existingFileId ? Readable.from(typeof content === "string" ? [content] : [content]) : stream;
    const file = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [outputId],
      },
      media: {
        mimeType,
        body: createStream,
      },
      fields: "id, webViewLink",
    });

    return {
      fileId: file.data.id!,
      webViewLink: file.data.webViewLink!,
    };
  } catch (err: any) {
    // Security audit fix — see the identical comment above; never log the
    // raw SDK error object (could carry a live access token).
    console.warn("Google Drive live upload error:", {
      message: err?.message,
      status: err?.status || err?.code,
    });
    // Real error, not a fake success — see this function's own header
    // comment for why a fabricated "fallback_" link is worse than an
    // honest failure. Re-thrown as a plain Error (never the raw SDK
    // error object, which can carry a live access token) so the caller's
    // message is safe to surface to the user as-is.
    throw new Error(err?.message ? `Google Drive upload failed: ${err.message}` : "Google Drive upload failed.");
  }
}
