#!/usr/bin/env node
'use strict';

/**
 * match.js
 *
 * match(productData, topK) — finds the listings most likely to be the same
 * garment as an incoming product.
 *
 * Three stages, in this order:
 *
 *   1. Hard filter.  Category must match. Brand must match too when the query
 *      names one — unless that leaves fewer than MIN_BRAND_CANDIDATES, in which
 *      case brand is relaxed and category alone stands. Cosine similarity only
 *      runs on what survives, so a COS puffer can no longer outrank an H&M one
 *      for an H&M query.
 *
 *   2. Cosine similarity over the surviving candidates.
 *
 *   3. Colour re-rank.  Embeddings smear colour badly — a Burgundy cable knit
 *      used to beat the correct Ecru one — so colour is applied afterwards as a
 *      structured adjustment: exact match boosts, an adjacent shade is neutral,
 *      a distant one penalises. Adjacency comes from COLOUR_NEIGHBOURS in
 *      generate-seed.js, so the notion of "adjacent" matches the data.
 *
 * There is no score threshold anywhere. Ranking is purely relative and the
 * function always returns topK results, backfilling from outside the filter if
 * the filter was narrower than topK.
 *
 *   const { match } = require('./match.js');
 *   const hits = await match(require('./targets.json').targets[0], 5);
 *
 * Also runnable directly:  node match.js "camel wool coat zara"
 */

const fs = require('fs');
const path = require('path');

const { describeProduct, embed, DIM } = require('./build-index.js');
const { COLOUR_NEIGHBOURS } = require('./generate-seed.js');

const EMBEDDINGS_FILE = path.join(__dirname, 'embeddings.json');
const LISTINGS_FILE = path.join(__dirname, 'listings.json');

/** Below this many brand-matched candidates, brand is dropped from the filter. */
const MIN_BRAND_CANDIDATES = 5;

/** Added to the cosine score once the colour relation is known. */
const COLOUR_ADJUSTMENT = {
  exact: 0.05,
  adjacent: 0,
  unknown: 0, // eBay rows often have no parseable colour; do not punish them
  distant: -0.05,
};

// ---------------------------------------------------------------------------
// Colour adjacency
// ---------------------------------------------------------------------------

/**
 * COLOUR_NEIGHBOURS is written one-way (Camel -> Oatmeal) but adjacency is
 * mutual, so mirror every pair before use.
 */
const ADJACENT = (() => {
  const map = new Map();
  const add = (a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const [colour, neighbours] of Object.entries(COLOUR_NEIGHBOURS)) {
    for (const n of neighbours) {
      add(colour, n);
      add(n, colour);
    }
  }
  return map;
})();

const normColour = (c) => String(c ?? '').trim().toLowerCase();

function colourRelation(queryColour, candidateColour) {
  const q = normColour(queryColour);
  const c = normColour(candidateColour);
  if (!q || !c || q === 'unspecified' || c === 'unspecified') return 'unknown';
  if (q === c) return 'exact';

  const neighbours = ADJACENT.get(
    Object.keys(COLOUR_NEIGHBOURS).find((k) => normColour(k) === q) ?? queryColour
  );
  if (neighbours && [...neighbours].some((n) => normColour(n) === c)) return 'adjacent';
  return 'distant';
}

// ---------------------------------------------------------------------------
// Index loading
// ---------------------------------------------------------------------------

let index = null;

/**
 * Loads embeddings.json once and flattens it into a single Float32Array.
 * One contiguous buffer keeps the scoring loop cache-friendly.
 */
