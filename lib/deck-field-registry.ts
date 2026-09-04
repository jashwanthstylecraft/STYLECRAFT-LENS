// Default token -> data-source registry for the Project Deck feature. Every
// token named in the product spec maps here; anything a template contains
// that ISN'T in this registry is left unmapped (never guessed at) and
// flagged for an admin to resolve on the mapping screen.
//
// `launch_timing` is deliberately mapped to "unmapped" — there is no
// launch-date/scheduling field anywhere in GTM_FIELD_SCHEMA or the saved
// report today (confirmed by direct research). Rendering it blank is more
// honest than fabricating a date from prose.
import { DeckPlaceholderMap, DeckTokenMapping, DeckTokenSource } from "./deck-types";
import type { ParsedDeckTemplate } from "./deck-template-parser";

type RegistryEntry = Pick<DeckTokenMapping, "kind" | "source">;

export const DECK_TOKEN_REGISTRY: Record<string, RegistryEntry> = {
  product_title:         { kind: "text",  source: { type: "gtm_field", field_id: "product_title" } },
  // "productName" (the actual product, e.g. "Rival Clipper"), NOT the
  // project's internal free-text reference "name" — see lib/db/projects.ts's
  // ProjectInput comment. A sales deck should show the real product name.
  project_name:          { kind: "text",  source: { type: "project_field", field: "productName" } },
  generated_date:        { kind: "date",  source: { type: "computed", name: "generated_date" } },
  product_image:         { kind: "image", source: { type: "snapshot_image", slot: "hero" } },
  positioning_statement: { kind: "text",  source: { type: "gtm_field", field_id: "positioning_statement" } },
  product_name_origin:   { kind: "text",  source: { type: "gtm_field", field_id: "product_name_origin" } },
  why_creating_item:     { kind: "text",  source: { type: "gtm_field", field_id: "why_creating_item" } },
  // top_6_features became a 5-row repeatable group in GTM Schema v3
  // (top_6_features_1..5) — joined here rather than pointed at a single
  // now-nonexistent field id.
  feature_list:          { kind: "text",  source: { type: "computed", name: "feature_list" } },
  spec_highlights:       { kind: "text",  source: { type: "computed", name: "spec_highlights" } },
  usp_1: { kind: "text", source: { type: "gtm_field", field_id: "reason_to_buy", split: "numbered_list", split_index: 0 } },
  usp_2: { kind: "text", source: { type: "gtm_field", field_id: "reason_to_buy", split: "numbered_list", split_index: 1 } },
  usp_3: { kind: "text", source: { type: "gtm_field", field_id: "reason_to_buy", split: "numbered_list", split_index: 2 } },
  usp_4: { kind: "text", source: { type: "gtm_field", field_id: "reason_to_buy", split: "numbered_list", split_index: 3 } },
  usp_5: { kind: "text", source: { type: "gtm_field", field_id: "reason_to_buy", split: "numbered_list", split_index: 4 } },
  competitor_table:      { kind: "table", source: { type: "computed", name: "competitor_table" } },
  price:                 { kind: "text",  source: { type: "report_field", path: "pricing_analysis.target_price" } },
  price_positioning:     { kind: "text",  source: { type: "report_field", path: "pricing_analysis.price_positioning" } },
  good_better_best:      { kind: "text",  source: { type: "gtm_field", field_id: "good_better_best" } },
  core_audience:         { kind: "text",  source: { type: "gtm_field", field_id: "core_consumer" } },
  channel_highlights:    { kind: "text",  source: { type: "report_field", path: "go_to_market.quick_wins" } },
  // No GTM/report field for this exists anywhere in the app today (a real,
  // confirmed data gap — see Context) — left unmapped deliberately.
  launch_timing:         { kind: "text",  source: { type: "unmapped" } },
  data_sources:          { kind: "text",  source: { type: "computed", name: "provenance_summary" } },
};

const NUMBERED_LIST_PATTERN = /(?:^|\n)\s*(?:\d+[.)]|[-•*])\s*/;

// "1. First claim... 2. Second claim..." -> ["First claim...", "Second claim..."].
// Never invents or drops content: if no numbered/bulleted pattern is found,
// returns the whole text as a single-element array (index 0), so a
// mis-detected split still shows something true rather than nothing.
export function splitNumberedList(text: string, expectedCount: number): string[] {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];

  const parts = trimmed
    .split(NUMBERED_LIST_PATTERN)
    .map(p => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) return parts.slice(0, expectedCount);
  return [trimmed];
}

export function buildDefaultPlaceholderMap(parsed: ParsedDeckTemplate): DeckPlaceholderMap {
  const tokens: DeckTokenMapping[] = parsed.tokens.map(t => {
    const registryEntry = DECK_TOKEN_REGISTRY[t.token];
    const kind = registryEntry?.kind ?? t.kind;
    const source: DeckTokenSource = registryEntry?.source ?? { type: "unmapped" };
    return {
      token: t.token,
      kind,
      occurrences: t.occurrences,
      source,
      image_box_px: t.imageBoxPx,
    };
  });

  const unmapped_tokens = tokens.filter(t => t.source.type === "unmapped").map(t => t.token);

  return {
    version: 1,
    slide_count: parsed.slideCount,
    tokens,
    unmapped_tokens,
  };
}
