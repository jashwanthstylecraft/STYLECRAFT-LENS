// lib/document-fill-engine.ts
// Automatic Source-Doc Fact Extraction & Cross-Document Fill — the actual
// per-document fill logic, extracted out of the two refill-from-sources
// ROUTES (app/api/documents/gtm/[id]/refill-from-sources,
// app/api/documents/content-form/[id]/refill-from-sources) into plain
// functions so BOTH the manual "Fill blanks from sources" button (via those
// routes) AND the automatic upload-triggered chain (lib/db/document-fill-
// state.ts + app/api/projects/[id]/fill-from-sources/continue) call the
// exact same code — no HTTP round-trip between the chain driver and the
// fill logic, no duplicated behavior to keep in sync.
import { getProject } from "@/lib/db/projects";
import { getOrCreateDocument, getDocumentFields, updateDocumentField, updateDocumentFieldMeta, setDocumentSourceDocVersions, getTdsFieldsForProject, flattenDocumentFields } from "@/lib/db/documents";
import { getProjectReports } from "@/lib/db/reports";
import { getLatestOutput } from "@/lib/project-outputs";
import { GTM_FIELD_SCHEMA, type GtmFieldAnswer } from "@/lib/gtm-field-schema";
import { deriveFieldsFromSources } from "@/lib/gtm-derive";
import { getUploadedTdsContext, applyUploadedTdsFacts, buildTdsGroundingBlock } from "@/lib/gtm-uploaded-tds";
import { getReferenceLinksContext, buildReferenceLinksPromptBlock } from "@/lib/gtm-reference-links";
import { getPredecessorProductContext } from "@/lib/predecessor-product-context";
import type { GtmSources } from "@/lib/gtm-generate";
import { buildTier6ExtraInputs, buildHairTypeSourceText } from "@/lib/gtm-generate";
import { applyTier6Inference } from "@/lib/gtm-tier6-inference";
import { listActiveDocsForProject } from "@/lib/db/uploaded-source-docs";
import { deriveFactsForDoc } from "@/lib/tds-doc-ingest";
import { isRealAnswer, isAwaitingInternalInput, isNotDeterminable } from "@/lib/field-answer-state";
import { resolveBrandForProduct, getActiveVoiceGuide, buildVoiceBlock } from "@/lib/brand-voice";
import { generateMarketingDirection } from "@/lib/gtm-marketing-direction";
import { generateProductFaqs } from "@/lib/gtm-product-faqs";
import { applyBoxOnlyDerivation } from "@/lib/gtm-box-only";
import { applyFeaturesAndExpertTip, applyCollectionKernelAdaptation, applyCoreConsumerBothNote } from "@/lib/gtm-features-and-tip";
import { listCatalogProducts } from "@/lib/db/catalog-products";
import { matchCatalogProductByName } from "@/lib/our-product-position";
import { listToolTypes } from "@/lib/db/tool-types";
import { getMarketingDefaults } from "@/lib/db/marketing-defaults";
import { CONTENT_FORM_SCHEMA } from "@/lib/content-form-field-schema";
import { generateContentForm } from "@/lib/content-form-generate";
import { getDocumentFillState, updateDocumentFillState, reclaimStaleRunningFillState, type DocumentFillStateRow, type FillStep } from "@/lib/db/document-fill-state";

const UNTOUCHABLE_SOURCES = new Set(["manual_edit", "project_record", "active_report"]);

// Unlike lib/gtm-generate.ts / lib/project-generation-engine.ts, this file
// chained multiple real AI phases (stale-fact retries, then FAQ + Marketing
// Direction, then Box Only) in one request with NO overall elapsed-time
// gate at all — each phase individually budgeted, but nothing stopping
// their sum from exceeding the calling routes' maxDuration and getting
// killed by Vercel mid-request (no response ever sent, surfacing as a
// stuck/retrying "Fill blanks from sources" button). 48s leaves ~12s of
// headroom under a 60s route cap for whatever DB writes/serialization
// still need to happen after — same margin convention as gtm-generate.ts's
// TIER_6_5_HARD_DEADLINE_MS.
const FILL_ENGINE_TIME_BUDGET_MS = 48_000;

