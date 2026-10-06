// lib/db/gtm-workbook-templates.ts
// CRUD over gtm_workbook_templates — same Supabase+memoryDb dual-path style
// as lib/db/deck-templates.ts, which this directly clones. The binary
// .xlsx lives in the Supabase Storage bucket "gtm-workbook-templates" with
// a base64-on-the-row fallback for local dev without Supabase configured —
// no public URL either way (see supabase_schema.sql's gtm_workbook_templates
// comment), bytes are only ever served through the authenticated export
// route / admin routes.
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import { memoryDb, MockGtmWorkbookTemplate } from "@/lib/memoryDb";

const STORAGE_BUCKET = "gtm-workbook-templates";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface GtmWorkbookSheetSummary {
  sheetNames: string[];
  missingRequiredSheets: string[];
}

export type GtmTemplateIndustry = "barber" | "beauty";

export interface GtmWorkbookTemplateRow {
  id: string;
  name: string;
  file_path: string;
  file_name: string | null;
  file_size_bytes: number | null;
  sheet_summary: GtmWorkbookSheetSummary;
  is_active: boolean;
  uploaded_by: string | null;
  uploaded_at: string;
  updated_at: string;
  industry: GtmTemplateIndustry;
  field_inspection: any | null;
}

function emptySheetSummary(): GtmWorkbookSheetSummary {
  return { sheetNames: [], missingRequiredSheets: [] };
}

function mockToRow(row: MockGtmWorkbookTemplate): GtmWorkbookTemplateRow {
  return {
    id: row.id,
    name: row.name,
    file_path: row.id, // memoryDb has no real Storage path — the row id doubles as the lookup key
    file_name: row.fileName,
    file_size_bytes: row.fileSizeBytes,
    sheet_summary: row.sheetSummary ?? emptySheetSummary(),
    is_active: row.isActive,
    uploaded_by: row.uploadedBy,
    uploaded_at: row.uploadedAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    industry: row.industry,
    field_inspection: row.fieldInspection,
  };
}

export async function createGtmWorkbookTemplate(input: {
  name: string;
  fileBuffer: Buffer;
  fileName: string;
  sheetSummary: GtmWorkbookSheetSummary;
  uploadedBy?: string | null;
  industry: GtmTemplateIndustry;
  fieldInspection?: any | null;
}): Promise<GtmWorkbookTemplateRow> {
  const filePath = `${Date.now()}-${input.fileName.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

  if (isSupabaseConfigured) {
    try {
      const { error: uploadError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(filePath, input.fileBuffer, { contentType: XLSX_MIME_TYPE, upsert: true });
      if (uploadError) throw uploadError;

      const { data, error } = await supabaseAdmin
        .from("gtm_workbook_templates")
        .insert({
          name: input.name,
          file_path: filePath,
          file_name: input.fileName,
          file_size_bytes: input.fileBuffer.length,
          sheet_summary: input.sheetSummary,
          is_active: false,
          uploaded_by: input.uploadedBy ?? null,
          industry: input.industry,
          field_inspection: input.fieldInspection ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (e) {
      console.warn("Supabase GTM workbook template create failed, falling back to memoryDb:", e);
    }
  }

  const now = new Date();
  const row: MockGtmWorkbookTemplate = {
    id: `gtmwbtpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    name: input.name,
    fileBase64: input.fileBuffer.toString("base64"),
    fileName: input.fileName,
    fileSizeBytes: input.fileBuffer.length,
    sheetSummary: input.sheetSummary,
    isActive: false,
    uploadedBy: input.uploadedBy ?? null,
    uploadedAt: now,
    updatedAt: now,
    industry: input.industry,
    fieldInspection: input.fieldInspection ?? null,
  };
  memoryDb.gtmWorkbookTemplates.push(row);
  return mockToRow(row);
}

