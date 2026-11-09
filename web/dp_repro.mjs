// Verification for the Drum Pads double-flash fix (Lowtide 2.8.6).
// Run from the repo root:  node web/dp_repro.mjs
// Exits non-zero on any failure.
//
// Loads the real DRUMPADS slice out of web/editor.html (DRUMPADS .. drumPadsHear)
// in a vm with stubbed LV / lvNoteOn / dev / DOM, then simulates taps and the
// DRUM_TRIG push that comes back from the FM-1, and records which pads flash.
//
// What changed in 2.8.6: every drag is written to the FM-1 at once, so the local
// map (drumPads.map) and the device map (drumPads.obj) always agree; and the
// toms are single-note (LOW TOM only G1 43, HI TOM only C2 48), so the note a
// tap sends is the tapped pad's own note. A tap therefore flashes exactly one
// pad — the tapped one — and a physical hit flashes exactly one pad too. The
// write itself is covered by the card test in web/test_web.mjs (the mock
// device's map is checked after a drag and after Reset); this script checks the
// flash side: one distinct pad per tap, none for a silent pad.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ed = readFileSync(join(HERE, "editor.html"), "utf8");
const slice = ed.slice(ed.indexOf("const DRUMPADS = {"), ed.indexOf("function drumPadsMarkPicked"));

const DRUM_LANES = [[36, "KICK"], [35, "KICK 2"], [38, "SNARE"], [39, "CLAP"], [42, "HAT"], [46, "OPEN HAT"], [44, "PEDAL"], [37, "RIM"],
  [40, "SNARE 2"], [43, "LOW TOM"], [48, "HI TOM"], [49, "CRASH"], [51, "RIDE"], [70, "SHAKER"], [63, "CONGA"], [56, "COWBELL"]];

const sentNotes = [];   // every note the editor "sends" to the FM-1
const flashes = [];     // every pad flash, in order: { note, source }

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  DRUM_LANES,
  LV: { kmode: "play", held: new Map() },
  dev: { dump: true, info: { proto: 15 }, output: { send: () => {} } },
  lvNoteOn(token, track, note, vel) {
    sentNotes.push({ token, track, note, vel });
    sandbox.LV.held.set(token, { ch: 9, note, track });
  },
  lvNoteOff(token) { sandbox.LV.held.delete(token); },
  lvG: () => 0, lvGv: () => 0,           // DR MAP off -> GM fallback lanes
  $: () => null, el: () => ({}),
  op: async (f) => f(), report: () => {},
  document: { activeElement: null, querySelectorAll: () => [] },
};
vm.createContext(sandbox);
vm.runInContext(slice, sandbox);

// Fake Drum Pads grid: 16 pads in PAD_NOTES order, recording "playing" adds.
function makePad(note) {
  return { note, classList: {
    add(cls) { if (cls === "playing") flashes.push({ note, source: "flash" }); },
    remove() {}, toggle() {}, contains: () => false,
  } };
}
const ctx = vm.runInContext(`({
  DRUMPADS, drumPads, drumPadsEff, drumPadsSerialize, drumPadsDeviceEff,
  drumPadsHearNote, drumPadsHear, drumPadsFlash, drumPadsTriggered,
  drumPadsFlashTimers })`, sandbox);
const { DRUMPADS, drumPads } = ctx;
const PAD_NOTES = DRUMPADS.PAD_NOTES;
const name = (n) => `${DRUMPADS.ableton(n)} (${n})`;