function isBlank(answer: string | null | undefined): boolean {
  return !isRealAnswer(answer) || isAwaitingInternalInput(answer) || isNotDeterminable(answer);
}

// A field currently sourced from "web" (the AI's own web-search fallback —
// the least-authoritative tier this pipeline ever writes) is eligible for
// replacement here too, not just a truly blank one. Uploading a new source
// doc or reference link should let genuinely source-grounded content win
// over a web guess made before that source existed — "pull from sources
// first, web/AI only as a last resort" applies on refill, not just on the
// very first generation. Manual edits and every other, more-authoritative
// source tier are left alone; this only ever widens what counts as
// "wants regeneration," never touches anything already better-grounded.
function wantsSourceReplacement(current: { answer?: string | null; source?: string | null } | undefined): boolean {
  if (!current || UNTOUCHABLE_SOURCES.has(current.source || "")) return false;
  return isBlank(current.answer) || current.source === "web";
}

async function buildProjectSources(project: any, userId: string): Promise<GtmSources> {
  const [salesKit, tds, reports] = await Promise.all([
    getLatestOutput(project.id, "sales_kit"),
    getTdsFieldsForProject(project.id),
    getProjectReports(project.id, userId),
  ]);
  const latestReport = reports?.[0];
  return {
    project: {
      productName: project.productName, description: project.description, category: project.category, toolType: project.toolType,
      motorFamily: project.motorFamily, motorBrandedName: project.motorBrandedName, motorTech: project.motorTech,
      keyDiff: project.keyDiff, pricePoint: project.pricePoint, companyContext: project.companyContext,
      targetMarket: project.targetMarket, productUrl: project.productUrl, asin: project.asin,
      referenceUrls: project.referenceUrls, predecessorRef: project.predecessorRef, orgId: project.orgId,
    },
    salesKit, tds,
    activeReport: latestReport
      ? { competitive_analysis: latestReport.competitive_analysis, pricing_analysis: latestReport.pricing_analysis, content_form: latestReport.content_form }
      : null,
  };
}

export interface FillStepResult {
  filled: number; // grounded fields overwritten verbatim from an uploaded fact
  regenerated: number; // narrative fields regenerated using source facts
  stillAwaiting: number; // fields still blank/awaiting after this pass
  changedFieldIds: string[];
  factsRetried: number;
}

// Retries stale/failed fact extraction for every active source doc first —
// shared by both fill functions below, same reasoning as the original GTM
// refill route's own comment: a doc whose LAST facts-derivation attempt
// failed (or never ran) must not stay silently stuck at 0 facts forever.
async function retryStaleExtractions(projectId: string, productName: string, routeStartTime: number): Promise<number> {
  const activeDocs = await listActiveDocsForProject(projectId);
  const staleDocs = activeDocs.filter(d => d.extraction_status === "complete" && d.facts_extraction_status !== "complete");
  let retried = 0;
  for (const staleDoc of staleDocs) {
    if (Date.now() - routeStartTime > FILL_ENGINE_TIME_BUDGET_MS) {
      console.warn(`[document-fill-engine] Stopping stale-extraction retries after ${retried}/${staleDocs.length} docs — over the ${FILL_ENGINE_TIME_BUDGET_MS}ms budget. Remaining docs stay stale until the next fill run.`);
      break;
    }
    await deriveFactsForDoc(staleDoc.id, projectId, productName, routeStartTime);
    retried++;
  }
  return retried;
}

