// lib/deck-data-mapper.ts
// Resolves every token in a deck's placeholder_map to its real value, using
// exactly the same read-paths already established elsewhere in the app —
// no new data-access patterns. Every resolved string is run through the
// existing sanitizeText() as the final step (per the feature spec). This
// module does no AI free-writing and fetches no image bytes — it only
// resolves WHAT a token's real, saved value is; length-fitting
// (lib/deck-condense.ts) and image byte fetching/cropping (lib/deck-render.ts)
// happen downstream.
import { getDocumentByProject, getDocumentFields, DocumentFieldRow } from "./db/documents";
import { getProjectReports } from "./db/reports";
import { getLatestSnapshot } from "./db/snapshots";
import { getProject } from "./db/projects";
import { getGtmLastEditedAt } from "./db/project-decks";
import { isRealAnswer, buildFillReport } from "./field-answer-state";
import { GTM_FIELD_SCHEMA } from "./gtm-field-schema";
import { sanitizeText } from "./sanitize";
import { splitNumberedList } from "./deck-field-registry";
import {
  DeckPlaceholderMap,
  DeckTokenMapping,
  DeckValue,
  CompetitorRow,
  DeckImageRef,
} from "./deck-types";

export interface DeckDataResult {
  values: Record<string, DeckValue>;
  // GTM's true last-edited moment at the time this data was built — stored
  // on the resulting project_decks row so Phase 4's staleness banner can
  // later compare it against a fresh getGtmLastEditedAt() read.
  gtmSnapshotAt: string | null;
}

interface ResolveCtx {
  project: any;
  gtmByFieldId: Map<string, DocumentFieldRow>;
  tdsByFieldId: Map<string, DocumentFieldRow>;
  report: any | null;
  snapshot: any | null;
  competitors: CompetitorRow[];
}

const USP_SPLIT_COUNT = 5;

const SPEC_HIGHLIGHT_FIELDS: { id: string; label: string }[] = [
  { id: "motor_type", label: "Motor" },
  { id: "motor_rpm", label: "RPM" },
  { id: "motor_run_time", label: "Run-time" },
  { id: "blade_name", label: "Blade" },
  { id: "product_weight", label: "Weight" },
];

const COMPETITOR_TABLE_MAX_ROWS = 10;

function getByPath(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatReportValue(value: any): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    const joined = value
      .map(v => (typeof v === "string" ? v : v?.description || v?.action || v?.detail || ""))
      .filter(Boolean)
      .join("\n");
    return sanitizeText(joined) || "";
  }
  return sanitizeText(String(value)) || "";
}

function buildCompetitorRows(report: any): CompetitorRow[] {
  if (!report) return [];
  const large = report.competitive_analysis?.large_brand_competitors || [];
  const indie = report.competitive_analysis?.indie_emerging_competitors || [];
  return [...large, ...indie].slice(0, COMPETITOR_TABLE_MAX_ROWS).map((c: any) => ({
    name: sanitizeText(c?.name) || c?.name || "",
    brand: sanitizeText(c?.brand),
    tier: c?.tier === "legacy" ? "Large Brand" : c?.tier === "emerging" ? "Indie/Emerging" : null,
    price: c?.price || null,
  }));
}

const TOP_6_FEATURES_GROUP_SIZE = 5;

// top_6_features became a 5-row repeatable group in GTM Schema v3
// (top_6_features_1..5, see lib/gtm-field-schema.ts) — joins whichever
// rows have real content into one bulleted block for the deck's
// feature_list token, same "stop at the first empty row" trim as the
// CSV/PDF exports (lib/gtm-group-fields.ts).
function buildTop6FeaturesList(gtmByFieldId: Map<string, DocumentFieldRow>): string {
  const lines: string[] = [];
  for (let i = 1; i <= TOP_6_FEATURES_GROUP_SIZE; i++) {
    const field = gtmByFieldId.get(`top_6_features_${i}`);
    if (!field || !isRealAnswer(field.answer)) break;
    const clean = sanitizeText(field.answer);
    if (clean) lines.push(clean);
  }
  return lines.join("\n");
}

function buildSpecHighlights(tdsByFieldId: Map<string, DocumentFieldRow>): string {
  const parts: string[] = [];
  for (const { id, label } of SPEC_HIGHLIGHT_FIELDS) {
    const field = tdsByFieldId.get(id);
    if (!field || !isRealAnswer(field.answer)) continue;
    const clean = sanitizeText(field.answer);
    if (clean) parts.push(`${label}: ${clean}`);
  }
  return parts.join(" · ");
}

