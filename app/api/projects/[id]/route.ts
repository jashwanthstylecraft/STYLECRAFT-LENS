import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth";
import { getProject, updateProject, deleteProject } from "@/lib/db/projects";
import { getLatestAnalysisForProject } from "@/lib/db/analyses";

const TERMINAL_ANALYSIS_STATUSES = ["complete", "failed", "cancelled"];

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getAuthSession();
    const { id } = params;

    const project = await getProject(id, session.orgId);
    if (!project) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Project not found" },
        { status: 404 }
      );
    }

    // Resumability fallback for the analysis progress banner (see
    // app/(app)/dashboard/projects/[id]/page.tsx) — the happy path carries
    // the just-created analysisId via the redirect URL instead, but a page
    // reload or a later revisit has no query param, so fall back to the
    // project's most recent still-in-flight analysis, if any.
    let activeAnalysisId: string | null = null;
    try {
      const latest = await getLatestAnalysisForProject(id, session.orgId);
      if (latest && !TERMINAL_ANALYSIS_STATUSES.includes(latest.status)) {
        activeAnalysisId = latest.id;
      }
    } catch {
      // Best-effort — never blocks loading the project itself over this.
    }

    return NextResponse.json({ project: { ...project, activeAnalysisId } });
  } catch (error: any) {
    return NextResponse.json(
      { error: "SERVER_ERROR", message: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getAuthSession();
    const { id } = params;
    const body = await request.json();

    // Filter allowed fields
    const updateData: Record<string, any> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.industry !== undefined) updateData.industry = body.industry;
    if (body.targetMarket !== undefined) updateData.targetMarket = body.targetMarket;
    if (body.productName !== undefined) updateData.productName = body.productName;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.category !== undefined) updateData.category = body.category || null;
    if (body.toolType !== undefined) updateData.toolType = body.toolType || null;
    if (body.companyContext !== undefined) updateData.companyContext = body.companyContext || null;
    if (body.motorFamily !== undefined) updateData.motorFamily = body.motorFamily || null;
    if (body.motorBrandedName !== undefined) updateData.motorBrandedName = body.motorBrandedName || null;
    if (body.motorTech !== undefined) updateData.motorTech = body.motorTech || null;
    if (body.keyDiff !== undefined) updateData.keyDiff = body.keyDiff || null;
    if (body.pricePoint !== undefined) updateData.pricePoint = body.pricePoint || null;
    if (body.sku !== undefined) updateData.sku = body.sku || null;
    if (body.relatedProducts !== undefined) updateData.relatedProducts = body.relatedProducts;
    // Reference Links — at most 5, plain strings only, trimmed and capped
    // in length; a bad/unreachable URL just fails its own fetch later
    // (lib/gtm-reference-links.ts's fetchPageText never throws) rather than
    // being rejected here.
    if (body.referenceUrls !== undefined) {
      const raw = Array.isArray(body.referenceUrls) ? body.referenceUrls : [];
      updateData.referenceUrls = raw
        .filter((u: any) => typeof u === "string")
        .map((u: string) => u.trim().slice(0, 500))
        .slice(0, 5);
    }
    if (body.predecessorRef !== undefined) updateData.predecessorRef = (typeof body.predecessorRef === "string" ? body.predecessorRef.trim().slice(0, 500) : null) || null;
    if (body.gtmTemplateOverride !== undefined) updateData.gtmTemplateOverride = body.gtmTemplateOverride || null;
    if (body.savedDefaults !== undefined) updateData.savedDefaults = body.savedDefaults;
    if (body.latestAnalysisId !== undefined) updateData.latestAnalysisId = body.latestAnalysisId;
    if (body.latestReportId !== undefined) updateData.latestReportId = body.latestReportId;
    if (body.lastUsedAt !== undefined) updateData.lastUsedAt = body.lastUsedAt;

    try {
      const project = await updateProject(id, session.orgId, updateData);
      return NextResponse.json({ project });
    } catch (e: any) {
      if (e.message === "Project not found") {
        return NextResponse.json(
          { error: "NOT_FOUND", message: "Project not found" },
          { status: 404 }
        );
      }
      throw e;
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: "SERVER_ERROR", message: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getAuthSession();
    const { id } = params;

    const project = await getProject(id, session.orgId);
    if (!project) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Project not found" },
        { status: 404 }
      );
    }

    await deleteProject(id, session.orgId);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: "SERVER_ERROR", message: error.message },
      { status: 500 }
    );
  }
}
