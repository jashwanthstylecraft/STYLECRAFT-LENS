// lib/db/analyses.ts
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { prisma } from "@/lib/db";
import { memoryDb } from "@/lib/memoryDb";

export async function createAnalysis(userId: string, orgId: string = "dev_org_id", projectId?: string, context?: any) {
  if (isSupabaseConfigured) {
    const { data, error } = await supabaseAdmin
      .from("analyses")
      .insert({
        user_id: userId,
        org_id: orgId,
        project_id: projectId || null,
        status: "pending",
        phase: 0,
        context: context || {},
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } else {
    // Local DB/memoryDb Fallback
    try {
      const analysis = await prisma.analysis.create({
        data: {
          orgId,
          userId: userId,
          projectId: projectId || null,
          status: "PENDING",
          phase: 0,
          context: context || {},
        }
      });
      return {
        id: analysis.id,
        project_id: analysis.projectId,
        user_id: analysis.userId,
        status: "pending",
        phase: 0,
      };
    } catch (e) {
      console.warn("Prisma failed in createAnalysis. Falling back to memoryDb.");
      const mockId = `an_${Date.now()}`;
      const analysis = {
        id: mockId,
        orgId,
        userId: userId,
        projectId: projectId || null,
        status: "PENDING" as const,
        phase: 0,
        context: context || {},
        phase0Result: null,
        phase1Result: null,
        phase2Result: null,
        phase3Result: null,
        pendingQuestion: null,
        errorMessage: null,
        durationMs: null,
        createdAt: new Date(),
        completedAt: null,
      };
      memoryDb.analyses.push(analysis);
      return {
        id: analysis.id,
        project_id: analysis.projectId,
        user_id: analysis.userId,
        status: "pending",
        phase: 0,
      };
    }
  }
}

export async function deleteAnalysis(analysisId: string, userId: string) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin
      .from("analyses")
      .delete()
      .eq("id", analysisId)
      .eq("user_id", userId);

    if (error) throw error;
    return;
  }

  try {
    await prisma.analysis.delete({ where: { id: analysisId } });
  } catch (e) {
    console.warn("Prisma failed in deleteAnalysis. Falling back to memoryDb.");
    const index = memoryDb.analyses.findIndex(a => a.id === analysisId && a.userId === userId);
    if (index !== -1) memoryDb.analyses.splice(index, 1);
    memoryDb.competitorAnalyses = memoryDb.competitorAnalyses.filter(ca => ca.analysisId !== analysisId);
  }
}

export async function updateAnalysisPhase(
  analysisId: string,
  phase: number,
  phaseKey: string, // "phase0_result" | "phase1_result" | "phase2_result" | "phase3_result"
  result: object,
  searches: number
) {
  if (isSupabaseConfigured) {
    // Note: total_searches is intentionally not persisted — it's tracked
    // and returned per-step to the client instead, not part of the schema.
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({
        phase,
        status: "running",
        [phaseKey]: result,
      })
      .eq("id", analysisId);

    if (error) throw error;
  } else {
    // Local DB/memoryDb Fallback. Prisma's schema has no phase0Result
    // column (the Product Identification stage lives only on
    // Supabase/memoryDb, same as documents/document_fields/
    // product_snapshots before it) — the update below throws for
    // phaseKey="phase0_result" and falls through to memoryDb, same
    // established pattern as every other branch in this file.
    const prismaKey = phaseKey === "phase0_result" ? "phase0Result"
                    : phaseKey === "phase1_result" ? "phase1Result"
                    : phaseKey === "phase2_result" ? "phase2Result"
                    : "phase3Result";
    try {
      await prisma.analysis.update({
        where: { id: analysisId },
        data: {
          phase,
          status: "RUNNING",
          [prismaKey]: result,
        }
      });
    } catch (e) {
      console.warn("Prisma failed in updateAnalysisPhase. Falling back to memoryDb.");
      const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
      if (mockAnalysis) {
        mockAnalysis.phase = phase;
        mockAnalysis.status = "RUNNING";
        mockAnalysis[prismaKey as "phase0Result" | "phase1Result" | "phase2Result" | "phase3Result"] = result;
      }
    }
  }
}

