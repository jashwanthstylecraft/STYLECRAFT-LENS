// lib/gtm-style-exemplars.ts
// GTM style corpus — literal (not paraphrased) excerpts from real, approved
// GTM Product Knowledge documents: Homie Clipper (SC628B), Homie Shaver
// (SC817B), Homie Shaver Replacement Foil (SC559B), the SC x 360 Jeezy
// Trimmer (SC423B), the Arbitrage Clipper (SCMD631B), the Saber Trimmer —
// Orange (SC421O), and the Saber II Clipper — Orange (SC617O). These
// describe OTHER, already-shipped products — they exist here purely as
// style/depth/format calibration for the AI generation prompt
// (lib/gtm-generate.ts's buildSystemInstruction), never as a data source
// for a NEW product's own facts. See STANDING_ANTI_COPY_WARNING below,
// which is embedded verbatim in every generation call that includes this
// corpus.
//
// Only the style-sensitive fields are included (narrative/claim-format
// fields) — grounded spec fields (dimensions, warranty text, etc.) don't
// need few-shot calibration and are deliberately excluded to keep prompt
// size down (see gtm-generate.ts's STYLE_EXEMPLAR_FIELD_IDS gate, which only
// attaches this corpus to chunks containing at least one of these ids).

export const STANDING_ANTI_COPY_WARNING =
  "The exemplar documents show REQUIRED style/depth/format only. They describe OTHER products. Never copy, paraphrase, or reuse their content, claims, specs, prices, or stories for a different product. Exception: collection-shared narratives, where you are explicitly instructed to adapt (not copy verbatim, not invent fresh) a stored collection kernel.";

export type ExemplarTier = "accessible" | "accessory" | "flagship";

export interface GtmExemplar {
  productName: string;
  sku: string;
  tier: ExemplarTier;
  excerpts: Partial<Record<string, string>>;
}

