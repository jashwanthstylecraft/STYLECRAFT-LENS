# GTM Style Reference — real-sheet pattern analysis

**Date:** 2026-10-07
**Why this exists:** the team compared Lens-generated GTM sheets against real, AI-assisted (Claude/ChatGPT) GTM docs they'd written by hand in Google Sheets and found Lens's output noticeably weaker. This document is the pattern analysis from reading 6 of those real sheets end-to-end (Gamma+ Boosted One Shaver GP804B, GP115B Xceed Dryer, Homie Clipper SC628B, Saber II Clipper Orange SC617O, Arbitrage Clipper SCMD631B, 3Versince Trimmer 3VESTRIM — covering clipper, trimmer, shaver, and dryer categories across both the StyleCraft and Gamma+ brands).

**What actually changed because of this:** the 3 products among these 6 that had zero prior calibration (Gamma+ Boosted One Shaver, GP115B Xceed Dryer, 3Versince Trimmer) were added as real excerpts to `lib/gtm-style-exemplars.ts` — the corpus that's actually injected into the GTM generation prompt (`lib/gtm-generate.ts`'s `buildSystemInstruction`, gated by `STYLE_EXEMPLAR_FIELD_IDS`/`renderStyleExemplarBlock`). That file already had excerpts from the other 3 (Homie Clipper, Saber II Orange, Arbitrage Clipper) from earlier work — this pass filled two real gaps: **zero Gamma+-brand calibration** and **zero Hair Dryer category calibration** (every prior exemplar was a StyleCraft barber tool). This document is the *why* behind those additions and a reference for extending the corpus further — it is not itself read by the generation pipeline.

**If you're asked to add more real GTM sheets to this corpus later:** read the sheet via Google Drive (`mcp__claude_ai_Google_Drive__read_file_content` with the file ID from its URL), pull the patterns described below, add a new entry to `GTM_STYLE_EXEMPLARS` in `lib/gtm-style-exemplars.ts` using only real, complete sentences (never complete a sentence Drive's own extraction truncated), and update this file's exemplar list in the header comment.

---

## 1. Real sheet structure (confirms Lens's own export template is already right)