// Registers a template whose bytes are ALREADY in Storage — used by the
// signed-upload-URL flow (app/api/admin/gtm-workbook-templates/upload-url +
// .../finalize), where the browser uploads directly to Storage to bypass
// Vercel's serverless function request-body limit (~4.5MB), which a real
// multi-tab .xlsx can exceed. Supabase-only, same precedent as
// createDeckTemplateFromStoragePath.
export async function createGtmWorkbookTemplateFromStoragePath(input: {
  name: string;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  sheetSummary: GtmWorkbookSheetSummary;
  uploadedBy?: string | null;
  industry: GtmTemplateIndustry;
  fieldInspection?: any | null;
}): Promise<GtmWorkbookTemplateRow> {
  const { data, error } = await supabaseAdmin
    .from("gtm_workbook_templates")
    .insert({
      name: input.name,
      file_path: input.filePath,
      file_name: input.fileName,
      file_size_bytes: input.fileSizeBytes,
      sheet_summary: input.sheetSummary,
      is_active: false,
      uploaded_by: input.uploadedBy ?? null,
      industry: input.industry,
      field_inspection: input.fieldInspection ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listGtmWorkbookTemplates(): Promise<GtmWorkbookTemplateRow[]> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabaseAdmin
      .from("gtm_workbook_templates")
      .select("*")
      .order("uploaded_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  return [...memoryDb.gtmWorkbookTemplates]
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
    .map(mockToRow);
}

export async function getGtmWorkbookTemplateById(id: string): Promise<GtmWorkbookTemplateRow | null> {
  if (isSupabaseConfigured) {
    const { data } = await supabaseAdmin.from("gtm_workbook_templates").select("*").eq("id", id).maybeSingle();
    return data;
  }

  const row = memoryDb.gtmWorkbookTemplates.find(t => t.id === id);
  return row ? mockToRow(row) : null;
}

// GTM Multi-Template work — scoped to `industry` so BOTH a barber and a
// beauty template can be active simultaneously (a real scoped partial
// unique index enforces exactly one active row PER industry — see
// supabase_schema.sql Section 54 — not one active row globally like before).
// Defaults to "barber" only for backward-compat call sites not yet updated
// for multi-template — every real caller now passes an explicit industry.
export async function getActiveGtmWorkbookTemplate(industry: GtmTemplateIndustry = "barber"): Promise<GtmWorkbookTemplateRow | null> {
  if (isSupabaseConfigured) {
    const { data } = await supabaseAdmin.from("gtm_workbook_templates").select("*").eq("is_active", true).eq("industry", industry).maybeSingle();
    return data;
  }

  const row = memoryDb.gtmWorkbookTemplates.find(t => t.isActive && t.industry === industry);
  return row ? mockToRow(row) : null;
}

// Clears is_active on every OTHER row of the SAME industry, then sets it on
// `id` — scoped so activating a beauty template never deactivates the
// barber one (or vice versa). Same low-concurrency-tolerant,
// two-sequential-statement style as setActiveDeckTemplate (an admin-only,
// rare action, not a hot path).
export async function setActiveGtmWorkbookTemplate(id: string, industry: GtmTemplateIndustry): Promise<void> {
  if (isSupabaseConfigured) {
    const { error: clearError } = await supabaseAdmin.from("gtm_workbook_templates").update({ is_active: false }).eq("is_active", true).eq("industry", industry);
    if (clearError) throw clearError;
    const { error: setError } = await supabaseAdmin.from("gtm_workbook_templates").update({ is_active: true, updated_at: new Date().toISOString() }).eq("id", id);
    if (setError) throw setError;
    return;
  }

  for (const t of memoryDb.gtmWorkbookTemplates) {
    if (t.industry === industry) t.isActive = false;
  }
  const row = memoryDb.gtmWorkbookTemplates.find(t => t.id === id);
  if (row) {
    row.isActive = true;
    row.updatedAt = new Date();
  }
}

export async function deleteGtmWorkbookTemplate(id: string): Promise<void> {
  if (isSupabaseConfigured) {
    // Look up the Storage path first — deleting the row alone would leak
    // the uploaded .xlsx in the "gtm-workbook-templates" bucket forever
    // (nothing else ever references file_path once this row is gone).
    const { data: row } = await supabaseAdmin.from("gtm_workbook_templates").select("file_path").eq("id", id).maybeSingle();
    const { error } = await supabaseAdmin.from("gtm_workbook_templates").delete().eq("id", id);
    if (error) throw error;
    if (row?.file_path) {
      const { error: storageError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([row.file_path]);
      if (storageError) console.warn(`Failed to remove GTM workbook template file "${row.file_path}" from Storage:`, storageError.message);
    }
    return;
  }
  const idx = memoryDb.gtmWorkbookTemplates.findIndex(t => t.id === id);
  if (idx >= 0) memoryDb.gtmWorkbookTemplates.splice(idx, 1);
}

export async function getGtmWorkbookTemplateFileBuffer(template: GtmWorkbookTemplateRow): Promise<Buffer> {
  if (isSupabaseConfigured) {
    const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(template.file_path);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }

  const row = memoryDb.gtmWorkbookTemplates.find(t => t.id === template.id);
  if (!row) throw new Error(`GTM workbook template ${template.id} not found in memoryDb`);
  return Buffer.from(row.fileBase64, "base64");
}
