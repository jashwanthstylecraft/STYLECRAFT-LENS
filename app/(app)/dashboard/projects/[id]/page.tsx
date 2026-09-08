// app/(app)/dashboard/projects/[id]/page.tsx
"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Sparkles,
  FileText,
  Plus,
  Trash2,
  ChevronRight,
  Loader2,
  Briefcase,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  DollarSign,
  Download,
  Edit2,
  Check,
  Globe,
  Sliders,
  Target,
  Eye,
  RefreshCw,
  Undo2,
  AlertCircle,
  Mail,
  BookmarkPlus,
  Star,
  Minus
} from "lucide-react";
import { toast } from "sonner";
import { downloadTabPDF, downloadReportPDF } from "@/lib/export-pdf";
import type { ToolTypeRow } from "@/lib/db/tool-types";
import { SaveToDriveButton } from "@/components/ui/SaveToDriveButton";
import { SourceDocsTab } from "@/components/project/SourceDocsTab";
import { LinkReportModal } from "@/components/project/LinkReportModal";
import { GTM_FIELD_SCHEMA, GTM_SECTIONS, GTM_SOURCE_LABELS, visibleGtmSchema, resolveGtmFamily } from "@/lib/gtm-field-schema";
import { CONTENT_FORM_SCHEMA, CONTENT_FORM_SECTIONS } from "@/lib/content-form-field-schema";
import { ComparisonChartPicker, type ComparisonChartSlot } from "@/components/analyze/ComparisonChartPicker";
import { TDS_FIELD_SCHEMA, TDS_SECTIONS } from "@/lib/tds-field-schema";
import { isRealAnswer, isAwaitingInternalInput, isNotDeterminable, type FillReport } from "@/lib/field-answer-state";
import { ProjectGenerationProgress } from "@/components/projects/ProjectGenerationProgress";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { MagicBentoSection, MagicBentoCard } from "@/components/ui/MagicBento";
import { useGlassMode, GlassModeOverride } from "@/stores/backgroundStageStore";
import FaqHelpLink from "@/components/help/FaqHelpLink";
import { useContactSupport } from "@/components/help/ContactSupportProvider";
import { getMultiplier, COUNTRY_OPTIONS, PRODUCT_TYPE_OPTIONS, ROYALTY_TYPE_OPTIONS, ROYALTY_PCT_BY_TYPE, TARIFF_EFFECTIVE_NOTE, type Country, type ProductType, type RoyaltyType } from "@/lib/tariff-multipliers";
import { computePriceStack } from "@/lib/price-stack";

type Tab = "competitive-analysis" | "pricing" | "go-to-market" | "content-form" | "sources";
// Content Form moved off the flat-JSONB report-driven model onto its own
// field-granular document (doc_type="content_form", see ContentFormSection)
// — same "doesn't depend on a linked report" reasoning as sources.
type ReportTab = Exclude<Tab, "sources" | "content-form">;