// GTM document — grounded/spec fields (verbatim override), then Marketing
// Direction + Product FAQ narrative fields (regenerate-if-blank), then Box
// Only (regenerate-if-blank) — see the original route's own header comment,
// preserved verbatim below since the reasoning didn't change, only where the
// code lives.
//
// 1. GROUNDED/spec fields: re-runs the deterministic + uploaded-TDS tiers,
//    writing only whatever actually changed.
// 2. WRITTEN/narrative fields (Marketing Direction + Product FAQ sections):
//    regenerates the whole group (these generators only ever run at group
//    granularity, matching their own initial-generation phase) but writes
//    ONLY fields that are still blank/awaiting/not-determinable at write
//    time — never touches a field with a real answer already.
// 3. Box Only section: this section has no independent phase/regenerate
//    entry point anywhere else in the app (it normally only runs inline
//    inside full GTM generation), so this is its only "fill from sources" path.
//
// A field already sourced from something more authoritative than an upload
// (manual_edit/project_record/active_report) is never touched in ANY pass.
export async function refillGtmFromSources(projectId: string, orgId: string, userId: string, actorEmail: string, routeStartTime: number = Date.now()): Promise<FillStepResult> {
  const project = await getProject(projectId, orgId) as any;
  if (!project) throw new Error("Project not found");
  const document = await getOrCreateDocument(projectId, "gtm");

  const factsRetried = await retryStaleExtractions(projectId, project.productName, routeStartTime);

  const fields = await getDocumentFields(document.id);
  const fieldsById = new Map(fields.map(f => [f.field_id, f]));

  const [sources, catalogProducts, marketingDefaults] = await Promise.all([
    buildProjectSources(project, userId),
    listCatalogProducts(),
    getMarketingDefaults(),
  ]);

  const derived = deriveFieldsFromSources(sources.project, sources.salesKit, sources.tds, sources.activeReport);
  const uploadedTdsContext = await getUploadedTdsContext(projectId);
  const referenceLinksContext = await getReferenceLinksContext(project.referenceUrls);
  const isPreLaunch = !project.productUrl && !project.asin && !referenceLinksContext.hasLinks;
  const predecessorContext = await getPredecessorProductContext(project.predecessorRef, project.orgId || orgId);
  const tdsGroundingBlock = buildTdsGroundingBlock(uploadedTdsContext, isPreLaunch)
    + (referenceLinksContext.hasLinks ? `\n\nREFERENCE SOURCES:\n${buildReferenceLinksPromptBlock(referenceLinksContext)}` : "")
    + (predecessorContext.text ? `\n\n${predecessorContext.text}` : "");
  const brand = await resolveBrandForProduct(project.productName);
  const voiceBlock = buildVoiceBlock(await getActiveVoiceGuide(brand));
  const matchedCatalogProduct = matchCatalogProductByName(project.productName, catalogProducts);

  // ---- Pass 0: Tier 6 (Good/Better/Best x3, Hair Type, Manufacturer) +
  // Tier 6.5 (Features full list/Expert Tip, Collection Kernel name-story
  // adaptation, Core Consumer "Both" note) — NOT covered by Pass 1-3 below
  // (those only re-check grounded/spec fields and Marketing Direction/FAQ/
  // Box Only), so any of these left blank at initial-generation time
  // (competitor data or catalog lineup not ready yet, most commonly —
  // exactly the race this whole refill mechanism now runs automatically
  // for, see the project page's post-analysis-completion call) never got a
  // second chance until now. Mirrors lib/gtm-generate.ts's own Tier 6/6.5
  // exactly, just re-run here — every one of these functions already
  // self-gates on "still unresolved," so calling them unconditionally is
  // safe and never touches an already-real answer.
  const pass0ChangedIds: string[] = [];
  if (Date.now() - routeStartTime > FILL_ENGINE_TIME_BUDGET_MS) {
    console.warn(`[document-fill-engine] Skipping Tier 6/6.5 refill — already over the ${FILL_ENGINE_TIME_BUDGET_MS}ms budget after stale-extraction retries. These fields stay blank until the next fill run.`);
  } else {
    const pass0Fields: Record<string, GtmFieldAnswer> = {};
    for (const f of fields) pass0Fields[f.field_id] = { answer: f.answer || "N/A", source: (f.source || "none") as any, sourceDetail: f.source_detail, flagged: !!f.flagged, notes: f.notes || undefined };

    const toolTypes = await listToolTypes();
    const tier6Extra = await buildTier6ExtraInputs(sources, toolTypes);
    applyTier6Inference(pass0Fields, GTM_FIELD_SCHEMA, { hairTypeSourceText: buildHairTypeSourceText(sources), ...tier6Extra });
    await applyFeaturesAndExpertTip(pass0Fields, GTM_FIELD_SCHEMA, sources, project.productName, routeStartTime, voiceBlock, tdsGroundingBlock, matchedCatalogProduct?.description ?? null);
    await applyCollectionKernelAdaptation(pass0Fields, GTM_FIELD_SCHEMA, project.productName, matchedCatalogProduct?.collection ?? null, voiceBlock, tdsGroundingBlock);
    await applyCoreConsumerBothNote(pass0Fields, GTM_FIELD_SCHEMA, project.productName, voiceBlock, tdsGroundingBlock);

    for (const schemaField of GTM_FIELD_SCHEMA) {
      const current = fieldsById.get(schemaField.id);
      const updated = pass0Fields[schemaField.id];
      if (!current || !updated) continue;

      const answerChanged = updated.answer !== current.answer && isRealAnswer(updated.answer);
      const notesChanged = !!updated.notes && updated.notes !== current.notes;
      if (!answerChanged && !notesChanged) continue;

      if (answerChanged) {
        await updateDocumentField(document.id, schemaField.id, updated.answer, actorEmail, {
          source: updated.source, sourceDetail: updated.sourceDetail, flagged: !!updated.flagged,
        });
      }
      if (notesChanged) {
        await updateDocumentFieldMeta(document.id, schemaField.id, { notes: updated.notes }, actorEmail);
      }
      pass0ChangedIds.push(schemaField.id);
    }
  }

  // Pass 0 may have written fields Pass 1-3 below also read via `fields`/
  // `fieldsById` — re-fetch so they never work off a stale pre-Pass-0
  // snapshot (cheap: one more read against an already-open connection).
  const fieldsAfterPass0 = pass0ChangedIds.length > 0 ? await getDocumentFields(document.id) : fields;
  const fieldsByIdAfterPass0 = pass0ChangedIds.length > 0 ? new Map(fieldsAfterPass0.map(f => [f.field_id, f])) : fieldsById;

  // ---- Pass 1: GROUNDED/spec fields ----
  const groundedChangedIds: string[] = [];
  for (const schemaField of GTM_FIELD_SCHEMA) {
    if (schemaField.kind !== "grounded") continue;
    const current = fieldsByIdAfterPass0.get(schemaField.id);
    if (!current) continue;
    if (UNTOUCHABLE_SOURCES.has(current.source || "")) continue;

    const candidateMap: Record<string, { answer: string; source: string; sourceDetail?: any }> = {
      [schemaField.id]: derived[schemaField.id] ? { ...derived[schemaField.id] } : { answer: current.answer || "N/A", source: current.source || "none" },
    };
    applyUploadedTdsFacts(candidateMap as any, [schemaField], uploadedTdsContext);
    const candidate = candidateMap[schemaField.id];

    const candidateAnswer = (candidate.answer || "").trim();
    const currentAnswer = (current.answer || "").trim();
    if (!candidateAnswer || candidateAnswer.toUpperCase() === "N/A" || candidateAnswer === currentAnswer) continue;

    await updateDocumentField(document.id, schemaField.id, candidateAnswer, actorEmail, {
      source: candidate.source, sourceDetail: candidate.sourceDetail, flagged: false,
    });
    groundedChangedIds.push(schemaField.id);
  }

  // ---- Pass 2: WRITTEN/narrative fields (Marketing Direction + Product FAQ) ----
  const marketingSchema = GTM_FIELD_SCHEMA.filter(f => f.section === "Marketing Direction" && f.kind === "written");
  const faqSchema = GTM_FIELD_SCHEMA.filter(f => f.section === "Product FAQ" && f.kind === "written");
  const wantsMarketing = marketingSchema.some(f => wantsSourceReplacement(fieldsByIdAfterPass0.get(f.id)));
  const wantsFaqs = faqSchema.some(f => wantsSourceReplacement(fieldsByIdAfterPass0.get(f.id)));

  const regeneratedIds: string[] = [];
  const overBudgetAfterPass1 = Date.now() - routeStartTime > FILL_ENGINE_TIME_BUDGET_MS;
  if (overBudgetAfterPass1 && (wantsMarketing || wantsFaqs)) {
    console.warn(`[document-fill-engine] Skipping Marketing Direction/FAQ regeneration — already over the ${FILL_ENGINE_TIME_BUDGET_MS}ms budget after Pass 1/stale-extraction retries. These fields stay blank until the next fill run.`);
  }

  if (!overBudgetAfterPass1 && (wantsMarketing || wantsFaqs)) {
    const gtmFieldsFlat = flattenDocumentFields(fieldsAfterPass0);

    if (wantsFaqs) {
      const faqFields = await generateProductFaqs(sources, gtmFieldsFlat, voiceBlock, tdsGroundingBlock);
      for (const schemaField of faqSchema) {
        const current = fieldsByIdAfterPass0.get(schemaField.id);
        if (!wantsSourceReplacement(current)) continue;
        const candidate = faqFields[schemaField.id];
        if (!candidate || !isRealAnswer(candidate.answer)) continue;
        await updateDocumentField(document.id, schemaField.id, candidate.answer, actorEmail, {
          source: candidate.source, sourceDetail: candidate.sourceDetail, flagged: !!candidate.flagged,
        });
        regeneratedIds.push(schemaField.id);
      }
    }

    const overBudgetBeforeMarketing = Date.now() - routeStartTime > FILL_ENGINE_TIME_BUDGET_MS;
    if (overBudgetBeforeMarketing && wantsMarketing) {
      console.warn(`[document-fill-engine] Skipping Marketing Direction regeneration — FAQ generation alone pushed past the ${FILL_ENGINE_TIME_BUDGET_MS}ms budget. These fields stay blank until the next fill run.`);
    }
    if (!overBudgetBeforeMarketing && wantsMarketing) {
      const refreshedFlat = wantsFaqs ? flattenDocumentFields(await getDocumentFields(document.id)) : gtmFieldsFlat;
      const marketingFields = await generateMarketingDirection(
        sources, refreshedFlat, matchedCatalogProduct?.collection ?? null, catalogProducts, matchedCatalogProduct?.id ?? null,
        marketingDefaults.languages, voiceBlock, tdsGroundingBlock
      );
      for (const schemaField of marketingSchema) {
        const current = fieldsByIdAfterPass0.get(schemaField.id);
        if (!wantsSourceReplacement(current)) continue;
        const candidate = marketingFields[schemaField.id];
        if (!candidate || !isRealAnswer(candidate.answer)) continue;
        await updateDocumentField(document.id, schemaField.id, candidate.answer, actorEmail, {
          source: candidate.source, sourceDetail: candidate.sourceDetail, flagged: !!candidate.flagged,
        });
        regeneratedIds.push(schemaField.id);
      }
    }
  }

  // ---- Pass 3: Box Only section ----
  const boxOnlySchema = GTM_FIELD_SCHEMA.filter(f => f.section === "Box Only");
  const wantsBoxOnly = boxOnlySchema.some(f => wantsSourceReplacement(fieldsByIdAfterPass0.get(f.id)));
  const overBudgetAfterPass2 = Date.now() - routeStartTime > FILL_ENGINE_TIME_BUDGET_MS;
  if (overBudgetAfterPass2 && wantsBoxOnly) {
    console.warn(`[document-fill-engine] Skipping Box Only regeneration — already over the ${FILL_ENGINE_TIME_BUDGET_MS}ms budget. These fields stay blank until the next fill run.`);
  }
  if (!overBudgetAfterPass2 && wantsBoxOnly) {
    const latestFields = flattenDocumentFields(await getDocumentFields(document.id));
    const boxFieldsMap: Record<string, { answer: string; source: string }> = {};
    for (const [id, answer] of Object.entries(latestFields)) boxFieldsMap[id] = { answer, source: "existing" };
    await applyBoxOnlyDerivation(boxFieldsMap as any, boxOnlySchema, project.productName, voiceBlock, tdsGroundingBlock);

    for (const schemaField of boxOnlySchema) {
      const current = fieldsByIdAfterPass0.get(schemaField.id);
      if (!wantsSourceReplacement(current)) continue;
      const candidate = (boxFieldsMap as any)[schemaField.id];
      if (!candidate || candidate.source === "existing" || !isRealAnswer(candidate.answer)) continue;
      await updateDocumentField(document.id, schemaField.id, candidate.answer, actorEmail, {
        source: candidate.source, sourceDetail: candidate.sourceDetail, flagged: !!candidate.flagged,
      });
      regeneratedIds.push(schemaField.id);
    }
  }

  if (uploadedTdsContext.docsUsed.length > 0) {
    const versions: Record<string, { id: string; version: number }> = {};
    for (const d of uploadedTdsContext.docsUsed) versions[d.docType] = { id: d.id, version: d.version };
    await setDocumentSourceDocVersions(document.id, versions);
  }

  const finalFields = await getDocumentFields(document.id);
  const stillAwaiting = finalFields.filter(f => isBlank(f.answer)).length;

  return {
    filled: groundedChangedIds.length,
    regenerated: pass0ChangedIds.length + regeneratedIds.length,
    stillAwaiting,
    changedFieldIds: [...pass0ChangedIds, ...groundedChangedIds, ...regeneratedIds],
    factsRetried,
  };
}