// Merges a partial patch into the analysis's context JSONB — used by the
// answer-question endpoint to record the user's clarifying answer
// (context.category) without disturbing the rest of the context bag.
export async function mergeAnalysisContext(analysisId: string, patch: Record<string, any>) {
  if (isSupabaseConfigured) {
    const existing = await getAnalysis(analysisId);
    const merged = { ...(existing?.context || {}), ...patch };
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({ context: merged, pending_question: null })
      .eq("id", analysisId);
    if (error) throw error;
    return merged;
  }

  const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
  if (mockAnalysis) {
    mockAnalysis.context = { ...(mockAnalysis.context || {}), ...patch };
    mockAnalysis.pendingQuestion = null;
    return mockAnalysis.context;
  }
  return patch;
}

// Targeted patch of one or more phase-result JSONB columns, WITHOUT
// touching `phase`/`status` — updateAnalysisPhase above always forces
// status:"running" and advances `phase`, which is exactly right for the
// phase pipeline's own progression but wrong for patching a single
// competitor's data on an analysis that may already be "complete" (a
// manual ASIN correction, lib/analysisEngine.ts's replaceCompetitor, must
// never make a finished analysis look like it's still processing). Same
// merge-only shape as mergeAnalysisContext above, just for phase results.
export async function patchAnalysisPhaseResults(
  analysisId: string,
  patch: { phase1_result?: object; phase2_result?: object; phase3_result?: object }
) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin.from("analyses").update(patch).eq("id", analysisId);
    if (error) throw error;
    return;
  }

  try {
    const prismaPatch: any = {};
    if (patch.phase1_result !== undefined) prismaPatch.phase1Result = patch.phase1_result;
    if (patch.phase2_result !== undefined) prismaPatch.phase2Result = patch.phase2_result;
    if (patch.phase3_result !== undefined) prismaPatch.phase3Result = patch.phase3_result;
    await prisma.analysis.update({ where: { id: analysisId }, data: prismaPatch });
  } catch (e) {
    console.warn("Prisma failed in patchAnalysisPhaseResults. Falling back to memoryDb.");
    const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
    if (mockAnalysis) {
      if (patch.phase1_result !== undefined) mockAnalysis.phase1Result = patch.phase1_result;
      if (patch.phase2_result !== undefined) mockAnalysis.phase2Result = patch.phase2_result;
      if (patch.phase3_result !== undefined) mockAnalysis.phase3Result = patch.phase3_result;
    }
  }
}

// Related Products feature — patches ONLY analyses.related_products,
// independent of phase0_result/phase1_result/etc (its own lifecycle: set
// once by lib/analysisEngine.ts's resolveRelatedProducts in Phase 0,
// re-patched in place by replaceRelatedProduct's "fixing a mispaste"
// swap). Same shape as patchAnalysisPhaseResults above — Supabase or
// memoryDb only, no Prisma column (mirrors phase0_result/
// phase1_brand_progress, both Supabase/memoryDb-only scratch data not in
// the Prisma schema).
export async function patchRelatedProducts(analysisId: string, relatedProducts: any[]) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin.from("analyses").update({ related_products: relatedProducts }).eq("id", analysisId);
    if (error) throw error;
    return;
  }

  const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
  if (mockAnalysis) mockAnalysis.relatedProducts = relatedProducts;
}

