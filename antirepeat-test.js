const { io } = require("socket.io-client");
const URL = "http://localhost:3000";
function connect() { return new Promise((resolve) => { const s = io(URL); s.once("connect", () => resolve(s)); }); }
function emitAck(s, e, p) { return new Promise((res) => s.emit(e, p, res)); }

async function playOneGame(socket, roundQuestionTexts, isFirst) {
  return new Promise((resolve) => {
    const seen = [];
    socket.on("game:question", (q) => {
      seen.push(q.question);
      setTimeout(() => socket.emit("answer:submit", { choiceIndex: 0 }), 30);
    });
    socket.once("game:final", () => {
      socket.removeAllListeners("game:question");
      roundQuestionTexts.push(...seen);
      resolve();
    });
    if (!isFirst) socket.emit("room:playAgain");
    setTimeout(() => socket.emit("room:start", { category: "hiphop90", rounds: 10, timeLimit: 6 }), isFirst ? 0 : 200);
  });
}

(async () => {
  const s = await connect();
  await emitAck(s, "room:create", { nickname: "AntiRepeat", mode: "classic" });

  const game1 = [];
  await playOneGame(s, game1, true);
  const game2 = [];
  await playOneGame(s, game2, false);
  const game3 = [];
  await playOneGame(s, game3, false);

  function overlapPct(a, b) {
    const setB = new Set(b);
    const shared = a.filter((x) => setB.has(x)).length;
    return (shared / a.length) * 100;
  }

  console.log("Overlap game1 vs game2:", overlapPct(game1, game2).toFixed(1) + "%");
  console.log("Overlap game1 vs game3:", overlapPct(game1, game3).toFixed(1) + "%");
  console.log("Overlap game2 vs game3:", overlapPct(game2, game3).toFixed(1) + "%");

  s.close();
  process.exit(0);
})();
