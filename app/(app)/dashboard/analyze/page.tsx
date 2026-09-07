"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Sparkles, Package, Pencil, Search, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { ProgressPanel } from "@/components/analyze/ProgressPanel";
import { ResultsPanel } from "@/components/analyze/ResultsPanel";
import { ToolType, getToolTypeLabel, toolTypesForIndustry } from "@/lib/tool-type-taxonomy";
import type { ToolTypeRow } from "@/lib/db/tool-types";
import { parsePriceToNumber } from "@/lib/pricing-analysis";
import { useAuth } from "@/hooks/useAuth";
// Type-only import — erased at compile time, so lib/db/catalog-products.ts's
// runtime code (which imports the server-only Supabase admin client) never
// reaches this "use client" bundle. Same precedent as ToolTypeRow above.
import type { CatalogProductRow } from "@/lib/db/catalog-products";
import { resolveAsinLocal } from "@/lib/asin-parse-client";

const TARGET_MARKET_LABELS: Record<string, string> = { pro: "Pro / Salon", consumer: "Retail", both: "Both" };

interface RelatedProductRow {
  input: string;
  asin: string | null;
  title: string | null;
  brand: string | null;
  price: string | null;
  image: string | null;
  error: string | null;
  mismatchWarning: string | null;
  loading: boolean;
  addedAt: string | null;
}
const EMPTY_RELATED_ROW: RelatedProductRow = {
  input: "", asin: null, title: null, brand: null, price: null, image: null,
  error: null, mismatchWarning: null, loading: false, addedAt: null,
};

// Sentinel select value that opens the inline "add new tool type" mini-form
// below, instead of being a real tool type itself.
const ADD_NEW_TOOL_TYPE = "__add_new__";

interface MotorFamilyOption {
  family_key: string;
  label: string;
  domain: string;
  aliases: string[];
}

// The parallel Heat/Plate Technology option shape — a full parallel to
// MotorFamilyOption for motorless styling tools (flat iron/curling iron/
// hot brush), minus the domain field (not needed here).
interface HeatTechFamilyOption {
  family_key: string;
  label: string;
  aliases: string[];
}

const CRITERION_LABELS: Record<string, string> = {
  motor: "Motor",
  heat_technology: "Heat/Plate Technology",
  none: "None",
};

interface ScoringProfileOption {
  type_key: string | null;
  motor_weight: number;
  price_weight: number;
  feature_weight: number;
}

function normalizeMotorToken(s: string): string {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").trim();
}

// Lightweight, self-contained mirror of lib/motor-taxonomy.ts's
// matchMotorFamily (whole-word alias containment) — deliberately NOT
// importing that module here, since it transitively pulls in server-only
// code (Supabase admin client, Rainforest calls) that must never reach a
// "use client" bundle. Families arrive from GET /api/motor-families already
// sorted by sort_order, so iterating in array order approximates the same
// first-match-wins precedence.
function detectMotorFamilyFromText(text: string, families: MotorFamilyOption[]): string | null {
  const tokens = new Set(normalizeMotorToken(text).split(/\s+/).filter(Boolean));
  if (tokens.size === 0) return null;
  for (const f of families) {
    const candidates = [f.label, f.family_key.replace(/_/g, " "), ...f.aliases];
    for (const c of candidates) {
      const cTokens = normalizeMotorToken(c).split(/\s+/).filter(Boolean);
      if (cTokens.length > 0 && cTokens.every(t => tokens.has(t))) return f.family_key;
    }
  }
  return null;
}

// Full parallel to detectMotorFamilyFromText for the Heat/Plate Technology
// criterion — same whole-word alias containment, same reasoning for not
// importing lib/heat-tech-taxonomy.ts directly into a client bundle.
function detectHeatTechFamilyFromText(text: string, families: HeatTechFamilyOption[]): string | null {
  const tokens = new Set(normalizeMotorToken(text).split(/\s+/).filter(Boolean));
  if (tokens.size === 0) return null;
  for (const f of families) {
    const candidates = [f.label, f.family_key.replace(/_/g, " "), ...f.aliases];
    for (const c of candidates) {
      const cTokens = normalizeMotorToken(c).split(/\s+/).filter(Boolean);
      if (cTokens.length > 0 && cTokens.every(t => tokens.has(t))) return f.family_key;
    }
  }
  return null;
}

