# SecondLook — project context

Read this before writing any code. `CONTEXT.pre-extension.md` is the earlier
snapshot from before the extension existed, kept for reference only — nothing
in it describes how SecondLook works now.

## What this is

A Chrome extension that detects the garment a user is viewing on a retail
site and surfaces second-hand alternatives from resale marketplaces.

Built for an AI hackathon at HEC Paris on waste-fighting, run with Phenix.
This is a **demo MVP**. A convincing, reliable six-minute demo beats
completeness. Anything that can fail live on stage is worse than a missing
feature.

## Repo layout

```
resale-data/          # data + matching engine
SecondLook/           # the Chrome extension
prototype.html        # original visual spec for the panel
```

## Current state — working

- Side panel via `chrome.sidePanel`, opens from the toolbar icon
- Extraction across Zara, H&M, Mango (plus Uniqlo, ASOS, Amazon, Nike
  registered), reading the **selected colourway** rather than the first one
- Local ranking: category hard filter, then IDF cosine on titles plus brand,
  colour, material and gender signals
- Gemini re-ranking live on `gemini-3.6-flash`
- Local / AI-verified toggle in the panel header, instant switch
- Impact footer, per category, sourced from impactco2.fr
- Benchmark: recall@1 10/10, recall@3 10/10, MRR 1.000
- ~640 KB unpacked, cold worker ~3.4 ms

## The matching pipeline

In `lib/score.js`:

1. **Hard filter on category** via `lib/taxonomy.js`. If the page doesn't map,
   or the category is empty, return `[]` — no widening, no cross-category
   backfill. The panel shows "No second-hand match in this category yet."
2. **IDF-weighted cosine** over the two titles (weight 1.00). IDF computed
   over corpus titles at load.
3. **Brand** exact match (0.35). Scored, not filtered — an ASOS page can
   still rank Zara coats sensibly.
4. **Colour** via `COLOUR_NEIGHBOURS` (0.30), scaled by extraction confidence.
5. **Material** partial credit for a shared fibre word (0.15).
6. **Gender** penalty on known mismatch only (0.20). Never a gate. Unknown
   costs nothing.
7. Relative ranking, **no absolute threshold**. Always returns 10.

Then `lib/gemini.js` re-ranks: classifies each candidate as EXACT_MATCH,
SAME_MODEL_DIFFERENT_COLOUR, CLOSE_ALTERNATIVE or NOT_RELEVANT with a
confidence and a 12-word reason. Drops NOT_RELEVANT, sorts by type then
confidence.

## Extraction — what the live sites actually serve

Hard-won, do not regress:

- **Zara emits no JSON-LD at all.** Only `og:` tags. No price meta, no brand
  meta, no gender anywhere in URL or DOM. Colour lives in `document.title` —
  but see the selected-variant rule below, because that title goes stale.
- **H&M emits `ProductGroup`, not `Product`**, with real fields on the group
  and bare variants underneath. `og:type` is `"website"`. It does publish
  `audience.suggestedGender`. **The group carries no `color` of its own** —
  colour lives only on the variants, and there can be 185 of them.
- **Mango emits no JSON-LD either**, `og:type` is `"article"`, no price meta.
  Colour appears as a text line under "Choisissez une couleur".

Extractor order: JSON-LD (walking `ProductGroup`), then `og:` tags, then
rendered page text, then `document.title`. `sources` in the debug strip says
which tier fired. **Colour is the exception** — it has its own order, below,
and `document.title` comes last in it rather than first-available.

**Zara's WOMAN/MAN/KIDS nav tabs are deliberately ignored.** All three carry
`aria-selected="true"` on WOMAN even on men's product pages. Reading them
would label every Zara page women's, which is worse than unknown. Breadcrumbs
are used (they describe the product); nav tabs are not (they describe the
site).

### Read the SELECTED colourway, never the first one

`content/variant.js` (a classic content script, loaded **before**
`content/extract.js` — MV3 has no declarative ESM content scripts). Pure
functions over plain data, so `tests/variant-colour.mjs` drives the same code
with no browser.

No single source works on all three sites, and the order is measured:

| | url-matched JSON-LD variant | selected swatch | rendered label | title slot |
|---|---|---|---|---|
| H&M | ✅ `sku` = `<group><colour><size>` | ✅ `aria-checked` | ✅ `COULEURS:` | ✅ |
| Zara | ✗ no JSON-LD | ✅ `aria-current` | ✗ | ⚠️ **stale** |
| Mango | ✗ no JSON-LD | ✗ selected one unmarked | ✅ | ✗ no colour in title |