// Honest, non-invented provenance line for the appendix slide — counts of
// real data already computed via the shared buildFillReport() helper, never
// a new AI summary of "how good the data is."
function buildProvenanceSummary(ctx: ResolveCtx): string {
  const gtmFieldsRecord: Record<string, { answer?: string | null; source?: string | null }> = {};
  ctx.gtmByFieldId.forEach((f, id) => { gtmFieldsRecord[id] = { answer: f.answer, source: f.source }; });
  const fillReport = buildFillReport(gtmFieldsRecord, GTM_FIELD_SCHEMA.map(f => ({ id: f.id })));

  const parts: string[] = [`${fillReport.filled}/${fillReport.total} GTM fields verified`];
  const topSource = Object.entries(fillReport.bySource).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topSource) parts.push(`primarily from ${topSource.replace(/_/g, " ")}`);
  if (ctx.competitors.length > 0) {
    parts.push(`${ctx.competitors.length} competitor${ctx.competitors.length === 1 ? "" : "s"} benchmarked`);
  }
  if (ctx.report?.created_at) {
    parts.push(`analysis run ${formatDate(new Date(ctx.report.created_at))}`);
  }
  return parts.join(" · ");
}

function resolveComputed(name: string, ctx: ResolveCtx): DeckValue {
  switch (name) {
    case "generated_date":
      return formatDate(new Date());
    case "competitor_table":
      return ctx.competitors;
    case "spec_highlights":
      return buildSpecHighlights(ctx.tdsByFieldId);
    case "feature_list":
      return buildTop6FeaturesList(ctx.gtmByFieldId);
    case "provenance_summary":
      return buildProvenanceSummary(ctx);
    default:
      return "";
  }
}

function resolveTokenValue(token: DeckTokenMapping, ctx: ResolveCtx): DeckValue {
  const source = token.source;
  switch (source.type) {
    case "gtm_field": {
      const field = ctx.gtmByFieldId.get(source.field_id);
      if (!field || !isRealAnswer(field.answer)) return "";
      const raw = field.answer as string;
      if (source.split === "numbered_list") {
        const parts = splitNumberedList(raw, USP_SPLIT_COUNT);
        return sanitizeText(parts[source.split_index ?? 0]) || "";
      }
      return sanitizeText(raw) || "";
    }
    case "report_field":
      return formatReportValue(getByPath(ctx.report, source.path));
    case "project_field":
      return sanitizeText((ctx.project as any)?.[source.field]) || "";
    case "snapshot_image": {
      const raw = ctx.snapshot?.raw_data;
      const url: string | null = raw?.site?.image || raw?.amazon?.image || null;
      const box = token.image_box_px || { width: 800, height: 600 };
      return { sourceUrl: url, targetWidthPx: box.width, targetHeightPx: box.height } as DeckImageRef;
    }
    case "computed":
      return resolveComputed(source.name, ctx);
    case "static":
      return source.value;
    case "unmapped":
    default:
      return "";
  }
}

export async function buildDeckDataForProject(
  projectId: string,
  orgId: string,
  userId: string,
  placeholderMap: DeckPlaceholderMap
): Promise<DeckDataResult> {
  const [project, gtmDoc, tdsDoc, reports, snapshot] = await Promise.all([
    getProject(projectId, orgId),
    getDocumentByProject(projectId, "gtm"),
    getDocumentByProject(projectId, "tds"),
    getProjectReports(projectId, userId),
    getLatestSnapshot(projectId),
  ]);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const [gtmFields, tdsFields] = await Promise.all([
    gtmDoc ? getDocumentFields(gtmDoc.id) : Promise.resolve([] as DocumentFieldRow[]),
    tdsDoc ? getDocumentFields(tdsDoc.id) : Promise.resolve([] as DocumentFieldRow[]),
  ]);
  const gtmByFieldId = new Map(gtmFields.map(f => [f.field_id, f]));
  const tdsByFieldId = new Map(tdsFields.map(f => [f.field_id, f]));

  const latestReport = (reports && reports[0]) || null;
  const competitors = buildCompetitorRows(latestReport);

  const ctx: ResolveCtx = { project, gtmByFieldId, tdsByFieldId, report: latestReport, snapshot, competitors };

  const values: Record<string, DeckValue> = {};
  for (const token of placeholderMap.tokens) {
    values[token.token] = resolveTokenValue(token, ctx);
  }

  return {
    values,
    gtmSnapshotAt: gtmDoc ? getGtmLastEditedAt(gtmDoc, gtmFields) : null,
  };
}
