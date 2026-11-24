'use strict';
// Issue #366: seeded generative tests for scanCode's masking state machine.
// The hand-written cases in test.js cover the shapes someone thought of; this
// builds snippets from read fragments and decoys so the next shape is found
// here rather than by a user. No dependencies: a small PRNG and a fixed seed
// list, so a failure is reproducible from the seed it prints.
const assert = require('node:assert');
const { scanCode } = require('./index');

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

/** mulberry32: tiny, deterministic, good enough for fragment selection. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

/** A read fragment: source text plus the keys it must report. */
function readFragment(random, tag, n) {
  const key = `${tag}_${n}`;
  return pick(random, [
    () => ({ text: `process.env.${key};`, keys: [key] }),
    () => ({ text: `process.env['${key}'];`, keys: [key] }),
    () => ({ text: `process.env["${key}"];`, keys: [key] }),
    () => ({ text: `process.env[\`${key}\`];`, keys: [key] }),
    () => ({ text: `process.env?.${key};`, keys: [key] }),
    () => ({ text: `process.env?.['${key}'];`, keys: [key] }),
    () => ({ text: `import.meta.env.${key};`, keys: [key] }),
    () => ({ text: `import.meta.env['${key}'];`, keys: [key] }),
    () => ({ text: `import.meta.env?.\`x\` && import.meta.env?.['${key}'];`, keys: [key] }),
    () => ({ text: `const { ${key} } = process.env;`, keys: [key] }),
    () => ({ text: `const { ${key} = 'fallback' } = process.env;`, keys: [key] }),
    () => ({ text: `const { ${key}: alias${n} } = process.env;`, keys: [key] }),
    // A read inside a template's ${...} is still a read.
    () => ({ text: `const s${n} = \`value: \${process.env.${key}}\`;`, keys: [key] }),
  ])();
}

/** A decoy: text that mentions a key but is not a read. */
function decoyFragment(random, tag, n) {
  const key = `${tag}_${n}`;
  return pick(random, [
    () => ({ text: `// process.env.${key}\n`, keys: [key] }),
    () => ({ text: `/* process.env.${key} */\n`, keys: [key] }),
    () => ({ text: `const s${n} = 'process.env.${key}';\n`, keys: [key] }),
    () => ({ text: 'const d' + n + ' = "process.env.' + key + '";\n', keys: [key] }),
    () => ({ text: 'const t' + n + ' = `process.env.' + key + '`;\n', keys: [key] }),
    () => ({ text: `const r${n} = /process\\.env\\.${key}/;\n`, keys: [key] }),
    () => ({ text: `const o${n} = { note: 'see process.env.${key}' };\n`, keys: [key] }),
  ])();
}

const NOISE = ['\n', '\n\n', ' ', '\t', ';', '(', ')', '}', '  '];

function build(seed) {
  const random = rng(seed);
  const reads = [];
  const decoys = [];
  const parts = [];
  const count = 2 + Math.floor(random() * 5);
  for (let i = 0; i < count; i++) {
    const isRead = random() < 0.55;
    const fragment = isRead
      ? readFragment(random, `R${seed}`, i)
      : decoyFragment(random, `D${seed}`, i);
    (isRead ? reads : decoys).push(...fragment.keys);
    parts.push(fragment.text);
    // Noise between fragments, never inside a line comment's span.
    if (random() < 0.6) parts.push(pick(random, NOISE));
  }
  return { snippet: parts.join(''), reads, decoys };
}

let checked = 0;
for (const seed of SEEDS) {
  const { snippet, reads, decoys } = build(seed);
  const found = scanCode(snippet);
  const context = `seed ${seed}\nsnippet:\n${snippet}`;

  for (const key of reads) {
    assert.ok(found.includes(key), `planted read ${key} was not reported\n${context}`);
  }
  for (const key of decoys) {
    assert.ok(!found.includes(key), `decoy ${key} was reported as a read\n${context}`);
  }
  assert.deepStrictEqual(found, [...new Set(found)].sort(), `output is not sorted and de-duplicated\n${context}`);
  assert.deepStrictEqual(scanCode(snippet), found, `scanning twice differs\n${context}`);
  checked += found.length;
}

console.log(`test-scan-fuzz.js: ${SEEDS.length} generated snippets, ${checked} reported keys, all invariants held`);
