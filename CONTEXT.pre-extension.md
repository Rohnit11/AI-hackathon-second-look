# SecondLook — project context (SUPERSEDED, 11 Sep 2026)

> **Do not build from this file.** It is the snapshot from before the Chrome
> extension existed, kept only as a record of the original plan. The live
> document is `CONTEXT.md`.
>
> What changed most: matching no longer uses `embeddings.json` or `match.js`
> and the Transformers.js model is gone — ranking is IDF cosine over titles in
> `SecondLook/lib/score.js`. Categories are flat, with no gender in the string.

## What this is

A browser extension that detects the product a user is viewing on a retail
site and surfaces second-hand alternatives from resale marketplaces.

Built for an AI hackathon at HEC Paris on the theme of waste-fighting,
organised with Phenix. This is a **demo MVP**, not production code. Judge
trade-offs accordingly: a convincing, reliable demo beats completeness.
The pitch is six minutes with a live demo, so anything that can fail on
stage is worse than a missing feature.

## Repo layout

```
resale-data/          # data + matching engine (BUILT)
SecondLook/           # the Chrome extension (TO BUILD)
prototype.html        # visual spec for the panel UI (BUILT)
```

## What already exists in `resale-data/`

| File | What it does |
|---|---|
| `listings.json` | ~250 seeded second-hand listings plus live eBay rows |
| `generate-seed.js` | Seed generator. Exports `COLOUR_NEIGHBOURS` |
| `fetch-ebay.js` | eBay Browse API fetcher, OAuth token flow |
| `build-index.js` | Embeds listings into `embeddings.json` |
| `match.js` | Exports `match(productData, topK)` |
| `test-match.js` | Runs `targets.json` through the matcher |
| `targets.json` | Ten target products, each with a planted match |

### Listing schema

```
id, title, brand, category, subcategory, colour, material, size,
condition, price, original_price_estimate, marketplace, listing_url,
image_url, posted_date, seller_country
```

Seeded rows have clean structured fields. Live eBay rows do not — 
`fetch-ebay.js` parses what it can from titles and writes `"Unspecified"`
where it fails. Matching has to survive both.

### Matching pipeline (in `match.js`)

1. Hard pre-filter on category, and on brand when the query brand is known.
   If fewer than 5 candidates survive, relax brand and keep category.
2. Cosine similarity against `embeddings.json`.
3. Colour re-rank using `COLOUR_NEIGHBOURS`: exact colour boosts, adjacent
   is neutral, distant penalises.
4. Relative ranking only. **No absolute score threshold** — testing showed
   no global cutoff separates true from false matches.

Embedding model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384 dims.
Multilingual because 39% of the dataset is French and an English-only model
buried French listings at median rank 131 against 18 for English.

## Visual spec — `prototype.html`

The panel design is settled. Match it.

- Fixed right-hand panel, 380px, full viewport height
- Own vertical scroll on `.results`; header and impact footer stay pinned
- Collapse to a 48px tab carrying the logo and a match count badge, via
  `body.panel-collapsed` and `translateX(100%)`
- Page pushed across with `margin-right`, so the panel never covers content
- Under 900px the panel overlays with a `rgba(16,18,22,.42)` backdrop
- `border-radius: 0`, left border only
- Entrance animation uses `fill-mode: backwards` (with `both` the keyframe's
  final `transform:none` outranks the collapse transform and the panel
  never slides away)
- `prefers-reduced-motion` handled

Result card contents: image, title, marketplace, price, saving %, condition,
confidence bar, one-line AI reason in italics, and a match-type badge —
EXACT MATCH (green), SAME MODEL DIFFERENT COLOUR (amber), CLOSE ALTERNATIVE
(grey).

Impact footer shows CO2 and water avoided, with the source cited (ADEME).

## Target sites

zara.com, hm.com, mango.com, uniqlo.com, asos.com, amazon.fr, nike.com

Read product data from the page's schema.org JSON-LD. Fall back to `og:`
meta tags, then page title plus main image. These sites swap products
without a full page reload, so watch `history.pushState` and URL changes.

## Constraints

- Everything must be free. No paid services anywhere.
- Local-first: matching runs on-device via Transformers.js so the demo works
  with the wifi off. The instructions warn that the venue internet may fail.
- Gemini Flash (free tier, ~5–15 rpm) is used later for match verification.
  Every call to it must fail silently back to local ranking.

## Working style

- Say what you guessed or could not verify rather than papering over it.
- Don't rewrite the matching approach without being asked.
- Flag anything that would break during a live demo.
