#!/usr/bin/env node
'use strict';

/**
 * generate-seed.js
 *
 * Produces listings.json: 250 synthetic second-hand fashion listings covering
 * women's and men's outerwear and knitwear from seven high-street brands.
 *
 * Two things matter about the output:
 *
 *  1. The titles are deliberately messy. Real resale titles are written by
 *     sellers on a phone, so they have inconsistent capitalisation, drift
 *     between French and English, often omit the brand entirely, and write
 *     sizes five different ways. Anything matching against this data has to
 *     cope with that, so the generator reproduces it on purpose.
 *
 *  2. Every product in targets.json is guaranteed at least one strong match.
 *     The generator reads targets.json, plants two or three deliberately
 *     scruffy listings per target, and writes the resulting listing ids back
 *     into each target's expected_match_ids as ground truth.
 *
 * Output is deterministic: same seed in, same file out. Override with
 * `node generate-seed.js --seed=123 --count=500`.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v = 'true'] = arg.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const SEED = Number(args.seed ?? 20240917);
const TOTAL = Number(args.count ?? 250);
const OUT_FILE = path.join(__dirname, args.out ?? 'listings.json');
const TARGETS_FILE = path.join(__dirname, 'targets.json');

// Fixed reference date so re-running the generator does not churn every
// posted_date. Dates are spread backwards from here.
const REFERENCE_DATE = new Date('2026-09-11T00:00:00Z');

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + helpers
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);

const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const chance = (p) => rand() < p;

/** Pick from an object of {value: weight}. */
function weighted(table) {
  const entries = Object.entries(table);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [value, w] of entries) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function slugify(str) {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function digits(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += randInt(i === 0 ? 1 : 0, 9);
  return out;
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

const BRANDS = {
  Zara: {
    tier: 1.0,
    weight: 20,
    genders: ['women', 'men'],
    variants: {
      any: ['Zara', 'ZARA', 'zara', 'Zara ', 'ZARA.'],
      women: ['Zara Woman', 'ZARA WOMAN', 'zara woman', 'Zara TRF', 'Zara Basic'],
      men: ['Zara Man', 'ZARA MAN', 'zara man', 'Zara Men'],
    },
  },
  'H&M': {
    tier: 0.72,
    weight: 18,
    genders: ['women', 'men'],
    variants: {
      any: ['H&M', 'H & M', 'h&m', 'HM', 'H and M', 'H&M.'],
      women: ['H&M Divided', 'H&M Studio', 'H&M Premium Selection'],
      men: ['H&M Divided', 'H&M Man'],
    },
  },
  Mango: {
    tier: 1.05,
    weight: 15,
    genders: ['women', 'men'],
    variants: {
      any: ['Mango', 'MANGO', 'mango', 'Mango.'],
      women: ['Violeta by Mango', 'Mango Woman', 'MANGO WOMAN'],
      men: ['Mango Man', 'MANGO MAN', 'Mango Suit'],
    },
  },
  COS: {
    tier: 1.45,
    weight: 13,
    genders: ['women', 'men'],
    variants: {
      any: ['COS', 'Cos', 'cos', 'COS Stores', 'C.O.S', 'COS '],
      women: ['COS Woman'],
      men: ['COS Man'],
    },
  },
  Uniqlo: {
    tier: 0.85,
    weight: 13,
    genders: ['women', 'men'],
    variants: {
      any: ['Uniqlo', 'UNIQLO', 'uniqlo', 'Uniqlo U', 'UNIQLO +J'],
      women: ['Uniqlo Women'],
      men: ['Uniqlo Men'],
    },
  },
  'Massimo Dutti': {
    tier: 1.55,
    weight: 11,
    genders: ['women', 'men'],
    variants: {
      any: [
        'Massimo Dutti',
        'MASSIMO DUTTI',
        'massimo dutti',
        'Massimo Duti',
        'MassimoDutti',
        'Massimo-Dutti',
      ],
      women: ['Massimo Dutti Woman'],
      men: ['Massimo Dutti Man'],
    },
  },
  'Sézane': {
    tier: 1.75,
    weight: 10,
    genders: ['women'],
    variants: {
      any: ['Sézane', 'Sezane', 'SÉZANE', 'SEZANE', 'sezane', 'Sézane Paris', 'sézane'],
      women: ['Sézane Paris'],
    },
  },
};

const BRAND_WEIGHTS = Object.fromEntries(
  Object.entries(BRANDS).map(([name, b]) => [name, b.weight])
);

// ---------------------------------------------------------------------------
// Categories, subcategories, garment vocabulary
// ---------------------------------------------------------------------------
// fr.n is the grammatical gender of the French noun, used so colour adjectives
// agree ("manteau noir" vs "veste noire").

const CATEGORIES = {
  "Women's Outerwear": {
    gender: 'women',
    weight: 32,
    subcategories: [
      { name: 'Wool Coat', price: 129, en: ['Wool Coat', 'Wool Blend Coat', 'Long Coat', 'Longline Coat'], fr: { words: ['manteau en laine', 'manteau laine', 'long manteau'], n: 'm' }, materials: { 'Wool Blend': 5, Wool: 3, 'Wool-Cashmere Blend': 2, 'Alpaca Blend': 1 } },
      { name: 'Trench Coat', price: 99, en: ['Trench Coat', 'Belted Trench', 'Classic Trench'], fr: { words: ['trench', 'trench-coat', 'imperméable'], n: 'm' }, materials: { 'Cotton Blend': 4, Cotton: 3, Polyester: 2 } },
      { name: 'Puffer Jacket', price: 69, en: ['Puffer Jacket', 'Padded Jacket', 'Down Jacket', 'Quilted Puffer'], fr: { words: ['doudoune', 'doudoune matelassée', 'veste matelassée'], n: 'f' }, materials: { 'Recycled Polyester': 5, Nylon: 3, Down: 2 } },
      { name: 'Biker Jacket', price: 79, en: ['Biker Jacket', 'Faux Leather Jacket', 'Moto Jacket'], fr: { words: ['perfecto', 'veste en cuir', 'veste effet cuir', 'blouson'], n: 'm' }, materials: { 'Faux Leather': 6, Leather: 2 } },
      { name: 'Blazer', price: 69, en: ['Blazer', 'Tailored Blazer', 'Oversized Blazer'], fr: { words: ['blazer', 'veste de tailleur', 'veste blazer'], n: 'm' }, materials: { 'Wool Blend': 4, 'Polyester Blend': 3, 'Linen Blend': 2 } },
      { name: 'Parka', price: 99, en: ['Parka', 'Hooded Parka', 'Padded Parka'], fr: { words: ['parka', 'parka à capuche'], n: 'f' }, materials: { Polyester: 4, 'Cotton Blend': 3, Nylon: 2 } },
      { name: 'Bomber Jacket', price: 59, en: ['Bomber Jacket', 'Bomber'], fr: { words: ['bomber', 'blouson bomber'], n: 'm' }, materials: { Polyester: 4, Nylon: 3, 'Faux Suede': 2 } },
      { name: 'Quilted Jacket', price: 69, en: ['Quilted Jacket', 'Diamond Quilted Jacket'], fr: { words: ['veste matelassée', 'veste capitonnée'], n: 'f' }, materials: { 'Recycled Polyester': 4, Nylon: 3 } },
      { name: 'Faux Fur Coat', price: 89, en: ['Faux Fur Coat', 'Teddy Coat', 'Faux Fur Jacket'], fr: { words: ['manteau fausse fourrure', 'manteau teddy'], n: 'm' }, materials: { 'Faux Fur': 5, 'Acrylic Blend': 3 } },
      { name: 'Shearling Jacket', price: 119, en: ['Shearling Jacket', 'Aviator Jacket', 'Borg Jacket'], fr: { words: ['veste peau lainée', 'veste aviateur'], n: 'f' }, materials: { 'Faux Shearling': 5, 'Faux Suede': 3 } },
      { name: 'Overshirt', price: 49, en: ['Overshirt', 'Shacket', 'Shirt Jacket'], fr: { words: ['surchemise', 'veste chemise'], n: 'f' }, materials: { 'Wool Blend': 4, Corduroy: 3, Cotton: 2 } },
      { name: 'Cape', price: 89, en: ['Cape', 'Wool Cape', 'Poncho'], fr: { words: ['cape', 'poncho', 'cape en laine'], n: 'f' }, materials: { 'Wool Blend': 4, 'Acrylic Blend': 3 } },
    ],
  },
  "Men's Outerwear": {
    gender: 'men',
    weight: 22,
    subcategories: [
      { name: 'Wool Overcoat', price: 149, en: ['Wool Overcoat', 'Wool Coat', 'Crombie Coat', 'Single Breasted Coat'], fr: { words: ['manteau en laine', 'manteau laine', 'pardessus'], n: 'm' }, materials: { 'Wool Blend': 5, Wool: 3, 'Wool-Cashmere Blend': 2 } },
      { name: 'Puffer Jacket', price: 79, en: ['Puffer Jacket', 'Padded Jacket', 'Down Jacket'], fr: { words: ['doudoune', 'doudoune matelassée'], n: 'f' }, materials: { 'Recycled Polyester': 5, Down: 3, Nylon: 2 } },
      { name: 'Bomber Jacket', price: 69, en: ['Bomber Jacket', 'Bomber', 'Harrington Jacket'], fr: { words: ['bomber', 'blouson', 'blouson bomber'], n: 'm' }, materials: { Polyester: 4, Nylon: 3, 'Faux Suede': 2 } },
      { name: 'Parka', price: 99, en: ['Parka', 'Hooded Parka', 'Fishtail Parka'], fr: { words: ['parka', 'parka à capuche'], n: 'f' }, materials: { Polyester: 4, 'Cotton Blend': 3 } },
      { name: 'Field Jacket', price: 89, en: ['Field Jacket', 'Utility Jacket', 'Chore Jacket'], fr: { words: ['veste de travail', 'veste militaire'], n: 'f' }, materials: { Cotton: 4, 'Cotton Blend': 3, Corduroy: 1 } },
      { name: 'Trench Coat', price: 119, en: ['Trench Coat', 'Classic Trench'], fr: { words: ['trench', 'trench-coat'], n: 'm' }, materials: { 'Cotton Blend': 4, Polyester: 2 } },
      { name: 'Blazer', price: 99, en: ['Blazer', 'Tailored Blazer', 'Suit Jacket'], fr: { words: ['blazer', 'veste de costume'], n: 'm' }, materials: { 'Wool Blend': 4, 'Linen Blend': 2, 'Polyester Blend': 2 } },
      { name: 'Overshirt', price: 49, en: ['Overshirt', 'Shacket', 'Shirt Jacket'], fr: { words: ['surchemise', 'veste chemise'], n: 'f' }, materials: { Corduroy: 3, 'Wool Blend': 3, Cotton: 3 } },
      { name: 'Quilted Jacket', price: 69, en: ['Quilted Jacket', 'Diamond Quilted Jacket'], fr: { words: ['veste matelassée'], n: 'f' }, materials: { 'Recycled Polyester': 4, Nylon: 2 } },
      { name: 'Biker Jacket', price: 129, en: ['Biker Jacket', 'Leather Jacket'], fr: { words: ['perfecto', 'veste en cuir', 'blouson cuir'], n: 'm' }, materials: { Leather: 4, 'Faux Leather': 4 } },
      { name: 'Gilet', price: 49, en: ['Gilet', 'Padded Gilet', 'Body Warmer'], fr: { words: ['doudoune sans manches', 'gilet matelassé'], n: 'm' }, materials: { 'Recycled Polyester': 4, Down: 2 } },
    ],
  },
  "Women's Knitwear": {
    gender: 'women',
    weight: 28,
    subcategories: [
      { name: 'Crew Neck Jumper', price: 39, en: ['Crew Neck Jumper', 'Knit Jumper', 'Sweater', 'Round Neck Knit'], fr: { words: ['pull col rond', 'pull en maille', 'pull'], n: 'm' }, materials: { 'Wool Blend': 4, Acrylic: 3, 'Cotton Blend': 3, 'Merino Wool': 2 } },
      { name: 'Cardigan', price: 45, en: ['Cardigan', 'Knit Cardigan', 'Button Up Cardigan'], fr: { words: ['cardigan', 'gilet en maille', 'gilet'], n: 'm' }, materials: { 'Wool Blend': 4, Acrylic: 3, 'Mohair Blend': 2, 'Cotton Blend': 2 } },
      { name: 'Turtleneck', price: 45, en: ['Turtleneck Jumper', 'Roll Neck Jumper', 'Polo Neck Knit'], fr: { words: ['pull col roulé', 'col roulé'], n: 'm' }, materials: { 'Merino Wool': 4, 'Wool Blend': 3, Cashmere: 2, Acrylic: 2 } },
      { name: 'V-Neck Jumper', price: 39, en: ['V Neck Jumper', 'V-Neck Sweater'], fr: { words: ['pull col V', 'pull décolleté V'], n: 'm' }, materials: { 'Wool Blend': 4, 'Cotton Blend': 3, Acrylic: 2 } },
      { name: 'Knitted Vest', price: 29, en: ['Knitted Vest', 'Sleeveless Jumper', 'Knit Tank'], fr: { words: ['débardeur en maille', 'pull sans manches'], n: 'm' }, materials: { 'Wool Blend': 3, Acrylic: 3, 'Cotton Blend': 2 } },
      { name: 'Cable Knit Jumper', price: 49, en: ['Cable Knit Jumper', 'Cable Knit Sweater', 'Chunky Knit'], fr: { words: ['pull maille torsadée', 'pull torsadé', 'pull grosse maille'], n: 'm' }, materials: { 'Wool Blend': 4, Lambswool: 3, Acrylic: 2 } },
      { name: 'Mock Neck Jumper', price: 39, en: ['Mock Neck Jumper', 'Funnel Neck Knit'], fr: { words: ['pull col montant', 'pull col cheminée'], n: 'm' }, materials: { 'Viscose Blend': 3, 'Wool Blend': 3, Acrylic: 2 } },
      { name: 'Wrap Cardigan', price: 55, en: ['Wrap Cardigan', 'Longline Cardigan', 'Belted Cardigan'], fr: { words: ['gilet long', 'cardigan long', 'gilet portefeuille'], n: 'm' }, materials: { 'Wool Blend': 3, 'Alpaca Blend': 3, 'Mohair Blend': 2 } },
      { name: 'Knitted Dress', price: 59, en: ['Knitted Dress', 'Jumper Dress', 'Knit Midi Dress'], fr: { words: ['robe en maille', 'robe pull'], n: 'f' }, materials: { 'Viscose Blend': 3, 'Wool Blend': 3, Acrylic: 2 } },
    ],
  },
  "Men's Knitwear": {
    gender: 'men',
    weight: 18,
    subcategories: [
      { name: 'Crew Neck Jumper', price: 39, en: ['Crew Neck Jumper', 'Knit Jumper', 'Sweater', 'Round Neck Knit'], fr: { words: ['pull col rond', 'pull en maille', 'pull'], n: 'm' }, materials: { 'Merino Wool': 4, Lambswool: 3, Cotton: 3, 'Wool Blend': 3 } },
      { name: 'Cardigan', price: 49, en: ['Cardigan', 'Knit Cardigan', 'Shawl Collar Cardigan'], fr: { words: ['cardigan', 'gilet en maille'], n: 'm' }, materials: { 'Wool Blend': 4, Lambswool: 3, 'Cotton Blend': 2 } },
      { name: 'Roll Neck Jumper', price: 49, en: ['Roll Neck Jumper', 'Turtleneck Jumper', 'Polo Neck Knit'], fr: { words: ['pull col roulé', 'col roulé'], n: 'm' }, materials: { 'Merino Wool': 4, Lambswool: 3, 'Wool Blend': 3 } },
      { name: 'V-Neck Jumper', price: 39, en: ['V Neck Jumper', 'V-Neck Sweater'], fr: { words: ['pull col V'], n: 'm' }, materials: { 'Merino Wool': 3, Cotton: 3, 'Wool Blend': 3 } },
      { name: 'Half Zip Jumper', price: 45, en: ['Half Zip Jumper', 'Quarter Zip Knit', 'Zip Neck Jumper'], fr: { words: ['pull demi-zip', 'pull col zippé'], n: 'm' }, materials: { 'Wool Blend': 4, 'Merino Wool': 3, 'Cotton Blend': 2 } },
      { name: 'Cable Knit Jumper', price: 49, en: ['Cable Knit Jumper', 'Cable Knit Sweater', 'Chunky Cable Knit'], fr: { words: ['pull maille torsadée', 'pull torsadé', 'pull grosse maille'], n: 'm' }, materials: { 'Wool Blend': 4, Lambswool: 3, Acrylic: 2 } },
      { name: 'Knitted Polo', price: 45, en: ['Knitted Polo', 'Polo Knit', 'Knitted Polo Shirt'], fr: { words: ['polo en maille', 'polo tricot'], n: 'm' }, materials: { 'Cotton Blend': 4, 'Merino Wool': 2, 'Linen Blend': 2 } },
      { name: 'Knitted Vest', price: 35, en: ['Knitted Vest', 'Sleeveless Jumper', 'Knit Tank'], fr: { words: ['débardeur en maille', 'pull sans manches'], n: 'm' }, materials: { 'Wool Blend': 3, Lambswool: 2, 'Cotton Blend': 2 } },
    ],
  },
};

const CATEGORY_WEIGHTS = Object.fromEntries(
  Object.entries(CATEGORIES).map(([name, c]) => [name, c.weight])
);

// ---------------------------------------------------------------------------
// Colours. fr.m / fr.f carry the adjective agreement where French inflects it.
// ---------------------------------------------------------------------------

const COLOURS = [
  { name: 'Black', weight: 20, fr: { m: 'noir', f: 'noire' } },
  { name: 'Navy', weight: 12, fr: { m: 'bleu marine', f: 'bleu marine' } },
  { name: 'Ecru', weight: 7, fr: { m: 'écru', f: 'écrue' } },
  { name: 'Camel', weight: 9, fr: { m: 'camel', f: 'camel' } },
  { name: 'Beige', weight: 8, fr: { m: 'beige', f: 'beige' } },
  { name: 'Grey Marl', weight: 8, fr: { m: 'gris chiné', f: 'grise chinée' } },
  { name: 'Charcoal', weight: 6, fr: { m: 'gris anthracite', f: 'gris anthracite' } },
  { name: 'Cream', weight: 7, fr: { m: 'crème', f: 'crème' } },
  { name: 'Khaki', weight: 7, fr: { m: 'kaki', f: 'kaki' } },
  { name: 'Burgundy', weight: 6, fr: { m: 'bordeaux', f: 'bordeaux' } },
  { name: 'Forest Green', weight: 5, fr: { m: 'vert forêt', f: 'vert forêt' } },
  { name: 'Chocolate Brown', weight: 6, fr: { m: 'marron chocolat', f: 'marron chocolat' } },
  { name: 'Rust', weight: 4, fr: { m: 'rouille', f: 'rouille' } },
  { name: 'Dusty Pink', weight: 5, fr: { m: 'rose poudré', f: 'rose poudré' } },
  { name: 'Off White', weight: 6, fr: { m: 'blanc cassé', f: 'blanc cassé' } },
  { name: 'Stone', weight: 4, fr: { m: 'pierre', f: 'pierre' } },
  { name: 'Oatmeal', weight: 4, fr: { m: 'avoine', f: 'avoine' } },
  { name: 'Sage', weight: 4, fr: { m: 'vert sauge', f: 'vert sauge' } },
  { name: 'Mustard', weight: 3, fr: { m: 'moutarde', f: 'moutarde' } },
  { name: 'Ice Blue', weight: 3, fr: { m: 'bleu glacier', f: 'bleu glacier' } },
  { name: 'Taupe', weight: 4, fr: { m: 'taupe', f: 'taupe' } },
];

const COLOUR_BY_NAME = Object.fromEntries(COLOURS.map((c) => [c.name, c]));
const COLOUR_WEIGHTS = Object.fromEntries(COLOURS.map((c) => [c.name, c.weight]));

/** Colours a matcher should treat as near-neighbours, used for planted near-misses. */
const COLOUR_NEIGHBOURS = {
  Camel: ['Beige', 'Oatmeal', 'Stone'],
  Beige: ['Camel', 'Oatmeal', 'Stone'],
  Ecru: ['Cream', 'Off White', 'Oatmeal'],
  Cream: ['Ecru', 'Off White', 'Oatmeal'],
  'Off White': ['Cream', 'Ecru'],
  Black: ['Charcoal'],
  Charcoal: ['Black', 'Grey Marl'],
  'Grey Marl': ['Charcoal', 'Stone'],
  Navy: ['Charcoal', 'Ice Blue'],
  'Chocolate Brown': ['Rust', 'Taupe', 'Camel'],
  Khaki: ['Sage', 'Forest Green'],
};

// ---------------------------------------------------------------------------
// Sizes. Sellers write the same size five different ways; the size field keeps
// whatever the seller wrote rather than normalising it.
// ---------------------------------------------------------------------------

const SIZES = {
  women: {
    alpha: ['XS', 'S', 'M', 'L', 'XL'],
    eu: ['32', '34', '36', '38', '40', '42', '44'],
    word: ['Extra Small', 'Small', 'Medium', 'Large'],
    fr: ['T.36', 'T.38', 'T.40', 'T1', 'T2', 'T3', 'Taille 38', 'Taille 40'],
    uk: ['UK 6', 'UK 8', 'UK 10', 'UK 12', 'UK 14'],
  },
  men: {
    alpha: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    eu: ['44', '46', '48', '50', '52', '54'],
    word: ['Small', 'Medium', 'Large', 'Extra Large'],
    fr: ['T.48', 'T.50', 'T.52', 'T2', 'T3', 'Taille 50'],
    uk: ['UK 38', 'UK 40', 'UK 42', 'UK 44'],
  },
};

const SIZE_STYLE_WEIGHTS = { alpha: 44, eu: 22, word: 12, fr: 14, uk: 8 };

function randomSize(gender) {
  return pick(SIZES[gender][weighted(SIZE_STYLE_WEIGHTS)]);
}

// ---------------------------------------------------------------------------
// Condition, marketplaces, countries
// ---------------------------------------------------------------------------

const CONDITIONS = {
  'new with tags': { weight: 12, priceFactor: 0.62 },
  'very good': { weight: 38, priceFactor: 0.45 },
  good: { weight: 36, priceFactor: 0.33 },
  satisfactory: { weight: 14, priceFactor: 0.22 },
};

const CONDITION_WEIGHTS = Object.fromEntries(
  Object.entries(CONDITIONS).map(([k, v]) => [k, v.weight])
);

const MARKETPLACES = {
  Vinted: {
    weight: 40,
    priceFactor: 1.0,
    countries: { FR: 38, DE: 20, BE: 10, ES: 8, IT: 7, NL: 7, LT: 5, PL: 5 },
    frenchBias: 0.45,
  },
  'Vestiaire Collective': {
    weight: 16,
    priceFactor: 1.25,
    countries: { FR: 45, IT: 15, GB: 15, DE: 10, ES: 8, BE: 7 },
    frenchBias: 0.2,
  },
  eBay: {
    weight: 20,
    priceFactor: 0.95,
    countries: { DE: 30, GB: 25, FR: 22, IT: 12, ES: 11 },
    frenchBias: 0.15,
  },
  'Emmaüs': {
    weight: 10,
    priceFactor: 0.5,
    countries: { FR: 100 },
    frenchBias: 0.85,
  },
  Leboncoin: {
    weight: 14,
    priceFactor: 0.9,
    countries: { FR: 100 },
    frenchBias: 0.8,
  },
};

const MARKETPLACE_WEIGHTS = Object.fromEntries(
  Object.entries(MARKETPLACES).map(([k, v]) => [k, v.weight])
);

// ---------------------------------------------------------------------------
// Title construction — the messy bit
// ---------------------------------------------------------------------------

const NEW_ONLY_FILLER = new Set(['BNWT', 'NEW', 'NEUF', 'neuf avec étiquette', 'jamais porté', 'as new']);

const FILLER_EN = {
  prefix: ['RARE', 'STUNNING', 'Gorgeous', 'BNWT', 'NEW', 'Vintage', 'SOLD OUT'],
  suffix: [
    'VGC',
    'worn twice',
    'excellent condition',
    'immaculate',
    'BNWT',
    'sold out online',
    'free postage',
    'no reserve',
    'oversized fit',
    'super cosy',
    'as new',
    'bundle discount',
    'quick sale',
  ],
};

const FILLER_FR = {
  prefix: ['SUPERBE', 'Magnifique', 'NEUF', 'RARE', 'Très joli', 'Sublime'],
  suffix: [
    'TBE',
    'très bon état',
    'comme neuf',
    'neuf avec étiquette',
    'jamais porté',
    'état impeccable',
    'porté 2 fois',
    'prix ferme',
    'envoi rapide',
    'à saisir',
    'petit prix',
    'collection automne',
  ],
};

const EMOJI = ['❤️', '✨', '⭐', '🔥', '🤎', '🖤'];
const SEPARATORS = [' - ', ' | ', ' // ', ', ', ' – ', ' / ', ' * '];

/** Drops "brand new" wording from anything that has actually been worn. */
function fillerFor(pool, condition) {
  const unworn = condition === 'new with tags';
  const allowed = unworn ? pool : pool.filter((f) => !NEW_ONLY_FILLER.has(f));
  return pick(allowed.length ? allowed : pool);
}

function applyCaps(str, style) {
  switch (style) {
    case 'upper':
      return str.toUpperCase();
    case 'lower':
      return str.toLowerCase();
    case 'sentence':
      return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    case 'title':
      // Anchored on whitespace and matching \p{Ll} so accented letters inside a
      // word are left alone ("laine mélangée" -> "Laine Mélangée", not "MéLangéE").
      return str.replace(/(^|\s)(\p{Ll})/gu, (_, pre, ch) => pre + ch.toUpperCase());
    default:
      return str; // 'asis' — leave the mixture of cases alone
  }
}

/** The size as a seller would type it into a title, which is not the size field. */
function sizeToken(size, lang) {
  const bare = size.replace(/^(T\.|Taille |UK )/i, '');
  const forms = lang === 'fr'
    ? [`taille ${bare}`, `T.${bare}`, `T ${bare}`, size, `${size}`, `taille ${size}`]
    : [`size ${bare}`, `Size ${size}`, size, `${size}`, `sz ${bare}`, `(${size})`];
  return pick(forms);
}

/**
 * Builds a listing title. Options let the planted target matches force a
 * particular flavour (French, brand omitted, shouty caps) so the guaranteed
 * matches are still awkward enough to be worth testing against.
 */
function buildTitle(listing, sub, opts = {}) {
  const lang = opts.lang ?? (chance(opts.frenchBias ?? 0.3) ? 'fr' : 'en');
  const includeBrand = opts.includeBrand ?? chance(0.8);
  const capsStyle =
    opts.caps ??
    weighted({ asis: 34, title: 24, lower: 16, upper: 14, sentence: 12 });

  const brandDef = BRANDS[listing.brand];
  const genderVariants = brandDef.variants[CATEGORIES[listing.category].gender] ?? [];
  const brandToken = chance(0.25) && genderVariants.length
    ? pick(genderVariants)
    : pick(brandDef.variants.any);

  const colour = COLOUR_BY_NAME[listing.colour];
  let garment;
  let colourToken;

  if (lang === 'fr') {
    garment = pick(sub.fr.words);
    colourToken = colour.fr[sub.fr.n];
  } else {
    garment = pick(sub.en);
    colourToken = listing.colour;
  }

  const parts = [];

  // Sellers lead with shouty filler surprisingly often.
  if (chance(0.16)) {
    parts.push(fillerFor(lang === 'fr' ? FILLER_FR.prefix : FILLER_EN.prefix, listing.condition));
  }

  // Brand sometimes comes first, sometimes after the garment, sometimes never.
  const brandFirst = chance(0.7);
  if (includeBrand && brandFirst) parts.push(brandToken.trim());

  // Colour before or after the garment, or omitted entirely.
  const colourPlacement = weighted({ before: 30, after: 45, none: 25 });
  if (colourPlacement === 'before') parts.push(`${colourToken} ${garment}`);
  else if (colourPlacement === 'after') parts.push(`${garment} ${colourToken}`);
  else parts.push(garment);

  if (includeBrand && !brandFirst) parts.push(brandToken.trim());

  // Material mentioned about a third of the time.
  if (chance(0.3)) {
    const mat = lang === 'fr' ? frenchMaterial(listing.material) : listing.material;
    if (mat) parts.push(mat);
  }

  // Size in the title roughly half the time, written however the seller felt.
  if (opts.sizeInTitle ?? chance(0.52)) parts.push(sizeToken(listing.size, lang));

  if (chance(0.34)) {
    parts.push(fillerFor(lang === 'fr' ? FILLER_FR.suffix : FILLER_EN.suffix, listing.condition));
  }

  // Occasional RRP shout, which is noise a price-aware matcher has to ignore.
  if (chance(0.08)) {
    parts.push(
      lang === 'fr'
        ? `px boutique ${Math.round(listing.original_price_estimate)}€`
        : `RRP €${Math.round(listing.original_price_estimate)}`
    );
  }

  let title = parts.join(pick(SEPARATORS));
  title = applyCaps(title, capsStyle);

  if (chance(0.07)) title += ` ${pick(EMOJI)}`;
  if (chance(0.05)) title += pick(['!!', '!!!', ' !', '...']);
  if (chance(0.04)) title = title.replace(/\s+/g, '  '); // stray double spaces

  return title.trim();
}

const MATERIAL_FR = {
  Wool: 'laine',
  'Wool Blend': 'laine mélangée',
  'Wool-Cashmere Blend': 'laine et cachemire',
  'Merino Wool': 'laine mérinos',
  Lambswool: 'laine d agneau',
  Cashmere: 'cachemire',
  Cotton: 'coton',
  'Cotton Blend': 'coton mélangé',
  Polyester: 'polyester',
  'Polyester Blend': 'polyester mélangé',
  'Recycled Polyester': 'polyester recyclé',
  Acrylic: 'acrylique',
  'Acrylic Blend': 'acrylique mélangé',
  'Alpaca Blend': 'alpaga',
  'Mohair Blend': 'mohair',
  'Faux Leather': 'simili cuir',
  Leather: 'cuir',
  'Faux Fur': 'fausse fourrure',
  'Faux Shearling': 'peau lainée',
  'Faux Suede': 'suédine',
  Down: 'duvet',
  Nylon: 'nylon',
  'Linen Blend': 'lin mélangé',
  'Viscose Blend': 'viscose',
  Corduroy: 'velours côtelé',
};

function frenchMaterial(material) {
  return MATERIAL_FR[material] ?? material.toLowerCase();
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** Round to a retail-looking ending: 39.99, 49.95, 129.00. */
function retailRound(value) {
  if (value >= 100) return Math.round(value / 10) * 10 - (chance(0.5) ? 0 : 0.05);
  const base = Math.round(value);
  return base - (chance(0.5) ? 0.01 : 0.05);
}

/** Round to what a private seller actually types: 25, 27.50, 34.90, 19.99. */
function resaleRound(value) {
  const v = Math.max(4, value);
  const style = weighted({ whole: 52, half: 12, ninety: 20, ninetynine: 16 });
  switch (style) {
    case 'whole':
      return Math.round(v);
    case 'half':
      return Math.round(v * 2) / 2;
    case 'ninety':
      return Math.floor(v) + 0.9;
    default:
      return Math.floor(v) + 0.99;
  }
}

function money(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const VINTED_DOMAIN = { FR: 'fr', DE: 'de', BE: 'be', ES: 'es', IT: 'it', NL: 'nl', LT: 'lt', PL: 'pl' };
const EBAY_DOMAIN = { FR: 'ebay.fr', DE: 'ebay.de', GB: 'ebay.co.uk', IT: 'ebay.it', ES: 'ebay.es' };

const VC_COAT_SUBS = new Set([
  'Wool Coat', 'Wool Overcoat', 'Trench Coat', 'Parka', 'Cape', 'Faux Fur Coat',
]);

function buildListingUrl(listing) {
  // Vestiaire Collective builds slugs from its own structured catalogue fields;
  // Vinted and Emmaüs slugify whatever the seller typed as the title.
  const structuredSlug = slugify(`${listing.brand} ${listing.colour} ${listing.subcategory}`);
  const titleSlug = slugify(listing.title).slice(0, 60) || structuredSlug;
  const gender = CATEGORIES[listing.category].gender;

  switch (listing.marketplace) {
    case 'Vinted': {
      const tld = VINTED_DOMAIN[listing.seller_country] ?? 'fr';
      return `https://www.vinted.${tld}/items/${digits(9)}-${titleSlug}`;
    }
    case 'Vestiaire Collective': {
      const section = listing.category.includes('Knitwear')
        ? 'knitwear'
        : VC_COAT_SUBS.has(listing.subcategory)
          ? 'coats'
          : 'jackets';
      return `https://www.vestiairecollective.com/${gender}-clothing/${section}/${slugify(listing.brand)}/${structuredSlug}-${digits(8)}.shtml`;
    }
    case 'eBay': {
      const domain = EBAY_DOMAIN[listing.seller_country] ?? 'ebay.fr';
      return `https://www.${domain}/itm/${digits(12)}`;
    }
    case 'Emmaüs':
      return `https://www.label-emmaus.co/fr/boutique/${titleSlug}-${digits(6)}/`;
    case 'Leboncoin':
      return `https://www.leboncoin.fr/ad/vetements/${digits(10)}`;
    default:
      return `https://example.com/${structuredSlug}`;
  }
}

function buildImageUrl(token) {
  // picsum.photos resolves, so the dataset renders in a UI without shipping binaries.
  return `https://picsum.photos/seed/${token}/600/800`;
}

function postedDate() {
  // Skewed towards recent: most listings on these sites are days or weeks old.
  const daysBack = Math.floor(Math.pow(rand(), 1.8) * 150);
  const d = new Date(REFERENCE_DATE.getTime() - daysBack * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Listing construction
// ---------------------------------------------------------------------------

let photoCounter = 0;

function makeListing(overrides = {}, titleOpts = {}) {
  const category = overrides.category ?? weighted(CATEGORY_WEIGHTS);
  const catDef = CATEGORIES[category];
  const gender = catDef.gender;

  // Sézane has no menswear, so redraw the brand until it fits the category.
  let brand = overrides.brand;
  if (!brand) {
    do {
      brand = weighted(BRAND_WEIGHTS);
    } while (!BRANDS[brand].genders.includes(gender));
  }

  const sub = overrides.subcategory
    ? catDef.subcategories.find((s) => s.name === overrides.subcategory)
    : pick(catDef.subcategories);

  if (!sub) {
    throw new Error(`Unknown subcategory "${overrides.subcategory}" for category "${category}"`);
  }

  const colour = overrides.colour ?? weighted(COLOUR_WEIGHTS);
  const material = overrides.material ?? weighted(sub.materials);
  const size = overrides.size ?? randomSize(gender);
  const condition = overrides.condition ?? weighted(CONDITION_WEIGHTS);
  const marketplace = overrides.marketplace ?? weighted(MARKETPLACE_WEIGHTS);
  const mp = MARKETPLACES[marketplace];
  const seller_country = overrides.seller_country ?? weighted(mp.countries);

  // Retail estimate, then discount it by condition, marketplace and a bit of noise.
  const retail = overrides.original_price_estimate
    ?? retailRound(sub.price * BRANDS[brand].tier);
  const jitter = 0.82 + rand() * 0.45;
  const raw = overrides.price
    ?? retail * CONDITIONS[condition].priceFactor * mp.priceFactor * jitter;
  let price = resaleRound(raw);
  // A resale price above the retail estimate would be nonsense.
  if (price > retail * 0.92) price = resaleRound(retail * 0.6);

  const listing = {
    id: null, // assigned after the final shuffle
    title: null,
    brand,
    category,
    subcategory: sub.name,
    colour,
    material,
    size,
    condition,
    price: money(price),
    original_price_estimate: money(retail),
    marketplace,
    listing_url: null,
    image_url: buildImageUrl(`rd-${SEED}-${photoCounter++}`),
    posted_date: overrides.posted_date ?? postedDate(),
    seller_country,
  };

  listing.title = buildTitle(listing, sub, {
    frenchBias: mp.frenchBias,
    ...titleOpts,
  });
  listing.listing_url = buildListingUrl(listing); // needs listing.title

  return listing;
}

// ---------------------------------------------------------------------------
// Planted matches for targets.json
// ---------------------------------------------------------------------------

const ALPHA_TO_EU = {
  women: { XS: '34', S: '36', M: '38', L: '40', XL: '42' },
  men: { XS: '44', S: '46', M: '48', L: '50', XL: '52', XXL: '54' },
};

const ALPHA_TO_WORD = {
  XS: 'Extra Small', S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra Large', XXL: 'XXL',
};

/**
 * Takes a size the target actually stocks and rewrites it the way some other
 * seller would have typed it. "M" becomes "38", "Medium" or "T.38".
 */
function restyleSize(size, gender) {
  const style = weighted({ same: 34, eu: 26, word: 20, fr: 20 });
  if (style === 'same') return size;
  const eu = ALPHA_TO_EU[gender][size] ?? size;
  if (style === 'eu') return eu;
  if (style === 'word') return ALPHA_TO_WORD[size] ?? size;
  return chance(0.5) ? `T.${eu}` : `Taille ${eu}`;
}

/**
 * Two or three listings per target that a matcher should find. They are
 * deliberately awkward: one is French with the brand present, one is English
 * with no brand in the title at all, and the optional third drifts on colour
 * or material so it sits just below the strong ones.
 */
function plantMatchesFor(target) {
  const catDef = CATEGORIES[target.category];
  if (!catDef) throw new Error(`${target.id}: unknown category "${target.category}"`);
  const gender = catDef.gender;
  const planted = [];

  const baseSize = pick(target.sizes_available);

  // 1. Strong match, French title, brand present, shouty caps half the time.
  planted.push(
    makeListing(
      {
        brand: target.brand,
        category: target.category,
        subcategory: target.subcategory,
        colour: target.colour,
        material: target.material,
        size: restyleSize(baseSize, gender),
        condition: weighted({ 'very good': 55, 'new with tags': 20, good: 25 }),
        marketplace: weighted({ Vinted: 55, Leboncoin: 20, 'Vestiaire Collective': 15, 'Emmaüs': 10 }),
        original_price_estimate: target.retail_price_eur,
      },
      {
        lang: 'fr',
        includeBrand: true,
        caps: weighted({ asis: 30, upper: 25, lower: 25, title: 20 }),
        sizeInTitle: true,
      }
    )
  );

  // 2. Strong match, English title, brand left out entirely.
  planted.push(
    makeListing(
      {
        brand: target.brand,
        category: target.category,
        subcategory: target.subcategory,
        colour: target.colour,
        material: target.material,
        size: restyleSize(pick(target.sizes_available), gender),
        condition: weighted({ good: 45, 'very good': 40, satisfactory: 15 }),
        marketplace: weighted({ Vinted: 40, eBay: 35, 'Vestiaire Collective': 25 }),
        original_price_estimate: target.retail_price_eur,
      },
      {
        lang: 'en',
        includeBrand: false,
        caps: weighted({ lower: 40, asis: 30, title: 30 }),
        sizeInTitle: chance(0.7),
      }
    )
  );

  // 3. Weaker but still plausible: same garment, neighbouring colour.
  if (chance(0.7)) {
    const neighbours = COLOUR_NEIGHBOURS[target.colour] ?? [];
    planted.push(
      makeListing(
        {
          brand: target.brand,
          category: target.category,
          subcategory: target.subcategory,
          colour: neighbours.length ? pick(neighbours) : target.colour,
          size: restyleSize(pick(target.sizes_available), gender),
          original_price_estimate: target.retail_price_eur,
        },
        { sizeInTitle: chance(0.5) }
      )
    );
  }

  return planted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadTargets() {
  if (!fs.existsSync(TARGETS_FILE)) {
    console.warn('! targets.json not found — generating listings without planted matches.');
    return null;
  }
  return JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
}

function summarise(listings) {
  const tally = (key) =>
    listings.reduce((acc, l) => {
      acc[l[key]] = (acc[l[key]] ?? 0) + 1;
      return acc;
    }, {});
  const line = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');

  console.log(`\n  brands       ${line(tally('brand'))}`);
  console.log(`  categories   ${line(tally('category'))}`);
  console.log(`  marketplaces ${line(tally('marketplace'))}`);
  console.log(`  conditions   ${line(tally('condition'))}`);

  const frenchish = listings.filter((l) =>
    /manteau|doudoune|veste|pull|gilet|maille|laine|surchemise|taille|blouson|cardigan long|robe/i.test(l.title)
  ).length;
  const deaccent = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const noBrand = listings.filter((l) => {
    const pattern = deaccent(l.brand).replace(/[&.]/g, '.?').replace(/\s+/g, '\\s*');
    return !new RegExp(pattern, 'i').test(deaccent(l.title));
  }).length;
  const withSize = listings.filter((l) =>
    /\b(?:size|sz|taille|t\.|uk)\b|\b(?:XS|S|M|L|XL|XXL)\b|\b(?:3[2-9]|4[0-9]|5[0-4])\b/i.test(l.title)
  ).length;

  console.log(`\n  titles with French wording   ${frenchish} (${Math.round((frenchish / listings.length) * 100)}%)`);
  console.log(`  titles missing the brand     ${noBrand} (${Math.round((noBrand / listings.length) * 100)}%)`);
  console.log(`  titles carrying a size       ${withSize} (${Math.round((withSize / listings.length) * 100)}%)`);
}

function main() {
  const targetsDoc = loadTargets();
  const listings = [];
  const plantedByTarget = new Map();

  if (targetsDoc) {
    for (const target of targetsDoc.targets) {
      const planted = plantMatchesFor(target);
      planted.forEach((l, i) => {
        l.__strength = i < 2 ? 'strong' : 'near';
      });
      plantedByTarget.set(target.id, planted);
      listings.push(...planted);
    }
  }

  while (listings.length < TOTAL) listings.push(makeListing());

  const ordered = shuffle(listings).slice(0, TOTAL);
  ordered.forEach((l, i) => {
    l.id = `ls-${String(i + 1).padStart(4, '0')}`;
  });

  // Every planted listing must survive into the final set, or the ground truth lies.
  for (const [targetId, planted] of plantedByTarget) {
    const missing = planted.filter((l) => !l.id);
    if (missing.length) {
      throw new Error(
        `${targetId}: ${missing.length} planted listing(s) fell outside --count=${TOTAL}. Raise the count.`
      );
    }
  }

  const output = ordered.map(({ __strength, ...rest }) => rest);
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`✓ wrote ${output.length} listings to ${path.basename(OUT_FILE)}`);

  if (targetsDoc) {
    for (const target of targetsDoc.targets) {
      const planted = plantedByTarget.get(target.id) ?? [];
      target.expected_match_ids = planted.filter((l) => l.__strength === 'strong').map((l) => l.id);
      target.expected_near_match_ids = planted.filter((l) => l.__strength === 'near').map((l) => l.id);
    }
    targetsDoc.note =
      'Target products to match against listings.json. URLs follow each retailer’s real ' +
      'product-page format. expected_match_ids lists listings planted as strong matches ' +
      '(same brand, subcategory, colour and material, messy title); expected_near_match_ids ' +
      'lists deliberate near-misses that drift on colour. Both are rewritten by generate-seed.js.';
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(targetsDoc, null, 2) + '\n');

    console.log(`✓ wrote ground-truth match ids back to targets.json\n`);
    for (const target of targetsDoc.targets) {
      const strong = target.expected_match_ids.length;
      const near = target.expected_near_match_ids.length;
      const flag = strong >= 1 ? ' ' : '!';
      console.log(
        `  ${flag} ${target.id}  ${String(target.brand).padEnd(13)} ${strong} strong, ${near} near  → ${target.expected_match_ids.join(', ')}`
      );
    }
    const weak = targetsDoc.targets.filter((t) => t.expected_match_ids.length < 1);
    if (weak.length) throw new Error(`Targets without a strong match: ${weak.map((t) => t.id).join(', ')}`);
  }

  summarise(output);
  console.log('');
}

module.exports = {
  CATEGORIES,
  COLOURS,
  COLOUR_NEIGHBOURS,
  BRANDS,
  CONDITIONS,
  MARKETPLACES,
  MATERIAL_FR,
  makeListing,
  buildTitle,
  main,
};

// Only regenerate when run directly — fetch-ebay.js imports the taxonomy above.
if (require.main === module) main();
