const { CATEGORIES } = require("./data/questions.js");

function normalizeArtistName(name) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

async function checkArt(art) {
  const entity = art.album ? "album" : "song";
  const term = art.album ? `${art.artist} ${art.album}` : `${art.artist} ${art.track}`;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=5`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (text.startsWith("Rate limit")) {
        await new Promise((r) => setTimeout(r, 4000 + attempt * 3000));
        continue;
      }
      const data = JSON.parse(text);
      const results = data.results || [];
      const wanted = normalizeArtistName(art.artist);
      const match = results.find((r) => {
        if (!r.artistName) return false;
        const found = normalizeArtistName(r.artistName);
        return found.includes(wanted) || wanted.includes(found);
      });
      return { found: !!match, top: results[0] ? `${results[0].artistName} | ${results[0].trackName || results[0].collectionName}` : "(nessun risultato)" };
    } catch (e) {
      return { found: null, top: "errore: " + e.message };
    }
  }
  return { found: null, top: "rate limit persistente, non verificato" };
}

async function main() {
  let total = 0;
  let mismatches = [];
  let unverified = [];
  for (const [catKey, cat] of Object.entries(CATEGORIES)) {
    for (const q of cat.questions) {
      if (!q.art) continue;
      total++;
      const result = await checkArt(q.art);
      if (result.found === null) {
        unverified.push({ cat: catKey, question: q.question });
      } else if (!result.found) {
        mismatches.push({ cat: catKey, question: q.question, art: q.art, topResult: result.top });
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  console.log(`Controllate ${total} domande con campo "art".`);
  console.log(`Mismatch confermati: ${mismatches.length} | Non verificabili (rate limit): ${unverified.length}\n`);
  mismatches.forEach((m) => {
    console.log(`[${m.cat}] "${m.question}"`);
    console.log(`   cercato: ${m.art.artist} / ${m.art.track || m.art.album}`);
    console.log(`   top risultato iTunes: ${m.topResult}`);
    console.log("");
  });
  if (unverified.length) {
    console.log("--- Non verificabili (rate limit persistente) ---");
    unverified.forEach((u) => console.log(`[${u.cat}] "${u.question}"`));
  }
}

main();
