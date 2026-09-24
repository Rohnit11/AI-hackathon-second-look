#!/usr/bin/env node
'use strict';

/**
 * fetch-ebay.js
 *
 * Queries the eBay Browse API for the same slice of the market that
 * generate-seed.js fakes — women's and men's outerwear and knitwear from Zara,
 * Mango, COS, Uniqlo, H&M, Sézane and Massimo Dutti — and appends the real
 * listings to listings.json in exactly the same schema.
 *
 * Credentials come from .env (see .env.example). If they are missing the script
 * logs why and exits 0, so `npm run build` still works on a fresh clone.
 *
 * eBay's item_summary/search returns less structured data than the seed
 * generator invents: there is no brand, size, colour or material field on a
 * search result. Those get parsed out of the title, which is exactly the messy
 * input this dataset exists to exercise. Anything unparseable is recorded as
 * "Unspecified" rather than guessed.
 */

const fs = require('fs');
const path = require('path');

const LISTINGS_FILE = path.join(__dirname, 'listings.json');
const ENV_FILE = path.join(__dirname, '.env');

// ---------------------------------------------------------------------------
// .env loading (no dependencies)
// ---------------------------------------------------------------------------

function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    // Strip matching quotes, and anything after an unquoted #.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    // Real environment variables win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const envFileFound = loadEnv(ENV_FILE);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLIENT_ID = (process.env.EBAY_CLIENT_ID ?? '').trim();
const CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET ?? '').trim();
const EBAY_ENV = (process.env.EBAY_ENV ?? 'production').trim().toLowerCase();
const MARKETPLACE_ID = (process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_FR').trim();
const LIMIT_PER_QUERY = clampInt(process.env.EBAY_LIMIT_PER_QUERY, 10, 1, 200);
const MAX_ITEMS = clampInt(process.env.EBAY_MAX_ITEMS, 200, 1, 10000);
const REQUEST_DELAY_MS = clampInt(process.env.EBAY_REQUEST_DELAY_MS, 250, 0, 10000);
const DISABLE_CATEGORY_FILTER =
  String(process.env.EBAY_DISABLE_CATEGORY_FILTER ?? 'false').toLowerCase() === 'true';

const HOSTS = {
  production: { api: 'https://api.ebay.com', label: 'production' },
  sandbox: { api: 'https://api.sandbox.ebay.com', label: 'sandbox' },
};
const HOST = HOSTS[EBAY_ENV] ?? HOSTS.production;

// Marketplace -> the currency and default seller country we expect back.
const MARKETPLACE_META = {
  EBAY_FR: { currency: 'EUR', country: 'FR', lang: 'fr-FR' },
  EBAY_DE: { currency: 'EUR', country: 'DE', lang: 'de-DE' },
  EBAY_ES: { currency: 'EUR', country: 'ES', lang: 'es-ES' },
  EBAY_IT: { currency: 'EUR', country: 'IT', lang: 'it-IT' },
  EBAY_GB: { currency: 'GBP', country: 'GB', lang: 'en-GB' },
  EBAY_US: { currency: 'USD', country: 'US', lang: 'en-US' },
};
const MARKET = MARKETPLACE_META[MARKETPLACE_ID] ?? MARKETPLACE_META.EBAY_FR;

// Rough conversion, only used when eBay returns a currency other than EUR.
// Good enough for a comparison dataset; not a finance-grade rate.
const FX_TO_EUR = { EUR: 1, GBP: 1.17, USD: 0.92, CHF: 1.05, PLN: 0.23, SEK: 0.088, DKK: 0.134 };

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Queries: seven brands x four category buckets
// ---------------------------------------------------------------------------
// The category ids come from eBay's US category tree, which the Browse API
// accepts for the European marketplaces too. If a marketplace rejects them or
// over-filters, set EBAY_DISABLE_CATEGORY_FILTER=true and search on keywords.

const CATEGORY_BUCKETS = [
  {
    category: "Women's Outerwear",
    categoryIds: '63862',
    terms: ['coat', 'jacket'],
  },
  {
    category: "Women's Knitwear",
    categoryIds: '63866',
    terms: ['jumper', 'cardigan'],
  },
  {
    category: "Men's Outerwear",
    categoryIds: '57988',
    terms: ['coat', 'jacket'],
  },
  {
    category: "Men's Knitwear",
    categoryIds: '11484',
    terms: ['jumper', 'sweater'],
  },
];

const BRANDS = ['Zara', 'Mango', 'COS', 'Uniqlo', 'H&M', 'Sézane', 'Massimo Dutti'];

function buildQueries() {
  const queries = [];
  for (const bucket of CATEGORY_BUCKETS) {
    for (const brand of BRANDS) {
      queries.push({
        brand,
        category: bucket.category,
        categoryIds: bucket.categoryIds,
        q: `${brand} ${bucket.terms[0]}`,
      });
    }
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Parsing eBay titles back into our schema
// ---------------------------------------------------------------------------
// The taxonomy is shared with generate-seed.js so both sources speak the same
// vocabulary and a match can be made across them.

const { CATEGORIES, BRANDS: BRAND_DEFS } = require('./generate-seed.js');

const ALLOWED_SUBCATEGORIES = Object.fromEntries(
  Object.entries(CATEGORIES).map(([name, def]) => [
    name,
    new Set(def.subcategories.map((s) => s.name)),
  ])
);

const deaccent = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

const norm = (s) => deaccent(s).toLowerCase();

// Ordered: the most specific pattern has to win, so "bleu marine" is checked
// before "bleu" and "blanc casse" before "blanc".
const COLOUR_RULES = [
  [/grey marl|gray marl|gris chine|marl/, 'Grey Marl'],
  [/blanc casse|off.?white|ivory/, 'Off White'],
  [/bleu marine|navy|marine/, 'Navy'],
  [/bleu glacier|ice blue/, 'Ice Blue'],
  [/vert foret|forest green|vert sapin/, 'Forest Green'],
  [/vert sauge|sage/, 'Sage'],
  [/rose poudre|dusty pink|blush|rose/, 'Dusty Pink'],
  [/marron chocolat|chocolate|marron|brown|chocolat/, 'Chocolate Brown'],
  [/anthracite|charcoal/, 'Charcoal'],
  [/bordeaux|burgundy|wine/, 'Burgundy'],
  [/oatmeal|avoine/, 'Oatmeal'],
  [/mustard|moutarde/, 'Mustard'],
  [/taupe/, 'Taupe'],
  [/rouille|rust/, 'Rust'],
  [/camel/, 'Camel'],
  [/ecru/, 'Ecru'],
  [/creme|cream/, 'Cream'],
  [/beige/, 'Beige'],
  [/kaki|khaki/, 'Khaki'],
  [/stone|pierre/, 'Stone'],
  [/noir|black/, 'Black'],
  [/blanc|white/, 'Off White'],
  [/gris|grey|gray/, 'Grey Marl'],
];

const MATERIAL_RULES = [
  [/laine et cachemire|wool.?cashmere/, 'Wool-Cashmere Blend'],
  [/merino|merinos/, 'Merino Wool'],
  [/lambswool|laine d.?agneau/, 'Lambswool'],
  [/cashmere|cachemire/, 'Cashmere'],
  [/recycled polyester|polyester recycle/, 'Recycled Polyester'],
  [/wool blend|laine melangee|melange de laine/, 'Wool Blend'],
  [/velours cotele|corduroy|cord\b/, 'Corduroy'],
  [/fausse fourrure|faux fur|teddy/, 'Faux Fur'],
  [/peau lainee|shearling|sherpa|borg/, 'Faux Shearling'],
  [/simili cuir|faux leather|leatherette|effet cuir|similicuir/, 'Faux Leather'],
  [/suedine|faux suede|suede/, 'Faux Suede'],
  [/alpaga|alpaca/, 'Alpaca Blend'],
  [/mohair/, 'Mohair Blend'],
  [/acrylique|acrylic/, 'Acrylic'],
  [/viscose/, 'Viscose Blend'],
  [/\blin\b|linen/, 'Linen Blend'],
  [/duvet|\bdown\b/, 'Down'],
  [/nylon/, 'Nylon'],
  [/polyester/, 'Polyester'],
  [/cotton blend|coton melange/, 'Cotton Blend'],
  [/coton|cotton/, 'Cotton'],
  [/cuir|leather/, 'Leather'],
  [/laine|wool/, 'Wool'],
];

// Rules resolve to a subcategory name, sometimes depending on gender because
// the men's and women's taxonomies use different words for the same garment.
const OUTERWEAR_RULES = [
  [/trench|impermeable/, () => 'Trench Coat'],
  [/puffer|doudoune|padded|down jacket|piumino/, () => 'Puffer Jacket'],
  [/parka/, () => 'Parka'],
  [/biker|perfecto|moto jacket|leather jacket|veste en cuir|blouson cuir/, () => 'Biker Jacket'],
  [/bomber|harrington|blouson/, () => 'Bomber Jacket'],
  [/blazer|veste de tailleur|suit jacket|veste de costume/, () => 'Blazer'],
  [/overshirt|shacket|surchemise|shirt jacket|veste chemise/, () => 'Overshirt'],
  [/fausse fourrure|faux fur|teddy coat/, () => 'Faux Fur Coat'],
  [/shearling|aviator|aviateur|peau lainee/, () => 'Shearling Jacket'],
  [/field jacket|chore|utility|veste de travail|militaire/, () => 'Field Jacket'],
  [/gilet|body warmer|sans manches/, () => 'Gilet'],
  [/\bcape\b|poncho/, () => 'Cape'],
  [/quilted|matelass|capitonn/, () => 'Quilted Jacket'],
  [/overcoat|pardessus|crombie/, (g) => (g === 'men' ? 'Wool Overcoat' : 'Wool Coat')],
  [/coat|manteau|cappotto|abrigo/, (g) => (g === 'men' ? 'Wool Overcoat' : 'Wool Coat')],
];

const KNITWEAR_RULES = [
  [/cable ?knit|torsad|grosse maille|chunky knit/, () => 'Cable Knit Jumper'],
  [/turtle ?neck|roll ?neck|polo neck|col roule/, (g) => (g === 'men' ? 'Roll Neck Jumper' : 'Turtleneck')],
  [/half ?zip|quarter ?zip|1\/4 zip|zip neck|demi.?zip|col zippe/, (g) => (g === 'men' ? 'Half Zip Jumper' : 'Mock Neck Jumper')],
  [/cardigan|gilet/, () => 'Cardigan'],
  [/sleeveless|knit(ted)? vest|debardeur|sans manches|knit tank/, () => 'Knitted Vest'],
  [/v.?neck|col v/, () => 'V-Neck Jumper'],
  [/mock neck|funnel|col montant|col cheminee/, (g) => (g === 'men' ? 'Roll Neck Jumper' : 'Mock Neck Jumper')],
  [/\bpolo\b/, (g) => (g === 'men' ? 'Knitted Polo' : 'Crew Neck Jumper')],
  [/dress|robe/, (g) => (g === 'women' ? 'Knitted Dress' : 'Crew Neck Jumper')],
  [/crew ?neck|col rond|round neck/, () => 'Crew Neck Jumper'],
  [/jumper|sweater|pull|knit|maille|maglione/, () => 'Crew Neck Jumper'],
];

function firstMatch(rules, text) {
  for (const [re, value] of rules) if (re.test(text)) return value;
  return null;
}

function parseColour(title) {
  return firstMatch(COLOUR_RULES, norm(title)) ?? 'Unspecified';
}

function parseMaterial(title) {
  return firstMatch(MATERIAL_RULES, norm(title)) ?? 'Unspecified';
}

const DEFAULT_SUBCATEGORY = {
  "Women's Outerwear": 'Wool Coat',
  "Women's Knitwear": 'Crew Neck Jumper',
  "Men's Outerwear": 'Wool Overcoat',
  "Men's Knitwear": 'Crew Neck Jumper',
};

// "gilet" is deliberately in neither list: in French it means a cardigan, in
// English resale it means a body warmer.
const KNITWEAR_SIGNALS = /\b(jumper|sweater|cardigan|knitwear|knitted|knit|pullover|pull|maille|tricot|roll ?neck|turtle ?neck|col roule|maglione|strickjacke|jersey)\b/;
const OUTERWEAR_SIGNALS = /\b(coat|jacket|parka|trench|puffer|doudoune|manteau|blouson|blazer|overcoat|anorak|veste|surchemise|cappotto|giacca|mantel|jacke|abrigo|chaqueta|perfecto)\b/;

const MEN_SIGNALS = /\b(mens|men|homme|herren|uomo|hombre|gents|garcon)\b/;
const WOMEN_SIGNALS = /\b(womens|women|ladies|lady|femme|damen|donna|mujer|woman)\b/;

/**
 * eBay returns what its keyword search felt like returning, so the query bucket
 * is a hint rather than a fact. Override it only when the title is unambiguous
 * — one signal present and its opposite absent.
 */
function refineCategory(title, query) {
  const t = norm(title);

  let klass = query.category.includes('Knitwear') ? 'Knitwear' : 'Outerwear';
  const knit = KNITWEAR_SIGNALS.test(t);
  const outer = OUTERWEAR_SIGNALS.test(t);
  if (knit && !outer) klass = 'Knitwear';
  else if (outer && !knit) klass = 'Outerwear';

  let gender = CATEGORIES[query.category].gender;
  const men = MEN_SIGNALS.test(t);
  const women = WOMEN_SIGNALS.test(t);
  if (men && !women) gender = 'men';
  else if (women && !men) gender = 'women';

  const candidate = `${gender === 'men' ? "Men's" : "Women's"} ${klass}`;
  return CATEGORIES[candidate] ? candidate : query.category;
}

function parseSubcategory(title, category) {
  const gender = CATEGORIES[category].gender;
  const rules = category.includes('Knitwear') ? KNITWEAR_RULES : OUTERWEAR_RULES;
  const resolve = firstMatch(rules, norm(title));
  const candidate = resolve ? resolve(gender) : null;
  // Never emit a subcategory that does not exist in this category's taxonomy.
  if (candidate && ALLOWED_SUBCATEGORIES[category].has(candidate)) return candidate;
  return DEFAULT_SUBCATEGORY[category];
}

/**
 * Pulls the size out of the title, keeping the seller's own notation rather
 * than normalising it — the inconsistency is the point of this dataset.
 */
function parseSize(title) {
  const t = deaccent(title);
  const labelled = t.match(/\b(?:taille|size|sz|talla|taglia|gr)\s*[:.]?\s*(XXS|XS|XXL|XL|S|M|L|\d{1,2})\b/i);
  if (labelled) return labelled[1].length <= 3 ? labelled[1].toUpperCase() : labelled[1];

  const tPrefixed = t.match(/\bT\.?\s?(\d{1,2})\b/);
  if (tPrefixed) return `T.${tPrefixed[1]}`;

  const regional = t.match(/\b(UK|EU|FR|IT|US|DE)\s?(\d{1,2})\b/i);
  if (regional) return `${regional[1].toUpperCase()} ${regional[2]}`;

  const worded = t.match(/\b(extra small|extra large|x-?large|x-?small|small|medium|large)\b/i);
  if (worded) {
    return worded[1].replace(/\b\w/g, (c) => c.toUpperCase()).replace(/X-?(Large|Small)/i, 'Extra $1');
  }

  // Standalone letter size, only when clearly delimited so a stray "M" in a
  // word does not count.
  const alpha = t.match(/(?:^|[\s,\-\/|(\[])(XXS|XS|XXL|XL|S|M|L)(?=$|[\s,\-\/|)\]])/);
  if (alpha) return alpha[1].toUpperCase();

  const numeric = t.match(/(?:^|[\s,\-\/|(\[])(3[0-9]|4[0-9]|5[0-4])(?=$|[\s,\-\/|)\]])/);
  if (numeric) return numeric[1];

  return 'Unspecified';
}

function parseBrand(title, queryBrand) {
  const t = norm(title);
  const patterns = [
    ['Massimo Dutti', /massimo\s*-?\s*dut+i/],
    ['Sézane', /sezane/],
    ['Uniqlo', /uniqlo/],
    ['Mango', /\bmango\b|violeta/],
    ['Zara', /\bzara\b/],
    ['COS', /\bc\.?o\.?s\b/],
    ['H&M', /h\s*&\s*m|\bh ?and ?m\b|\bhm\b|divided/],
  ];
  // If the title names one of our brands, believe the title over the query
  // that happened to surface the item.
  for (const [brand, re] of patterns) if (re.test(t)) return brand;
  return queryBrand;
}

const CONDITION_FACTORS = {
  'new with tags': 0.62,
  'very good': 0.45,
  good: 0.33,
  satisfactory: 0.22,
};

function mapCondition(item) {
  const text = norm(item.condition ?? '');
  if (/new with tags|neuf avec etiquette|neu mit etikett/.test(text)) return 'new with tags';
  if (/new without tags|new other|neuf sans etiquette/.test(text)) return 'very good';
  if (/new with defects|defect/.test(text)) return 'good';
  if (/for parts|not working|damaged|pour pieces/.test(text)) return 'satisfactory';
  if (/refurb/.test(text)) return 'very good';
  if (/\bnew\b|\bneuf\b|\bneu\b/.test(text)) return 'new with tags';

  switch (String(item.conditionId ?? '')) {
    case '1000':
      return 'new with tags';
    case '1500':
    case '2000':
    case '2500':
    case '2750':
      return 'very good';
    case '1750':
    case '3000':
    case '4000':
      return 'good';
    case '5000':
    case '6000':
    case '7000':
      return 'satisfactory';
    default:
      // eBay's default apparel condition is "Pre-owned", which sits at "good".
      return 'good';
  }
}

function toEur(value, currency) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return null;
  const rate = FX_TO_EUR[currency];
  if (rate === undefined) return null;
  return Math.round(amount * rate * 100) / 100;
}

/** Work a plausible retail price back out of the resale price and condition. */
function estimateRetail(priceEur, condition) {
  const factor = CONDITION_FACTORS[condition] ?? 0.33;
  const raw = priceEur / factor;
  const capped = Math.min(Math.max(raw, priceEur * 1.2), 900);
  const rounded = capped >= 100 ? Math.round(capped / 10) * 10 : Math.round(capped / 5) * 5;
  return Math.max(rounded, Math.round(priceEur * 1.2 * 100) / 100);
}

// ---------------------------------------------------------------------------
// OAuth: client credentials grant
// ---------------------------------------------------------------------------

let cachedToken = null; // { value, expiresAt }

async function getToken({ force = false } = {}) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });

  const res = await fetch(`${HOST.api}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = `${parsed.error ?? res.status}: ${parsed.error_description ?? detail}`;
    } catch {
      /* keep the raw body */
    }
    throw new Error(`eBay OAuth failed (HTTP ${res.status}) — ${detail}`);
  }

  const json = JSON.parse(text);
  cachedToken = {
    value: json.access_token,
    // Refresh a minute early so a long run never uses a token mid-expiry.
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 7200) - 60) * 1000,
  };
  return cachedToken.value;
}

// ---------------------------------------------------------------------------
// Browse API search
// ---------------------------------------------------------------------------

const stats = {
  queriesRun: 0,
  queriesFailed: 0,
  itemsSeen: 0,
  skippedDuplicate: 0,
  skippedNoPrice: 0,
  appended: 0,
};

async function searchOnce(query, token) {
  const params = new URLSearchParams({
    q: query.q,
    limit: String(LIMIT_PER_QUERY),
    filter: [
      'buyingOptions:{FIXED_PRICE|AUCTION}',
      'conditions:{NEW|USED}',
      'price:[5..600]',
      `priceCurrency:${MARKET.currency}`,
    ].join(','),
    sort: 'newlyListed',
  });
  if (!DISABLE_CATEGORY_FILTER) params.set('category_ids', query.categoryIds);

  const res = await fetch(`${HOST.api}/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
      'Accept-Language': MARKET.lang,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(25000),
  });

  return res;
}

