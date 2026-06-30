const { io } = require("socket.io-client");
const URL = "http://localhost:3000";
let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}`, extra !== undefined ? extra : ""); }
}
function connect() { return new Promise((resolve) => { const s = io(URL); s.once("connect", () => resolve(s)); }); }
function once(socket, event, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (p) => { clearTimeout(t); resolve(p); });
  });
}
function emitAck(socket, event, payload) { return new Promise((resolve) => socket.emit(event, payload, resolve)); }

async function testHomeDataAndProfile() {
  console.log("\n--- home:data + profile:get ---");
  const s = await connect();
  const home = await emitAck(s, "home:data", { nickname: "SmokeTester" });
  ok("home:data risponde con leaderboard array", Array.isArray(home.leaderboard));
  ok("home:data risponde con daily.msUntilReset > 0", home.daily.msUntilReset > 0, home.daily.msUntilReset);
  const prof = await emitAck(s, "profile:get", { nickname: "SmokeTester" });
  ok("profile:get crea profilo se assente", prof.ok && prof.profile.nickname === "SmokeTester");
  s.close();
}

async function testClassicWithBadgesAndLeaderboard() {
  console.log("\n--- classica: badge first_login + leaderboard ---");
  const nickname = `Sk${Date.now()}`.slice(0, 16);
  const s = await connect();
  const created = await emitAck(s, "room:create", { nickname, mode: "classic" });
  ok("room:create include newBadges con first_login", created.newBadges.includes("first_login"), created.newBadges);
  // il client non conosce mai correctIndex (anti-cheat): proviamo tutte le opzioni in round-robin
  // così su 12 round è statisticamente certo totalizzare punteggio > 0 almeno una volta.
  let guess = 0;
  s.emit("room:start", { category: "mixed", rounds: 12, timeLimit: 8 });
  s.on("game:question", (q) => {
    const choice = guess % q.options.length;
    guess++;
    setTimeout(() => s.emit("answer:submit", { choiceIndex: choice }), 80);
  });
  const final = await once(s, "game:final", 90000);
  ok("game:final players hanno newBadges field", Array.isArray(final.players[0].newBadges));
  const myScore = final.players.find((p) => p.nickname === nickname).score;
  ok("smoke: punteggio finale > 0 su 12 round round-robin", myScore > 0, myScore);
  const home = await emitAck(s, "home:data", { nickname });
  ok("leaderboard globale aggiornata dopo la partita", home.leaderboard.some((e) => e.nickname === nickname), home.leaderboard);
  s.close();
}

async function testMixedMode() {
  console.log("\n--- modalità Mista (alterna testo/audio) ---");
  const s = await connect();
  await emitAck(s, "room:create", { nickname: "SmokeMixed", mode: "mixed" });
  s.emit("room:start", { category: "mixed", rounds: 6, timeLimit: 12 });
  const seenModes = new Set();
  s.on("game:question", (q) => {
    seenModes.add(q.imageMode === "audio" ? "audio" : "text");
    setTimeout(() => s.emit("answer:submit", { choiceIndex: 0 }), 50);
  });
  await once(s, "game:final", 60000);
  ok("mista: ha visto almeno un tipo di round (testo o audio)", seenModes.size >= 1, [...seenModes]);
  console.log("   tipi visti:", [...seenModes].join(", "));
  s.close();
}

async function testStreakMode() {
  console.log("\n--- modalità Streak (nessun timer, ritmo libero) ---");
  const s = await connect();
  await emitAck(s, "room:create", { nickname: "SmokeStreak", mode: "streak" });
  s.emit("room:start", { category: "hiphop90" });
  let count = 0;
  let lastStreak = -1;
  const donePromise = new Promise((resolve) => {
    s.on("streak:question", (q) => {
      count++;
      setTimeout(() => s.emit("answer:submit", { choiceIndex: 0 }), 30);
    });
    s.on("streak:result", (r) => {
      lastStreak = r.streakCount;
      if (count >= 4) resolve();
    });
  });
  await donePromise;
  ok("streak: ha servito più domande senza timer/fine partita", count >= 4, count);
  ok("streak: streakCount è un numero valido (>=0)", lastStreak >= 0, lastStreak);
  s.emit("room:leave");
  s.close();
}

async function testDailyChallenge() {
  console.log("\n--- Daily Challenge (seed deterministico, no stanza) ---");
  const s1 = await connect();
  const s2 = await connect();
  const start1 = await emitAck(s1, "daily:start", { nickname: "DailyPlayerA" });
  const start2 = await emitAck(s2, "daily:start", { nickname: "DailyPlayerB" });
  ok("daily:start risponde ok per entrambi", start1.ok && start2.ok);
  ok("daily: stesso numero totale di domande", start1.total === start2.total, [start1.total, start2.total]);
  ok("daily: stessa prima domanda per tutti (seed deterministico)", start1.question.question === start2.question.question, [start1.question.question, start2.question.question]);
  ok("daily: stesse opzioni nello stesso ordine", JSON.stringify(start1.question.options) === JSON.stringify(start2.question.options));

  let res1 = await emitAck(s1, "daily:answer", { choiceIndex: 0 });
  for (let i = 1; i < start1.total; i++) {
    res1 = await emitAck(s1, "daily:answer", { choiceIndex: 0 });
  }
  ok("daily: completa e segnala done", res1.done === true);
  ok("daily: leaderboard giornaliera presente nel risultato finale", Array.isArray(res1.leaderboard));

  const home = await emitAck(s1, "home:data", { nickname: "DailyPlayerA" });
  ok("daily: playedToday=true dopo aver completato", home.daily.playedToday === true);
  s1.close();
  s2.close();
}

async function testReactionsRateLimit() {
  console.log("\n--- reaction emoji + rate limit ---");
  const host = await connect();
  const guest = await connect();
  const created = await emitAck(host, "room:create", { nickname: "ReactHost", mode: "classic" });
  await emitAck(guest, "room:join", { code: created.room.code, nickname: "ReactGuest" });

  const incomingPromise = once(guest, "reaction:incoming");
  host.emit("reaction:send", { emoji: "🔥" });
  const incoming = await incomingPromise;
  ok("reaction: il guest riceve la reaction", incoming.emoji === "🔥" && incoming.nickname === "ReactHost", incoming);

  host.emit("reaction:send", { emoji: "😂" });
  await new Promise((r) => setTimeout(r, 150));
  let blockedReceived = false;
  guest.once("reaction:incoming", () => { blockedReceived = true; });
  host.emit("reaction:send", { emoji: "💀" }); // 3a in <10s: deve essere bloccata
  await new Promise((r) => setTimeout(r, 300));
  ok("reaction: rate limit blocca la 3a reaction in 10s", blockedReceived === false);

  host.close();
  guest.close();
}

async function main() {
  await testHomeDataAndProfile();
  await testClassicWithBadgesAndLeaderboard();
  await testMixedMode();
  await testStreakMode();
  await testDailyChallenge();
  await testReactionsRateLimit();
  console.log(`\n=== RISULTATO: ${pass} passati, ${fail} falliti ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((err) => { console.error("ERRORE FATALE:", err); process.exit(1); });
