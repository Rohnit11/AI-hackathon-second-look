/**
 * rewrite-titles.js — tops up the thin titles in the 250 seeded background rows.
 *
 *   node rewrite-titles.js [--dry-run] [--max-tries=60]
 *
 * WHY THIS EXISTS, and what it deliberately does NOT do.
 *
 * The brief called these titles "randomly generated" and "not plausible
 * garments". That is not what is in the file. All 250 name a garment that
 * agrees with their own subcategory field; generate-seed.js builds them from a
 * per-subcategory vocabulary, in two languages, and the result reads like
 * Vinted. So this is not a rewrite from scratch and it does not touch the rows
 * that are already fine.
 *
 * What IS wrong is thinness. buildTitle() drops the colour 25% of the time and
 * the brand 20% of the time, independently, so a tail of rows names only the
 * garment — "pull col rond", "GILET MATELASSÉ", "Bomber Khaki * VGC". Those are
 * the rows that read as filler on screen: not wrong, just empty. Fifteen name
 * neither brand nor colour; another handful carry the generator's stray
 * double-space and trailing-ellipsis artefacts, which read as broken data
 * rather than as a careless seller.
 *
 * THE GATE a title has to pass:
 *   - names its garment (always true already — buildTitle guarantees it)
 *   - names at least TWO of { brand, colour, material }
 *   - no doubled spaces, no trailing "..."
 *
 * HOW a failing row is fixed: rejection sampling on the EXISTING generator.
 * buildTitle() is called until it returns something that passes. Nothing about
 * the realism conventions is reimplemented or softened — the caps mixture, the
 * separators, the seller filler, the emoji, the size notation and the RRP
 * shouts all come out of generate-seed.js at exactly the rates they always did,
 * only now conditioned on the row actually describing itself.
 *
 * WHAT IS PRESERVED PER ROW, and why it matters:
 *   - language. A French title stays French, an English one stays English.
 *   - brand presence. A title that omitted the brand goes on omitting it.
 * targets.json plants its matches in PAIRS — one French with the brand, one
 * English without — so the benchmark has a hard half and an easy half. Forcing
 * a brand onto the hard half would quietly make tests/score-quality.mjs easier
 * to pass, which is the opposite of useful. Those rows reach the gate on colour
 * plus material instead.
 *
 * Output: listings.json in place, same shape, same row count, same order, same
 * structured fields. Only `title` changes.
 *
 * Determinism: generate-seed.js seeds one module-level mulberry32 at require
 * time, so a given input file plus a given gate gives a given output file.
 * Rows are visited in file order.
 */

const fs = require('node:fs');
const path = require('node:path');

const { CATEGORIES, COLOURS, MATERIAL_FR, buildTitle } = require('./generate-seed.js');

const FILE = path.join(__dirname, 'listings.json');
const TARGETS = path.join(__dirname, 'targets.json');

/**
 * The twenty rows targets.json plants as the right answers, left exactly as
 * they are.
 *
 * Two reasons, and the second is the one that matters.
 *
 * The measured one: these rows sit on a knife edge. tgt-010's planted match
 * ls-0115 beat the hand-written dl-404 by 0.024 on a corpus where scoring is
 * IDF-weighted COSINE, so a longer title is divided by a larger norm. Adding
 * "Navy" to "Wool Overcoat * Wool Blend * Size 54" is more true and more
 * readable and it still drops the row to rank 2, because "navy" is not a word
 * tgt-010's query contains. A richer title is not a better-scoring one.
 *
 * The principled one: rewriting the answer key is how a benchmark stops meaning
 * anything. Holding these twenty fixed is what lets the 10/10 after this change
 * be compared with the 10/10 before it.
 *
 * They are 20 of 250. Three of them stay thin as a result — ls-0034, ls-0115
 * and ls-0134 name neither their brand nor their colour — and the run prints
 * them by id every time, rather than quietly fixing them.
 */
const PLANTED = new Set(
  JSON.parse(fs.readFileSync(TARGETS, 'utf8')).targets.flatMap((t) => t.expected_match_ids ?? [])
);
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const DRY = Boolean(args['dry-run']);
const MAX_TRIES = Number(args['max-tries'] ?? 60);

