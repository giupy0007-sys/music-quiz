const { io } = require("socket.io-client");
const URL_BASE = "http://localhost:3000";
function connect() { return new Promise((resolve) => { const s = io(URL_BASE); s.once("connect", () => resolve(s)); }); }
function once(socket, event, t = 15000) { return new Promise((res, rej) => { const to = setTimeout(() => rej(new Error("timeout " + event)), t); socket.once(event, (p) => { clearTimeout(to); res(p); }); }); }
function emitAck(s, e, p) { return new Promise((res) => s.emit(e, p, res)); }

(async () => {
  let pass = 0, fail = 0;
  function ok(label, cond, extra) { if (cond) { pass++; console.log("✅", label); } else { fail++; console.log("❌", label, extra ?? ""); } }

  const blitz = await connect();
  await emitAck(blitz, "room:create", { nickname: "RegBlitz", mode: "blitz" });
  blitz.emit("room:start", { category: "hiphop2000", rounds: 3, timeLimit: 25 });
  const bq = await once(blitz, "game:question");
  ok("blitz: timeLimit ancora forzato a 10", bq.timeLimit === 10, bq.timeLimit);
  blitz.close();

  const blind = await connect();
  await emitAck(blind, "room:create", { nickname: "RegBlind", mode: "blind" });
  blind.emit("room:start", { category: "trapmodern", rounds: 3, timeLimit: 10 });
  const bdq = await once(blind, "game:question");
  ok("blind: imageMode ancora none", bdq.imageMode === "none", bdq.imageMode);
  blind.close();

  const audio = await connect();
  await emitAck(audio, "room:create", { nickname: "RegAudio", mode: "audio" });
  audio.emit("room:start", { category: "raptrap2010", rounds: 2, timeLimit: 10 });
  const aq = await once(audio, "game:question", 20000);
  ok("audio: question generica ancora presente", aq.question.includes("Ascolta"));
  audio.close();

  const collabHost = await connect();
  const collabGuest = await connect();
  const created = await emitAck(collabHost, "room:create", { nickname: "RegCollabHost", mode: "collab" });
  await emitAck(collabGuest, "room:join", { code: created.room.code, nickname: "RegCollabGuest" });
  collabHost.emit("room:start", { category: "hiphop90", duration: 30 });
  const cq = await once(collabHost, "game:question", 10000);
  ok("collab: ancora mode collab + teamScore 0", cq.mode === "collab" && cq.teamScore === 0);
  collabHost.close();
  collabGuest.close();

  console.log(`\n=== REGRESSIONE: ${pass} passati, ${fail} falliti ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