export const GTM_STYLE_EXEMPLARS: GtmExemplar[] = [
  {
    productName: "Homie Nano Clipper",
    sku: "SC628B",
    tier: "accessible",
    excerpts: {
      why_creating_item: "Completing the Homie Collection with the addition of this clipper",
      positioning_statement:
        "The StyleCraft Homie Nano Clipper is a USB-C rechargeable cordless clipper built for professionals and everyday users who want quiet, lightweight performance and smooth, clean results at a price that competes with the top DTC and Amazon brands. The compact nano body, Fixed Stainless Steel Taper Blade, and customizable click or freestyle lever deliver real cutting performance without the premium price tag. Compatible with most StyleCraft and Gamma+ clipper blades, the Homie Nano Clipper is the tool that anchors the Homie Collection and opens the door to a wider audience.",
      product_name_origin:
        "Homie is a term rooted in loyalty, familiarity, and community - it's the person who always has your back, reliable, real, and never pretentious. The Homie name was established with this clipper and carried through the full collection (Clipper, Trimmer, Shaver) to represent StyleCraft's connection to the grooming community at every level. The stylized H with a heart in the logo reinforces that emotional bond - this is a brand that cares about craft and the people who practice it.",
      name_story_tie:
        "The Homie name signals accessibility without sacrificing credibility. A homie doesn't show off - they just show up and deliver. That's exactly what the Nano Clipper does: ultra-quiet, lightweight, smooth cutting, at a price that makes sense. The name also anchors the Homie Collection ecosystem - when a consumer already owns the Homie Trimmer or Shaver, the Clipper feels like a natural completion of the set rather than a standalone purchase. Compatible with most StyleCraft and Gamma+ blades, it fits right into a kit they're already building. The name does the cross-sell for you.",
      features_full_list:
        "POWERFUL MOTOR runs at up to 7,000 RPM and cuts through any hair type.\nFIXED STAINLESS STEEL TAPER BLADE and silver Ceramic cutting blade are great for smoother bulk cutting.",
      reason_to_buy:
        "ULTRA-QUIET OPERATION - One of the quietest tools in its class. The kind of quiet people notice - less noise fatigue, more focus, every cut. COMPACT NANO BODY - Genuinely lightweight ergonomic design built to reduce hand fatigue during extended use. Light enough that you notice it most when you put it down.",
      up_sell:
        "The Clipper is the anchor of the Homie Collection - anytime someone buys the Trimmer or Shaver solo, this is the trade-up conversation. Lead with the lightweight/quiet comfort story, close with blade compatibility. At $69.95 salon, it's an easy yes for entry-level buyers who want real cordless performance without the pro price.",
      approved_pricing: "Salon: $69.95 Retail: $74.95",
    },
  },
  {
    productName: "Homie Nano Single Foil Shaver",
    sku: "SC817B",
    tier: "accessible",
    excerpts: {
      why_creating_item:
        "To add on to the Homie Collection. An accessible, pro-grade single foil shaver that brings finishing power to a wider audience - both at the chair and at home.",
      positioning_statement:
        "The StyleCraft Homie Nano Single Foil Shaver is the finishing move - at the chair or at home. The smallest, most accessible tool in the Homie Collection, it brings Gold Titanium Foil performance and Echo Cutter precision to anyone who wants a clean, close finish. Pro barbers reach for it as a lightweight add-on for sensitive skin cleanup. Everyday groomers reach for it because it fits in a pocket, charges with USB-C, and delivers results they'd normally pay more for. It's the tool that completes the collection and opens the door to a wider audience.",
      reason_to_buy:
        "GOLD TITANIUM FOIL + ECHO CUTTER - Premium foil material gentle on sensitive skin with an Echo Cutter that delivers audible feedback. Barbers and at-home users can feel and hear the difference. POCKET-SIZED MICRO DIMENSIONS - The most compact tool in the Homie Collection.",
      up_sell:
        "The Homie Shaver is a low-barrier, high-value add-on close for any barber or client already investing in the Homie Collection. At $29.95 salon / $34.95 retail, it practically sells itself. Lead with the Gold Titanium Foil and Echo Cutter story, then pivot immediately to the SC559B Replacement Foil Head as an automatic repeat purchase. That one conversation locks in a recurring revenue stream right at the point of sale.",
      expert_tip:
        "The Homie Nano performs best on short stubble and freshly trimmed areas. For longer growth, trim down first, then let the foil do the finishing work. The closer the starting point, the cleaner the result.",
      approved_pricing: "Salon: $24.95 Retail: $34.95",
    },
  },
  {
    productName: "StyleCraft Homie Shaver Single Foil Replacement Head",
    sku: "SC559B",
    tier: "accessory",
    excerpts: {
      why_creating_item: "Replacement foil and cutter for the Homie single foil shaver",
      positioning_statement:
        "The SC559B keeps the Homie Shaver performing like day one. A fresh Gold Titanium ultra-thin foil and Echo cutter restore the close, crisp finish the Homie is known for no drag, no tugging, no irritation. It's the easiest way to protect the tool and the results.",
      product_name_origin:
        "Carries the Homie name, rooted in loyalty, familiarity, and community. Established with the Homie Nano Clipper and carried through the full collection.",
      name_story_tie:
        "A homie always shows up. This is the SKU that keeps the Homie Shaver showing up, dependable maintenance that ties directly back to the collection ecosystem. Owning the shaver makes this purchase automatic.",
      features_full_list:
        "Gold Titanium ultra-thin foil head perfect for sensitive skin\nEasy snap-on installation, replaces in seconds with no tools.",
      reason_to_buy: "To maintain peak performance from your shaver",
      expert_tip: "Shaver is best used after trimmer or on short stubble",
      approved_pricing: "$9.95/$10.95",
    },
  },
  {
    productName: "S|C x 360 Jeezy Trimmer",
    sku: "SC423B",
    tier: "flagship",
    excerpts: {
      why_creating_item:
        "1. Consumer need - pros, stylists, and barber students needed a finishing tool that matched the clipper's performance standard\n2. Competitive gap - vector tools have historically been limited by build quality and run-time; the IN3 motor is the direct answer and a category first\n3. Identity & customization - pros want tools that reflect who they are behind the chair\n4. 360 Jeezy's credibility - peer-to-peer trust from one of the industry's most recognized barbers, not celebrity hype\n5. Complete system - positions the trimmer as the natural second half of the 360 Jeezy x StyleCraft lineup",
      positioning_statement:
        "Following the success of the original clipper collaboration, 360 Jeezy and StyleCraft set out to create the perfect companion tool. The goal was simple: build a trimmer that hits just as hard in performance, but dials in even tighter for detailing, lining, and finishing work. Every element was considered, from balance in hand to blade performance, to meet the real demands of daily barbering. This isn't just an add-on. It's the second half of a complete cutting system, designed by a barber who lives behind the chair.",
      product_name_origin:
        "The 360 Jeezy collaboration represents a full-circle approach to barbering, precision, consistency, and mastery from every angle. Just like a clean 360 wave pattern, every detail matters. This trimmer is built to reflect that same level of discipline and sharpness in every lineup.",
      name_story_tie:
        "The clipper laid the foundation. The trimmer finishes the job. Together, they represent the full system, bulk removal to final detail, executed with the same level of control and intention that defines 360 Jeezy's craft.",
      features_full_list:
        "Powered by the patented IN3 Vector Motor with intuitive torque control, engineered to deliver ultra-quiet performance, less vibration and longer-lasting battery efficiency.\nFixed Gold Titanium X-Pro Wide blade with \"The One\" black DLC Deep Tooth cutter delivers the crunchiest cuts and ultra-sharp lines.",
      reason_to_buy:
        "1. Our first-ever IN3 Vector Motor - up to 11,500 RPM, ultra-quiet performance, low vibration, and longer lasting battery efficiency with up to 3.5 hours of run-time\n2. Co-designed with one of the industry's most recognized barbers - 360 Jeezy's real input, not just a name on a box\n3. Precision that finishes the job - Gold X-Pro Wide + \"The One\" DLC cutter, completes the full cutting system with the clipper\n4. Full metal body - ultra-quiet performance, low vibration, premium build quality and durability that pros expect\n5. Customizable + built for the pro - interchangeable parts, up to 3.5 hours of run-time, USB-C charging",
      expert_tip:
        "The IN3 Vector Motor automatically adjusts torque based on the resistance it encounters - so the trimmer intuitively works harder through dense or coarse hair and eases up on finer areas without you doing a thing. Trust the motor and let it do the work. Keep the Gold X-Pro Wide blade oiled before and after every use to maintain sharpness and extend blade life. For the cleanest zero-gap lines, remove the drop top skeleton option to maximize blade visibility and precision around curves and edges.",
      up_sell:
        "360 Jeezy Clipper, any shaver with overstock or underperforming to complete the full set of clipper, trimmer and shaver. Clipper and trimmer grips and any accessories.",
      approved_pricing: "$259.95 / $269.95",
      // Marketing Direction section (GTM workbook export work, 4th filled
      // tab) — real excerpts from this SAME product's own filled Marketing
      // Direction sheet, colocated here rather than in a parallel exemplar
      // module (see lib/gtm-marketing-direction.ts's header comment for why).
      // Two fields from the real sheet (Content Ideas/Territories, Where
      // Should We Be Advertising) are deliberately OMITTED — the only source
      // text available for them was itself mid-sentence fragments, and
      // fabricating a completion would violate this corpus's own "never
      // invent, only real approved copy" rule.
      marketing_primary_goal:
        "Drive awareness, revenue, and retailer sell-in for the SC x 360 Jeezy Trimmer (SC423B); establish this as the go-to precision trimmer co-designed with one of the industry's most recognized barbers. Leveraging 360 Jeezy's presence and credibility to reinforce StyleCraft's position as the leading professional barbering brand.",
      marketing_success_kpis:
        "Revenue (sell-through at launch), ROAS on paid social/paid search, DTC traffic, engagement rate on barber community content, Amazon/Walmart sell-through, influencer earned media value from pro barber network. Initial sell-in and did we sell out?",
      marketing_launch_timing:
        "Marketing should kick off 2-4 weeks before in-market date; teaser content and influencer seeding with pro barbers should begin 4-6 weeks out. Embargo Strategy: Sample barbers early and instruct them NOT TO TALK ABOUT IT for the first X days. Build curiosity and buzz. 'What is that trimmer?' Then have all seeded barbers post and talk about it simultaneously on the reveal date.",
      marketing_core_audience:
        "Professional barbers and master barbers who follow respected figures in the barbering community. 360 Jeezy's audience. Barbers, barber students, and grooming enthusiasts who trust peer-to-peer recommendations from working pros. 25-45 male-skewing audience with deep investment in the craft.",
      marketing_secondary_audience:
        "Advanced home groomers and grooming enthusiasts who aspire to pro-level results; barber school students looking to invest in their first professional-grade trimmer; fans of barber culture content on social media; and stylists who want a precision trimmer that performs at a professional level and aligns with their personal brand behind the chair.",
      marketing_consumer_barrier:
        "Why is this trimmer worth the premium price? What does 360 Jeezy's co-sign actually mean for the product? Marketing must answer: this tool was designed with one of the industry's most recognized barbers, delivering ultra-quiet performance, low vibration, longer lasting battery efficiency with up to 3.5 hours of run-time, and the same great power.",
      marketing_messaging_direction:
        "Authentic, craft-first, community-rooted. Tone should feel like it comes from inside the barbershop. Respected, skilled, no-hype. Let 360 Jeezy speak to the tool from a barber's POV. Focus on the new IN3 motor and new customizable features. Reference: how barbers talk to each other about tools they trust. Avoid: celebrity hype tone, overly polished/corporate language, anything that feels inauthentic to the barber community.",
      marketing_product_name_origin:
        "Named in collaboration with 360 Jeezy, a professional barber known within the barbering community. The name and colorway (black, gold, red) reflect his personal aesthetic and professional identity. This is the trimmer companion to the SC x 360 Jeezy Clipper. A complete pro lineup built with his input.",
      marketing_visual_direction:
        "Primary: clean product-focused hero shots on dark backdrop highlighting gold blade, red grips, and full metal body. Secondary: in-barbershop action shots. 360 Jeezy using the trimmer on a real client, showing clean lines and precision. Lifestyle: behind-the-chair, craft-focused. Mood: professional, sharp, barbershop authentic. Avoid: overly staged/editorial looks disconnected from the shop.",
      marketing_languages: "English (primary). Spanish (secondary, for retail/DTC market reach). French Canadian",
      marketing_dos_donts:
        "DO: Let 360 Jeezy lead the story as a credible working barber; highlight IN3 motor tech and Gold X-Pro Wide blade performance; show real barbershop environments and real clients; use red/black/gold palette consistently; speak to pro barbers peer-to-peer. DON'T: Frame this as a celebrity/rapper collab; use language disconnected from barber culture; oversell as a consumer/retail product (pro-first); mix up clipper and trimmer messaging; use competitor brand names.",
      marketing_web_coverage:
        "Full PDP refresh on brand.com and Amazon for SC423B. Add to SC x 360 Jeezy product family page alongside the SC x 360 Jeezy Clipper. Cross-reference on clipper PDP as \"Also available: SC x 360 Jeezy Trimmer.\" Update category pages and buying guide where 360 Jeezy collab is featured.",
      marketing_print_material:
        "Spec sheet / sell sheet for sales team and external reps. Flyer for trade show and barber education events. Counter card or shelf talker for key retail/POS accounts. In-box co-branded 360 Jeezy barber collab insert card.",
      marketing_trade_show_launch:
        "Yes, if aligned with launch timing. Booth featuring SC423B alongside SC x 360 Jeezy Clipper as the complete pro collab lineup. 360 Jeezy appearance/demo opportunity if available.",
    },
  },
  {
    productName: "StyleCraft Arbitrage Clipper",
    sku: "SCMD631B",
    tier: "flagship",
    excerpts: {
      why_creating_item:
        "Barbers want to feel real performance change in their tool, not just another spec sheet claim. The Arbitrage answers that with a P.U.R.E. Outrunner Motor, new technology for StyleCraft, paired with Intuitive Torque Control that automatically adjusts power to resistance. It delivers serious power while running quiet and smooth in the hand.",
      positioning_statement:
        "The Arbitrage Clipper is built around a motor StyleCraft has never used before. The P.U.R.E. Outrunner Motor with Intuitive Torque Control gives barbers power that adjusts to the cut in real time, and does it while running remarkably quiet, backed by a DLC Echo blade, a heavy-duty full metal body, and up to 4 hours of run-time on a single charge.",
      product_name_origin: "Arbitrage - the edge gained by spotting an advantage before anyone else does.",
      name_story_tie:
        "Just like an arbitrage move captures an edge others haven't spotted yet, this clipper gives barbers access to motor technology StyleCraft hasn't put in a clipper before, an advantage in the chair before it becomes the standard everyone else is chasing.",
      new_technology:
        "YES. New P.U.R.E. Outrunner Motor. You can see the motor spinning inside the machine. This is the same type of motors that are in drones.",
      features_full_list:
        "P.U.R.E Permanent-Magnet Ultra Rotational Engine Outrunner Motor with Intuitive Torque Control runs up to 7,200 RPM to adjust for resistance.\nFixed premium DLC Echo blade and shallow tooth 2.0 cutter feeds hair more efficiently for a smoother, pull-free cut and an audible crunch.",
      up_sell: "Bundle with the Saber trimmer and Instinct shaver for a full behind the chair kit",
      reason_to_buy:
        "New technology for StyleCraft, with Intuitive Torque Control that automatically adjusts power through thick or resistant hair, all while running quiet with minimal vibration. Paired with a fixed DLC Echo blade for a smoother pull-free cut and a heavy-duty full metal body, in one cordless clipper that runs up to 4 hours on a single charge.",
      expert_tip:
        "Let the motor do the work. Intuitive Torque Control automatically pushes more power through thick or resistant hair, so you don't need to force the pass, and the outrunner design keeps it noticeably quieter in your hand while it does it.",
      approved_pricing: "Salon: $259.95 | Retail: $269.95",
      marketing_primary_goal:
        "Drive trial and revenue at launch. Build brand equity around the P.U.R.E. Outrunner Motor as a new, differentiated motor technology for StyleCraft, positioning the Arbitrage as a genuine step forward in cordless clipper performance.",
      marketing_success_kpis:
        "Sell-through rate, with sold out at launch as the 30-day health benchmark. Revenue at dealer and salon. Organic social engagement and barber creator UGC volume. Demo video views. Amazon BSR rank within 90 days of launch.",
      marketing_launch_timing:
        "Marketing should kick off aligned to sampling delivery, with barber creator seeding starting 4 to 6 weeks before the in-market date. Demo video and PDP go live day-of launch. Treat this as a coordinated launch event, not a quiet lineup addition.",
      marketing_core_audience:
        "Professional barbers, full-time and high-volume, who are actively upgrading their tool lineup. They're performance-driven, follow barber culture on social, and pay attention to real motor and blade technology rather than marketing claims. They want to feel like they're cutting with something genuinely new.",
      marketing_secondary_audience:
        "Mobile barbers and independent suite owners who need reliable cordless performance outside a fixed station. Barbering students and recent grads making a first pro clipper investment. Barber supply retailers and distributors evaluating new SKUs to carry.",
      marketing_consumer_barrier:
        "Barbers have heard 'powerful motor' before and tune it out. Marketing needs to make the P.U.R.E. Outrunner Motor feel like a real technological step forward, not another spec sheet claim, by showing what the motor actually does differently in the cut.",
      marketing_messaging_direction:
        "Confident, sharp, technically credible. Speaks like a barber who's genuinely impressed by what's under the hood, not someone selling a deal. Lead with the P.U.R.E. Outrunner Motor as new ground for StyleCraft, and let Intuitive Torque Control and the quiet, vibration-free feel carry the proof.",
      marketing_product_name_origin:
        "Arbitrage - taking advantage of an edge others haven't found yet. Here, that edge is the motor: new outrunner technology StyleCraft hasn't used before, giving barbers a genuine performance advantage.",
      marketing_visual_direction:
        "In-salon, behind-the-chair demo content leading the mix, showing the motor working through resistance in real cuts. Supplement with tight product-focused shots highlighting the full metal body and blade. Avoid overly staged lifestyle imagery; keep it grounded in the shop.",
      marketing_content_ideas:
        "Demo-first content showing the torque control adjusting to thick or resistant hair in real time. Side-by-side quiet-operation comparisons against louder competitor motors. Barber creator 'first cut' reaction content focused on how quiet and controlled the motor feels. Behind-the-build content on the outrunner motor and blade.",
      marketing_languages: "English, Spanish",
      marketing_dos_donts:
        "DO lead with the motor as new technology for StyleCraft. DO make the torque control tangible and demonstrable. DO NOT frame this around price or value positioning. DO NOT overclaim the motor as first-of-its-kind in the market; it's new to barber tools and new to StyleCraft, not new to market overall. DO NOT use em dashes in any copy.",
      marketing_trade_show_launch: "If the timing aligns, yes",
    },
  },
  {
    productName: "Saber Trimmer — Orange",
    sku: "SC421O",
    tier: "flagship",
    excerpts: {
      why_creating_item:
        "The Saber Trimmer is the benchmark barbers measure other trimmers against. It already exists and already performs. This is updated content for a new color, extending the Saber lineup with a finish that matches how barbers want their station to look.",
      positioning_statement:
        "The Saber Trimmer sets the standard for detail work in modern barbering, pairing the highest torque with the lowest vibration for laser lines and clean perimeters. Now finished in orange for the barbers who treat their tools as part of their signature.",
      product_name_origin:
        "Inspired by the saber-toothed tiger, the Saber embodies raw power and calculated precision. An apex predator in its time, this trimmer carries that legacy, built to perform at the highest level.",
      name_story_tie:
        "The Saber name is built on precision under power. The trimmer is where that precision is most visible, in the line, the edge, and the perimeter. Orange brings that predator energy forward in a way the original finishes could not. In a craft that is always evolving, the Saber is a tool built for those who lead, not follow.",
      features_full_list:
        "Fixed black DLC X-Pro Wide blade and \"The One\" deep tooth cutter\nLong-life digital brushless motor runs up to 7,200 RPM",
      up_sell:
        "Sell the pair. A barber buying the orange Saber 2 Clipper is the same barber who wants the matching orange trimmer on the station. Lead with the set, not the single tool.",
      reason_to_buy:
        "Highest torque, lowest vibration. The X-Pro Wide blade with \"The One\" cutter edges up with laser lines and blasts through bulk, and the full metal body holds steady through a full book of clients.",
      expert_tip:
        "Set the blade flat to the skin for the perimeter, then roll the trimmer 10 to 15 degrees and flick out to erase bulk lines without over etching. Keep the blade cool and lightly oiled between clients so the crunch stays crisp.",
      approved_pricing: "Salon $199.95 / Retail $209.95",
      // Product FAQ section — real our_differentiators/selling_position/
      // rep_talking_point content, not present in any exemplar before this one.
      our_differentiators:
        "Highest torque and lowest vibration in its class, in a full metal body that weighs almost nothing. The X-Pro Wide blade paired with \"The One\" cutter delivers the audible crunch barbers recognize, and zero gaps with the included setter for the closest possible finish. The skeleton-style axis keeps the sightline open for detail work other trimmers block. Backed by a 1 year warranty.",
      selling_position:
        "The Saber Trimmer is the benchmark barbers measure other trimmers against. High torque, low vibration, full metal, and a blade combination built for laser lines and bulk in the same pass. Now available in orange, the same tool barbers already trust, in a finish that stands out on any station.",
      rep_talking_point_1:
        "Digital brushless motor at 7,200 RPM. Highest torque, lowest vibration. It runs cooler, cuts smoother, and lasts over 1,000 hours of motor life. Barbers feel the difference in the wrist by the end of a full day.",
      rep_talking_point_2:
        "Black DLC X-Pro Wide blade with \"The One\" deep tooth cutter. It edges up with laser lines and blasts through bulk without switching tools. Zero gaps with the setter that comes assembled in the box, for the closest finish possible.",
      rep_talking_point_3:
        "Full metal body at 3.5 ounces. Heavy-duty enough to dampen noise and absorb vibration, light enough to run all day without fatigue, and the skeleton-style axis keeps the sightline wide open for detail work. This is a tool built for how barbers actually work.",
      marketing_primary_goal:
        "Drive revenue and retailer sell-in, and drive attach rate to the SC617O Saber 2 Clipper in Orange. Expand the Saber collection footprint with a colorway that creates urgency among barbers who lead with personality.",
      marketing_success_kpis:
        "Revenue (primary). Attach rate to SC617O. ROAS on paid social and Amazon. Amazon PDP conversion rate. Email open rate and CTR. Distributor sell-in units. Social engagement rate including reach, saves, and shares.",
      marketing_launch_timing:
        "Kick off 4 weeks ahead of launch. If the orange clipper and trimmer launch together, run one campaign with the set as the hero rather than two separate product pushes.",
      marketing_core_audience:
        "Barbers aged 22 to 45 who view their tools as an extension of their brand identity. Performance-driven, brand-loyal, and culturally connected. Detail-focused, since the trimmer is where their line work gets judged. Primarily male, based in independent shops and suites. Many already own a Saber Trimmer in black or white.",
      marketing_secondary_audience:
        "Aspiring barbers and cosmetology students building a first pro kit. Gift buyers shopping for a barber during Q4 holiday season. Existing Saber 2 Clipper owners who want the matching trimmer.",
      marketing_consumer_barrier:
        "For existing Saber Trimmer owners: I already have this, why do I need another. Frame the orange as a collectible, expressive tool that signals identity on the station. For new buyers: performance parity with the black and white has to be explicit.",
      marketing_messaging_direction:
        "Tone is bold, proud, unapologetic. The barbers who choose orange are not blending in, they are showing up. Lean into tool identity and personal brand, and into the trimmer specifically as the tool that finishes the work. Avoid generic now available in orange language. Lead with personality, back it with performance.",
      marketing_product_name_origin:
        "Orange is the color of energy, fire, and dominance, an apex predator at full force. The Saber is already named for the saber-toothed tiger. Orange brings that predator energy to life in a way the original finishes could not.",
      marketing_visual_direction:
        "Product-focused studio shots on dark backgrounds with the orange as hero. Macro on the blade and the line it leaves. In-hand shots in real barbershops, mid-detail. The trimmer is a precision tool, so the creative should show precision, not just the object. Set shots pairing it with the orange Saber 2 Clipper. Real barbers, real shops.",
      marketing_content_ideas:
        "Line work close-ups and edge-up ASMR using the orange SKU. Side-by-side colorway lineup content. The full orange setup, clipper and trimmer together on station. What your tools say about you social series. Unboxing and first-look content for influencer seeding.",
      marketing_languages: "English primary. Spanish and French Canadian",
      marketing_dos_donts:
        "DO lead with barber identity and personal brand. DO hero the orange against dark backgrounds. DO show line work and detail results, not just the tool. DO merchandise it with the orange Saber 2 Clipper as a set. DO cite specs where they validate the tool for new buyers. DON'T position orange as secondary or lesser than the black or white. DON'T use generic now available in a new color messaging. DON'T show home or bathroom settings. DON'T name or compare to competitor brands. DON'T use professional as a standalone descriptor.",
    },
  },
  {
    productName: "Saber II Clipper — Orange",
    sku: "SC617O",
    tier: "flagship",
    excerpts: {
      why_creating_item:
        "There's a reason the Saber 2 is our best seller, it outperforms everything else in its class. From raw cutting power to dialed-in precision, this is the clipper barbers depend on when average isn't an option. It's the best clipper in barbering. Period. Now available in a new color.",
      positioning_statement:
        "The Saber 2 defines the standard for modern barbering, combining elite cutting power with refined control to deliver unmatched performance in every environment.",
      product_name_origin:
        "Inspired by the saber-toothed tiger, the Saber 2 embodies raw power and calculated precision. An apex predator in its time, this clipper carries that legacy, built to perform at the highest level.",
      name_story_tie:
        "The Saber 2 represents evolution in motion. Inspired by the saber-toothed tiger, an apex predator that defined its era, this clipper carries that same legacy of dominance, precision, and control. In a craft that's always evolving, the Saber 2 stands as a tool built for those who lead, not follow.",
      features_full_list:
        "Fixed DLC Echo Blade & Shallow Tooth 2.0 Cutter\nEON Digital Brushless Motor runs at up to 7,200 rpm",
      up_sell:
        "Trade up barbers who already own an older Saber or a competitor clipper. The motor and blade are the upgrade story, the orange finish is the conversation starter that gets them to pick it up.",
      reason_to_buy:
        "Quiet. Strong. Ergonomic. The Saber 2, paired with the Echo blade and the audible crunch feedback every barber knows and loves.",
      expert_tip:
        "Keep your clipper blades cool, clean, and lightly oiled during and after every service. Heat buildup and hair debris are the fastest ways to reduce cutting performance and shorten blade life.",
      approved_pricing: "Salon: $299.95 Retail: $319.95",
      our_differentiators:
        "The only clipper in its class pairing the EON Digital Brushless Motor with the DLC Echo blade for audible crunch feedback. Full metal body with modular magnetic drop-tops, so barbers get a premium feel and still clean it in seconds. Tight and stretch taper bracket kits plus a floating lever make the taper genuinely customizable. Best seller status in the Saber lineup, backed by a 1 year warranty.",
      selling_position:
        "The Saber 2 is the best clipper in barbering, period. Inspired by the apex predator that defined its era, it combines elite cutting power with refined control. Now available in orange, it is the same dominant performance barbers depend on, in a colorway that stands out in any shop.",
      rep_talking_point_1:
        "EON Digital Brushless Motor, 7,200 RPM. The Saber 2 runs up to 7,200 RPM of quiet, consistent power. It does not bog down, it does not overheat, and it does not quit. This is the motor barbers trust when they cannot afford a bad cut.",
      rep_talking_point_2:
        "DLC Echo blade with Shallow Tooth 2.0 cutter. The DLC Echo fixed blade gives you that audible crunch every barber knows and loves, paired with the Shallow Tooth 2.0 cutter for a smoother cut with zero pulling. It is a blade combo built for precision, and it can be zero gapped for the closest finish possible.",
      rep_talking_point_3:
        "Heavy-duty full metal body with modular drop-tops. The Saber 2 is built like a tank, dampens noise and absorbs vibration, and it is still modular. The removable magnetic drop-tops make cleaning effortless, and the tight or stretch taper bracket kits let barbers customize their taper on the fly. This clipper adapts to how you work.",
      marketing_primary_goal:
        "Drive revenue and retailer sell-in. Expand the Saber II collection footprint with a high-demand colorway that creates urgency among pro barbers who lead with personality. Secondary goal is to grow new-to-brand awareness through bold visual identity.",
      marketing_success_kpis:
        "Revenue (primary); ROAS (paid social + Amazon); Amazon PDP conversion rate; email open rate + CTR; distributor sell-in units; social engagement rate (reach, saves, shares).",
      marketing_launch_timing:
        "Marketing kick-off: 4 weeks prior to Q4 2026 launch date (approx. early September 2026). Pre-launch teaser phase begins T-4 weeks. Full channel activation at launch week. Sustain phase runs 8 weeks post-launch.",
      marketing_core_audience:
        "Barbers aged 22 to 45 who treat their tools as an extension of their brand identity. Performance-driven, brand-loyal, and culturally connected. They follow other barbers on social, care about how their setup looks, and invest in tools that reflect their craft. Primarily male, working out of independent shops and suites. Most are already aware of or running the Saber 2 in black.",
      marketing_secondary_audience:
        "Aspiring barbers and cosmetology students who follow barber culture and want to build their professional kit. Gift buyers shopping for a professional barber during holiday season (Q4 timing). Style-forward consumers who want a premium clipper with standout aesthetics.",
      marketing_consumer_barrier:
        "For existing Saber 2 owners: I already have the Saber 2, so why do I need this? Marketing must reinforce that this is a collectible, expressive tool that signals identity and craft in the chair. For new buyers: must communicate performance parity with the original black SKU so the color never reads as a step down in quality.",
      marketing_messaging_direction:
        "Bold, proud, and unapologetic. Barbers who choose orange are not blending in, they are showing up. Lean into tool identity and personal brand. Skip generic \"Now available in orange\" language. Lead with personality, back it with performance.",
      marketing_product_name_origin:
        "Orange is the color of energy, fire, and dominance, the look of an apex predator at full force. The Saber 2 is already named after the saber-toothed tiger. Orange brings that predator energy to life in a way the original black colorway could not. This is the Saber in its element.",
      marketing_visual_direction:
        "Product-focused studio shots against dark or black backgrounds with the orange as the hero. In-hand shots in real barbershop environments. Lifestyle content showing the full setup, with the orange clipper on station and in hand mid cut. Close-up texture on the all-metal body and the orange lever and accents. Avoid overly clinical or sterile product-only imagery. Real barbers, real shops.",
      marketing_content_ideas:
        "Reveal content: \"Something new is coming to the Saber collection\" teaser. Side-by-side colorway lineup content featuring the Saber family in black, white, and orange. ASMR clipper cut content using the orange SKU. \"What your clipper color says about you\" social series. Barber identity content built around tool setups with the orange as the focal point. Unboxing and first-look content for influencer seeding.",
      marketing_languages: "English (primary). Spanish & French Canadian, strong barber market overlap with Spanish-speaking professionals in the US.",
      marketing_dos_donts:
        "DO: Lead with barber identity and personal brand story. Hero the orange colorway against dark backgrounds. Use real barbers and real shop environments. Reference the Saber collection (Black, White, Gold, Orange) to position it as a lineup. Reference performance specs when relevant to validate the tool for new buyers. DON'T: Position the orange SKU as secondary or lesser to the original black. Avoid generic \"now available in a new color\" messaging. Don't show it in domestic or home bathroom settings. Don't lead with specs alone. Emotion and identity come first.",
      marketing_web_coverage:
        "PDP page (Amazon, DTC/Brand.com, Walmart) — hero images, A+ content module, feature bullet copy. Brand storefront update on Amazon and Walmart.",
    },
  },
];

