// In-memory fallback database for development when PostgreSQL is not connected
//
// Also autosaves to a local JSON snapshot so dev-server restarts (dependency
// changes, cache clears, crashes) don't silently wipe unsaved data. This is a
// dev convenience, not a substitute for a real database in production.
import fs from "fs";
import path from "path";
import { FAQ_SEED_DATA } from "./faq-seed-data";

const SNAPSHOT_PATH = path.join(process.cwd(), ".local-data", "memdb-snapshot.json");
const AUTOSAVE_INTERVAL_MS = 3000;

// Vercel (and other serverless platforms) mount a read-only filesystem and
// recycle warm containers unpredictably — a setInterval here would fail on
// every write AND leak a recurring timer into every container that imports
// this module for the life of that container. This snapshot is a local-dev
// convenience only; production persistence goes through Supabase.
const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

export interface MockCompetitor {
  id: string;
  orgId: string;
  name: string;
  website: string | null;
  description: string | null;
  status: "ACTIVE" | "MONITORING" | "ARCHIVED";
  tags: string[];
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockProject {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  industry: string;
  targetMarket: string;
  productName: string;
  description: string;
  category?: string | null;
  toolType?: string | null;
  companyContext?: string | null;
  motorFamily?: string | null;
  motorBrandedName?: string | null;
  motorTech?: string | null;
  keyDiff?: string | null;
  pricePoint?: string | null;
  productUrl?: string | null;
  asin?: string | null;
  sku?: string | null;
  savedDefaults?: any;
  latestAnalysisId?: string | null;
  latestReportId?: string | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Raw {asin,url,addedAt} input only, for re-run pre-fill — see
  // lib/db/analyses.ts's related_products for the ENRICHED per-analysis data.
  relatedProducts?: any[];
  // GTM Multi-Template work — null (default) auto-routes the workbook export
  // to whichever template matches the product's tool type family; 'barber'/
  // 'beauty' pins it regardless of the resolved family (mixed-collection override).
  gtmTemplateOverride?: "barber" | "beauty" | null;
  // Reference Links — up to 5 user-supplied URLs (product pages, competitor/
  // brand sites) checked first for GTM/Content Form generation, ahead of the
  // AI's own web search. See lib/gtm-reference-links.ts.
  referenceUrls?: string[];
  // Predecessor Product Reference — a name or link to an existing/prior
  // product this one is a modified version of, used as fallback-only GTM
  // grounding. See lib/predecessor-product-context.ts.
  predecessorRef?: string | null;
}

export interface MockAnalysis {
  id: string;
  orgId: string;
  userId: string;
  projectId: string | null;
  status: "PENDING" | "RUNNING" | "COMPLETE" | "FAILED" | "CANCELLED";
  phase: number;
  context?: any;
  phase0Result?: any;
  phase1Result: any;
  phase2Result: any;
  phase3Result: any;
  pendingQuestion?: { question: string; foundSoFar?: string } | null;
  phase1BrandProgress?: any[] | null;
  relatedProducts?: any[];
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface MockCompetitorAnalysis {
  id: string;
  analysisId: string;
  competitorId: string | null;
  name: string;
  tier: string;
  threatScore: number;
  category: string;
  tags: string[];
  insight: string | null;
  pricePoint: string | null;
  standoutFeature: string | null;
}

export interface MockReport {
  id: string;
  orgId: string;
  userId?: string;
  projectId: string | null;
  analysisId?: string | null;
  title: string;
  content: any; // TipTap JSON / full section bundle
  status: string;
  fileUrl: string | null;
  // Report section data (kept snake_case to match the Supabase column
  // contract that the UI and lib/project-context.ts read directly)
  competitive_analysis?: any;
  pricing_analysis?: any;
  go_to_market?: any;
  content_form?: any;
  product_knowledge?: any;
  driveUrl?: string | null;
  driveFileId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockArtwork {
  id: string;
  projectId: string;
  fileUrl: string;
  fileName: string;
  purpose: string;
  aiSuggestions: any;
  createdAt: Date;
}

export interface MockOutput {
  id: string;
  projectId: string;
  outputType: string;
  content: any;
  html?: string;
  driveUrl?: string;
  driveFileId?: string;
  createdAt: Date;
}

export interface MockDocument {
  id: string;
  projectId: string;
  docType: string;
  status: string;
  driveUrl?: string | null;
  driveFileId?: string | null;
  // Separate from driveUrl/driveFileId above — see lib/db/documents.ts's
  // DocumentRow.xlsx_drive_url comment for why they're kept apart.
  xlsxDriveUrl?: string | null;
  xlsxDriveFileId?: string | null;
  snapshotId?: string | null;
  // Brand Voice Guide work — which guide version was active at generation
  // time, see lib/db/documents.ts's setDocumentVoiceGuide.
  voiceGuideId?: string | null;
  voiceGuideVersion?: number | null;
  // Uploaded TDS Ingestion — see lib/db/documents.ts's DocumentRow.source_doc_versions.
  sourceDocVersions?: Record<string, { id: string; version: number }> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockDocumentField {
  id: string;
  documentId: string;
  fieldId: string;
  section: string;
  question: string;
  answer: string | null;
  // The AI/derivation-generated value, preserved across manual edits to
  // `answer` — see supabase_schema.sql's ai_answer column comment.
  aiAnswer: string | null;
  source: string | null;
  sourceDetail: any;
  flagged: boolean;
  owner: string | null;
  notes: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface MockDocumentFieldHistory {
  id: string;
  documentFieldId: string;
  answer: string | null;
  changedBy: string | null;
  changedAt: Date;
}

export interface MockProductSnapshot {
  id: string;
  projectId: string;
  sourceUrl: string | null;
  asin: string | null;
  rawData: any;
  capturedAt: Date;
}

export interface MockSectionProvenance {
  id: string;
  productKey: string;
  section: string;
  analysisId: string | null;
  productName: string | null;
  tiers: any[];
  queries: any[];
  resolvedAt: Date;
}

export interface MockProjectGenerationState {
  projectId: string;
  phase: string;
  status: string;
  errorMessage: string | null;
  updatedAt: Date;
}

export interface MockDeckTemplate {
  id: string;
  name: string;
  // Dev-without-Supabase fallback: the .pptx itself as base64, same
  // fallback trick used elsewhere in this codebase (e.g. the artwork
  // route) when a real Storage bucket isn't configured.
  fileBase64: string;
  fileName: string | null;
  fileSizeBytes: number | null;
  slideCount: number;
  placeholderMap: any; // DeckPlaceholderMap, see lib/deck-types.ts
  isActive: boolean;
  uploadedBy: string | null;
  uploadedAt: Date;
  updatedAt: Date;
}

// Direct clone of MockDeckTemplate for the official GTM workbook export
// feature (lib/db/gtm-workbook-templates.ts) — same base64-fallback
// precedent.
export interface MockGtmWorkbookTemplate {
  id: string;
  name: string;
  fileBase64: string;
  fileName: string | null;
  fileSizeBytes: number | null;
  sheetSummary: any; // GtmWorkbookSheetSummary, see lib/db/gtm-workbook-templates.ts
  isActive: boolean;
  uploadedBy: string | null;
  uploadedAt: Date;
  updatedAt: Date;
  // GTM Multi-Template work — which industry this template serves; exactly
  // one row per industry may have isActive:true (enforced in application
  // code here, a real scoped unique index in Supabase — see
  // lib/db/gtm-workbook-templates.ts).
  industry: "barber" | "beauty";
  // Part 1.2's "template inspection on upload" output for a beauty upload —
  // null for barber (barber IS the reference template, nothing to diff).
  fieldInspection: any | null;
}

// Brand Voice Guide work — versioned, brand-scoped voice/tone/terminology
// guide (lib/db/brand-voice-guides.ts). A new edit is a new row (version =
// previous max for that brand + 1); isActive is scoped per-brand, not
// globally.
export interface MockBrandVoiceGuide {
  id: string;
  brand: string;
  content: string;
  version: number;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Uploaded TDS Ingestion — externally-authored TDS/Spec Sheet/Sales Kit/
// Other files a team uploads per project (lib/db/uploaded-source-docs.ts).
// Versioned per (projectId, docType): a replacement upload auto-activates
// immediately, deactivating the prior active row for that project+type.
export interface MockUploadedSourceDoc {
  id: string;
  projectId: string;
  docType: string; // 'tds' | 'spec_sheet' | 'sales_kit' | 'other'
  fileBase64: string;
  fileName: string | null;
  fileSizeBytes: number | null;
  mimeType: string | null;
  version: number;
  isActive: boolean;
  fullText: string | null;
  extractionStatus: string; // pending | complete | failed
  factsExtractionStatus?: string; // not_attempted | complete | failed
  // {label, text}[] (lib/tds-doc-extract.ts's ExtractedLocation) — restores
  // page/sheet attribution for facts derived after initial upload (see
  // supabase_schema.sql Section 53's own comment on why this was missing).
  locations?: { label: string; text: string }[];
  uploadedBy: string | null;
  uploadedAt: Date;
  updatedAt: Date;
}

// Structured facts extracted from a MockUploadedSourceDoc row
// (lib/db/extracted-facts.ts) — one row per (sourceDocId, fieldId).
export interface MockExtractedFact {
  id: string;
  sourceDocId: string;
  projectId: string;
  fieldId: string;
  value: string;
  rawText: string | null;
  sourceLocation: string | null;
  confirmedByUser: boolean;
  // 'grounded_field' | 'narrative_signal' — see supabase_schema.sql Section 53.
  factType?: string;
  // 'high' | 'medium' | 'low'
  confidence?: string;
  createdAt: Date;
  updatedAt: Date;
}

// One row per project, tracks the automatic cross-document fill chain
// (Sources upload -> extract -> fill GTM -> fill Content Form) — see
// supabase_schema.sql Section 53's own header comment.
export interface MockDocumentFillState {
  projectId: string;
  status: string; // idle | running | complete | failed
  steps: string[];
  currentStepIndex: number;
  triggeredByDocId: string | null;
  triggeredByFileName: string | null;
  results: Record<string, any>;
  startedAt: Date | null;
  updatedAt: Date;
}

export interface MockProjectDeck {
  id: string;
  projectId: string;
  templateId: string | null;
  status: string; // pending | generating | complete | failed
  fileBase64: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  placeholderValues: any;
  slidesRemoved: number[];
  errorMessage: string | null;
  gtmSnapshotAt: string | null;
  generatedAt: Date | null;
  driveUrl: string | null;
  driveFileId: string | null;
  createdAt: Date;
}

export interface MockBrandCategory {
  id: string;
  slug: string;
  name: string;
  productTypes: string[];
  audience: string | null; // 'professional' | 'retail'
  createdAt: Date;
}

export interface MockLegacyBrand {
  id: string;
  categoryId: string;
  brandName: string;
  aliases: string[];
  // Brand's own official website domain(s) — see lib/db/legacy-brands.ts's
  // LegacyBrandRow.official_domains for the full rationale.
  officialDomains: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// GTM's Manufacturer auto-detect cascade (lib/gtm-tier6-inference.ts) falls
// back to this admin-editable name-prefix map when a project has no catalog
// record to read `brand` from directly. See lib/db/brand-name-hints.ts.
export interface MockBrandNameHint {
  id: string;
  brand: string;
  namePrefixes: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// GTM style-corpus work — admin-editable narrative kernel (origin story,
// logo meaning, voice notes) for a named product line ("Homie", "360
// Jeezy"). See lib/db/collections.ts.
export interface MockCollection {
  id: string;
  name: string;
  narrativeKernel: string;
  logoMeaning: string;
  voiceNotes: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockMotorFamily {
  id: string;
  familyKey: string;
  label: string;
  domain: string; // 'clipper_trimmer_shaver' | 'beauty'
  aliases: string[];
  modifier: boolean;
  adjacentFamilies: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// Admin-editable grooming/beauty industry gate — the allow/block category
// segments, required/disqualifying keywords, trimmer co-signal words,
// component disqualifiers, cross-domain use phrases, and the same-tool-kind
// confidence threshold that lib/grooming-industry-gate.ts's
// passesGroomingIndustryGate() checks candidates against BEFORE motor/price
// scoring. One flat, ruleType-discriminated array (not six) — same
// precedent as motorTechSearchMisses' brandName-discriminator reuse instead
// of a forked array. Always-seeded, same precedent as motorFamilies/toolTypes.
export interface MockGroomingGateRule {
  id: string;
  ruleType: string;
  value: string;
  label: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// Per-candidate rejection audit log — real usage data (starts empty), same
// non-seeded precedent as competitorCorrections/motorTechSearchMisses.
export interface MockGroomingGateIncident {
  id: string;
  analysisId: string | null;
  phase: string; // 'phase1' | 'phase2' | 'manual_removal'
  candidateName: string | null;
  candidateAsin: string | null;
  candidateBrand: string | null;
  categoryPath: string | null;
  failedRule: string | null;
  detail: string | null;
  dismissedAt: Date | null;
  createdAt: Date;
}

export interface MockToolType {
  id: string;
  typeKey: string;
  label: string;
  aliases: string[];
  family: string | null; // 'clipper_trimmer_shaver' | 'beauty' | null (either)
  // Which evidence-backed criterion dominates composite scoring for this
  // type — 'motor' (existing motor taxonomy/extraction), 'heat_technology'
  // (the parallel plate/heat taxonomy for motorless styling tools), or
  // 'none' (neither applies — that scoring_profiles weight slot should be 0).
  primaryCriterion: "motor" | "heat_technology" | "none";
  enabled: boolean;
  custom: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockScoringProfile {
  id: string;
  // null = the global default/fallback profile, used for any tool type
  // (including every custom one) with no row of its own.
  typeKey: string | null;
  motorWeight: number;
  priceWeight: number;
  featureWeight: number;
  updatedAt: Date;
}

export interface MockHeatTechFamily {
  id: string;
  familyKey: string;
  label: string;
  aliases: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockBrandedHeatTechName {
  id: string;
  brandName: string;
  brandedTerm: string;
  familyKey: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// Real usage data (a user manually correcting a wrongly-selected
// competitor) — starts empty, same non-seeded precedent as
// brandedMotorNames/brandedHeatTechNames above. expiredAt (not a hard
// delete) lets an admin turn a learned rule off while keeping it
// inspectable in the audit log — see lib/db/competitor-corrections.ts.
export interface MockCompetitorCorrection {
  id: string;
  analysisId: string | null;
  projectId: string | null;
  toolType: string;
  motorFamily?: string | null;
  heatTechFamily?: string | null;
  priceBand?: string | null;
  oldAsin: string;
  oldTitle?: string | null;
  // Nullable — a "Remove" action (no replacement chosen yet) records a
  // correction with newAsin: null; correctionType distinguishes this from
  // the original replace flow, which always populates newAsin.
  newAsin: string | null;
  newTitle?: string | null;
  reason: string;
  note?: string | null;
  userId?: string | null;
  expiredAt?: Date | null;
  createdAt: Date;
  correctionType?: string; // 'replace' (default) | 'remove'
}

export interface MockBrandedMotorName {
  id: string;
  brandName: string;
  brandedTerm: string;
  familyKey: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// Our own product lineup — selectable at the analyze form's initial stage
// to auto-fill every analysis field instead of manual entry (replaces the
// old hardcoded lib/stylecraft-products.ts array). heatTechFamily/
// heatTechBranded are parallel to motorFamily/motorBranded (same
// sibling-column precedent as MockCompetitorCorrection above) — a motorless
// styling tool populates the heat pair instead, per tool_types
// primaryCriterion. importFlags carries admin-review badges raised during
// seed/re-import normalization ('incomplete', 'tool_type_needs_review',
// 'motor_needs_confirmation', 'heat_tech_needs_confirmation') — never a
// silent guess. active=false is a soft-deactivate, never a hard delete.
export interface MockCatalogProduct {
  id: string;
  name: string;
  industry: string;
  targetMarket: string;
  toolType: string;
  targetPrice: number | null;
  description: string | null;
  motorFamily: string | null;
  motorBranded: string | null;
  heatTechFamily: string | null;
  heatTechBranded: string | null;
  active: boolean;
  importFlags: string[];
  source: string;
  // Section 35/36 (supabase_schema.sql) — GTM's Comparison Chart picker and
  // Manufacturer auto-detect cascade need these. Optional/nullable so the
  // 62 existing seed literals below don't all need editing individually —
  // seedCatalogProductDefaults() backfills brand: "StyleCraft" on push
  // (every current seed row genuinely IS StyleCraft-sourced), sku stays
  // null until an admin fills it in (no SKU data exists in the seed source).
  brand?: string | null;
  sku?: string | null;
  // Section 38 — GTM style-corpus work. productKind defaults to "tool" for
  // every existing seed row (accurate — none of them are accessories);
  // parentSku/collection stay null/undefined until an admin sets them.
  productKind?: string;
  parentSku?: string | null;
  collection?: string | null;
  // GTM workbook export work — BOX ONLY's UPC row; stays null until an
  // admin/import sets it.
  upc?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockCompetitorMatchingConfig {
  motorWeight: number;
  priceWeight: number;
  featureWeight: number;
  updatedAt: Date;
}

export interface MockMarketingDefaults {
  languages: string;
  updatedAt: Date;
}

export interface MockFaq {
  id: string;
  category: string;
  question: string;
  answer: string;
  sortOrder: number;
  enabled: boolean;
  feature?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockFeatureFlag {
  flagName: string;
  enabled: boolean;
  updatedAt: Date;
}

export interface MockFaqVote {
  id: string;
  faqId: string;
  vote: "up" | "down";
  createdAt: Date;
}

export interface MockFaqSearchMiss {
  id: string;
  term: string;
  createdAt: Date;
}

export interface MockMotorTechMiss {
  id: string;
  term: string;
  // Set only for a branded-name miss (lib/db/motor-families.ts's
  // logBrandedMotorMiss) — null for the original plain-motorTech-miss case.
  brandName?: string | null;
  aiGuessedFamily?: string | null;
  createdAt: Date;
}

export interface MockSupportMessage {
  id: string;
  userId: string;
  name: string;
  email: string;
  topic: string;
  message: string;
  context: Record<string, any> | null;
  screenshotUrl: string | null;
  emailStatus: "pending" | "sent" | "failed";
  emailError: string | null;
  ackEmailStatus: "pending" | "sent" | "failed";
  adminNotificationRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockAuthEvent {
  id: string;
  eventType: string;
  email: string | null;
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  detail: string | null;
  createdAt: Date;
}

export interface MockNote {
  id: string;
  competitorId: string;
  content: string;
  createdAt: Date;
}

// Snapshot JSON turns Date fields into ISO strings — convert the known
// Date-typed fields back so downstream code (.getTime(), .toLocaleDateString())
// keeps working after a reload.
function reviveDateFields(items: any[] | undefined, fields: string[]): any[] {
  return (items ?? []).map((item: any) => {
    const copy: any = { ...item };
    for (const field of fields) {
      if (copy[field] != null) copy[field] = new Date(copy[field]);
    }
    return copy;
  });
}

function reviveDates(data: any): any {
  return {
    competitors: reviveDateFields(data.competitors, ["createdAt", "updatedAt"]),
    projects: reviveDateFields(data.projects, ["createdAt", "updatedAt", "lastUsedAt"]),
    analyses: reviveDateFields(data.analyses, ["createdAt", "completedAt"]),
    competitorAnalyses: data.competitorAnalyses ?? [],
    reports: reviveDateFields(data.reports, ["createdAt", "updatedAt"]),
    notes: reviveDateFields(data.notes, ["createdAt"]),
    artwork: reviveDateFields(data.artwork, ["createdAt"]),
    outputs: reviveDateFields(data.outputs, ["createdAt"]),
  };
}

class MemoryDatabase {
  competitors: MockCompetitor[] = [];
  projects: MockProject[] = [];
  analyses: MockAnalysis[] = [];
  competitorAnalyses: MockCompetitorAnalysis[] = [];
  reports: MockReport[] = [];
  notes: MockNote[] = [];
  artwork: MockArtwork[] = [];
  outputs: MockOutput[] = [];
  documents: MockDocument[] = [];
  documentFields: MockDocumentField[] = [];
  documentFieldHistory: MockDocumentFieldHistory[] = [];
  productSnapshots: MockProductSnapshot[] = [];
  // Deliberately excluded from saveSnapshot/loadSnapshot/reviveDates below —
  // same precedent as productSnapshots itself: doesn't survive a local
  // dev-server restart without Supabase configured, which is expected.
  sectionProvenance: MockSectionProvenance[] = [];
  projectGenerationState: MockProjectGenerationState[] = [];
  // Same non-persisted-across-restart precedent as productSnapshots above —
  // fine at dev scale, Supabase is the real store in production.
  deckTemplates: MockDeckTemplate[] = [];
  gtmWorkbookTemplates: MockGtmWorkbookTemplate[] = [];
  // Same always-seeded precedent as collections/brandNameHints — real
  // default StyleCraft voice guide content, not an empty admin table.
  brandVoiceGuides: MockBrandVoiceGuide[] = [];
  // Uploaded TDS Ingestion — starts empty, real usage data, not a seeded
  // default (there's no sensible default TDS to seed per-project).
  uploadedSourceDocs: MockUploadedSourceDoc[] = [];
  extractedFacts: MockExtractedFact[] = [];
  documentFillStates: MockDocumentFillState[] = [];
  projectDecks: MockProjectDeck[] = [];
  // Unlike deckTemplates/projectDecks (an empty admin-fills-it-in feature),
  // this registry must be non-empty in local dev without Supabase too —
  // real default behavior mirroring the seeded supabase_schema.sql rows.
  // seedBrandRegistryDefaults() runs unconditionally below (not gated on
  // loadSnapshot() like seed()), since these arrays are never part of the
  // snapshot file and would otherwise silently stay empty across every
  // restart that finds an existing snapshot on disk.
  brandCategories: MockBrandCategory[] = [];
  legacyBrands: MockLegacyBrand[] = [];
  // Same always-seeded (not snapshot-gated) precedent as brandCategories/
  // legacyBrands above — real default competitor-matching config, not an
  // empty admin table.
  motorFamilies: MockMotorFamily[] = [];
  // Same always-seeded (not snapshot-gated) precedent as motorFamilies above
  // — real default Tool Type configuration (the 9 built-ins), not an empty
  // admin table. Custom admin/user-added types start absent, added via
  // lib/db/tool-types.ts's addToolType.
  toolTypes: MockToolType[] = [];
  // Real usage data (an analysis' free-text Motor Technology that didn't
  // match any taxonomy family) — same non-seeded, non-persisted-across-
  // restart precedent as faqSearchMisses just below.
  motorTechSearchMisses: MockMotorTechMiss[] = [];
  // Admin-entered brand -> proprietary motor name -> family mappings.
  // seedBrandedMotorNameDefaults() below always seeds the 6 confirmed
  // StyleCraft entries (real default data, same precedent as motorFamilies)
  // — further ad-hoc admin additions for other brands still just push onto
  // this array, same as legacy brands' official_domains.
  brandedMotorNames: MockBrandedMotorName[] = [];
  // Same always-seeded precedent as motorFamilies/toolTypes above — real
  // default product-catalog data (21 GTM-forms products + deduped survivors
  // of the old lib/stylecraft-products.ts array), not an empty admin table.
  catalogProducts: MockCatalogProduct[] = [];
  // Same always-seeded precedent as legacyBrands/motorFamilies above — real
  // default StyleCraft/Gamma+ name-prefix hints for GTM's Manufacturer
  // auto-detect cascade, not an empty admin table.
  brandNameHints: MockBrandNameHint[] = [];
  // Same always-seeded precedent — real default Homie/360 Jeezy collection
  // kernels (lib/db/collections.ts), not an empty admin table.
  collections: MockCollection[] = [];
  competitorMatchingConfig: MockCompetitorMatchingConfig = { motorWeight: 0.45, priceWeight: 0.35, featureWeight: 0.2, updatedAt: new Date() };
  // GTM workbook export work — Marketing Direction's "Languages" field org
  // default (Settings-editable, same singleton-row precedent as
  // competitorMatchingConfig above).
  marketingDefaults: MockMarketingDefaults = {
    languages: "English (primary). Spanish (secondary, for retail/DTC market reach). French Canadian",
    updatedAt: new Date(),
  };
  // Replaces competitorMatchingConfig above — per-tool-type weight profiles.
  // Same always-seeded precedent as motorFamilies/toolTypes.
  scoringProfiles: MockScoringProfile[] = [];
  // Full parallel to motorFamilies/brandedMotorNames for the new Heat/Plate
  // Technology criterion (motorless styling tools) — same seeding precedent.
  heatTechFamilies: MockHeatTechFamily[] = [];
  brandedHeatTechNames: MockBrandedHeatTechName[] = [];
  // Real usage data (users correcting wrongly-selected competitors) — same
  // non-seeded, non-persisted-across-restart precedent as
  // brandedMotorNames/faqVotes above.
  competitorCorrections: MockCompetitorCorrection[] = [];
  // Grooming/beauty industry gate — always-seeded, same precedent as
  // motorFamilies/toolTypes above (real default reference config).
  groomingGateRules: MockGroomingGateRule[] = [];
  // Real usage data (per-candidate gate-rejection audit trail) — same
  // non-seeded precedent as competitorCorrections just above.
  groomingGateIncidents: MockGroomingGateIncident[] = [];
  // Same always-seeded precedent — real default Help content, not an
  // empty admin table. Votes/search-misses start empty (real usage data).
  faqs: MockFaq[] = [];
  faqVotes: MockFaqVote[] = [];
  faqSearchMisses: MockFaqSearchMiss[] = [];
  // Always-seeded (same precedent as motorFamilies/competitorMatchingConfig
  // above) — real default flag state, not an empty admin table.
  featureFlags: MockFeatureFlag[] = [
    { flagName: "tds_enabled", enabled: true, updatedAt: new Date() },
    { flagName: "buyer_sentiment_enabled", enabled: false, updatedAt: new Date() },
    { flagName: "news_updates_enabled", enabled: false, updatedAt: new Date() },
  ];
  // Real usage data (Contact Support submissions) — same non-seeded,
  // non-persisted-across-restart precedent as faqVotes/faqSearchMisses.
  supportMessages: MockSupportMessage[] = [];
  // Auth audit log / login-rate-limit tracking — same non-seeded precedent.
  authEvents: MockAuthEvent[] = [];

  constructor() {
    if (IS_SERVERLESS || !this.loadSnapshot()) {
      this.seed();
    }
    this.seedBrandRegistryDefaults();
    this.seedMotorFamilyDefaults();
    this.seedToolTypeDefaults();
    this.seedScoringProfileDefaults();
    this.seedHeatTechFamilyDefaults();
    this.seedBrandedMotorNameDefaults();
    this.seedCatalogProductDefaults();
    this.seedBrandNameHintDefaults();
    this.seedCollectionDefaults();
    this.seedBrandVoiceGuideDefaults();
    this.seedFaqDefaults();
    this.seedGroomingGateRuleDefaults();
    if (!IS_SERVERLESS) this.startAutosave();
  }

  private loadSnapshot(): boolean {
    if (IS_SERVERLESS) return false;
    try {
      if (!fs.existsSync(SNAPSHOT_PATH)) return false;
      const raw = fs.readFileSync(SNAPSHOT_PATH, "utf-8");
      const data = reviveDates(JSON.parse(raw));
      this.competitors = data.competitors ?? [];
      this.projects = data.projects ?? [];
      this.analyses = data.analyses ?? [];
      this.competitorAnalyses = data.competitorAnalyses ?? [];
      this.reports = data.reports ?? [];
      this.notes = data.notes ?? [];
      this.artwork = data.artwork ?? [];
      this.outputs = data.outputs ?? [];
      return true;
    } catch (e) {
      console.warn("Failed to load memoryDb snapshot, seeding fresh:", e);
      return false;
    }
  }

  saveSnapshot() {
    if (IS_SERVERLESS) return;
    try {
      fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
      const data = {
        competitors: this.competitors,
        projects: this.projects,
        analyses: this.analyses,
        competitorAnalyses: this.competitorAnalyses,
        reports: this.reports,
        notes: this.notes,
        artwork: this.artwork,
        outputs: this.outputs,
      };
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data));
    } catch (e) {
      console.warn("Failed to save memoryDb snapshot:", e);
    }
  }

  private startAutosave() {
    const g = globalThis as unknown as { __memDbAutosaveStarted?: boolean };
    if (g.__memDbAutosaveStarted) return;
    g.__memDbAutosaveStarted = true;

    setInterval(() => this.saveSnapshot(), AUTOSAVE_INTERVAL_MS);
    const flushAndExit = () => {
      this.saveSnapshot();
      process.exit(0);
    };
    process.on("exit", () => this.saveSnapshot());
    process.on("SIGINT", flushAndExit);
    process.on("SIGTERM", flushAndExit);
  }

  seed() {
    // Seed initial competitors
    this.competitors = [
      {
        id: "comp_1",
        orgId: "dev_org_id",
        name: "Wahl Professional",
        website: "https://www.wahlpro.com",
        description: "Leading manufacturer of professional clippers, trimmers, and grooming accessories.",
        status: "ACTIVE",
        tags: ["luxury", "corded", "professional"],
        logoUrl: "https://www.google.com/s2/favicons?sz=64&domain=wahlpro.com",
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      },
      {
        id: "comp_2",
        orgId: "dev_org_id",
        name: "BaBylissPRO",
        website: "https://babylisspro.com",
        description: "Premium hair care and grooming tools utilizing advanced motor technology.",
        status: "ACTIVE",
        tags: ["professional", "cordless", "brushless"],
        logoUrl: "https://www.google.com/s2/favicons?sz=64&domain=babylisspro.com",
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
      {
        id: "comp_3",
        orgId: "dev_org_id",
        name: "Dyson Hair Care",
        website: "https://www.dyson.com",
        description: "High-end consumer and professional styling tools with specialized high-velocity motors.",
        status: "MONITORING",
        tags: ["luxury", "technology", "consumer"],
        logoUrl: "https://www.google.com/s2/favicons?sz=64&domain=dyson.com",
        createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      }
    ];

    // No default mock projects
    this.projects = [];

    // Seed default notes
    this.notes = [
      {
        id: "note_1",
        competitorId: "comp_1",
        content: "Strong brand presence in barbershops. Heavy retail distribution.",
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
      {
        id: "note_2",
        competitorId: "comp_2",
        content: "Their FX3 line is gaining traction. Priced at $210, competitive.",
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      }
    ];
  }

  // Mirrors supabase_schema.sql's seed INSERTs exactly (same 4 categories,
  // same brands/aliases/sort_order) — called unconditionally (see
  // constructor) so local dev without Supabase always has real default
  // behavior, not an empty registry. No-op if already seeded (e.g. called
  // twice via a hot reload sharing the global instance).
  seedBrandRegistryDefaults() {
    if (this.brandCategories.length > 0) return;

    const now = new Date();
    const categoryDefs: { slug: string; name: string; productTypes: string[]; audience: string }[] = [
      { slug: "legacy_professional_clippers", name: "Legacy Professional Clippers, Trimmers, and Shavers", productTypes: ["clipper", "trimmer", "shaver"], audience: "professional" },
      { slug: "legacy_retail_clippers", name: "Legacy Retail Clippers, Trimmers, and Shavers", productTypes: ["clipper", "trimmer", "shaver"], audience: "retail" },
      { slug: "professional_beauty", name: "Professional Beauty", productTypes: ["dryer", "iron", "styler", "brush"], audience: "professional" },
      { slug: "retail_beauty", name: "Retail Beauty", productTypes: ["dryer", "iron", "styler", "brush"], audience: "retail" },
    ];

    // Official domain(s) per brand — seeded best-effort from the brand's
    // own known site(s), searched FIRST by lib/brand-site-discovery.ts
    // before falling through to Amazon. Runtime discovery attempts are
    // what actually verify these are live (see the admin "Domain health"
    // panel) — a wrong/stale seed here just means that one brand's
    // brand-site attempts come up empty, never breaks anything.
    const brandDefs: Record<string, { name: string; aliases: string[]; officialDomains: string[] }[]> = {
      legacy_professional_clippers: [
        { name: "Wahl", aliases: [], officialDomains: ["wahlpro.com", "wahl.com"] },
        { name: "Andis", aliases: [], officialDomains: ["andis.com"] },
        { name: "Oster", aliases: [], officialDomains: ["osterpro.com"] },
        { name: "BaByliss", aliases: ["BaBylissPRO", "Babyliss Pro"], officialDomains: ["babylisspro.com"] },
        { name: "TPOB", aliases: ["The Profession Of Barbering"], officialDomains: ["tpobshop.com"] },
        { name: "Cocco", aliases: [], officialDomains: ["coccohaircutting.com"] },
        { name: "JRL", aliases: [], officialDomains: ["jrlprofessional.com"] },
      ],
      legacy_retail_clippers: [
        { name: "Wahl", aliases: [], officialDomains: ["wahlpro.com", "wahl.com"] },
        { name: "Andis", aliases: [], officialDomains: ["andis.com"] },
        { name: "Oster", aliases: [], officialDomains: ["osterpro.com"] },
        { name: "Panasonic", aliases: [], officialDomains: ["panasonic.com"] },
        { name: "Conair", aliases: [], officialDomains: ["conair.com"] },
        { name: "Manscaped", aliases: [], officialDomains: ["manscaped.com"] },
        { name: "Remington", aliases: [], officialDomains: ["remingtonproducts.com"] },
      ],
      professional_beauty: [
        { name: "BaByliss", aliases: ["BaBylissPRO", "Babyliss Pro"], officialDomains: ["babylisspro.com"] },
        { name: "GHD", aliases: [], officialDomains: ["ghdhair.com"] },
        { name: "Paul Mitchell", aliases: [], officialDomains: ["paulmitchell.com"] },
        { name: "Bio Ionic", aliases: [], officialDomains: ["bioionic.com"] },
        { name: "Dyson", aliases: [], officialDomains: ["dyson.com"] },
        { name: "Shark", aliases: [], officialDomains: ["sharkbeauty.com"] },
        { name: "Amika", aliases: [], officialDomains: ["loveamika.com"] },
        { name: "Olivia Garden", aliases: [], officialDomains: ["oliviagarden.com"] },
        { name: "T3", aliases: [], officialDomains: ["t3micro.com"] },
      ],
      retail_beauty: [
        { name: "Conair", aliases: [], officialDomains: ["conair.com"] },
        { name: "Revlon", aliases: [], officialDomains: ["revlonhairtools.com"] },
        { name: "L'Oreal", aliases: ["L'Oréal", "LOreal", "L Oreal"], officialDomains: [] },
        { name: "Hot Tools", aliases: ["Hot Tools Professional"], officialDomains: ["hottools.com"] },
        { name: "Drybar", aliases: [], officialDomains: ["thedrybar.com"] },
        { name: "Dyson", aliases: [], officialDomains: ["dyson.com"] },
        { name: "Shark", aliases: [], officialDomains: ["sharkbeauty.com"] },
      ],
    };

    for (const cat of categoryDefs) {
      const categoryId = `bcat_${cat.slug}`;
      this.brandCategories.push({
        id: categoryId,
        slug: cat.slug,
        name: cat.name,
        productTypes: cat.productTypes,
        audience: cat.audience,
        createdAt: now,
      });
      brandDefs[cat.slug].forEach((b, i) => {
        this.legacyBrands.push({
          id: `lbrand_${cat.slug}_${i}`,
          categoryId,
          brandName: b.name,
          aliases: b.aliases,
          officialDomains: b.officialDomains,
          enabled: true,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        });
      });
    }
  }

  // Mirrors supabase_schema.sql's motor_families seed INSERT + Section 25's
  // canonical-7-family restructure exactly — this seeds the restructure's
  // END STATE directly (memoryDb has no migration concept, it just seeds
  // once), not the UPDATE/INSERT steps themselves. "linear" and
  // "brushless_digital" stay present but disabled (folded into Pivot and
  // Brushless respectively) rather than removed, matching the SQL's
  // non-destructive disable. Array ORDER matters — it becomes sort_order,
  // which matchMotorFamily checks in sequence: "vector" must come before
  // "magnetic" (matching the real SQL's sort_order, where "vector" kept
  // magnetic_vector's original low sort_order=1 and the new "magnetic" row
  // was appended last at sort_order=8) so text containing the more specific
  // "electromagnetic vector" resolves to Vector, not Magnetic, before
  // Magnetic's own bare "electromagnetic" alias gets a chance to match.
  seedMotorFamilyDefaults() {
    if (this.motorFamilies.length > 0) return;
    const now = new Date();
    const defs: { key: string; label: string; domain: string; aliases: string[]; modifier?: boolean; adjacent?: string[]; enabled?: boolean }[] = [
      { key: "rotary", label: "Rotary Motor", domain: "clipper_trimmer_shaver", aliases: ["rotary", "rotary motor"] },
      { key: "vector", label: "Vector Motor", domain: "clipper_trimmer_shaver", aliases: ["vector", "in3", "electromagnetic vector"] },
      { key: "pivot", label: "Pivot Motor", domain: "clipper_trimmer_shaver", aliases: ["pivot", "pivot motor", "linear", "linear magnetic"] },
      { key: "linear", label: "Linear", domain: "clipper_trimmer_shaver", aliases: ["linear magnetic"], enabled: false },
      { key: "ac_motor", label: "AC Motor", domain: "beauty", aliases: ["ac motor", "ac", "alternating current"] },
      { key: "dc_motor", label: "DC Motor", domain: "beauty", aliases: ["dc motor", "dc", "direct current"] },
      { key: "brushless_digital", label: "Brushless Digital", domain: "beauty", aliases: ["brushless digital motor", "digital motor"], enabled: false },
      { key: "brushless", label: "Brushless Motor", domain: "clipper_trimmer_shaver", aliases: ["brushless", "bldc", "brushless dc", "digital brushless", "eon digital brushless", "digital motor", "brushless digital motor"] },
      { key: "magnetic", label: "Magnetic Motor", domain: "clipper_trimmer_shaver", aliases: ["magnetic", "electromagnetic"] },
    ];
    defs.forEach((d, i) => {
      this.motorFamilies.push({
        id: `mfam_${d.key}`,
        familyKey: d.key,
        label: d.label,
        domain: d.domain,
        aliases: d.aliases,
        modifier: d.modifier ?? false,
        adjacentFamilies: d.adjacent ?? [],
        enabled: d.enabled ?? true,
        sortOrder: i,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 56 grooming_gate_rules seed —
  // the ticket's own allow/block category segments, required/disqualifying
  // keywords, trimmer co-signal words, component disqualifiers, cross-
  // domain use phrases, and confidence threshold. Order within each
  // ruleType doesn't matter for matching (unlike motorFamilies' aliases),
  // so sortOrder here is just a stable display order per group.
  seedGroomingGateRuleDefaults() {
    if (this.groomingGateRules.length > 0) return;
    const now = new Date();
    const defs: { ruleType: string; value: string; label?: string }[] = [
      // Positive category signals (Beauty & Personal Care taxonomy)
      ...["Beauty & Personal Care", "Hair Care", "Hair Cutting Tools", "Hair Clippers", "Hair Trimmers", "Shave & Hair Removal", "Electric Shavers", "Men's Grooming", "Hair Dryers", "Hair Styling Tools", "Flat Irons", "Curling Irons", "Tools & Accessories"].map(v => ({ ruleType: "allow_category_segment", value: v })),
      // Negative category signals (never a grooming/beauty product)
      ...["Patio, Lawn & Garden", "Tools & Home Improvement", "Power & Hand Tools", "Outdoor Power Tools", "Automotive", "Kitchen & Dining", "Appliances", "Industrial & Scientific", "Pet Supplies", "Toys & Games", "Sports & Outdoors", "Garden", "Lawn Mowers", "String Trimmers", "Weed Trimmers", "Hedge Trimmers", "Brush Cutters", "Drills", "Saws"].map(v => ({ ruleType: "block_category_segment", value: v })),
      // Required product-type keywords (title/description must contain at least one).
      // "dryer" (bare, alongside the existing "hair dryer"/"blow dryer" phrases)
      // covers real Amazon titles like "Conair InfinitiPRO Dryer" that never
      // spell out "hair" — consistent with the "dryer" tool type's own alias
      // list (lib/db/tool-types.ts's seed) already treating bare "dryer" as
      // sufficient evidence.
      ...["hair", "clipper", "trimmer", "shaver", "foil", "beard", "barber", "grooming", "haircut", "dryer", "hair dryer", "blow dryer", "flat iron", "curling", "styling", "razor", "edger", "lining", "fade"].map(v => ({ ruleType: "required_keyword", value: v })),
      // Disqualifying keywords (any hit rejects, unless our product is itself pet-grooming for the pet/dog/animal ones)
      ...["weed", "grass", "lawn", "garden", "hedge", "string trimmer", "brush cutter", "wacker", "whacker", "drill", "saw", "sander", "tire", "engine", "kitchen", "blender", "vacuum", "wood", "metal cutting", "automotive"].map(v => ({ ruleType: "disqualifying_keyword", value: v })),
      ...["dog grooming", "pet grooming", "animal grooming"].map(v => ({ ruleType: "disqualifying_keyword", value: v, label: "Skipped when our own product is pet grooming" })),
      // "Trimmer" is ambiguous across industries — require one of these to co-occur
      ...["beard", "hair", "barber", "body", "mustache", "ear", "nose"].map(v => ({ ruleType: "trimmer_cosignal_keyword", value: v })),
      // Bare motor/component/OEM-part listings, not a finished grooming tool
      ...["brushless motor", "dc motor", "outrunner motor", "motor kit", "replacement motor", "esc", "propeller", "stator", "armature", "dynamo", "gear motor", "servo motor"].map(v => ({ ruleType: "component_disqualifier", value: v })),
      // Cross-domain use phrases — reject regardless of motor match
      ...["surfboard", "efoil", "drone", "rc car", "boat", "underwater", "marine", "thruster", "lawn mower"].map(v => ({ ruleType: "cross_domain_use_phrase", value: v })),
      { ruleType: "confidence_threshold", value: "0.4", label: "Minimum same-tool-kind confidence to survive the gate" },
    ];
    defs.forEach((d, i) => {
      this.groomingGateRules.push({
        id: `ggrule_${i}_${d.ruleType}`,
        ruleType: d.ruleType,
        value: d.value,
        label: d.label ?? null,
        enabled: true,
        sortOrder: i,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 28 tool_types seed INSERT
  // (+ Section 30's primary_criterion backfill) exactly — the 9 built-in
  // types Tool Type used to be a fixed TS union of.
  seedToolTypeDefaults() {
    if (this.toolTypes.length > 0) return;
    const now = new Date();
    const defs: { key: string; label: string; aliases: string[]; family: string | null; primaryCriterion: "motor" | "heat_technology" | "none" }[] = [
      { key: "trimmer", label: "Trimmer", aliases: ["trimmer", "beard trimmer", "detailer", "outliner", "liner", "edger"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" },
      { key: "shaver", label: "Shaver", aliases: ["shaver", "foil shaver", "rotary shaver", "electric shaver", "razor"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" },
      { key: "dryer", label: "Hair Dryer", aliases: ["dryer", "blow dryer", "diffuser"], family: "beauty", primaryCriterion: "motor" },
      { key: "flat_iron", label: "Flat Iron", aliases: ["flat iron", "straightener", "hair iron"], family: "beauty", primaryCriterion: "heat_technology" },
      { key: "curling_iron", label: "Curling Iron", aliases: ["curling iron", "curling wand", "curler", "wand"], family: "beauty", primaryCriterion: "heat_technology" },
      { key: "hot_brush", label: "Hot Brush", aliases: ["hot brush", "styling brush", "heated brush"], family: "beauty", primaryCriterion: "heat_technology" },
      { key: "clipper", label: "Clipper", aliases: ["clipper"], family: "clipper_trimmer_shaver", primaryCriterion: "motor" },
      { key: "other_styling", label: "Other Styling Tool", aliases: [], family: "beauty", primaryCriterion: "none" },
      { key: "combo", label: "Combo / Multi-Tool Kit", aliases: [], family: null, primaryCriterion: "none" },
    ];
    defs.forEach((d, i) => {
      this.toolTypes.push({
        id: `ttype_${d.key}`,
        typeKey: d.key,
        label: d.label,
        aliases: d.aliases,
        family: d.family,
        primaryCriterion: d.primaryCriterion,
        enabled: true,
        custom: false,
        sortOrder: i,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 29 scoring_profiles seed INSERT
  // exactly — replaces the old singleton competitorMatchingConfig with
  // per-tool-type weight profiles. typeKey: null is the global default row.
  seedScoringProfileDefaults() {
    if (this.scoringProfiles.length > 0) return;
    const now = new Date();
    const defs: { key: string | null; motor: number; price: number; feature: number }[] = [
      { key: null, motor: 45, price: 35, feature: 20 },
      { key: "clipper", motor: 45, price: 35, feature: 20 },
      { key: "trimmer", motor: 45, price: 35, feature: 20 },
      { key: "shaver", motor: 45, price: 35, feature: 20 },
      { key: "dryer", motor: 35, price: 35, feature: 30 },
      { key: "flat_iron", motor: 40, price: 35, feature: 25 },
      { key: "curling_iron", motor: 40, price: 35, feature: 25 },
      { key: "hot_brush", motor: 40, price: 35, feature: 25 },
    ];
    defs.forEach(d => {
      this.scoringProfiles.push({
        id: `sprof_${d.key ?? "default"}`,
        typeKey: d.key,
        motorWeight: d.motor,
        priceWeight: d.price,
        featureWeight: d.feature,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 31 heat_tech_families seed INSERT
  // exactly — a full parallel to seedMotorFamilyDefaults for the new
  // motorless-styling-tool criterion, minus the motor-specific
  // modifier/adjacent_families concepts (not needed here).
  seedHeatTechFamilyDefaults() {
    if (this.heatTechFamilies.length > 0) return;
    const now = new Date();
    const defs: { key: string; label: string; aliases: string[] }[] = [
      { key: "titanium", label: "Titanium", aliases: ["titanium", "titanium plates", "titanium-coated", "titanium coated"] },
      { key: "ceramic", label: "Ceramic", aliases: ["ceramic", "ceramic plates", "ceramic-coated", "ceramic coated"] },
      { key: "tourmaline", label: "Tourmaline", aliases: ["tourmaline", "tourmaline plates", "tourmaline-ceramic", "tourmaline ceramic"] },
      { key: "ionic", label: "Ionic", aliases: ["ionic", "ion technology", "negative ion"] },
      { key: "infrared", label: "Infrared", aliases: ["infrared", "infrared technology"] },
    ];
    defs.forEach((d, i) => {
      this.heatTechFamilies.push({
        id: `htfam_${d.key}`,
        familyKey: d.key,
        label: d.label,
        aliases: d.aliases,
        enabled: true,
        sortOrder: i,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 34 branded_motor_names seed INSERT
  // exactly — StyleCraft's own proprietary motor marketing names, confirmed
  // against the canonical 7-family taxonomy (Section 25).
  seedBrandedMotorNameDefaults() {
    if (this.brandedMotorNames.length > 0) return;
    const now = new Date();
    const defs: { term: string; familyKey: string }[] = [
      { term: "EON Digital Brushless", familyKey: "brushless" },
      { term: "Digital Brushless", familyKey: "brushless" },
      { term: "BLDC", familyKey: "brushless" },
      { term: "Super Torque Rotary", familyKey: "rotary" },
      { term: "Supercharged Rotary", familyKey: "rotary" },
      { term: "P.U.R.E Outrunner", familyKey: "brushless" },
    ];
    defs.forEach((d, i) => {
      this.brandedMotorNames.push({
        id: `bmn_stylecraft_${i}`,
        brandName: "StyleCraft",
        brandedTerm: d.term,
        familyKey: d.familyKey,
        enabled: true,
        sortOrder: i,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 34 catalog_products seed INSERT
  // exactly — the 21 GTM-forms products (source: gtm_forms_import, the
  // authoritative spec) plus the deduped survivors of the old
  // lib/stylecraft-products.ts array (source: legacy_catalog_import).
  // Brushes/Apparel/Accessories categories from that old array are
  // deliberately excluded (no analyzable tool_type). Rows whose motor/
  // heat-tech text didn't resolve against the taxonomy are seeded with a
  // null family and 'motor_needs_confirmation'/'heat_tech_needs_confirmation'
  // in importFlags rather than guessed.
  seedCatalogProductDefaults() {
    if (this.catalogProducts.length > 0) return;
    const now = new Date();
    const defs: { name: string; industry: string; targetMarket: string; toolType: string; targetPrice: number | null; description: string | null; motorFamily: string | null; motorBranded: string | null; heatTechFamily: string | null; heatTechBranded: string | null; importFlags: string[]; source: string }[] = [
      { name: "Infared Curler", industry: "haircare-styling", targetMarket: "pro", toolType: "curling_iron", targetPrice: null, description: null, motorFamily: null, motorBranded: null, heatTechFamily: "infrared", heatTechBranded: "Infrared Technology", importFlags: [], source: "gtm_forms_import" },
      { name: "Orange Saber II Clipper", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 299.95, description: "EON Digital brushless motor up to 7,200rpm, Echo blade with shallow 2.0 cutter, full metal body", motorFamily: "brushless", motorBranded: "EON Digital Brushless", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Orange Saber Trimmer", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 199.95, description: "Digital brushless motor, full metal body, gold X-Pro wide blade with \"The One\" cutter", motorFamily: "brushless", motorBranded: "Digital Brushless", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Xceed Dryer", industry: "haircare-styling", targetMarket: "pro", toolType: "dryer", targetPrice: 299.95, description: null, motorFamily: null, motorBranded: null, heatTechFamily: null, heatTechBranded: null, importFlags: ["incomplete"], source: "gtm_forms_import" },
      { name: "3versince Trimmer", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 184.95, description: "Hand-sharpened modified blade, super torque rotary motor up to 7,500 rpm, lightweight ergonomic rubber grip", motorFamily: "rotary", motorBranded: "Super Torque Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Anime Clipper", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 249.95, description: "EON Digital brushless motor up to 7,800rpm, Echo taper blade with echo deep tooth cutter, ergonomic lightweight design", motorFamily: "brushless", motorBranded: "EON Digital Brushless", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Anime Trimmer", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 199.95, description: "EON Digital brushless motor up to 7,800rpm, X-Pro wide DLC blade with \"The One\" cutter, ergonomic lightweight design", motorFamily: "brushless", motorBranded: "EON Digital Brushless", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Alpha Up", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 159.95, description: "Super torque rotary motor up to 7,200 rpm, enhanced build quality, DLC faper blade with slim deep tooth cutter", motorFamily: "rotary", motorBranded: "Super Torque Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Hitter Up", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 119.95, description: "Super torque rotary motor up to 6,500 rpm, enhanced build quality, DLC X-Pro wide blade with \"The One\" cutter", motorFamily: "rotary", motorBranded: "Super Torque Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Arbitrage Clipper", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 279.95, description: "Outrunner motor up to 7,200rpm, intuitive torque control, full metal body, Echo blade with shallow 2.0 cutter", motorFamily: "brushless", motorBranded: "P.U.R.E Outrunner", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Retro Dryer", industry: "haircare-styling", targetMarket: "consumer", toolType: "dryer", targetPrice: 139.95, description: null, motorFamily: null, motorBranded: null, heatTechFamily: null, heatTechBranded: null, importFlags: ["incomplete"], source: "gtm_forms_import" },
      { name: "Multistyler", industry: "haircare-styling", targetMarket: "consumer", toolType: "dryer", targetPrice: 189.95, description: null, motorFamily: null, motorBranded: null, heatTechFamily: null, heatTechBranded: null, importFlags: ["incomplete", "tool_type_needs_review"], source: "gtm_forms_import" },
      { name: "Smarty Dryer", industry: "haircare-styling", targetMarket: "consumer", toolType: "dryer", targetPrice: 179.95, description: null, motorFamily: "brushless", motorBranded: "BLDC", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Homie Dryer", industry: "haircare-styling", targetMarket: "consumer", toolType: "dryer", targetPrice: 129.95, description: null, motorFamily: null, motorBranded: null, heatTechFamily: null, heatTechBranded: null, importFlags: ["incomplete"], source: "gtm_forms_import" },
      { name: "Daymond John Clipper", industry: "grooming-barbering", targetMarket: "both", toolType: "clipper", targetPrice: 99.95, description: "Supercharged rotary motor, adjustable speeds up to 7,000/8,000/9,000 rpm, smart LED display, full metal body", motorFamily: "rotary", motorBranded: "Supercharged Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Daymond John Trimmer", industry: "grooming-barbering", targetMarket: "both", toolType: "trimmer", targetPrice: 79.95, description: "Supercharged rotary motor, adjustable speeds up to 7,000/8,000/9,000 rpm, smart LED display, full metal body", motorFamily: "rotary", motorBranded: "Supercharged Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Daymond John Shaver", industry: "grooming-barbering", targetMarket: "both", toolType: "shaver", targetPrice: 79.95, description: "Supercharged rotary motor, adjustable speeds up to 7,000/8,000/9,000 rpm, smart LED display, full metal body", motorFamily: "rotary", motorBranded: "Supercharged Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Red Saber II Clipper", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 299.95, description: "EON Digital brushless motor up to 7,200rpm, Echo blade with shallow 2.0 cutter, full metal body", motorFamily: "brushless", motorBranded: "EON Digital Brushless", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Red Saber Trimmer", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 199.95, description: "Digital brushless motor, full metal body, gold X-Pro wide blade with \"The One\" cutter", motorFamily: "brushless", motorBranded: "Digital Brushless", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Protege 2 Clipper", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 89.95, description: "Super torque rotary motor up to 7,200 rpm, enhanced build quality, stainless steel faper blade with DLC slim deep tooth cutter", motorFamily: "rotary", motorBranded: "Super Torque Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Protege 2 Trimmer", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 79.95, description: "Super torque rotary motor up to 6,500 rpm, enhanced build quality, stainless steel X-Pro wide blade with DLC \"The One\" cutter", motorFamily: "rotary", motorBranded: "Super Torque Rotary", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "gtm_forms_import" },
      { name: "Saber 2 Professional Hair Clipper with EON Digital Brushless Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 319.95, description: "Professional cordless modular hair clipper with EON Digital Brushless Motor. High torque, premium performance for professional barbers. Available in Gold and Black finishes.", motorFamily: "brushless", motorBranded: "EON Digital Brushless Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "S|C x 360 Jeezy Professional Hair Clipper with IN2 Vector Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 299.95, description: "Signature artist-collaboration clipper with the IN2 Vector Motor — limited-run professional cordless clipper.", motorFamily: "vector", motorBranded: "IN2 Vector Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Instinct Metal Professional Hair Clipper with IN2 Vector Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 299.95, description: "Professional hair clipper with IN2 Vector Motor. Intelligent torque control adjusts power automatically. All-metal construction.", motorFamily: "vector", motorBranded: "IN2 Vector Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Instinct Professional Hair Clipper with IN2 Vector Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 269.95, description: "Professional cordless hair clipper with the IN2 Vector Motor and intuitive torque control, in a lightweight polymer body.", motorFamily: "vector", motorBranded: "IN2 Vector Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Reign Professional Hair Clipper with EON Digital Brushless Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 229.95, description: "Reign Professional Hair Clipper with EON Digital Brushless Motor. Conquer every style. Available in standard and Purple finishes.", motorFamily: "brushless", motorBranded: "EON Digital Brushless Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Rebel 2.0 Professional Hair Clipper with Super C4RBN Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 199.95, description: "Rebel 2.0 Professional Hair Clipper with Super C4RBN Motor. Rebel with a cause — for barbers who demand more.", motorFamily: null, motorBranded: "Super C4RBN Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "S|C x United by Short Hair — Rogue Clipper Collab", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 149.95, description: "Limited-run Rogue clipper collaboration with United by Short Hair, sold exclusively through the UBSH channel.", motorFamily: "magnetic", motorBranded: "9V Microchipped Magnetic Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Rogue Professional Hair Clipper with Microchipped Magnetic Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 129.95, description: "Rogue Professional Hair Clipper with 9V Microchipped Magnetic Motor. Embrace the unconventional.", motorFamily: "magnetic", motorBranded: "9V Microchipped Magnetic Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Ergo Professional Hair Clipper with Microchipped Magnetic Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "clipper", targetPrice: 129.95, description: "Ergo Professional Hair Clipper with a linear microchipped magnetic motor, built for an ergonomic in-hand feel during long shifts.", motorFamily: "magnetic", motorBranded: "Microchipped Magnetic Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Solecito Professional Hair Clipper with Powerful Rotary Motor", industry: "grooming-barbering", targetMarket: "both", toolType: "clipper", targetPrice: 109.95, description: "Solecito Professional Hair Clipper with Powerful Rotary Motor — professional rotary performance at a mid-tier price.", motorFamily: "rotary", motorBranded: "Powerful Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Rival Metal Hair Clipper with Digital Display", industry: "grooming-barbering", targetMarket: "both", toolType: "clipper", targetPrice: 59.95, description: "Rival Metal Hair Clipper with Digital Display. All-metal construction with digital battery indicator.", motorFamily: "brushless", motorBranded: "Digital Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "ACE Cordless Hair Clipper with Rotary Motor", industry: "grooming-barbering", targetMarket: "consumer", toolType: "clipper", targetPrice: 69.95, description: "ACE Cordless Hair Clipper with Rotary Motor. Entry-level professional clipper, frequently discounted.", motorFamily: "rotary", motorBranded: "Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Instinct Metal Professional Hair Trimmer with IN2 Vector Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 239.95, description: "Instinct Metal Professional Hair Trimmer with IN2 Vector Motor and intelligent torque control in an all-metal body.", motorFamily: "vector", motorBranded: "IN2 Vector Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Saber Professional Hair Trimmer with Digital Brushless Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 209.95, description: "Saber Professional Hair Trimmer with Digital Brushless Motor. High energy, low vibration. Best seller. Available in Gold and Black.", motorFamily: "brushless", motorBranded: "Digital Brushless Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Precision Saber Professional Hair Trimmer with Digital Brushless Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 209.95, description: "Precision variant of the Saber trimmer line with a full-metal body and Digital Brushless Motor, tuned for detail line-up work.", motorFamily: "brushless", motorBranded: "Digital Brushless Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Instinct Professional Hair Trimmer with IN2 Vector Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 179.95, description: "Instinct Professional Hair Trimmer with IN2 Vector Motor and intuitive torque control in a lightweight polymer body.", motorFamily: "vector", motorBranded: "IN2 Vector Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Rebel Professional Hair Trimmer with Super-Torque Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 139.95, description: "Rebel Professional Hair Trimmer with a modular Super-Torque Motor for detail and outline work.", motorFamily: null, motorBranded: "Super-Torque Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Flex Professional Hair Trimmer with Super-Torque Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 129.95, description: "Flex Professional Hair Trimmer with Super-Torque Motor, the trimmer half of the Super Set combo.", motorFamily: null, motorBranded: "Super-Torque Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Reign Professional Hair Trimmer with EON Digital Brushless Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "trimmer", targetPrice: 189.95, description: "Reign Professional Hair Trimmer with EON Digital Brushless Motor. Available in standard and Purple finishes.", motorFamily: "brushless", motorBranded: "EON Digital Brushless Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Ace Hair Trimmer with Rotary Motor", industry: "grooming-barbering", targetMarket: "consumer", toolType: "trimmer", targetPrice: 59.95, description: "Ace Hair Trimmer with Rotary Motor, USB-C rechargeable with 3 guide combs and stainless steel blades.", motorFamily: "rotary", motorBranded: "Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Ace Body Buzzer Hair Trimmer with Supercharged Rotary Motor", industry: "grooming-barbering", targetMarket: "consumer", toolType: "trimmer", targetPrice: 59.95, description: "Ace Body Buzzer Hair Trimmer with Supercharged Rotary Motor, purpose-built for body grooming.", motorFamily: "rotary", motorBranded: "Supercharged Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Homie Nano Trimmer", industry: "grooming-barbering", targetMarket: "consumer", toolType: "trimmer", targetPrice: 54.95, description: "Homie Nano Trimmer — compact, portable, precise trimming for home use.", motorFamily: null, motorBranded: "Nano Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Ace Beard Blender Hair Trimmer with Supercharged Rotary Motor", industry: "grooming-barbering", targetMarket: "consumer", toolType: "trimmer", targetPrice: 37.95, description: "Ace Beard Blender Hair Trimmer with Supercharged Rotary Motor, designed for blending beard fades and edges.", motorFamily: "rotary", motorBranded: "Supercharged Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Schnozzle Water Resistant Nose and Ear Hair Trimmer", industry: "grooming-barbering", targetMarket: "consumer", toolType: "trimmer", targetPrice: 29.95, description: "Schnozzle Water Resistant Nose and Ear Hair Trimmer in matte black.", motorFamily: null, motorBranded: "Compact Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Ace 3-in-1 Rechargeable Multipurpose Hair Trimmer", industry: "grooming-barbering", targetMarket: "consumer", toolType: "trimmer", targetPrice: 29.95, description: "Ace 3-in-1 Rechargeable Multipurpose Hair Trimmer. Versatile consumer trimmer for multiple uses.", motorFamily: null, motorBranded: "Rechargeable Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Ace Electric Ear and Nose Hair Trimmer with Dual-Speed Motor", industry: "grooming-barbering", targetMarket: "consumer", toolType: "trimmer", targetPrice: 27.95, description: "Ace Electric Ear and Nose Hair Trimmer with a Dual-Speed Motor for adjustable precision.", motorFamily: null, motorBranded: "Dual-Speed Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Instinct Metal Professional Double Foil Shaver with IN2 Vector Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "shaver", targetPrice: 179.95, description: "Instinct Metal Professional Double Foil Shaver with IN2 Vector Motor and a built-in micro-trimmer. Available in Black and Pink.", motorFamily: "vector", motorBranded: "IN2 Vector Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Rebel Professional Double Foil Shaver with Super-Torque Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "shaver", targetPrice: 84.95, description: "Rebel Professional Double Foil Shaver with Super-Torque Motor and a gold titanium foil head.", motorFamily: null, motorBranded: "Super-Torque Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Ace Waterproof Triple Foil Shaver with Integrated Pop-Up Trimmer", industry: "grooming-barbering", targetMarket: "consumer", toolType: "shaver", targetPrice: 74.95, description: "Ace Waterproof Triple Foil Shaver with an integrated pop-up trimmer for edging.", motorFamily: "rotary", motorBranded: "Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Ace Bald Head 7X Foil Shaver with Supercharged Motor", industry: "grooming-barbering", targetMarket: "consumer", toolType: "shaver", targetPrice: 69.95, description: "Ace Bald Head 7X Foil Shaver with a Supercharged Motor, purpose-built for close head shaves.", motorFamily: null, motorBranded: "Supercharged Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Uno 2.0 Professional Single Foil Shaver with Supercharged Motor", industry: "grooming-barbering", targetMarket: "both", toolType: "shaver", targetPrice: 59.95, description: "Uno 2.0 Professional Single Foil Shaver with Supercharged Motor and USB-C charging.", motorFamily: null, motorBranded: "Supercharged Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Absolute Zero Professional Double Foil Shaver with Rotary Motor", industry: "grooming-barbering", targetMarket: "both", toolType: "shaver", targetPrice: 49.95, description: "Absolute Zero Professional Double Foil Shaver with a built-in retractable trimmer.", motorFamily: "rotary", motorBranded: "Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Uno Professional Single Foil Shaver with Turbocharged Motor", industry: "grooming-barbering", targetMarket: "both", toolType: "shaver", targetPrice: 49.95, description: "Uno Professional Single Foil Shaver with Turbocharged Motor, USB rechargeable and travel-sized. Available in Red.", motorFamily: null, motorBranded: "Turbocharged Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Ace Single Foil Shaver with Built-in Trimmer", industry: "grooming-barbering", targetMarket: "consumer", toolType: "shaver", targetPrice: 37.95, description: "Ace Single Foil Shaver with a built-in trimmer for touch-ups on the go.", motorFamily: null, motorBranded: "Compact Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Rogue Combo Set - Professional Cordless Hair Clipper/Trimmer with 9V Magnetic Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "combo", targetPrice: 219.95, description: "Rogue Combo Set with Clipper and Trimmer. 9V Microchipped Magnetic Motor. Best seller combo.", motorFamily: "magnetic", motorBranded: "9V Magnetic Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Super Set - Rebel Cordless Hair Clipper & Flex Cordless Hair Trimmer Set with Super-Torque Rotary Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "combo", targetPrice: 199.95, description: "Super Set pairing the Rebel Clipper and Flex Trimmer with a Super-Torque Rotary Motor, includes travel case.", motorFamily: "rotary", motorBranded: "Super-Torque Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Rebel Combo Set - Professional Cordless Hair Clipper/Hair Trimmer Set with Super-Torque Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "combo", targetPrice: 189.95, description: "Rebel Combo Set with modular clipper and trimmer sharing a Super-Torque Motor platform.", motorFamily: null, motorBranded: "Super-Torque Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Protégé Combo - Professional Cordless Hair Clipper/Hair Trimmer Combo with Turbocharged Rotary Motor", industry: "grooming-barbering", targetMarket: "pro", toolType: "combo", targetPrice: 179.95, description: "Protégé Combo pairing a clipper and trimmer with a Turbocharged Rotary Motor in a matte metallic black finish.", motorFamily: "rotary", motorBranded: "Turbocharged Rotary Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Sage Professional Lightweight Hair Dryer with Digital LED Display", industry: "haircare-styling", targetMarket: "pro", toolType: "dryer", targetPrice: 199.95, description: "Sage Professional Lightweight Hair Dryer with a Digital Brushless Motor and LED temperature display.", motorFamily: "brushless", motorBranded: "Digital Brushless Motor", heatTechFamily: null, heatTechBranded: null, importFlags: [], source: "legacy_catalog_import" },
      { name: "Sage 2-in-1 Diffuser & Hair Dryer with Ion Generator", industry: "haircare-styling", targetMarket: "both", toolType: "dryer", targetPrice: 99.95, description: "Sage 2-in-1 Diffuser & Hair Dryer with Ion Generator. Style with wisdom, shine with confidence.", motorFamily: null, motorBranded: "Ion Generator Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Stay-Temp Professional Hair Dryer with Turbo Power Motor", industry: "haircare-styling", targetMarket: "both", toolType: "dryer", targetPrice: 69.95, description: "Stay-Temp Professional Hair Dryer with Turbo Power Motor for fast, consistent-heat drying.", motorFamily: null, motorBranded: "Turbo Power Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Ace Professional Lightweight Foldable Hair Dryer", industry: "haircare-styling", targetMarket: "consumer", toolType: "dryer", targetPrice: 59.95, description: "Ace Professional Lightweight Foldable Hair Dryer built for travel and everyday consumer use.", motorFamily: null, motorBranded: "Standard Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Rival Lightweight Foldable Hair Dryer", industry: "haircare-styling", targetMarket: "consumer", toolType: "dryer", targetPrice: 39.95, description: "Rival Lightweight Foldable Hair Dryer. Compact, travel-friendly design.", motorFamily: null, motorBranded: "Standard Motor", heatTechFamily: null, heatTechBranded: null, importFlags: ["motor_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Sage Professional 1\" Cordless Curling Iron & Wand with Removable Clamp", industry: "haircare-styling", targetMarket: "both", toolType: "curling_iron", targetPrice: 129.95, description: "Sage Professional 1\" Cordless Curling Iron & Wand with a removable clamp for both clamped and wand-style curling. Features a 1\" ceramic barrel.", motorFamily: null, motorBranded: null, heatTechFamily: "ceramic", heatTechBranded: "Ceramic Barrel", importFlags: [], source: "legacy_catalog_import" },
      { name: "Sage Professional Retractable Styling Brush & Curling Wand 1.25\"", industry: "haircare-styling", targetMarket: "both", toolType: "other_styling", targetPrice: 99.95, description: "Sage Professional Retractable Styling Brush & Curling Wand with a 1.25\" ceramic barrel — bristles retract for wand-style curling.", motorFamily: null, motorBranded: null, heatTechFamily: "ceramic", heatTechBranded: "Ceramic Barrel", importFlags: [], source: "legacy_catalog_import" },
      { name: "Sage Professional Flat Iron with 1\" Titanium Plates", industry: "haircare-styling", targetMarket: "both", toolType: "flat_iron", targetPrice: 99.95, description: "Sage Professional Flat Iron with 1\" titanium plates for fast, even heat distribution.", motorFamily: null, motorBranded: null, heatTechFamily: "titanium", heatTechBranded: "Titanium Plates", importFlags: [], source: "legacy_catalog_import" },
      { name: "Stay-Temp Professional Flat Iron with 1\" Titanium Plates", industry: "haircare-styling", targetMarket: "both", toolType: "flat_iron", targetPrice: 89.95, description: "Stay-Temp Professional Flat Iron with 1\" titanium plates and consistent temperature hold.", motorFamily: null, motorBranded: null, heatTechFamily: "titanium", heatTechBranded: "Titanium Plates", importFlags: [], source: "legacy_catalog_import" },
      { name: "Sage Professional Triple Barrel Deep Waver", industry: "haircare-styling", targetMarket: "both", toolType: "other_styling", targetPrice: 89.95, description: "Sage Professional Triple Barrel Deep Waver for beachy waves in one pass. Ceramic coated barrels.", motorFamily: null, motorBranded: null, heatTechFamily: "ceramic", heatTechBranded: "Ceramic Coated", importFlags: [], source: "legacy_catalog_import" },
      { name: "Heat Stroke Professional Beard & Hair Styling Cordless Hot Brush", industry: "haircare-styling", targetMarket: "both", toolType: "other_styling", targetPrice: 69.95, description: "Heat Stroke Professional Beard & Hair Styling Cordless Hot Brush for beard straightening and styling.", motorFamily: null, motorBranded: null, heatTechFamily: null, heatTechBranded: null, importFlags: ["heat_tech_needs_confirmation"], source: "legacy_catalog_import" },
      { name: "Stay-Temp Professional Ceramic Extended Barrel Curling Iron (0.75\"–1.25\")", industry: "haircare-styling", targetMarket: "both", toolType: "curling_iron", targetPrice: 54.95, description: "Stay-Temp Professional Ceramic Extended Barrel Curling Iron, available in 0.75\", 1\", and 1.25\" barrel sizes.", motorFamily: null, motorBranded: null, heatTechFamily: "ceramic", heatTechBranded: "Ceramic Barrel", importFlags: [], source: "legacy_catalog_import" },
      { name: "Stay-Temp Professional Ceramic Barrel 3/4\" Marcel Curling Iron", industry: "haircare-styling", targetMarket: "both", toolType: "curling_iron", targetPrice: 49.95, description: "Stay-Temp Professional Ceramic Barrel 3/4\" Marcel Curling Iron for classic clamp-free curling technique.", motorFamily: null, motorBranded: null, heatTechFamily: "ceramic", heatTechBranded: "Ceramic Barrel", importFlags: [], source: "legacy_catalog_import" },
      { name: "Stay-Temp Professional Ceramic Barrel Curling Iron (0.5\"–1.5\")", industry: "haircare-styling", targetMarket: "both", toolType: "curling_iron", targetPrice: 44.95, description: "Stay-Temp Professional Ceramic Barrel Curling Iron, available across five barrel sizes from 0.5\" to 1.5\".", motorFamily: null, motorBranded: null, heatTechFamily: "ceramic", heatTechBranded: "Ceramic Barrel", importFlags: [], source: "legacy_catalog_import" },
    ];
    defs.forEach((d, i) => {
      this.catalogProducts.push({
        id: `catprod_${i}`,
        name: d.name,
        industry: d.industry,
        targetMarket: d.targetMarket,
        toolType: d.toolType,
        targetPrice: d.targetPrice,
        description: d.description,
        motorFamily: d.motorFamily,
        motorBranded: d.motorBranded,
        heatTechFamily: d.heatTechFamily,
        heatTechBranded: d.heatTechBranded,
        active: true,
        importFlags: d.importFlags,
        source: d.source,
        brand: "StyleCraft",
        sku: null,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 36 brand_name_hints seed INSERT
  // exactly — real default StyleCraft/Gamma+ name-prefix hints for GTM's
  // Manufacturer auto-detect cascade (lib/gtm-tier6-inference.ts), used only
  // when a project has no catalog record to read `brand` from directly.
  seedBrandNameHintDefaults() {
    if (this.brandNameHints.length > 0) return;
    const now = new Date();
    const defs: { brand: string; namePrefixes: string[] }[] = [
      { brand: "StyleCraft", namePrefixes: ["Saber", "Anime", "Protege", "Protégé", "Reign", "Rebel", "Rogue", "Instinct", "Ergo", "Solecito", "Rival", "Ace", "Homie", "Schnozzle", "Sage", "Stay-Temp", "Stay Temp"] },
      { brand: "Gamma+", namePrefixes: ["Absolute", "X-Evo", "XEvo"] },
    ];
    defs.forEach((d, i) => {
      this.brandNameHints.push({
        id: `bhint_${i}`,
        brand: d.brand,
        namePrefixes: d.namePrefixes,
        enabled: true,
        sortOrder: i,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 39 collections seed INSERT
  // exactly — real Homie/360 Jeezy narrative kernel text quoted verbatim
  // from the approved GTM sheets, not invented.
  seedCollectionDefaults() {
    if (this.collections.length > 0) return;
    const now = new Date();
    const defs: { name: string; narrativeKernel: string; logoMeaning: string; voiceNotes: string }[] = [
      {
        name: "Homie",
        narrativeKernel:
          "Homie is a term rooted in loyalty, familiarity, and community - it's the person who always has your back, reliable, real, and never pretentious. The Homie name was established with the Homie Nano Clipper and carried through the full collection (Clipper, Trimmer, Shaver) to represent StyleCraft's connection to the grooming community at every level.",
        logoMeaning: "The stylized H with a heart in the logo reinforces that emotional bond - this is a brand that cares about craft and the people who practice it.",
        voiceNotes: "Confident, down-to-earth, community-rooted. Not trying to be premium - owning the accessible-pro lane with pride. Real talk, no fluff. A homie doesn't show off, they just show up and deliver.",
      },
      {
        name: "360 Jeezy",
        narrativeKernel:
          "The 360 Jeezy collaboration represents a full-circle approach to barbering: precision, consistency, and mastery from every angle. Just like a clean 360 wave pattern, every detail matters. Co-designed with one of the industry's most recognized barbers, every feature decision was made from behind the chair, not behind a desk.",
        logoMeaning: "N/A - no distinct logo lockup beyond the co-branded S|C x 360 Jeezy wordmark.",
        voiceNotes: "Bold, technical authority, craft language. Peer-to-peer trust from a working barber, not celebrity hype. Confident, professional, never generic/corporate.",
      },
    ];
    defs.forEach((d, i) => {
      this.collections.push({
        id: `collection_${i}`,
        name: d.name,
        narrativeKernel: d.narrativeKernel,
        logoMeaning: d.logoMeaning,
        voiceNotes: d.voiceNotes,
        enabled: true,
        sortOrder: i,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  // Mirrors supabase_schema.sql's Section 42 brand_voice_guides seed INSERT
  // exactly — the real StyleCraftUS Brand Voice Guide, verbatim. No Gamma+
  // row is seeded — its absence is the "no brand voice guide on file"
  // signal lib/brand-voice.ts falls back on.
  seedBrandVoiceGuideDefaults() {
    if (this.brandVoiceGuides.length > 0) return;
    const now = new Date();
    const content = `# StyleCraftUS Brand Voice Guide

*Derived from analysis of stylecraftus.com (homepage, About Us / Our Story, collection and product copy) — July 2026*

---

## 1. Brand Personality

If StyleCraft were a person, they'd be a master barber who came up through the industry, knows every motor spec by heart, and treats their clients like family. Confident bordering on cocky about the tools, but genuinely warm with people. They talk like a peer in the shop, not a corporation — they'd say "the Fam" without irony, hype a "new drop" like a sneaker release, and then patiently walk you through a warranty claim.

**In one line:** A pro-grade challenger brand with streetwear energy and family-business heart.

## 2. Voice Attributes

### Bold & Competitive
- **We are:** Confident, declarative, unafraid of big statements. We name products after winners and fighters (Saber, Rebel, Rogue, Reign, Ace, Instinct) and write taglines like commands: "Conquer Every Style." "Do Whatever It Takes."
- **We are not:** Arrogant toward the customer, or dismissive of competitors by name. The swagger is about the tools, never at anyone's expense.
- **Sounds like:** "Unmatched. Unstoppable. Intuitive."
- **Does NOT sound like:** "We think you might enjoy our clipper, which compares favorably to leading brands."

### Tech-Credible
- **We are:** Specific about engineering. We lead with named technology — EON Digital Brushless Motor, IN2 Vector Motor, Super C4RBN, Stay-Temp — and concrete benefits (high torque, low vibration, full metal body). Specs are part of the swagger.
- **We are not:** Jargon for jargon's sake. Every spec ties to what it does in the pro's hand: faster cuts, cooler blades, longer sessions.
- **Sounds like:** "High energy, low vibration."
- **Does NOT sound like:** Vague fluff like "cutting-edge quality you can trust."

### Community-First ("The Fam")
- **We are:** Warm, loyal, reciprocal. We talk about barbers and stylists as family and collaborators, not customers. We celebrate their work and their following, not just our products. "It's a 2-way street."
- **We are not:** Corporate-friendly-by-committee, or transactional. We never fake intimacy with generic "valued customer" language.
- **Sounds like:** "If you are not happy, we are not happy."
- **Does NOT sound like:** "We appreciate your business and strive for customer satisfaction."

### Street-Culture Fluent
- **We are:** Plugged into barber culture — drops, collabs (S|C x 360 Jeezy), edgy colorways, metallic finishes. Product launches read like sneaker releases: "NEW DROPS."
- **We are not:** Trend-chasing or trying too hard. The culture references come from being *in* the community, not marketing to it.
- **Sounds like:** "Embrace the unconventional: Go Rogue!"
- **Does NOT sound like:** Forced slang or memes disconnected from barbering.

### Craft-Proud & Family-Built
- **We are:** A family-owned, US-based company with 50+ years of combined industry experience. We invoke the founder story (Ken & Austin Russo), craftsmanship, and "the art & science of styling."
- **We are not:** Nostalgic or old-fashioned. Heritage backs up innovation; it doesn't replace it.
- **Sounds like:** "The Art & Science of Styling."
- **Does NOT sound like:** "Old-world tradition since days gone by."

## 3. Audience

**Primary:** Professional barbers and stylists — people who cut hair for a living, care about torque, blade quality, and battery life, and see their tools as an extension of their craft and personal brand. They expect to be addressed as peers and pros.

**Secondary:** Prosumers and home users who aspire to pro-grade results and buy into the culture (the Ace and Homie lines, brushes, dryers).

They care about: performance under daily use, standing out (finishes, colorways), education and skill growth, and being part of a community that respects the craft.

## 4. Core Messaging Pillars

1. **Pro-grade innovation** — Named motor technology and engineering that rivals the biggest players. Every product claim anchors to a spec or design feature.
2. **Built by and for the craft** — Family-owned, 50+ years of industry expertise, tools designed with working barbers and stylists.
3. **The Fam** — A loyal, two-way community. We elevate our pros' craft and their following, and they carry the brand.
4. **Edgy design that stands out** — Bold colorways, metallic finishes, collabs. The tool on your station says something about you.
5. **Service that has your back** — Trained, genuinely helpful support; happiness guaranteed in spirit: "If you are not happy, we are not happy."

## 5. Tone Spectrum (voice stays fixed, tone flexes)

| Context | Dial up | Dial down | Example register |
|---|---|---|---|
| Product launches / drops | Boldness, hype, culture | Warmth | "NEW DROP. Conquer every style." |
| Product detail pages | Tech credibility | Slang | Specs first, benefit-driven, still punchy |
| Education / tutorials | Craft pride, clarity | Hype | Peer-to-peer teaching, step-by-step |
| Customer service / support | Warmth, patience | Swagger | Plain, friendly, human — no attitude |
| Corporate / press / About | Heritage, credibility | Street slang | Confident but polished; founder story |
| Social media | Community, playfulness | Formality | Fam language, collabs, celebrating pros' work |

## 6. Style Rules (observed & recommended)

- **Taglines:** Short imperative or fragment constructions, often stacked one-word sentences ("Unmatched. Unstoppable. Intuitive."). ALL CAPS acceptable in headlines/banners only, never body copy.
- **Contractions:** Use them ("we've got the answers") — the voice is conversational.
- **Exclamation marks:** Sparingly; reserve for launch/hype moments ("Go Rogue!"), max one per piece.
- **Body copy:** Warm, first-person plural ("we," "our"), direct address ("you," "your craft").
- **Product naming convention:** [Collection Name] + [Product Type] + "with" + [Named Technology] (e.g., "Reign Professional Hair Clipper with EON Digital Brushless Motor"). Keep this structure consistent.

## 7. Terminology

**Preferred terms**
| Use | Notes |
|---|---|
| StyleCraft / StyleCraftUS / S\\|C | S\\|C shorthand for logos, collabs, sub-brands (S\\|C Educators, S\\|C x 360 Jeezy) |
| the Fam | Community/social contexts only, not corporate copy |
| pros, barbers, stylists | Never "users" or "consumers" in community-facing copy |
| drop / new drop | For product launches on social and homepage |
| tools | Preferred over "devices" or "appliances" (except corporate/press: "hair appliances" is acceptable) |
| Named tech in full on first use | "EON Digital Brushless Motor," "IN2 Vector Motor," "Super C4RBN," "Stay-Temp Technology" |

**Avoid**
- Generic praise without a spec behind it ("high quality," "great performance" standing alone)
- Corporate distance ("valued customers," "our organization")
- Talking down to home users — they're aspiring pros, not amateurs

## 8. Watch-outs (flagged during audit)

- **Unsubstantiated superlatives:** Lines like "one of the fastest growing beauty and grooming tool companies since the industrial revolution" and "rivaling billion-dollar companies" are on-voice in their boldness but legally soft. Recommend qualifying with a source (e.g., Inc. 500 recognition, which the site already displays) or softening in formal/press contexts.
- **Voice drift between sections:** Corporate copy occasionally slips into run-on, less polished sentences ("Join the revolution and experience."). Keep the bold-but-polished standard everywhere.
- **Consistency of S|C vs. SC vs. SIC:** Product listings show variants ("SIC Pro" mat). Standardize on S|C.

---

*Use this guide with content reviews: check any new copy against the five voice attributes, the tone spectrum for its channel, and the terminology table.*
`;
    this.brandVoiceGuides.push({
      id: "bvg_0",
      brand: "StyleCraft",
      content,
      version: 1,
      isActive: true,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Mirrors scripts/seed-faqs.ts's upsert logic, from the same shared
  // lib/faq-seed-data.ts source — sort_order is assigned per-category, in
  // the array's own listed order.
  seedFaqDefaults() {
    if (this.faqs.length > 0) return;
    const now = new Date();
    const countByCategory = new Map<string, number>();
    for (const entry of FAQ_SEED_DATA) {
      const sortOrder = countByCategory.get(entry.category) ?? 0;
      countByCategory.set(entry.category, sortOrder + 1);
      this.faqs.push({
        id: `faq_${this.faqs.length}`,
        category: entry.category,
        question: entry.question,
        answer: entry.answer,
        sortOrder,
        enabled: true,
        feature: entry.feature ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

// Global registry for development hot reloads
const globalForMemDb = globalThis as unknown as {
  memoryDb: MemoryDatabase | undefined;
};

export const memoryDb = globalForMemDb.memoryDb ?? new MemoryDatabase();
if (process.env.NODE_ENV !== "production") globalForMemDb.memoryDb = memoryDb;
export default memoryDb;
