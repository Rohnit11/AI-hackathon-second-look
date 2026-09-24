# resale-data

Second-hand fashion listing data for testing product matching: a synthetic seed
set, a live eBay fetcher that appends to it, and a set of target products with
known-good answers.

Scope is women's and men's **outerwear** and **knitwear** from Zara, Mango, COS,
Uniqlo, H&M, Sézane and Massimo Dutti.

## Quick start

```bash
npm run seed          # writes listings.json (250 rows) + fills in targets.json
cp .env.example .env  # add eBay API keys, optional
npm run fetch:ebay    # appends real eBay listings to listings.json
npm run index         # embeds every listing -> embeddings.json
npm run test:match    # runs all 10 targets through match(), prints top 5
```

`npm run build` runs both. The eBay step skips itself with a message if there
are no credentials, so the seed data works on its own.

## Files

| File | What it is |
| --- | --- |
| `generate-seed.js` | Generates the synthetic listings. Deterministic. |
| `fetch-ebay.js` | Queries the eBay Browse API and appends real listings. |
| `listings.json` | The dataset. Seed rows have `ls-` ids, eBay rows `ebay-`. |
| `targets.json` | Ten retailer products to match, with ground-truth answers. |
| `build-index.js` | Embeds listings with all-MiniLM-L6-v2 into `embeddings.json`. |
| `match.js` | `match(productData, topK)` — cosine search over the index. |
| `test-match.js` | Runs every target through `match()` and scores the ranking. |

## Schema

Every row in `listings.json` has the same sixteen fields, whether it came from
the generator or from eBay:

```json
{
  "id": "ls-0019",
  "title": "Camel Long Manteau | Zara Basic | Laine Mélangée | T 38 | Envoi Rapide",
  "brand": "Zara",
  "category": "Women's Outerwear",
  "subcategory": "Wool Coat",
  "colour": "Camel",
  "material": "Wool Blend",
  "size": "38",
  "condition": "new with tags",
  "price": 89.5,
  "original_price_estimate": 129,
  "marketplace": "Leboncoin",
  "listing_url": "https://www.leboncoin.fr/ad/vetements/4173232002",
  "image_url": "https://picsum.photos/seed/rd-20240917-0/600/800",
  "posted_date": "2026-08-04",
  "seller_country": "FR"
}
```

`condition` is one of `new with tags`, `very good`, `good`, `satisfactory`.
`marketplace` is one of `Vinted`, `Vestiaire Collective`, `eBay`, `Emmaüs`,
`Leboncoin`. Prices are EUR. `category` carries the gender split, so
`subcategory` stays a pure garment type.

## Why the titles are a mess

That is the point. Resale titles are typed by people on phones, so the generator
reproduces what they actually look like:

```
zara / belted cardigan camel / (small) / no reserve 🔥
RARE * trench crème * taille 34 * comme neuf
H&M / GRIS ANTHRACITE BLAZER / LAINE MÉLANGÉE
Long Coat - Free Postage ❤️
noir gilet long // massimodutti // taille t2 // très bon état
```

Roughly 39% of titles use French wording, 28% never name the brand, 60% carry a
size, and sizes appear as `M`, `38`, `Medium`, `T.38` and `UK 12` for the same
garment. Capitalisation is inconsistent by design, and brand names appear as
`Sezane`, `SÉZANE`, `massimodutti`, `H and M`, `Zara TRF` and so on.

Two details matter for anything matching against this:

- **The structured fields are always clean.** A listing whose title says nothing
  but `Long Coat - Free Postage` still has `brand: "Zara"`, `colour: "Camel"`.
  The title is the hard input; the fields are the truth.
- **URLs don't leak the answer.** Vinted and Emmaüs slugs are built from the
  seller's title, so a listing that omits the brand omits it from the URL too.
  Only Vestiaire Collective uses structured slugs, because the real site does.

## Targets and ground truth

`targets.json` holds ten real-format Zara, H&M and Mango product pages. The
generator plants matches for each and writes the answers back:

- `expected_match_ids` — strong matches. Same brand, subcategory, colour and
  material as the target, but with a deliberately awkward title. Each target
  gets two: one French with the brand present, one English with the brand left
  out entirely.
- `expected_near_match_ids` — near misses that drift to a neighbouring colour
  (camel/beige, ecru/cream). A matcher should rank these below the strong ones,
  not discard them.

Planted sizes are restyled from what the target actually stocks, so an `M` on
the product page turns up as `38`, `Medium` or `T.38` on the listing.

`npm run seed` prints a per-target summary and **throws** if any target ends up
without a strong match, so the guarantee is enforced rather than assumed.

## eBay fetcher

`fetch-ebay.js` uses the Browse API `item_summary/search` endpoint with an OAuth
client-credentials token, which it refreshes automatically and retries once on a
401. It runs 28 queries (7 brands × 4 category buckets), rate-limits itself
between calls, skips a failed query rather than aborting the run, and dedupes
against existing rows by id and URL before appending.

The Browse API's search results carry no brand, size, colour or material field,
so those are parsed out of the title with the same vocabulary the generator
uses — `generate-seed.js` exports its taxonomy and `fetch-ebay.js` imports it, so
the two sources can't drift apart. **Anything unparseable is recorded as
`"Unspecified"` rather than guessed.** The category from the query bucket is
treated as a hint: if the title clearly says otherwise, it gets reclassified.