function loadIndex() {
  if (index) return index;

  if (!fs.existsSync(EMBEDDINGS_FILE)) {
    throw new Error('embeddings.json not found — run `npm run index` first.');
  }
  if (!fs.existsSync(LISTINGS_FILE)) {
    throw new Error('listings.json not found — run `npm run seed` first.');
  }

  const payload = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
  const listings = JSON.parse(fs.readFileSync(LISTINGS_FILE, 'utf8'));
  const byId = new Map(listings.map((l) => [l.id, l]));

  const rows = payload.embeddings ?? [];
  const dim = payload.dim ?? DIM;
  const matrix = new Float32Array(rows.length * dim);
  const meta = [];

  rows.forEach((row, i) => {
    if (row.vector.length !== dim) {
      throw new Error(`${row.id}: expected ${dim} dimensions, got ${row.vector.length}`);
    }
    matrix.set(row.vector, i * dim);
    meta.push({ row: i, id: row.id, text: row.text, listing: byId.get(row.id) ?? null });
  });

  const orphans = meta.filter((m) => !m.listing);
  if (orphans.length) {
    console.warn(
      `! ${orphans.length} embedded id(s) are not in listings.json — the index is stale. Re-run \`npm run index\`.`
    );
  }

  index = { matrix, meta, dim, normalized: payload.normalized === true, model: payload.model };
  return index;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity of `query` against row `i` of the flattened matrix.
 * When both sides are L2-normalised, cosine reduces to the dot product; the
 * divisor is kept for indexes that are not.
 */
function cosineAt(matrix, offset, query, dim, preNormalized) {
  let dot = 0;
  if (preNormalized) {
    for (let d = 0; d < dim; d++) dot += matrix[offset + d] * query[d];
    return dot;
  }

  let magA = 0;
  let magB = 0;
  for (let d = 0; d < dim; d++) {
    const a = matrix[offset + d];
    const b = query[d];
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Stage 1: hard filter
// ---------------------------------------------------------------------------

const normKey = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Narrows the corpus before any similarity is computed.
 * Returns the surviving candidates plus the stage that produced them, so the
 * caller can see whether brand was actually applied.
 */
function filterCandidates(meta, { brand, category }) {
  if (!category) {
    // A free-text query carries no structured fields to filter on.
    return { pool: meta, stage: 'none' };
  }

  const byCategory = meta.filter((m) => m.listing && normKey(m.listing.category) === normKey(category));
  if (!byCategory.length) return { pool: meta, stage: 'none' };

  if (!brand) return { pool: byCategory, stage: 'category' };

  const byBrand = byCategory.filter((m) => normKey(m.listing.brand) === normKey(brand));
  // Too few to rank meaningfully — keep the category constraint, drop brand.
  if (byBrand.length < MIN_BRAND_CANDIDATES) {
    return { pool: byCategory, stage: 'category (brand relaxed)' };
  }
  return { pool: byBrand, stage: 'brand+category' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object|string} productData  A targets.json product, a listing, or free text.
 * @param {number} topK               How many listings to return. Default 5.
 * @param {object} [options]
 * @param {boolean} [options.filter=true]      Apply the brand/category pre-filter.
 * @param {boolean} [options.colourRerank=true] Apply the colour adjustment.
 * @returns {Promise<Array>} topK listings, best first. Each carries:
 *   score       final ranking score (similarity + colour adjustment)
 *   similarity  raw cosine, before any adjustment
 *   colour_match exact | adjacent | unknown | distant
 *   stage       which filter the candidate came through, or 'backfill'
 */
async function match(productData, topK = 5, options = {}) {
  if (productData === null || productData === undefined) {
    throw new TypeError('match(productData, topK): productData is required');
  }

  const { filter = true, colourRerank = true } = options;
  const { matrix, meta, dim, normalized } = loadIndex();
  const k = Math.max(1, Math.min(Math.trunc(topK) || 5, meta.length));

  const queryText = describeProduct(productData);
  if (!queryText) throw new Error('productData produced an empty description');

  const isObject = typeof productData === 'object';
  const queryBrand = isObject ? productData.brand : null;
  const queryCategory = isObject ? productData.category : null;
  const queryColour = isObject ? productData.colour : null;

  const { pool, stage } = filter
    ? filterCandidates(meta, { brand: queryBrand, category: queryCategory })
    : { pool: meta, stage: 'disabled' };

  const [queryVector] = await embed([queryText]);

  const score = (m, fromStage) => {
    const similarity = cosineAt(matrix, m.row * dim, queryVector, dim, normalized);
    const relation = colourRerank
      ? colourRelation(queryColour, m.listing?.colour)
      : 'unknown';
    return {
      meta: m,
      similarity,
      relation,
      final: similarity + COLOUR_ADJUSTMENT[relation],
      stage: fromStage,
    };
  };

  // Purely relative ranking — no score threshold at any point.
  const ranked = pool.map((m) => score(m, stage)).sort((a, b) => b.final - a.final);

  // The filter can be narrower than topK; top up so the caller always gets k.
  if (ranked.length < k) {
    const chosen = new Set(pool.map((m) => m.id));
    const rest = meta
      .filter((m) => !chosen.has(m.id))
      .map((m) => score(m, 'backfill'))
      .sort((a, b) => b.final - a.final)
      .slice(0, k - ranked.length);
    ranked.push(...rest);
  }

  return ranked.slice(0, k).map((r) => ({
    ...(r.meta.listing ?? { id: r.meta.id }),
    score: Math.round(r.final * 10000) / 10000,
    similarity: Math.round(r.similarity * 10000) / 10000,
    colour_match: r.relation,
    stage: r.stage,
    matched_text: r.meta.text,
    query_text: queryText,
  }));
}

module.exports = { match, loadIndex, describeProduct, colourRelation, filterCandidates, MIN_BRAND_CANDIDATES };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('usage: node match.js "<product description>"');
    process.exit(1);
  }
  match(query, 5)
    .then((hits) => {
      console.log(`\nquery: "${hits[0]?.query_text ?? query}"\n`);
      hits.forEach((h, i) => {
        console.log(
          `${i + 1}. ${h.score.toFixed(4)} (cos ${h.similarity.toFixed(4)}, colour ${h.colour_match})  ` +
            `${h.id}  ${h.brand} · ${h.colour} ${h.subcategory} · €${h.price}`
        );
        console.log(`   ${h.title}`);
      });
      console.log('');
    })
    .catch((err) => {
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
    });
}