/** Runs one query, refreshing the token on a 401 and backing off on a 429. */
async function runQuery(query) {
  let forceNewToken = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await getToken({ force: forceNewToken });
    const res = await searchOnce(query, token);

    if (res.ok) return (await res.json()).itemSummaries ?? [];

    if (res.status === 401 && attempt < 2) {
      // Token rejected — drop it and get a fresh one before retrying.
      cachedToken = null;
      forceNewToken = true;
      continue;
    }
    if (res.status === 429 && attempt < 2) {
      const wait = 2000 * (attempt + 1);
      console.warn(`  rate limited, waiting ${wait}ms before retrying "${query.q}"`);
      await sleep(wait);
      continue;
    }

    const body = (await res.text()).slice(0, 250);
    throw new Error(`HTTP ${res.status} — ${body}`);
  }
  return [];
}

// ---------------------------------------------------------------------------
// eBay item -> listings.json schema
// ---------------------------------------------------------------------------

function mapItem(item, query) {
  const title = String(item.title ?? '').trim();
  if (!title) return null;

  const currency = item.price?.currency ?? MARKET.currency;
  const priceEur = toEur(item.price?.value, currency);
  if (priceEur === null || priceEur <= 0) return null;

  const condition = mapCondition(item);
  const originalFromEbay = toEur(
    item.marketingPrice?.originalPrice?.value,
    item.marketingPrice?.originalPrice?.currency ?? currency
  );
  const original =
    originalFromEbay && originalFromEbay > priceEur
      ? originalFromEbay
      : estimateRetail(priceEur, condition);

  const legacyId = item.legacyItemId ?? String(item.itemId ?? '').split('|')[1] ?? item.itemId;

  const brand = parseBrand(title, query.brand);
  let category = refineCategory(title, query);
  // Sézane makes no menswear, so a men's category under that brand is a
  // mis-read of the title rather than a real listing.
  if (!BRAND_DEFS[brand]?.genders.includes(CATEGORIES[category].gender)) {
    category = category.replace(/^(Men's|Women's)/, "Women's");
  }

  return {
    id: `ebay-${legacyId}`,
    title,
    brand,
    category,
    subcategory: parseSubcategory(title, category),
    colour: parseColour(title),
    material: parseMaterial(title),
    size: parseSize(title),
    condition,
    price: priceEur,
    original_price_estimate: Math.round(original * 100) / 100,
    marketplace: 'eBay',
    listing_url: item.itemWebUrl ?? item.itemAffiliateWebUrl ?? null,
    image_url: item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null,
    posted_date: (item.itemCreationDate ?? new Date().toISOString()).slice(0, 10),
    seller_country: item.itemLocation?.country ?? MARKET.country,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readListings() {
  if (!fs.existsSync(LISTINGS_FILE)) {
    console.warn('! listings.json not found — starting a new file. Run `npm run seed` first for the seed data.');
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(LISTINGS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('listings.json is not a JSON array');
    return parsed;
  } catch (err) {
    console.error(`! Could not read listings.json: ${err.message}`);
    console.error('  Refusing to overwrite it. Fix or delete the file and re-run.');
    process.exit(1);
  }
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log('— Skipping eBay fetch: no API credentials.');
    console.log(
      envFileFound
        ? '  .env was found but EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are empty.'
        : '  No .env file. Copy .env.example to .env and add your eBay keys.'
    );
    console.log('  Get a keyset at https://developer.ebay.com/my/keys — listings.json is unchanged.');
    process.exit(0);
  }

  const listings = readListings();
  const seenUrls = new Set(listings.map((l) => l.listing_url).filter(Boolean));
  const seenIds = new Set(listings.map((l) => l.id));
  const startCount = listings.length;

  console.log(`eBay Browse API — ${HOST.label}, marketplace ${MARKETPLACE_ID}`);
  console.log(`Existing listings: ${startCount}. Appending up to ${MAX_ITEMS}.\n`);

  try {
    await getToken();
    console.log('✓ OAuth token acquired\n');
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error('  listings.json is unchanged.');
    process.exit(1);
  }

  const queries = buildQueries();
  const fresh = [];

  for (const query of queries) {
    if (fresh.length >= MAX_ITEMS) break;

    let items;
    try {
      items = await runQuery(query);
      stats.queriesRun++;
    } catch (err) {
      stats.queriesFailed++;
      console.warn(`  ! "${query.q}" (${query.category}) failed: ${err.message}`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    let added = 0;
    for (const item of items) {
      if (fresh.length >= MAX_ITEMS) break;
      stats.itemsSeen++;

      const mapped = mapItem(item, query);
      if (!mapped || !mapped.listing_url) {
        stats.skippedNoPrice++;
        continue;
      }
      if (seenIds.has(mapped.id) || seenUrls.has(mapped.listing_url)) {
        stats.skippedDuplicate++;
        continue;
      }

      seenIds.add(mapped.id);
      seenUrls.add(mapped.listing_url);
      fresh.push(mapped);
      added++;
    }

    console.log(`  ${String(added).padStart(3)} new  ${query.category.padEnd(18)} ${query.q}`);
    await sleep(REQUEST_DELAY_MS);
  }

  stats.appended = fresh.length;

  if (!fresh.length) {
    console.log('\nNo new listings to append; listings.json is unchanged.');
    return;
  }

  fs.writeFileSync(LISTINGS_FILE, JSON.stringify(listings.concat(fresh), null, 2) + '\n');

  console.log(`\n✓ appended ${fresh.length} eBay listings (${startCount} → ${startCount + fresh.length})`);
  console.log(
    `  queries ${stats.queriesRun} ok / ${stats.queriesFailed} failed · ` +
      `items seen ${stats.itemsSeen} · duplicates ${stats.skippedDuplicate} · unusable ${stats.skippedNoPrice}`
  );

  const unspecified = (field) => fresh.filter((l) => l[field] === 'Unspecified').length;
  console.log(
    `  unparsed from titles — colour ${unspecified('colour')}, ` +
      `material ${unspecified('material')}, size ${unspecified('size')} (of ${fresh.length})`
  );
}

main().catch((err) => {
  console.error(`\n✗ Unexpected failure: ${err.message}`);
  process.exitCode = 1;
});