- **H&M — the URL's article code.** `productpage.1309974005` matches variant
  skus starting `1309974005`. The only thing that can separate 185 variants.
- **Zara — the selected swatch.** `document.title` is right on a cold load and
  **does not update on an in-page colourway switch**: after clicking Charcoal
  the URL gained `?v1=545461699` and the swatch read "Charcoal" while the title
  still said "Mid-blue", nine seconds later. The swatch was right in both
  states. This is why the title is now a LAST resort.
- **Mango — the rendered label.** Nothing else exists: its swatches are plain
  links with no selected marker. But a colourway switch is a full navigation
  (`/37047884/57/00` → `/99/00`) so the label re-renders. 57 → "Bleu nuit",
  99 → "Noir".

`lib/normalise.js` owns the priority: variant → swatch → label → title slot →
low-confidence text. When a variant cannot be resolved **unambiguously** the
colour is left `null`, never guessed — unknown is a zero adjustment in
`lib/score.js`, wrong actively promotes the wrong listing.

**The bug this replaced, so nobody reintroduces it:** `readJsonLd` took
`hasVariant[0]` and merged it under the group. With no `color` on the group,
the first variant's colour survived. All three H&M demo pages were wrong,
including the stage page — 1341516004 reported "Beige clair chiné" instead of
"Bleu foncé"; 1309974005 reported "Noir" instead of "Bleu denim". The title
slot still carries the guard it always had (must start with the product name,
first ` - ` segment that isn't a gender word); it just no longer decides.

`name_en` in `lib/normalise.js` was hardcoded `null`. It now carries the
resolved subcategory — the corpus's own English garment vocabulary — because
token overlap does not translate, so a French page scored exactly zero against
every English listing. Resolved from the product NAME alone, not the five
sources `garment` uses: feeding it into the token channel gives the
subcategory guess teeth it did not have, and the weak sources are where the
bad guesses come from.

## Gemini config

- Model: **`gemini-3.6-flash`**, defined once as `DEFAULT_MODEL` in
  `background.js` and overridable from the Options page. (An earlier note here
  said 3.8 "doesn't exist" — Google's current docs do use `gemini-3.8-flash`
  in their own examples, so treat that as unverified rather than settled. 3.6
  is the deliberate choice, not a workaround.)
- **`chrome.storage.local` outranks every default in the source**, so changing
  the constant is not enough on a profile that has already run SecondLook.
  `getSettings()` treats a stored `gemini-3.8-flash` — this code's old default,
  never a user's choice — as unset, and the Options page says what it replaced.
  A model you actually typed, including `gemini-2.5-flash`, is left alone.
- Key lives in extension storage via the Options page, not in `config.local.js`.
- **Thinking config must be nested, and its enum is upper-case.** The v1beta
  discovery document gives `GenerationConfig` no `thinkingLevel` property at
  all; the only thinking field is `thinkingConfig`, and `thinkingLevel` takes
  `MINIMAL | LOW | MEDIUM | HIGH`. So: `thinkingConfig.thinkingLevel:
  "MINIMAL"` for `gemini-3.*`, `thinkingConfig.thinkingBudget: 0` for
  `gemini-2.5.*`, neither for anything else — the API errors on the wrong one.
- `maxOutputTokens` is **8192** and thought tokens are charged against it, so
  it is a thinking budget as much as an answer budget.
- On a 400 about a knob the call walks a named ladder — `full` → `no-schema`
  (schema dropped, **thinking still pinned**) → `bare` — and records
  `rungUsed` in the debug dump.

  This ladder is the fix for a real outage. The request used to send
  `{ thinkingLevel: 'low' }` at the top level of `generationConfig`: an unknown
  field *and* a lower-case enum name. The 400 it earned fell back to a request
  with thinking un-pinned under a 2048-token ceiling, Gemini 3's default
  thinking ate the budget, and the truncated output surfaced on every page as
  "AI unavailable — model did not return a JSON array". The parser was never
  the problem; do not loosen it.

  **Not yet confirmed against a live key.** The wrong field placement and the
  bad enum name are proven from the discovery document; the chain from there to
  the truncated output is inferred, not observed. One run of `gemini-live.mjs`
  settles it.
- `GEMINI_API_KEY=... node tests/gemini-live.mjs --compare-shapes` makes one
  real call and prints the raw body, `finishReason` and `usageMetadata` beside
  both request shapes. Everything else in `tests/` stubs the network.
- Free tier: **measured at 5 rpm on the demo key**, not the 5-15 the docs
  suggest. A recording run at 5s spacing was rate limited with `limit: 5` in
  the 429 body. There is a 3s floor between calls in the extension and a
  per-product verdict cache; `tools/build-demo-freeze.mjs` spaces its calls
  15s apart and backs off on 429 and 503.
- **A `(cached)` marker in the debug strip means no live call was made.**
  A timing (`in 912ms`) means a live call succeeded.
- Every failure path falls back silently to local ranking. The panel never
  empties and never shows a spinner that doesn't resolve.

## Catalogue

290 listings in `data/listings.json`:
- 40 hand-written across 8 demo pages (`tools/demo-listings.json`)
- 250 seeded rows remapped onto flat categories, kept as background noise so
  the demo rows win on merit rather than by being alone

Categories are **flat**: Denim, Knitwear, Outerwear, T-Shirts. No gender in
the category string.

Images: 290 bundled SVG tiles in `images/` — solid block in the listing's
colour, brand at top, garment type and colour at bottom. Nothing fetches.

Links: every `listing_url` is a marketplace **search** URL (brand plus
garment, no colour — adding colour empties the results page). Never an
invented item id; those 404'd.

`node tools/build-catalogue.mjs` rebuilds everything.

## Known weaknesses — say these before a judge finds them

- The catalogue is hand-seeded. The eBay Browse API fetcher is live in the
  repo; production would run on marketplace affiliate feeds.
- Links land on search results pages, not the specific item. Item-level deep
  links need affiliate access.
- Gender resolves on 5 of 8 demo pages. The three Zara pages stay unknown.
- Token overlap still does not translate in ONE direction. `name_en` fixed
  French-page-to-English-listing; an English page still scores zero against a
  French listing, so a good match like "Camel Long Manteau | Zara Basic" reads
  as filler on the Zara coat page. The symmetric fix would be a `name_fr`.
- The 250 background titles were topped up so none reads as noise: every one
  now names its garment and at least two of brand / colour / material, and the
  whitespace and ellipsis artefacts are gone. Three are deliberately still
  thin — ls-0034, ls-0115, ls-0134 — because `targets.json` scores against
  them and rewriting a benchmark's answer key is how it stops meaning
  anything. `node rewrite-titles.js` in `resale-data/` is idempotent.
- What still looks like filler in positions 4+ is mostly the hand-written demo
  rows and genuine cross-language misses, NOT bad seeded titles. Do not
  "fix" the catalogue again expecting the filler count to move.
- Water figures for Knitwear and Outerwear are estimates, labelled as such.
  ADEME publishes water for cotton t-shirts and jeans, not wool.

## Demo pages

Eight fixtures in `tests/demo-pages.data.mjs` (nine entries — the Zara flare
jeans appear twice, one per colourway, sharing a URL).

**`tests/demo-pages.mjs` does NOT check the URLs.** It stubs `fetch` and only
re-runs the matching against the stored payloads, so it passes happily on a
product that was delisted months ago. This file used to say to run it the
morning of the pitch to catch rotation; that was false comfort.

`node tests/demo-urls.mjs` is the real check, and it is honest about its own
limits: Mango server-renders `og:title` so rotation is detectable, Zara is a
client-rendered SPA that returns 200 with no title for a URL that has never
existed, and H&M 403s a plain fetch whether the product is real or not. It
prints the six it cannot judge so they can be opened in a browser.

All eight were confirmed live in a browser on 13 Sep 2026.

### Stage page: Zara — Purl Knit Quarter-Zip Jumper (`p03332310`)

**Changed on 14 Sep 2026, and the reason is worth keeping.**

It used to be the H&M brossée page, picked when `tests/ab-demo.mjs` headroom
was the only number available. Headroom is a PREDICTION — the count of rows
with `tokens < 0.1` — and once the AI pass was recorded against the real model
it turned out to predict the wrong thing. brossée removes **nothing**: it keeps
all ten and reorders seven. "The AI strips the filler" was never true there.

Measured from `data/demo-freeze.json` (9 recorded, `gemini-3.6-flash`), by
removals then reordering:

| page | category | pool | removed | reordered |
|---|---|---|---|---|
| H&M — Regular Jeans | Denim | **10** | 4 | 5 |
| Zara — Flare Fit Jeans (Charcoal) | Denim | **10** | 4 | 4 |
| **Zara — Purl Knit Quarter-Zip** | Knitwear | **109** | **4** | **3** |
| Mango — T-shirt 100 % coton | T-Shirts | **10** | 3 | 2 |
| Zara — Flare Fit Jeans (Mid-blue) | Denim | **10** | 2 | 4 |
| Mango — Manteau laine croisé | Outerwear | 161 | 1 | 7 |
| Zara — Relaxed Fit Wool Blend Coat | Outerwear | 161 | 1 | 6 |
| H&M — T-shirt interlock | T-Shirts | **10** | 1 | 4 |
| H&M — brossée | Knitwear | 109 | **0** | 7 |

H&M Regular Jeans has the largest raw delta, and is NOT the stage page. Denim
and T-Shirts hold exactly ten listings each, so on those pages the local "top
10" is the entire category — nothing was selected, and "the AI removed 4 of the
10" means 40% of the whole denim catalogue is irrelevant to a jeans query. It
is the right answer to the wrong question.

Purl Knit is the only page with both a deep pool and real removals: 10 of 109
ranked locally, 4 dropped, and all three badge types on one screen with an
EXACT MATCH at 98% over two SAME MODEL DIFFERENT COLOUR at 95%.

**Second page: H&M — brossée**, promoted from stage page. It removes nothing,
so do not promise removals — what it shows is *grading*, with confidence
running 98% down to 60% and reasons that name the difference ("but has a half
zip collar instead of crew neck"). It also carries the strongest extraction
story in the set: 185 variants, picked by the URL's article code.

If the stage page itself fails, fall back to H&M — Regular Jeans, and do not
say "out of 290" on it.

`tests/ab-demo.mjs` headroom is still useful for spotting pages with material
for the model to work on, but it is a proxy and it is not what picks the stage
page any more. The recorded freeze is.

## Demo mode

A frozen set for the eight demo pages, so nothing on stage depends on the
network. Options page → **Demo mode**.

- `data/demo-freeze.json`, built by `node tools/build-demo-freeze.mjs`. Holds
  the exact payload the worker would have pushed, for every demo page.
- **Both sides of the Local/AI toggle are frozen.** The toggle is the pitch's
  centrepiece; a frozen set with only a local half would be useless.
- Matched on `pathname`, so Zara's `?v1=` colourway parameter does not turn a
  frozen page into an unknown one. Two entries sharing a path — the flare jeans
  — are separated by the extracted colour.
- A page OUTSIDE the frozen set still gets live local results, and Gemini is
  still not called. Demo mode never spends quota.
- It lives in `chrome.storage.local` and is read on every match, so it survives
  the worker being suspended, and it is **off** unless storage explicitly says
  otherwise — a fresh profile can never start in it.
- Visible three ways: a `DEMO` badge on the toolbar icon (the only one you can
  see with the panel shut), an undismissable banner across the top of the
  panel, and the Options page.

**The AI half is either a recording or a stand-in, and they are not the same
claim.** The current freeze is **recorded**: 9 of 9 against `gemini-3.6-flash`
on 14 Sep 2026. The file stamps which, and the banner and the Options page both
repeat it, so "here is what Gemini returned" cannot be said over a stand-in by
accident.

Recording RESUMES. `node tools/build-demo-freeze.mjs` keeps every entry already
marked `recorded` and re-records only the stand-ins, so a run that was rate
limited part-way costs only the pages it missed. `--all` forces a full rebuild.
Calls are 15s apart with backoff on 429 and 503 — the first attempt used 5s and
was rate limited on a key the API reports as `limit: 5`.

`./tools/record-freeze.sh` is the wrapper: it prompts for the key with echo off
so it never reaches shell history, and checks it against ListModels (free)
before spending anything.

## Constraints

- Everything free. No paid services.
- Local-first: ranking runs on-device so the demo works offline. Gemini is
  additive only.
- Never add a call in the hot path without accounting for the rate limit.

## Working style

- Say what you guessed or couldn't verify. Don't paper over it.
- Don't rewrite the matching approach without being asked.
- Don't silence an error with a `typeof` guard or a swallowing try/catch —
  that hides the break and ships a permanently degraded feature.
- Flag anything that could break during a live demo.