// Manually re-opens Phase 3 (synthesis) on an already-complete analysis —
// used by the "Regenerate" banner shown after a competitor swap leaves
// stale synthesis text (lib/analysisEngine.ts's replaceCompetitor sets
// phase3_result.synthesis_possibly_stale, this route clears it back to
// null). Deliberately the one place phase/status ARE reset backward
// (unlike patchAnalysisPhaseResults above): the client's existing
// POST .../continue polling loop needs `status:"running"`/`phase:3` to
// pick this up and re-run the exact same phase-3 branch runAnalysisStep
// already has, no new state-machine code.
export async function resetPhase3ForRegeneration(analysisId: string) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({ phase: 3, status: "running", phase3_result: null })
      .eq("id", analysisId);
    if (error) throw error;
    return;
  }

  try {
    await prisma.analysis.update({ where: { id: analysisId }, data: { phase: 3, status: "RUNNING", phase3Result: null as any } });
  } catch (e) {
    console.warn("Prisma failed in resetPhase3ForRegeneration. Falling back to memoryDb.");
    const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
    if (mockAnalysis) {
      mockAnalysis.phase = 3;
      mockAnalysis.status = "RUNNING";
      mockAnalysis.phase3Result = null;
    }
  }
}

// Terminal stored phase is 5, one past the highest real phase index (4 —
// synthesis, phase 3 0-indexed) — bumped from the old 3-phase pipeline's
// terminal value of 4 when Product Identification was inserted as a new
// phase 0 ahead of the two competitor-discovery phases.
export async function completeAnalysis(analysisId: string, durationMs: number) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({
        status: "complete",
        phase: 5,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      })
      .eq("id", analysisId);

    if (error) throw error;
  } else {
    // Local DB/memoryDb Fallback
    try {
      await prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: "COMPLETE",
          phase: 5,
          completedAt: new Date(),
          durationMs,
        }
      });
    } catch (e) {
      console.warn("Prisma failed in completeAnalysis. Falling back to memoryDb.");
      const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
      if (mockAnalysis) {
        mockAnalysis.status = "COMPLETE";
        mockAnalysis.phase = 5;
        mockAnalysis.completedAt = new Date();
        mockAnalysis.durationMs = durationMs;
      }
    }
  }
}

// Pauses the pipeline for user input — phase stays where it is (identity
// couldn't be confirmed), status stays "running", and pending_question's
// mere presence is what stops runAnalysisStep from advancing until
// mergeAnalysisContext (via POST /api/analyses/:id/answer) clears it.
export async function setPendingQuestion(analysisId: string, question: { question: string; foundSoFar?: string; field?: string; placeholder?: string }) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({ pending_question: question })
      .eq("id", analysisId);
    if (error) throw error;
    return;
  }

  const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
  if (mockAnalysis) mockAnalysis.pendingQuestion = question;
}

// Live per-brand search progress for Phase 1's curated legacy-brand
// discovery pass (lib/legacy-brand-discovery.ts's onBrandProgress
// callback) — written incrementally, multiple times, WHILE Phase 1's own
// request is still in flight, so a concurrent GET /api/analyses/[id] poll
// (components/analyze/ProgressPanel.tsx) sees real progress mid-run. Same
// simple two-path style as setPendingQuestion above (Supabase-or-memoryDb,
// no Prisma attempt) — this is the same tier of Supabase/memoryDb-only
// scratch data as pending_question, not part of the Prisma schema.
export async function updatePhase1BrandProgress(analysisId: string, progress: any) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({ phase1_brand_progress: progress })
      .eq("id", analysisId);
    if (error) throw error;
    return;
  }

  const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
  if (mockAnalysis) mockAnalysis.phase1BrandProgress = progress;
}

export async function failAnalysis(analysisId: string, errorMessage: string) {
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({ status: "failed", error_message: errorMessage })
      .eq("id", analysisId);

    if (error) throw error;
  } else {
    // Local DB/memoryDb Fallback
    try {
      await prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: "FAILED",
          errorMessage,
        }
      });
    } catch (e) {
      console.warn("Prisma failed in failAnalysis. Falling back to memoryDb.");
      const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
      if (mockAnalysis) {
        mockAnalysis.status = "FAILED";
        mockAnalysis.errorMessage = errorMessage;
      }
    }
  }
}