// ---------------------------------------------------------------------------
// Vocabulary, rebuilt from the generator's own tables so the two cannot drift
// ---------------------------------------------------------------------------

const dea = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Keyed on category AND subcategory, never on subcategory alone. The same
 * subcategory name carries a DIFFERENT vocabulary in each category: a men's
 * Bomber Jacket may be called a "Harrington Jacket" and a men's Blazer a "veste
 * de costume", neither of which appears in the women's list. Collapsing the two
 * made real titles look like they had no garment word in them.
 */
const SUB_BY_KEY = new Map();
for (const [catName, cat] of Object.entries(CATEGORIES)) {
  for (const sub of cat.subcategories) SUB_BY_KEY.set(`${catName}\u0000${sub.name}`, sub);
}
const subFor = (row) => SUB_BY_KEY.get(`${row.category}\u0000${row.subcategory}`);

const COLOUR_WORDS = new Map(
  COLOURS.map((c) => [c.name, [...new Set([c.name, c.fr.m, c.fr.f])].map(dea)])
);

/**
 * Brand spellings a title may legitimately use. The generator's own variants
 * cover "Zara Basic" and "Mango Woman"; the punctuation-stripped forms cover
 * H&M being typed as "H & M", "HM" or "H And M", which real sellers all do.
 */
