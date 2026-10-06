import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth";
import { createGtmWorkbookTemplate, listGtmWorkbookTemplates, GtmTemplateIndustry } from "@/lib/db/gtm-workbook-templates";
import { parseGtmWorkbookTemplate } from "@/lib/gtm-workbook-template-parser";
import { buildGtmTemplateFieldInspection } from "@/lib/gtm-workbook-inspection";

// Same zip-bomb-defense reasoning as deck-templates' own cap — a real
// 12-tab workbook runs well under this; admin-only upload narrows the risk
// further.
const MAX_TEMPLATE_SIZE_BYTES = 50 * 1024 * 1024;

export const maxDuration = 30;

function requireAdmin(role: string) {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw Object.assign(new Error("Not authorized"), { status: 403 });
  }
}

export async function GET() {
  try {
    const session = await getAuthSession();
    requireAdmin(session.role);
    const templates = await listGtmWorkbookTemplates();
    return NextResponse.json({ templates });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load GTM workbook templates" }, { status: err.status || 500 });
  }
}

// Direct-upload path for local dev without Supabase configured (no real
// body-size limit there) — see .../upload-url/route.ts for the signed-URL
// flow real deployments use instead.
export async function POST(req: NextRequest) {
  try {
    const session = await getAuthSession();
    requireAdmin(session.role);

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const name = (formData.get("name") as string) || file?.name || "Untitled template";
    const resolvedIndustry: GtmTemplateIndustry = formData.get("industry") === "beauty" ? "beauty" : "barber";
    if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    if (file.size > MAX_TEMPLATE_SIZE_BYTES) {
      return NextResponse.json({ error: `Template file too large (max ${MAX_TEMPLATE_SIZE_BYTES / 1024 / 1024}MB)` }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sheetSummary = parseGtmWorkbookTemplate(buffer);
    if (sheetSummary.missingRequiredSheets.length > 0) {
      return NextResponse.json({ error: `Missing required sheet(s): ${sheetSummary.missingRequiredSheets.join(", ")}` }, { status: 400 });
    }

    // Part 1.2's "template inspection on upload" — runs for every upload
    // (barber included). The comparison basis is a static, code-level
    // reference label set (lib/gtm-workbook-data-mapper.ts's
    // getReferenceLabelsForSheet), not whatever's currently active as
    // "barber" — so a fresh barber re-upload is just as worth checking
    // against it as a beauty one, especially right after the previous
    // template(s) were removed and a new one is going in blind.
    const fieldInspection = buildGtmTemplateFieldInspection(buffer);

    const template = await createGtmWorkbookTemplate({
      name,
      fileBuffer: buffer,
      fileName: file.name,
      sheetSummary,
      uploadedBy: session.email,
      industry: resolvedIndustry,
      fieldInspection,
    });

    return NextResponse.json({ template });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to upload GTM workbook template" }, { status: err.status || 500 });
  }
}
