#!/usr/bin/env node
'use strict';

/**
 * build-index.js
 *
 * Embeds every row in listings.json with Xenova/all-MiniLM-L6-v2 and writes
 * embeddings.json.
 *
 * The vector is built from a normalised description rather than the raw title.
 * Raw resale titles carry a lot that actively hurts a semantic match — shipping
 * promises, condition boasts, emoji, price shouts, the seller's size notation —
 * so the title is stripped back to the words that describe the garment and then
 * prefixed with the structured fields.
 *
 *   ls-0019 "Camel Long Manteau | Zara Basic | Laine Mélangée | T 38 | Envoi Rapide"
 *        -> "zara women's outerwear wool coat camel wool blend camel long manteau laine melangee"
 *
 * Vectors are mean-pooled and L2-normalised, so cosine similarity is a plain
 * dot product at query time.
 *
 *   node build-index.js [--batch=32] [--out=embeddings.json] [--dtype=fp32]
 */

const fs = require('fs');
const path = require('path');

// Multilingual: the dataset is ~39% French, and the English-only
// all-MiniLM-L6-v2 scored equivalent EN/FR phrases at 0.16-0.34 cosine.
// Same 384 dimensions, so the index format is unchanged.
const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const DIM = 384;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const LISTINGS_FILE = path.join(__dirname, 'listings.json');
const OUT_FILE = path.join(__dirname, args.out ?? 'embeddings.json');
const BATCH_SIZE = Math.max(1, Number(args.batch ?? 32));
const DTYPE = args.dtype ?? 'fp32';

// ---------------------------------------------------------------------------
// Title cleaning
// ---------------------------------------------------------------------------

// Phrases sellers add that say nothing about the garment. Longest first so
// "neuf avec etiquette" is removed before a bare "neuf" can match inside it.
const NOISE_PHRASES = [
  // French
  'neuf avec etiquette', 'neuf avec étiquette', 'tres bon etat', 'très bon état',
  'etat impeccable', 'état impeccable', 'comme neuf', 'jamais porte', 'jamais porté',
  'porte 2 fois', 'porté 2 fois', 'envoi rapide', 'envoi soigne', 'envoi soigné',
  'prix ferme', 'petit prix', 'a saisir', 'à saisir', 'px boutique', 'px neuf',
  'collection automne', 'collection hiver', 'tbe', 'bon etat', 'bon état',
  'magnifique', 'superbe', 'sublime', 'tres joli', 'très joli', 'rare',
  // English
  'brand new with tags', 'new with tags', 'sold out online', 'sold out',
  'excellent condition', 'immaculate', 'worn twice', 'worn once', 'as new',
  'free postage', 'free shipping', 'no reserve', 'quick sale', 'bundle discount',
  'must have', 'super cosy', 'cosy', 'gorgeous', 'stunning', 'bnwt', 'vgc',
  'unworn', 'oversized fit',
];