Every real sheet follows the same tab sequence: **Product** (SKU/UPC/launch metadata) → **Product Testing** (usually empty) → **Product Knowledge** (the brief — Core Consumer, Why Creating This, Positioning Statement draft, Product Name Origin, Name/Story Tie, Collection, New Technology, Approved Pricing, Good/Better/Best) → **BOX ONLY** (condensed box copy) → **Product FAQ** → **Marketing Direction** (strategy layer, see §3) → **Final Copy** (polished copywriter output) → **Austin Review** (a named internal reviewer's revision pass — see §4) → **Product Purchasing** / **Creative Playbook** / **GTM Plan Deliverables** / **Sampling Program** (ops/PM tabs, no AI content). This matches `lib/gtm-workbook-data-mapper.ts`'s existing 5-sheet real-template mapping (Product Knowledge, BOX ONLY, Marketing Direction, Product FAQ, Final Copy) — the structure was never the gap.

Key observation: **the same conceptual field (e.g. "Positioning Statement") appears twice** — once as a rough brief in Product Knowledge (sometimes left blank — it's a prompt, not a deliverable), and again as the polished, final version in Final Copy. Final Copy's version is consistently tighter and more specific than Product Knowledge's.

## 2. Narrative field patterns (what actually makes these read better)

- **Positioning Statement almost always references a specific named sibling/predecessor product or a specific proprietary technology name, never generic claims.** Example (Gamma+ Boosted One Shaver): "Where the Double Foil covers ground, the Boosted One goes deeper into the detail" — directly contrasts against its own sibling SKU. Example (Arbitrage Clipper): grounded entirely in the "P.U.R.E. Outrunner Motor" name, never a generic "powerful motor" claim. **Lens's `positioning_statement` currently has no mechanism to reference sibling/predecessor products by name** — it only has `companyContext` + general sources. Consider: does `predecessorRef`/`predecessorProduct` context (already in the GTM prompt as `<PREDECESSOR_PRODUCT>`) get surfaced strongly enough for this? Worth checking.
- **Why are we creating this item?** is either (a) one tight sentence for a simple collection-completion ("Completing the Homie Collection with the addition of this clipper") or (b) a named consumer-need + competitive-gap + proof point for a flagship/new-tech product. Never generic "there's a market for this."
- **Product Name Origin / How does the name tie to the story?** always does real wordplay or real brand-meaning work, then explicitly calls back every subsequent claim to that theme. Example (Xceed): the name IS the tagline IS the proof structure — "exceed expectations" → every spec is framed as "exceeding" a limit. This callback discipline (name's theme echoed in every other field) is consistently present and is probably the single most distinctive trait of real copy vs. generic AI copy.
- **Variant/color-extension products** (Saber II Orange) address a specific objection head-on: "I already have the Saber 2 in black, why do I need this?" — framed in Marketing Direction's `Consumer Barrier` field, then answered in the Positioning Statement/Core Message as a collectible/identity angle, never pretending the variant is a wholly new product.
- **Partnership/co-branded products** (3Versince Trimmer) name the partner brand directly and repeatedly, and — notably — the "New Technology?" answer is honestly **"No, reused platform motor"** rather than inventing a tech angle. Real GTMs don't force a new-technology story when there isn't one.
- **Feature bullets**: `CAPS LABEL. 1-2 sentence benefit.` — confirmed consistent across every sheet and every brand. This already matches Lens's own `features_full_list` prompt convention exactly — not a gap.
- **FAQs** are literal `Q: ... A: ...` pairs, each answer citing a specific, checkable fact (exact RPM, exact hour count, exact test condition — "tested to 1,000 working hours in Italian salon conditions").
- **Taglines** come as a short numbered list (3-5 options), explicitly split "Sexy" (emotional/short) vs. "Techie" (spec-forward, often literally the 3 front-of-box callouts).

## 3. Marketing Direction — a whole layer Lens doesn't generate at all

Every real sheet has a full Marketing Direction tab: Previous Product Reference, Primary Goal, Success KPIs, Launch Timing, Core Audience (with explicit age ranges and real buying-channel names like "BSG, Cosmo Prof"), Secondary Audience, Consumer Barrier, Messaging Direction, Visual Direction, sometimes Content Ideas / Languages / Do's & Don'ts / Web Coverage / Trade Show Launch. `lib/gtm-style-exemplars.ts` already has calibration text for most of these (`marketing_primary_goal`, `marketing_success_kpis`, etc. — added in earlier work for the 360 Jeezy/Arbitrage/Saber exemplars), and this pass added the same fields for the 3 new products. **Open question worth raising with the team**: does Lens's `GTM_FIELD_SCHEMA` actually have fields wired to accept AI-generated answers for all of these, or does Marketing Direction stay human-only in the app today? If the schema has the fields but they're `internal`-kind (never asked of the AI), that's a deliberate choice worth confirming is still wanted — these are clearly AI-draftable from the same sources (TDS, competitive analysis, pricing) the rest of the sheet uses.

## 4. Explicit house-style rules found in real reviewer notes

These came from an internal reviewer's actual correction comments (the "Austin Review" tab), not inferred — treat them as real, standing brand rules:

- **Never use em dashes in any copy.** (Arbitrage Clipper's `marketing_dos_donts`: "DO NOT use em dashes in any copy.") Lens's own prompt/output should be checked against this — worth a grep for em-dash usage in generated copy if this hasn't been enforced already.
- **Never use "professional" as a standalone descriptor.** (Saber Trimmer Orange's `marketing_dos_donts`.) It should always be paired with something more specific.
- **Never imply another StyleCraft/Gamma+ product is worse, even by comparison framing.** Real example: a draft describing the Arbitrage Clipper's quietness by contrast ("brushless motors are typically noisier...") was rejected because StyleCraft *also* sells brushless clipper motors — the fix was to compare against "powerful motors" generically, never name a sibling product's own motor type as the inferior baseline. This is the same principle behind this session's "exclude the analyzed product's own brand from competitor lists" fix, one level up: never let one StyleCraft/Gamma+ product's marketing copy disparage another.
- **Lead with a short, punchy hook sentence; cut filler words.** Real editor note on the 3Versince Trimmer's long description: "Start with: 'Our first ever trimmer with hand-modified blade assembled!' ... the first sentence is the most important. It's a hook, and the shorter, the sweeter. We dropped a lot of the filler words like 'this' and 'ship' and 'on the unit.'"
- **A variant/color SKU must never read as a downgrade.** Every orange/variant sheet explicitly instructs: performance parity with the original must be stated plainly, and the variant must never be framed as "secondary" or "a new color, nothing else."

## 5. Products referenced (useful if any of these come up again)

| Product | SKU | Brand | Category | Key facts |
|---|---|---|---|---|
| Boosted One Shaver | GP804B | Gamma+ | Shaver | Super Torque Motor, 9,000 RPM, single gold titanium foil, sibling to Boosted Double Foil |
| Xceed Hair Dryer | GP115B | Gamma+ | Dryer | OxyRay Trio Light Technology (infrared + active oxygen + ionic), brushless motor, 12 heat/speed combos, $249.95 salon, partnership w/ Gamma Più (Italy) |
| Homie Nano Clipper | SC628B | StyleCraft | Clipper | USB-C, 7,000 RPM, anchors the "Homie Collection" (Clipper/Trimmer/Shaver), $69.95/$74.95 |
| Saber II Clipper (Orange) | SC617O | StyleCraft Pro | Clipper | Color variant of Saber 2 (also Black/White/Gold); EON Digital Brushless Motor, 7,200 RPM, DLC Echo blade, $299.95/$319.95 |
| Arbitrage Clipper | SCMD631B | StyleCraft Pro | Clipper | P.U.R.E. Outrunner Motor (new to StyleCraft) with Intuitive Torque Control, DLC Echo blade, 4hr runtime, $259.95/$269.95 |
| 3Versince X S\|C Pro Trimmer | 3VESTRIM | StyleCraft Pro | Trimmer | Partnership product w/ 3Versince blade brand (ES5, hand-sharpened/diamond-lapped), same Super Torque Motor as Flex Trimmer, 7,500 RPM |

See also [[stylecraft_gtm_brand_rules]] (agent memory) for Rafa Pinto's broader brand voice rules, and `lib/gtm-style-exemplars.ts` for the literal corpus these patterns were extracted from.
