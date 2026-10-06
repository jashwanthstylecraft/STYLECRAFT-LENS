import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { parseGtmWorkbookTemplate } from "@/lib/gtm-workbook-template-parser";
import { createGtmWorkbookTemplateFromStoragePath, GtmTemplateIndustry } from "@/lib/db/gtm-workbook-templates";
import { buildGtmTemplateFieldInspection } from "@/lib/gtm-workbook-inspection";

export const maxDuration = 30;

const STORAGE_BUCKET = "gtm-workbook-templates";
// Matches exactly the shape .../upload-url/route.ts generates
// (`${Date.now()}-${sanitized filename}`) — rejects anything else,
// including a path containing "..", before ever calling storage.download.
const TEMPLATE_PATH_RE = /^\d+-[a-zA-Z0-9._-]+$/;
const MAX_TEMPLATE_SIZE_BYTES = 50 * 1024 * 1024;

function requireAdmin(role: string) {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw Object.assign(new Error("Not authorized"), { status: 403 });
  }
}

// Completes the signed-upload-URL flow (see .../upload-url/route.ts) — the
// browser has already PUT the raw bytes straight into Storage; this
// downloads them back server-side to validate and register the template.
export async function POST(req: NextRequest) {
  try {
    const session = await getAuthSession();
    requireAdmin(session.role);

    const { path, name, fileName, industry } = await req.json();
    if (!path || !TEMPLATE_PATH_RE.test(path)) {
      return NextResponse.json({ error: "Invalid storage path" }, { status: 400 });
    }
    const resolvedIndustry: GtmTemplateIndustry = industry === "beauty" ? "beauty" : "barber";

    const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(path);
    if (error) throw error;
    const buffer = Buffer.from(await data.arrayBuffer());
    if (buffer.length > MAX_TEMPLATE_SIZE_BYTES) {
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([path]);
      return NextResponse.json({ error: `Template file too large (max ${MAX_TEMPLATE_SIZE_BYTES / 1024 / 1024}MB)` }, { status: 400 });
    }

    const sheetSummary = parseGtmWorkbookTemplate(buffer);
    if (sheetSummary.missingRequiredSheets.length > 0) {
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([path]);
      return NextResponse.json({ error: `Missing required sheet(s): ${sheetSummary.missingRequiredSheets.join(", ")}` }, { status: 400 });
    }

    // Part 1.2's "template inspection on upload" — runs for every upload
    // (barber included); see the sibling route.ts's identical comment for
    // why (the reference labels are static, not tied to whatever's
    // currently active).
    const fieldInspection = buildGtmTemplateFieldInspection(buffer);

    const template = await createGtmWorkbookTemplateFromStoragePath({
      name: name || fileName || "Untitled template",
      filePath: path,
      fileName: fileName || path,
      fileSizeBytes: buffer.length,
      sheetSummary,
      uploadedBy: session.email,
      industry: resolvedIndustry,
      fieldInspection,
    });

    return NextResponse.json({ template });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to finalize GTM workbook template upload" }, { status: err.status || 500 });
  }
}