Configuration lives in `.env` (see `.env.example`): marketplace, per-query limit,
total cap, request delay, and a switch to drop the category filter.

Two approximations worth knowing about:

- eBay category ids (`63862`, `63866`, `57988`, `11484`) come from the US
  category tree. They work on the European marketplaces, but if a marketplace
  over-filters, set `EBAY_DISABLE_CATEGORY_FILTER=true` to search on keywords.
- Non-EUR prices are converted with a small static rate table. Fine for
  comparison, not for accounting.

## Determinism

`generate-seed.js` uses a seeded PRNG and a fixed reference date, so the same
seed produces the same file. Change it with `--seed=123`, `--count=500`,
`--out=other.json`. Re-running does not churn the diff.

## Note on the target URLs

The ten products in `targets.json` use each retailer's genuine product-page URL
and reference format (`zara.com/fr/fr/…-p########.html`,
`www2.hm.com/fr_fr/productpage.##########.html`,
`shop.mango.com/fr/…_########.html`) with realistic names, colours and prices.
They are representative rather than scraped from live pages — retailer URLs for
a given season go dead within months, and both sites block automated access.
Swap in live URLs if you need them to resolve.

Listing images point at `picsum.photos`, which resolves, so the dataset renders
in a UI without shipping any binaries.

## Matching

```js
const { match } = require('./match.js');
const hits = await match(require('./targets.json').targets[0], 5);
// [{ id: 'ls-0019', title: '...', brand: 'Zara', score: 0.9247, ... }, ...]
```

`build-index.js` embeds each listing with `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dims,
mean-pooled, L2-normalised, so cosine is a plain dot product). The embedded text
is not the raw title — it is the structured fields followed by a cleaned title:

```
"Camel Long Manteau | Zara Basic | Laine Mélangée | T 38 | Envoi Rapide"
  -> "zara women's outerwear wool coat camel wool blend camel long manteau laine melangee"
```

Cleaning strips emoji, price shouts, condition boasts, shipping promises and
every size notation, then drops repeated words. It does not translate or guess.

`match()` accepts a targets.json product, a listing row, or a plain string, and
reduces it through the same builder so both sides are shaped identically.
Everything runs in-process via onnxruntime-node; nothing leaves the machine.

### Ranking pipeline

`match()` runs three stages:

1. **Hard filter.** Category must match. Brand must match too when the query
   names one — unless that leaves fewer than 5 candidates, in which case brand
   is relaxed and category alone stands. Cosine only runs on survivors.
2. **Cosine similarity** over the surviving candidates.
3. **Colour re-rank.** Exact colour `+0.05`, adjacent `0`, distant `-0.05`,
   unknown `0`. Adjacency is the (symmetrised) `COLOUR_NEIGHBOURS` map from
   `generate-seed.js`, so "adjacent" means what the data means by it.

There is no score threshold anywhere. Ranking is relative, and `match()` always
returns `topK`, backfilling from outside the filter if the filter was narrower.
Each hit reports `score` (the final ranking value), `similarity` (raw cosine),
`colour_match` and `stage`. Because the colour boost is additive, `score` can
exceed 1.0; `similarity` is the untouched cosine.

### Measured results

On the 250-row seed corpus, all ten targets place a planted match at rank 1, and
all 20 planted matches land in the top 2 (up from 18/20). Filtering and the
colour re-rank fixed both previously-documented inversions: the Burgundy cable
knit no longer outranks the Ecru one, and the COS puffer can no longer appear at
all for an H&M query.

### The model swap did not pay off

Switching to the multilingual model fixed cross-language similarity — "camel wool
coat" vs "manteau en laine camel" went 0.34 to 0.85 — but made *retrieval* worse
where it is actually hard. Ranking on the cleaned title alone, with no structured
fields to lean on:

| title-only ablation | all-MiniLM-L6-v2 | multilingual-L12-v2 |
| --- | --- | --- |
| French median rank | 91 | 162 |
| English median rank | 12.5 | 28 |
| planted match in top 3 | 6/10 | 5/10 |
| mean pairwise cosine, all 250 titles | 0.258 | 0.344 |

The multilingual model is worse in every query mode (English-only, French-only,
and both), so this is not an artefact of a bilingual query. The cause is that
last row: it packs the whole clothing domain into a tighter cone, so everything
looks alike and there is less signal left to rank on. all-MiniLM shreds French
into subword pieces it does not understand, but it shreds it *consistently*,
which is enough to retrieve French-against-French.

With the hard filter in place the model barely matters — both reach 10/10 at
rank 1 end-to-end. Revert with one line in `build-index.js` if raw-title
matching ever matters more than cross-language similarity.

### Still open

The hard filter makes a category mis-parse fatal rather than merely costly: a
listing filed under the wrong category is now invisible to the right query,
reachable only through backfill. That is a real risk for eBay rows, whose
category is inferred from the title by `fetch-ebay.js`, and none for seed rows,
whose category is generated. Worth watching once real eBay data is in.
