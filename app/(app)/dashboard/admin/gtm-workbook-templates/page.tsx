"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldAlert, RefreshCw, Loader2, AlertCircle, Upload, CheckCircle2, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { GtmWorkbookTemplateRow, GtmTemplateIndustry } from "@/lib/db/gtm-workbook-templates";

const INDUSTRY_LABELS: Record<GtmTemplateIndustry, string> = {
  barber: "Barber",
  beauty: "Beauty",
};

export default function AdminGtmWorkbookTemplatesPage() {
  const { user, loading: authLoading } = useAuth();
  const [templates, setTemplates] = useState<GtmWorkbookTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadingIndustry, setUploadingIndustry] = useState<GtmTemplateIndustry | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const barberFileInputRef = useRef<HTMLInputElement>(null);
  const beautyFileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/gtm-workbook-templates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load GTM workbook templates");
      setTemplates(data.templates || []);
    } catch (err: any) {
      setError(err.message || "Failed to load GTM workbook templates");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user && (user.role === "OWNER" || user.role === "ADMIN")) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Same signed-upload-URL bypass as the Deck Templates admin page — a real
  // multi-tab .xlsx can exceed Vercel's ~4.5MB inbound body limit. GTM
  // Multi-Template work — every upload now targets a specific industry
  // (barber/beauty), both of which can have their own active template
  // simultaneously.
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>, industry: GtmTemplateIndustry) {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.xlsx$/i, "");
    setUploadingIndustry(industry);
    try {
      const urlRes = await fetch("/api/admin/gtm-workbook-templates/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name }),
      });
      const urlData = await urlRes.json();
      if (!urlRes.ok) throw new Error(urlData.error || "Failed to prepare upload");

      if (urlData.mode === "signed") {
        const { createSupabaseBrowserClient } = await import("@/lib/supabase-browser");
        const supabase = createSupabaseBrowserClient();
        const { error: uploadError } = await supabase.storage
          .from("gtm-workbook-templates")
          .uploadToSignedUrl(urlData.path, urlData.token, file);
        if (uploadError) throw new Error(uploadError.message || "Upload to storage failed");

        const finalizeRes = await fetch("/api/admin/gtm-workbook-templates/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: urlData.path, name, fileName: file.name, industry }),
        });
        const finalizeData = await finalizeRes.json();
        if (!finalizeRes.ok) throw new Error(finalizeData.error || "Failed to finalize upload");
        toast.success(`Uploaded — ${INDUSTRY_LABELS[industry]} template found all required sheets`);
      } else {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("name", name);
        formData.append("industry", industry);
        const res = await fetch("/api/admin/gtm-workbook-templates", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        toast.success(`Uploaded — ${INDUSTRY_LABELS[industry]} template found all required sheets`);
      }

      await load();
    } catch (err: any) {
      toast.error(err.message || "Failed to upload template");
    } finally {
      setUploadingIndustry(null);
      if (barberFileInputRef.current) barberFileInputRef.current.value = "";
      if (beautyFileInputRef.current) beautyFileInputRef.current.value = "";
    }
  }

  async function handleActivate(id: string) {
    setActivatingId(id);
    try {
      const res = await fetch(`/api/admin/gtm-workbook-templates/${id}/activate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to activate");
      toast.success("Template is now active — Download XLSX will use it");
      await load();
    } catch (err: any) {
      toast.error(err.message || "Failed to activate template");
    } finally {
      setActivatingId(null);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/gtm-workbook-templates/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete");
      toast.success("Template removed");
      setConfirmDeleteId(null);
      await load();
    } catch (err: any) {
      toast.error(err.message || "Failed to delete template");
    } finally {
      setDeletingId(null);
    }
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Spinner size="lg" className="text-accent" />
      </div>
    );
  }

  if (!user || (user.role !== "OWNER" && user.role !== "ADMIN")) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center space-y-3">
        <ShieldAlert className="w-8 h-8 mx-auto text-text-muted" />
        <h1 className="text-sm font-bold text-text-primary">Not authorized</h1>
        <p className="text-xs text-text-muted">This page is restricted to workspace owners/admins.</p>
      </div>
    );
  }

  const barberTemplates = templates.filter(t => (t.industry || "barber") === "barber");
  const beautyTemplates = templates.filter(t => t.industry === "beauty");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-accent" />
          <h1 className="text-display">GTM Workbook Templates</h1>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-border hover:border-border-strong text-text-secondary text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>
      <p className="text-xs text-text-muted -mt-4">
        Barber and Beauty each have their own active template — the export auto-selects by the
        product&apos;s tool type (with a per-project override). Product Knowledge, BOX ONLY, Marketing
        Direction, Product FAQ, and Final Copy get filled with real data — every other tab is
        exported byte-for-byte untouched.
      </p>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-xs">Loading…</div>
      ) : error ? (
        <div className="p-8 text-center text-danger text-xs flex items-center justify-center gap-1.5">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      ) : (
        <>
          <IndustrySection
            industry="barber"
            templates={barberTemplates}
            uploading={uploadingIndustry === "barber"}
            activatingId={activatingId}
            fileInputRef={barberFileInputRef}
            onUpload={e => handleUpload(e, "barber")}
            onActivate={handleActivate}
            onDeleteRequest={setConfirmDeleteId}
          />
          <IndustrySection
            industry="beauty"
            templates={beautyTemplates}
            uploading={uploadingIndustry === "beauty"}
            activatingId={activatingId}
            fileInputRef={beautyFileInputRef}
            onUpload={e => handleUpload(e, "beauty")}
            onActivate={handleActivate}
            onDeleteRequest={setConfirmDeleteId}
          />
        </>
      )}

      <ConfirmDialog
        isOpen={!!confirmDeleteId}
        title="Delete this template?"
        description="This permanently removes the uploaded workbook and its file. This action is irreversible."
        confirmLabel="Delete template"
        loading={deletingId === confirmDeleteId}
        onConfirm={() => { if (confirmDeleteId) handleDelete(confirmDeleteId); }}
        onClose={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}

function IndustrySection({
  industry,
  templates,
  uploading,
  activatingId,
  fileInputRef,
  onUpload,
  onActivate,
  onDeleteRequest,
}: {
  industry: GtmTemplateIndustry;
  templates: GtmWorkbookTemplateRow[];
  uploading: boolean;
  activatingId: string | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onActivate: (id: string) => void;
  onDeleteRequest: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-text-primary uppercase tracking-wider">{INDUSTRY_LABELS[industry]} Templates</h2>
        <label className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          <span>Upload {INDUSTRY_LABELS[industry]} template</span>
          <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" disabled={uploading} onChange={onUpload} />
        </label>
      </div>

      <div className="border border-border rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_140px_120px_140px_140px] gap-3 px-4 py-2.5 bg-surface-3/30 border-b border-border text-[10px] font-bold text-text-muted uppercase tracking-wider">
          <span>Name</span>
          <span>Sheets Found</span>
          <span>Status</span>
          <span>Uploaded</span>
          <span></span>
        </div>

        {templates.length === 0 ? (
          <div className="p-8 text-center text-text-muted text-xs">
            No {INDUSTRY_LABELS[industry].toLowerCase()} template uploaded yet.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {templates.map(t => (
              <TemplateRow key={t.id} template={t} activatingId={activatingId} onActivate={onActivate} onDeleteRequest={onDeleteRequest} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateRow({
  template: t,
  activatingId,
  onActivate,
  onDeleteRequest,
}: {
  template: GtmWorkbookTemplateRow;
  activatingId: string | null;
  onActivate: (id: string) => void;
  onDeleteRequest: (id: string) => void;
}) {
  const [showInspection, setShowInspection] = useState(false);
  const sheetCount = t.sheet_summary?.sheetNames?.length || 0;
  const missing = t.sheet_summary?.missingRequiredSheets?.length || 0;
  const inspection = t.field_inspection as Record<string, { shared: string[]; candidateOnly: string[]; referenceOnly: string[] }> | null;

  return (
    <div>
      <div className="grid grid-cols-[1fr_140px_120px_140px_140px] gap-3 px-4 py-3 items-center text-xs">
        <span className="font-semibold text-text-primary truncate flex items-center gap-1.5">
          {t.name}
          {inspection && (
            <button
              type="button"
              onClick={() => setShowInspection(v => !v)}
              className="text-text-muted hover:text-text-secondary"
              title="Show label inspection vs. the barber reference template"
            >
              {showInspection ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          )}
        </span>
        <span>
          {missing > 0 ? (
            <Badge tone="danger" uppercase>{missing} missing</Badge>
          ) : (
            <Badge tone="success" uppercase>{sheetCount} sheets</Badge>
          )}
        </span>
        <span>
          {t.is_active ? (
            <span className="inline-flex items-center gap-1 text-success font-semibold">
              <CheckCircle2 className="w-3.5 h-3.5" /> Active
            </span>
          ) : (
            <span className="text-text-muted">Inactive</span>
          )}
        </span>
        <span className="text-text-muted text-[11px]">{new Date(t.uploaded_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        <span className="flex items-center gap-1.5">
          {!t.is_active && (
            <button
              type="button"
              onClick={() => onActivate(t.id)}
              disabled={activatingId === t.id}
              className="flex items-center gap-1 px-2 py-1 border border-border hover:border-border-strong text-text-secondary text-[10px] font-bold rounded-md transition-colors disabled:opacity-50"
            >
              {activatingId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Activate"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDeleteRequest(t.id)}
            title="Delete template"
            className="p-1.5 border border-border hover:border-danger/40 hover:text-danger text-text-muted rounded-md transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>
      {showInspection && inspection && (
        <div className="px-4 pb-4 space-y-3 bg-surface-3/20">
          <p className="text-[10px] text-text-muted">
            Label inspection vs. the barber reference template, per tab — shared labels reuse the
            same field; candidate-only labels are new to this template; reference-only labels exist
            in barber but weren&apos;t found here (a possible gap, not necessarily an error).
          </p>
          {Object.entries(inspection).map(([sheet, diff]) => (
            <div key={sheet} className="text-[11px] space-y-1">
              <div className="font-bold text-text-primary">{sheet}</div>
              <div className="grid grid-cols-3 gap-3">
                <LabelDiffColumn title="Shared" tone="success" labels={diff.shared} />
                <LabelDiffColumn title="New in this template" tone="default" labels={diff.candidateOnly} />
                <LabelDiffColumn title="Missing vs. barber" tone="danger" labels={diff.referenceOnly} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LabelDiffColumn({ title, tone, labels }: { title: string; tone: "success" | "danger" | "default"; labels: string[] }) {
  return (
    <div className="space-y-1">
      <div className={`text-[10px] font-bold uppercase tracking-wider ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text-muted"}`}>
        {title} ({labels.length})
      </div>
      <ul className="text-[10px] text-text-secondary space-y-0.5 max-h-32 overflow-y-auto">
        {labels.map((l, i) => (
          <li key={i} className="truncate" title={l}>{l}</li>
        ))}
        {labels.length === 0 && <li className="text-text-muted">—</li>}
      </ul>
    </div>
  );
}