export default function AnalyzePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "OWNER" || user?.role === "ADMIN";

  const projectIdParam = searchParams.get("projectId");
  const pastAnalysisId = searchParams.get("id");

  // App view state: 'form' | 'running' | 'results'
  const [viewState, setViewState] = useState<"form" | "running" | "results">("form");
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  // Form Fields State
  // Source chooser at the initial stage — "catalog" (📦 StyleCraft Catalog,
  // the default) vs "custom" (✏️ New/Custom Product, the old flat-form
  // behavior). catalogProductId is the authoritative id threaded onto the
  // analysis context (see lib/our-product-position.ts's resolveOurLineupTier
  // and lib/db/reports.ts's matchCatalogProduct, both id-first now).
  const [productSource, setProductSource] = useState<"catalog" | "custom">("catalog");
  const [catalogProducts, setCatalogProducts] = useState<CatalogProductRow[]>([]);
  const [catalogProductId, setCatalogProductId] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogToolTypeFilter, setCatalogToolTypeFilter] = useState("");
  const [saveToCatalog, setSaveToCatalog] = useState(false);
  const [industry, setIndustry] = useState("grooming-barbering");
  const [targetMarket, setTargetMarket] = useState<"pro" | "consumer" | "both">("both");
  const [productName, setProductName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  // Strict tool-type isolation (lib/tool-type-taxonomy.ts) — required so a
  // trimmer analysis can never pull in clipper data (or vice versa). Kept
  // separate from the free-text "category" field above, which is not
  // reliable enough on its own to gate competitor/spec/review selection.
  const [toolType, setToolType] = useState<ToolType | "">("");
  const [pricePoint, setPricePoint] = useState("");
  const [companyContext, setCompanyContext] = useState("");
  // Canonical motor type — one of the 7 fixed families (lib/validations.ts's
  // MOTOR_FAMILY_VALUES); matching/grounding always uses this, never
  // motorBrandedName below. motorBrandedName is an optional, display-only
  // marketing name (e.g. "EON Digital Brushless Motor") shown in documents
  // alongside the canonical family, never used for matching.
  const [motorFamily, setMotorFamily] = useState("");
  const [motorBrandedName, setMotorBrandedName] = useState("");
  // Full parallel to motorFamily/motorBrandedName for the Heat/Plate
  // Technology criterion (flat iron/curling iron/hot brush) — see
  // CRITERION_LABELS / primaryCriterion below for which one actually shows.
  const [heatTechFamily, setHeatTechFamily] = useState("");
  const [heatTechBrandedName, setHeatTechBrandedName] = useState("");
  const [keyDiff, setKeyDiff] = useState("");
  // Description autofill — Positioning context / Key differentiating
  // feature suggested from whatever's already typed into Description, so a
  // user doesn't have to re-type facts they already wrote once. Only ever
  // fills a field that's still empty (never overwrites something the user
  // typed), and only fires once per description text (descriptionAutofilledFor
  // tracks what it already ran against) so it can't spam calls while typing.
  const [autofillingFromDescription, setAutofillingFromDescription] = useState(false);
  const descriptionAutofilledFor = useRef<string>("");
  const [relatedProductRows, setRelatedProductRows] = useState<RelatedProductRow[]>([
    { ...EMPTY_RELATED_ROW }, { ...EMPTY_RELATED_ROW }, { ...EMPTY_RELATED_ROW },
  ]);
  // Predecessor Product Reference — a name or link to an existing/prior
  // StyleCraft product this one is a modified version of. Resolved server-
  // side at GTM generation time (lib/predecessor-product-context.ts) as a
  // fallback-only grounding source, not previewed here the way Related
  // Products are — no client round-trip needed for a plain text field.
  const [predecessorRef, setPredecessorRef] = useState("");
  const [motorFamilies, setMotorFamilies] = useState<MotorFamilyOption[]>([]);
  const [heatTechFamilies, setHeatTechFamilies] = useState<HeatTechFamilyOption[]>([]);
  const [toolTypes, setToolTypes] = useState<ToolTypeRow[]>([]);
  // "+ Add new tool type…" inline mini-form state.
  const [showAddToolType, setShowAddToolType] = useState(false);
  const [newToolTypeName, setNewToolTypeName] = useState("");
  const [newToolTypeSynonyms, setNewToolTypeSynonyms] = useState("");
  const [addingToolType, setAddingToolType] = useState(false);
  const [toolTypeDupSuggestion, setToolTypeDupSuggestion] = useState<{ label: string; type_key: string } | null>(null);

  // Market Category auto-fill — proposes the selected Tool Type's own label
  // (e.g. "Hair Clippers" for the clipper type) as a starting point, since
  // that's the most common real value anyway. Same "only fill if empty"
  // rule as the Description autofill below — never overwrites a value the
  // user already typed, or one pre-filled from an existing project.
  useEffect(() => {
    if (!toolType || category.trim() || toolTypes.length === 0) return;
    const label = getToolTypeLabel(toolType, toolTypes);
    if (label && label !== "—") setCategory(label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolType, toolTypes]);

  // Populates the Motor Type <select> with the real, fixed 7-family
  // taxonomy (lib/motor-taxonomy.ts).
  useEffect(() => {
    fetch("/api/motor-families")
      .then(r => r.json())
      .then(data => setMotorFamilies(data.families || []))
      .catch(() => {});
  }, []);

  // Populates the Heat/Plate Technology <select> with the real taxonomy
  // (lib/heat-tech-taxonomy.ts) — full parallel to the Motor Type fetch
  // above, shown instead of it for motorless styling tools.
  useEffect(() => {
    fetch("/api/heat-tech-families")
      .then(r => r.json())
      .then(data => setHeatTechFamilies(data.families || []))
      .catch(() => {});
  }, []);

  // Populates the catalog picker's card grid — the real, DB-backed
  // StyleCraft product lineup (lib/db/catalog-products.ts), replacing the
  // old hardcoded lib/stylecraft-products.ts array. Active products only.
  useEffect(() => {
    fetch("/api/catalog-products")
      .then(r => r.json())
      .then(data => setCatalogProducts(data.products || []))
      .catch(() => {});
  }, []);

  // Populates the Tool Type <select> with the real, DB-backed taxonomy
  // (built-ins + any admin/user-added custom types) — lib/db/tool-types.ts.
  useEffect(() => {
    fetch("/api/tool-types")
      .then(r => r.json())
      .then(data => setToolTypes(data.toolTypes || []))
      .catch(() => {});
  }, []);

  // Which criterion drives matching for the SELECTED tool type
  // (lib/db/tool-types.ts's primary_criterion) — replaces the old
  // industry-based "Motor Type only for Grooming & Barbering" gate, which
  // wrongly hid Motor for Hair Dryer (a real motorized type that happens to
  // share the "haircare-styling" industry with motorless flat
  // irons/curling irons/hot brushes). Before a specific tool type is picked,
  // falls back to the old industry heuristic just so the right field isn't
  // jarringly absent while the user is still choosing.
  const selectedToolTypeRow = toolType ? toolTypes.find(t => t.type_key === toolType) : undefined;
  const primaryCriterion: "motor" | "heat_technology" | "none" = selectedToolTypeRow
    ? (selectedToolTypeRow.primary_criterion as "motor" | "heat_technology" | "none")
    : (industry === "haircare-styling" ? "none" : "motor");
  const criterionLabel = CRITERION_LABELS[primaryCriterion] || "Motor";

  // "Adjust weights for this analysis" — resolves the selected tool type's
  // scoring profile (own row, else the global default) via
  // lib/db/scoring-profiles.ts, purely for prefilling the expander; the
  // actual weights used server-side are resolved fresh at analysis time
  // (see lib/analysisEngine.ts), this is display-only.
  const [scoringProfiles, setScoringProfiles] = useState<ScoringProfileOption[]>([]);
  const [showWeightOverride, setShowWeightOverride] = useState(false);
  const [weightOverrideInputs, setWeightOverrideInputs] = useState({ motor: "45", price: "35", feature: "20" });
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    fetch("/api/scoring-profiles")
      .then(r => r.json())
      .then(data => setScoringProfiles(data.profiles || []))
      .catch(() => {});
  }, []);

  const resolvedProfileForToolType = (() => {
    const own = toolType ? scoringProfiles.find(p => p.type_key === toolType) : undefined;
    return own || scoringProfiles.find(p => p.type_key === null) || { motor_weight: 45, price_weight: 35, feature_weight: 20 };
  })();

  // Re-prefills the expander's inputs from the newly-selected tool type's
  // profile whenever it's still closed (never clobbers a value the user is
  // actively adjusting).
  useEffect(() => {
    if (showWeightOverride) return;
    setWeightOverrideInputs({
      motor: String(resolvedProfileForToolType.motor_weight),
      price: String(resolvedProfileForToolType.price_weight),
      feature: String(resolvedProfileForToolType.feature_weight),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolType, scoringProfiles]);

  const weightOverrideSum = (Number(weightOverrideInputs.motor) || 0) + (Number(weightOverrideInputs.price) || 0) + (Number(weightOverrideInputs.feature) || 0);
  const weightOverridePct = (raw: string) => (weightOverrideSum > 0 ? Math.round(((Number(raw) || 0) / weightOverrideSum) * 100) : 0);

  async function handleSaveWeightsToProfile() {
    setSavingProfile(true);
    try {
      const res = await fetch("/api/admin/scoring-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          typeKey: toolType || null,
          motor: Number(weightOverrideInputs.motor),
          price: Number(weightOverrideInputs.price),
          feature: Number(weightOverrideInputs.feature),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save profile");
      toast.success("Saved as this tool type's default profile");
      const profilesRes = await fetch("/api/scoring-profiles");
      const profilesData = await profilesRes.json();
      setScoringProfiles(profilesData.profiles || []);
    } catch (err: any) {
      toast.error(err.message || "Failed to save profile — admin access required");
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleAddToolType() {
    const label = newToolTypeName.trim();
    if (label.length < 3) {
      toast.error("Name must be at least 3 characters");
      return;
    }
    const aliases = newToolTypeSynonyms.split(",").map(s => s.trim()).filter(Boolean);
    const family = industry === "haircare-styling" ? "beauty" : "clipper_trimmer_shaver";
    setAddingToolType(true);
    try {
      const res = await fetch("/api/tool-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, aliases, family, confirmDuplicate: !!toolTypeDupSuggestion }),
      });
      const data = await res.json();
      if (res.status === 409 && data.suggestion) {
        setToolTypeDupSuggestion(data.suggestion);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Failed to add tool type");
      setToolTypes(prev => [...prev, data.toolType]);
      setToolType(data.toolType.type_key);
      setShowAddToolType(false);
      setNewToolTypeName("");
      setNewToolTypeSynonyms("");
      setToolTypeDupSuggestion(null);
      toast.success(`Added "${data.toolType.label}" as a new tool type`);
    } catch (err: any) {
      toast.error(err.message || "Failed to add tool type");
    } finally {
      setAddingToolType(false);
    }
  }

  // Live auto-detect: as soon as the branded-name text resolves to a real
  // family (e.g. pasting "EON Digital Brushless Motor" matches Brushless
  // Motor's own seeded aliases), auto-select it — but only while no family
  // is selected yet, so this never fights a choice the user already made or
  // confirmed. The user can always change the select manually afterward.
  useEffect(() => {
    if (motorFamily || !motorBrandedName.trim() || motorFamilies.length === 0) return;
    const detected = detectMotorFamilyFromText(motorBrandedName, motorFamilies);
    if (detected) setMotorFamily(detected);
  }, [motorBrandedName, motorFamilies, motorFamily]);

  // Same live auto-detect, mirrored for the Heat/Plate Technology criterion.
  useEffect(() => {
    if (heatTechFamily || !heatTechBrandedName.trim() || heatTechFamilies.length === 0) return;
    const detected = detectHeatTechFamilyFromText(heatTechBrandedName, heatTechFamilies);
    if (detected) setHeatTechFamily(detected);
  }, [heatTechBrandedName, heatTechFamilies, heatTechFamily]);

// Clears the form back to a blank slate for manual entry — the "✏️ New/
  // Custom Product" side of the source chooser. keyDiff/category are left
  // alone here too (nothing to reset FROM if the user hasn't touched them
  // yet, and this mirrors handleCatalogProductSelect below never touching
  // them either).
  function handleCustomSelect() {
    setProductSource("custom");
    setCatalogProductId(null);
    setSaveToCatalog(false);
    setProductName("");
    setIndustry("grooming-barbering");
    setTargetMarket("both");
    setDescription("");
    setCategory("");
    setToolType("");
    // Positioning Context asks for THIS product's own positioning facts
    // (BSR, price tier, target customer), never a company/brand
    // description — nothing meaningful to prefill here.
    setCompanyContext("");
    setMotorFamily("");
    setMotorBrandedName("");
    setHeatTechFamily("");
    setHeatTechBrandedName("");
    setPricePoint("");
  }

  // Auto-fills exactly the 7 fields the catalog carries — productName,
  // industry, targetMarket, toolType, pricePoint, description, and
  // (mutually exclusive per product) motorFamily+motorBrandedName OR
  // heatTechFamily+heatTechBrandedName. category/keyDiff are deliberately
  // NOT touched — the catalog has no data for them, and this never
  // overwrites something the user already typed. Every field stays freely
  // editable afterward — this fills, it never locks.
  function handleCatalogProductSelect(product: CatalogProductRow) {
    setProductSource("catalog");
    setCatalogProductId(product.id);
    setIndustry(product.industry);
    setTargetMarket(product.target_market as any);
    setProductName(product.name);
    setDescription(product.description || "");
    setToolType(product.tool_type);
    setPricePoint(product.target_price != null ? `$${product.target_price.toFixed(2)}` : "");
    // Same reasoning as handleCustomSelect above — no real BSR/target-
    // customer data per catalog product, nothing genuine to prefill.
    setCompanyContext("");
    setMotorFamily(product.motor_family || "");
    setMotorBrandedName(product.motor_branded || "");
    setHeatTechFamily(product.heat_tech_family || "");
    setHeatTechBrandedName(product.heat_tech_branded || "");
    // Same "auto-fill from description" suggestion the Description
    // textarea's onBlur triggers manually — firing it here too means
    // picking a catalog product immediately suggests Positioning
    // context/Key differentiating feature from ITS description, instead of
    // only after the user happens to click into and back out of the
    // Description box. companyContext was just cleared above (line ~397),
    // so pass "" explicitly rather than reading the pre-selection state.
    void triggerDescriptionAutofill(product.name, product.description || "", keyDiff, "");
  }

  // Completed Results State (Aggregated results object)
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [savingReport, setSavingReport] = useState(false);
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const [regeneratingSynthesis, setRegeneratingSynthesis] = useState(false);

  // Patches exactly the one competitor a CompetitorCard just replaced
  // (POST .../competitors/replace) into whichever of phase1/phase2 it
  // actually lives in — this page owns analysisResult, CompetitorCard
  // never mutates its own competitor prop directly.
  function handleCompetitorReplaced(oldAsin: string, updatedCompetitor: any, synthesisPossiblyStale: boolean) {
    setAnalysisResult((prev: any) => {
      if (!prev) return prev;
      const patchList = (list: any[]) => (list || []).map((c: any) => (c.asin === oldAsin ? updatedCompetitor : c));
      const inPhase1 = (prev.phase1?.competitors || []).some((c: any) => c.asin === oldAsin);
      return {
        ...prev,
        phase1: inPhase1 ? { ...prev.phase1, competitors: patchList(prev.phase1.competitors) } : prev.phase1,
        phase2: !inPhase1 ? { ...prev.phase2, competitors: patchList(prev.phase2.competitors) } : prev.phase2,
        phase3: synthesisPossiblyStale && prev.phase3 ? { ...prev.phase3, synthesis_possibly_stale: true } : prev.phase3,
      };
    });
  }

  // Related Products' "fixing a mispaste re-fetches in place" swap —
  // patches analysisResult.relatedProducts by ASIN match, mirroring
  // handleCompetitorReplaced above exactly, just against a flat array
  // instead of phase1/phase2.competitors.
  function handleRelatedProductReplaced(oldAsin: string, updatedRelatedProduct: any) {
    setAnalysisResult((prev: any) => {
      if (!prev) return prev;
      return {
        ...prev,
        relatedProducts: (prev.relatedProducts || []).map((r: any) => (r.asin === oldAsin ? updatedRelatedProduct : r)),
      };
    });
  }

  // Remove + Refill single slot (Part 3) — three handlers mirroring
  // handleCompetitorReplaced above exactly: this page owns analysisResult,
  // CompetitorCard/EmptySlotCard never mutate their own props directly.

  // Fired by CompetitorCard's own onRemoved after ITS OWN POST
  // .../competitors/remove already succeeded — this just patches the
  // returned placeholder into whichever phase's competitors array the
  // removed ASIN lived in (tier tells us directly, no search needed) and
  // propagates staleness into phase3 exactly like handleCompetitorReplaced.
  function handleCompetitorRemoved(asin: string, tier: string, placeholder: any, synthesisPossiblyStale: boolean) {
    setAnalysisResult((prev: any) => {
      if (!prev) return prev;
      const patchList = (list: any[]) => (list || []).map((c: any) => (c.asin === asin ? placeholder : c));
      const inPhase1 = tier === "legacy";
      return {
        ...prev,
        phase1: inPhase1 ? { ...prev.phase1, competitors: patchList(prev.phase1.competitors) } : prev.phase1,
        phase2: !inPhase1 ? { ...prev.phase2, competitors: patchList(prev.phase2.competitors) } : prev.phase2,
        phase3: synthesisPossiblyStale && prev.phase3 ? { ...prev.phase3, synthesis_possibly_stale: true } : prev.phase3,
      };
    });
  }

  // Which removed slot's refill is currently in flight — threaded into
  // ResultsPanel so only that one EmptySlotCard shows a spinner.
  const [refillingAsin, setRefillingAsin] = useState<string | null>(null);

  // Fired by EmptySlotCard's onRefillRequested (just the removedAsin —
  // EmptySlotCard/ResultsPanel never fetch this themselves, unlike the
  // Remove flow above). This is the one that actually calls
  // POST .../competitors/refill-slot, then hands the parsed response
  // (with the requested removedAsin attached, since the route's own
  // response never echoes it back) to handleSlotRefilled below.
  async function requestSlotRefill(removedAsin: string) {
    if (!analysisId) return;
    setRefillingAsin(removedAsin);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/competitors/refill-slot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removedAsin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to refill this slot");
      handleSlotRefilled({ ...data, removedAsin });
    } catch (err: any) {
      toast.error(err.message || "Failed to refill this slot");
    } finally {
      setRefillingAsin(null);
    }
  }

  // An honest "nothing qualifies" (result.ok === false) is a NORMAL outcome
  // here (see app/api/analyses/[id]/competitors/refill-slot/route.ts's own
  // header comment) — surfaced via toast rather than silently doing
  // nothing, never treated as a crash.
  function handleSlotRefilled(result: any) {
    if (!result?.ok) {
      toast.error(result?.reason || "No replacement found for this slot");
      return;
    }
    const inPhase1 = result.tier === "legacy";
    setAnalysisResult((prev: any) => {
      if (!prev) return prev;
      const patchList = (list: any[]) => (list || []).map((c: any) => (c.removed_asin === result.removedAsin ? result.competitor : c));
      return {
        ...prev,
        phase1: inPhase1 ? { ...prev.phase1, competitors: patchList(prev.phase1.competitors) } : prev.phase1,
        phase2: !inPhase1 ? { ...prev.phase2, competitors: patchList(prev.phase2.competitors) } : prev.phase2,
        phase3: result.synthesisPossiblyStale && prev.phase3 ? { ...prev.phase3, synthesis_possibly_stale: true } : prev.phase3,
      };
    });
  }

  // Fired once after ResultsPanel's own "Remove & refill N flagged" button
  // completes its POST .../competitors/bulk-refill call — each entry is
  // either a successful remove+refill pair or a per-item error (never a
  // thrown exception, see that route's own per-item try/catch), so this
  // loops the same per-item logic as the two handlers above rather than
  // reusing them directly (their signatures don't fit a batch element).
  function handleBulkRefillComplete(results: any[]) {
    if (!results || results.length === 0) return;
    let anyStale = false;
    setAnalysisResult((prev: any) => {
      if (!prev) return prev;
      let phase1Competitors: any[] = prev.phase1?.competitors || [];
      let phase2Competitors: any[] = prev.phase2?.competitors || [];

      for (const item of results) {
        if (!item.ok) {
          toast.error(`Could not remove/refill ${item.asin}: ${item.error || "Unknown error"}`);
          continue;
        }
        const { removed, refilled } = item;
        if (removed?.synthesisPossiblyStale) anyStale = true;
        if (refilled?.synthesisPossiblyStale) anyStale = true;

        const inPhase1 = phase1Competitors.some((c: any) => c.asin === item.asin);
        const list = inPhase1 ? phase1Competitors : phase2Competitors;
        const original = list.find((c: any) => c.asin === item.asin);

        let replacement: any;
        if (refilled?.ok) {
          replacement = refilled.competitor;
        } else {
          replacement = {
            empty_slot: true,
            tier: removed?.tier,
            removed: true,
            removed_asin: removed?.removedAsin ?? item.asin,
            removed_name: original?.name ?? null,
            removed_brand: original?.brand ?? null,
            name: "Slot removed — refill to search for a replacement",
          };
          if (refilled?.reason) toast.error(`No replacement found for ${original?.name || item.asin}: ${refilled.reason}`);
        }

        const patched = list.map((c: any) => (c.asin === item.asin ? replacement : c));
        if (inPhase1) phase1Competitors = patched;
        else phase2Competitors = patched;
      }

      return {
        ...prev,
        phase1: { ...prev.phase1, competitors: phase1Competitors },
        phase2: { ...prev.phase2, competitors: phase2Competitors },
        phase3: anyStale && prev.phase3 ? { ...prev.phase3, synthesis_possibly_stale: true } : prev.phase3,
      };
    });
  }

  // Resets Phase 3 server-side then hands control back to the same
  // ProgressPanel view a fresh analysis uses — it re-fetches phase0-2
  // results (already complete, instant) and re-runs only the synthesis
  // call, no new state-machine code needed.
  async function handleRegenerateSynthesis() {
    if (!analysisId) return;
    setRegeneratingSynthesis(true);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/regenerate-synthesis`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to start synthesis regeneration");
      setViewState("running");
    } catch (err: any) {
      toast.error(err.message || "Failed to start synthesis regeneration");
    } finally {
      setRegeneratingSynthesis(false);
    }
  }

  // Pre-fill form if projectId is passed
  useEffect(() => {
    if (projectIdParam) {
      fetch(`/api/projects/${projectIdParam}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.project) {
            const p = data.project;
            setProductName(p.productName || "");
            setIndustry(p.industry || "grooming");
            setTargetMarket(p.targetMarket || "both");
            setDescription(p.description || "");
            setCategory(p.category || "");
            setToolType(p.toolType || "");
            setPricePoint(p.pricePoint || "");
            setCompanyContext(p.companyContext || "");
            setMotorFamily(p.motorFamily || "");
            // Courtesy starting point for a legacy project that only ever
            // had free-text motorTech (no motorFamily yet) — the live
            // auto-detect effect above will try to resolve it into the
            // canonical select once motorFamilies has loaded.
            setMotorBrandedName(p.motorFamily ? p.motorBrandedName || "" : p.motorTech || "");
            setKeyDiff(p.keyDiff || "");
            setPredecessorRef(p.predecessorRef || "");
            if (Array.isArray(p.relatedProducts) && p.relatedProducts.length) {
              const saved = p.relatedProducts as { asin: string | null; url?: string; addedAt?: string }[];
              setRelatedProductRows((rows) => rows.map((row, i) => (saved[i] ? { ...EMPTY_RELATED_ROW, input: saved[i].url || saved[i].asin || "" } : row)));
              saved.slice(0, 3).forEach((sp, i) => {
                const savedInput = sp.url || sp.asin;
                if (savedInput) void resolveRelatedRow(i, savedInput, [], sp.addedAt || null, p.toolType || "");
              });
            }
            toast.success(`Loaded specifications from project "${p.name}"`);
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdParam]);

  // Load past analysis if id is passed — resumes it via the ProgressPanel if
  // still in progress (or stuck mid-phase from an earlier dropped
  // connection) instead of only handling the already-complete case.
  useEffect(() => {
    if (pastAnalysisId) {
      fetch(`/api/analyses/${pastAnalysisId}`)
        .then((r) => r.json())
        .then((data) => {
          const analysis = data.analysis;
          if (!analysis) {
            toast.error("Analysis not found");
            return;
          }

          const name = analysis.projects?.product_name || analysis.context?.productName || "Product Analysis";
          setProductName(name);

          if (analysis.status === "complete") {
            const identity = analysis.phase0_result || {};
            const p1 = analysis.phase1_result || {};
            const p2 = analysis.phase2_result || {};
            const p3 = analysis.phase3_result || {};
            const searches = (p1.web_searches_performed || 0) + (p2.web_searches_performed || 0) + (p3.web_searches_performed || 0);

            setAnalysisId(analysis.id);
            setAnalysisResult({ identity, phase1: p1, phase2: p2, phase3: p3, relatedProducts: analysis.related_products || [], productName: name, totalSearches: searches });
            setViewState("results");
          } else if (analysis.status === "failed") {
            toast.error(analysis.error_message || "This analysis failed");
          } else {
            // pending/running — resume from whatever phase is persisted.
            setAnalysisId(analysis.id);
            setViewState("running");
          }
        })
        .catch(() => toast.error("Failed to load analysis"));
    }
  }, [pastAnalysisId]);

  const validate = (): boolean => {
    const errs: { [key: string]: string } = {};
    if (!productName.trim()) {
      errs.productName = "Product name is required";
    } else if (productName.trim().length < 3) {
      errs.productName = "Product name must be at least 3 characters";
    }
    if (!description.trim()) {
      errs.description = "Product description is required";
    } else if (description.trim().length < 10) {
      errs.description = "Add at least 10 characters for sharper results";
    }
    if (!toolType) errs.toolType = "Select the exact tool type";
    // Motor Type / Heat-Plate Technology are each shown only when the
    // selected tool type's primary_criterion actually calls for them —
    // required whenever the relevant one is actually shown, per
    // primaryCriterion above.
    if (primaryCriterion === "motor" && !motorFamily) {
      errs.motorFamily = "Select the motor type";
    }
    if (primaryCriterion === "heat_technology" && !heatTechFamily) {
      errs.heatTechFamily = "Select the plate/heat technology";
    }
    const priceNum = parsePriceToNumber(pricePoint);
    if (!pricePoint.trim() || priceNum === null || priceNum <= 0) {
      errs.pricePoint = "Enter a target price greater than $0";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  function formatPriceOnBlur() {
    const n = parsePriceToNumber(pricePoint);
    if (n !== null && n > 0) setPricePoint(`$${n.toFixed(2)}`);
  }

  function updateRelatedRow(index: number, patch: Partial<RelatedProductRow>) {
    setRelatedProductRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  // Validates + resolves one Related Products row: cheap local ASIN/URL
  // format check and duplicate-across-rows check first (no network
  // round-trip for an obviously invalid paste), then a real lightweight
  // preview fetch (POST /api/products/preview) for image/title/price so
  // the user can confirm they pasted the right product. Takes the raw
  // input/existing-ASINs as plain arguments (not read off component state)
  // so it can be called either from the onBlur handler below OR directly
  // from the project-pre-fill effect without a stale-closure risk.
  async function resolveRelatedRow(index: number, raw: string, existingAsins: (string | null)[], preservedAddedAt: string | null, requiredToolType: string) {
    if (!raw.trim()) {
      updateRelatedRow(index, { ...EMPTY_RELATED_ROW, input: "" });
      return;
    }

    const asin = resolveAsinLocal(raw);
    // Not an ASIN/Amazon URL — still accept it if it's at least a
    // well-formed URL (any other product/competitor page). The server
    // preview call below resolves it via a lightweight page-title fetch
    // instead of Rainforest; only genuinely non-URL garbage input errors
    // here without ever reaching the network.
    if (!asin && !/^https?:\/\//i.test(raw.trim())) {
      updateRelatedRow(index, { error: "Enter a valid ASIN, Amazon product URL, or any other product page URL", asin: null, title: null, brand: null, price: null, image: null, mismatchWarning: null });
      return;
    }
    if (asin && existingAsins.some((a, i) => i !== index && a === asin)) {
      updateRelatedRow(index, { error: "Already added in another row", asin: null, title: null, brand: null, price: null, image: null, mismatchWarning: null });
      return;
    }

    updateRelatedRow(index, { loading: true, error: null });
    try {
      const res = await fetch("/api/products/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asinOrUrl: raw.trim(), requiredToolType: requiredToolType || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        updateRelatedRow(index, { loading: false, error: data.message || "Could not fetch that product", asin: null, title: null, brand: null, price: null, image: null, mismatchWarning: null });
        return;
      }
      updateRelatedRow(index, {
        loading: false, error: null,
        asin: data.asin, title: data.title, brand: data.brand, price: data.price, image: data.image,
        mismatchWarning: data.toolTypeMismatchWarning || null,
        addedAt: preservedAddedAt || new Date().toISOString(),
      });
    } catch {
      updateRelatedRow(index, { loading: false, error: "Could not fetch that product — check the connection and try again" });
    }
  }

  function handleRelatedProductBlur(index: number) {
    const row = relatedProductRows[index];
    void resolveRelatedRow(index, row.input, relatedProductRows.map((r) => r.asin), row.addedAt, toolType);
  }

  // Shared by the Description textarea's onBlur AND catalog-product
  // selection below — takes the name/description/current-field values as
  // explicit params (never reads them off state) so it works correctly
  // right after handleCatalogProductSelect sets description/clears
  // companyContext in the same tick, before React has re-rendered.
  async function triggerDescriptionAutofill(nameText: string, descriptionText: string, currentKeyDiff: string, currentCompanyContext: string) {
    const trimmed = descriptionText.trim();
    if (trimmed.length < 10) return;
    if (currentCompanyContext.trim() && currentKeyDiff.trim()) return; // both already filled — nothing to suggest
    if (descriptionAutofilledFor.current === trimmed) return; // already tried this exact text
    descriptionAutofilledFor.current = trimmed;

    setAutofillingFromDescription(true);
    try {
      const res = await fetch("/api/analyze/autofill-from-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productName: nameText.trim() || "this product", description: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) return; // best-effort suggestion — a failure here should never block the form

      let filledSomething = false;
      if (data.keyDiff && !currentKeyDiff.trim()) {
        setKeyDiff(data.keyDiff);
        filledSomething = true;
      }
      if (data.positioningContext && !currentCompanyContext.trim()) {
        setCompanyContext(data.positioningContext);
        filledSomething = true;
      }
      if (filledSomething) toast.success("Suggested Positioning context / Key differentiating feature from your description — review and edit as needed");
    } catch {
      // Best-effort — never surfaces an error for a suggestion feature.
    } finally {
      setAutofillingFromDescription(false);
    }
  }

  function handleDescriptionBlur() {
    return triggerDescriptionAutofill(productName, description, keyDiff, companyContext);
  }

  // {asin,url,addedAt} triples for the submit body / project pre-fill —
  // only resolved, non-errored rows count. asin is null for a non-Amazon
  // related product (see resolveRelatedRow) — url carries it instead, so
  // it's required in that case (a resolved external row always has one,
  // set from the input itself when the preview call succeeded).
  function resolvedRelatedAsins(): { asin: string | null; url?: string; addedAt: string }[] {
    return relatedProductRows
      .filter((r) => (r.asin || r.title) && !r.error)
      .map((r) => ({
        asin: r.asin,
        url: /^https?:\/\//i.test(r.input.trim()) ? r.input.trim() : undefined,
        addedAt: r.addedAt || new Date().toISOString(),
      }));
  }

  const handleRunAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (submitting) return;

    setSubmitting(true);
    try {
      // Save project defaults if associated with a project
      if (projectIdParam) {
        fetch(`/api/projects/${projectIdParam}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            savedDefaults: {
              productName: productName.trim(),
              industry,
              targetMarket,
              description: description.trim(),
              category: category.trim(),
              toolType,
              pricePoint: pricePoint.trim(),
              companyContext: companyContext.trim(),
              motorFamily,
              motorBrandedName: motorBrandedName.trim(),
              keyDiff: keyDiff.trim(),
            },
            // Top-level column (not nested in savedDefaults, which the
            // pre-fill effect above doesn't read) — mirrors how
            // companyContext/motorFamily are ALSO real top-level project
            // columns the pre-fill effect reads directly (p.companyContext,
            // not p.savedDefaults.companyContext).
            relatedProducts: resolvedRelatedAsins(),
            predecessorRef: predecessorRef.trim() || null,
          })
        }).catch(() => {});
      }

      // Legacy free-text fallback for any code path not yet updated to read
      // motorFamily/motorBrandedName directly — the branded name if given,
      // else the canonical family's own label, never blank when a family is
      // selected.
      const motorFamilyLabel = motorFamilies.find(f => f.family_key === motorFamily)?.label || "";
      const motorTechFallback = motorFamilyLabel
        ? (motorBrandedName.trim() ? `${motorFamilyLabel} (${motorBrandedName.trim()})` : motorFamilyLabel)
        : motorBrandedName.trim();
      // Same fallback construction, mirrored for Heat/Plate Technology.
      const heatTechFamilyLabel = heatTechFamilies.find(f => f.family_key === heatTechFamily)?.label || "";
      const heatTechRawFallback = heatTechFamilyLabel
        ? (heatTechBrandedName.trim() ? `${heatTechFamilyLabel} (${heatTechBrandedName.trim()})` : heatTechFamilyLabel)
        : heatTechBrandedName.trim();

      const res = await fetch("/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectIdParam || undefined,
          industry,
          targetMarket,
          productName: productName.trim(),
          description: description.trim(),
          category: category.trim() || undefined,
          toolType,
          companyContext: companyContext.trim() || undefined,
          // Only submit whichever criterion actually applies to the
          // selected tool type — never both, never a stale value left over
          // from a prior tool-type selection.
          motorFamily: primaryCriterion === "motor" ? (motorFamily || undefined) : undefined,
          motorBrandedName: primaryCriterion === "motor" ? (motorBrandedName.trim() || undefined) : undefined,
          motorTech: primaryCriterion === "motor" ? (motorTechFallback || undefined) : undefined,
          heatTechFamily: primaryCriterion === "heat_technology" ? (heatTechFamily || undefined) : undefined,
          heatTechBrandedName: primaryCriterion === "heat_technology" ? (heatTechBrandedName.trim() || undefined) : undefined,
          heatTechRaw: primaryCriterion === "heat_technology" ? (heatTechRawFallback || undefined) : undefined,
          keyDiff: keyDiff.trim() || undefined,
          pricePoint: pricePoint.trim() || undefined,
          catalogProductId: catalogProductId || undefined,
          relatedAsins: resolvedRelatedAsins().length ? resolvedRelatedAsins() : undefined,
          predecessorRef: predecessorRef.trim() || undefined,
          weightOverride: showWeightOverride && weightOverrideSum > 0 ? {
            motor: Number(weightOverrideInputs.motor) || 0,
            price: Number(weightOverrideInputs.price) || 0,
            feature: Number(weightOverrideInputs.feature) || 0,
          } : undefined,
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to start analysis");

      // "Save changes back to catalog" — admin-gated (client-side here, the
      // PATCH route enforces it for real). Best-effort, never blocks the
      // analysis itself from starting.
      if (saveToCatalog && catalogProductId && isAdmin) {
        fetch(`/api/admin/catalog-products/${catalogProductId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: productName.trim(),
            industry,
            targetMarket,
            toolType,
            targetPrice: parsePriceToNumber(pricePoint),
            description: description.trim(),
            motorFamily: primaryCriterion === "motor" ? (motorFamily || null) : null,
            motorBranded: primaryCriterion === "motor" ? (motorBrandedName.trim() || null) : null,
            heatTechFamily: primaryCriterion === "heat_technology" ? (heatTechFamily || null) : null,
            heatTechBranded: primaryCriterion === "heat_technology" ? (heatTechBrandedName.trim() || null) : null,
          }),
        }).catch(() => {});
      }

      setAnalysisId(data.analysisId);
      setViewState("running");
    } catch (err: any) {
      toast.error(err.message || "Failed to trigger analysis");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAsReport = async () => {
    if (savedReportId) {
      router.push(`/dashboard/reports/${savedReportId}`);
      return;
    }

    if (!analysisId || !analysisResult) return;
    
    setSavingReport(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Competitive Intelligence Report — ${productName}`,
          projectId: projectIdParam || undefined,
          analysisId,
          productName,
          industry,
          targetMarket,
          pricePoint,
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message);

      toast.success("Report saved");
      router.push(`/dashboard/reports/${data.report.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to save report");
    } finally {
      setSavingReport(false);
    }
  };

  // Canonical family label + branded name in parens when given (e.g.
  // "Brushless Motor (EON Digital Brushless Motor)") — pure derived text for
  // the review-step summary below, mirrors how competitor comparisons
  // display motor_type/motor_branded_name (CompetitorCard.tsx).
  const motorSummaryLabel = (() => {
    const label = motorFamilies.find(f => f.family_key === motorFamily)?.label;
    if (!label) return "";
    return motorBrandedName.trim() ? `${label} (${motorBrandedName.trim()})` : label;
  })();
  // Same derivation, mirrored for Heat/Plate Technology.
  const heatTechSummaryLabel = (() => {
    const label = heatTechFamilies.find(f => f.family_key === heatTechFamily)?.label;
    if (!label) return "";
    return heatTechBrandedName.trim() ? `${label} (${heatTechBrandedName.trim()})` : label;
  })();
  // Whichever criterion applies to the currently-selected tool type, or a
  // neutral "not applicable" note for 'none' types — never shows a stale
  // Motor label for a motorless product or vice versa.
  const criterionSummaryLabel = primaryCriterion === "heat_technology"
    ? (heatTechSummaryLabel || `${criterionLabel.toLowerCase()} unspecified`)
    : primaryCriterion === "motor"
    ? (motorSummaryLabel || "motor type unspecified")
    : "not applicable for this tool type";

  return (
    <div className="space-y-6">
      {/* Dynamic Header */}
      {viewState === "form" && (
        <div className="flex flex-col gap-2 cinema-text">
          <h1 className="text-display">New competitive analysis</h1>
          <p className="text-xs text-text-secondary leading-normal max-w-2xl">
            Gemini searches the web and Amazon indices to discover 10 competing products (5 established, 5 emerging) then maps prices, specifications, and synthesises strategic intelligence recommendations. Takes 1–2 minutes.
          </p>
        </div>
      )}

      {/* VIEW 1: INPUT FORM */}
      {viewState === "form" && (
        <form onSubmit={handleRunAnalysis} className="space-y-6 text-xs">
          {/* Product source chooser */}
          <div className="bg-surface-2 border border-accent/30 rounded-xl p-5 space-y-4 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-accent/5 rounded-full blur-xl pointer-events-none" />
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/15 text-accent border border-accent/20">
                <Sparkles className="w-4 h-4 text-accent" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-text-primary">Where&apos;s this product from?</h3>
                <p className="text-[10px] text-text-muted mt-0.5">Pick one of our own products to auto-fill every field, or enter a custom product manually</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setProductSource("catalog")}
                className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-xs font-semibold transition ${productSource === "catalog" ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface-1 text-text-secondary hover:border-accent/40"}`}
              >
                <Package className="w-4 h-4" /> StyleCraft Catalog
              </button>
              <button
                type="button"
                onClick={handleCustomSelect}
                className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-xs font-semibold transition ${productSource === "custom" ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface-1 text-text-secondary hover:border-accent/40"}`}
              >
                <Pencil className="w-4 h-4" /> New / Custom Product
              </button>
            </div>

            {productSource === "catalog" && (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={catalogSearch}
                    onChange={e => setCatalogSearch(e.target.value)}
                    placeholder="Search products…"
                    className="w-full pl-8 pr-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-xs"
                  />
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCatalogToolTypeFilter("")}
                    className={`px-2 py-1 rounded-full text-[10px] font-semibold border ${!catalogToolTypeFilter ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-accent/40"}`}
                  >
                    All
                  </button>
                  {toolTypes.filter(t => catalogProducts.some(p => p.tool_type === t.type_key)).map(t => (
                    <button
                      key={t.type_key}
                      type="button"
                      onClick={() => setCatalogToolTypeFilter(t.type_key)}
                      className={`px-2 py-1 rounded-full text-[10px] font-semibold border ${catalogToolTypeFilter === t.type_key ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-accent/40"}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="max-h-72 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2 pr-1">
                  {catalogProducts.length === 0 && (
                    <p className="text-[10px] text-text-muted col-span-2 text-center py-4">Loading catalog…</p>
                  )}
                  {catalogProducts
                    .filter(p => !catalogToolTypeFilter || p.tool_type === catalogToolTypeFilter)
                    .filter(p => !catalogSearch.trim() || p.name.toLowerCase().includes(catalogSearch.trim().toLowerCase()))
                    .map(p => {
                      const isSelected = catalogProductId === p.id;
                      const isIncomplete = p.import_flags?.includes("incomplete");
                      const techLabel = p.motor_branded || p.heat_tech_branded;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleCatalogProductSelect(p)}
                          className={`text-left p-3 rounded-lg border transition space-y-1 ${isSelected ? "border-accent bg-accent/10" : "border-border bg-surface-1 hover:border-accent/40"}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-semibold text-text-primary text-xs leading-tight">{p.name}</span>
                            {isIncomplete && (
                              <span className="flex items-center gap-0.5 shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-warning/10 border border-warning/25 text-warning">
                                <AlertTriangle className="w-2.5 h-2.5" /> Incomplete
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-muted">
                            <span>{getToolTypeLabel(p.tool_type, toolTypes)}</span>
                            {p.target_price != null && (
                              <>
                                <span>•</span>
                                <span className="text-accent font-bold">${p.target_price.toFixed(2)}</span>
                              </>
                            )}
                            {techLabel && (
                              <>
                                <span>•</span>
                                <span>{techLabel}</span>
                              </>
                            )}
                          </div>
                        </button>
                      );
                    })}
                </div>

                {catalogProductId && isAdmin && (
                  <label className="flex items-center gap-2 text-[10px] text-text-secondary pt-2 border-t border-border">
                    <input
                      type="checkbox"
                      checked={saveToCatalog}
                      onChange={e => setSaveToCatalog(e.target.checked)}
                      className="rounded"
                    />
                    Save changes back to catalog
                  </label>
                )}
              </div>
            )}
          </div>

          {/* Card 1: Product Specs */}
          <div className="bg-surface-2 border border-border rounded-xl p-5 space-y-4 shadow-sm">
            <h2 className="text-sm font-bold text-text-primary">Product details</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="font-semibold text-text-primary block">Industry *</label>
                <select
                  value={industry}
                  onChange={(e) => {
                    setIndustry(e.target.value);
                    // Motor Type only applies to motorized tool types, Heat/
                    // Plate Technology only to motorless styling tools — the
                    // Industry switch itself doesn't determine which shows
                    // (the selected Tool Type does, see primaryCriterion
                    // above), but clear both here as a reasonable starting
                    // point so a stale value never gets submitted before the
                    // Tool Type re-selection below settles which one applies.
                    if (e.target.value === "haircare-styling") { setMotorFamily(""); setMotorBrandedName(""); }
                    else { setHeatTechFamily(""); setHeatTechBrandedName(""); }
                    // Tool Type options are Industry-dependent (see
                    // toolTypesForIndustry) — a Tool Type valid under the
                    // old Industry (e.g. "Trimmer") is meaningless once the
                    // Industry no longer offers it.
                    setToolType(prev => (toolTypesForIndustry(e.target.value, toolTypes).some(t => t.type_key === prev) ? prev : ""));
                  }}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                  required
                >
                  <option value="" disabled>Select industry…</option>
                  <option value="grooming-barbering">Grooming & Barbering</option>
                  <option value="haircare-styling">Hair Care & Styling</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-text-primary block mb-1">Target Market *</label>
                <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-surface-1 border border-border">
                  {[
                    { key: "pro", label: "Pro / Salon" },
                    { key: "consumer", label: "Retail" },
                    { key: "both", label: "Both" }
                  ].map(opt => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setTargetMarket(opt.key as any)}
                      className={`py-1.5 rounded-md text-[10px] font-bold transition-all ${
                        targetMarket === opt.key
                          ? "bg-surface-3 text-text-primary border border-border-strong shadow-sm"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-text-muted">
                  Affects which competitor brands are searched — Pro/Salon and Retail use separate curated brand lists; Both merges and dedupes across both.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="font-semibold text-text-primary block">Product Name *</label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => {
                    setProductName(e.target.value);
                    if (errors.productName) setErrors(prev => { const n = { ...prev }; delete n.productName; return n; });
                  }}
                  placeholder="e.g. Apex Cordless Clipper"
                  className={`w-full px-3 py-2 border rounded-lg bg-surface-1 outline-none text-text-primary focus:border-accent ${
                    errors.productName ? "border-danger" : "border-border"
                  }`}
                />
                {errors.productName && <p className="text-[10px] text-danger">{errors.productName}</p>}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-text-primary block">Tool Type *</label>
                  <select
                    value={toolType}
                    onChange={(e) => {
                      if (e.target.value === ADD_NEW_TOOL_TYPE) {
                        setShowAddToolType(true);
                        return;
                      }
                      setToolType(e.target.value as ToolType);
                      if (errors.toolType) setErrors(prev => { const n = { ...prev }; delete n.toolType; return n; });
                    }}
                    className={`w-full px-3 py-2 border rounded-lg bg-surface-1 outline-none text-text-primary focus:border-accent ${
                      errors.toolType ? "border-danger" : "border-border"
                    }`}
                  >
                    <option value="" disabled>Select exact tool type…</option>
                    {toolTypesForIndustry(industry, toolTypes).map((t) => (
                      <option key={t.type_key} value={t.type_key}>{t.label}</option>
                    ))}
                    <option value={ADD_NEW_TOOL_TYPE}>+ Add new tool type…</option>
                  </select>
                  {errors.toolType && <p className="text-[10px] text-danger">{errors.toolType}</p>}
                  {showAddToolType && (
                    <div className="mt-2 p-3 border border-border rounded-lg bg-surface-3/30 space-y-2">
                      <input
                        type="text"
                        value={newToolTypeName}
                        onChange={(e) => { setNewToolTypeName(e.target.value); setToolTypeDupSuggestion(null); }}
                        placeholder="New tool type name — e.g. Foil Shaper"
                        className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                      />
                      <input
                        type="text"
                        value={newToolTypeSynonyms}
                        onChange={(e) => setNewToolTypeSynonyms(e.target.value)}
                        placeholder="Also called (comma-separated, optional)"
                        className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                      />
                      {toolTypeDupSuggestion && (
                        <p className="text-[10px] text-warning">
                          Did you mean &quot;{toolTypeDupSuggestion.label}&quot;?{" "}
                          <button type="button" className="underline font-semibold" onClick={() => { setToolType(toolTypeDupSuggestion.type_key); setShowAddToolType(false); setNewToolTypeName(""); setNewToolTypeSynonyms(""); setToolTypeDupSuggestion(null); }}>
                            Use this instead
                          </button>
                          {" · "}
                          <button type="button" className="underline font-semibold" onClick={handleAddToolType} disabled={addingToolType}>
                            Add anyway
                          </button>
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleAddToolType}
                          disabled={addingToolType}
                          className="flex items-center gap-1 px-2.5 py-1 bg-accent hover:bg-accent-hover text-white text-[11px] font-bold rounded-lg transition-colors disabled:opacity-50"
                        >
                          {addingToolType ? "Adding…" : "Add"}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setShowAddToolType(false); setNewToolTypeName(""); setNewToolTypeSynonyms(""); setToolTypeDupSuggestion(null); }}
                          className="px-2.5 py-1 text-[11px] font-semibold text-text-muted hover:text-text-primary transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-text-primary block">Market Category</label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Hair Clippers"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-text-primary block">Target Price *</label>
                  <input
                    type="text"
                    value={pricePoint}
                    onChange={(e) => {
                      setPricePoint(e.target.value);
                      if (errors.pricePoint) setErrors(prev => { const n = { ...prev }; delete n.pricePoint; return n; });
                    }}
                    onBlur={formatPriceOnBlur}
                    placeholder="e.g. $180"
                    className={`w-full px-3 py-2 border rounded-lg bg-surface-1 outline-none text-text-primary focus:border-accent ${
                      errors.pricePoint ? "border-danger" : "border-border"
                    }`}
                  />
                  {errors.pricePoint && <p className="text-[10px] text-danger">{errors.pricePoint}</p>}
                  <p className="text-[10px] text-text-muted">Competitors are matched by motor technology first, then closest to this price.</p>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="font-semibold text-text-primary">Product Description *</label>
                <span className="text-[10px] text-text-muted">{description.length} chars {description.trim().length > 0 && description.trim().length < 10 ? `(${10 - description.trim().length} more needed)` : ""}</span>
              </div>
              <textarea
                rows={4}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  if (errors.description) setErrors(prev => { const n = { ...prev }; delete n.description; return n; });
                }}
                onBlur={handleDescriptionBlur}
                placeholder="Describe key specs, blade/motor type, battery life, target audience..."
                className={`w-full px-3 py-2 border rounded-lg bg-surface-1 outline-none text-text-primary focus:border-accent resize-y ${
                  errors.description ? "border-danger" : "border-border"
                }`}
              />
              {errors.description && <p className="text-[10px] text-danger">{errors.description}</p>}
              {autofillingFromDescription && (
                <p className="text-[10px] text-text-muted flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Suggesting Positioning context / Key differentiating feature from your description…
                </p>
              )}
            </div>
          </div>

          {/* Card 2: Positioning Context — product facts, not company/brand
              description (feeds AI positioning advice for THIS product). */}
          <div className="bg-surface-2 border border-border rounded-xl p-5 space-y-4 shadow-sm">
            <h2 className="text-sm font-bold text-text-primary">Positioning context</h2>
            <div className="space-y-1">
              <label className="font-semibold text-text-primary block">Positioning context</label>
              <textarea
                rows={2}
                value={companyContext}
                onChange={(e) => setCompanyContext(e.target.value)}
                placeholder="e.g. Currently #1,200 BSR in Beauty & Personal Care, priced mid-tier vs. competitors, popular with barbershop owners age 30-50..."
                className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent resize-y"
              />
              <p className="text-[10px] text-text-muted">
                Product-specific facts that sharpen positioning — current BSR, standout reviews, who actually buys it. Not a company/brand description.
              </p>
            </div>

            <div className="space-y-3 pt-3 border-t border-border">
              <div>
                <label className="font-semibold text-text-primary block">Related Products</label>
                <p className="text-[10px] text-text-muted">
                  Paste Amazon URLs (or any other product page URL) of up to 3 products similar to yours. These help Claude find nearby, comparable competitors — and they&apos;ll appear in the analysis alongside the discovered competitors. Non-Amazon links are shown for reference and used as discovery context, but won&apos;t carry price/rating data.
                </p>
              </div>
              {relatedProductRows.map((row, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={row.input}
                      onChange={(e) => updateRelatedRow(i, { input: e.target.value, error: null, mismatchWarning: null })}
                      onBlur={() => handleRelatedProductBlur(i)}
                      placeholder={`Related product ${i + 1} — Amazon URL, ASIN, or any other product page URL (optional)`}
                      className="flex-1 px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-sm"
                    />
                    {row.loading && <span className="text-[10px] text-text-muted whitespace-nowrap">Checking…</span>}
                  </div>
                  {row.error && <p className="text-[10px] text-danger">{row.error}</p>}
                  {row.mismatchWarning && <p className="text-[10px] text-warning">{row.mismatchWarning}</p>}
                  {(row.asin || row.title) && !row.error && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <div className="flex items-center gap-2 px-3 py-2 bg-surface-1 border border-border rounded-lg">
                      {row.image && <img src={row.image} alt="" className="w-8 h-8 object-contain rounded flex-shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-text-primary truncate">{row.title}</p>
                        <p className="text-[10px] text-text-muted">
                          {row.asin ? [row.brand, row.price].filter(Boolean).join(" · ") : `${row.brand || "external reference"} · no price/rating data`}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-1 pt-3 border-t border-border">
              <label className="font-semibold text-text-primary block">Based on an existing product (optional)</label>
              <p className="text-[10px] text-text-muted">
                If this is a modified/refreshed version of a product you already sell, paste its name or a link (Amazon or any other product page). We&apos;ll use it to fill in GTM fields your other sources don&apos;t cover — never to override this product&apos;s own real, different specs.
              </p>
              <input
                type="text"
                value={predecessorRef}
                onChange={(e) => setPredecessorRef(e.target.value)}
                placeholder="e.g. an existing StyleCraft product name, or an Amazon/product URL"
                className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent text-sm"
              />
            </div>
          </div>

          {/* Card 3: Precision specs */}
          <div className="bg-surface-2 border border-border rounded-xl p-5 space-y-4 shadow-sm">
            <h2 className="text-sm font-bold text-text-primary">Precision targeting</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Motor Type / Heat-Plate Technology — whichever criterion
                  actually applies to the SELECTED tool type
                  (primaryCriterion above, from lib/db/tool-types.ts's
                  primary_criterion), never both, never neither's stale
                  leftover value. Each is a fixed canonical list — our own
                  branding (e.g. "EON Digital Brushless Motor") maps to a
                  canonical family for matching purposes; the branded name is
                  a separate, optional display-only field below it. */}
              {primaryCriterion === "motor" && (
                <div className="space-y-1">
                  <label className="font-semibold text-text-primary block">Motor type *</label>
                  <select
                    value={motorFamily}
                    onChange={(e) => {
                      setMotorFamily(e.target.value);
                      if (errors.motorFamily) setErrors(prev => { const n = { ...prev }; delete n.motorFamily; return n; });
                    }}
                    className={`w-full px-3 py-2 border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent ${
                      errors.motorFamily ? "border-danger" : "border-border"
                    }`}
                  >
                    <option value="">Select motor type…</option>
                    {motorFamilies.map(f => (
                      <option key={f.family_key} value={f.family_key}>{f.label}</option>
                    ))}
                  </select>
                  {errors.motorFamily && <p className="text-[10px] text-danger">{errors.motorFamily}</p>}
                  <input
                    type="text"
                    value={motorBrandedName}
                    onChange={(e) => setMotorBrandedName(e.target.value)}
                    placeholder="Branded motor name (optional) — e.g. EON Digital Brushless Motor"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                  />
                  <p className="text-[10px] text-text-muted">
                    Competitors are matched on the motor family. Your branded motor name appears in documents but matching uses the universal type.
                  </p>
                </div>
              )}

              {primaryCriterion === "heat_technology" && (
                <div className="space-y-1">
                  <label className="font-semibold text-text-primary block">Plate/heat technology *</label>
                  <select
                    value={heatTechFamily}
                    onChange={(e) => {
                      setHeatTechFamily(e.target.value);
                      if (errors.heatTechFamily) setErrors(prev => { const n = { ...prev }; delete n.heatTechFamily; return n; });
                    }}
                    className={`w-full px-3 py-2 border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent ${
                      errors.heatTechFamily ? "border-danger" : "border-border"
                    }`}
                  >
                    <option value="">Select plate/heat technology…</option>
                    {heatTechFamilies.map(f => (
                      <option key={f.family_key} value={f.family_key}>{f.label}</option>
                    ))}
                  </select>
                  {errors.heatTechFamily && <p className="text-[10px] text-danger">{errors.heatTechFamily}</p>}
                  <input
                    type="text"
                    value={heatTechBrandedName}
                    onChange={(e) => setHeatTechBrandedName(e.target.value)}
                    placeholder="Branded plate/heat name (optional) — e.g. SoftTouch Titanium"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                  />
                  <p className="text-[10px] text-text-muted">
                    Competitors are matched on the plate/heat technology family. Your branded name appears in documents but matching uses the universal type.
                  </p>
                </div>
              )}

              <div className={`space-y-1 ${primaryCriterion === "none" ? "md:col-span-2" : ""}`}>
                <label className="font-semibold text-text-primary block">Key differentiating feature</label>
                <input
                  type="text"
                  value={keyDiff}
                  onChange={(e) => setKeyDiff(e.target.value)}
                  placeholder="e.g. full-metal body, zero-gap blade, 4-hour battery life"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                />
                <p className="text-[10px] text-text-muted">Optional — competitors sharing this feature are ranked slightly higher.</p>
              </div>
            </div>
          </div>

          {/* "Adjust weights for this analysis" — prefilled from the
              selected tool type's scoring profile (lib/db/scoring-profiles.ts);
              changes here apply to THIS run only unless "Save to profile" is
              clicked. Free-entry, no sum-to-1 constraint — normalization
              happens server-side at scoring time. */}
          <div className="bg-surface-2 border border-border rounded-xl p-5 space-y-3">
            <button
              type="button"
              onClick={() => setShowWeightOverride(v => !v)}
              className="flex items-center justify-between w-full text-left"
            >
              <span className="text-sm font-bold text-text-primary">Adjust weights for this analysis</span>
              <span className="text-[10px] text-text-muted">{showWeightOverride ? "Hide" : "Optional — click to expand"}</span>
            </button>
            {showWeightOverride && (
              <div className="space-y-3">
                <p className="text-[10px] text-text-muted">
                  Enter any non-negative numbers expressing RELATIVE importance — no need to sum to 1 or 100. Prefilled from this tool type&apos;s current profile.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{criterionLabel}</label>
                    <input
                      type="number" step="1" min="0"
                      value={weightOverrideInputs.motor}
                      onChange={e => setWeightOverrideInputs(prev => ({ ...prev, motor: e.target.value }))}
                      className="mt-1 w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                    />
                    <p className="mt-0.5 text-[10px] text-text-muted">→ {weightOverridePct(weightOverrideInputs.motor)}%</p>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Price</label>
                    <input
                      type="number" step="1" min="0"
                      value={weightOverrideInputs.price}
                      onChange={e => setWeightOverrideInputs(prev => ({ ...prev, price: e.target.value }))}
                      className="mt-1 w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                    />
                    <p className="mt-0.5 text-[10px] text-text-muted">→ {weightOverridePct(weightOverrideInputs.price)}%</p>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Features</label>
                    <input
                      type="number" step="1" min="0"
                      value={weightOverrideInputs.feature}
                      onChange={e => setWeightOverrideInputs(prev => ({ ...prev, feature: e.target.value }))}
                      className="mt-1 w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-surface-1 text-text-primary outline-none focus:border-accent"
                    />
                    <p className="mt-0.5 text-[10px] text-text-muted">→ {weightOverridePct(weightOverrideInputs.feature)}%</p>
                  </div>
                </div>
                {weightOverrideSum <= 0 && <p className="text-[10px] text-danger">At least one criterion must be &gt; 0 — falling back to the profile default.</p>}
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-text-muted">
                    {criterionLabel} {weightOverrideInputs.motor || 0} → {weightOverridePct(weightOverrideInputs.motor)}% · Price {weightOverrideInputs.price || 0} → {weightOverridePct(weightOverrideInputs.price)}% · Features {weightOverrideInputs.feature || 0} → {weightOverridePct(weightOverrideInputs.feature)}%
                  </p>
                  <button
                    type="button"
                    onClick={handleSaveWeightsToProfile}
                    disabled={savingProfile}
                    className="px-2.5 py-1.5 text-[11px] font-semibold text-accent hover:underline disabled:opacity-50"
                  >
                    {savingProfile ? "Saving…" : "Save to profile"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Review-step summary — pure derived text, confirms every field's
              real value right before the run starts (no new state). */}
          {productName.trim() && toolType && (
            <p className="text-[11px] text-text-secondary bg-surface-3/30 border border-border rounded-lg px-4 py-2.5">
              Analyzing: <span className="font-semibold text-text-primary">{productName.trim()}</span> — {getToolTypeLabel(toolType, toolTypes)}, {criterionSummaryLabel}, {pricePoint.trim() || "price unspecified"}, {TARGET_MARKET_LABELS[targetMarket]} market
              {keyDiff.trim() && <> · differentiator: {keyDiff.trim()}</>}
            </p>
          )}

          {/* Action Row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border border-border bg-surface-2 rounded-xl">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => router.back()}
                disabled={submitting}
                className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Cancel</span>
              </button>
              <span className="text-[10px] text-text-secondary">
                ⚡ Runs 3-phase AI search · crawls competitive web data · outputs strategic recommendations
              </span>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="flex items-center justify-center gap-1.5 px-6 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-xs font-bold rounded-lg transition-all shadow shadow-accent/25 self-end sm:self-auto"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Starting analysis…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Run analysis</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* VIEW 2: RUNNING PROGRESS PANEL */}
      {viewState === "running" && analysisId && (
        <ProgressPanel
          analysisId={analysisId}
          productName={productName}
          onComplete={(res) => {
            setAnalysisResult(res);
            if (res.reportId) {
              setSavedReportId(res.reportId);
            }
            setViewState("results");
          }}
          onError={(msg) => {
            toast.error(msg || "Analysis failed");
            setViewState("form");
          }}
          onCancelled={() => {
            toast("Analysis cancelled");
            setViewState("form");
          }}
        />
      )}

      {/* VIEW 3: RESULTS PANEL */}
      {viewState === "results" && analysisResult && (
        <ResultsPanel
          analysis={{ ...analysisResult, pricePoint }}
          analysisId={analysisId}
          onSaveAsReport={handleSaveAsReport}
          savingReport={savingReport}
          onNewAnalysis={() => setViewState("form")}
          onCompetitorReplaced={handleCompetitorReplaced}
          onRelatedProductReplaced={handleRelatedProductReplaced}
          onRegenerateSynthesis={handleRegenerateSynthesis}
          regeneratingSynthesis={regeneratingSynthesis}
          onRemoved={handleCompetitorRemoved}
          onRefillRequested={requestSlotRefill}
          refillingAsin={refillingAsin}
          onBulkRefillComplete={handleBulkRefillComplete}
        />
      )}
    </div>
  );
}
