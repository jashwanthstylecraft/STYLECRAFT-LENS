"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import {
  Save,
  Download,
  ArrowLeft,
  Edit2,
  X,
  Loader2,
  Star,
  ExternalLink,
  Plus,
  Trash2,
  AlertTriangle
} from "lucide-react";
import { CompetitorCard, EmptySlotCard } from "@/components/analyze/CompetitorCard";
import { downloadReportPDF } from "@/lib/export-pdf";
import type { ToolTypeRow } from "@/lib/db/tool-types";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { isPricingAnalysisEmpty } from "@/lib/pricing-analysis";
import { SectionSourceLine, SourceUnavailableCaption } from "@/components/analyze/SectionSourceLine";
import { assertProvenance } from "@/lib/provenance-format";
import { MagicBentoSection, MagicBentoCard } from "@/components/ui/MagicBento";

type Tab = "competitive-analysis" | "pricing" | "go-to-market" | "content-form";

const TABS: { key: Tab; label: string }[] = [
  { key: "competitive-analysis", label: "Competitive Analysis" },
  { key: "pricing",              label: "Pricing" },
  { key: "go-to-market",         label: "Go To Market" },
  { key: "content-form",         label: "Content Form" },
];

export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<Tab>("competitive-analysis");
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pricingSourceOpen, setPricingSourceOpen] = useState(false);

  // Fetched once and threaded into every CompetitorCard — lib/feature-
  // flags.ts's isBuyerSentimentEnabled()/isNewsUpdatesEnabled(). Default
  // true (fail-open) until the fetch resolves.
  const [buyerSentimentEnabled, setBuyerSentimentEnabled] = useState(true);
  const [newsUpdatesEnabled, setNewsUpdatesEnabled] = useState(true);
  useEffect(() => {
    fetch("/api/features")
      .then(res => res.json())
      .then(data => {
        if (typeof data.buyer_sentiment_enabled === "boolean") setBuyerSentimentEnabled(data.buyer_sentiment_enabled);
        if (typeof data.news_updates_enabled === "boolean") setNewsUpdatesEnabled(data.news_updates_enabled);
      })
      .catch(() => {});
  }, []);

  // Fetched once here and threaded into downloadReportPDF (lib/export-pdf.ts)
  // — that module renders client-side, with no other existing tool-types
  // fetch to reuse.
  const [toolTypes, setToolTypes] = useState<ToolTypeRow[]>([]);
  useEffect(() => {
    fetch("/api/tool-types")
      .then(res => res.json())
      .then(data => { if (Array.isArray(data.toolTypes)) setToolTypes(data.toolTypes); })
      .catch(() => {});
  }, []);

  const fetchReport = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/reports/${id}`);
      if (!res.ok) {
        if (res.status === 404) {
          toast.error("Report not found");
          router.push("/dashboard/reports");
          return;
        }
        throw new Error();
      }
      const data = await res.json();
      setReport(data.report);
    } catch (e) {
      toast.error("Failed to load report");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && id) fetchReport();
  }, [user, id]);

  const dataKey: Record<Tab, string> = {
    "competitive-analysis": "competitive_analysis",
    "pricing":              "pricing_analysis",
    "go-to-market":         "go_to_market",
    "content-form":         "content_form",
  };

  const startEdit = () => {
    setEditData(JSON.parse(JSON.stringify(report[dataKey[activeTab]] ?? {})));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditData(null);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/reports/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [dataKey[activeTab]]: editData,
        })
      });

      if (!res.ok) throw new Error();
      const updated = await res.json();
      setReport(updated.report);
      setEditing(false);
      setEditData(null);
      toast.success("Section updated successfully");
    } catch (e) {
      toast.error("Failed to save report updates");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteReport = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/reports/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Report deleted");
      router.push("/dashboard/reports");
    } catch (e) {
      toast.error("Failed to delete report");
      setDeleting(false);
    }
  };

  const handleExportPDF = async () => {
    setExporting(true);
    toast.loading("Compiling print layouts…", { id: "pdf-export" });
    try {
      // Filter out "news"-tagged provenance rows from the export only —
      // never mutates the displayed `report` state — when News Updates is
      // disabled. Old saved reports may carry these rows from before the
      // flag existed; hiding them at export time (not deleting them) means
      // flipping the flag back on restores the appendix with no re-save.
      // Also drop any empty_slot placeholder (lib/analysisEngine.ts's fill
      // loop) — never a real competitor, never belongs in an export.
      const dropNews = !newsUpdatesEnabled;
      const exportReport = {
        ...report,
        competitive_analysis: {
          ...report.competitive_analysis,
          large_brand_competitors: (report.competitive_analysis?.large_brand_competitors || []).filter((c: any) => !c.empty_slot),
          indie_emerging_competitors: (report.competitive_analysis?.indie_emerging_competitors || []).filter((c: any) => !c.empty_slot),
          section_provenance: dropNews
            ? (report.competitive_analysis?.section_provenance || []).filter((r: any) => r.section !== "news")
            : report.competitive_analysis?.section_provenance,
        },
      };
      await downloadReportPDF(exportReport, toolTypes);
      
      // Update status to EXPORTED
      const res = await fetch(`/api/reports/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "EXPORTED" })
      });
      if (res.ok) {
        const data = await res.json();
        setReport(data.report);
      }
      
      toast.dismiss("pdf-export");
      toast.success("PDF print dialog opened");
    } catch (err) {
      toast.dismiss("pdf-export");
      toast.error("Failed to download PDF");
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-24 text-xs">
        <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
        <p className="text-text-muted font-medium">Opening report workspace...</p>
      </div>
    );
  }

  if (!report) return <div>Report not found</div>;

  const ca = report.competitive_analysis || {};
  const pa = report.pricing_analysis || {};
  const gtm = report.go_to_market || {};
  const cf = report.content_form || {};
  const pricingEmpty = isPricingAnalysisEmpty(pa);

  return (
    <div className="space-y-6 text-xs font-sans">
      
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/dashboard/reports")} className="p-1.5 rounded-lg hover:bg-surface-3 text-text-secondary transition-colors cinema-text">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="cinema-text">
            <h1 className="text-display leading-tight">{report.title}</h1>
            <p className="text-[10px] text-text-muted mt-0.5 leading-none">
              Status: <span className="font-semibold text-text-secondary">{report.status}</span>
              {report.projects?.name && (
                <> · Project: <span className="font-semibold text-text-secondary">{report.projects.name}</span></>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
          <button 
            onClick={handleExportPDF} 
            disabled={exporting}
            className="flex items-center gap-1.5 px-4 py-2 border border-border bg-surface-3/45 hover:bg-surface-3 text-text-primary text-xs font-bold rounded-lg transition-colors shadow-sm disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download PDF</span>
          </button>

          {editing ? (
            <>
              <button 
                onClick={cancelEdit} 
                className="flex items-center gap-1 px-3 py-2 border border-border bg-surface-2 hover:bg-surface-3 text-text-primary text-xs font-bold rounded-lg transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>Cancel</span>
              </button>
              <button 
                onClick={saveEdit} 
                disabled={saving}
                className="flex items-center gap-1 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-bold rounded-lg transition-colors shadow shadow-accent/25"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>Save</span>
              </button>
            </>
          ) : (
            <button 
              onClick={startEdit} 
              className="flex items-center gap-1 px-4 py-2 bg-surface-3 hover:border-border-strong text-text-primary border border-border text-xs font-bold rounded-lg transition-colors"
            >
              <Edit2 className="w-3.5 h-3.5 text-text-muted" />
              <span>Edit</span>
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => { setActiveTab(t.key); setEditing(false); }}
            className={`px-4 py-2 border-b-2 font-bold text-xs transition-colors ${
              activeTab === t.key 
                ? "border-accent text-accent" 
                : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Workspace Panel */}
      <div className="bg-surface-2 border border-border rounded-xl p-6 md:p-8 space-y-6 shadow-sm">
        
        {activeTab === "competitive-analysis" && (
          <div className="space-y-6">
            <h2 className="text-sm font-bold text-text-primary">Market Analysis</h2>

            <MagicBentoSection className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Market Snapshot */}
            <MagicBentoCard className="p-5 space-y-3 md:col-span-2">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
                <div className="p-4 rounded-xl bg-surface-3 border border-border-strong text-center">
                  <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Growth Metric</span>
                  {editing ? (
                    <input 
                      type="text"
                      className="w-full mt-2 px-2.5 py-1.5 border border-border rounded bg-surface-1 text-text-primary outline-none focus:border-accent text-xs font-bold text-center"
                      value={editData.market_snapshot?.headline_stat_value ?? ""}
                      onChange={e => setEditData({
                        ...editData,
                        market_snapshot: { ...editData.market_snapshot, headline_stat_value: e.target.value }
                      })}
                    />
                  ) : (
                    <span className="text-display mt-1 text-accent block">
                      {ca.market_snapshot?.headline_stat_value || "—"}
                    </span>
                  )}
                </div>
                
                <div className="md:col-span-3 space-y-1">
                  <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Overview Snapshot</span>
                  {editing ? (
                    <textarea 
                      rows={4}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                      value={editData.market_snapshot?.overview_paragraph ?? ""}
                      onChange={e => setEditData({
                        ...editData,
                        market_snapshot: { ...editData.market_snapshot, overview_paragraph: e.target.value }
                      })}
                    />
                  ) : ca.market_snapshot?.overview_paragraph ? (
                    <p className="text-text-secondary leading-relaxed text-xs">
                      {ca.market_snapshot.overview_paragraph}
                    </p>
                  ) : null}
                </div>
              </div>
            </MagicBentoCard>

            {/* Key Trends */}
            <MagicBentoCard className="p-5 space-y-3">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Key Industry Trends</span>
              {editing ? (
                <div className="space-y-3">
                  {editData.key_trends?.map((t: any, i: number) => (
                    <div key={i} className="flex gap-2 items-start border border-border p-3 rounded-lg bg-surface-3">
                      <div className="flex-1 space-y-2">
                        <input 
                          type="text"
                          className="w-full px-2 py-1 border border-border rounded bg-surface-1 text-text-primary text-xs font-bold"
                          value={t.trend_name}
                          onChange={e => {
                            const list = [...editData.key_trends];
                            list[i].trend_name = e.target.value;
                            setEditData({ ...editData, key_trends: list });
                          }}
                          placeholder="Trend name..."
                        />
                        <textarea 
                          rows={2}
                          className="w-full px-2 py-1 border border-border rounded bg-surface-1 text-text-primary text-xs"
                          value={t.description}
                          onChange={e => {
                            const list = [...editData.key_trends];
                            list[i].description = e.target.value;
                            setEditData({ ...editData, key_trends: list });
                          }}
                          placeholder="Trend description..."
                        />
                      </div>
                      <button 
                        type="button" 
                        onClick={() => {
                          const list = editData.key_trends.filter((_: any, idx: number) => idx !== i);
                          setEditData({ ...editData, key_trends: list });
                        }}
                        className="p-1 text-text-muted hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button 
                    type="button"
                    onClick={() => {
                      const list = [...(editData.key_trends || []), { trend_name: "", description: "" }];
                      setEditData({ ...editData, key_trends: list });
                    }}
                    className="flex items-center gap-1 text-[11px] font-bold text-accent hover:underline"
                  >
                    <Plus size={12} /> Add Trend
                  </button>
                </div>
              ) : (
                <ul className="space-y-2 pl-4 list-disc text-text-secondary leading-relaxed">
                  {ca.key_trends?.map((t: any, i: number) => (
                    <li key={i}>
                      <strong className="text-text-primary">{t.trend_name}:</strong> {t.description}
                    </li>
                  ))}
                  {(!ca.key_trends || ca.key_trends.length === 0) && <li className="italic">No trends documented</li>}
                </ul>
              )}
            </MagicBentoCard>

            {/* Positioning recommendation */}
            <MagicBentoCard className="p-5 space-y-3 md:col-span-2">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Positioning Recommendation</span>
              {editing ? (
                <textarea
                  rows={4}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                  value={editData.positioning_recommendation ?? ""}
                  onChange={e => setEditData({ ...editData, positioning_recommendation: e.target.value })}
                />
              ) : ca.positioning_recommendation ? (
                <p className="text-text-secondary leading-relaxed bg-surface-3 p-4 border border-border rounded-lg font-medium italic">
                  {ca.positioning_recommendation}
                </p>
              ) : null}
            </MagicBentoCard>

            {/* Target Buyer Persona — absent on reports saved before this field existed */}
            {(editing || ca.target_buyer_persona) && (
              <MagicBentoCard className="p-5 space-y-3 md:col-span-2">
                <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Target Buyer Persona</span>
                {editing ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        placeholder="Archetype name"
                        value={editData?.target_buyer_persona?.archetype_name ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, archetype_name: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Age range"
                        value={editData?.target_buyer_persona?.age_range ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, age_range: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Household income"
                        value={editData?.target_buyer_persona?.household_income ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, household_income: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Life stage"
                        value={editData?.target_buyer_persona?.life_stage ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, life_stage: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Shopping style"
                        value={editData?.target_buyer_persona?.shopping_style ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, shopping_style: e.target.value } })}
                        className="col-span-2 w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                      />
                    </div>
                    <input
                      type="text"
                      placeholder="Quote"
                      value={editData?.target_buyer_persona?.quote ?? ""}
                      onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, quote: e.target.value } })}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                    />
                    <textarea
                      rows={3}
                      placeholder="Lifestyle & personality"
                      value={editData?.target_buyer_persona?.lifestyle_and_personality ?? ""}
                      onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, lifestyle_and_personality: e.target.value } })}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-border/40">
                      <textarea
                        rows={2}
                        placeholder="Pain points"
                        value={editData?.target_buyer_persona?.pain_points ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, pain_points: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                      />
                      <textarea
                        rows={2}
                        placeholder="Objections"
                        value={editData?.target_buyer_persona?.objections ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, objections: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                      />
                      <textarea
                        rows={2}
                        placeholder="Purchase triggers"
                        value={editData?.target_buyer_persona?.purchase_triggers ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, purchase_triggers: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                      />
                      <textarea
                        rows={2}
                        placeholder="Messaging that resonates"
                        value={editData?.target_buyer_persona?.messaging_that_resonates ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, messaging_that_resonates: e.target.value } })}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                      />
                      <input
                        type="text"
                        placeholder="Preferred channels"
                        value={editData?.target_buyer_persona?.preferred_channels ?? ""}
                        onChange={e => setEditData({ ...editData, target_buyer_persona: { ...editData?.target_buyer_persona, preferred_channels: e.target.value } })}
                        className="sm:col-span-2 w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="bg-surface-3 p-4 border border-border rounded-lg space-y-2">
                    <p className="font-bold text-text-primary">{ca.target_buyer_persona.archetype_name}</p>
                    <p className="text-text-secondary italic">&ldquo;{ca.target_buyer_persona.quote}&rdquo;</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1">
                      <div>
                        <span className="text-[9px] text-text-muted uppercase tracking-wider">Age Range</span>
                        <p className="text-text-secondary">{ca.target_buyer_persona.age_range}</p>
                      </div>
                      <div>
                        <span className="text-[9px] text-text-muted uppercase tracking-wider">Household Income</span>
                        <p className="text-text-secondary">{ca.target_buyer_persona.household_income}</p>
                      </div>
                      <div>
                        <span className="text-[9px] text-text-muted uppercase tracking-wider">Life Stage</span>
                        <p className="text-text-secondary">{ca.target_buyer_persona.life_stage}</p>
                      </div>
                      <div>
                        <span className="text-[9px] text-text-muted uppercase tracking-wider">Shopping Style</span>
                        <p className="text-text-secondary">{ca.target_buyer_persona.shopping_style}</p>
                      </div>
                    </div>
                    <p className="text-text-secondary leading-relaxed">{ca.target_buyer_persona.lifestyle_and_personality}</p>
                    {(ca.target_buyer_persona.pain_points || ca.target_buyer_persona.objections || ca.target_buyer_persona.purchase_triggers || ca.target_buyer_persona.messaging_that_resonates || ca.target_buyer_persona.preferred_channels) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/40">
                        {ca.target_buyer_persona.pain_points && (
                          <div>
                            <span className="text-[9px] text-text-muted uppercase tracking-wider">Pain Points</span>
                            <p className="text-text-secondary">{ca.target_buyer_persona.pain_points}</p>
                          </div>
                        )}
                        {ca.target_buyer_persona.objections && (
                          <div>
                            <span className="text-[9px] text-text-muted uppercase tracking-wider">Objections</span>
                            <p className="text-text-secondary">{ca.target_buyer_persona.objections}</p>
                          </div>
                        )}
                        {ca.target_buyer_persona.purchase_triggers && (
                          <div>
                            <span className="text-[9px] text-text-muted uppercase tracking-wider">Purchase Triggers</span>
                            <p className="text-text-secondary">{ca.target_buyer_persona.purchase_triggers}</p>
                          </div>
                        )}
                        {ca.target_buyer_persona.messaging_that_resonates && (
                          <div>
                            <span className="text-[9px] text-text-muted uppercase tracking-wider">Messaging That Resonates</span>
                            <p className="text-text-secondary">{ca.target_buyer_persona.messaging_that_resonates}</p>
                          </div>
                        )}
                        {ca.target_buyer_persona.preferred_channels && (
                          <div className="sm:col-span-2">
                            <span className="text-[9px] text-text-muted uppercase tracking-wider">Preferred Channels</span>
                            <p className="text-text-secondary">{ca.target_buyer_persona.preferred_channels}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </MagicBentoCard>
            )}
            </MagicBentoSection>

            {/* Mapped Competitors Discovered */}
            <div className="space-y-3 border-t border-border/40 pt-4">
              <h3 className="text-sm font-bold text-text-primary">Discovered Competitor Mappings (10 total)</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(ca.large_brand_competitors || []).map((c: any, i: number) => (
                  c.empty_slot
                    ? <EmptySlotCard key={`large_${i}`} reason={c.reason || "No additional legacy competitor found."} />
                    : <CompetitorCard key={`large_${i}`} competitor={{ ...c, tier: "legacy" }} buyerSentimentEnabled={buyerSentimentEnabled} newsUpdatesEnabled={newsUpdatesEnabled} />
                ))}
                {(ca.indie_emerging_competitors || []).map((c: any, i: number) => (
                  c.empty_slot
                    ? <EmptySlotCard key={`indie_${i}`} reason={c.reason || "No additional emerging competitor found."} />
                    : <CompetitorCard key={`indie_${i}`} competitor={{ ...c, tier: "emerging" }} buyerSentimentEnabled={buyerSentimentEnabled} newsUpdatesEnabled={newsUpdatesEnabled} />
                ))}
              </div>
            </div>

          </div>
        )}

        {activeTab === "pricing" && (
          <div className="space-y-6">
            <h2 className="text-sm font-bold text-text-primary">Pricing Analysis & Benchmarks</h2>

            {!pricingEmpty && (
              assertProvenance(pa.provenance, "pricing") ? (
                <SectionSourceLine
                  flavor="pricing"
                  provenance={pa.provenance}
                  resolvedAt={pa.provenance_resolved_at}
                  open={pricingSourceOpen}
                  onToggle={() => setPricingSourceOpen(o => !o)}
                />
              ) : <SourceUnavailableCaption />
            )}

            {!editing && pricingEmpty ? (
              <p className="text-text-muted italic py-6 text-center">
                No pricing data available for this report yet. Click Edit above to add pricing information manually.
              </p>
            ) : (
              <MagicBentoSection className="grid grid-cols-1 gap-4">
                {/* Target Price & Positioning */}
                <MagicBentoCard className="p-5">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
                  <div className="p-4 rounded-xl bg-surface-3 border border-border-strong text-center">
                    <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Target Price</span>
                    {editing ? (
                      <input
                        type="text"
                        className="w-full mt-2 px-2.5 py-1.5 border border-border rounded bg-surface-1 text-text-primary outline-none focus:border-accent text-xs font-bold text-center"
                        value={editData.target_price ?? ""}
                        onChange={e => setEditData({ ...editData, target_price: e.target.value })}
                      />
                    ) : pa.target_price ? (
                      <span className="text-display mt-1 text-accent block">{pa.target_price}</span>
                    ) : (
                      <span className="text-xs text-text-muted italic block mt-2">Not set</span>
                    )}
                  </div>

                  <div className="md:col-span-3 space-y-1">
                    <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Price Positioning</span>
                    {editing ? (
                      <textarea
                        rows={3}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                        value={editData.price_positioning ?? ""}
                        onChange={e => setEditData({ ...editData, price_positioning: e.target.value })}
                      />
                    ) : pa.price_positioning ? (
                      <p className="text-text-secondary leading-relaxed">{pa.price_positioning}</p>
                    ) : (
                      <p className="text-xs text-text-muted italic">Not enough priced competitors to compute a positioning statement.</p>
                    )}
                  </div>
                </div>
                </MagicBentoCard>

                {/* Pricing benchmark grid */}
                {((editing ? editData.competitor_prices : pa.competitor_prices)?.length > 0) && (
                  <MagicBentoCard className="p-5 space-y-3">
                    <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Pricing Benchmarks</span>
                    <div className="bg-surface-3 border border-border rounded-lg overflow-hidden">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr className="bg-surface-1/40 border-b border-border/80 font-bold text-text-muted">
                            <th className="py-2.5 px-4">Competitor</th>
                            <th className="py-2.5 px-4">Brand</th>
                            <th className="py-2.5 px-4">Tier</th>
                            <th className="py-2.5 px-4">Price</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/45">
                          {(editing ? editData.competitor_prices : pa.competitor_prices)?.map((item: any, i: number) => (
                            <tr key={i} className="hover:bg-surface-1/10 transition-colors">
                              <td className="py-2.5 px-4 font-bold text-text-primary">
                                {item.name}
                                {item.source_url && (
                                  <a href={item.source_url} target="_blank" rel="noopener noreferrer" className="ml-1.5 text-accent hover:underline font-normal text-[10px]">
                                    source
                                  </a>
                                )}
                              </td>
                              <td className="py-2.5 px-4 text-text-secondary">{item.brand || ""}</td>
                              <td className="py-2.5 px-4 uppercase tracking-wider text-[9px] font-semibold">{item.tier || ""}</td>
                              <td className="py-2.5 px-4">
                                {editing ? (
                                  <input
                                    type="text"
                                    className="px-2 py-1 border border-border rounded bg-surface-1 text-text-primary text-xs max-w-[100px] font-mono"
                                    value={item.price ?? ""}
                                    onChange={e => {
                                      const list = [...editData.competitor_prices];
                                      list[i].price = e.target.value;
                                      setEditData({ ...editData, competitor_prices: list });
                                    }}
                                  />
                                ) : (
                                  <span className="font-mono text-accent-text font-bold">{item.price || ""}</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </MagicBentoCard>
                )}

                {/* General notes */}
                {(editing || pa.notes) && (
                  <MagicBentoCard className="p-5 space-y-2">
                    <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Pricing Notes & Strategy</span>
                    {editing ? (
                      <textarea
                        rows={4}
                        className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                        value={editData.notes ?? ""}
                        onChange={e => setEditData({ ...editData, notes: e.target.value })}
                        placeholder="Enter strategic pricing decisions or analysis notes..."
                      />
                    ) : (
                      <p className="text-text-secondary leading-relaxed whitespace-pre-line bg-surface-1/40 p-4 border border-border rounded-lg">
                        {pa.notes}
                      </p>
                    )}
                  </MagicBentoCard>
                )}
              </MagicBentoSection>
            )}
          </div>
        )}

        {activeTab === "go-to-market" && (
          <div className="space-y-6">
            <h2 className="text-sm font-bold text-text-primary">Go-To-Market Strategy</h2>

            <MagicBentoSection className="grid grid-cols-1 gap-4">
            {/* GTM Positioning */}
            <MagicBentoCard className="p-5 space-y-2">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Core Positioning</span>
              {editing ? (
                <textarea
                  rows={4}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                  value={editData.positioning ?? ""}
                  onChange={e => setEditData({ ...editData, positioning: e.target.value })}
                />
              ) : gtm.positioning ? (
                <p className="text-text-secondary leading-relaxed bg-surface-3 p-4 border border-border rounded-lg italic font-medium">
                  {gtm.positioning}
                </p>
              ) : null}
            </MagicBentoCard>

            {/* Quick Wins */}
            <MagicBentoCard className="p-5 space-y-3">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Quick Wins</span>
              {editing ? (
                <div className="space-y-2">
                  {editData.quick_wins?.map((win: string, i: number) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input 
                        type="text"
                        className="flex-1 px-2.5 py-1.5 border border-border rounded bg-surface-1 text-text-primary text-xs"
                        value={win}
                        onChange={e => {
                          const list = [...editData.quick_wins];
                          list[i] = e.target.value;
                          setEditData({ ...editData, quick_wins: list });
                        }}
                      />
                      <button 
                        type="button" 
                        onClick={() => {
                          const list = editData.quick_wins.filter((_: any, idx: number) => idx !== i);
                          setEditData({ ...editData, quick_wins: list });
                        }}
                        className="p-1 text-text-muted hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button 
                    type="button"
                    onClick={() => {
                      const list = [...(editData.quick_wins || []), ""];
                      setEditData({ ...editData, quick_wins: list });
                    }}
                    className="flex items-center gap-1 text-[11px] font-bold text-accent hover:underline"
                  >
                    <Plus size={12} /> Add Quick Win
                  </button>
                </div>
              ) : (
                <ul className="space-y-1.5 pl-4 list-disc text-text-secondary">
                  {gtm.quick_wins?.map((win: string, i: number) => (
                    <li key={i} className="leading-relaxed">{win}</li>
                  ))}
                  {(!gtm.quick_wins || gtm.quick_wins.length === 0) && <li className="italic">No quick wins listed</li>}
                </ul>
              )}
            </MagicBentoCard>

            {/* GTM Notes */}
            <MagicBentoCard className="p-5 space-y-2">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Launch Notes & Channel Strategy</span>
              {editing ? (
                <textarea
                  rows={4}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                  value={editData.notes ?? ""}
                  onChange={e => setEditData({ ...editData, notes: e.target.value })}
                  placeholder="Enter GTM launch notes..."
                />
              ) : gtm.notes ? (
                <p className="text-text-secondary leading-relaxed whitespace-pre-line bg-surface-1/40 p-4 border border-border rounded-lg">
                  {gtm.notes}
                </p>
              ) : null}
            </MagicBentoCard>
            </MagicBentoSection>

          </div>
        )}

        {activeTab === "content-form" && (
          <div className="space-y-6">
            <h2 className="text-sm font-bold text-text-primary">Content Form & Messaging Guidelines</h2>

            <MagicBentoSection className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Target Audience & Product info */}
            <MagicBentoCard className="p-5 space-y-1">
                <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Target Audience</span>
                {editing ? (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                    value={editData.target_audience ?? ""}
                    onChange={e => setEditData({ ...editData, target_audience: e.target.value })}
                  />
                ) : cf.target_audience ? (
                  <p className="font-bold text-text-primary text-xs p-3 bg-surface-3 rounded-lg border border-border">
                    {cf.target_audience}
                  </p>
                ) : null}
            </MagicBentoCard>

            <MagicBentoCard className="p-5 space-y-1">
                <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Product Name</span>
                {editing ? (
                  <input
                    type="text"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                    value={editData.product_name ?? ""}
                    onChange={e => setEditData({ ...editData, product_name: e.target.value })}
                  />
                ) : cf.product_name ? (
                  <p className="font-bold text-text-primary text-xs p-3 bg-surface-3 rounded-lg border border-border">
                    {cf.product_name}
                  </p>
                ) : null}
            </MagicBentoCard>

            {/* Key messages */}
            <MagicBentoCard className="p-5 space-y-3 md:col-span-2">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Key Messaging Themes</span>
              {editing ? (
                <div className="space-y-2">
                  {editData.key_messages?.map((msg: string, i: number) => (
                    <div key={i} className="flex gap-2 items-start">
                      <textarea 
                        rows={2}
                        className="flex-1 px-3 py-1.5 border border-border rounded bg-surface-1 text-text-primary text-xs resize-y"
                        value={msg}
                        onChange={e => {
                          const list = [...editData.key_messages];
                          list[i] = e.target.value;
                          setEditData({ ...editData, key_messages: list });
                        }}
                      />
                      <button 
                        type="button" 
                        onClick={() => {
                          const list = editData.key_messages.filter((_: any, idx: number) => idx !== i);
                          setEditData({ ...editData, key_messages: list });
                        }}
                        className="p-1 text-text-muted hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button 
                    type="button"
                    onClick={() => {
                      const list = [...(editData.key_messages || []), ""];
                      setEditData({ ...editData, key_messages: list });
                    }}
                    className="flex items-center gap-1 text-[11px] font-bold text-accent hover:underline"
                  >
                    <Plus size={12} /> Add messaging guideline
                  </button>
                </div>
              ) : (
                <ul className="space-y-2 pl-4 list-disc text-text-secondary leading-relaxed">
                  {cf.key_messages?.map((msg: string, i: number) => (
                    <li key={i}>{msg}</li>
                  ))}
                  {(!cf.key_messages || cf.key_messages.length === 0) && <li className="italic">No messages documented</li>}
                </ul>
              )}
            </MagicBentoCard>

            {/* Content notes */}
            <MagicBentoCard className="p-5 space-y-2 md:col-span-2">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block font-semibold">Copywriting Notes & Strategy</span>
              {editing ? (
                <textarea
                  rows={4}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs resize-y"
                  value={editData.notes ?? ""}
                  onChange={e => setEditData({ ...editData, notes: e.target.value })}
                  placeholder="Enter content production or copywriting guidelines..."
                />
              ) : cf.notes ? (
                <p className="text-text-secondary leading-relaxed whitespace-pre-line bg-surface-1/40 p-4 border border-border rounded-lg">
                  {cf.notes}
                </p>
              ) : null}
            </MagicBentoCard>
            </MagicBentoSection>

          </div>
        )}

      </div>

      {/* Danger Zone */}
      <div className="bg-surface-2 border border-danger/25 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-danger">
          <AlertTriangle className="w-4 h-4" />
          <h2 className="text-xs font-bold uppercase tracking-wider">Danger Zone</h2>
        </div>
        <p className="text-[11px] text-text-muted leading-normal">
          Permanently delete this report. This action is irreversible.
        </p>
        <button
          onClick={() => setConfirmDeleteOpen(true)}
          className="px-4 py-2 bg-danger/10 border border-danger/35 hover:bg-danger/20 text-danger text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 w-full sm:w-auto"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Delete report</span>
        </button>
      </div>

      <ConfirmDialog
        isOpen={confirmDeleteOpen}
        title="Delete this report?"
        description="This will permanently delete the report. This action is irreversible."
        confirmLabel="Delete report"
        loading={deleting}
        onConfirm={handleDeleteReport}
        onClose={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