export default function ProjectDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("competitive-analysis");
  const [selectedReport, setSelectedReport] = useState<any>(null);
  const [linkingReport, setLinkingReport] = useState(false);
  const [pipelineState, setPipelineState] = useState<any>(null);
  // Automatic Source-Doc Fact Extraction & Cross-Document Fill — the
  // resumable "fill GTM -> fill Content Form" chain's current state. Polled
  // (not just fetched once) from a driver mounted HERE, at the page level,
  // rather than inside SourceDocsTab — this component stays mounted across
  // every tab switch (only the tab's own child component remounts), so
  // switching away from Sources never interrupts the chain, and reopening
  // the project later resumes it via the same GET-then-poll effect below.
  const [fillState, setFillState] = useState<any>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Defaults true (matches lib/db/feature-flags.ts's own default-enabled
  // behavior) so the TDS section doesn't flash in on the first render while
  // the real flag value is still loading — a false default would incorrectly
  // hide it for that first frame instead.
  const [tdsEnabled, setTdsEnabled] = useState(true);
  // Marketing Direction generation defaults to enabled at the flag layer
  // (unlike deckEnabled above) — default this to true so the progress
  // stepper shows its row from the first frame instead of it popping in.
  const [marketingDirectionEnabled, setMarketingDirectionEnabled] = useState(true);
  // Content Form generation also defaults to enabled at the flag layer —
  // same reasoning as marketingDirectionEnabled above.
  const [contentFormEnabled, setContentFormEnabled] = useState(true);
  const { open: openContactSupport } = useContactSupport();

  // Fetched once here and threaded into downloadReportPDF/downloadTabPDF
  // (lib/export-pdf.ts) — that module renders client-side, with no other
  // existing tool-types fetch to reuse.
  const [toolTypes, setToolTypes] = useState<ToolTypeRow[]>([]);
  useEffect(() => {
    fetch("/api/tool-types")
      .then(res => res.json())
      .then(data => { if (Array.isArray(data.toolTypes)) setToolTypes(data.toolTypes); })
      .catch(() => {});
  }, []);

  const fetchProjectDetails = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/projects/${id}`);
      if (!res.ok) {
        if (res.status === 404) {
          toast.error("Project not found");
          router.push("/dashboard/projects");
          return;
        }
        throw new Error();
      }
      const data = await res.json();
      setProject(data.project);
      
      // Load reports linked to this project
      const reps = data.project.reports || [];
      setReports(reps);
      if (reps.length > 0) {
        // Retain selection if possible
        const alreadySelected = selectedReport ? reps.find((r: any) => r.id === selectedReport.id) : null;
        setSelectedReport(alreadySelected || reps[0]);
      } else {
        setSelectedReport(null);
      }
    } catch (e) {
      toast.error("Failed to load project details");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) fetchProjectDetails();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/projects/${id}/pipeline`)
      .then(r => r.json())
      .then(data => setPipelineState(data.state ?? null))
      .catch(() => {});
  }, [id]);

  // Automatic Source-Doc Fact Extraction & Cross-Document Fill — resumable
  // one-step-per-request chain (see lib/document-fill-engine.ts's
  // runNextFillStep). Mounted at the PAGE level (not inside SourceDocsTab)
  // so switching tabs never interrupts an in-flight chain; runs once on
  // mount to resume anything already "running" (e.g. from before the user
  // closed the tab), and again whenever SourceDocsTab's onSourceUploaded
  // fires (pollGeneration below is exposed for that). No fixed polling
  // interval — same tight "await, then immediately loop" pattern as
  // ProgressPanel/ProjectGenerationProgress, since each step is itself a
  // short, bounded request.
  const pollFillState = useRef<() => void>(() => {});
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function run() {
      try {
        const res = await fetch(`/api/projects/${id}/fill-from-sources/continue`);
        const data = await res.json();
        let state = data.state;
        if (cancelled) return;
        setFillState(state);
        const wasRunning = state?.status === "running";

        while (!cancelled && state?.status === "running") {
          const contRes = await fetch(`/api/projects/${id}/fill-from-sources/continue`, { method: "POST" });
          const contData = await contRes.json();
          state = contData.state;
          if (cancelled) return;
          setFillState(state);
        }

        if (!cancelled && wasRunning && state?.status === "complete") {
          const gtmResult = state.results?.gtm;
          const cfResult = state.results?.content_form;
          const parts: string[] = [];
          if (gtmResult) parts.push(`${(gtmResult.filled || 0) + (gtmResult.regenerated || 0)} in GTM`);
          if (cfResult) parts.push(`${cfResult.regenerated || 0} in Content Form`);
          const total = (gtmResult?.filled || 0) + (gtmResult?.regenerated || 0) + (cfResult?.regenerated || 0);
          if (total > 0) {
            toast.success(`Sources updated — filled ${parts.join(", ")}`, {
              description: state.triggered_by_file_name ? `From ${state.triggered_by_file_name}` : undefined,
            });
          }
        }
      } catch {
        // Best-effort — a failed poll just means the chain resumes the next
        // time this effect runs (e.g. the next page visit), never surfaced
        // as an error to the user.
      }
    }

    pollFillState.current = run;
    run();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    fetch("/api/features")
      .then(r => r.json())
      .then(data => {
        if (typeof data.tds_enabled === "boolean") setTdsEnabled(data.tds_enabled);
        if (typeof data.marketing_direction_generation_enabled === "boolean") setMarketingDirectionEnabled(data.marketing_direction_generation_enabled);
        if (typeof data.content_form_generation_enabled === "boolean") setContentFormEnabled(data.content_form_generation_enabled);
      })
      .catch(() => {});
  }, []);

  const handleDeleteProject = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();

      toast.success("Project deleted");
      router.push("/dashboard/projects");
    } catch (e) {
      toast.error("Failed to delete project");
      setDeleting(false);
    }
  };

  const formatRelativeTime = (dateString: string) => {
    if (!dateString) return "Never";
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return `${diffDays} days ago`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-24">
        <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
        <p className="text-xs text-text-muted">Loading project workspace...</p>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="space-y-6">
      {/* Back Link */}
      <div className="flex flex-col gap-4">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary self-start transition-colors cinema-text"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to projects</span>
        </button>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-surface-2 border border-border rounded-xl">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/25 flex items-center justify-center text-accent">
              <Briefcase className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-display leading-none">{project.name}</h1>
                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-bold bg-accent-bg border border-accent-border text-accent-text uppercase tracking-wider">
                  {project.industry === "grooming-barbering" ? "Grooming & Barbering" : "Hair Care & Styling"}
                </span>
              </div>
              <p className="text-xs text-text-muted mt-1">Product: <span className="font-semibold text-text-secondary">{project.productName}</span></p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto">
            <button
              onClick={() => router.push(`/dashboard/analyze?projectId=${id}`)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-bold rounded-lg transition-colors shadow shadow-accent/25"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Run analysis</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Left Side: Product Specifications (4/12) */}
        <div className="lg:col-span-4 bg-surface-2 border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider">Product specs & context</h2>
          
          <div className="space-y-4 text-xs">
            <div className="space-y-1">
              <span className="text-[10px] text-text-muted uppercase font-bold block">Description</span>
              <p className="text-text-primary leading-relaxed">{project.description}</p>
            </div>

            {project.category && (
              <div className="space-y-1">
                <span className="text-[10px] text-text-muted uppercase font-bold block">Market / Amazon Category</span>
                <p className="text-text-primary font-semibold">{project.category}</p>
              </div>
            )}

            {project.pricePoint && (
              <div className="space-y-1">
                <span className="text-[10px] text-text-muted uppercase font-bold block">Target Price Point</span>
                <p className="text-text-primary font-semibold">{project.pricePoint}</p>
              </div>
            )}

            {project.targetMarket && (
              <div className="space-y-1">
                <span className="text-[10px] text-text-muted uppercase font-bold block">Target Market Tier</span>
                <p className="text-text-primary font-semibold uppercase">{project.targetMarket}</p>
              </div>
            )}

            {(project.motorTech || project.keyDiff || project.companyContext) && (
              <div className="pt-3 border-t border-border/60 space-y-3">
                <span className="text-[10px] text-text-muted uppercase font-bold block font-mono">Hardware & Positioning specs</span>

                {project.motorTech && (
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-text-secondary">Motor type</span>
                    <span className="text-text-primary font-semibold">{project.motorTech}</span>
                  </div>
                )}
                {project.keyDiff && (
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-text-secondary">Differentiator</span>
                    <span className="text-text-primary font-semibold">{project.keyDiff}</span>
                  </div>
                )}
                {project.companyContext && (
                  <div className="space-y-1 pt-1">
                    <span className="text-[9px] text-text-muted uppercase font-bold block">Positioning Context</span>
                    <p className="text-text-secondary italic leading-relaxed">{project.companyContext}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Linked Reports Workspace (8/12) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Project Outputs & Document Generators Bar — renders regardless
              of whether a report is linked; Sales Kit still needs one for
              its "Active Report" cross-references, but TDS/GTM download
              and Save-to-Drive buttons work off the project alone. */}
          <ProjectOutputsBar project={project} report={selectedReport} tdsEnabled={tdsEnabled} />

          {/* Report selector and download bar — only meaningful once a
              report is linked; the tab bar itself (below) is NOT gated on
              this, since Project Deck doesn't depend on a report at all —
              a project with zero linked reports must still be able to
              reach it. */}
          {reports.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-surface-2 border border-border rounded-xl">
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-text-muted uppercase font-mono tracking-wider">Active Report:</span>
                <select
                  value={selectedReport?.id}
                  onChange={e => setSelectedReport(reports.find(r => r.id === e.target.value))}
                  className="px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-xs outline-none focus:border-accent font-semibold"
                >
                  {reports.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.title} — {formatRelativeTime(r.created_at)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLinkingReport(true)}
                  className="px-3 py-1.5 border border-border bg-surface-3/40 hover:bg-surface-3 text-text-primary text-xs font-bold rounded-lg transition-colors"
                >
                  Link report
                </button>
                <button
                  onClick={() => downloadReportPDF(selectedReport, toolTypes)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs font-bold rounded-lg transition-colors shadow shadow-accent/20"
                  title="Export whole report PDF"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export full PDF</span>
                </button>
              </div>
            </div>
          )}

          <div className="space-y-4">
            {/* Tab Navigation — always visible; Sources doesn't depend on a
                linked report */}
            <div className="flex items-center gap-1 border-b border-border overflow-x-auto cinema-text">
              {(["competitive-analysis", "pricing", "go-to-market", "content-form", "sources"] as Tab[]).map(tab => (
                <button
                  key={tab}
                  className={`px-4 py-2 border-b-2 font-bold text-xs transition-colors whitespace-nowrap ${
                    activeTab === tab
                      ? "border-accent text-accent"
                      : "border-transparent text-text-secondary hover:text-text-primary"
                  }`}
                  onClick={() => setActiveTab(tab)}
                >
                  {TAB_LABELS[tab]}
                </button>
              ))}
              <FaqHelpLink
                category={TAB_FAQ_CATEGORY[activeTab]}
                className="ml-auto shrink-0 inline-flex items-center justify-center text-text-muted hover:text-accent transition-colors"
                title={`Help: ${TAB_LABELS[activeTab]}`}
              />
              <button
                type="button"
                onClick={() => openContactSupport({ context: { tab: TAB_LABELS[activeTab], projectId: id, productName: project?.productName } })}
                className="shrink-0 mr-2 inline-flex items-center justify-center text-text-muted hover:text-accent transition-colors"
                title="Contact support about this project"
              >
                <Mail className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Tab Content Canvas — a fully opaque bg-surface-2 box, so
                nothing rendered inside it (Sources/Content Form tabs
                directly, Competitive Analysis/Pricing/Go-To-Market via
                ReportTabContent) is actually floating over the route's
                cinema background image the way useGlassMode()'s route-based
                default assumes. Confirmed live via screenshot: MagicBentoCard's
                near-white/gray "glass" text tokens, calibrated for a
                near-black translucent fill directly over that image, went
                low-contrast when blended against this opaque box's real
                (light-in-light-theme) color instead. GlassModeOverride forces
                every useGlassMode() call in this subtree to the correct
                answer — solid, not glass — with no changes needed in any of
                the nested tab components themselves. */}
            <GlassModeOverride value={false}>
            <div className="bg-surface-2 border border-border rounded-xl p-5 md:p-6 shadow-sm">
              {activeTab === "sources" ? (
                <SourceDocsTab projectId={id} onSourceUploaded={() => pollFillState.current()} projectReferenceUrls={project?.referenceUrls} onReferenceUrlsChange={(urls: string[]) => setProject((p: any) => (p ? { ...p, referenceUrls: urls } : p))} />
              ) : activeTab === "content-form" ? (
                <ContentFormSection projectId={id} pipelineStatus={pipelineState?.status} pipelinePhase={pipelineState?.phase} pipelineErrorMessage={pipelineState?.error_message} fillStatus={fillState?.status} />
              ) : selectedReport ? (
                <ReportTabContent
                  report={selectedReport}
                  activeTab={activeTab}
                  onUpdate={fetchProjectDetails}
                  projectId={id}
                  toolTypes={toolTypes}
                />
              ) : (
                /* Empty state — scoped to just this canvas, not the whole
                   page, so the tab bar and Project Deck stay reachable. */
                <div className="flex flex-col items-center justify-center p-8 text-center space-y-3">
                  <div className="w-10 h-10 rounded-full bg-surface-3 border border-border flex items-center justify-center text-base">📊</div>
                  <div className="space-y-1">
                    <h3 className="text-xs font-bold text-text-primary">No report linked</h3>
                    <p className="text-[11px] text-text-muted max-w-sm">Run a competitive analysis to compile a report, or link an existing report in your database.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => router.push(`/dashboard/analyze?projectId=${id}`)}
                      className="px-3.5 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs font-bold rounded-lg transition-colors shadow"
                    >
                      Run analysis
                    </button>
                    <button
                      onClick={() => setLinkingReport(true)}
                      className="px-3.5 py-1.5 border border-border bg-surface-3/50 hover:bg-surface-3 text-text-primary text-xs font-bold rounded-lg transition-colors"
                    >
                      Link report
                    </button>
                  </div>
                </div>
              )}
            </div>
            </GlassModeOverride>
          </div>

          {/* TDS + GTM live independently of whether a report is linked —
              every project now gets this pipeline automatically on
              creation. Mount condition intentionally only excludes
              "complete" — a "failed" pipeline must stay visible (with its
              Retry button) on every page load, not just live in the same
              session where it failed. */}
          {pipelineState && pipelineState.status !== "complete" && (
            <ProjectGenerationProgress projectId={id} tdsEnabled={tdsEnabled} marketingDirectionEnabled={marketingDirectionEnabled} contentFormEnabled={contentFormEnabled} onDone={() => { fetchProjectDetails(); setPipelineState((s: any) => s ? { ...s, status: "complete" } : s); }} />
          )}
          {tdsEnabled && <TdsKnowledgeSection projectId={id} pipelineStatus={pipelineState?.status} />}
          <ProductKnowledgeSection projectId={id} pipelineStatus={pipelineState?.status} pipelinePhase={pipelineState?.phase} fillStatus={fillState?.status} projectSku={project?.sku} onSkuChange={(sku: string) => setProject((p: any) => (p ? { ...p, sku } : p))} projectToolType={project?.toolType} projectGtmTemplateOverride={project?.gtmTemplateOverride} onGtmTemplateOverrideChange={(v: string | null) => setProject((p: any) => (p ? { ...p, gtmTemplateOverride: v } : p))} toolTypes={toolTypes} />
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-surface-2 border border-danger/25 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-danger">
          <AlertTriangle className="w-4 h-4" />
          <h2 className="text-xs font-bold uppercase tracking-wider">Danger Zone</h2>
        </div>
        <p className="text-[11px] text-text-muted leading-normal">
          Permanently delete this project and its related database indexes. This action is irreversible.
        </p>
        <button
          onClick={() => setConfirmDeleteOpen(true)}
          className="px-4 py-2 bg-danger/10 border border-danger/35 hover:bg-danger/20 text-danger text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 w-full sm:w-auto"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Delete project</span>
        </button>
      </div>

      {/* Link Report Modal */}
      <LinkReportModal
        isOpen={linkingReport}
        projectId={id}
        onLinked={fetchProjectDetails}
        onClose={() => setLinkingReport(false)}
      />

      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title="Delete this project?"
        description="This will permanently delete the project and remove related database indexes. This action is irreversible."
        confirmLabel="Delete project"
        loading={deleting}
        onConfirm={handleDeleteProject}
        onClose={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}

const TAB_LABELS: Record<Tab, string> = {
  "competitive-analysis": "Competitive Analysis",
  "pricing":              "Pricing",
  "go-to-market":         "Go To Market",
  "content-form":         "Content Form",
  "sources":              "Sources",
};

// Maps each tab to the FAQ category its contextual "?" icon deep-links to
// (see lib/faq-seed-data.ts's FAQ_CATEGORIES). Sources reuses Go To Market's
// category — the closest existing one (uploaded docs exist to feed GTM
// generation), rather than adding a whole new FAQ category for this pass.
const TAB_FAQ_CATEGORY: Record<Tab, string> = {
  "competitive-analysis": "Competitive Analysis Tab",
  "pricing":              "Pricing Tab",
  "go-to-market":         "Go To Market Tab",
  "content-form":         "Content Form Tab",
  "sources":              "Go To Market Tab",
};

// ─── Tab Content Container ──────────────────────────────────────────────────
// Only ever called for the 3 report-driven tabs now.
function ReportTabContent({
  report,
  activeTab,
  onUpdate,
  projectId,
  toolTypes,
}: {
  report: any;
  activeTab: ReportTab;
  onUpdate: () => void;
  projectId: string;
  toolTypes: ToolTypeRow[];
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localData, setLocalData] = useState<any>(null);

  const dataKey = {
    "competitive-analysis": "competitive_analysis",
    "pricing":              "pricing_analysis",
    "go-to-market":         "go_to_market",
  }[activeTab];

  const tabData = report[dataKey] || {};

  // Sync local editing state when tab or report changes
  useEffect(() => {
    setLocalData(tabData);
    setEditing(false);
  }, [report.id, activeTab]);

  async function saveEdit() {
    setSaving(true);
    try {
      const res = await fetch(`/api/reports/${report.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [dataKey]: localData })
      });
      if (!res.ok) throw new Error();
      toast.success("Changes saved successfully");
      setEditing(false);
      onUpdate();
    } catch (e) {
      toast.error("Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
          {activeTab === "competitive-analysis" && <Globe className="w-4 h-4 text-accent" />}
          {activeTab === "pricing" && <DollarSign className="w-4 h-4 text-accent" />}
          {activeTab === "go-to-market" && <Sliders className="w-4 h-4 text-accent" />}
          <span>{TAB_LABELS[activeTab]}</span>
        </h3>
        
        <div className="flex items-center gap-2">
          <button
            onClick={() => downloadTabPDF(report, activeTab, toolTypes)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-border bg-surface-3/50 hover:bg-surface-3 text-text-secondary text-[11px] font-bold rounded-lg transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export tab PDF</span>
          </button>
          
          {editing ? (
            <>
              <button 
                onClick={() => { setEditing(false); setLocalData(tabData); }} 
                className="px-3 py-1.5 hover:bg-surface-3 text-text-secondary text-[11px] font-bold rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={saveEdit} 
                disabled={saving} 
                className="flex items-center gap-1 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg disabled:opacity-50 transition-colors shadow"
              >
                {saving ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                <span>Save</span>
              </button>
            </>
          ) : (
            <button 
              onClick={() => { setEditing(true); setLocalData(tabData); }} 
              className="flex items-center gap-1 px-3 py-1.5 border border-border hover:border-border-strong text-text-secondary text-[11px] font-bold rounded-lg transition-colors"
            >
              <Edit2 className="w-3 h-3" />
              <span>Edit</span>
            </button>
          )}
        </div>
      </div>

      {/* RENDER ACTIVE TAB */}
      {activeTab === "competitive-analysis" && (
        <CompetitiveAnalysisTab
          data={tabData}
          editing={editing}
          localData={localData}
          setLocalData={setLocalData}
        />
      )}
      {activeTab === "pricing" && (
        <PricingTab
          data={tabData}
          editing={editing}
          localData={localData}
          setLocalData={setLocalData}
        />
      )}
      {activeTab === "go-to-market" && (
        <GoToMarketTab
          data={tabData}
          editing={editing}
          localData={localData}
          setLocalData={setLocalData}
          projectId={projectId}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// COMPETITIVE ANALYSIS TAB VIEW & EDIT
// ────────────────────────────────────────────────────────────────────────────
function CompetitiveAnalysisTab({ data, editing, localData, setLocalData }: any) {
  if (editing) {
    return (
      <MagicBentoCard className="p-5 space-y-4 text-xs">
        <div className="space-y-1">
          <label className="font-semibold text-text-primary">Market Snapshot Overview</label>
          <textarea
            rows={4}
            value={localData?.market_snapshot?.overview_paragraph || ""}
            onChange={e => setLocalData({
              ...localData,
              market_snapshot: {
                ...localData.market_snapshot,
                overview_paragraph: e.target.value
              }
            })}
            className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y"
          />
        </div>
        <div className="space-y-1">
          <label className="font-semibold text-text-primary">Positioning Strategy Statement</label>
          <textarea
            rows={3}
            value={localData?.positioning_recommendation || ""}
            onChange={e => setLocalData({
              ...localData,
              positioning_recommendation: e.target.value
            })}
            className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y"
          />
        </div>
      </MagicBentoCard>
    );
  }

  const snapshot = data.market_snapshot || {};
  const trends = data.key_trends || [];
  const gaps = data.market_gaps || [];
  const threats = data.top_threats || [];
  const opps = data.top_opportunities || [];
  const largeComps = data.large_brand_competitors || [];
  const emergingComps = data.indie_emerging_competitors || [];

  return (
    <MagicBentoSection className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
      {/* Overview Block */}
      <MagicBentoCard className="p-4 space-y-1.5 md:col-span-2">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
        <div className="p-4 border border-border bg-surface-3/20 rounded-xl space-y-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded text-[8px] font-bold bg-success-bg border border-success/20 text-success uppercase tracking-wider">
            growth
          </span>
          <p className="text-base font-black text-text-primary leading-tight">
            {snapshot.headline_stat_value || snapshot.market_size_current || "Market Growth Analysis"}
          </p>
        </div>
        <p className="md:col-span-3 text-text-secondary leading-relaxed p-1">
          {snapshot.overview_paragraph}
        </p>
        </div>
      </MagicBentoCard>

      {/* Trends */}
      <MagicBentoCard className="p-4 space-y-2.5">
          <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Key Industry Trends</h4>
          <ul className="space-y-2">
            {trends.map((t: any, i: number) => (
              <li key={i} className="flex gap-2">
                <span className="text-accent font-bold mt-0.5">•</span>
                <p className="text-text-secondary">
                  <strong className="text-text-primary">{t.trend_name}:</strong> {t.description}
                </p>
              </li>
            ))}
          </ul>
      </MagicBentoCard>
      {/* Gaps */}
      <MagicBentoCard className="p-4 space-y-2.5">
          <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Market Gaps</h4>
          <ul className="space-y-2">
            {gaps.map((g: any, i: number) => (
              <li key={i} className="flex gap-2 text-text-secondary">
                <span className="text-text-muted font-bold mt-0.5">·</span>
                <span>{g}</span>
              </li>
            ))}
          </ul>
      </MagicBentoCard>

      {/* Threats */}
      <MagicBentoCard className="p-4 space-y-2.5">
          <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-danger" />
            <span>Top Threats</span>
          </h4>
          <ul className="space-y-2">
            {threats.map((t: any, i: number) => (
              <li key={i} className="flex gap-2">
                <span className="text-danger font-bold mt-0.5"><Minus className="w-3 h-3" /></span>
                <p className="text-text-secondary">
                  <strong className="text-text-primary">{t.competitor_name}:</strong> {t.threat_description}
                </p>
              </li>
            ))}
          </ul>
      </MagicBentoCard>
      {/* Opportunities */}
      <MagicBentoCard className="p-4 space-y-2.5">
          <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
            <Lightbulb className="w-3.5 h-3.5 text-success" />
            <span>Top Opportunities</span>
          </h4>
          <ul className="space-y-2">
            {opps.map((o: any, i: number) => (
              <li key={i} className="flex gap-2">
                <span className="text-success font-bold mt-0.5"><Plus className="w-3 h-3" /></span>
                <p className="text-text-secondary">
                  <strong className="text-text-primary">{o.action}:</strong> {o.description}
                </p>
              </li>
            ))}
          </ul>
      </MagicBentoCard>

      {/* Competitors List (Legacy) */}
      <MagicBentoCard className="p-4 space-y-3">
        <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Large & Established Brands</h4>
        <div className="grid grid-cols-1 gap-3">
          {largeComps.map((c: any, i: number) => (
            <div key={i} className="p-3 bg-surface-3/30 border border-border rounded-lg space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-text-primary">{c.name}</span>
                <a href={c.amazon_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-accent hover:underline">
                  {c.verified_by_rainforest === false ? "Search Amazon ↗" : "Amazon Listing ↗"}
                </a>
              </div>
              <div className="text-[10px] text-text-muted flex justify-between">
                <span>Brand: {c.brand}</span>
                <span className="text-text-secondary font-bold">{c.price || "—"}</span>
                <span className="inline-flex items-center gap-0.5"><Star className="w-2.5 h-2.5 fill-warning text-warning" /> {c.rating || "—"} ({c.review_count || "—"})</span>
              </div>
              {c.verified_by_rainforest === false && (
                <span className="inline-block px-1.5 py-0.5 rounded text-[8px] font-bold bg-warning-bg border border-warning/20 text-warning uppercase tracking-wider">
                  Unverified — not matched on Amazon
                </span>
              )}
            </div>
          ))}
        </div>
      </MagicBentoCard>

      {/* Competitors List (Emerging) */}
      <MagicBentoCard className="p-4 space-y-3">
        <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Indie & Emerging Brands</h4>
        <div className="grid grid-cols-1 gap-3">
          {emergingComps.map((c: any, i: number) => (
            <div key={i} className="p-3 bg-surface-3/30 border border-border rounded-lg space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-text-primary">{c.name}</span>
                <a href={c.amazon_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-accent hover:underline">
                  {c.verified_by_rainforest === false ? "Search Amazon ↗" : "Amazon Listing ↗"}
                </a>
              </div>
              <div className="text-[10px] text-text-muted flex justify-between">
                <span>Brand: {c.brand}</span>
                <span className="text-text-secondary font-bold">{c.price || "—"}</span>
                <span className="inline-flex items-center gap-0.5"><Star className="w-2.5 h-2.5 fill-warning text-warning" /> {c.rating || "—"} ({c.review_count || "—"})</span>
              </div>
              {c.verified_by_rainforest === false && (
                <span className="inline-block px-1.5 py-0.5 rounded text-[8px] font-bold bg-warning-bg border border-warning/20 text-warning uppercase tracking-wider">
                  Unverified — not matched on Amazon
                </span>
              )}
            </div>
          ))}
        </div>
      </MagicBentoCard>

      {/* Positioning Statement */}
      <MagicBentoCard className="p-4 space-y-1 md:col-span-2" glowColor="99, 102, 241">
        <h4 className="text-[10px] font-bold text-accent-text uppercase tracking-wider">Positioning Recommendation</h4>
        <p className="text-text-secondary leading-relaxed italic">{data.positioning_recommendation}</p>
      </MagicBentoCard>
    </MagicBentoSection>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// TARIFF & LANDED-COST CALCULATOR — internal multiplier table (lib/tariff-
// multipliers.ts) + instant, deterministic price-stack math (lib/price-
// stack.ts), zero network calls. Persisted as a `tariff_price_stack` object
// nested inside the SAME pricing_analysis JSONB blob the rest of this tab
// already round-trips through — only the raw inputs are saved (country/
// product type/royalty type/FOB/other/overrides); the multiplier and full
// price stack are always re-derived live from those inputs (both here in
// edit mode and in the read-only view below), so there's never a stale
// cached number to fall out of sync with its own inputs.
// ────────────────────────────────────────────────────────────────────────────
interface TariffPriceStackData {
  country?: Country;
  product_type?: ProductType;
  royalty_type?: RoyaltyType;
  fob_cost?: number;
  other_costs?: number;
  royalty_pct_override?: number;
  salon_price_override?: number;
  retail_price_override?: number;
  retail_touched?: boolean;
}

function gmBandClass(band: "green" | "amber" | "neutral"): string {
  return band === "green" ? "text-success" : band === "amber" ? "text-warning" : "text-text-muted";
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function TariffPriceStackEditor({ value, onChange }: { value: TariffPriceStackData; onChange: (v: TariffPriceStackData) => void }) {
  const { country, product_type: productType, royalty_type: royaltyType } = value;
  const fobCost = value.fob_cost ?? 0;
  const otherCosts = value.other_costs ?? 0;
  const defaultRoyaltyPct = royaltyType ? ROYALTY_PCT_BY_TYPE[royaltyType] : 0;
  const royaltyPct = value.royalty_pct_override ?? defaultRoyaltyPct;

  const multiplierResult = country && productType && royaltyType ? getMultiplier(country, productType, royaltyType) : null;
  const stack = multiplierResult?.multiplier != null
    ? computePriceStack({
        fobCost, multiplier: multiplierResult.multiplier, royaltyPct, otherCosts,
        salonPriceOverride: value.salon_price_override ?? null,
        retailPriceOverride: value.retail_price_override ?? null,
      })
    : null;

  function update(patch: Partial<TariffPriceStackData>) {
    onChange({ ...value, ...patch });
  }

  function handleSalonChange(raw: string) {
    const num = parseFloat(raw);
    // Editing Salon reseeds Retail's own SUGGESTION only if the user hasn't
    // manually touched Retail yet — an existing manual Retail edit is never
    // clobbered by an upstream Salon change.
    update({ salon_price_override: isNaN(num) ? undefined : num, ...(value.retail_touched ? {} : { retail_price_override: undefined }) });
  }

  function handleRetailChange(raw: string) {
    const num = parseFloat(raw);
    update({ retail_price_override: isNaN(num) ? undefined : num, retail_touched: true });
  }

  return (
    <div className="space-y-4">
      <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Tariff & Landed Cost Calculator</h4>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-text-secondary">Country of Origin</label>
          <select
            value={country || ""}
            onChange={e => update({ country: (e.target.value || undefined) as Country | undefined })}
            className="w-full px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-[11px] outline-none focus:border-accent"
          >
            <option value="">Select…</option>
            {COUNTRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-text-secondary">Product Type</label>
          <select
            value={productType || ""}
            onChange={e => update({ product_type: (e.target.value || undefined) as ProductType | undefined })}
            className="w-full px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-[11px] outline-none focus:border-accent"
          >
            <option value="">Select…</option>
            {PRODUCT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-text-secondary">Royalty Type</label>
          <select
            value={royaltyType || ""}
            onChange={e => update({ royalty_type: (e.target.value || undefined) as RoyaltyType | undefined })}
            className="w-full px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-[11px] outline-none focus:border-accent"
          >
            <option value="">Select…</option>
            {ROYALTY_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {country && productType && royaltyType && (
        multiplierResult?.multiplier != null ? (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent/10 border border-accent/25 rounded-lg">
            <span className="text-[10px] text-text-muted uppercase font-bold">Multiplier</span>
            <span className="text-sm font-black text-accent">{multiplierResult.multiplier.toFixed(2)}×</span>
          </div>
        ) : (
          <div className="px-3 py-1.5 bg-danger-bg border border-danger/25 rounded-lg text-[11px] text-danger font-semibold">
            {multiplierResult?.error}
          </div>
        )
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-text-secondary">FOB Cost ($)</label>
          <input
            type="number" step="0.01"
            value={value.fob_cost ?? ""}
            onChange={e => update({ fob_cost: e.target.value === "" ? undefined : parseFloat(e.target.value) })}
            className="w-full px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-[11px] outline-none focus:border-accent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-text-secondary">Other Costs ($)</label>
          <input
            type="number" step="0.01"
            value={value.other_costs ?? ""}
            onChange={e => update({ other_costs: e.target.value === "" ? undefined : parseFloat(e.target.value) })}
            className="w-full px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-[11px] outline-none focus:border-accent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-text-secondary">Royalty %{royaltyType ? ` (default ${(defaultRoyaltyPct * 100).toFixed(0)}%)` : ""}</label>
          <input
            type="number" step="0.1"
            value={value.royalty_pct_override != null ? value.royalty_pct_override * 100 : (royaltyType ? defaultRoyaltyPct * 100 : "")}
            onChange={e => update({ royalty_pct_override: e.target.value === "" ? undefined : parseFloat(e.target.value) / 100 })}
            className="w-full px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary text-[11px] outline-none focus:border-accent"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => toast.success("Price stack recalculated")}
        disabled={!stack}
        className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
      >
        Calculate
      </button>

      {stack && (
        <div className="space-y-3 pt-3 border-t border-border/60">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
            <div className="p-2.5 bg-surface-3/30 rounded-lg">
              <div className="text-text-muted uppercase text-[9px] font-bold">Landed Cost</div>
              <div className="font-bold text-text-primary">{fmtUsd(stack.landedCost)}</div>
            </div>
            <div className="p-2.5 bg-surface-3/30 rounded-lg">
              <div className="text-text-muted uppercase text-[9px] font-bold">Adjusted Landed</div>
              <div className="font-bold text-text-primary">{fmtUsd(stack.adjustedLanded)}</div>
            </div>
            <div className="p-2.5 bg-surface-3/30 rounded-lg space-y-0.5">
              <div className="text-text-muted uppercase text-[9px] font-bold">Salon Price</div>
              <input
                type="number" step="0.01"
                value={value.salon_price_override ?? stack.salonPrice.toFixed(2)}
                onChange={e => handleSalonChange(e.target.value)}
                className="w-full bg-transparent font-bold text-text-primary outline-none border-b border-border/40 focus:border-accent"
              />
              <div className={`text-[10px] font-bold ${gmBandClass(stack.gmSalonBand)}`}>{stack.gmSalonPct != null ? `${(stack.gmSalonPct * 100).toFixed(1)}% GM` : "—"}</div>
            </div>
            <div className="p-2.5 bg-surface-3/30 rounded-lg space-y-0.5">
              <div className="text-text-muted uppercase text-[9px] font-bold">Dealer Price</div>
              <div className="font-bold text-text-primary">{fmtUsd(stack.dealerPrice)}</div>
              <div className={`text-[10px] font-bold ${gmBandClass(stack.gmDealerBand)}`}>{stack.gmDealerPct != null ? `${(stack.gmDealerPct * 100).toFixed(1)}% GM` : "—"}</div>
            </div>
          </div>

          <div className="p-3 bg-accent/10 border border-accent/25 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-[9px] text-text-muted uppercase font-bold">Target Retail Price</div>
              <input
                type="number" step="0.01"
                value={value.retail_price_override ?? stack.retailPrice.toFixed(2)}
                onChange={e => handleRetailChange(e.target.value)}
                className="bg-transparent text-lg font-black text-accent outline-none border-b border-accent/30 focus:border-accent w-32"
              />
            </div>
            <div className={`text-[11px] font-bold ${gmBandClass(stack.gmRetailBand)}`}>{stack.gmRetailPct != null ? `${(stack.gmRetailPct * 100).toFixed(1)}% GM` : "—"}</div>
          </div>
        </div>
      )}
      <p className="text-[10px] text-text-muted italic">{TARIFF_EFFECTIVE_NOTE}</p>
    </div>
  );
}

// Read-only rendering of a saved tariff_price_stack — re-derives the
// multiplier/full stack live from the saved raw inputs (same reasoning as
// the editor above: never a stale cached number).
function TariffPriceStackSummary({ tps }: { tps: TariffPriceStackData }) {
  if (!tps.country || !tps.product_type || !tps.royalty_type) return null;
  const mult = getMultiplier(tps.country, tps.product_type, tps.royalty_type);
  if (mult.multiplier == null) {
    return (
      <MagicBentoCard className="p-4">
        <span className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Tariff &amp; Landed Cost</span>
        <p className="text-[11px] text-danger mt-1">{mult.error}</p>
      </MagicBentoCard>
    );
  }
  const royaltyPct = tps.royalty_pct_override ?? ROYALTY_PCT_BY_TYPE[tps.royalty_type];
  const stack = computePriceStack({
    fobCost: tps.fob_cost || 0, multiplier: mult.multiplier, royaltyPct, otherCosts: tps.other_costs || 0,
    salonPriceOverride: tps.salon_price_override ?? null, retailPriceOverride: tps.retail_price_override ?? null,
  });
  return (
    <MagicBentoCard className="p-4 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <span className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Tariff &amp; Landed Cost</span>
          <p className="text-[11px] text-text-secondary font-mono tabular-nums">
            Multiplier <strong className="text-accent">{mult.multiplier.toFixed(2)}×</strong> · Landed {fmtUsd(stack.landedCost)} · Adjusted Landed {fmtUsd(stack.adjustedLanded)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] text-text-muted uppercase font-bold">Target Retail Price</div>
          <div className={`text-lg font-black font-mono tabular-nums ${gmBandClass(stack.gmRetailBand)}`}>{fmtUsd(stack.retailPrice)}</div>
        </div>
      </div>
      <p className="text-[10px] text-text-muted italic">{TARIFF_EFFECTIVE_NOTE}</p>
    </MagicBentoCard>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// PRICING TAB VIEW & EDIT
// ────────────────────────────────────────────────────────────────────────────
function PricingTab({ data, editing, localData, setLocalData }: any) {
  if (editing) {
    return (
      <div className="space-y-4">
        <MagicBentoCard className="p-5 space-y-4 text-xs">
          <div className="space-y-1">
            <label className="font-semibold text-text-primary">Pricing Index / Headline Positioning</label>
            <input
              type="text"
              value={localData?.price_positioning || ""}
              onChange={e => setLocalData({ ...localData, price_positioning: e.target.value })}
              className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="font-semibold text-text-primary">Pricing Strategy Notes</label>
            <textarea
              rows={5}
              value={localData?.notes || ""}
              onChange={e => setLocalData({ ...localData, notes: e.target.value })}
              className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y"
              placeholder="Type strategic pricing notes here..."
            />
          </div>
        </MagicBentoCard>

        <MagicBentoCard className="p-5 text-xs">
          <TariffPriceStackEditor
            value={localData?.tariff_price_stack || {}}
            onChange={v => setLocalData({ ...localData, tariff_price_stack: v })}
          />
        </MagicBentoCard>
      </div>
    );
  }

  const prices = data.competitors_pricing || [];

  return (
    <MagicBentoSection className="grid grid-cols-1 gap-4 text-xs">
      <MagicBentoCard className="p-4">
        <span className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Price Positioning Headline</span>
        <p className="text-sm font-bold text-text-primary mt-1">{data.price_positioning || "No pricing headline recorded."}</p>
      </MagicBentoCard>

      {data.tariff_price_stack && <TariffPriceStackSummary tps={data.tariff_price_stack} />}

      <MagicBentoCard className="p-4 space-y-2">
        <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Competitor Price Index</h4>
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-surface-3/50 border-b border-border text-[10px] text-text-muted uppercase font-mono">
                <th className="p-3">Competitor Name</th>
                <th className="p-3">Price Point</th>
                <th className="p-3">Market Tier</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p: any, i: number) => (
                <tr key={i} className="border-b border-border hover:bg-surface-3/10 transition-colors">
                  <td className="p-3 font-semibold text-text-primary">{p.name}</td>
                  <td className="p-3 font-mono tabular-nums text-accent font-bold">{p.price || "—"}</td>
                  <td className="p-3">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider ${
                      p.tier === "large" ? "bg-indigo-950 text-indigo-300" : "bg-emerald-950 text-emerald-300"
                    }`}>
                      {p.tier}
                    </span>
                  </td>
                </tr>
              ))}
              {prices.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-text-muted">No competitor pricing mapped.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </MagicBentoCard>

      <MagicBentoCard className="p-4 space-y-1.5">
        <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Pricing Strategy Notes</h4>
        <p className="text-text-secondary leading-relaxed bg-surface-3/15 p-3 rounded-lg border border-border/40 whitespace-pre-wrap">
          {data.notes || "Add strategy notes by clicking Edit."}
        </p>
      </MagicBentoCard>
    </MagicBentoSection>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// GO TO MARKET TAB VIEW & EDIT
// ────────────────────────────────────────────────────────────────────────────
function GoToMarketTab({ data, editing, localData, setLocalData, projectId }: any) {
  const [recsOpen, setRecsOpen] = useState(false);
  const isGlass = useGlassMode();

  const editBlock = editing && (
    <MagicBentoCard className="p-5 space-y-4 text-xs">
      <div className="space-y-1">
        <label className="font-semibold text-text-primary">Positioning Strategy</label>
        <textarea
          rows={3}
          value={localData?.positioning || ""}
          onChange={e => setLocalData({ ...localData, positioning: e.target.value })}
          className="font-body-doc w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y"
        />
      </div>
      <div className="space-y-1">
        <label className="font-semibold text-text-primary">Strategic notes & deployment details</label>
        <textarea
          rows={4}
          value={localData?.notes || ""}
          onChange={e => setLocalData({ ...localData, notes: e.target.value })}
          className="font-body-doc w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y"
          placeholder="Type strategic details..."
        />
      </div>
    </MagicBentoCard>
  );

  const recs = data.recommendations || [];
  const wins = data.quick_wins || [];

  return (
    <div className="space-y-6 text-xs">
      {editing ? (
        editBlock
      ) : (
        <div className={`border border-border rounded-xl overflow-hidden ${isGlass ? "cinema-glass" : ""}`}>
          <button
            type="button"
            onClick={() => setRecsOpen(o => !o)}
            className="w-full flex items-center justify-between px-4 py-3 bg-surface-3/30 hover:bg-surface-3/50 transition-colors"
          >
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Strategic Recommendations</span>
            <ChevronRight className={`w-3.5 h-3.5 text-text-muted transition-transform ${recsOpen ? "rotate-90" : ""}`} />
          </button>
          {recsOpen && (
            <MagicBentoSection className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <MagicBentoCard className="p-4 md:col-span-2">
                <span className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Core Positioning Statement</span>
                <p className="font-body-doc text-text-primary leading-relaxed mt-1 italic">{data.positioning || "No core positioning recorded."}</p>
              </MagicBentoCard>

                <MagicBentoCard className="p-4 space-y-2.5">
                  <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Strategic Recommendations</h4>
                  <div className="space-y-3">
                    {recs.map((r: any, i: number) => {
                      const priorityColors =
                        r.priority === "high" ? "border-l-2 border-danger bg-danger-bg/5 p-3 rounded-lg" :
                        r.priority === "medium" ? "border-l-2 border-warning bg-warning-bg/5 p-3 rounded-lg" :
                        "border-l-2 border-zinc-500 bg-surface-3/20 p-3 rounded-lg";
                      return (
                        <div key={i} className={priorityColors}>
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-text-primary">{r.title || r.headline}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider border ${
                              r.priority === "high" ? "bg-danger/10 border-danger/25 text-danger" :
                              r.priority === "medium" ? "bg-warning/10 border-warning/25 text-warning" :
                              "bg-zinc-800 border-zinc-700 text-zinc-400"
                            }`}>
                              {r.priority}
                            </span>
                          </div>
                          <p className="text-text-muted text-[10px] mt-1.5 leading-relaxed">{r.detail || r.explanation}</p>
                        </div>
                      );
                    })}
                  </div>
                </MagicBentoCard>

                <MagicBentoCard className="p-4 space-y-2.5">
                  <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Tactical Quick Wins</h4>
                  <ul className="space-y-2">
                    {wins.map((w: any, i: number) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-accent font-bold font-mono mt-0.5">»</span>
                        <span className="text-text-secondary leading-normal">{w}</span>
                      </li>
                    ))}
                  </ul>
                </MagicBentoCard>

              <MagicBentoCard className="p-4 space-y-1.5 md:col-span-2">
                <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">GTM Deployment Notes</h4>
                <p className="text-text-secondary leading-relaxed bg-surface-3/15 p-3 rounded-lg border border-border/40 whitespace-pre-wrap">
                  {data.notes || "Add deployment details by clicking Edit."}
                </p>
              </MagicBentoCard>
            </MagicBentoSection>
          )}
        </div>
      )}

    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// TECHNICAL DATA SHEET (live product snapshot — no AI regenerate)
// ────────────────────────────────────────────────────────────────────────────
const TDS_SOURCE_LABELS: Record<string, string> = {
  amazon: "Amazon",
  official_site: "Product Page",
  product_snapshot: "Snapshot",
  project_record: "Project",
  manual_edit: "Manual",
  web: "Web — verify",
  gtm_cross_fill: "From GTM",
  none: "Not Listed",
};

const isTdsFieldComplete = isRealAnswer;

function tdsFlagReason(detail: any): string {
  if (!detail) return "Flagged";
  if (detail.reason === "ungrounded") return `Rejected — the extracted answer ("${detail.rejectedAnswer}") wasn't found in the snapshot`;
  if (detail.conflict) return `Sources disagree: ${detail.conflict.map((c: any) => `${c.source}="${c.answer}"`).join(" vs ")}`;
  return "Flagged for review";
}

function snapshotDomain(sourceUrl: string | null | undefined, asin: string | null | undefined): string | null {
  if (sourceUrl) {
    try { return new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { return sourceUrl; }
  }
  return asin ? `Amazon (${asin})` : null;
}

function TdsKnowledgeSection({ projectId, pipelineStatus }: { projectId: string; pipelineStatus?: string }) {
  const isGlass = useGlassMode();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [snapshotMeta, setSnapshotMeta] = useState<{ capturedAt: string | null; sourceUrl: string | null; asin: string | null }>({ capturedAt: null, sourceUrl: null, asin: null });
  const [fields, setFields] = useState<Record<string, FieldRow>>({});
  const [fillReport, setFillReport] = useState<FillReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [fieldStatus, setFieldStatus] = useState<Record<string, FieldStatus>>({});
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/documents/tds?projectId=${projectId}`);
        const data = await res.json();
        if (data.document) {
          setDocumentId(data.document.id);
          setSnapshotMeta({
            capturedAt: data.document.snapshot_captured_at ?? null,
            sourceUrl: data.document.snapshot_source_url ?? null,
            asin: data.document.snapshot_asin ?? null,
          });
          const map: Record<string, FieldRow> = {};
          for (const f of data.fields) map[f.field_id] = f;
          setFields(map);
          setFillReport(data.document.fillReport ?? null);
        }
      } catch (e) {}
      setLoading(false);
    })();
    // Re-fetch whenever the auto-generation pipeline's status changes (e.g.
    // transitions to "complete") — otherwise a freshly-finished TDS document
    // only ever appeared after a manual page reload, since this fetch used
    // to depend only on projectId (same bug already fixed for GTM's
    // ProductKnowledgeSection below — applying the identical fix here).
  }, [projectId, pipelineStatus]);

  const completedCount = TDS_FIELD_SCHEMA.reduce((n, f) => n + (isTdsFieldComplete(fields[f.id]?.answer) ? 1 : 0), 0);

  async function handleCapture() {
    setCapturing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/snapshot`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Snapshot capture failed");
      setDocumentId(data.document.id);
      setSnapshotMeta({
        capturedAt: data.document.snapshot_captured_at ?? null,
        sourceUrl: data.document.snapshot_source_url ?? null,
        asin: data.document.snapshot_asin ?? null,
      });
      const map: Record<string, FieldRow> = {};
      for (const f of data.fields) map[f.field_id] = f;
      setFields(map);
      setFillReport(null); // stale until the next GET refetch — avoids showing a mismatched pre-capture breakdown
      toast.success("Live product snapshot captured");
    } catch (err: any) {
      toast.error(err.message || "Failed to capture snapshot");
    } finally {
      setCapturing(false);
    }
  }

  function handleFieldChange(fieldId: string, value: string) {
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], answer: value } }));
    if (debounceTimers.current[fieldId]) clearTimeout(debounceTimers.current[fieldId]);
    debounceTimers.current[fieldId] = setTimeout(() => saveField(fieldId, value), 800);
  }

  async function saveField(fieldId: string, value: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/tds/${documentId}/fields/${fieldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      setFieldStatus(prev => ({ ...prev, [fieldId]: "saved" }));
      setTimeout(() => setFieldStatus(prev => (prev[fieldId] === "saved" ? { ...prev, [fieldId]: "idle" } : prev)), 1500);
    } catch (e) {
      toast.error("Failed to save field");
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  async function handleRevert(fieldId: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/tds/${documentId}/fields/${fieldId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Nothing to revert to");
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      toast.success("Reverted to previous value");
    } catch (err: any) {
      toast.error(err.message || "Failed to revert field");
    } finally {
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  const hasDocument = !!documentId;
  const domain = snapshotDomain(snapshotMeta.sourceUrl, snapshotMeta.asin);

  return (
    <div className={`border border-border rounded-xl overflow-hidden ${isGlass ? "cinema-glass" : ""}`}>
      <div className="flex items-center justify-between px-4 py-3 bg-surface-3/30 border-b border-border flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Technical Data Sheet</span>
          <FaqHelpLink category="TDS" title="Help: TDS" />
          {hasDocument && (
            <span className="text-[10px] font-mono text-text-secondary px-1.5 py-0.5 rounded bg-surface-3 border border-border">
              {completedCount}/{TDS_FIELD_SCHEMA.length} fields completed
            </span>
          )}
          {hasDocument && formatFillReport(fillReport) && (
            <span className="text-[9px] text-text-muted" title="Fill breakdown by source tier">
              {formatFillReport(fillReport)}
            </span>
          )}
          {snapshotMeta.capturedAt && (
            <span className="text-[10px] text-text-muted italic">
              Live snapshot captured {new Date(snapshotMeta.capturedAt).toLocaleString()}{domain ? ` from ${domain}` : ""}
            </span>
          )}
        </div>
        <button
          onClick={handleCapture}
          disabled={capturing || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg disabled:opacity-50 transition-colors shadow"
        >
          {capturing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span>{hasDocument ? "Re-capture snapshot" : "Capture snapshot"}</span>
        </button>
      </div>

      {loading ? (
        <p className="p-4 text-text-muted text-[11px]">Loading…</p>
      ) : !hasDocument ? (
        <p className="p-4 text-text-muted text-[11px]">
          Capture a live snapshot from the product&apos;s official page and/or Amazon listing to fill this Technical
          Data Sheet with real, verifiable specs — no AI regeneration, just a real-time capture you can hand-edit.
          {!snapshotMeta.sourceUrl && !snapshotMeta.asin && " Add a product URL or ASIN to this project first."}
        </p>
      ) : (
        <div className="divide-y divide-border/60">
          {TDS_SECTIONS.map(section => (
            <div key={section} className="p-4 space-y-3">
              <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{section}</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                {TDS_FIELD_SCHEMA.filter(f => f.section === section).map(f => {
                  const entry = fields[f.id];
                  const complete = isTdsFieldComplete(entry?.answer);
                  const status = fieldStatus[f.id] || "idle";
                  const flagged = !!entry?.flagged;
                  const awaitingInternal = isAwaitingInternalInput(entry?.answer);
                  const notDeterminable = isNotDeterminable(entry?.answer);
                  // Same distinction as the GTM grid below: "never captured yet"
                  // (still needs attention) vs "captured but confirmed not
                  // listed" (a settled, non-urgent answer) vs "Awaiting internal
                  // input" (a genuine team decision) vs "Not determinable"
                  // (every fill tier verifiably ran) — previously all rendered
                  // as an identical amber chip.
                  const isPending = !complete && !awaitingInternal && !notDeterminable && (entry?.answer ?? "").trim() === "";
                  const isSettledNA = !complete && !awaitingInternal && !notDeterminable && !isPending;
                  const chipClass = flagged
                    ? "bg-danger/10 border-danger/30 text-danger"
                    : awaitingInternal
                    ? "bg-warning/10 border-warning/25 text-warning"
                    : notDeterminable
                    ? "bg-surface-3 border-border text-text-muted"
                    : isPending
                    ? "bg-warning/10 border-warning/25 text-warning"
                    : isSettledNA
                    ? "bg-surface-3 border-border text-text-muted"
                    : "bg-surface-3 border-border text-text-muted";
                  const chipLabel = awaitingInternal
                    ? "Awaiting Internal Input"
                    : notDeterminable
                    ? "Not Determinable"
                    : TDS_SOURCE_LABELS[entry?.source || "none"];
                  return (
                    <div key={f.id} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <label className="font-semibold text-text-primary text-[11px] flex items-center gap-1">
                          {f.question}
                          {flagged && (
                            <AlertCircle className="w-3 h-3 text-danger shrink-0" aria-label={tdsFlagReason(entry?.source_detail)} />
                          )}
                        </label>
                        <div className="flex items-center gap-1 shrink-0">
                          <span
                            className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${chipClass}`}
                            title={awaitingInternal ? `Set by ${f.owner || "your team"} — edit the field directly` : undefined}
                          >
                            {chipLabel}
                          </span>
                          <button
                            type="button"
                            title="Revert to previous value"
                            onClick={() => handleRevert(f.id)}
                            className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
                          >
                            <Undo2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <textarea
                        rows={2}
                        value={entry?.answer || ""}
                        onChange={e => handleFieldChange(f.id, e.target.value)}
                        title={flagged ? tdsFlagReason(entry?.source_detail) : undefined}
                        className={`w-full px-2.5 py-1.5 border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y text-[11px] ${
                          flagged ? "border-danger/40" : "border-border"
                        }`}
                      />
                      <div className="h-3 text-[9px] text-text-muted">
                        {status === "saving" && "Saving…"}
                        {status === "saved" && "Saved ✓"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// PRODUCT KNOWLEDGE (77-field GTM generator)
// ────────────────────────────────────────────────────────────────────────────
const SOURCE_LABELS = GTM_SOURCE_LABELS;

const OWNER_OPTIONS = ["Product Marketing", "Marketing", "Sales", "Legal", "Ops"];

// GTM Schema v3's repeatable-row groups (lib/gtm-field-schema.ts's
// groupFields) — the overall label shown once above row #1, distinct from
// each row's own "{Label} #{n}" question text.
const GTM_GROUP_LABELS: Record<string, string> = {
  features_full_list: "Features (full list)",
  cross_sell: "Cross Sell Products",
  top_6_features: "Top Features in Priority Order",
  feature_icons: "Icons for the Features",
  faq_question: "FAQ Questions",
  faq_answer: "FAQ Answers",
  box_feature: "Box Features (6 Max)",
};

const isFieldComplete = isRealAnswer;

type FieldRow = {
  field_id: string;
  answer: string | null;
  source: string | null;
  source_detail: any;
  flagged: boolean;
  owner?: string | null;
  notes?: string | null;
};
type FieldStatus = "idle" | "saving" | "saved" | "regenerating";

function flagReason(detail: any): string {
  if (!detail) return "Flagged";
  if (detail.reason === "ungrounded") return `Rejected — AI's answer ("${detail.rejectedAnswer}") wasn't found in any source`;
  if (detail.reason === "boilerplate") return `Too similar to another product's answer for this field: "${detail.similarTo}"`;
  if (detail.reason === "possible-competitor-brand-name") return `Mentions a competitor brand ("${detail.brand}") — please verify or rewrite generically`;
  if (detail.reason === "char-limit-truncated") return "The AI's draft exceeded this field's character limit and was truncated to fit — review the cut-off point";
  if (detail.reason === "voice_violation") return "Didn't pass the brand voice check even after one retry — review before using";
  if (detail.conflict) return `Sources disagree: ${detail.conflict.map((c: any) => `${c.source}="${c.answer}"`).join(" vs ")}`;
  return "Flagged for review";
}

// Groups the fill report's per-source counts into the coarser buckets the
// spec calls for ("58 from product data, 9 web, 4 derived, 3 awaiting
// internal input") — a reader doesn't need to know "tds" vs "sales_kit" vs
// "active_report" are all "product data" to get the gist at a glance.
const SOURCE_GROUP_LABELS: Record<string, string> = {
  project_record: "product data",
  sales_kit: "product data",
  tds: "product data",
  active_report: "product data",
  competitive_analysis: "product data",
  multiple: "product data",
  amazon: "product data",
  product_snapshot: "product data",
  official_site: "product data",
  manual_edit: "manual edits",
  web: "web",
  derived: "derived",
  category_default: "category typical",
  gtm_cross_fill: "from GTM",
  uploaded_tds: "uploaded TDS",
  predecessor_product: "predecessor product",
};

function formatFillReport(report: FillReport | null): string | null {
  if (!report) return null;
  const grouped: Record<string, number> = {};
  for (const [source, count] of Object.entries(report.bySource)) {
    const label = SOURCE_GROUP_LABELS[source] || source;
    grouped[label] = (grouped[label] || 0) + count;
  }
  const parts = Object.entries(grouped).map(([label, count]) => `${count} ${label}`);
  if (report.awaitingInternalInput > 0) parts.push(`${report.awaitingInternalInput} awaiting internal input`);
  if (report.notDeterminable > 0) parts.push(`${report.notDeterminable} not determinable`);
  if (report.voiceAdjusted > 0) parts.push(`${report.voiceAdjusted} auto-adjusted for voice`);
  if (report.voiceFlagged > 0) parts.push(`${report.voiceFlagged} flagged for voice review`);
  return parts.length ? parts.join(" · ") : null;
}

function ProductKnowledgeSection({
  projectId,
  pipelineStatus,
  pipelinePhase,
  fillStatus,
  projectSku,
  onSkuChange,
  projectToolType,
  projectGtmTemplateOverride,
  onGtmTemplateOverrideChange,
  toolTypes,
}: {
  projectId: string;
  pipelineStatus?: string;
  pipelinePhase?: string;
  // Automatic Source-Doc Fact Extraction & Cross-Document Fill — flips
  // "running" -> "complete" when the fill chain finishes touching this
  // document; included in the refetch effect below so a tab already open
  // when the chain completes shows the newly-filled fields without
  // requiring a manual navigation-away-and-back remount.
  fillStatus?: string;
  projectSku?: string | null;
  onSkuChange?: (sku: string) => void;
  // GTM Multi-Template work — resolves which family's fields (Blades/Lever/
  // Guards/Charging vs. Curling Iron/Flat Iron/Electrical & Power/Control
  // Settings) actually render in this grid — see lib/gtm-field-schema.ts's
  // resolveGtmFamily.
  projectToolType?: string | null;
  projectGtmTemplateOverride?: string | null;
  onGtmTemplateOverrideChange?: (value: string | null) => void;
  toolTypes?: ToolTypeRow[];
}) {
  const isGlass = useGlassMode();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, FieldRow>>({});
  const [fillReport, setFillReport] = useState<FillReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [fieldStatus, setFieldStatus] = useState<Record<string, FieldStatus>>({});
  const [fillingAll, setFillingAll] = useState(false);
  const [fillProgress, setFillProgress] = useState<{ done: number; total: number } | null>(null);
  const [xlsxDriveUrl, setXlsxDriveUrl] = useState<string | null>(null);
  const [skuDraft, setSkuDraft] = useState(projectSku || "");
  const [skuSaving, setSkuSaving] = useState(false);
  // Uploaded TDS Ingestion — which source-doc version(s) this document was
  // actually generated against, vs. whichever are CURRENTLY active for the
  // project — a mismatch means a source was uploaded/replaced since, so the
  // "out of date sources" banner + re-fill action below can offer to catch
  // this document back up.
  const [sourceDocVersions, setSourceDocVersions] = useState<Record<string, { id: string; version: number }> | null>(null);
  const [activeSourceDocs, setActiveSourceDocs] = useState<{ doc_type: string; id: string; version: number }[]>([]);
  const [refilling, setRefilling] = useState(false);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => { setSkuDraft(projectSku || ""); }, [projectSku]);

  async function saveSku(value: string) {
    setSkuSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save SKU");
      onSkuChange?.(value);
    } catch (err: any) {
      toast.error(err.message || "Failed to save SKU");
    } finally {
      setSkuSaving(false);
    }
  }

  function handleSkuChange(value: string) {
    setSkuDraft(value);
    if (debounceTimers.current["__sku"]) clearTimeout(debounceTimers.current["__sku"]);
    debounceTimers.current["__sku"] = setTimeout(() => saveSku(value), 800);
  }

  // GTM Multi-Template work — "Export using: Auto / Barber / Beauty" pin for
  // mixed-collection products (e.g. a shaver marketed inside a beauty line).
  // A plain select, saved immediately (no debounce — discrete choice, not
  // free text) via the same PATCH /api/projects/[id] route saveSku uses.
  const [overrideSaving, setOverrideSaving] = useState(false);
  async function handleGtmTemplateOverrideChange(value: string) {
    const nextOverride = value === "auto" ? null : value;
    setOverrideSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gtmTemplateOverride: nextOverride }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save export template override");
      onGtmTemplateOverrideChange?.(nextOverride);
      toast.success(nextOverride ? `Export will always use the ${nextOverride === "barber" ? "Barber" : "Beauty"} template` : "Export will auto-select the template from the product's tool type");
    } catch (err: any) {
      toast.error(err.message || "Failed to save export template override");
    } finally {
      setOverrideSaving(false);
    }
  }

  async function loadDocument() {
    setLoading(true);
    try {
      const [docRes, sourceDocsRes] = await Promise.all([
        fetch(`/api/documents/gtm?projectId=${projectId}`),
        fetch(`/api/projects/${projectId}/source-docs`).catch(() => null),
      ]);
      const data = await docRes.json();
      if (data.document) {
        setDocumentId(data.document.id);
        const map: Record<string, FieldRow> = {};
        for (const f of data.fields) map[f.field_id] = f;
        setFields(map);
        setFillReport(data.document.fillReport ?? null);
        setSourceDocVersions(data.document.source_doc_versions ?? null);
        setXlsxDriveUrl(data.document.xlsx_drive_url ?? null);
      }
      if (sourceDocsRes && sourceDocsRes.ok) {
        const sourceDocsData = await sourceDocsRes.json();
        setActiveSourceDocs((sourceDocsData.docs || []).filter((d: any) => d.is_active));
      }
    } catch (e) {}
    setLoading(false);
  }

  useEffect(() => {
    loadDocument();
    // Re-fetch whenever the auto-generation pipeline's status changes (e.g.
    // transitions to "complete") — otherwise a freshly-finished GTM document
    // only ever appeared after a manual page reload, since this fetch used
    // to depend only on projectId. fillStatus is the same idea for the
    // Automatic Source-Doc Fact Extraction & Cross-Document Fill chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pipelineStatus, fillStatus]);

  // A mismatch (or an active doc that wasn't stamped on this document at
  // all) means at least one source has changed since this document was
  // generated — never true before a document exists at all.
  const docsOutOfDate = !!documentId && activeSourceDocs.some(d => {
    const stamped = sourceDocVersions?.[d.doc_type];
    return !stamped || stamped.id !== d.id;
  });

  async function handleRefillFromSources() {
    if (!documentId) return;
    setRefilling(true);
    try {
      const res = await fetch(`/api/documents/gtm/${documentId}/refill-from-sources`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const retriedNote = data.factsRetried > 0 ? ` (retried extraction on ${data.factsRetried} source doc${data.factsRetried === 1 ? "" : "s"})` : "";
      toast.success(data.changed > 0 ? `Updated ${data.changed} field(s) from your sources${retriedNote}` : `No spec fields needed updating — nothing changed${retriedNote}`);
      await loadDocument();
    } catch (err: any) {
      toast.error(err.message || "Failed to re-fill from sources");
    } finally {
      setRefilling(false);
    }
  }

  // Excludes empty legacyOptional fields (e.g. Axis Shield when a product
  // has none) from both the completion count and its denominator, so a
  // product without those parts never shows as permanently incomplete.
  // GTM Multi-Template work — also hides the other family's fields
  // (Blades/Lever/Guards/Charging vs. Curling Iron/Flat Iron/Electrical &
  // Power/Control Settings), same treatment.
  const resolvedFamily = resolveGtmFamily({ toolType: projectToolType, gtmTemplateOverride: projectGtmTemplateOverride }, toolTypes || []);
  const visibleSchema = visibleGtmSchema(GTM_FIELD_SCHEMA, fields, resolvedFamily);
  const completedCount = visibleSchema.reduce((n, f) => n + (isFieldComplete(fields[f.id]?.answer) ? 1 : 0), 0);

  function handleFieldChange(fieldId: string, value: string) {
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], answer: value } }));
    if (debounceTimers.current[fieldId]) clearTimeout(debounceTimers.current[fieldId]);
    debounceTimers.current[fieldId] = setTimeout(() => saveField(fieldId, value), 800);
  }

  async function saveField(fieldId: string, value: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/gtm/${documentId}/fields/${fieldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      setFieldStatus(prev => ({ ...prev, [fieldId]: "saved" }));
      setTimeout(() => setFieldStatus(prev => (prev[fieldId] === "saved" ? { ...prev, [fieldId]: "idle" } : prev)), 1500);
    } catch (e) {
      toast.error("Failed to save field");
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  // Used by the Comparison Chart picker (structured slots) and the
  // Manufacturer quick-pick (clearing the ambiguous flag on confirm) —
  // both need an immediate save with a real sourceDetail, unlike the plain
  // textarea path's debounced saveField.
  async function saveFieldWithDetail(fieldId: string, value: string, sourceDetail: any) {
    if (!documentId) return;
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], answer: value, source_detail: sourceDetail, flagged: false } }));
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/gtm/${documentId}/fields/${fieldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: value, sourceDetail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      setFieldStatus(prev => ({ ...prev, [fieldId]: "saved" }));
      setTimeout(() => setFieldStatus(prev => (prev[fieldId] === "saved" ? { ...prev, [fieldId]: "idle" } : prev)), 1500);
    } catch (e) {
      toast.error("Failed to save field");
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  async function handleRegenerate(fieldId: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "regenerating" }));
    try {
      const res = await fetch(`/api/documents/gtm/${documentId}/fields/${fieldId}/regenerate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Regeneration failed");
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      toast.success("Field regenerated");
    } catch (err: any) {
      toast.error(err.message || "Failed to regenerate field");
    } finally {
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  // GTM style-corpus work, Part C — seeds/overwrites the stored collection
  // kernel (lib/db/collections.ts) from this document's own current
  // Product Name Origin answer, so the next product in the same collection
  // has real text to adapt from (lib/gtm-features-and-tip.ts's
  // applyCollectionKernelAdaptation) instead of generating in a vacuum.
  async function handleSaveAsKernel(fieldId: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "regenerating" }));
    try {
      const res = await fetch(`/api/documents/gtm/${documentId}/fields/${fieldId}/save-as-kernel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save collection kernel");
      toast.success(`Saved as "${data.collection.name}" collection kernel`);
    } catch (err: any) {
      toast.error(err.message || "Failed to save collection kernel");
    } finally {
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  // Tops up whatever's still N/A after the initial 77-field bulk generation.
  // The bulk pass (lib/gtm-generate.ts) has to fit ~77 fields' worth of AI
  // calls inside Vercel's fixed 60s function ceiling, so it chunks fields
  // and gives each chunk a tight timeout — some genuinely-findable answers
  // don't make it back in time and settle as N/A. The single-field
  // regenerate route below has no such competition (45s all to itself, one
  // field), so re-running it per still-empty field is the same OpenAI
  // web-search path but with real room to actually finish the search. A
  // small concurrency cap (not all-at-once) keeps this from firing 70+
  // simultaneous OpenAI requests when a document is mostly unfilled.
  const FILL_REMAINING_CONCURRENCY = 3;

  async function handleFillRemaining() {
    if (!documentId || fillingAll) return;
    const pendingIds = GTM_FIELD_SCHEMA.filter(f => !isFieldComplete(fields[f.id]?.answer)).map(f => f.id);
    if (pendingIds.length === 0) {
      toast.success("Every field is already filled");
      return;
    }

    setFillingAll(true);
    setFillProgress({ done: 0, total: pendingIds.length });
    let filledCount = 0;

    const queue = [...pendingIds];
    const worker = async () => {
      while (queue.length > 0) {
        const fieldId = queue.shift();
        if (!fieldId) return;
        setFieldStatus(prev => ({ ...prev, [fieldId]: "regenerating" }));
        try {
          const res = await fetch(`/api/documents/gtm/${documentId}/fields/${fieldId}/regenerate`, { method: "POST" });
          const data = await res.json();
          if (res.ok) {
            setFields(prev => ({ ...prev, [fieldId]: data.field }));
            if (isFieldComplete(data.field?.answer)) filledCount++;
          }
        } catch {
          // Leave this one as-is — it's still counted in the progress total
          // below, and the user can retry it individually via its own button.
        } finally {
          setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
          setFillProgress(prev => (prev ? { ...prev, done: prev.done + 1 } : prev));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(FILL_REMAINING_CONCURRENCY, pendingIds.length) }, worker));

    setFillingAll(false);
    setFillProgress(null);
    toast.success(
      filledCount > 0
        ? `Filled ${filledCount} of ${pendingIds.length} remaining field${pendingIds.length === 1 ? "" : "s"}`
        : "No additional answers found via web search for the remaining fields"
    );
  }

  async function handleRevert(fieldId: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/gtm/${documentId}/fields/${fieldId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Nothing to revert to");
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      toast.success("Reverted to previous value");
    } catch (err: any) {
      toast.error(err.message || "Failed to revert field");
    } finally {
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  function handleOwnerChange(fieldId: string, owner: string) {
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], owner } }));
    saveMeta(fieldId, { owner });
  }

  function handleNotesChange(fieldId: string, notes: string) {
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], notes } }));
    if (debounceTimers.current[`notes:${fieldId}`]) clearTimeout(debounceTimers.current[`notes:${fieldId}`]);
    debounceTimers.current[`notes:${fieldId}`] = setTimeout(() => saveMeta(fieldId, { notes }), 800);
  }

  async function saveMeta(fieldId: string, meta: { owner?: string; notes?: string }) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/gtm/${documentId}/fields/${fieldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meta),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      setFieldStatus(prev => ({ ...prev, [fieldId]: "saved" }));
      setTimeout(() => setFieldStatus(prev => (prev[fieldId] === "saved" ? { ...prev, [fieldId]: "idle" } : prev)), 1500);
    } catch (e) {
      toast.error("Failed to save");
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  const hasDocument = !!documentId;
  // GTM now generates automatically (see app/api/projects/route.ts +
  // lib/project-generation-engine.ts) — no manual trigger button. This is a
  // read-only reflection of the same project_generation_state the top-level
  // ProjectGenerationProgress banner drives; deliberately not a second
  // independent poller/retry (see that banner for the Retry action).
  // The engine's `phase` column names the step just COMPLETED, not the one
  // in flight. The real window GTM's generateAllFields is in flight is
  // phase:"tds" + status:"running" — phase:"gtm"+"running" is now a real,
  // later state too (deck generation, the next phase, running), but by then
  // hasDocument is already true (GTM's document was saved before that
  // transition), so it never falls into this "not generated yet" branch.
  const isGtmPhaseRunning = pipelinePhase === "tds" && pipelineStatus === "running";
  const isQueued = !hasDocument && !isGtmPhaseRunning && (pipelineStatus === "pending" || pipelineStatus === "running");
  const pipelineFailed = !hasDocument && pipelineStatus === "failed";

  return (
    <div className={`border border-border rounded-xl overflow-hidden ${isGlass ? "cinema-glass" : ""}`}>
      <div className="flex items-center justify-between px-4 py-3 bg-surface-3/30 border-b border-border flex-wrap gap-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Product Knowledge</span>
          {hasDocument && (
            <span className="text-[10px] font-mono text-text-secondary px-1.5 py-0.5 rounded bg-surface-3 border border-border">
              {completedCount}/{visibleSchema.length} fields completed
            </span>
          )}
          {hasDocument && formatFillReport(fillReport) && (
            <span className="text-[9px] text-text-muted" title="Fill breakdown by source tier">
              {formatFillReport(fillReport)}
            </span>
          )}
          {!hasDocument && isGtmPhaseRunning && (
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-accent px-1.5 py-0.5 rounded bg-accent-bg border border-accent-border">
              <Loader2 className="w-3 h-3 animate-spin" /> Generating…
            </span>
          )}
          {!hasDocument && isQueued && (
            <span className="text-[10px] font-bold text-text-muted px-1.5 py-0.5 rounded bg-surface-3 border border-border">Queued</span>
          )}
          {pipelineFailed && (
            <span className="text-[10px] font-bold text-danger px-1.5 py-0.5 rounded bg-danger-bg border border-danger/25">
              Generation failed — see retry above
            </span>
          )}
        </div>
        {hasDocument && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <select
              value={projectGtmTemplateOverride || "auto"}
              onChange={e => handleGtmTemplateOverrideChange(e.target.value)}
              disabled={overrideSaving}
              title="Which workbook template Download XLSX / Save to Drive uses — Auto follows the product's tool type"
              className="px-1.5 py-1 border border-border hover:border-border-strong bg-surface-2 text-text-secondary text-[10px] font-bold rounded-lg transition-colors disabled:opacity-50"
            >
              <option value="auto">Export: Auto</option>
              <option value="barber">Export: Barber</option>
              <option value="beauty">Export: Beauty</option>
            </select>
            {completedCount < visibleSchema.length && (
              <button
                type="button"
                onClick={handleFillRemaining}
                disabled={fillingAll}
                title="Re-run AI web search on every N/A or empty field"
                className="flex items-center gap-1 px-2 py-1 bg-accent hover:bg-accent-hover text-white text-[10px] font-bold rounded-lg transition-colors disabled:opacity-60"
              >
                {fillingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                <span>{fillingAll && fillProgress ? `Filling ${fillProgress.done}/${fillProgress.total}…` : "Fill remaining"}</span>
              </button>
            )}
            <a
              href={`/api/documents/gtm/${documentId}/export-xlsx`}
              title="Official 12-tab GTM workbook — Product Knowledge, BOX ONLY, Product FAQ, Marketing Direction, and Final Copy filled; every other tab untouched"
              className="flex items-center gap-1 px-2 py-1 border border-border hover:border-border-strong text-text-secondary text-[10px] font-bold rounded-lg transition-colors"
            >
              <Download className="w-3 h-3" />
              <span>XLSX</span>
            </a>
            {documentId && <SaveToDriveButton docType="gtm-xlsx" id={documentId} initialDriveUrl={xlsxDriveUrl} compact />}
            {documentId && (
              <button
                type="button"
                onClick={handleRefillFromSources}
                disabled={refilling}
                title="Retries extraction on any uploaded source doc that hasn't successfully produced facts yet, then re-syncs spec fields from all of them — never touches a field you've edited by hand"
                className="flex items-center gap-1 px-2 py-1 border border-border hover:border-border-strong text-text-secondary text-[10px] font-bold rounded-lg transition-colors disabled:opacity-50"
              >
                {refilling ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                <span>Fill from sources</span>
              </button>
            )}
          </div>
        )}
      </div>

      {docsOutOfDate && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-warning-bg border-b border-warning/25 text-[11px]">
          <span className="text-warning font-semibold">Sources have changed since this document was generated — spec fields may be out of date.</span>
          <button
            type="button"
            onClick={handleRefillFromSources}
            disabled={refilling}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-warning-bg hover:bg-warning/20 border border-warning/25 text-warning text-[10px] font-bold rounded-md transition-colors disabled:opacity-50 shrink-0"
          >
            {refilling ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            <span>Re-fill from updated sources</span>
          </button>
        </div>
      )}

      {loading ? (
        <p className="p-4 text-text-muted text-[11px]">Loading…</p>
      ) : !hasDocument ? (
        <p className="p-4 text-text-muted text-[11px]">
          {isGtmPhaseRunning
            ? "Generating the 77-field product knowledge sheet now…"
            : isQueued
            ? "Queued for automatic generation from this project's Sales Kit, TDS, and Active Report."
            : pipelineFailed
            ? "Automatic generation failed — use Retry above to resume."
            : "This project hasn't been queued for Go-To-Market generation yet."}
        </p>
      ) : (
        <div className="divide-y divide-border/60">
          {GTM_SECTIONS.map(section => (
            <div key={section} className="p-4 space-y-3">
              <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{section}</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                {visibleSchema.filter(f => f.section === section).map(f => {
                  const entry = fields[f.id];
                  const complete = isFieldComplete(entry?.answer);
                  const status = fieldStatus[f.id] || "idle";
                  const flagged = !!entry?.flagged;
                  const isInternal = f.kind === "internal";
                  const awaitingInternal = isAwaitingInternalInput(entry?.answer);
                  const notDeterminable = isNotDeterminable(entry?.answer);
                  // Distinguish "never generated yet" (no answer at all — still
                  // needs attention) from "AI/derivation explicitly decided N/A"
                  // (a real, settled answer) — both used to render as an
                  // identical amber "N/A" chip, indistinguishable at a glance
                  // across a 77-row grid. "Awaiting internal input" (a genuine
                  // team decision, see lib/gtm-field-schema.ts's
                  // INTERNAL_FIELD_IDS) and "Not determinable" (every fill tier
                  // verifiably ran and still came up empty) are further split
                  // out from those two — they're both settled/complete-ish
                  // states in isFieldComplete's eyes today would be false, but
                  // they mean very different things to a reader.
                  const isPending = !complete && !awaitingInternal && !notDeterminable && (entry?.answer ?? "").trim() === "";
                  const isSettledNA = !complete && !awaitingInternal && !notDeterminable && !isPending;
                  const chipClass = flagged
                    ? "bg-danger/10 border-danger/30 text-danger"
                    : awaitingInternal
                    ? "bg-warning/10 border-warning/25 text-warning"
                    : notDeterminable
                    ? "bg-surface-3 border-border text-text-muted"
                    : isPending
                    ? "bg-warning/10 border-warning/25 text-warning"
                    : isSettledNA
                    ? "bg-surface-3 border-border text-text-muted"
                    : entry?.source === "web"
                    ? "bg-accent-bg border-accent-border text-accent-text"
                    : "bg-surface-3 border-border text-text-muted";
                  // "{Doc type} (filename, p.X)" per the source-fill feature's
                  // own badge spec — sourceDetail.label already carries this
                  // exact string (lib/gtm-uploaded-tds.ts's buildFactSourceLabel)
                  // for any uploaded_tds field; every other source keeps the
                  // existing short generic label.
                  const chipLabel = awaitingInternal
                    ? "Awaiting Internal Input"
                    : notDeterminable
                    ? "Not Determinable"
                    : entry?.source === "uploaded_tds" && entry?.source_detail?.label
                    ? entry.source_detail.label
                    : SOURCE_LABELS[entry?.source || "none"];
                  const bothNeedsNotes = f.id === "core_consumer" && entry?.answer === "Both" && !entry?.notes?.trim();
                  return (
                    <Fragment key={f.id}>
                    {f.group?.index === 1 && (
                      <div className="md:col-span-2 pt-1">
                        <h5 className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{GTM_GROUP_LABELS[f.group.id] || f.question}</h5>
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <label className="font-semibold text-text-primary text-[11px] flex items-center gap-1">
                          {f.question}
                          {flagged && (
                            <AlertCircle className="w-3 h-3 text-danger shrink-0" aria-label={flagReason(entry?.source_detail)} />
                          )}
                        </label>
                        <div className="flex items-center gap-1 shrink-0">
                          <span
                            className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${chipClass}`}
                            title={entry?.source_detail?.label || (awaitingInternal ? `Set by ${f.owner || "your team"} — edit the field directly` : undefined)}
                          >
                            {chipLabel}
                          </span>
                          {!isInternal && (
                            <button
                              type="button"
                              title="Regenerate this field"
                              onClick={() => handleRegenerate(f.id)}
                              disabled={status === "regenerating"}
                              className="p-0.5 text-text-muted hover:text-accent transition-colors disabled:opacity-50"
                            >
                              <RefreshCw className={`w-3 h-3 ${status === "regenerating" ? "animate-spin" : ""}`} />
                            </button>
                          )}
                          {f.id === "product_name_origin" && complete && (
                            <button
                              type="button"
                              title="Save this text as the collection's shared narrative kernel — future products in the same line will adapt from it"
                              onClick={() => handleSaveAsKernel(f.id)}
                              disabled={status === "regenerating"}
                              className="p-0.5 text-text-muted hover:text-accent transition-colors disabled:opacity-50"
                            >
                              <BookmarkPlus className="w-3 h-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            title="Revert to previous value"
                            onClick={() => handleRevert(f.id)}
                            className="p-0.5 text-text-muted hover:text-text-primary transition-colors"
                          >
                            <Undo2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      {f.helperText && (
                        <p className="text-[9px] text-text-muted -mt-0.5">{f.helperText}</p>
                      )}
                      {f.id === "manufacturer" && entry?.source_detail?.ambiguous ? (
                        <div className="flex items-center gap-2">
                          {["StyleCraft", "Gamma+"].map(brand => (
                            <button
                              key={brand}
                              type="button"
                              onClick={() => saveFieldWithDetail(f.id, brand, { label: `Manually confirmed: ${brand}` })}
                              className="px-2.5 py-1.5 border border-border rounded-lg text-[11px] font-semibold text-text-secondary hover:border-accent hover:text-accent"
                            >
                              {brand}
                            </button>
                          ))}
                        </div>
                      ) : f.uiControl === "sku_picker" ? (
                        <ComparisonChartPicker
                          slots={(entry?.source_detail?.slots as (ComparisonChartSlot | null)[] | undefined) || [null, null]}
                          onSave={(answer, slots) => saveFieldWithDetail(f.id, answer, { slots })}
                        />
                      ) : f.uiControl === "select" && f.options ? (
                        <select
                          value={entry?.answer || ""}
                          onChange={e => handleFieldChange(f.id, e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-[11px]"
                        >
                          <option value="">Select…</option>
                          {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <textarea
                          rows={2}
                          value={entry?.answer || ""}
                          onChange={e => handleFieldChange(f.id, e.target.value)}
                          title={flagged ? flagReason(entry?.source_detail) : undefined}
                          className={`font-body-doc w-full px-2.5 py-1.5 border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y text-[11px] ${
                            flagged ? "border-danger/40" : "border-border"
                          }`}
                        />
                      )}
                      {f.id === "product_title" && (
                        <input
                          type="text"
                          value={skuDraft}
                          onChange={e => handleSkuChange(e.target.value)}
                          placeholder="SKU (renders as Product Title — SKU)"
                          className="w-full px-2.5 py-1 border border-border rounded-lg bg-surface-1 text-text-secondary placeholder-text-muted outline-none focus:border-accent text-[10px]"
                        />
                      )}
                      <div className="flex items-center gap-2">
                        <select
                          value={entry?.owner || f.owner || "Product Marketing"}
                          onChange={e => handleOwnerChange(f.id, e.target.value)}
                          title="Owner"
                          className="px-1.5 py-1 border border-border rounded-md bg-surface-1 text-text-secondary text-[9px] outline-none focus:border-accent"
                        >
                          {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <input
                          type="text"
                          value={entry?.notes || ""}
                          onChange={e => handleNotesChange(f.id, e.target.value)}
                          placeholder={bothNeedsNotes ? "Required: why Both, and how to balance the two audiences" : "Notes…"}
                          className={`flex-1 px-1.5 py-1 border rounded-md bg-surface-1 text-text-secondary placeholder-text-muted text-[9px] outline-none focus:border-accent ${
                            bothNeedsNotes ? "border-warning/50" : "border-border"
                          }`}
                        />
                      </div>
                      <div className="h-3 text-[9px] text-text-muted">
                        {status === "saving" && "Saving…"}
                        {status === "saved" && "Saved ✓"}
                        {status === "regenerating" && "Regenerating…"}
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CONTENT FORM SECTION — field-granular Product Detail Page content sheet
// (doc_type="content_form"), same autosave/history/badge model as GTM's own
// ProductKnowledgeSection above (deliberately NOT a report-driven
// Edit/Save-toggle tab like the old ContentFormTab it replaces — this is a
// self-contained data-fetch/save component, mounted directly for the
// "content-form" tab the same way SourceDocsTab bypasses ReportTabContent
// entirely, since it no longer depends on a linked report).
// ────────────────────────────────────────────────────────────────────────────
const CONTENT_FORM_GROUP_LABELS: Record<string, string> = {
  bullet_top3: "Bullet Points Top 3",
  bullet_long: "Bullet Points Long Form",
  bullet_condensed: "Bullet Points Condensed",
  website_copy_short: "Website Copy Block — Short Version (Top 3)",
  website_copy_long: "Website Copy Block — Long Version (Hot Spot)",
};

function CharLimitTextarea({
  value, limit, onChange, flagged, className,
}: { value: string; limit: number; onChange: (v: string) => void; flagged?: boolean; className?: string }) {
  const overLimit = value.length > limit;
  return (
    <div className="space-y-0.5">
      <textarea
        rows={2}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`${className || ""} w-full px-2.5 py-1.5 border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y text-[11px] ${
          overLimit || flagged ? "border-danger/40" : "border-border"
        }`}
      />
      <div className={`text-[9px] font-mono ${overLimit ? "text-danger font-bold" : "text-text-muted"}`}>
        {value.length}/{limit} characters{overLimit ? " — exceeds limit, will not save" : ""}
      </div>
    </div>
  );
}

function ContentFormSection({
  projectId, pipelineStatus, pipelinePhase, pipelineErrorMessage, fillStatus,
}: { projectId: string; pipelineStatus?: string; pipelinePhase?: string; pipelineErrorMessage?: string | null; fillStatus?: string }) {
  const isGlass = useGlassMode();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, FieldRow>>({});
  const [fillReport, setFillReport] = useState<FillReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [fieldStatus, setFieldStatus] = useState<Record<string, FieldStatus>>({});
  const [fillingAll, setFillingAll] = useState(false);
  const [fillProgress, setFillProgress] = useState<{ done: number; total: number } | null>(null);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function loadDocument() {
    setLoading(true);
    try {
      const res = await fetch(`/api/documents/content-form?projectId=${projectId}`);
      const data = await res.json();
      if (data.document) {
        setDocumentId(data.document.id);
        const map: Record<string, FieldRow> = {};
        for (const f of data.fields) map[f.field_id] = f;
        setFields(map);
        setFillReport(data.document.fillReport ?? null);
      }
    } catch (e) {}
    setLoading(false);
  }

  useEffect(() => {
    loadDocument();
    // Re-fetch when the auto-generation pipeline's status changes, same
    // reasoning as ProductKnowledgeSection's own effect. fillStatus is the
    // same idea for the Automatic Source-Doc Fact Extraction & Cross-
    // Document Fill chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pipelineStatus, fillStatus]);

  const completedCount = CONTENT_FORM_SCHEMA.reduce((n, f) => n + (isFieldComplete(fields[f.id]?.answer) ? 1 : 0), 0);

  function handleFieldChange(fieldId: string, value: string) {
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], answer: value } }));
    if (debounceTimers.current[fieldId]) clearTimeout(debounceTimers.current[fieldId]);
    debounceTimers.current[fieldId] = setTimeout(() => saveField(fieldId, value), 800);
  }

  async function saveField(fieldId: string, value: string) {
    if (!documentId) return;
    const schemaField = CONTENT_FORM_SCHEMA.find(f => f.id === fieldId);
    if (schemaField?.charLimit && value.length > schemaField.charLimit) {
      // Never persists an over-limit answer — the char counter already
      // warns the user; this is the save-time guard, matching the
      // server-side check in the PATCH route itself (defense in depth).
      return;
    }
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/content-form/${documentId}/fields/${fieldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      setFieldStatus(prev => ({ ...prev, [fieldId]: "saved" }));
      setTimeout(() => setFieldStatus(prev => (prev[fieldId] === "saved" ? { ...prev, [fieldId]: "idle" } : prev)), 1500);
    } catch (e: any) {
      toast.error(e.message || "Failed to save field");
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  async function handleRegenerate(fieldId: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "regenerating" }));
    try {
      const res = await fetch(`/api/documents/content-form/${documentId}/fields/${fieldId}/regenerate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Regeneration failed");
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      toast.success("Field regenerated");
    } catch (err: any) {
      toast.error(err.message || "Failed to regenerate field");
    } finally {
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  // Content Form's generator only ever runs at full-document granularity
  // (every field is written together from the same shared prompt, unlike
  // GTM's per-field grounded specs) — regenerateContentFormField (the old
  // per-field /regenerate route this used to loop over) re-ran the ENTIRE
  // 33-field generation and threw away every field's answer except the one
  // requested. Looping that once per blank field meant N blank fields cost
  // N full-document OpenAI generations instead of 1 — confirmed as the
  // single largest avoidable AI-credit waste in the app. refill-from-sources
  // already does this correctly (one generateContentForm call, writes only
  // the fields that were actually blank), so reuse it here instead of
  // reinventing a batched version of the same thing.
  async function handleFillRemaining() {
    if (!documentId || fillingAll) return;
    const pendingIds = CONTENT_FORM_SCHEMA.filter(f => !isFieldComplete(fields[f.id]?.answer)).map(f => f.id);
    if (pendingIds.length === 0) {
      toast.success("Every field is already filled");
      return;
    }
    // No setFillProgress here (unlike GTM's version of this handler) — this
    // is now a single request, not a per-field loop, so there's no real
    // "done/total" to report partway through; a fillProgress value that
    // never advances from 0 would just read as a stuck progress bar for
    // however long the request takes. The button falls back to a plain
    // "Filling…" label instead (see its own render below).
    setFillingAll(true);
    try {
      const res = await fetch(`/api/documents/content-form/${documentId}/refill-from-sources`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fill remaining fields");
      await loadDocument();
      const filledCount = data.regenerated || 0;
      toast.success(filledCount > 0 ? `Filled ${filledCount} of ${pendingIds.length} remaining field${pendingIds.length === 1 ? "" : "s"}` : "No additional content generated for the remaining fields");
    } catch (err: any) {
      toast.error(err.message || "Failed to fill remaining fields");
    } finally {
      setFillingAll(false);
    }
  }

  async function handleRevert(fieldId: string) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/content-form/${documentId}/fields/${fieldId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Nothing to revert to");
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      toast.success("Reverted to previous value");
    } catch (err: any) {
      toast.error(err.message || "Failed to revert field");
    } finally {
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  function handleOwnerChange(fieldId: string, owner: string) {
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], owner } }));
    saveMeta(fieldId, { owner });
  }

  function handleNotesChange(fieldId: string, notes: string) {
    setFields(prev => ({ ...prev, [fieldId]: { ...prev[fieldId], notes } }));
    if (debounceTimers.current[`notes:${fieldId}`]) clearTimeout(debounceTimers.current[`notes:${fieldId}`]);
    debounceTimers.current[`notes:${fieldId}`] = setTimeout(() => saveMeta(fieldId, { notes }), 800);
  }

  async function saveMeta(fieldId: string, meta: { owner?: string; notes?: string }) {
    if (!documentId) return;
    setFieldStatus(prev => ({ ...prev, [fieldId]: "saving" }));
    try {
      const res = await fetch(`/api/documents/content-form/${documentId}/fields/${fieldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meta),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFields(prev => ({ ...prev, [fieldId]: data.field }));
      setFieldStatus(prev => ({ ...prev, [fieldId]: "saved" }));
      setTimeout(() => setFieldStatus(prev => (prev[fieldId] === "saved" ? { ...prev, [fieldId]: "idle" } : prev)), 1500);
    } catch (e) {
      toast.error("Failed to save");
      setFieldStatus(prev => ({ ...prev, [fieldId]: "idle" }));
    }
  }

  const hasDocument = !!documentId;
  const isContentFormPhaseRunning = pipelinePhase === "content_form" && pipelineStatus === "running";
  const isQueued = !hasDocument && !isContentFormPhaseRunning && (pipelineStatus === "pending" || pipelineStatus === "running");
  const pipelineFailed = !hasDocument && pipelineStatus === "failed";
  // A document row exists (created up-front, see lib/project-generation-
  // engine.ts's content_form phase) but generation itself threw before any
  // fields got saved — distinct from "never queued at all." Gated on the
  // engine's own message prefix so an unrelated phase's error never
  // misattributes here.
  const contentFormGenerationErrored =
    completedCount === 0 && !!pipelineErrorMessage && pipelineErrorMessage.startsWith("Content Form generation had an error");

  function renderField(f: (typeof CONTENT_FORM_SCHEMA)[number]) {
    const entry = fields[f.id];
    const complete = isFieldComplete(entry?.answer);
    const status = fieldStatus[f.id] || "idle";
    const flagged = !!entry?.flagged;
    const chipClass = flagged
      ? "bg-danger/10 border-danger/30 text-danger"
      : complete
      ? "bg-surface-3 border-border text-text-muted"
      : "bg-warning/10 border-warning/25 text-warning";
    const chipLabel = complete ? (SOURCE_LABELS[entry?.source || "none"] || "Filled") : "Pending";
    return (
      <Fragment key={f.id}>
        {f.group?.index === 1 && (
          <div className="md:col-span-2 pt-1">
            <h5 className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{CONTENT_FORM_GROUP_LABELS[f.group.id] || f.question}</h5>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <label className="font-semibold text-text-primary text-[11px] flex items-center gap-1">
              {f.group ? `#${f.group.index}` : f.question}
              {flagged && <AlertCircle className="w-3 h-3 text-danger shrink-0" aria-label={flagReason(entry?.source_detail)} />}
            </label>
            <div className="flex items-center gap-1 shrink-0">
              <span className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${chipClass}`}>{chipLabel}</span>
              <button
                type="button"
                title="Regenerate this field"
                onClick={() => handleRegenerate(f.id)}
                disabled={status === "regenerating"}
                className="p-0.5 text-text-muted hover:text-accent transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${status === "regenerating" ? "animate-spin" : ""}`} />
              </button>
              <button type="button" title="Revert to previous value" onClick={() => handleRevert(f.id)} className="p-0.5 text-text-muted hover:text-text-primary transition-colors">
                <Undo2 className="w-3 h-3" />
              </button>
            </div>
          </div>
          {f.charLimit ? (
            <CharLimitTextarea value={entry?.answer || ""} limit={f.charLimit} onChange={v => handleFieldChange(f.id, v)} flagged={flagged} className="font-body-doc" />
          ) : (
            <textarea
              rows={2}
              value={entry?.answer || ""}
              onChange={e => handleFieldChange(f.id, e.target.value)}
              title={flagged ? flagReason(entry?.source_detail) : undefined}
              className={`font-body-doc w-full px-2.5 py-1.5 border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y text-[11px] ${flagged ? "border-danger/40" : "border-border"}`}
            />
          )}
          <div className="flex items-center gap-2">
            <select
              value={entry?.owner || f.owner || "Product Marketing"}
              onChange={e => handleOwnerChange(f.id, e.target.value)}
              title="Owner"
              className="px-1.5 py-1 border border-border rounded-md bg-surface-1 text-text-secondary text-[9px] outline-none focus:border-accent"
            >
              {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
            <input
              type="text"
              value={entry?.notes || ""}
              onChange={e => handleNotesChange(f.id, e.target.value)}
              placeholder="Notes…"
              className="flex-1 px-1.5 py-1 border border-border rounded-md bg-surface-1 text-text-secondary placeholder-text-muted text-[9px] outline-none focus:border-accent"
            />
          </div>
          <div className="h-3 text-[9px] text-text-muted">
            {status === "saving" && "Saving…"}
            {status === "saved" && "Saved ✓"}
            {status === "regenerating" && "Regenerating…"}
          </div>
        </div>
      </Fragment>
    );
  }

  return (
    <div className={`border border-border rounded-xl overflow-hidden ${isGlass ? "cinema-glass" : ""}`}>
      <div className="flex items-center justify-between px-4 py-3 bg-surface-3/30 border-b border-border flex-wrap gap-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Content Form</span>
          {hasDocument && (
            <span className="text-[10px] font-mono text-text-secondary px-1.5 py-0.5 rounded bg-surface-3 border border-border">
              {completedCount}/{CONTENT_FORM_SCHEMA.length} fields completed
            </span>
          )}
          {hasDocument && formatFillReport(fillReport) && (
            <span className="text-[9px] text-text-muted" title="Fill breakdown by source tier">{formatFillReport(fillReport)}</span>
          )}
          {!hasDocument && isContentFormPhaseRunning && (
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-accent px-1.5 py-0.5 rounded bg-accent-bg border border-accent-border">
              <Loader2 className="w-3 h-3 animate-spin" /> Generating…
            </span>
          )}
          {!hasDocument && isQueued && <span className="text-[10px] font-bold text-text-muted px-1.5 py-0.5 rounded bg-surface-3 border border-border">Queued</span>}
          {pipelineFailed && (
            <span className="text-[10px] font-bold text-danger px-1.5 py-0.5 rounded bg-danger-bg border border-danger/25">Generation failed — see retry above</span>
          )}
        </div>
        {hasDocument && completedCount < CONTENT_FORM_SCHEMA.length && (
          <button
            type="button"
            onClick={handleFillRemaining}
            disabled={fillingAll}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg transition-colors disabled:opacity-60"
          >
            {fillingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>{fillingAll ? "Filling…" : "Fill remaining fields"}</span>
          </button>
        )}
      </div>

      {loading ? (
        <p className="p-4 text-text-muted text-[11px]">Loading…</p>
      ) : !hasDocument ? (
        <p className="p-4 text-text-muted text-[11px]">
          {isContentFormPhaseRunning
            ? "Generating Product Detail Page content now…"
            : isQueued
            ? "Queued for automatic generation once Product Knowledge completes."
            : pipelineFailed
            ? "Automatic generation failed — use Retry above to resume."
            : "This project's Content Form hasn't been generated yet — it runs automatically right after Go-To-Market, or can be backfilled for existing projects (see scripts/backfill-content-form-phase.ts)."}
        </p>
      ) : (
        <div className="divide-y divide-border/60">
          {contentFormGenerationErrored && (
            <div className="p-4 flex items-center justify-between gap-3 bg-danger-bg border-b border-danger/20">
              <p className="text-[11px] text-danger">{pipelineErrorMessage}</p>
            </div>
          )}
          {CONTENT_FORM_SECTIONS.map(section => {
            const sectionFields = CONTENT_FORM_SCHEMA.filter(f => f.section === section);
            // Website Copy Block is special-cased as a 3x2 grid (3 short-copy
            // cells + 3 long-copy cells side-by-side) rather than the generic
            // vertical group list, matching the real template's own layout.
            const isWebsiteCopyBlock = section === "Website Copy Block";
            return (
              <div key={section} className="p-4 space-y-3">
                <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{section}</h4>
                {isWebsiteCopyBlock ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {[1, 2, 3].map(col => (
                      <div key={col} className="space-y-3 p-2 border border-border/40 rounded-lg">
                        {(["website_copy_short", "website_copy_long"] as const).map(prefix => {
                          const f = sectionFields.find(x => x.id === `${prefix}_${col}`);
                          if (!f) return null;
                          const entry = fields[f.id];
                          const status = fieldStatus[f.id] || "idle";
                          return (
                            <div key={f.id} className="space-y-1">
                              <label className="font-semibold text-text-primary text-[10px]">{CONTENT_FORM_GROUP_LABELS[prefix]} — Cell {col}</label>
                              <textarea
                                rows={2}
                                value={entry?.answer || ""}
                                onChange={e => handleFieldChange(f.id, e.target.value)}
                                className="w-full px-2 py-1 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y text-[10px]"
                              />
                              <div className="h-2.5 text-[8px] text-text-muted">{status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : ""}</div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                    {sectionFields.map(f => renderField(f))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// LinkReportModal subcomponent deleted in favor of shared import

// ────────────────────────────────────────────────────────────────────────────
// PROJECT OUTPUTS BAR COMPONENT (Sales Kit, TDS, Drive)
// ────────────────────────────────────────────────────────────────────────────
function ProjectOutputsBar({ project, report, tdsEnabled }: { project: any; report: any; tdsEnabled: boolean }) {
  const [generating, setGenerating] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);
  const [generatedHtml, setGeneratedHtml] = useState<Record<string, string>>({});
  const [driveUrls, setDriveUrls] = useState<Record<string, string | null>>({});
  const [hasGtm, setHasGtm] = useState(false);
  const [hasTds, setHasTds] = useState(false);

  // Preload any previously generated outputs so View/Drive state works without regenerating
  useEffect(() => {
    (["sales-kit"] as const).forEach(async (type) => {
      try {
        const res = await fetch(`/api/projects/${project.id}/${type}`);
        const data = await res.json();
        if (data.html) setGeneratedHtml(prev => ({ ...prev, [type]: data.html }));
        setDriveUrls(prev => ({ ...prev, [type]: data.driveUrl ?? null }));
      } catch (e) {}
    });
    (async () => {
      try {
        const res = await fetch(`/api/documents/gtm?projectId=${project.id}`);
        const data = await res.json();
        setHasGtm(!!data.document && (data.fields || []).some((f: any) => isRealAnswer(f.answer)));
        setDriveUrls(prev => ({ ...prev, gtm: data.document?.drive_url ?? null }));
      } catch (e) {}
    })();
    (async () => {
      try {
        const res = await fetch(`/api/documents/tds?projectId=${project.id}`);
        const data = await res.json();
        setHasTds(!!data.document && (data.fields || []).some((f: any) => isRealAnswer(f.answer)));
        setDriveUrls(prev => ({ ...prev, tds: data.document?.drive_url ?? null }));
      } catch (e) {}
    })();
  }, [project.id]);

  useEffect(() => {
    setDriveUrls(prev => ({ ...prev, "active-report": report?.drive_url ?? null }));
  }, [report?.id]);

  async function downloadPdf(docType: "sales-kit" | "tds" | "gtm" | "active-report", id: string) {
    setDownloadingPdf(docType);
    try {
      const res = await fetch(`/api/documents/${docType}/${id}/export-pdf`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "PDF export failed");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="(.+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] || `${docType}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking on the very next tick (not synchronously) — some browsers
      // haven't finished handing the blob off to their download manager by
      // the time a.click() returns, and revoking immediately can silently
      // kill the download before it starts. A short delay costs nothing
      // (the object URL is only ever referenced by this one anchor) and
      // matches the pattern lib/export-pdf.ts's print-window flow already
      // uses (a setTimeout before its own revokeObjectURL).
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      toast.error(err.message || "Failed to download PDF");
    } finally {
      setDownloadingPdf(null);
    }
  }

  function writeHtmlToTab(win: Window, html: string) {
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  function openHtmlInNewTab(html: string) {
    const win = window.open("", "_blank");
    if (win) writeHtmlToTab(win, html);
  }

  async function generateOutput(type: "sales-kit") {
    // Open the tab synchronously, inside the click's user-activation window —
    // generation can take 10s+, and window.open() after that await is long
    // past Chrome's user-gesture grace period and gets silently popup-blocked.
    const win = window.open("", "_blank");
    setGenerating(type);
    try {
      const res = await fetch(`/api/projects/${project.id}/${type}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");

      toast.success("Sales Kit generated!");
      if (data.html) {
        setGeneratedHtml(prev => ({ ...prev, [type]: data.html }));
        if (win) {
          writeHtmlToTab(win, data.html);
          win.onload = () => setTimeout(() => win.print(), 400);
        }
      } else if (win) {
        win.close();
      }
    } catch (err: any) {
      toast.error(err.message || `Failed to generate ${type}`);
      if (win) win.close();
    } finally {
      setGenerating(null);
    }
  }

  async function viewOutput(type: "sales-kit") {
    if (generatedHtml[type]) {
      openHtmlInNewTab(generatedHtml[type]);
      return;
    }

    const win = window.open("", "_blank");
    setViewing(type);
    try {
      const res = await fetch(`/api/projects/${project.id}/${type}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");

      if (data.html) {
        setGeneratedHtml(prev => ({ ...prev, [type]: data.html }));
        if (win) writeHtmlToTab(win, data.html);
      } else {
        toast.error("No Sales Kit available to view");
        if (win) win.close();
      }
    } catch (err: any) {
      toast.error(err.message || `Failed to load ${type}`);
      if (win) win.close();
    } finally {
      setViewing(null);
    }
  }

  return (
    <div className="p-4 bg-surface-2 border border-border rounded-xl space-y-3 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-accent" />
          <span>Exportable Project Outputs & Document Center</span>
        </h3>
        <span className="text-[10px] text-text-muted font-mono">Automated PDF & HTML Documents</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Sales Kit Card */}
        <div className="p-3 bg-surface-1 border border-border rounded-lg flex flex-col gap-2">
          <div className="space-y-0.5">
            <h4 className="font-bold text-text-primary text-xs flex items-center gap-1.5">
              <span>💼 Sales Kit</span>
            </h4>
            <p className="text-[10px] text-text-muted">Elevator pitch, features, competitive advantage table & objection handlers</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => viewOutput("sales-kit")}
              disabled={viewing === "sales-kit"}
              className="flex items-center gap-1 px-3 py-1.5 border border-border hover:border-border-strong text-text-secondary text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>{viewing === "sales-kit" ? "Loading…" : "View"}</span>
            </button>
            <button
              type="button"
              onClick={() => generateOutput("sales-kit")}
              disabled={generating === "sales-kit"}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg transition-all disabled:opacity-50 shadow-sm"
            >
              {generating === "sales-kit" ? "Generating…" : "Regenerate"}
            </button>
            <button
              type="button"
              onClick={() => downloadPdf("sales-kit", project.id)}
              disabled={downloadingPdf === "sales-kit"}
              title="Click Regenerate first if you haven't generated a Sales Kit for this project yet"
              className="flex items-center gap-1 px-3 py-1.5 border border-border hover:border-border-strong text-text-secondary text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{downloadingPdf === "sales-kit" ? "Rendering…" : "Download PDF"}</span>
            </button>
            <SaveToDriveButton docType="sales-kit" id={project.id} initialDriveUrl={driveUrls["sales-kit"]} />
          </div>
        </div>

        {/* Technical Data Sheet Card — a live snapshot, not a regeneratable
            document; the editable field grid lives in TdsKnowledgeSection
            below. No View/Regenerate here, same pattern as the GTM card. */}
        {tdsEnabled && (
          <div className="p-3 bg-surface-1 border border-border rounded-lg flex flex-col gap-2">
            <div className="space-y-0.5">
              <h4 className="font-bold text-text-primary text-xs flex items-center gap-1.5">
                <span>📄 Technical Data Sheet (TDS)</span>
              </h4>
              <p className="text-[10px] text-text-muted">Live snapshot of real specs — capture it below, no AI regeneration</p>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => downloadPdf("tds", project.id)}
                disabled={!hasTds || downloadingPdf === "tds"}
                title={hasTds ? undefined : "No TDS snapshot has been captured for this project yet — capture one below first"}
                className="flex items-center gap-1 px-3 py-1.5 border border-border hover:border-border-strong text-text-secondary text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{downloadingPdf === "tds" ? "Rendering…" : "Download PDF"}</span>
              </button>
              {hasTds ? (
                <SaveToDriveButton docType="tds" id={project.id} initialDriveUrl={driveUrls["tds"]} />
              ) : (
                <span className="text-[10px] text-text-muted italic">No snapshot captured yet</span>
              )}
            </div>
          </div>
        )}

        {/* Active Report Card */}
        <div className="p-3 bg-surface-1 border border-border rounded-lg flex flex-col gap-2">
          <div className="space-y-0.5">
            <h4 className="font-bold text-text-primary text-xs flex items-center gap-1.5">
              <span>📊 Active Report</span>
            </h4>
            <p className="text-[10px] text-text-muted">Full competitive analysis, pricing, GTM & content brief</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => downloadPdf("active-report", report.id)}
              disabled={!report?.id || downloadingPdf === "active-report"}
              title={report?.id ? undefined : "No competitive analysis report is linked to this project yet"}
              className="flex items-center gap-1 px-3 py-1.5 border border-border hover:border-border-strong text-text-secondary text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{downloadingPdf === "active-report" ? "Rendering…" : "Download PDF"}</span>
            </button>
            {report?.id ? (
              <SaveToDriveButton docType="active-report" id={report.id} initialDriveUrl={driveUrls["active-report"]} />
            ) : (
              <span className="text-[10px] text-text-muted italic">No report linked yet</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

