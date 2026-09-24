# SecondLook — what's left

Ordered by value. Do them one at a time, verify in the browser after each,
and stop when time runs out rather than leaving something half-done.

Read CONTEXT.md first.

---

## 1. Clean up the background catalogue (accuracy)

**Why.** The 250 seeded rows still carry randomly generated titles. On the
H&M knitwear page, 6 of 10 local results are filler. Gemini removes them, so
the demo survives, but Local mode looks worse than the matcher actually is,
and the toggle's Local side is what a judge sees first when you make the
point about what AI adds.

**Prompt:**

```
Improve the 250 background rows in the catalogue. Do not touch the 40
hand-written demo rows in tools/demo-listings.json.

Right now the background rows carry randomly generated titles that don't
correspond to plausible garments, so they surface as obvious filler in
positions 4-10 of Local mode.

Rewrite them so each row is a plausible real listing for its category, brand
and colour: a title a real seller would write, consistent with the row's
structured fields. Keep the existing realism conventions — inconsistent
capitalisation, some French, sizes written different ways, brand sometimes
missing from the title. Keep the same 290 total and the same category
distribution.

The goal is that a filler result looks like a reasonable near-miss rather
than noise, so Local mode is defensible on its own.

Then rebuild and re-run:
- node tests/score-quality.mjs — recall@1 and MRR must not regress
- node tests/ab-demo.mjs — report the new filler counts per page

Tell me whether the H&M brossée page still has the highest headroom, and if
a different page now differs most between Local and AI, say which.
```

---

## 2. Vision extraction (biggest AI upgrade)

**Why.** Extraction is the weakest part of the build and you know it: Zara
and Mango emit no JSON-LD, colour is scraped from `document.title` text, and
gender is unknown on three of eight demo pages. Sending the product photo to
Gemini removes all of that in one move, and it's the answer to "how would
this work on a retailer you haven't hand-coded."

**Prompt:**

```
Add Gemini vision extraction as a signal source.

When a product page is detected, send the main product image to
gemini-3.6-flash with a structured prompt asking for: garment type, primary
colour, apparent material, cut/fit, and apparent gender cut. Return strict
JSON with a per-field confidence.

Rules:
- This SUPPLEMENTS the existing extractor, it does not replace it. Structured
  sources (JSON-LD, og: tags) still win where they exist. Vision fills the
  fields those leave unknown, and breaks ties on low-confidence text reads.
- Never block first paint. Local results render from text extraction
  immediately; vision refines and re-ranks when it lands, same as the Gemini
  verification pass does today.
- Budget: this is a second call per product against a 5-15 rpm free tier.
  Share the rate limiter and the per-product cache with the verification
  call. If either would exceed the budget, skip vision, not verification.
- Show it in the debug strip: which fields came from vision, and its timing.
- On any failure, fall back silently.

Then walk all eight demo pages and report, per page: which fields vision
filled that text extraction had left unknown, and whether the top result
changed.
```

---

## 3. AI-generated marketplace queries

**Why.** Links currently go to brand-plus-garment searches with no colour,
because colour empties the results page. It works but it's crude, and a judge
who clicks will see loosely related results. A model can pick the phrasing
that actually performs on each marketplace, in the right language.

**Prompt:**

```
Replace the hardcoded marketplace search URL pattern with a generated one.

For each result card, ask Gemini to produce the search string most likely to
return relevant results on that specific marketplace for that specific
garment. Account for: Vinted and Leboncoin behaving differently, French vs
English listing vocabulary, and which attributes to include or drop so the
results page isn't empty.

Do this in the SAME Gemini call as the verification pass — add the field to
the existing response schema. Do not add a third call.

Fall back to the current pattern on any failure.

Then load all five marketplace patterns in a real browser and report how many
results each returns for the Zara wool coat and the H&M brossée jumper,
before and after.
```

---

## 4. The sell-side tab (only if there's a clear evening free)

**Why.** This is the differentiator. Every resale aggregator helps you buy.
None of them put supply back. It also answers the hardest Q&A question: does
making second-hand easier reduce waste, or just add a cheaper way to consume?

**Prompt:**

```
Add a second tab to the panel: "Sell".

Flow:
- Read the user's order history from the retailer's own site where available.
  For the demo, seed a realistic fake order history in a fixture file and use
  that — do not block on real account access.
- Show items the user bought more than ~9 months ago as candidates to list.
- On selecting one, call Gemini to generate a complete Vinted listing: title
  in the right idiom, description, suggested category, and a suggested price
  anchored to comparable listings in our catalogue.
- Show the generated listing in a card with a copy button.

Keep it visually consistent with the Buy tab. Same rate limiter, same cache,
same silent fallback.

This is a demo feature: the fake history must look plausible on screen and
the generated listing must be good enough to read aloud.
```

---

## 5. Demo safety (do this regardless, the night before)

**Prompt:**

```
Final pass before the pitch:

1. Demo mode toggle in settings that forces a frozen known-good result set
   for the eight demo pages, bypassing live matching and Gemini entirely.
2. Re-run node tests/demo-pages.mjs and tell me if any of the eight retail
   URLs have rotated. If one has, fix the slug in tools/demo-listings.json
   and rebuild.
3. Confirm both disabled states still render correctly: no API key, and rate
   limited. Neither may ever produce an empty panel.
4. Give me the exact click sequence for a two-minute demo on the H&M brossée
   page, including where to pause for the toggle.
```

---

## Rate limit warning

Free tier is 5 to 15 requests a minute. Each new AI feature adds calls per
product page. Do not click through more than three or four product pages in
the ten minutes before you present, or you'll hit the limit on stage and the
toggle's AI side will disable itself.

## Things deliberately not on this list

- Natural language filtering in the panel. Demos for four seconds, adds
  nothing to the argument.
- Expanding to more retail sites. Eight pages is enough and each new site is
  a new extraction edge case.
- Item-level deep links. Needs affiliate access, can't be faked honestly.