// User-initiated stop (ProgressPanel's Cancel button) — a real terminal
// status, not a failure, so it reads honestly if the analysis is ever
// revisited. The Prisma AnalysisStatus enum (prisma/schema.prisma) has no
// CANCELLED value and isn't part of this app's schema-migration convention
// (Prisma is a local dev-bypass-only path, never the real production
// store — see lib/auth.ts's own comments) — mapped to FAILED with a
// distinguishing errorMessage there instead of a real migration.
export async function cancelAnalysis(analysisId: string) {
  const message = "Cancelled by user";
  if (isSupabaseConfigured) {
    const { error } = await supabaseAdmin
      .from("analyses")
      .update({ status: "cancelled", error_message: message })
      .eq("id", analysisId);

    if (error) throw error;
  } else {
    try {
      await prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: "FAILED",
          errorMessage: message,
        }
      });
    } catch (e) {
      console.warn("Prisma failed in cancelAnalysis. Falling back to memoryDb.");
      const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
      if (mockAnalysis) {
        mockAnalysis.status = "CANCELLED";
        mockAnalysis.errorMessage = message;
      }
    }
  }
}

export async function getAnalysis(analysisId: string) {
  if (isSupabaseConfigured) {
    const { data, error } = await supabaseAdmin
      .from("analyses")
      .select("*, projects(*)")
      .eq("id", analysisId)
      .single();

    if (error) throw error;
    return data;
  } else {
    // Local DB/memoryDb Fallback
    try {
      const analysis = await prisma.analysis.findUnique({
        where: { id: analysisId },
        include: { project: true }
      });
      if (!analysis) return null;
      return {
        id: analysis.id,
        org_id: analysis.orgId,
        project_id: analysis.projectId,
        user_id: analysis.userId,
        status: analysis.status.toLowerCase(),
        phase: analysis.phase,
        context: analysis.context,
        phase1_result: analysis.phase1Result,
        phase2_result: analysis.phase2Result,
        phase3_result: analysis.phase3Result,
        error_message: analysis.errorMessage,
        duration_ms: analysis.durationMs,
        created_at: analysis.createdAt,
        completed_at: analysis.completedAt,
        projects: analysis.project ? {
          id: analysis.project.id,
          name: analysis.project.name,
          product_name: analysis.project.productName,
          industry: analysis.project.industry,
          description: analysis.project.description,
        } : null
      };
    } catch (e) {
      console.warn("Prisma failed in getAnalysis. Falling back to memoryDb.");
      const mockAnalysis = memoryDb.analyses.find(a => a.id === analysisId);
      if (!mockAnalysis) return null;
      const project = memoryDb.projects.find(p => p.id === mockAnalysis.projectId);
      return {
        id: mockAnalysis.id,
        org_id: mockAnalysis.orgId,
        project_id: mockAnalysis.projectId,
        user_id: mockAnalysis.userId,
        status: mockAnalysis.status.toLowerCase(),
        phase: mockAnalysis.phase,
        context: mockAnalysis.context,
        phase0_result: mockAnalysis.phase0Result,
        phase1_result: mockAnalysis.phase1Result,
        phase2_result: mockAnalysis.phase2Result,
        phase3_result: mockAnalysis.phase3Result,
        pending_question: mockAnalysis.pendingQuestion,
        phase1_brand_progress: mockAnalysis.phase1BrandProgress ?? null,
        related_products: mockAnalysis.relatedProducts ?? [],
        error_message: mockAnalysis.errorMessage,
        duration_ms: mockAnalysis.durationMs,
        created_at: mockAnalysis.createdAt,
        completed_at: mockAnalysis.completedAt,
        projects: project ? {
          id: project.id,
          name: project.name,
          product_name: project.productName,
          industry: project.industry,
          description: project.description,
        } : null
      };
    }
  }
}