// Content Form document — every field is kind:"written" (no grounded/
// override distinction), so "fill" means: regenerate the whole 33-field
// sheet (this generator only ever runs at full-document granularity,
// matching its own initial-generation phase), writing ONLY fields still
// blank at write time.
export async function refillContentFormFromSources(projectId: string, orgId: string, userId: string, actorEmail: string, routeStartTime: number = Date.now()): Promise<FillStepResult> {
  const project = await getProject(projectId, orgId) as any;
  if (!project) throw new Error("Project not found");
  const document = await getOrCreateDocument(projectId, "content_form");

  const factsRetried = await retryStaleExtractions(projectId, project.productName, routeStartTime);

  const fields = await getDocumentFields(document.id);
  const fieldsById = new Map(fields.map(f => [f.field_id, f]));

  const wantsFill = CONTENT_FORM_SCHEMA.some(f => wantsSourceReplacement(fieldsById.get(f.id)));
  if (!wantsFill) {
    return { filled: 0, regenerated: 0, stillAwaiting: fields.filter(f => isBlank(f.answer)).length, changedFieldIds: [], factsRetried };
  }

  const gtmDocument = await getOrCreateDocument(projectId, "gtm");
  const gtmDocFields = await getDocumentFields(gtmDocument.id);
  const gtmFieldsFlat = flattenDocumentFields(gtmDocFields);

  const [sources, catalogProducts] = await Promise.all([buildProjectSources(project, userId), listCatalogProducts()]);
  const matchedCatalogProduct = matchCatalogProductByName(project.productName, catalogProducts);
  const brand = await resolveBrandForProduct(project.productName);
  const voiceBlock = buildVoiceBlock(await getActiveVoiceGuide(brand));
  const referenceLinksContext = await getReferenceLinksContext(project.referenceUrls);
  // Reference Links count as real web presence — same reasoning as
  // refillGtmFromSources above; this isPreLaunch previously omitted them,
  // an inconsistency noted but not yet fixed.
  const isPreLaunch = !project.productUrl && !project.asin && !referenceLinksContext.hasLinks;
  const uploadedTdsContext = await getUploadedTdsContext(projectId);
  const predecessorContext = await getPredecessorProductContext(project.predecessorRef, project.orgId || orgId);
  const tdsGroundingBlock = buildTdsGroundingBlock(uploadedTdsContext, isPreLaunch)
    + (referenceLinksContext.hasLinks ? `\n\nREFERENCE SOURCES:\n${buildReferenceLinksPromptBlock(referenceLinksContext)}` : "")
    + (predecessorContext.text ? `\n\n${predecessorContext.text}` : "");

  if (Date.now() - routeStartTime > FILL_ENGINE_TIME_BUDGET_MS) {
    console.warn(`[document-fill-engine] Skipping Content Form regeneration — already over the ${FILL_ENGINE_TIME_BUDGET_MS}ms budget after stale-extraction retries. Fields stay blank until the next fill run.`);
    return { filled: 0, regenerated: 0, stillAwaiting: fields.filter(f => isBlank(f.answer)).length, changedFieldIds: [], factsRetried };
  }

  const generated = await generateContentForm(sources, gtmFieldsFlat, matchedCatalogProduct, voiceBlock, tdsGroundingBlock);

  const regeneratedIds: string[] = [];
  for (const schemaField of CONTENT_FORM_SCHEMA) {
    const current = fieldsById.get(schemaField.id);
    if (!wantsSourceReplacement(current)) continue;
    const candidate = generated[schemaField.id];
    if (!candidate || !isRealAnswer(candidate.answer)) continue;
    await updateDocumentField(document.id, schemaField.id, candidate.answer, actorEmail, {
      source: candidate.source, sourceDetail: candidate.sourceDetail, flagged: !!candidate.flagged,
    });
    regeneratedIds.push(schemaField.id);
  }

  const finalFields = await getDocumentFields(document.id);
  const stillAwaiting = finalFields.filter(f => isBlank(f.answer)).length;

  return { filled: 0, regenerated: regeneratedIds.length, stillAwaiting, changedFieldIds: regeneratedIds, factsRetried };
}

