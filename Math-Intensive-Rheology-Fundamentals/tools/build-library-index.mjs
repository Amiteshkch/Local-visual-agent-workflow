import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const ZOTERO_ROOT = "/Users/amiteshkumar/Library/CloudStorage/GoogleDrive-amitesh18iisc@gmail.com/My Drive/Zotero_DB";
const OUT_DIR = new URL("../data/", import.meta.url);

const topicRules = [
  ["chain-statistics", /rouse|zimm|de gennes|coil|stretch|single polymer|dna dynamics|wormlike|kuhn|flory|polymer physics/i],
  ["dilute-dynamics", /dilute|rouse|zimm|relaxation time|microfluidic|single polymer|hydrodynamic/i],
  ["entangled-dynamics", /reptation|entangled|tube|mcleish|likhtman|graessley|polymeric liquids|dynamics of polymeric/i],
  ["extensional-rheology", /extensional|elongational|capillary|pinch|beads-on-string|elastocapillary|filament|stretching|coil-stretch|caBER|ROJER/i],
  ["linear-viscoelasticity", /linear viscoelastic|viscoelastic|stress relaxation|relaxation modulus|modulus|rheology|rheological/i],
  ["xanthan-polyelectrolytes", /xanthan|gum|polyelectrolyte|guar|cellulose|CMC|EHEC|polysaccharide/i],
  ["jets-atomization", /jet|spray|atomization|breakup|drop|droplet|fragmentation|ligament/i]
];

const equationRules = [
  ["Rouse-Zimm spectra", /rouse|zimm|hydrodynamic|relaxation time|dilute/i],
  ["Tube and reptation scaling", /reptation|tube|entangled|graessley|mcleish|likhtman|doi|edwards/i],
  ["Coil-stretch transition", /coil-stretch|de gennes|stretching|extensional flow|single polymer/i],
  ["Elastocapillary thinning", /capillary|pinch|beads-on-string|filament|elastocapillary|caBER|relaxation times/i],
  ["Constitutive modeling", /oldroyd|fene|viscoelastic model|polymeric liquids|bird|carreau|renardy/i],
  ["Food and polysaccharide rheology", /xanthan|gum|fruit|juice|polysaccharide|CMC|guar|food thickener/i]
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) walk(path, files);
    if (stats.isFile() && /\.pdf$/i.test(entry)) files.push({ path, stats });
  }
  return files;
}

function parseTitle(file) {
  const raw = basename(file, ".pdf").replace(/\s+/g, " ").trim();
  const match = raw.match(/^(.+?)\s+-\s+(\d{4})\s+-\s+(.+)$/);
  if (!match) return { title: raw, authors: "", year: "" };
  return { authors: match[1], year: match[2], title: match[3] };
}

function tagsFor(text, rules) {
  return rules.filter(([, regex]) => regex.test(text)).map(([tag]) => tag);
}

const all = walk(ZOTERO_ROOT)
  .map(({ path, stats }) => {
    const parsed = parseTitle(path);
    const haystack = `${parsed.authors} ${parsed.year} ${parsed.title} ${path}`;
    return {
      title: parsed.title,
      authors: parsed.authors,
      year: parsed.year,
      path,
      sizeMb: +(stats.size / 1024 / 1024).toFixed(1),
      topics: tagsFor(haystack, topicRules),
      equationFamilies: tagsFor(haystack, equationRules)
    };
  })
  .filter(item => item.topics.length || item.equationFamilies.length)
  .sort((a, b) => {
    const ay = Number(a.year) || 0;
    const by = Number(b.year) || 0;
    return by - ay || a.title.localeCompare(b.title);
  });

const priority = all.filter(item => {
  const text = `${item.title} ${item.authors}`.toLowerCase();
  return /rouse|zimm|de gennes|bird|doi|edwards|mcleish|likhtman|larson|entov|hinch|dinic|del giudice|graessley|colby|rubinstein|schroeder|coil-stretch|single polymer/.test(text);
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  new URL("library-index.js", OUT_DIR),
  `window.RHEOLOGY_LIBRARY = ${JSON.stringify(all, null, 2)};\nwindow.RHEOLOGY_PRIORITY_LIBRARY = ${JSON.stringify(priority, null, 2)};\n`
);

console.log(`Indexed ${all.length} rheology/polymer PDFs from Zotero_DB.`);
console.log(`Priority mathematical references: ${priority.length}.`);