const BRAND_WORDS = {
  Zara: ['zara'],
  'H&M': ['h&m', 'h & m', 'h and m', 'hm', 'h m'],
  Mango: ['mango'],
  COS: ['cos', 'c.o.s'],
  Uniqlo: ['uniqlo'],
  'Massimo Dutti': ['massimo dutti', 'massimo-dutti', 'massimodutti', 'massimo duti'],
  'Sézane': ['sezane'],
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const namesColour = (title, colour) => {
  const t = dea(title);
  return (COLOUR_WORDS.get(colour) ?? [dea(colour)]).some((w) => t.includes(w));
};

const namesBrand = (title, brand) => {
  const t = dea(title);
  return (BRAND_WORDS[brand] ?? [dea(brand)]).some((w) => t.includes(dea(w)));
};

/**
 * A fibre word, not the whole material string. "laine mélangée" counts for Wool
 * Blend and so does a bare "laine"; "Faux Leather" counts for "simili cuir" and
 * for "cuir". This mirrors materialScore() in the extension's lib/score.js,
 * which also gives partial credit for a shared fibre word.
 */
const namesMaterial = (title, material) => {
  const t = dea(title);
  const en = dea(material).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== 'blend' && w !== 'faux');
  const fr = dea(MATERIAL_FR[material] ?? '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== 'melangee' && w !== 'melange');
  return [...en, ...fr].some((w) => t.includes(w));
};

const garmentWords = (sub) => [...sub.en, ...sub.fr.words];

const namesGarment = (title, sub) => {
  const t = dea(title);
  return garmentWords(sub).some((w) => t.includes(dea(w)));
};

/**
 * The garment term the title actually used, longest match first.
 *
 * This has to be preserved across a rewrite, and the reason is a measured
 * regression rather than a principle. ls-0115 read "Wool Overcoat * Wool Blend
 * * Size 54"; a rewrite that named the colour but said "Wool Coat" instead —
 * both are in the same vocabulary, both are true of the garment — cost the row
 * the token "overcoat", which is rare in the corpus and therefore carries most
 * of its IDF weight. tgt-010's planted match fell from rank 1 to rank 4 and
 * tests/score-quality.mjs went from 10/10 to 9/10 on that one word.
 *
 * So a rewrite may add to a title. It may not rename the garment.
 */
const garmentUsed = (title, sub) => {
  const t = dea(title);
  return garmentWords(sub)
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((w) => t.includes(dea(w))) ?? null;
};

const hasArtefact = (title) => /\s{2,}/.test(title) || /\.\.\.$/.test(title.trim());

function attributesNamed(title, row) {
  return [
    namesBrand(title, row.brand),
    namesColour(title, row.colour),
    namesMaterial(title, row.material),
  ].filter(Boolean).length;
}

/**
 * @returns {string[]} the reasons this title fails, empty when it passes.
 */
function gate(title, row, sub, { requireBrand }) {
  const why = [];
  if (!namesGarment(title, sub)) why.push('no garment word');
  if (attributesNamed(title, row) < 2) why.push('names fewer than two of brand/colour/material');
  if (hasArtefact(title)) why.push('whitespace or ellipsis artefact');
  return why;
}

/**
 * Stricter than the gate, and deliberately so.
 *
 * The gate decides whether a row NEEDS work. This decides whether a proposed
 * replacement is allowed to land, and it requires the colour outright rather
 * than accepting brand-plus-material. Without that a rewrite could satisfy the
 * gate while throwing away a colour the original had — trading one thin title
 * for another. Every replacement therefore names its colour, and every rewritten
 * row ends up naming strictly more than it did before.
 *
 * Brand presence is PRESERVED, not required: a title that omitted the brand must
 * go on omitting it, or targets.json's hard halves quietly become easy ones.
 *
 * The material must also be named OUTSIDE the garment term. "Wool Overcoat"
 * contains "wool", so without that rule "WOOL OVERCOAT NAVY" counts as naming
 * both a colour and a material, and a rewrite could trade "Wool Overcoat * Wool
 * Blend * Size 54" for it and call that an improvement.
 */
function acceptable(title, row, sub, { requireBrand, keepGarment }) {
  if (gate(title, row, sub, { requireBrand }).length) return false;
  if (!namesColour(title, row.colour)) return false;
  if (keepGarment && !dea(title).includes(dea(keepGarment))) return false;
  if (namesBrand(title, row.brand) !== requireBrand) return false;

  const outsideGarment = keepGarment ? dea(title).split(dea(keepGarment)).join(' ') : title;
  const named = [
    namesBrand(title, row.brand),
    namesColour(outsideGarment, row.colour),
    namesMaterial(outsideGarment, row.material),
  ].filter(Boolean).length;
  return named >= 2;
}

// ---------------------------------------------------------------------------
// What the existing title already decided
// ---------------------------------------------------------------------------

/**
 * French or English, decided by which of the subcategory's two word lists the
 * title drew from — comparing the LONGEST match on each side, not mere
 * presence. The English "Gilet" is a substring of the French "gilet matelassé",
 * so a presence test calls "GILET MATELASSÉ" English and then no English-mode
 * rewrite can ever keep its garment term. Falls back to a short function-word
 * test for the titles whose garment word is spelled the same either way
 * ("parka", "blazer", "bomber", "trench", "cape", "polo").
 */
const FR_MARKERS = /\b(taille|tres|bon|etat|comme|neuf|jamais|porte|envoi|rapide|prix|petit|saisir|px|boutique|laine|melangee|coton|cuir|noir|noire|bleu|marine|blanc|casse|ecru|creme|gris|chine|anthracite|vert|marron|chocolat|rose|poudre|rouille|moutarde|avoine|sauge|glacier|magnifique|superbe|sublime|joli|a capuche|sans manches)\b/;

function languageOf(title, sub) {
  const t = dea(title);
  const longest = (words) =>
    words.reduce((best, w) => (t.includes(dea(w)) && w.length > best ? w.length : best), 0);
  const fr = longest(sub.fr.words);
  const en = longest(sub.en);
  if (fr > en) return 'fr';
  if (en > fr) return 'en';
  return FR_MARKERS.test(t) ? 'fr' : 'en';
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const changed = [];
const stuck = [];
let tries = 0;

const skipped = [];
const tidied = [];

/**
 * Doubled spaces and a trailing "..." are the generator's two cosmetic tics.
 * lib/describe.js's cleanTitle() flattens punctuation and collapses whitespace
 * before anything is tokenised, so removing them cannot move a score by a
 * single digit — they only make the panel look like it is rendering broken
 * data. Safe to apply even to the rows held fixed for the benchmark.
 */
const tidy = (t) => t.replace(/\.{2,}$/, '').replace(/\s{2,}/g, ' ').trim();

for (const row of rows) {
  if (PLANTED.has(row.id)) {
    const clean = tidy(row.title);
    if (clean !== row.title) {
      tidied.push({ id: row.id, before: row.title, after: clean });
      row.title = clean;
    }
    skipped.push(row);
    continue;
  }
  const sub = subFor(row);
  if (!sub) {
    // A subcategory the generator does not know would mean the seed and this
    // script have drifted apart. Louder than a silent skip.
    throw new Error(`${row.id}: ${row.category} / "${row.subcategory}" is not in generate-seed.js`);
  }

  const lang = languageOf(row.title, sub);
  const requireBrand = namesBrand(row.title, row.brand);

  const why = gate(row.title, row, sub, { requireBrand });
  if (!why.length) continue;

  const opts = { lang, includeBrand: requireBrand };
  // null for the handful whose seller used the other gender's vocabulary
  // ("Round Neck Knit" on a women's row); those may take any garment word.
  const keepGarment = garmentUsed(row.title, sub);

  let next = null;
  for (let i = 0; i < MAX_TRIES; i += 1) {
    tries += 1;
    const candidate = buildTitle(row, sub, opts);
    if (acceptable(candidate, row, sub, { requireBrand, keepGarment })) {
      next = candidate;
      break;
    }
  }

  if (!next) {
    // Nothing fabricated as a fallback: if the generator cannot reach the gate
    // in MAX_TRIES the row is left exactly as it was and reported, so the
    // failure is visible instead of papered over with a hand-built string.
    stuck.push({ row, why });
    continue;
  }

  changed.push({ id: row.id, why, before: row.title, after: next });
  row.title = next;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (n) => `${Math.round((n / rows.length) * 100)}%`;
const french = rows.filter((r) => languageOf(r.title, subFor(r)) === 'fr').length;
const noBrand = rows.filter((r) => !namesBrand(r.title, r.brand)).length;
const withSize = rows.filter((r) =>
  /\b(?:size|sz|taille|t\.|uk)\b|\b(?:XS|S|M|L|XL|XXL)\b|\b(?:3[2-9]|4[0-9]|5[0-4])\b/i.test(r.title)
).length;
const noColour = rows.filter((r) => !namesColour(r.title, r.colour)).length;

const thinPlanted = skipped.filter(
  (r) => !namesBrand(r.title, r.brand) && !namesColour(r.title, r.colour)
);

console.log(`rows            ${rows.length}`);
console.log(`rewritten       ${changed.length}  (${tries} generator calls)`);
console.log(`already fine    ${rows.length - changed.length - stuck.length - skipped.length}`);
console.log(`held fixed      ${skipped.length}  targets.json ground truth, ${thinPlanted.length} of them thin`);
console.log(`  of those, whitespace/ellipsis tidied on ${tidied.length} (cannot affect scoring)`);
console.log(`could not fix   ${stuck.length}`);
console.log('');
console.log('realism conventions, after:');
console.log(`  French wording    ${french} (${pct(french)})`);
console.log(`  brand omitted     ${noBrand} (${pct(noBrand)})`);
console.log(`  colour omitted    ${noColour} (${pct(noColour)})`);
console.log(`  size in the title ${withSize} (${pct(withSize)})`);

if (stuck.length) {
  console.log('\nNOT FIXED — left as they were:');
  for (const s of stuck) console.log(`  ${s.row.id}  ${s.why.join('; ')}  ${JSON.stringify(s.row.title)}`);
}

if (thinPlanted.length) {
  console.log('\nHELD FIXED and still thin — these name neither brand nor colour,');
  console.log('and are left that way because targets.json scores against them:');
  for (const r of thinPlanted) console.log(`  ${r.id}  ${JSON.stringify(r.title)}`);
}

if (args.verbose) {
  console.log('\nrewrites:');
  for (const c of changed) {
    console.log(`  ${c.id}  (${c.why.join('; ')})`);
    console.log(`    -  ${JSON.stringify(c.before)}`);
    console.log(`    +  ${JSON.stringify(c.after)}`);
  }
}

if (DRY) {
  console.log('\n--dry-run: listings.json not written');
} else {
  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(process.cwd(), FILE)}`);
}