export async function getUserAnalyses(userId: string) {
  if (isSupabaseConfigured) {
    const { data, error } = await supabaseAdmin
      .from("analyses")
      .select("*, projects(name, product_name)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data;
  } else {
    // Local DB/memoryDb Fallback
    try {
      const analyses = await prisma.analysis.findMany({
        where: { userId },
        include: { project: true },
        orderBy: { createdAt: "desc" }
      });
      return analyses.map(an => ({
        id: an.id,
        project_id: an.projectId,
        user_id: an.userId,
        status: an.status.toLowerCase(),
        phase: an.phase,
        created_at: an.createdAt,
        projects: an.project ? {
          name: an.project.name,
          product_name: an.project.productName,
        } : null
      }));
    } catch (e) {
      console.warn("Prisma failed in getUserAnalyses. Falling back to memoryDb.");
      const list = memoryDb.analyses.filter(a => a.userId === userId);
      return list.map(an => {
        const project = memoryDb.projects.find(p => p.id === an.projectId);
        return {
          id: an.id,
          project_id: an.projectId,
          user_id: an.userId,
          status: an.status.toLowerCase(),
          phase: an.phase,
          created_at: an.createdAt,
          projects: project ? {
            name: project.name,
            product_name: project.productName,
          } : null
        };
      }).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    }
  }
}

// The most recent analysis linked to a project, regardless of status — lets
// the project page (app/(app)/dashboard/projects/[id]/page.tsx) detect an
// analysis that's still pending/running (e.g. after a page reload or a
// revisit) and resume showing its progress banner, without the client
// needing to have carried the analysisId itself via the URL. Returns null
// when the project has no analyses at all.
export async function getLatestAnalysisForProject(projectId: string, orgId: string) {
  if (isSupabaseConfigured) {
    const { data, error } = await supabaseAdmin
      .from("analyses")
      .select("id, status, phase")
      .eq("project_id", projectId)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  } else {
    try {
      const analysis = await prisma.analysis.findFirst({
        where: { projectId, orgId },
        orderBy: { createdAt: "desc" },
      });
      if (!analysis) return null;
      return { id: analysis.id, status: analysis.status.toLowerCase(), phase: analysis.phase };
    } catch (e) {
      console.warn("Prisma failed in getLatestAnalysisForProject. Falling back to memoryDb.");
      const list = memoryDb.analyses
        .filter(a => a.projectId === projectId && a.orgId === orgId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (!list.length) return null;
      return { id: list[0].id, status: list[0].status.toLowerCase(), phase: list[0].phase };
    }
  }
}

// For the anti-boilerplate check: recent completed analyses' identified
// category + positioning text, so a newly-generated Phase 3 synthesis can
// be compared against what the last few DIFFERENT-category analyses
// produced — catching generic, could-apply-to-any-category strategy text.
export async function getRecentAnalysesForBoilerplateCheck(orgId: string, excludeAnalysisId: string, limit = 5) {
  if (isSupabaseConfigured) {
    const { data, error } = await supabaseAdmin
      .from("analyses")
      .select("id, phase0_result, phase3_result")
      .eq("org_id", orgId)
      .eq("status", "complete")
      .neq("id", excludeAnalysisId)
      .order("completed_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((a: any) => ({
      category: a.phase0_result?.category as string | undefined,
      positioningText: a.phase3_result?.positioning_recommendation as string | undefined,
    }));
  }

  return memoryDb.analyses
    .filter(a => a.orgId === orgId && a.status === "COMPLETE" && a.id !== excludeAnalysisId)
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
    .slice(0, limit)
    .map(a => ({
      category: (a.phase0Result as any)?.category as string | undefined,
      positioningText: (a.phase3Result as any)?.positioning_recommendation as string | undefined,
    }));
}
