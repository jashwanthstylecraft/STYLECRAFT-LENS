import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth";
import { getGtmWorkbookTemplateById, deleteGtmWorkbookTemplate } from "@/lib/db/gtm-workbook-templates";

function requireAdmin(role: string) {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw Object.assign(new Error("Not authorized"), { status: 403 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getAuthSession();
    requireAdmin(session.role);

    const existing = await getGtmWorkbookTemplateById(params.id);
    if (!existing) return NextResponse.json({ error: "Template not found" }, { status: 404 });

    await deleteGtmWorkbookTemplate(params.id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to delete GTM workbook template" }, { status: err.status || 500 });
  }
}
