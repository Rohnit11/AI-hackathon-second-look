#!/usr/bin/env node
'use strict';

/**
 * test-match.js
 *
 * Runs every product in targets.json through match() and prints the top 5 so
 * the ranking can be eyeballed.
 *
 * targets.json carries ground truth — expected_match_ids are the listings
 * planted as strong matches, expected_near_match_ids are deliberate colour
 * drifts — so each hit is annotated and the run ends with recall and MRR
 * figures. The point is to see *where* the ranking is wrong, not just that it
 * scores well on average.
 *
 *   node test-match.js [--topk=5]
 */

const path = require('path');
const { match } = require('./match.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const TOP_K = Math.max(1, Number(args.topk ?? 5));
const targets = require(path.join(__dirname, 'targets.json')).targets;

const pad = (s, n) => String(s).padEnd(n);
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

async function main() {
  console.log(`Matching ${targets.length} targets against listings.json — top ${TOP_K} each`);
  console.log(`Legend:  ✓ planted strong match   ~ planted near match (colour drift)\n`);

  const rows = [];

  for (const target of targets) {
    const strong = new Set(target.expected_match_ids ?? []);
    const near = new Set(target.expected_near_match_ids ?? []);

    const hits = await match(target, TOP_K);

    console.log('─'.repeat(100));
    console.log(`${target.id}  ${target.brand} — ${target.name_en}`);
    console.log(
      `          ${target.category} · ${target.subcategory} · ${target.colour} · ${target.material} · €${target.retail_price_eur}`
    );
    console.log(`          expecting: ${[...strong].join(', ') || '(none)'}\n`);

    hits.forEach((hit, i) => {
      const mark = strong.has(hit.id) ? '✓' : near.has(hit.id) ? '~' : ' ';
      console.log(
        `   ${mark} ${i + 1}. ${hit.score.toFixed(4)}  ${pad(hit.id, 9)} ` +
          `${pad(trunc(`${hit.brand} · ${hit.colour} ${hit.subcategory}`, 42), 43)} €${hit.price}`
      );
      console.log(`         ${trunc(hit.title, 88)}`);
    });

    // Where did the planted strong matches actually land?
    const ranks = [...strong]
      .map((id) => hits.findIndex((h) => h.id === id) + 1)
      .map((r) => (r === 0 ? Infinity : r));
    const bestRank = Math.min(...ranks);
    const foundCount = ranks.filter((r) => Number.isFinite(r)).length;

    rows.push({
      id: target.id,
      brand: target.brand,
      category: target.category,
      colour: target.colour,
      bestRank,
      foundCount,
      expected: strong.size,
      topScore: hits[0]?.score ?? 0,
      strongScores: [...strong]
        .map((id) => hits.find((h) => h.id === id)?.score)
        .filter((s) => s !== undefined),
      missedIds: [...strong].filter((id) => !hits.some((h) => h.id === id)),
    });

    const status =
      bestRank === 1
        ? 'top hit is a planted match'
        : Number.isFinite(bestRank)
          ? `first planted match at rank ${bestRank}`
          : `NO planted match in the top ${TOP_K}`;
    console.log(`\n          → ${status} (${foundCount}/${strong.size} found)\n`);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log('═'.repeat(100));
  console.log('SUMMARY\n');

  const n = rows.length;
  const at = (k) => rows.filter((r) => r.bestRank <= k).length;
  const mrr = rows.reduce((s, r) => s + (Number.isFinite(r.bestRank) ? 1 / r.bestRank : 0), 0) / n;
  const totalExpected = rows.reduce((s, r) => s + r.expected, 0);
  const totalFound = rows.reduce((s, r) => s + r.foundCount, 0);

  console.log(`  recall@1  ${at(1)}/${n}    a planted match is the single best hit`);
  console.log(`  recall@3  ${at(3)}/${n}`);
  console.log(`  recall@${TOP_K}  ${at(TOP_K)}/${n}`);
  console.log(`  MRR       ${mrr.toFixed(3)}`);
  console.log(`  both planted matches surfaced: ${totalFound}/${totalExpected}\n`);

  console.log(`  ${pad('target', 9)} ${pad('brand', 14)} ${pad('best rank', 10)} ${pad('found', 7)} top score`);
  for (const r of rows) {
    const rank = Number.isFinite(r.bestRank) ? `#${r.bestRank}` : 'missed';
    const flag = r.bestRank === 1 ? '  ' : r.bestRank <= TOP_K ? ' ·' : ' !';
    console.log(
      `${flag}${pad(r.id, 9)} ${pad(r.brand, 14)} ${pad(rank, 10)} ${pad(`${r.foundCount}/${r.expected}`, 7)} ${r.topScore.toFixed(4)}`
    );
  }

  const weak = rows.filter((r) => r.bestRank > 1);
  if (weak.length) {
    console.log(`\n  Weak spots (${weak.length}/${n} targets):`);
    for (const r of weak) {
      const detail = r.missedIds.length ? `missed ${r.missedIds.join(', ')}` : `best rank #${r.bestRank}`;
      console.log(`    ${r.id} (${r.brand}, ${r.colour} ${r.category}) — ${detail}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