ctx.drumPads.ui = {
  grid: { children: PAD_NOTES.map(makePad), querySelectorAll: () => [] },
  trig: { set textContent(v) { /* Last triggered line */ } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reset() {
  sentNotes.length = 0; flashes.length = 0;
  for (const t of ctx.drumPadsFlashTimers.values()) clearTimeout(t);
  ctx.drumPadsFlashTimers.clear();
  ctx.drumPads.ui.grid.children = PAD_NOTES.map(makePad);
}
// The DRUM_TRIG push as the firmware sends it for the note the editor just
// sent: exactly what the onPush handler does (editor.html ~9201-9204).
function pushTrig(note, ch, vel, lane) {
  ctx.drumPadsTriggered({ ch, note, vel, lane });
  ctx.drumPadsFlash(note, lane);
}
// A tap on a pad, then the push that comes back for the note it sent.
async function tap(note) {
  reset();
  ctx.drumPadsHear(note);
  await sleep(10); // let the (stubbed) send land
  const sent = sentNotes.length ? sentNotes[0].note : null;
  if (sent != null) {
    const lane = ctx.drumPadsEff()[PAD_NOTES.indexOf(note)];
    pushTrig(sent, 10, 100, lane);
  }
  await sleep(250); // let the 140 ms flash timers run
  return { sent, flashed: [...new Set(flashes.map((f) => f.note))] };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let failures = 0;
function check(cond, label, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const setMap = (obj17, map16) => { drumPads.obj = Uint8Array.from(obj17); drumPads.map = Uint8Array.from(map16); };

// ---- 1. the default grid: single-note toms --------------------------------
const defEff = [10, 11, 255, 12, 6, 255, 5, 255, 8, 255, 4, 9, 0, 7, 2, 3]; // PAD_NOTES order
setMap(DRUMPADS.defaultObj(), new Uint8Array(16).fill(0xFF));
check(eq(ctx.drumPadsEff(), defEff), "default eff: the tom's other pads (F1 41, A1 45, B1 47, D2 50) are silent",
  `got ${JSON.stringify(ctx.drumPadsEff())}`);

// ---- 2. a silent pad: nothing sent, nothing flashes ------------------------
let r = await tap(41);   // F1: LOW TOM's old pad, no lane now
check(r.sent === null && r.flashed.length === 0, "tap F1 (41): no note sent, no pad flashes",
  `sent ${r.sent == null ? "none" : name(r.sent)}, flashed ${r.flashed.map(name).join(", ") || "none"}`);

// ---- 3. a tom pad: the sent note is the tapped pad's own note ---------------
r = await tap(43);   // G1: LOW TOM's only pad
check(r.sent === 43 && eq(r.flashed, [43]), "tap G1 (43): sends 43, flashes only G1",
  `sent ${r.sent == null ? "none" : name(r.sent)}, flashed ${r.flashed.map(name).join(", ")}`);
r = await tap(48);   // C2: HI TOM's only pad
check(r.sent === 48 && eq(r.flashed, [48]), "tap C2 (48): sends 48, flashes only C2",
  `sent ${r.sent == null ? "none" : name(r.sent)}, flashed ${r.flashed.map(name).join(", ")}`);

// ---- 4. a drag, written at once: the maps agree, so one pad flashes --------
const preEff = [...defEff]; preEff[11] = 3; preEff[15] = 255;   // CLAP on G1 (43), its home 39 silent
const postEff = [...preEff]; postEff[3] = 3; postEff[11] = 12;   // drag: CLAP on 51, RIDE on 43
const postMap = ctx.drumPadsSerialize(postEff);
setMap([...postMap, 4], postMap);   // the immediate write: the device holds the swapped map too
r = await tap(51);
check(r.sent === 51 && eq(r.flashed, [51]), "after the drag + write: tap CLAP at D#1 (51) sends 51, flashes only D#1",
  `sent ${r.sent == null ? "none" : name(r.sent)}, flashed ${r.flashed.map(name).join(", ")}`);
r = await tap(43);
check(r.sent === 43 && eq(r.flashed, [43]), "after the drag + write: tap RIDE at G1 (43) sends 43, flashes only G1",
  `sent ${r.sent == null ? "none" : name(r.sent)}, flashed ${r.flashed.map(name).join(", ")}`);

// ---- 5. a physical hit (no tap): only the DRUM_TRIG push, one pad ----------
setMap(DRUMPADS.defaultObj(), new Uint8Array(16).fill(0xFF));
reset();
pushTrig(37, 10, 100, 2);   // SNARE on C#1 from the controller
await sleep(250);
check(eq([...new Set(flashes.map((f) => f.note))], [37]), "physical hit: SNARE C#1 (37) flashes only C#1",
  `flashed ${[...new Set(flashes.map((f) => f.note))].map(name).join(", ")}`);
reset();
pushTrig(43, 10, 100, 9);   // LOW TOM on G1 from the controller
await sleep(250);
check(eq([...new Set(flashes.map((f) => f.note))], [43]), "physical hit: LOW TOM G1 (43) flashes only G1",
  `flashed ${[...new Set(flashes.map((f) => f.note))].map(name).join(", ")}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\ndouble-flash fix verified: one pad per tap, none for a silent pad");
process.exit(failures ? 1 : 0);
