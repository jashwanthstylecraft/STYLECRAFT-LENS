// Tier 7 — the last, lowest-confidence fill in the field-resolution ladder:
// a doc-agnostic, category-level "typical for this kind of product" value,
// used only once every earlier tier (product data, web search, computed
// derivation) has already failed for a field. Deliberately narrow: only
// fields where a category-typical guess is genuinely useful and safe to
// label as unconfirmed. `warranty` is EXCLUDED on purpose — it's a legal
// commitment to the customer, not something safe to default even with a
// hedge; the same caution applies to anything else that reads as a
// specific, checkable number/claim rather than a genuinely typical pattern.
export const CATEGORY_DEFAULT_FIELD_IDS = new Set([
  "certification_needed",
  "rating_label",
  "care_directions",
  "hair_type",
  "material",
]);

interface CategoryDefaults {
  certification_needed?: string;
  rating_label?: string;
  care_directions?: string;
  hair_type?: string;
  material?: string;
}

// Matched by case-insensitive substring against the project's own free-text
// category (see lib/stylecraft-products.ts for the real values in use today:
// Clippers, Trimmers, Shavers, Sets, Hair Dryers, Styling Tools, Brushes,
// Apparel, Accessories) — never an exact-match lookup, since phrasing can
// vary ("Hair Dryers" vs "hair dryer" vs a subcategory string).
const CATEGORY_DEFAULTS: [string, CategoryDefaults][] = [
  ["clipper", {
    certification_needed: "CE, RoHS",
    rating_label: "Manufacturer rating label typically lists voltage, wattage, and applicable safety certification marks",
    care_directions: "Oil the blades after each use, clear off hair/debris with the included brush, and avoid full submersion in water unless the product is labeled waterproof.",
    // Was previously missing here (present for dryer/styling/brush below)
    // with no stated reason — a professional clipper is just as
    // universally marketed as usable across hair types as those
    // categories, so the omission left hair_type permanently empty for
    // this app's single largest product family. See
    // lib/gtm-tier6-inference.ts's inferHairTypeFromMotor for the more
    // specific, motor/RPM-cited version of this same answer that Tier 6
    // tries first — this is only the Tier 7 safety net.
    hair_type: "All Hair Types",
    material: "ABS plastic housing with stainless steel blades",
  }],
  ["trimmer", {
    certification_needed: "CE, RoHS",
    rating_label: "Manufacturer rating label typically lists voltage, wattage, and applicable safety certification marks",
    care_directions: "Oil the blades after each use, clear off hair/debris with the included brush, and avoid full submersion in water unless the product is labeled waterproof.",
    hair_type: "All Hair Types",
    material: "ABS plastic housing with stainless steel blades",
  }],
  ["shaver", {
    certification_needed: "CE, RoHS",
    rating_label: "Manufacturer rating label typically lists voltage, wattage, and applicable safety certification marks",
    care_directions: "Clean the foil/blade after each use and avoid full submersion in water unless the product is labeled waterproof.",
    hair_type: "All Hair Types",
    material: "ABS plastic housing with a stainless steel foil/blade",
  }],
  ["hair dryer", {
    certification_needed: "CE, ETL, RoHS",
    rating_label: "Manufacturer rating label typically lists voltage, wattage/amperage, and applicable safety certification marks",
    care_directions: "Clean the air intake filter regularly, avoid use near water, and unplug when not in use.",
    hair_type: "All Hair Types",
    material: "ABS plastic housing",
  }],
  ["styling", {
    certification_needed: "CE, RoHS",
    rating_label: "Manufacturer rating label typically lists voltage, wattage, and applicable safety certification marks",
    care_directions: "Allow the tool to cool before storing; avoid use on wet hair unless the product is labeled for wet use.",
    hair_type: "All Hair Types",
    material: "Ceramic- or tourmaline-coated plates/barrel over a metal core",
  }],
  ["brush", {
    care_directions: "Remove hair from the bristles after each use and wash periodically with mild soap and water.",
    hair_type: "All Hair Types",
    material: "Nylon or boar-bristle over a plastic or wood handle",
  }],
];

function normalizeCategory(category: string): string {
  return category.toLowerCase().trim();
}

// Returns the category-typical value for a field, or null if the field
// isn't in the tier-7 whitelist, no category was provided, or no known
// category keyword matches. Callers are responsible for wrapping the
// returned value in the spec's exact unconfirmed-source phrasing (see
// CATEGORY_DEFAULT_LABEL_PREFIX) before displaying/saving it.
export function getCategoryDefault(category: string | null | undefined, fieldId: string): string | null {
  if (!category || !CATEGORY_DEFAULT_FIELD_IDS.has(fieldId)) return null;

  const normalized = normalizeCategory(category);
  for (const [keyword, defaults] of CATEGORY_DEFAULTS) {
    if (normalized.includes(keyword)) {
      const value = (defaults as Record<string, string | undefined>)[fieldId];
      if (value) return value;
    }
  }
  return null;
}

export const CATEGORY_DEFAULT_LABEL_PREFIX = "Typical for this category (not confirmed for this product): ";