// The resumable chain driver — one step per call, exactly like
// project-generation-engine.ts's runProjectGenerationStep. Called by both
// the "start" route (which also initializes the state row) and the
// "continue" route (which just resumes it) — see app/api/projects/[id]/
// fill-from-sources/{start,continue}. A closed tab mid-chain just means this
// never gets called again until something re-triggers it (the automatic
// poll mounted in ProjectDetailPage, or a manual "Fill blanks from sources"
// click) — no background-job service involved, per this feature's own
// design (see supabase_schema.sql Section 53's comment on the reverted
// Inngest attempt).
export async function runNextFillStep(projectId: string, orgId: string, userId: string, actorEmail: string): Promise<DocumentFillStateRow | null> {
  await reclaimStaleRunningFillState(projectId);
  const state = await getDocumentFillState(projectId);
  if (!state || state.status !== "running") return state;

  const step: FillStep | undefined = state.steps[state.current_step_index];
  if (!step) {
    await updateDocumentFillState(projectId, { status: "complete" });
    return getDocumentFillState(projectId);
  }

  try {
    const result = step === "gtm"
      ? await refillGtmFromSources(projectId, orgId, userId, actorEmail)
      : await refillContentFormFromSources(projectId, orgId, userId, actorEmail);

    const nextIndex = state.current_step_index + 1;
    const isDone = nextIndex >= state.steps.length;
    await updateDocumentFillState(projectId, {
      status: isDone ? "complete" : "running",
      currentStepIndex: nextIndex,
      resultsPatch: { [step]: result },
    });
  } catch (err: any) {
    await updateDocumentFillState(projectId, {
      status: "failed",
      resultsPatch: { [step]: { error: err.message || "Fill step failed" } },
    });
  }
  return getDocumentFillState(projectId);
}