const NOISE_RE = new RegExp(
  `\\b(?:${NOISE_PHRASES.sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'gi'
);

// The seller's size notation, in every form the dataset uses. Size is a filter,
// not a semantic signal, so it is dropped from the embedding text entirely.
const SIZE_RE = [
  /\b(?:taille|size|sz|talla|taglia|gr)\s*[:.]?\s*(?:xxs|xs|xxl|xl|s|m|l|\d{1,2})\b/gi,
  /\bt\.?\s?\d{1,2}\b/gi,
  /\b(?:uk|eu|fr|it|us|de)\s?\d{1,2}\b/gi,
  /\b(?:extra small|extra large|x-?large|x-?small|small|medium|large)\b/gi,
  /(?:^|[\s,\-/|(\[])(?:xxs|xs|xxl|xl)(?=$|[\s,\-/|)\]])/gi,
];

const PRICE_RE = /(?:rrp|px)?\s*[€£$]\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?[€£$]/gi;
// Emoji and pictographs; \p{Extended_Pictographic} covers the ranges we emit.
const EMOJI_RE = /[\p{Extended_Pictographic}️‍]/gu;

/**
 * Reduces a seller's title to the words that describe the garment.
 * Deliberately conservative: it removes noise, it does not translate or guess.
 */
function cleanTitle(raw) {
  let t = String(raw ?? '').toLowerCase();

  t = t.replace(EMOJI_RE, ' ');
  t = t.replace(PRICE_RE, ' ');
  t = t.replace(NOISE_RE, ' ');
  for (const re of SIZE_RE) t = t.replace(re, ' ');
  // A label whose value a previous rule already removed ('taille t2' -> 'taille').
  t = t.replace(/\b(?:taille|size|sz|talla|taglia)\b/gi, ' ');

  // Separators and leftover punctuation become spaces.
  t = t.replace(/[|/*,\-–—_()[\]!?.:;"'+#~]+/g, ' ');
  // Bare numbers left over (sizes, quantities) carry no meaning here.
  t = t.replace(/\b\d+\b/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();

  // Titles often repeat a word the structured fields already supply
  // ("veste peau lainee cos peau lainee"). Keep first occurrence only.
  const seen = new Set();
  return t
    .split(' ')
    .filter((w) => w && (w.length > 1 || /[a-z]/.test(w)) && !seen.has(w) && seen.add(w))
    .join(' ');
}

/**
 * The text that actually gets embedded. Structured fields first because they
 * are clean and reliable, then the salvaged title for anything they miss
 * (cut, collar, pattern, fit).
 *
 * Note: subcategory is included alongside category. Without the garment type
 * ("Wool Coat" vs "Cardigan") the structured half of the string is too vague to
 * separate a coat from a jumper of the same brand and colour.
 */
function buildDescription(row) {
  const parts = [
    row.brand,
    row.category,
    row.subcategory,
    row.colour,
    row.material,
    cleanTitle(row.title),
  ];
  return parts
    .map((p) => String(p ?? '').toLowerCase().trim())
    .filter((p) => p && p !== 'unspecified')
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** Same string, built from a targets.json product instead of a listing. */
function describeProduct(product) {
  if (typeof product === 'string') return cleanTitle(product);
  return buildDescription({
    brand: product.brand,
    category: product.category,
    subcategory: product.subcategory,
    colour: product.colour,
    material: product.material,
    // Both names: name_en carries the English garment words the model knows,
    // name is the French original a listing might echo.
    title: [product.name_en, product.name, product.title].filter(Boolean).join(' '),
  });
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

let extractorPromise = null;

/** Loads the model once per process and reuses it. */
async function getExtractor(dtype = DTYPE) {
  if (!extractorPromise) {
    const { pipeline } = require('@huggingface/transformers');
    extractorPromise = pipeline('feature-extraction', MODEL_ID, { dtype });
  }
  return extractorPromise;
}

/** Returns one L2-normalised vector per input string. */
async function embed(texts, { batchSize = BATCH_SIZE, onProgress } = {}) {
  const extractor = await getExtractor();
  const vectors = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    vectors.push(...output.tolist());
    if (onProgress) onProgress(Math.min(i + batch.length, texts.length), texts.length);
  }

  return vectors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// 6dp on a unit vector costs ~1e-6 of precision and roughly halves the file.
const round6 = (v) => Math.round(v * 1e6) / 1e6;

async function main() {
  if (!fs.existsSync(LISTINGS_FILE)) {
    console.error('! listings.json not found. Run `npm run seed` first.');
    process.exit(1);
  }

  const listings = JSON.parse(fs.readFileSync(LISTINGS_FILE, 'utf8'));
  console.log(`Embedding ${listings.length} listings with ${MODEL_ID} (${DTYPE})`);

  const texts = listings.map(buildDescription);

  const t0 = Date.now();
  const vectors = await embed(texts, {
    onProgress: (done, total) => {
      process.stdout.write(`\r  ${done}/${total}`);
    },
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write('\n');

  const bad = vectors.filter((v) => v.length !== DIM);
  if (bad.length) throw new Error(`${bad.length} vectors were not ${DIM}-dimensional`);

  const payload = {
    model: MODEL_ID,
    dim: DIM,
    normalized: true,
    built_at: new Date().toISOString(),
    count: listings.length,
    // text is kept so a surprising match can be explained without re-deriving it.
    embeddings: listings.map((row, i) => ({
      id: row.id,
      text: texts[i],
      vector: vectors[i].map(round6),
    })),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload) + '\n');

  const sizeMb = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`✓ wrote ${listings.length} vectors to ${path.basename(OUT_FILE)} (${sizeMb} MB) in ${seconds}s`);
  console.log(`\n  sample text: "${texts[0]}"`);
  console.log(`  from title:  "${listings[0].title}"`);
}

module.exports = { MODEL_ID, DIM, cleanTitle, buildDescription, describeProduct, embed, getExtractor };

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  });
}