// Field ids the corpus actually has calibration text for — used by
// lib/gtm-generate.ts to decide whether a given chunk of fields should get
// the (token-costly) exemplar block attached at all.
export const STYLE_EXEMPLAR_FIELD_IDS = new Set(
  GTM_STYLE_EXEMPLARS.flatMap(ex => Object.keys(ex.excerpts))
);

// Renders the corpus block for the system prompt — only the fields present
// in `fieldIds` are shown per exemplar, so a chunk asking about
// `expert_tip` doesn't drag in unrelated positioning-statement text from
// all 4 products.
export function renderStyleExemplarBlock(fieldIds: string[]): string {
  const relevant = fieldIds.filter(id => STYLE_EXEMPLAR_FIELD_IDS.has(id));
  if (relevant.length === 0) return "";

  const sections = GTM_STYLE_EXEMPLARS.map(ex => {
    const lines = relevant
      .map(id => (ex.excerpts[id] ? `  ${id}: ${ex.excerpts[id]}` : null))
      .filter(Boolean)
      .join("\n");
    if (!lines) return null;
    return `[${ex.productName} (${ex.sku}) — ${ex.tier} tier]\n${lines}`;
  }).filter(Boolean);

  if (sections.length === 0) return "";

  return `\n\nSTYLE EXEMPLARS (real, approved GTM sheets for OTHER products — depth/format/voice reference ONLY):\n${sections.join("\n\n")}\n\n${STANDING_ANTI_COPY_WARNING}`;
}
