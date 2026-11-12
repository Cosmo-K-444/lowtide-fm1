// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// Node checks of the web pages' JS (no browser, no hardware). Run from the repo root:
//   node web/test_web.mjs
// - editor.html: the protocol section (between PROTO-BEGIN/END) against its mock device (v1 commands,
//   the user preset bank / librarian, library files, live pushes, older-firmware fallback, the v3 tracks
//   and the mixer), its tab layout and ja/en strings,
//   and the user-sample pipeline byte for byte against tools/sampleio.py
// - fm1pkg.js: productOf and logicalImage on build/lowtide.fwsc (skipped without a build)
// - fm1ota.js: a full install and an unplug during the write against a simulated FM-1

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { logicalImage, productOf } from "./fm1pkg.js";
import { Updater, pack7, unpack7, FM1_PORT } from "./fm1ota.js";

let failed = 0;
const ok = (cond, what) => { console.log(`${what.padEnd(64)} ${cond ? "ok" : "FAIL"}`); if (!cond) failed++; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const cjsRequire = createRequire(import.meta.url);   /* acorn, for the scope walk (optional: skipped without it) */
const py = (code, ...args) => execFileSync(PYTHON, ["-c", code, ...args], { maxBuffer: 1 << 26 });
const HERE = fileURLToPath(new URL(".", import.meta.url));

/* ------------------------------------------------------------ editor protocol --- */
const html = readFileSync(join(HERE, "editor.html"), "utf8");
const proto = html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/"));
const E = vm.runInNewContext(proto + `
;({ frame, unframe, parse, req, Link, parseWav, resample, normalize, rootFromName, buildSlot, makeMockDevice, CMD, PUSH, SMP,
   CHOP, chopNovelty, chopHits, chopSnap, chopGrid, chopEqual, chopList, chopPick, chopFit, chopZones, wavFile, zipStore, crc32,
   UP, bank, capturePatch, auditionPatch, startWatch, libraryFile, readLibraryFile, paramKeys, patternFromSteps, stepsFromPattern, upName,
   mixer, GM_DRUM, drumName, parseNotes, fmtValue, F, DRUM_LANES, LV_NAMES, emptyDrum, lockable, MICRO, FC, fillGet, fillSet, pack7, unpack7,
   loudDb, matchGains, withGain, LEVEL_MIN, gainQ15, gainDbFromQ15, backupCapture, backupRestore, backupObjects, b64enc, b64dec, FM6, KIT, kitPad, kitZones, kitLen, kitBytes, kitFit, kitSplit, kitLaneOf, kitPlace, zipRead, ROLL, SMF, ARR, mockSettings, fm6CartWrite, fm6CartPreset, fm6CartSlots, fm6CartPresets, DSYN, DSYN_MOCK_NAMES, DSYN_MOCK_KITS, SetGate, bkProjFormat, bkDevFormat, bkFwAtLeast, THEME, FM1_PORT_ED: FM1_PORT, fm1Ports, LOOP, LIVE, LVX, SONGF, songCapture, songLoad, songObjects, imaEncode, imaDecode, imaStateAt, kitSliceEntry, kitSlicePutEntry, kitSliceRange, kitSliceDev, KIT_MIN_CHOP, bkWriteObj, bkReadObj, bkMutex, kitRate, kitPlayLen, kitMinChop })`,
{ setTimeout, clearTimeout, setInterval, clearInterval, console, TextEncoder, TextDecoder, Blob, Response, DecompressionStream });

async function editorMock() {
  const m = E.makeMockDevice();
  const inp = [...m.access.inputs.values()][0], out = [...m.access.outputs.values()][0];
  const link = new E.Link((d) => out.send(d), { timeout: 300 });
  inp.onmidimessage = (e) => link.receive(e.data);
  const rq = async (r, o) => link.request(r, o);
  const info = E.parse[E.CMD.INFO](await rq(E.req.info()));
  ok(info.nengines === 12 && info.engines[9] === "FM6" && info.engines[10] === "PHYS" && info.engines[11] === "NOISE" && info.engines[5] === "VOICE" && info.engines[6] === "TRIO" && info.engines[7] === "WHEEL" && info.engines[8] === "GRAIN" && info.pcount === 71 && info.pe0 === 63 && info.engines[4] === "SAMPLE",
    "editor: INFO");
  let descs = 0;
  for (let i = 0; i < info.pcount; i++) if (E.parse[E.CMD.DESC](await rq(E.req.desc(0, i))).label) descs++;
  ok(descs === info.pcount, "editor: DESC for every parameter");
  {
    /* the SLICER (core.h P_SLCR..P_SLDEPTH = 45..48, just before P_E0): the mock as params.c has it,
       and a factory preset turns it off as ui.c apply_preset_to does */
    const pc = readFileSync(join(HERE, "../firmware/src/params.c"), "utf8");
    const sd = [];
    for (let i = 45; i < 49; i++) sd.push(E.parse[E.CMD.DESC](await rq(E.req.desc(0, i))));
    ok(sd.map((d) => d.label).join() === "SLCR,PAT,RATE,DEPTH" && sd[0].names.join() === "OFF,GATE,STUT"
      && sd[2].names.join() === "1/8,1/16,1/32,8T,16T,32T" && sd[2].def === 1 && sd[1].min === 1 && sd[1].max === 16 && sd[3].def === 127
      && /\[P_SLCR\] = PE\("SLCR", N_SLCR, 0\)/.test(pc) && /\[P_SLPAT\] = PD\("PAT", F_INT, 1, 16, 1\)/.test(pc)
      && /\[P_SLRATE\] = PE\("RATE", N_SLDIV, 1\)/.test(pc) && /\[P_SLDEPTH\] = PD\("DEPTH", F_PCT, 0, 127, 127\)/.test(pc)
      && /N_SLDIV\[\] = \{"1\/8", "1\/16", "1\/32", "8T", "16T", "32T"\}/.test(pc),
      "editor: SLICER parameters 45..48 (mock == params.c)");
    await rq(E.req.set(0, 45, 2));
    await rq(E.req.set(0, 46, 7));
    const on = E.parse[E.CMD.DUMP](await rq(E.req.dump()), info);
    await rq(E.req.preset(0, 1));
    const off = E.parse[E.CMD.DUMP](await rq(E.req.dump()), info);
    ok(on.p[45] === 2 && on.p[46] === 7 && off.p[45] === 0 && off.p[46] === 1, "editor: a factory preset turns the SLICER off");
  }
  const scale = E.parse[E.CMD.DESC](await rq(E.req.desc(0, 26)));
  const scaleNames = ["CHR", "MAJ", "MIN", "DOR", "MIX", "PEN", "MPEN", "HARM", "PHRY", "LYD", "LOC", "MEL", "BLUES", "WHOLE", "DIMHW", "DIMWH"];
  ok(scale.label === "SCL" && scale.max === 15 && eq(scale.names, scaleNames), "editor: all 16 scale names exposed");
  const scaleSet = E.parse[E.CMD.SET](await rq(E.req.set(0, scale.id, 15)));
  ok(scaleSet.value === 15, "editor: new scale selection is not clamped to the old range");
  const dump = E.parse[E.CMD.DUMP](await rq(E.req.dump()), info);
  ok(dump.p.length === info.pcount && dump.g.length === info.gcount, "editor: DUMP");
  const set = E.parse[E.CMD.SET](await rq(E.req.set(0, 3, 500)));
  ok(set.value === 127, "editor: SET clamps to the range");
  const st = E.parse[E.CMD.STEP_SET](await rq(E.req.stepSet(5, { n: 2, notes: [60, 64], time: 0, flags: 1, vel: 100 })));
  ok(st.n === 2 && st.notes[1] === 64 && st.vel === 100, "editor: STEP_SET");
  const pj = E.parse[E.CMD.PROJECT](await rq(E.req.project(1, 2), { timeout: 4000, retries: 0 }));
  ok(pj.used === 1, "editor: PROJECT save");
  /* sample upload as smpUpload() does it */
  const s = Int16Array.from({ length: 3000 }, (_, i) => Math.round(8000 * Math.sin(i / 7)));
  const { hdr, data } = E.buildSlot("test", [{ s, root: 60 }]);
  let rc = E.parse[E.CMD.SMP_BEGIN](await rq(E.req.smpBegin(1), { timeout: 1000, retries: 0 })).rc;
  for (let off = 0; off < data.length && !rc; off += 256) {
    rc = E.parse[E.CMD.SMP_WRITE](await rq(E.req.smpWrite(1, E.SMP.DATA_OFF + off, data.subarray(off, off + 256)), { timeout: 1000 })).rc;
  }
  rc = rc || E.parse[E.CMD.SMP_END](await rq(E.req.smpEnd(1, hdr), { timeout: 2000, retries: 0 })).rc;
  const si = E.parse[E.CMD.SMP_INFO](await rq(E.req.smpInfo()));
  ok(rc === 0 && si.slots[1].zones === 1 && si.slots[1].name === "TEST", "editor: sample upload (CRC checked by the mock)");
  /* 2.7: a file's loop (Samples page): LOOP+TAIL's points on rising zero crossings, the zone looped = 2 (held), the
     decoder's state at the loop start; LOOP the whole file; ONE SHOT as before */
  {
    const w = Int16Array.from({ length: 4000 }, (_, i) => Math.round(8000 * Math.sin(2 * Math.PI * (i + 13) / 100)));
    const [a, b] = E.LOOP.snapRange(w, 1030, 2990), rising = (j) => w[j - 1] < 0 && w[j] >= 0;
    ok(rising(a) && rising(b + 1) && Math.abs(a - 1030) <= 50 && Math.abs(b - 2990) <= 50,
      `loop: points snapped to rising zero crossings (${a}, ${b})`);
    const zone = (sl) => { const v = new DataView(sl.hdr.buffer);
      return { n: v.getUint32(36, true), ls: v.getUint32(40, true), le: v.getUint32(44, true), pred: v.getInt16(54, true), idx: sl.hdr[56], looped: sl.hdr[59] }; };
    const t2 = zone(E.buildSlot("LP", [{ s: w, root: 60, loop: 2, ls: a, le: b }]));
    ok(t2.looped === 2 && t2.ls === a && t2.le === b && Math.abs(t2.pred - w[a - 1]) < 600 && t2.idx > 0,
      `loop: LOOP+TAIL -> looped 2, ls / le, the decoder state at ls (pred ${t2.pred} ~ ${w[a - 1]})`);
    const t1 = zone(E.buildSlot("LP", [{ s: w, root: 60, loop: 1 }])), t0 = zone(E.buildSlot("LP", [{ s: w, root: 60 }]));
    ok(t1.looped === 2 && t1.ls === 0 && t1.le === 3999 && t1.pred === 0 && t0.looped === 0 && t0.ls === 0 && t0.le === 3999,
      "loop: LOOP the whole file (looped 2); ONE SHOT looped 0, as before");
    const [c, d] = E.LOOP.range({ s: w, loop: 2, ls: 3990, le: 10 });
    ok(c < d && d - c + 1 >= E.LOOP.MIN && d < w.length, "loop: points out of order or too close: a loop of at least LOOP.MIN inside the file");
    /* a WAV's own loop (its 'smpl' chunk, after the data as most editors write it) */
    const wav = E.wavFile(w), smpl = new Uint8Array(8 + 60), sv = new DataView(smpl.buffer);
    smpl.set([0x73, 0x6D, 0x70, 0x6C]); sv.setUint32(4, 60, true); sv.setUint32(8 + 28, 1, true);
    sv.setUint32(8 + 44, 1234, true); sv.setUint32(8 + 48, 3210, true);
    const both = new Uint8Array(wav.length + smpl.length);
    both.set(wav); both.set(smpl, wav.length);
    new DataView(both.buffer).setUint32(4, both.length - 8, true);
    const pw = E.parseWav(both), pn = E.parseWav(wav);
    ok(pw.loop && pw.loop[0] === 1234 && pw.loop[1] === 3210 && pw.x.length === 4000 && pn.loop === null,
      "loop: a WAV's 'smpl' loop is read (after the data chunk too); none without one");
  }
  /* a device that never answers */
  const dead = new E.Link(() => {}, { timeout: 30 });
  const err = await dead.request(E.req.info(), { retries: 1 }).then(() => null, (e) => e.message);
  ok(/^timeout/.test(err || ""), "editor: no reply -> timeout after the retries");
  link.close();
  m.stop();
}

/* ------------------------------------- editor protocol v2: librarian + live --- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (x) => JSON.stringify(x);
/* a mock + Link pair; counts frames sent per cmd and timeouts reported */
function attachMock(opt, linkOpt = {}) {
  const m = E.makeMockDevice({ auto: false, ...opt });
  const inp = [...m.access.inputs.values()][0], out = [...m.access.outputs.values()][0];
  const sent = {}, ev = { timeouts: 0, unknown: [], pushes: [] };
  const link = new E.Link((d) => { sent[d[4]] = (sent[d[4]] || 0) + 1; out.send(d); }, {
    timeout: 300, onTimeout: () => ev.timeouts++, onUnknown: (f) => ev.unknown.push(f),
    onPush: (f) => ev.pushes.push({ ...f, pending: link.cur ? link.cur.cmd : 0 }), ...linkOpt });
  inp.onmidimessage = (e) => link.receive(e.data);
  const rq = (r, o) => link.request(r, o);
  return { m, link, rq, sent, ev, done: () => { link.close(); m.stop(); } };
}
const emptyStep = { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0 };

async function editorLibrarian() {
  const { m, rq, done } = attachMock({});
  const C = E.CMD;
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const pdesc = [];
  for (let i = 0; i < info.pcount; i++) pdesc.push(E.parse[C.DESC](await rq(E.req.desc(0, i))));
  const keys = E.paramKeys(pdesc, info.pe0, info.pcount);
  ok(keys[6] === "PIT" && keys[13] === "PIT#2" && keys[info.pe0] === "E0" && new Set(keys).size === keys.length, "librarian: parameter keys unique (label#n, E0..E7)");

  const b = await E.bank.list(rq);
  ok(b.total === 32 && b.slots.length === 32 && b.slots[1].used && b.slots[1].name === "GLASS BELL" && !b.slots[3].used
    && b.slots[31].slot === 31, "librarian: UP_LIST, 32 slots in 2 frames");

  const cap = (await E.capturePatch(rq, info, "acid test")).patch;
  ok(cap.engine === 0 && cap.p.length === info.pcount && cap.pattern && cap.pattern[0][0] === 45 && cap.pattern[0][1] === 1,
    "librarian: capture = DUMP + first 16 steps");
  let rc = await E.bank.put(rq, 10, cap);
  const g = await E.bank.get(rq, info, 10);
  ok(rc === 0 && g.used && g.name === "acid test" && g.engine === 0 && eq(g.p, cap.p) && js(g.pattern) === js(cap.pattern),
    "librarian: UP_PUT -> UP_GET round trip");
  const bad = E.parse[C.UP_PUT](await rq(E.req.upPut(60, cap), { timeout: 2500, retries: 0 }));
  ok(bad.rc === 1, "librarian: UP_PUT to a slot past the bank -> rc 1");
  ok(E.upName("") === "PATCH" && E.upName("abcdefghijklmnop") === "abcdefghijkl" && E.upName("Bäss") === "Bss", "librarian: device names (ASCII, 1..12)");

  await rq(E.req.set(0, 1, 33));
  rc = await E.bank.store(rq, 11, "STORED");
  const g2 = await E.bank.get(rq, info, 11);
  const d1 = E.parse[C.DUMP](await rq(E.req.dump()), info);
  ok(rc === 0 && g2.name === "STORED" && g2.engine === d1.engine && eq(g2.p, d1.p) && g2.p[1] === 33, "librarian: UP_STORE keeps the current sound");

  /* another engine, empty sequencer, then UP_LOAD brings the sound back, not the pattern (LIVE) */
  await rq(E.req.preset(2, 0));
  for (let i = 0; i < info.nstep; i++) await rq(E.req.stepSet(i, emptyStep));
  rc = await E.bank.load(rq, 10);
  const d2 = E.parse[C.DUMP](await rq(E.req.dump()), info);
  const st = [];
  for (let i = 0; i < 16; i++) st.push(E.parse[C.STEP_GET](await rq(E.req.stepGet(i))));
  ok(rc === 0 && d2.engine === 0 && eq(d2.p, cap.p) && st.every((x) => !x.n), "librarian: UP_LOAD applies the sound, the sequencer stays empty (LIVE)");

  rc = await E.bank.erase(rq, 11);
  const b2 = await E.bank.list(rq);
  const rcEmpty = await E.bank.load(rq, 11);
  ok(rc === 0 && !b2.slots[11].used && b2.slots[10].used && rcEmpty === 1, "librarian: UP_ERASE, UP_LOAD of an empty slot -> rc 1");

  /* audition: a PHASE patch with a pattern into an empty sequencer: the sound only (as UP_LOAD in Lowtide), never
     the pattern, and the mix / pattern / key parameters stay (ui.c param_kept) */
  const bass = await E.bank.get(rq, info, 2);   /* PHASE RESO, with the ACID pattern */
  for (let i = 0; i < info.nstep; i++) await rq(E.req.stepSet(i, emptyStep));
  const KEPT = [0, 25, 26, 27, 29, 30, 31, 32, 39, 40, 49];
  for (const [id, v] of [[0, 77], [25, 5], [29, 12], [39, -10], [49, 2]]) await rq(E.req.set(0, id, v));
  const d2b = E.parse[C.DUMP](await rq(E.req.dump()), info);
  const flashBefore = js(m.state.bank);
  let a = await E.auditionPatch(rq, info, bass, { gEng: 20 });
  const d3 = E.parse[C.DUMP](await rq(E.req.dump()), info);
  const st3 = [];
  for (let i = 0; i < 16; i++) st3.push(E.parse[C.STEP_GET](await rq(E.req.stepGet(i))));
  const soundOk = (d, pt) => d.p.every((v, i) => (KEPT.includes(i) ? v === d2b.p[i] : v === pt.p[i]));
  ok(!a.wrote && d3.engine === bass.engine && soundOk(d3, bass) && st3.every((s) => !s.n) && js(m.state.bank) === flashBefore
    && d3.p[0] === 77 && d3.p[25] === 5 && d3.p[29] === 12 && d3.p[49] === 2,
    "librarian: audition = G_ENGSEL + SETs of the sound; no pattern, mix, LEN or key; no flash write");
  /* notes in the sequencer stay too */
  await rq(E.req.stepSet(20, { n: 1, notes: [50, 0, 0, 0], time: 0, flags: 0, vel: 90 }));
  const bell = await E.bank.get(rq, info, 1);
  a = await E.auditionPatch(rq, info, { ...bell, pattern: [[72, 0], [74, 0]] }, { gEng: 20 });
  const s0 = E.parse[C.STEP_GET](await rq(E.req.stepGet(0))), s20 = E.parse[C.STEP_GET](await rq(E.req.stepGet(20)));
  const d4 = E.parse[C.DUMP](await rq(E.req.dump()), info);
  ok(!a.wrote && !s0.n && s20.notes[0] === 50 && d4.engine === 1 && soundOk(d4, bell), "librarian: audition keeps the sequencer as it is");

  /* ties as the firmware keeps them: no note; a rest has no flags */
  const tied = [[60, 1], [61, 4], [0, 4], [0, 3], [64, 2]];
  const norm = E.patternFromSteps(E.stepsFromPattern(tied));
  rc = await E.bank.put(rq, 12, { ...cap, name: "TIES", pattern: tied });
  const g3 = await E.bank.get(rq, info, 12);
  ok(rc === 0 && js(norm.slice(0, 5)) === js([[60, 1], [0, 4], [0, 4], [0, 0], [64, 2]]) && js(g3.pattern) === js(norm),
    "librarian: pattern ties / rests normalised like the firmware");
  rc = await E.bank.store(rq, 13, "");
  ok(rc === 0 && (await E.bank.get(rq, info, 13)).name === `${info.engines[d4.engine]} 14`, "librarian: UP_STORE with no name -> automatic name");

  /* library files */
  const ctx = { keys, engines: info.engines, firmware: info.version, pe0: info.pe0 };
  const pts = [cap, { ...bass, engineName: info.engines[bass.engine], tags: ["bass", "device"] }];
  const file = JSON.parse(JSON.stringify(E.libraryFile("library", pts, ctx)));
  ok(file.format === "felucca-library" && file.version === 1 && file.pCount === 71 && file.paramLabels.length === 71 && file.engines.length === 12,
    "library file: versioned, with P_COUNT, labels and engines");
  const back = E.readLibraryFile(file, ctx);
  ok(back.patches.length === 2 && !back.skipped && eq(back.patches[0].p, cap.p) && eq(back.patches[1].p, bass.p)
    && js(back.patches[1].pattern) === js(bass.pattern) && back.patches[1].tags.join() === "bass,device" && back.patches[1].engineName === "PHASE",
    "library file: write -> read round trip");
  /* a future firmware: one more parameter at id 5, engines in another order and one of them gone */
  const keys2 = [...keys.slice(0, 5), "NEW", ...keys.slice(5)];
  const eng2 = ["PHASE", "ANALOG", "SAMPLE"];
  const fut = E.readLibraryFile(file, { keys: keys2, engines: eng2 });
  const p0 = fut.patches[0].p;
  ok(fut.patches.length === 2 && p0.length === 72 && p0[5] === null && p0[6] === cap.p[5] && p0[71] === cap.p[70]
    && fut.patches[0].engine === 1 && fut.patches[1].engine === 0, "library file: other ids / engine order mapped by label and name");
  /* a library written by 2.5 (61 parameters, the engine's from 53) read by 2.6 (71, from 63): the engine's values
   * land on the new ids, the 2.6 parameters stay unset (their defaults) */
  const keysOld = [...keys.slice(0, 53), ...keys.slice(63)];
  const oldFile = JSON.parse(JSON.stringify(E.libraryFile("old", [{ ...cap, p: [...cap.p.slice(0, 53), ...cap.p.slice(63)] }],
    { keys: keysOld, engines: info.engines, firmware: "SLOOP 2.5", pe0: 53 })));
  const up = E.readLibraryFile(oldFile, ctx), pu = up.patches[0].p;
  ok(oldFile.pCount === 61 && pu.length === 71 && pu.slice(63).join() === cap.p.slice(63).join() && pu[52] === cap.p[52]
    && pu.slice(53, 63).every((x) => x == null), "library file: a 2.5 one (61 parameters) read by 2.6: E1..E8 at 63..70, the new ones unset");
  const lost = E.readLibraryFile({ ...file, patches: [{ ...file.patches[0], engineName: "WAVETABLE" }] }, ctx);
  ok(lost.patches.length === 0 && lost.skipped === 1, "library file: a patch for an unknown engine is skipped");
  const bankFile = E.libraryFile("bank", [{ ...g, engineName: "ANALOG", slot: 10 }], ctx);
  ok(bankFile.kind === "bank" && bankFile.patches[0].slot === 10 && E.readLibraryFile(bankFile, ctx).patches[0].slot === 10, "library file: bank export keeps slot numbers");
  const old = E.readLibraryFile({ format: "felucca-patch", version: 1, engine: 0, preset: 4, engineName: "ANALOG", presetName: "ACID", p: d2.p, steps: E.stepsFromPattern(cap.pattern) }, ctx);
  ok(old.patches.length === 1 && eq(old.patches[0].p, d2.p) && js(old.patches[0].pattern) === js(cap.pattern), "library file: reads the old \"Save to file\" format");
  /* a "Save to file" of 2.5 (61 values, the engine's from 53, no pCount) on 2.6: the engine's 8 at 63..70 */
  const p61 = [...d2.p.slice(0, 53), ...d2.p.slice(63)];
  const o61 = E.readLibraryFile({ format: "felucca-patch", version: 1, engine: 0, preset: 4, engineName: "ANALOG", p: p61 }, ctx).patches[0].p;
  const p71 = E.readLibraryFile({ format: "felucca-patch", version: 1, engine: 0, preset: 4, engineName: "ANALOG", p: d2.p, pCount: 71, pE0: 63 },
    { ...ctx, keys: keys.slice(0, 53).concat(keys.slice(63)) }).patches[0].p;
  ok(o61.length === 71 && o61.slice(63).join() === d2.p.slice(63).join() && o61.slice(53, 63).every((x) => x == null) && o61[52] === d2.p[52]
    && p71.length === 61 && p71.slice(53).join() === d2.p.slice(63).join(),
    "library file: a \"Save to file\" of another version is read by count (the engine's 8 in their place, 61 <-> 71)");
  let threw = false;
  try { E.readLibraryFile({ format: "something" }, ctx); } catch (e) { threw = true; }
  ok(threw, "library file: unknown format -> error");
  done();
}

async function editorLive() {
  const C = E.CMD;
  const { m, link, rq, sent, ev, done } = attachMock({ watchMs: 250 });
  const info = E.parse[C.INFO](await rq(E.req.info()));
  ok(await E.startWatch(rq), "live: WATCH on");

  /* a push between a request and its reply */
  const pend = rq(E.req.dump());
  const kn = m.sim.knob(9, 4);
  const dump = E.parse[C.DUMP](await pend, info);
  const ch = ev.pushes.find((f) => f.cmd === C.CHANGED);
  const cv = ch && E.parse[C.CHANGED](ch.a);
  ok(dump.p.length === 71 && ch && ch.pending === C.DUMP && cv.scope === 0 && cv.id === 9 && cv.value === kn.value && !ev.unknown.length,
    "live: CHANGED while DUMP waits -> push handler, reply still matched");
  const rl = m.sim.reload();
  m.sim.step(3);
  const pend2 = rq(E.req.stepGet(7));
  const s7 = E.parse[C.STEP_GET](await pend2);
  await sleep(10);
  const r = ev.pushes.find((f) => f.cmd === C.RELOAD), sc = ev.pushes.find((f) => f.cmd === C.STEP_CHANGED);
  ok(s7.index === 7 && r && E.parse[C.RELOAD](r.a).preset === rl.preset && sc && E.parse[C.STEP_CHANGED](sc.a).index === 3,
    "live: RELOAD and STEP_CHANGED routed");
  const nr = ev.pushes.filter((f) => f.cmd === C.RELOAD).length;
  await rq(E.req.preset(1, 2));
  await rq(E.req.stepSet(9, { n: 1, notes: [62, 0, 0, 0], time: 0, flags: 0, vel: 90 }));
  await sleep(10);
  ok(ev.pushes.filter((f) => f.cmd === C.RELOAD).length === nr + 1 && !ev.pushes.some((f) => f.cmd === C.STEP_CHANGED && f.a[0] === 9),
    "live: RELOAD after an editor PRESET too, nothing after its STEP_SET");

  /* PING keeps the watch on; without requests it ends */
  for (let i = 0; i < 4; i++) { await sleep(120); await rq(E.req.ping()); }
  let n0 = ev.pushes.length;
  m.sim.knob();
  await sleep(10);
  ok(ev.pushes.length === n0 + 1, "live: PING keeps WATCH on");
  await sleep(320);
  n0 = ev.pushes.length;
  m.sim.knob();
  await sleep(10);
  ok(ev.pushes.length === n0, "live: WATCH ends by itself without requests");

  /* a slider drag: 40 values at once -> one SET in flight + one coalesced, the last value wins */
  const before = sent[C.SET] || 0;
  const all = [];
  for (let v = 0; v < 40; v++) all.push(rq(E.req.set(0, 9, v * 3), { key: "0:9" }));
  await Promise.all(all);
  ok((sent[C.SET] || 0) - before === 2 && m.state.p[9] === 117 && link.idle, "live: drag SETs coalesce (2 frames for 40 values, latest kept)");
  ok(ev.timeouts === 0, "live: no timeouts");
  done();

  /* older firmware: no reply to WATCH -> false without a "no reply" message; no bank */
  const o = attachMock({ legacy: true });
  E.parse[C.INFO](await o.rq(E.req.info()));
  const w = await o.rq(E.req.watch(1), { timeout: 60, retries: 0, quiet: true }).then(() => true, () => false);
  const sw = await E.startWatch(o.rq);
  const bl = await E.bank.list((rr, oo) => o.rq(rr, { ...oo, timeout: 60, quiet: true })).then(() => "listed", (e) => e.message);
  ok(!w && !sw && /^timeout/.test(bl) && o.ev.timeouts === 0, "live: older firmware -> WATCH unanswered (fall back to polling), no bank");
  o.done();
}

/* ------------------------------------------------------ editor protocol v3: tracks --- */
async function editorTracks() {
  const C = E.CMD;
  const { m, rq, ev, done } = attachMock({ watchMs: 1000 });
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const tr = E.parse[C.TRACK](await rq(E.req.track()));
  ok(info.ntrk === 4 && tr.sel === 0 && tr.ntrk === 4 && tr.tracks[0].engine === 0 && tr.tracks[1].engine === 1
    && tr.tracks[3].engine === info.nengines, "tracks: INFO NTRK, TRACK lists 4 (track 4 = drums, engine NENGINES)");
  /* the v1 commands follow the selected track */
  const d0 = E.parse[C.DUMP](await rq(E.req.dump()), info);
  const t1 = E.parse[C.TRACK](await rq(E.req.track(1)));
  const d1 = E.parse[C.DUMP](await rq(E.req.dump()), info);
  await rq(E.req.set(0, 1, 77));
  const td0 = E.parse[C.TRACK_DUMP](await rq(E.req.trackDump(0)), info);
  const td1 = E.parse[C.TRACK_DUMP](await rq(E.req.trackDump(1)), info);
  ok(t1.sel === 1 && d1.engine === 1 && d0.engine === 0 && td1.p[1] === 77 && td0.p[1] === d0.p[1] && td0.p[1] !== 77,
    "tracks: TRACK selects; DUMP / SET act on it, TRACK_DUMP reads any track");
  /* steps of a track that is not selected */
  const w = E.parse[C.TRACK_STEP](await rq(E.req.trackStep(2, 5, { n: 2, notes: [60, 67, 0, 0], time: 0, flags: 1, vel: 99 })));
  const g2 = E.parse[C.TRACK_STEP](await rq(E.req.trackStep(2, 5)));
  const s1 = E.parse[C.STEP_GET](await rq(E.req.stepGet(5)));
  ok(w.track === 2 && g2.n === 2 && g2.notes[1] === 67 && g2.vel === 99 && s1.n === 0, "tracks: TRACK_STEP set / get on another track");
  /* level / mute; the drum level is GLO > DRUMS LEVEL */
  const mx = E.parse[C.TRACK_MIX](await rq(E.req.trackMix(0, 90, 1)));
  const mxd = E.parse[C.TRACK_MIX](await rq(E.req.trackMix(3, 64, 0)));
  const mx2 = E.parse[C.TRACK_MIX](await rq(E.req.trackMix(0)));
  const tr2 = E.parse[C.TRACK](await rq(E.req.track()));
  ok(mx.level === 90 && mx.mute === 1 && mx2.level === 90 && mxd.level === 64 && m.state.g[25] === 64
    && tr2.tracks[0].level === 90 && tr2.tracks[0].mute === 1, "tracks: TRACK_MIX level / mute (drums: G_DRLVL)");
  /* the drum track: no sound to store or load */
  await rq(E.req.track(3));
  const dd = E.parse[C.DUMP](await rq(E.req.dump()), info);
  const us = E.parse[C.UP_STORE](await rq(E.req.upStore(20, "X"), { timeout: 2500, retries: 0 }));
  const ul = E.parse[C.UP_LOAD](await rq(E.req.upLoad(1), { timeout: 2500, retries: 0 }));
  ok(dd.engine === info.nengines && us.rc === 1 && ul.rc === 1, "tracks: drum track selected -> DUMP engine NENGINES, UP_STORE / UP_LOAD rc 1");
  /* pushes carry the selected track */
  await rq(E.req.track(0));
  ok(await E.startWatch(rq), "tracks: WATCH on");
  m.sim.track(2);
  m.sim.step(4);
  await sleep(10);
  const rl = ev.pushes.find((f) => f.cmd === C.RELOAD), sc = ev.pushes.find((f) => f.cmd === C.STEP_CHANGED);
  ok(rl && E.parse[C.RELOAD](rl.a).track === 2 && sc && E.parse[C.STEP_CHANGED](sc.a).track === 2 && E.parse[C.STEP_CHANGED](sc.a).index === 4,
    "tracks: RELOAD / STEP_CHANGED carry the selected track");
  /* projects keep all four tracks */
  await rq(E.req.project(1, 3), { timeout: 4000, retries: 0 });
  await rq(E.req.trackStep(2, 5, { n: 0, notes: [0, 0, 0, 0], time: 2, flags: 0, vel: 0 }));
  await rq(E.req.track(0));
  await rq(E.req.project(0, 3), { timeout: 4000, retries: 0 });
  const back = E.parse[C.TRACK_STEP](await rq(E.req.trackStep(2, 5)));
  const sel = E.parse[C.TRACK](await rq(E.req.track())).sel;
  ok(back.n === 2 && back.notes[0] === 60 && sel === 2, "tracks: PROJECT save / load keeps every track and the selection");
  /* older firmware: no NTRK in INFO, no RELOAD track byte */
  const o = attachMock({ legacy: true });
  const oi = E.parse[C.INFO](await o.rq(E.req.info()));
  ok(oi.ntrk === 0 && E.parse[C.RELOAD]([0, 4]).track === 0 && E.parse[C.STEP_CHANGED]([7]).track === 0, "tracks: older firmware parses (no tracks)");
  o.done();
  done();
}

/* ------------------------------- editor 2.6: SET coalescing per control (SetGate) --- */
/* a user report: DIV 1/8 on the drum track, then 1/8 on a synth track: the second SET never left (the coalescing kept the
   last value sent per control, whatever the track). userSet as editor.html has it, on the mock */
async function editorSetGate() {
  const C = E.CMD;
  const { link, rq, sent, done } = attachMock({});
  const info = E.parse[C.INFO](await rq(E.req.info()));
  let div = -1;
  for (let i = 0; i < info.pcount && div < 0; i++) if (E.parse[C.DESC](await rq(E.req.desc(0, i))).label === "DIV") div = i;
  const gate = new E.SetGate(), k = "0:" + div;
  const pending = (key) => link.hasQueued(key) || (!!link.cur && link.cur.key === key);
  const user = (v) => {                               /* editor.html userSet / sendSet */
    if (!gate.user(k, v, pending(k), Date.now())) return null;
    gate.get(k).sent = v;
    return rq(E.req.set(0, div, v), { key: k });
  };
  const divOf = async (t) => E.parse[C.TRACK_DUMP](await rq(E.req.trackDump(t)), info).p[div];
  await rq(E.req.track(3));
  const d0 = await divOf(0), want = d0 === 1 ? 2 : 1;
  await user(want);
  await rq(E.req.track(0));                           /* (selectTrack -> afterSoundChange: gate.clear()) */
  const n0 = sent[C.SET] || 0;
  const p = user(want);                               /* the same value, track 1: sent, even without the clear */
  if (p) await p;
  ok(div >= 0 && (await divOf(3)) === want && (await divOf(0)) === want && sent[C.SET] === n0 + 1,
    "SetGate: DIV set on the drum track, then the same DIV on track 1: sent, both set");
  gate.clear();
  ok(gate.get(k) === undefined, "SetGate: clear() forgets every control (another track / sound / FM-1)");
  /* a drag: while a SET is pending, the same value is not queued again; a new one replaces the queued one */
  const a = user(5), b = user(5), c = user(6), d = user(6);
  ok(a && b === null && c && d === null, "SetGate: pending: the same value skipped, a new value sent (queued)");
  await Promise.all([a, c]);
  ok((await divOf(0)) === 6, "SetGate: the last value wins");
  ok(user(6) !== null, "SetGate: answered: the same value sent again (a knob may have moved it on the FM-1)");
  await rq(E.req.set(0, div, d0));
  done();
}

/* ------------------------------------------------ editor v3: the mixer (Tracks tab) --- */
async function editorMixer() {
  const C = E.CMD;
  const { m, rq, ev, done } = attachMock({ watchMs: 1000 });
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const PAN = 39, MUTE = 40;
  const m0 = await E.mixer.read(rq, info, { pan: PAN });
  ok(m0.ntrk === 4 && m0.tracks.length === 4 && m0.tracks[1].pan === -24 && m0.tracks[2].pan === 20 && m0.tracks[3].engine === info.nengines
    && m0.tracks.every((x) => Number.isInteger(x.level) && (x.mute === 0 || x.mute === 1)), "mixer: read = TRACK + pan of every track (TRACK_DUMP)");
  /* level / mute of a track that is not selected, and of the drum track (G_DRLVL) */
  const a = await E.mixer.setMix(rq, 2, 70, 1);
  const b = await E.mixer.setMix(rq, 3, 200, 0);
  const m1 = await E.mixer.read(rq, info, { pan: PAN });
  const td2 = E.parse[C.TRACK_DUMP](await rq(E.req.trackDump(2)), info);
  ok(a.level === 70 && a.mute === 1 && b.level === 127 && m.state.g[25] === 127 && m1.tracks[2].level === 70 && m1.tracks[2].mute === 1
    && td2.p[0] === 70 && td2.p[MUTE] === 1 && m1.sel === 0, "mixer: TRACK_MIX level / mute round trip (drums: G_DRLVL, clamped)");
  /* pan of another track: selected for the SET, the selection put back, no RELOAD pushed */
  ok(await E.startWatch(rq), "mixer: WATCH on");
  const pushes = ev.pushes.length;
  /* (the v3 path: firmware 0.8 has no TRACK_PARAM) */
  const p2 = await E.mixer.setPan(rq, 2, 0, PAN, -40);
  const p0 = await E.mixer.setPan(rq, 0, 0, PAN, 99);
  await sleep(10);
  const m2 = await E.mixer.read(rq, info, { pan: PAN });
  const d0 = E.parse[C.DUMP](await rq(E.req.dump()), info);
  ok(p2 === -40 && p0 === 63 && m2.sel === 0 && m2.tracks[2].pan === -40 && m2.tracks[0].pan === 63 && d0.p[PAN] === 63 && m2.tracks[1].pan === -24
    && ev.pushes.length === pushes, "mixer: pan of any track via SET (other track selected for a moment, then back; no push)");
  /* the device's TRACKS page: level of the selected track pushes CHANGED; REC arm shows in TRACK */
  m.sim.level(33);
  m.sim.arm(1);
  await sleep(10);
  const ch = ev.pushes.filter((f) => f.cmd === C.CHANGED).map((f) => E.parse[C.CHANGED](f.a)).pop();
  const m3 = await E.mixer.read(rq, info, { pan: PAN });
  ok(ch && ch.scope === 0 && ch.id === 0 && ch.value === 33 && m3.tracks[0].level === 33 && m3.tracks[1].armed === 1 && m3.tracks[0].armed === 0,
    "mixer: device-side level (CHANGED push) and REC arm read back");
  await rq(E.req.track(3));
  m.sim.level(90);
  await sleep(10);
  const chd = E.parse[C.CHANGED](ev.pushes.filter((f) => f.cmd === C.CHANGED).pop().a);
  ok(chd.scope === 1 && chd.id === 25 && chd.value === 90, "mixer: drum level on the device pushes G_DRLVL");
  /* the drum track's steps: GM notes, shown and typed by name */
  const st = [];
  for (let i = 0; i < 16; i++) st.push(E.parse[C.TRACK_STEP](await rq(E.req.trackStep(3, i))));
  const names = st[0].notes.slice(0, st[0].n).map(E.drumName).join(" ");
  ok(names === "KICK CHH" && st[4].notes.slice(0, 2).map(E.drumName).join(" ") === "SNARE CHH" && E.drumName(20) === "20",
    "mixer: the mock drum track holds a GM pattern (KICK CHH ...)");
  ok(JSON.stringify(E.parseNotes("kick CHH 49")) === "[36,42,49]" && JSON.stringify(E.parseNotes("C4 SNARE")) === "[60,38]" && E.parseNotes("KICKS") === null
    && Object.keys(E.GM_DRUM).length === 47 && new Set(Object.values(E.GM_DRUM)).size === 47, "mixer: GM drum names parse (unique, 35..81)");
  done();
}

/* ------------------------------------- editor v4: TRACK_PARAM and TRACK_CHANGED --- */
async function editorTrackParam() {
  const C = E.CMD, PAN = 39, MUTE = 40;
  const { m, rq, sent, ev, done } = attachMock({ watchMs: 1000 });
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const w1 = E.parse[C.WATCH](await rq(E.req.watch(1)));
  m.sim.param(2, PAN, 11);
  await sleep(10);
  ok(w1.on === 1 && !ev.pushes.some((f) => f.cmd === C.TRACK_CHANGED), "v4: WATCH 1 answers 1 as before (no TRACK_CHANGED pushes)");
  ok(await E.startWatch(rq) === 3, "v4: WATCH 3 -> 3 (TRACK_PARAM / TRACK_CHANGED known)");
  const tracks0 = sent[C.TRACK] || 0, pushes = ev.pushes.length;
  const g = E.parse[C.TRACK_PARAM](await rq(E.req.trackParam(1, PAN)));
  const p2 = await E.mixer.setPan(rq, 2, 0, PAN, -40, true);
  const p1 = await E.mixer.setPan(rq, 1, 0, PAN, 99, true);
  const alg = E.parse[C.TRACK_PARAM](await rq(E.req.trackParam(1, info.pe0, 50)));   /* track 2 is DIGITAL: ALG 0..7 */
  const lv = E.parse[C.TRACK_PARAM](await rq(E.req.trackParam(3, 0, -5)));
  const sel = E.parse[C.TRACK](await rq(E.req.track()));
  const td2 = E.parse[C.TRACK_DUMP](await rq(E.req.trackDump(2)), info);
  await sleep(10);
  ok(g.track === 1 && g.id === PAN && g.value === -24 && p2 === -40 && p1 === 63 && alg.value === 7 && lv.value === 0 && td2.p[PAN] === -40
    && sel.sel === 0 && (sent[C.TRACK] || 0) === tracks0 + 1 && ev.pushes.length === pushes,
    "v4: TRACK_PARAM get / set on other tracks (clamped as SET, selection kept, no push)");
  const bad = await rq(E.req.trackParam(4, PAN), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  ok(bad === "none", "v4: TRACK_PARAM of track 5: no reply");
  /* device-side changes: CHANGED for the selected track, TRACK_CHANGED for the others */
  m.sim.param(2, PAN, 30);
  m.sim.param(3, MUTE, 1);
  m.sim.param(0, PAN, -7);
  await sleep(10);
  const tc = ev.pushes.filter((f) => f.cmd === C.TRACK_CHANGED).map((f) => E.parse[C.TRACK_CHANGED](f.a));
  const ch = ev.pushes.filter((f) => f.cmd === C.CHANGED).map((f) => E.parse[C.CHANGED](f.a)).pop();
  ok(tc.length === 2 && tc[0].track === 2 && tc[0].id === PAN && tc[0].value === 30 && tc[1].track === 3 && tc[1].id === MUTE && tc[1].value === 1
    && ch && ch.scope === 0 && ch.id === PAN && ch.value === -7 && !ev.unknown.length, "v4: TRACK_CHANGED pushes for the other tracks, CHANGED for the selected one");
  done();
  /* firmware 0.8 (v3): WATCH 3 answers 1, TRACK_PARAM unanswered: the editor keeps the select / restore path */
  const o = attachMock({ v3: true, watchMs: 1000 });
  E.parse[C.INFO](await o.rq(E.req.info()));
  const on = await E.startWatch(o.rq);
  const tp = await o.rq(E.req.trackParam(1, PAN), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  const pv = await E.mixer.setPan(o.rq, 2, 0, PAN, 5, false);
  ok(on === 1 && tp === "none" && pv === 5 && o.ev.timeouts === 0 && !o.ev.unknown.length, "v4: v3 firmware -> WATCH 1, no TRACK_PARAM (pan by select / restore)");
  o.done();
}

/* ------------------------------------- editor v9 (SLOOP 2.4): FM6 patches --- */
async function editorV9() {
  const C = E.CMD, F = E.FM6;
  /* the editor's factory patches == the firmware's (build/gen/felucca_fm6.h, tools/gen_fm6_patches.py) */
  const gp = join(HERE, "../build/gen/felucca_fm6.h");
  if (existsSync(gp)) {
    const h = readFileSync(gp, "utf8").replace(/\/\*[^*]*\*\//g, "");
    const arr = (name) => (new RegExp(`${name}\\[[^\\]]*\\](?:\\[[^\\]]*\\])?\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(h) || [])[1] || "";
    const nums = (x) => (x.match(/\d+/g) || []).map(Number);
    const fac = nums(arr("FM6_FACTORY"));
    ok(js(nums(arr("FM6_INIT"))) === js(Array.from(F.INIT_PK)) && fac.length === F.FACTORY_PK.length * 128
      && F.FACTORY_PK.every((pk, i) => js(Array.from(pk)) === js(fac.slice(i * 128, i * 128 + 128))),
    "v9: the editor's init and factory patches == felucca_fm6.h");
  }
  /* pack / unpack: every voice survives, every value into its range */
  let rt = true;
  for (let n = 0; n < 50; n++) {
    const v = F.sanitize(Uint8Array.from({ length: F.SIZE }, (_, i) => (i * 37 + n * 101 + (i * n) % 13) & 127));
    if (js(Array.from(F.unpack(F.pack(v)))) !== js(Array.from(v))) rt = false;
  }
  ok(rt, "v9: FM6 pack / unpack round trip (50 voices, sanitized)");
  /* SysEx: one voice (163 bytes) and a 32-voice bank (4104 bytes), names, checksums */
  const v1 = F.factory(0), one = F.singleSysex(v1), p1 = F.parseSysex(one);
  ok(one.length === 163 && one[0] === 0xF0 && one[162] === 0xF7 && p1.voices.length === 1 && !p1.badSum
    && js(Array.from(p1.voices[0].v)) === js(Array.from(v1)), "v9: single-voice SysEx: 163 bytes, read back the same");
  const voices = Array.from({ length: 32 }, (_, k) => { const v = F.factory(k % F.FACTORY_PK.length); F.setName(v, `VOICE ${k + 1}`); return v; });
  const bank = F.bankSysex(voices), pb = F.parseSysex(bank);
  ok(bank.length === 4104 && pb.voices.length === 32 && !pb.badSum && pb.voices[31].name.trim() === "VOICE 32"
    && pb.voices.every((x, k) => js(Array.from(x.v)) === js(Array.from(F.unpack(F.pack(voices[k]))))),
  "v9: 32-voice bank SysEx: 4104 bytes, 32 voices with their names");
  const badb = Uint8Array.from(bank); badb[4102] ^= 1;
  ok(F.parseSysex(badb).badSum, "v9: a bank with a wrong checksum is read but flagged");
  /* damaged and unusual files (2.4, after Felucca 1.0.3) */
  const cut = bank.subarray(0, 6 + 128 * 10 + 50);               /* cut inside voice 11 */
  const pc = F.parseSysex(cut);
  ok(pc.voices.length === 10 && pc.short === 1 && pc.voices[9].name.trim() === "VOICE 10", "v9: a bank cut short: its whole voices, flagged");
  const two = Uint8Array.from([...bank, ...one]), p2 = F.parseSysex(two);
  ok(p2.voices.length === 33 && !p2.badSum && !p2.short, "v9: a bank and a voice in one file: 33 voices");
  const nof7 = Uint8Array.from([...bank.subarray(0, 4102), ...one]);   /* the bank with no checksum / F7 */
  ok(F.parseSysex(nof7).voices.length === 33, "v9: a message with no end: the next one still read");
  const raw2 = new Uint8Array(8192); raw2.set(bank.subarray(6, 4102), 0); raw2.set(bank.subarray(6, 4102), 4096);
  ok(F.parseSysex(raw2).voices.length === 64, "v9: raw data, two 4096-byte banks: 64 voices");
  const fm4 = Uint8Array.from([0xF0, 0x43, 0x00, 0x04, 0x20, 0x00, ...new Array(4096).fill(0), 0, 0xF7]), p4 = F.parseSysex(fm4);
  ok(!p4.voices.length && p4.kinds.includes("fm4") && p4.sysex, "v9: 4-operator voices: none read, said so");
  const roland = F.parseSysex(Uint8Array.from([0xF0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7F, 0x00, 0x41, 0xF7]));
  ok(!roland.voices.length && roland.kinds[0] === "maker:41", "v9: another maker's SysEx: its ID");
  ok(!F.parseSysex(Uint8Array.from([1, 2, 3])).sysex, "v9: not SysEx at all: said so");
  /* the device: FM6_LIST / GET / PUT / ERASE */
  const { m, rq, done } = attachMock({});
  const info = E.parse[C.INFO](await rq(E.req.info()));
  ok(info.proto === 19 && info.nengines === 12 && info.engines[9] === "FM6", "v9: INFO ends with 19 (v19 includes v9), FM6 is engine 9");
  const L = E.parse[C.FM6_LIST](await rq(E.req.fm6List()));
  if (!(L.factory === 8 && L.bank === 27 && L.slots.length === 35)) console.log("  FM6_LIST", L.factory, L.bank, L.slots.length, js(L.slots.slice(0, 10)));
  ok(L.factory === 8 && L.bank === 27 && L.slots.length === 35 && L.slots[0].used, "v9: FM6_LIST: 8 factory patches, 27 bank slots");
  const mine = F.factory(3); F.setName(mine, "MY BELL");
  let r = E.parse[C.FM6_PUT](await rq(E.req.fm6Put(F.TARGET.TRACK, 1, F.pack(mine))));
  const g = E.parse[C.FM6_GET](await rq(E.req.fm6Get(F.TARGET.TRACK, 1)));
  ok(r.rc === 0 && g.rc === 0 && F.name(F.unpack(g.packed)).trim() === "MY BELL", "v9: FM6_PUT to track 2, FM6_GET reads it back");
  r = E.parse[C.FM6_PUT](await rq(E.req.fm6Put(F.TARGET.BANK, 4, F.pack(mine)), { timeout: 3000 }));
  const L2 = E.parse[C.FM6_LIST](await rq(E.req.fm6List()));
  ok(r.rc === 0 && L2.slots[8 + 4].used && L2.slots[8 + 4].name.trim() === "MY BELL", "v9: stored in bank slot B5, listed by name");
  m.sim.play(true);
  r = E.parse[C.FM6_PUT](await rq(E.req.fm6Put(F.TARGET.BANK, 5, F.pack(mine)), { timeout: 3000 }));
  const re = E.parse[C.FM6_ERASE](await rq(E.req.fm6Erase(4), { timeout: 3000 }));
  ok(r.rc === 3 && re.rc === 3, "v9: bank writes refused while the song plays (rc 3)");
  m.sim.play(false);
  const e1 = E.parse[C.FM6_ERASE](await rq(E.req.fm6Erase(4), { timeout: 3000 }));
  const ge = E.parse[C.FM6_GET](await rq(E.req.fm6Get(F.TARGET.BANK, 4)));
  const bad = E.parse[C.FM6_GET](await rq(E.req.fm6Get(F.TARGET.FACTORY, 30)));
  ok(e1.rc === 0 && ge.rc === 2 && bad.rc === 1, "v9: FM6_ERASE empties the slot (GET rc 2), a bad index is rc 1");
  done();
  const old = attachMock({ v8: true });
  const oi = E.parse[C.INFO](await old.rq(E.req.info()));
  let none = false;
  try { await old.rq(E.req.fm6List(), { timeout: 200, retries: 0 }); } catch (e) { none = true; }
  ok(oi.proto === 8 && none, "v9: a v8 device says 8 and does not answer FM6_LIST (the editor hides the FM6 panel)");
  old.done();
}

/* ------------------------------------- editor v6: backup / restore --- */
async function editorBackup() {
  const C = E.CMD;
  const { rq, done } = attachMock({});
  const info = E.parse[C.INFO](await rq(E.req.info()));
  ok(info.proto >= 6, "backup: INFO protocol v6 or later");
  const ec = readFileSync(join(HERE, "../firmware/src/editor.c"), "utf8");
  ok(/ED_BK_IDS\[\] = \{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 32, 33, 34, 35\}/.test(ec) && E.backupObjects && [10, 11].every((id) => ec.includes(`id == ${id}u`)),
    "backup: the object ids == editor.c ED_BK_IDS (35: USR4, 9: SYN kits, 10: MIDI LEARN, 11: theme, 12: the drum map + knob speed, 13: the kit slices)");
  await rq(E.req.upStore(3, "BACKUP ME"));
  await rq(E.req.project(1, 2), { timeout: 4000, retries: 0 });
  const s = Int16Array.from({ length: 3000 }, (_, i) => Math.round(8000 * Math.sin(i / 7)));
  const { hdr, data } = E.buildSlot("test", [{ s, root: 60 }]);
  await rq(E.req.smpBegin(1), { timeout: 1000, retries: 0 });
  for (let off = 0; off < data.length; off += 256) await rq(E.req.smpWrite(1, E.SMP.DATA_OFF + off, data.subarray(off, off + 256)), { timeout: 1000 });
  await rq(E.req.smpEnd(1, hdr), { timeout: 2000, retries: 0 });
  const A = await E.backupCapture(rq, info);
  const obj = (id) => A.objects.find((o) => o.id === id);
  ok(A.format === "sloop-backup" && A.objects.map((o) => o.id).join() === "0,1,2,3,4,5,6,7,8,9,32,33,34,35" && obj(9).len === 1464 && obj(33).len > 512 && obj(35).len === 0
    && obj(4).len > 0 && obj(3).len === 0 && obj(32).len === 0, "backup: LIST + GET: 14 objects (project in C, sample in USR2, B empty, the FM6 bank, the SYN kits, USR4)");
  await rq(E.req.upErase(3));
  await rq(E.req.smpErase(1), { timeout: 2500, retries: 0 });
  await rq(E.req.set(0, 3, 5));
  await rq(E.req.project(1, 1), { timeout: 4000, retries: 0 });
  await E.backupRestore(rq, JSON.parse(JSON.stringify(A)));   /* as written to disk and read back */
  const B = await E.backupCapture(rq, info);
  ok(js(B.objects) === js(A.objects), "backup: restore -> the same bytes again (presets, projects, samples, settings)");
  const bad = JSON.parse(JSON.stringify(A));
  bad.objects[2].data = E.b64enc(E.b64dec(bad.objects[2].data).map((x, i) => i === 3 ? x ^ 1 : x));
  let caught = "";
  try { E.backupObjects(bad); } catch (e) { caught = e.code; }
  ok(caught === "bkBad", "backup: a damaged file is refused before anything is written");
  done();
  const old = attachMock({ noBackup: true });
  const oi = E.parse[C.INFO](await old.rq(E.req.info()));
  ok(oi.proto === 5, "backup: firmware without it says protocol 5 (the editor hides backup)");
  old.done();
}

/* --------------------------- the drum map + knob speed (backup object 12, 17 bytes) --- */
async function editorDrumMap() {
  const C = E.CMD;
  const { m, rq, done } = attachMock({});
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const list = async () => E.parse[C.BK_LIST](await rq(E.req.bkList()));
  const get12 = async () => {
    await list();   /* the mock's BK_GET reads the snapshot a BK_LIST took (a BK_PUT clears it) */
    const g = E.parse[C.BK_GET](await rq(E.req.bkGet(12, 0, 17)));
    if (g.rc) throw new Error(`GET rc ${g.rc}`);
    return g.data;
  };
  const put12 = async (bytes) => {
    let r = E.parse[C.BK_PUT](await rq(E.req.bkBegin(12, bytes.length, E.crc32(bytes))));
    if (r.rc) return r.rc;
    r = E.parse[C.BK_PUT](await rq(E.req.bkData(12, 0, bytes)));
    if (r.rc) return r.rc;
    return E.parse[C.BK_PUT](await rq(E.req.bkCommit(12))).rc;
  };
  ok(!(await list()).items.some((x) => x.id === 12), "drum map: object 12 absent when the map is default (speed 1x)");
  /* (2.8.4) the drum preset: TRACK_DUMP on the drum track reads its kit, TRACK_PARAM writes it — the
     preset dropdown's protocol. The mock's drum track powers on with kit 5 (808). */
  const kitOf = async () => E.parse[C.TRACK_DUMP](await rq(E.req.trackDump(3)), info).p[info.pe0];
  ok((await kitOf()) === 5, "drum pads: the drum track's kit reads as 808 (index 5) on the mock device");
  ok(E.parse[C.TRACK_PARAM](await rq(E.req.trackParam(3, info.pe0, 6))).value === 6 && (await kitOf()) === 6
    && E.parse[C.TRACK_PARAM](await rq(E.req.trackParam(3, info.pe0, 5))).value === 5 && (await kitOf()) === 5,
    "drum pads: TRACK_PARAM writes the drum track's kit (808 -> 909 -> 808, read back each time)");
  /* swap KICK and HI TOM, speed 2x */
  const map = new Uint8Array(17).fill(0xFF);
  map[0] = 10; map[12] = 0; map[16] = 8;
  ok((await put12(map)) === 0, "drum map: BK_PUT of 17 bytes commits (rc 0)");
  const it = (await list()).items.find((x) => x.id === 12);
  const back = await get12();
  ok(!!it && it.len === 17 && eq(back, map) && it.crc === E.crc32(map) && m.state.drumMap[16] === 8,
    "drum map: BK_LIST shows object 12 (17 bytes); BK_GET reads the swapped map and speed 2x back");
  /* speed only: 4x, map back to default */
  const fast = new Uint8Array(17).fill(0xFF); fast[16] = 16;
  ok((await put12(fast)) === 0 && (await get12())[16] === 16 && m.state.drumMap[16] === 16, "drum map: speed 4x round trip (byte 16)");
  /* reset to the default: the object leaves BK_LIST again */
  const def = new Uint8Array(17).fill(0xFF); def[16] = 4;
  ok((await put12(def)) === 0 && !(await list()).items.some((x) => x.id === 12), "drum map: all-0xFF + speed 1x is the default again (object 12 unlisted)");
  /* a bad object is refused; a bad byte is taken as the firmware takes it (project.c drum_part_read) */
  const badLen = new Uint8Array(16).fill(0xFF);
  ok((await put12(badLen)) === 2, "drum map: 16 bytes (not 17) -> rc 2");
  const badSpeed = new Uint8Array(17).fill(0xFF); badSpeed[16] = 3;
  ok((await put12(badSpeed)) === 0 && m.state.drumMap[16] === 4 && !(await list()).items.some((x) => x.id === 12),
    "drum map: speed 3 (not a quarter step) -> stored as 1x (and the object is default again)");
  const badLane = new Uint8Array(17).fill(0xFF); badLane[0] = 20; badLane[16] = 8;
  ok((await put12(badLane)) === 0 && (await get12())[0] === 0xFF && m.state.drumMap[16] === 8,
    "drum map: lane 20 (not a lane) -> stored as unmapped, the speed kept");
  /* the editor's GM fallback for notes 36..51 == drums.c LANE_OF_GM (the device's default for an unmapped note) */
  const dc = readFileSync(join(HERE, "../firmware/src/drums.c"), "utf8");
  const gmNums = ((/LANE_OF_GM\[81 - 35 \+ 1\] = \{([^}]*)\}/.exec(dc) || [])[1] || "").replace(/\/\*[^*]*\*\//g, "").split(",").map((x) => x.trim() === "DRUM_LANE_NONE" ? 255 : +x);   /* (2.8.7) the firmware table has no DRUM_LANE_NONE left: the four ex-tom notes now answer lanes */
  const ed = readFileSync(join(HERE, "editor.html"), "utf8");
  const fb = ((/GM_FALLBACK: \[([^\]]*)\]/.exec(ed) || [])[1] || "").split(",").map((x) => +x);
  ok(gmNums.length === 47 && fb.join() === gmNums.slice(1, 17).join(),
    "drum map: the editor's GM fallback for notes 36..51 == drums.c LANE_OF_GM");
  /* a backup carries object 12; a restore puts it back */
  await put12(map);
  const A = await E.backupCapture(rq, info);
  await put12(def);
  ok(A.objects.some((x) => x.id === 12 && x.len === 17), "drum map: a backup holds object 12 when non-default");
  await E.backupRestore(rq, JSON.parse(JSON.stringify(A)));
  ok(eq(await get12(), map) && m.state.drumMap[16] === 8, "drum map: a restore puts the map and speed back");
  /* (2.8.6) the drum-pad MIDI learn is gone: DP_LEARN (78) is no command any more — the editor has
     no dpLearn request and no parser for 78, the mock does not answer it, and the protocol is v15.
     DRUM_TRIG (79) stays. */
  ok(C.DP_LEARN === undefined && !E.req.dpLearn && !E.parse[78] && info.proto === 19,
    "drum pad learn: DP_LEARN is gone (no command 78, no dpLearn request, no parser; protocol v19)");
  await put12(def);   /* the default map: every pad plays its GM sound */
  const unanswered = await rq([78, [0]], { timeout: 250, retries: 0 }).then(() => "answered", (e) => e.message);
  ok(/^timeout/.test(unanswered) && !(await list()).items.some((x) => x.id === 12),
    "drum pad learn: a DP_LEARN frame (78) gets no reply from the device and changes nothing");
  /* (2.8.3) TRUE MOVES: the editor's effective pads, from the map bytes alone (the pure functions, run in
     a sandbox with no device: DR MAP off, so the default is the GM sound). PAD_NOTES order is
     [48,49,50,51,44,45,46,47,40,41,42,43,36,37,38,39]; the default eff there is
     [10,11,15,12,6,13,5,14,8,1,4,9,0,7,2,3] — (2.8.7) the filled default grid: the tom's other pads
     (50, 45, 47, 41) now play COWBELL, SHAKER, CONGA and KICK 2, so no pad is silent by default. */
  const dpSrc = ed.slice(ed.indexOf("const DRUM_LANES ="), ed.indexOf("const LV_NAMES"))
    + ed.slice(ed.indexOf("const DRUMPADS = {"), ed.indexOf("function drumPadsStatus"));
  const D = vm.runInNewContext(dpSrc + `\n;({ DRUMPADS, drumPads, drumPadsEff, drumPadsSerialize, drumPadsDefaultLane, drumPadsDeviceEff, drumPadsHearNote, drumPadsNotesOfLane, kitLaneNotes, kitLaneGridPos, drumPadsTriggeredLine, drumPadsExportData, drumPadsParseImport })`,
    { console, dev: null });
  D.drumPads.map = new Uint8Array(16).fill(0xFF);
  ok(D.drumPadsEff().join() === [10, 11, 15, 12, 6, 13, 5, 14, 8, 1, 4, 9, 0, 7, 2, 3].join(),
    "drum map: true moves: the default grid plays each pad's GM sound (the filled default: no pad silent)");
  D.drumPads.map[0] = 10;   /* HI TOM on pad 36: pad 48 goes silent */
  ok(D.drumPadsEff().join() === [255, 11, 15, 12, 6, 13, 5, 14, 8, 1, 4, 9, 10, 7, 2, 3].join(),
    "drum map: true moves: a moved sound's other pads are silent (HI TOM on 36 silences 48)");
  ok(eq(D.drumPadsSerialize(D.drumPadsEff()), new Uint8Array([10, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])),
    "drum map: true moves: silent pads serialise as unmapped (0xFF), the moved lane as its byte");
  D.drumPads.map = new Uint8Array(16).fill(0xFF);
  D.drumPads.map[12] = 15;   /* COWBELL on pad 48: its default pad D2 (50) goes silent (2.8.7: COWBELL's default is D2) */
  ok(D.drumPadsEff().join() === [15, 11, 255, 12, 6, 13, 5, 14, 8, 1, 4, 9, 0, 7, 2, 3].join()
    && eq(D.drumPadsSerialize(D.drumPadsEff()), new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 15, 0xFF, 0xFF, 0xFF])),
    "drum map: true moves: COWBELL on pad 48, its default pad D2 goes silent");
  /* the grid and the map bytes agree: a swap (KICK <-> HI TOM, bytes 0 and 12) shows each sound on its own
     pad and serialises back to the same bytes (the bytes are per note, not per grid position) */
  D.drumPads.map = new Uint8Array(16).fill(0xFF);
  D.drumPads.map[0] = 10; D.drumPads.map[12] = 0;
  ok(D.drumPadsEff().join() === [0, 11, 15, 12, 6, 13, 5, 14, 8, 1, 4, 9, 10, 7, 2, 3].join()
    && eq(D.drumPadsSerialize(D.drumPadsEff()), D.drumPads.map),
    "drum map: true moves: a KICK/HI TOM swap shows on the right pads and round-trips");
  /* (2.8.9, item 13) the kit builder shows the position's note name next to the sound (C1 at the
     bottom-left, name only, no MIDI number): renderKits sets each pad's key label from its grid
     position, and the tooltip stays empty */
  ok(/pu\.key\.textContent = DRUMPADS\.ableton\(DRUMPADS\.PAD_NOTES\[i\]\)/.test(ed) && /pu\.key\.title = ""/.test(ed)
    && !/pu\.key\.textContent = ""/.test(ed)
    && D.DRUMPADS.ableton(36) === "C1" && D.DRUMPADS.ableton(48) === "C2" && D.DRUMPADS.ableton(51) === "D#2",
    "drum pads: the kit builder shows the position note name next to the sound (C1, C2, D#2 — name only, no MIDI number)");
  /* (2.8.3) PREVIEW: the note that plays a lane on the FM-1 as it is now (its map as last read, obj): with
     the default device map, HI TOM is heard on 48 (its first pad), KICK on 36, COWBELL on D2 (50, its
     default pad since 2.8.7); with HI TOM moved to 36 on the device, it is heard on 36 — and KICK, on no pad
     with its usual note taken, has no note at all (-1) */
  const defObj = () => { const b = new Uint8Array(17).fill(0xFF); b[16] = 4; return b; };
  D.drumPads.obj = defObj();
  ok(D.drumPadsHearNote(10) === 48 && D.drumPadsHearNote(0) === 36 && D.drumPadsHearNote(15) === 50
    && D.drumPadsHearNote(9) === 43,
    "drum map: preview: the note that plays a lane on the default device map");
  D.drumPads.obj = defObj(); D.drumPads.obj[0] = 10;   /* HI TOM on 36 on the device */
  ok(D.drumPadsHearNote(10) === 36 && D.drumPadsHearNote(0) === -1,
    "drum map: preview: a moved lane is heard on its pad; a lane with no pad and its note taken has none");
  D.drumPads.obj = defObj(); D.drumPads.obj[12] = 15;   /* COWBELL on 48 on the device */
  ok(D.drumPadsHearNote(15) === 48,
    "drum map: preview: COWBELL moved to pad 48 is heard on 48, not its usual note 56");
  /* (2.8.5) the drum pad file: export round-trips, import validates each entry on its own. The file
     keeps the MIDI numbers (a file needs them) and the sound names are informational — the lane
     decides. The speed is not in the file. */
  D.drumPads.map = new Uint8Array(16).fill(0xFF);
  const exported = D.drumPadsExportData();
  ok(exported.entries.length === 16 && exported.entries[0].note === 48 && exported.entries[0].lane === 10
    && exported.entries[0].sound === "HI TOM" && exported.entries[12].note === 36 && exported.entries[12].lane === 0
    && exported.entries[12].sound === "KICK" && exported.entries[2].note === 50 && exported.entries[2].lane === 15
    && exported.entries[2].sound === "COWBELL" && exported.entries[9].note === 41 && exported.entries[9].lane === 1
    && exported.entries[9].sound === "KICK 2" && exported.firmware === "",
    "drum pads: export: 16 entries in PAD_NOTES order, note + lane + sound (the file keeps the MIDI numbers)");
  const roundTrip = D.drumPadsParseImport(JSON.parse(JSON.stringify(exported)));
  ok(eq(roundTrip.map, D.drumPads.map) && roundTrip.bad.length === 0,
    "drum pads: import: the exported file reads back to the same map, nothing rejected");
  D.drumPads.map = new Uint8Array(16).fill(0xFF); D.drumPads.map[0] = 10;   /* HI TOM on 36: 48 silent */
  const imported = D.drumPadsParseImport({ entries: [{ note: 48, lane: 0 }, { note: 36, lane: 10 }] });
  ok(imported.bad.length === 0 && imported.map[12] === 0 && imported.map[0] === 10,
    "drum pads: import: two entries swap KICK and HI TOM (the import loads the map, written at once)");
  const badImport = D.drumPadsParseImport({ entries: [{ note: 48, lane: 20 }, { note: 35, lane: 0 }, { note: 48, lane: 0 }, { note: 40, lane: -1 }] });
  ok(badImport.bad.length === 3 && badImport.bad.join() === "48,35,40" && badImport.map[12] === 0 && badImport.map[0] === 10,
    "drum pads: import: a bad lane, a bad note and a negative lane are rejected per entry (named), the good entry still lands");
  const dupImport = D.drumPadsParseImport({ entries: [{ note: 48, lane: 0 }, { note: 36, lane: 0 }] });
  ok(dupImport.bad.length === 1 && dupImport.bad[0] === 36 && dupImport.map[12] === 0 && dupImport.map[0] === 10,
    "drum pads: import: a lane named by two entries is rejected on the second (a lane with no pad has nowhere to show)");
  let threw = false;
  try { D.drumPadsParseImport({ entries: "no" }); } catch (e) { threw = /not a drum pad file/.test(e.message); }
  try { D.drumPadsParseImport(null); } catch (e) { threw = threw && /not a drum pad file/.test(e.message); }
  ok(threw, "drum pads: import: a file without an entries array is refused");
  /* (2.8.6) single-note toms: a tom answers only its home note — LOW TOM G1 (43), HI TOM C2 (48).
     (2.8.7) the filled default grid: the tom's other notes are separate sounds now (F1 KICK 2, A1 SHAKER,
     B1 CONGA, D2 COWBELL), so moving a sound onto a tom pad leaves them playing — and the serialize
     still writes just the two swapped bytes: no explicit tom bytes on the other notes. */
  D.drumPads.map = new Uint8Array(16).fill(0xFF);
  const rideSwap = D.drumPadsEff();   /* RIDE (51) <-> LOW TOM (43) */
  const t = rideSwap[3]; rideSwap[3] = rideSwap[11]; rideSwap[11] = t;
  const rideMap = D.drumPadsSerialize(rideSwap);
  ok(rideMap[7] === 12 && rideMap[15] === 9 && rideMap[5] === 0xFF && rideMap[9] === 0xFF
    && rideMap[11] === 0xFF && rideMap[3] === 0xFF,
    "drum map: single-note toms: RIDE onto G1 (43) writes just the two swapped bytes (LOW TOM on 51, RIDE on 43)");
  D.drumPads.map = rideMap;
  ok(D.drumPadsEff()[3] === 9 && D.drumPadsEff()[11] === 12 && D.drumPadsEff()[9] === 1 && D.drumPadsEff()[5] === 13,
    "drum map: single-note toms: after the swap, D#2 plays LOW TOM, G1 plays RIDE, F1 still plays KICK 2 and A1 still plays SHAKER");
  D.drumPads.map = new Uint8Array(16).fill(0xFF);
  const hiSwap = D.drumPadsEff();   /* SNARE (38) <-> HI TOM (48) */
  const u = hiSwap[0]; hiSwap[0] = hiSwap[14]; hiSwap[14] = u;
  const hiMap = D.drumPadsSerialize(hiSwap);
  ok(hiMap[12] === 2 && hiMap[2] === 10 && hiMap[11] === 0xFF && hiMap[14] === 0xFF,
    "drum map: single-note toms: SNARE onto C2 (48) writes just the two swapped bytes (HI TOM on 38, SNARE on 48)");
  D.drumPads.map = hiMap;
  ok(D.drumPadsEff()[0] === 2 && D.drumPadsEff()[14] === 10 && D.drumPadsEff()[7] === 14 && D.drumPadsEff()[2] === 15,
    "drum map: single-note toms: after the swap, C2 plays SNARE, B1 still plays CONGA and D2 still plays COWBELL");
  /* (2.8.5) the kit builder follows the Drum Pads layout: a lane sits at its first pad in PAD_NOTES
     order (a tom at its home pad); a lane on no pad goes after the grid, in lane order.
     (2.8.7) the filled default grid: every lane is on a pad now, so none goes after the grid — KICK 2
     sits on F1, SHAKER on A1, CONGA on B1, COWBELL on D2. This is the layout Reset produces (the
     default map, all 0xFF), so after Reset the kit builder shows the sounds at these positions. */
  D.drumPads.map = new Uint8Array(16).fill(0xFF);
  ok(D.kitLaneGridPos(0) === 12 && D.kitLaneGridPos(10) === 0 && D.kitLaneGridPos(9) === 11
    && D.kitLaneGridPos(15) === 2 && D.kitLaneGridPos(1) === 9 && D.kitLaneGridPos(13) === 5 && D.kitLaneGridPos(14) === 7,
    "drum pads: kit layout: KICK at pad 12, HI TOM at pad 0, LOW TOM at pad 11, COWBELL on D2, KICK 2 on F1, SHAKER on A1, CONGA on B1 (the filled default grid, as after Reset)");
  D.drumPads.map[0] = 10; D.drumPads.map[12] = 0;   /* KICK <-> HI TOM */
  ok(D.kitLaneGridPos(0) === 0 && D.kitLaneGridPos(10) === 12,
    "drum pads: kit layout: after a swap, KICK sits at pad 0 and HI TOM at pad 12");
  ok(/const order = \[\.\.\.Array\(16\)\.keys\(\)\]\.sort\(\(a, b\) => kitLaneGridPos\(a\) - kitLaneGridPos\(b\)/.test(ed)
    && /u\.grid\.append\(\.\.\.order\.map\(\(l\) => u\.pads\[l\]\.box\)\)/.test(ed),
    "drum pads: kit layout: renderKits orders the builder's pads by kitLaneGridPos (the Drum Pads layout)");
  /* (2.8.6) the help text is the new one, exactly: click to preview, tap a physical pad, drag to swap,
     every kit, the preset's sound, and the preset below */
  ok(/Click a pad to preview\. Tap your physical drum pad to preview\. Drag a sound to another pad to swap them\. Applies to every kit: sample kits, drum synth kits and user kits\. The sounds come from the drum preset \(kit\) currently selected on the drum track — tapping a pad plays that preset's sound\. You can also change the preset below\./.test(ed)
    && !/as in Ableton's Drum Rack/.test(ed) && !/still plays on its usual note too/.test(ed),
    "drum map: the help text is the new one (click/tap/drag, every kit, the preset below)");
  ok(/\.dppad \.sound \{ font-size: 17px/.test(ed) && /\.dppad \.note \{ font-size: 14px; color: var\(--fg2\)/.test(ed)
    && !/\.dppad \.midi \{/.test(ed) && !/class: "midi"/.test(ed),
    "drum map: the pad labels are larger and brighter (sound 17px, note 14px fg2) and the MIDI number is gone from the pads");
  /* (2.8.4) the preset: the fallback kit names, and the last triggered line */
  const kitEnum = [...ed.match(/const KIT = E\("KIT", \[([^\]]*)\], 0\)/)[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  ok(D.DRUMPADS.KIT_NAMES.length === 46 && js(D.DRUMPADS.KIT_NAMES) === js(kitEnum),
    "drum pads: the fallback kit names are the firmware's 46 (the mock's KIT enum)");
  /* (2.8.5) the last triggered line: channel, Ableton note name, sound and velocity — no MIDI note
     number, and no CC: a CC has no note name and no sound, so it leaves the line alone (see MIDI in
     below). A trigger with no velocity known leaves the velocity off. */
  ok(D.drumPadsTriggeredLine({ ch: 10, note: 36, lane: 0, vel: 100 }) === "Last triggered: Ch 10 · C1 · KICK · Vel 100"
    && D.drumPadsTriggeredLine({ ch: 10, note: 48, lane: 10, vel: 80 }) === "Last triggered: Ch 10 · C2 · HI TOM · Vel 80"
    && D.drumPadsTriggeredLine({ ch: 10, note: 48, lane: 255, vel: 100 }) === "Last triggered: Ch 10 · C2 · — · Vel 100"
    && D.drumPadsTriggeredLine({ ch: 10, note: 51, lane: 12, vel: 100 }) === "Last triggered: Ch 10 · D#2 · RIDE · Vel 100"
    && D.drumPadsTriggeredLine({ ch: 10, note: 36, lane: 0 }) === "Last triggered: Ch 10 · C1 · KICK",
    "drum pads: the last triggered line shows channel, note name, sound and velocity — no note number; without a velocity the Vel part is left off");
  /* (2.8.5) MIDI in: a note on the drum channel (10) shows in the last triggered line; another channel,
     note-offs and CCs leave it alone; a silent pad shows no sound. (The pad-order lookup matters here:
     drumPadsEff is in PAD_NOTES order, not note order.) */
  const miDev = { dump: { g: new Array(50).fill(0) }, gdesc: [], info: { pe0: 63 } };
  miDev.dump.g[24] = 10;   /* the drum channel */
  const DM = vm.runInNewContext(dpSrc + `\n;({ drumPads, drumPadsMidiIn })`,
    { console, dev: miDev, lvG: (l, d) => d, lvGv: (id) => miDev.dump.g[id] });
  DM.drumPadsMidiIn([0x99, 36, 100]);
  const trig36 = DM.drumPads.trigMsg;
  DM.drumPadsMidiIn([0x98, 36, 100]);
  const trigCh9 = DM.drumPads.trigMsg;
  DM.drumPadsMidiIn([0x99, 36, 0]);
  const trigOff = DM.drumPads.trigMsg;
  DM.drumPadsMidiIn([0xB9, 74, 100]);
  const trigCC = DM.drumPads.trigMsg;
  DM.drumPads.map = new Uint8Array(16).fill(0xFF); DM.drumPads.map[0] = 10;   /* HI TOM on 36: 48 goes silent */
  DM.drumPadsMidiIn([0x99, 48, 100]);
  const trigSilent = DM.drumPads.trigMsg;
  ok(trig36 === "Last triggered: Ch 10 · C1 · KICK · Vel 100"
    && trigCh9 === trig36 && trigOff === trig36
    && trigCC === trig36
    && trigSilent === "Last triggered: Ch 10 · C2 · — · Vel 100",
    "drum pads: MIDI in: a drum-channel note shows channel, note name, sound and velocity; other channels, note-offs and CCs leave the line alone; a silent pad shows no sound");
  /* (2.8.3) RESET + PREVIEW, driven through the card itself: a tiny fake DOM runs the card's render code
     (the real $/el from the file), with a device that still holds the default map. A drag swap is heard as
     the sound now on the pad, and Reset puts the grid back to the default layout. (2.8.6) every change is
     written to the device at once, so the mock's map is checked after a drag and after Reset. */
  class FakeEl {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this._text = "";
      this._classes = new Set(); this._listeners = {};
      this.style = { setProperty: () => {} };
      this.dataset = new Proxy({}, { get: (_, k) => this.attrs["data-" + k] ?? undefined,
        set: (_, k, v) => { this.attrs["data-" + k] = String(v); return true; } });
      this.classList = { add: (...c) => c.forEach((x) => this._classes.add(x)),
        remove: (...c) => c.forEach((x) => this._classes.delete(x)),
        toggle: (c, f) => { if (f === undefined) f = !this._classes.has(c); f ? this._classes.add(c) : this._classes.delete(c); },
        contains: (c) => this._classes.has(c) };
      this.disabled = false; this.draggable = false;
    }
    get textContent() { return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
    set textContent(v) { this.children = []; this._text = String(v ?? ""); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, fn) { (this._listeners[t] ??= []).push(fn); }
    append(...kids) { for (const k of kids) if (k != null) this.children.push(k); return this; }
    prepend(...kids) { this.children.unshift(...kids.filter((k) => k != null)); return this; }
    replaceChildren(...kids) { this.children = []; this._text = ""; return this.append(...kids); }
    click() { (this._listeners.click || []).forEach((f) => f({ preventDefault: () => {} })); }
    _match(sel) {
      if (sel.startsWith("[data-note=")) return this.attrs["data-note"] === sel.match(/"([^"]*)"/)[1];
      if (sel.startsWith(".")) return this._classes.has(sel.slice(1));
      return this.tagName === sel.toUpperCase();
    }
    querySelector(sel) { for (const c of this.children) { if (typeof c !== "string") { if (c._match(sel)) return c; const d = c.querySelector(sel); if (d) return d; } } return null; }
    querySelectorAll(sel, out = []) { for (const c of this.children) { if (typeof c !== "string") { if (c._match(sel)) out.push(c); c.querySelectorAll(sel, out); } } return out; }
  }
  const dpBox = new FakeEl("div");
  dpBox.setAttribute("id", "drumpads");
  const notesOn = [];
  const renderKitsCalls = [];   /* (2.8.7) Reset re-renders the kit builder: the card test records the calls */
  const lvStub = { kmode: "play", held: new Map() };   /* LV.held: what the editor's lvNoteOn records */
  const cardMock = attachMock({});   /* a real device for the card's Learn arm / poll / re-read */
  const cardCtx = { console, document: { createElement: (t) => new FakeEl(t), getElementById: (id) => (id === "drumpads" ? dpBox : null) },
    dev: { dump: { g: new Array(50).fill(0) } }, LV: lvStub,
    lvNoteOn: (tok, track, note, vel) => { notesOn.push(note); lvStub.held.set(tok, { ch: 9, note, track }); },
    lvNoteOff: (tok) => { lvStub.held.delete(tok); }, setTimeout, clearTimeout, setInterval, clearInterval,
    lvG: (l, d) => d, lvGv: (id) => (cardCtx.dev.dump ? cardCtx.dev.dump.g[id] : 0),
    req: E.req, parse: E.parse, CMD: E.CMD, crc32: E.crc32,
    rq: (r, o) => cardMock.rq(r, o), report: () => {}, tab: "drumpads", bkMutex: E.bkMutex,
    renderKits: () => { renderKitsCalls.push(1); },   /* (2.8.7) the builder re-render, stubbed: the card test only records that Reset calls it */
    op: async (fn) => { try { await fn(); } catch (e) { /* the real op reports it; the test checks the result */ } } };
  cardCtx.dev.dump.g[24] = 10;   /* the drum channel */
  const R = vm.runInNewContext(
    ed.slice(ed.indexOf("const $ = "), ed.indexOf("const sleep ="))
    + ed.slice(ed.indexOf("const DRUM_LANES ="), ed.indexOf("const LV_NAMES"))
    + ed.slice(ed.indexOf("const DRUMPADS = {"), ed.indexOf("/* ---- MIDI LEARN"))
    + `\n;({ DRUMPADS, drumPads, drumPadsEff, drumPadsRender, drumPadsDrop, drumPadsHear, drumPadsFlash, drumPadsMidiIn, kitLaneGridPos })`,
    cardCtx);
  const padSound = (note) => R.drumPads.ui.grid.querySelector(`[data-note="${note}"]`).querySelector(".sound").textContent;
  const cardMap = () => cardMock.m.state.drumMap;   /* the mock device's map, as the card's writes leave it */
  R.drumPadsRender();
  /* (2.8.4) the card has the preset dropdown and the last triggered line: without a device the dropdown
     is disabled and shows the firmware's kit names, and the line is empty */
  const kitOpts = [...R.drumPads.ui.kit.children].map((c) => c.textContent);
  ok(R.drumPads.ui.kit && kitOpts.length === 46 && kitOpts[0] === "ACOUSTIC" && kitOpts[5] === "808" && kitOpts[45] === "SYN4"
    && R.drumPads.ui.kit.disabled === true
    && R.drumPads.ui.kitNow.textContent === "Connect the FM-1 to read the preset."
    && R.drumPads.ui.trig.textContent === "Last triggered: —",
    "drum pads: card: the preset dropdown (46 kits, disabled without a device) and the last triggered line");
  R.drumPadsDrop({ from: "pad", idx: 12 }, 0);   /* drag pad 36 (KICK) onto pad 48 (HI TOM): a swap */
  await sleep(200);   /* the drag writes the map to the device at once */
  ok(padSound(36) === "HI TOM" && padSound(48) === "KICK"
    && cardMap()[0] === 10 && cardMap()[12] === 0 && cardMap().slice(1, 12).every((b) => b === 0xFF),
    "drum map: card: a drag swap shows on the grid and is written to the device at once (HI TOM on 36, KICK on 48)");
  notesOn.length = 0;
  R.drumPads.ui.grid.querySelector('[data-note="36"]').click();   /* tap the pad now holding HI TOM */
  const heard36 = notesOn.length ? notesOn[0] : -1;
  ok(R.drumPads.ui.trig.textContent === "Last triggered: Ch 10 · C1 · HI TOM · Vel 100",
    "drum pads: card: tapping a pad shows the triggered channel, note name, sound and velocity");
  notesOn.length = 0;
  R.drumPads.ui.grid.querySelector('[data-note="48"]').click();   /* tap the pad now holding KICK */
  ok(heard36 === 36 && notesOn.length === 1 && notesOn[0] === 48,
    "drum map: card: tapping a swapped pad previews the sound now on it, on its own note (the device map matches after the write)");
  ok(R.drumPads.ui.trig.textContent === "Last triggered: Ch 10 · C2 · KICK · Vel 100",
    "drum pads: card: the last triggered line follows the pad just tapped");
  R.drumPads.map = new Uint8Array(16).fill(0xFF); R.drumPads.map[0] = 10;   /* HI TOM on 36 only: pad 48 is silent */
  R.drumPadsRender();
  notesOn.length = 0;
  R.drumPads.ui.grid.querySelector('[data-note="48"]').click();
  ok(notesOn.length === 0 && padSound(48) === "—"
    && R.drumPads.ui.trig.textContent === "Last triggered: Ch 10 · C2 · KICK · Vel 100",
    "drum map: card: tapping a silent pad previews nothing (and the last triggered line stays put)");
  renderKitsCalls.length = 0;
  R.drumPads.ui.reset.click();   /* Reset */
  await sleep(200);   /* Reset writes the default map to the device at once */
  ok(eq(R.drumPads.map, new Uint8Array(16).fill(0xFF))
    && padSound(36) === "KICK" && padSound(48) === "HI TOM"
    && padSound(41) === "KICK 2" && padSound(45) === "SHAKER" && padSound(47) === "CONGA" && padSound(50) === "COWBELL"
    && cardMap().slice(0, 16).every((b) => b === 0xFF),
    "drum map: card: Reset puts the grid back to the default layout and writes it to the device at once");
  /* (2.8.7) Reset is just "Reset" now, and it re-renders the kit builder to the default positions too:
     the builder follows the map, so after Reset its layout is the filled default grid */
  ok(R.drumPads.ui.reset.textContent === "Reset" && !/Reset to default layout/.test(ed)
    && renderKitsCalls.length === 1
    && R.kitLaneGridPos(1) === 9 && R.kitLaneGridPos(13) === 5 && R.kitLaneGridPos(14) === 7 && R.kitLaneGridPos(15) === 2
    && R.kitLaneGridPos(0) === 12 && R.kitLaneGridPos(10) === 0,
    "drum pads: card: Reset is just \"Reset\" and re-renders the kit builder to the filled default grid");
  /* (2.8.6) the learn is gone from the card: no Learn buttons on any pad, no Write button, no tray
     and no Current mapping table — on any protocol version — and the preset line is the help message */
  cardCtx.dev.info = { proto: 15, version: "LOWTIDE 2.8.7 BETA", pcount: 71 };
  R.drumPadsRender();
  ok(R.drumPads.ui.grid.querySelectorAll(".dplearn").length === 0
    && !R.drumPads.ui.write && !R.drumPads.ui.tray && !R.drumPads.ui.table
    && R.drumPads.ui.kitNow.textContent === "Select a drum preset to change sounds"
    && R.drumPads.ui.kit.disabled === false,
    "drum pads: card: no Learn buttons, no Write button, no tray, no Current mapping table; the preset line is the help message");
  /* (2.8.5) the flash: a MIDI note shows in the last triggered line and flashes its pad for 140 ms;
     a trigger outside the block flashes the pad holding its lane; a sound on no pad flashes nothing */
  R.drumPads.map = new Uint8Array(16).fill(0xFF); R.drumPadsRender();
  cardCtx.dev.info = { proto: 15, version: "LOWTIDE 2.8.7 BETA", pcount: 71 };
  R.drumPadsMidiIn([0x99, 36, 100]);
  const pad36 = R.drumPads.ui.grid.querySelector('[data-note="36"]');
  ok(R.drumPads.ui.trig.textContent === "Last triggered: Ch 10 · C1 · KICK · Vel 100"
    && pad36.classList.contains("playing"),
    "drum pads: card: a MIDI note shows in the last triggered line and flashes its pad");
  await sleep(200);
  ok(!pad36.classList.contains("playing"),
    "drum pads: card: the flash is brief (the pad's highlight is gone after 140 ms)");
  R.drumPadsFlash(56, 0);   /* a note outside the block, on the lane KICK plays: the pad holding KICK flashes */
  ok(pad36.classList.contains("playing"),
    "drum pads: card: a trigger outside the block flashes the pad holding its lane");
  await sleep(200);
  R.drumPads.map = new Uint8Array(16).fill(0xFF); R.drumPads.map[14] = 0;   /* KICK on D2: COWBELL is on no pad (2.8.7: every lane has a pad by default, so a no-pad lane needs a moved sound) */
  R.drumPadsRender();
  R.drumPadsFlash(56, 15);   /* COWBELL's home note 56, outside the block, on no pad: nothing flashes */
  ok(![...R.drumPads.ui.grid.querySelectorAll(".dppad")].some((p) => p.classList.contains("playing")),
    "drum pads: card: a sound on no pad flashes nothing");
  cardMock.done();
  /* (2.8.5) the Import and Export JSON buttons are in the button bar */
  ok(R.drumPads.ui.export && R.drumPads.ui.export.textContent === "Export JSON"
    && R.drumPads.ui.import && R.drumPads.ui.import.textContent === "Import JSON" && R.drumPads.ui.file,
    "drum pads: card: the Import and Export JSON buttons are in the button bar");
  /* (2.8.5) DRUM_TRIG: the firmware pushes the last live drum hit while the editor WATCHes — note,
     channel, velocity, lane. A silent pad pushes nothing; a v13 device never sends it. */
  const w = attachMock({ watchMs: 1000 });
  ok(await E.startWatch(w.rq), "drum trig: WATCH on");
  const trigPushes = () => w.ev.pushes.filter((f) => f.cmd === C.DRUM_TRIG);
  w.m.sim.drumTrig(36, 10, 100);
  await sleep(30);
  const tp = trigPushes();
  ok(tp.length === 1 && E.parse[C.DRUM_TRIG](tp[0].a).note === 36 && E.parse[C.DRUM_TRIG](tp[0].a).ch === 10
    && E.parse[C.DRUM_TRIG](tp[0].a).vel === 100 && E.parse[C.DRUM_TRIG](tp[0].a).lane === 0,
    "drum trig: a live drum hit on the drum channel pushes DRUM_TRIG (note 36, ch 10, vel 100, lane KICK)");
  ok(E.PUSH.has(C.DRUM_TRIG) && E.PUSH.has(C.CHANGED),
    "drum trig: DRUM_TRIG is a push the editor watches for");
  const wPut12 = async (bytes) => {
    let r = E.parse[C.BK_PUT](await w.rq(E.req.bkBegin(12, bytes.length, E.crc32(bytes))));
    if (r.rc) return r.rc;
    r = E.parse[C.BK_PUT](await w.rq(E.req.bkData(12, 0, bytes)));
    if (r.rc) return r.rc;
    return E.parse[C.BK_PUT](await w.rq(E.req.bkCommit(12))).rc;
  };
  const silentMap = new Uint8Array(17).fill(0xFF); silentMap[0] = 10; silentMap[16] = 4;   /* HI TOM on 36: 48 silent */
  ok((await wPut12(silentMap)) === 0 && w.m.sim.drumTrig(48, 10, 100) === false,
    "drum trig: a silent pad pushes nothing (the firmware records nothing for it)");
  await sleep(30);
  ok(trigPushes().length === 1, "drum trig: no DRUM_TRIG arrived for the silent pad");
  const w13 = attachMock({ v13: true, watchMs: 1000 });
  ok(await E.startWatch(w13.rq) && w13.m.sim.drumTrig(36, 10, 100) === false,
    "drum trig: a v13 device never sends DRUM_TRIG");
  await sleep(30);
  ok(!w13.ev.pushes.some((f) => f.cmd === C.DRUM_TRIG), "drum trig: no DRUM_TRIG arrived from the v13 device");
  w.done(); w13.done();
  /* (2.8.5) the learned speed now covers the Select, Presets and Algorithm knobs too (not just the
     K1–K4 followers): the editor says so, and the firmware scales their CC deltas by the speed,
     carrying the fraction in an accumulator (0.5x takes two CC steps per step, 2x moves two). */
  const uc = readFileSync(join(HERE, "../firmware/src/ui.c"), "utf8");
  ok(/How fast a learned CC turns a knob: K1–K4 knob followers, and the Select \(tempo\), Presets and Algorithm knobs\. Volume is not affected/.test(ed)
    && /preset_acc \+= \(\(int32_t\)v - preset_cc_last\) \* \(int32_t\)learn_speed_q/.test(uc)
    && /track_acc \+= \(\(int32_t\)v - track_cc_last\) \* \(int32_t\)learn_speed_q/.test(uc)
    && /select_acc \+= \(\(int32_t\)v - select_cc_last\) \* \(int32_t\)learn_speed_q/.test(uc),
    "learn speed: the Select, Presets and Algorithm knobs scale with the learned speed (quarter-step accumulators); Volume stays absolute");
  done();
}

/* ------------------------------------- editor v5 (SLOOP 2.0): lanes, levels, ratchets --- */
async function editorV5() {
  const C = E.CMD;
  const { m, rq, ev, done } = attachMock({ watchMs: 1000 });
  const info = E.parse[C.INFO](await rq(E.req.info()));
  ok(info.proto === 19 && /LOWTIDE/.test(info.version) && info.pcount === 71 && info.gcount === 50 && info.pe0 === 63, "v5..v19: INFO ends with the protocol version (19: pred-as-gain in version-2 user slots); 50 globals (2.5: drum DLY; 2.6: GLO > MIDI, TEXTURE, BEND; 2.7: FX CH, DR MAP, REMOTE, CLK OUT; 2.7.2: FX FADE)");
  /* (2.8.3) the device's INFO version is LOWTIDE, never FELUCCA: editor.c builds "LOWTIDE " + the version,
     and uses the default as-is when it already starts with LOWTIDE (ui.c: "LOWTIDE 2.8.5") */
  const ecVer = readFileSync(join(HERE, "../firmware/src/editor.c"), "utf8");
  ok(!ecVer.includes('"FELUCCA " FELUCCA_VERSION') && /case ED_INFO[\s\S]{0,1200}LOWTIDE /.test(ecVer)
    && /already starts with "LOWTIDE "/.test(ecVer),
    "editor: INFO version is LOWTIDE (editor.c prepends it, never doubled)");
  /* the firmware says the same: ED_DRUM_STEP is command 33, INFO sends 5, P_CHORD / the master globals as the mock has them */
  const ec = readFileSync(join(HERE, "../firmware/src/editor.c"), "utf8"), pc = readFileSync(join(HERE, "../firmware/src/params.c"), "utf8");
  const en = (/enum \{ ED_INFO = 1,([^}]*)\}/.exec(ec) || [])[1] || "";
  const names = ["ED_INFO", ...en.replace(/\/\*[^*]*\*\//g, "").split(",").map((x) => x.trim()).filter(Boolean)];
  ok(names.indexOf("ED_DRUM_STEP") + 1 === C.DRUM_STEP && names.indexOf("ED_TRACK_CHANGED") + 1 === C.TRACK_CHANGED
    && names.indexOf("ED_BK_LIST") + 1 === C.BK_LIST && names.indexOf("ED_BK_PUT") + 1 === C.BK_PUT
    && names.indexOf("ED_LOCK_GET") + 1 === C.LOCK_GET && names.indexOf("ED_LOCK_SET") + 1 === C.LOCK_SET
    && names.indexOf("ED_MICRO_GET") + 1 === C.MICRO_GET && names.indexOf("ED_MICRO_SET") + 1 === C.MICRO_SET
    && names.indexOf("ED_FILL_GET") + 1 === C.FILL_GET && names.indexOf("ED_FILL_SET") + 1 === C.FILL_SET
    && /ED_FM6_GET = 68, ED_FM6_PUT, ED_FM6_LIST, ED_FM6_ERASE/.test(ec) && C.FM6_GET === 68 && C.FM6_ERASE === 71
    && /#define ED_PROTO 19u/.test(ec) && /ed_b\(ED_PROTO\);/.test(ec)
    && !/ED_DP_LEARN/.test(ec) && C.DP_LEARN === undefined
    && /#define ED_DRUM_TRIG 79u/.test(ec) && C.DRUM_TRIG === 79
    && /enum \{ ED_DSYN_LIST = 72, ED_DSYN_GET, ED_DSYN_PUT, ED_DSYN_STORE, ED_DSYN_PLAY \};/.test(readFileSync(join(HERE, "../firmware/src/editor_dsyn.c"), "utf8"))
    && C.DSYN_LIST === 72 && C.DSYN_PLAY === 76, "v5..v19: command numbers and INFO == editor.c / editor_dsyn.c");
  const enumNames = (id) => (new RegExp(`${id}\\[\\] = \\{([^}]*)\\}`).exec(pc) || [])[1].split(",").map((x) => x.trim().replace(/"/g, ""));
  const chord = E.parse[C.DESC](await rq(E.req.desc(0, 49)));
  const gd = [];
  for (let i = 27; i < 32; i++) gd.push(E.parse[C.DESC](await rq(E.req.desc(1, i))));
  ok(chord.label === "CHORD" && chord.names.join() === enumNames("N_CHORD").join() && /\[P_CHORD\] = PE\("CHORD", N_CHORD, 0\)/.test(pc)
    && gd.map((d) => d.label).join() === "DUST,DUCK,FILT,ROLL,NEW" && gd[3].names.join() === enumNames("N_ROLL").join() && gd[3].def === 1
    && /\[G_DUST\] = PD\("DUST", F_PCT, 0, 127, 0\)/.test(pc) && /\[G_FILT\] = PD\("FILT", F_FILT, -64, 63, 0\)/.test(pc)
    && /\[G_ROLL\] = PE\("ROLL", N_ROLL, 1\)/.test(pc) && /\[G_NEWPRJ\] = PE\("NEW", N_GO, 0\)/.test(pc),
    "v5: CHORD, DUST, DUCK, FILT, ROLL, NEW (mock == params.c)");
  /* the value formats (params.c fmt_value) */
  const fv = (fmt, v, max = 127, min = 0) => E.fmtValue({ fmt, min, max, names: [] }, v).join("");
  ok(fv(E.F.SWING, 0, 100) === "0" && fv(E.F.SWING, 50, 100) === "50" && fv(E.F.SWING, 100, 100) === "100"
    && fv(E.F.FILT, 0, 63, -64) === "OFF" && fv(E.F.FILT, -64, 63, -64) === "LP100%" && fv(E.F.FILT, -32, 63, -64) === "LP50%" && fv(E.F.FILT, 63, 63, -64) === "HP100%"
    && fv(E.F.PCT, 127) === "100%" && fv(E.F.PCT, 64) === "50%" && fv(E.F.PCT, 60, 120) === "50%", "v5: SWING 0..100 (2.5), FILT LP / OFF / HP, PCT of the range");
  /* a synth step keeps its levels and ratchets; an old-style write clears them (as the firmware) */
  const w = E.parse[C.STEP_SET](await rq(E.req.stepSet(3, { n: 2, notes: [60, 67, 0, 0], time: 0, flags: 0, vel: 100, lvl: 0b11000110, rat: 0b10000011 })));
  const g = E.parse[C.STEP_GET](await rq(E.req.stepGet(3)));
  const w2 = E.parse[C.STEP_SET](await rq(E.req.stepSet(3, { n: 1, notes: [62, 0, 0, 0], time: 0, flags: 0, vel: 90 })));
  ok(w.lvl === 0b11000110 && g.lvl === 0b11000110 && g.rat === 0b10000011 && w2.lvl === 0 && w2.rat === 0 && E.req.stepSet(1, { n: 0, notes: [], time: 2, flags: 0, vel: 0 })[1].length === 9,
    "v5: STEP_SET / STEP_GET level and ratchet bytes (8 bits each), none for an old step");
  /* the drum track: 16 lanes with their level and ratchet; lane 15 uses the top bits */
  const d = E.emptyDrum();
  d.on = (1 << 0) | (1 << 4) | (1 << 15); d.lvl[0] = 3; d.lvl[4] = 1; d.rat[4] = 3; d.lvl[15] = 2; d.rat[15] = 1;
  const ds = E.parse[C.DRUM_STEP](await rq(E.req.drumStep(5, d)));
  const dg = E.parse[C.DRUM_STEP](await rq(E.req.drumStep(5)));
  ok(ds.index === 5 && dg.on === d.on && dg.lvl.join() === d.lvl.join() && dg.rat.join() === d.rat.join()
    && E.req.drumStep(5, d)[1].every((b) => b >= 0 && b < 128) && E.req.drumStep(5, d)[1].length === 14, "v5: DRUM_STEP round trip (16 lanes, levels, ratchets)");
  /* old commands see the lanes as GM notes (the first four, ACC when one is hard); an old write lands on lanes */
  const old = E.parse[C.TRACK_STEP](await rq(E.req.trackStep(3, 5)));
  await rq(E.req.trackStep(3, 6, { n: 2, notes: [38, 46, 0, 0], time: 0, flags: 1, vel: 100 }));
  const d6 = E.parse[C.DRUM_STEP](await rq(E.req.drumStep(6)));
  ok(old.n === 3 && old.notes.slice(0, 3).join() === "36,42,56" && old.flags === 1 && d6.on === ((1 << 2) | (1 << 5)) && d6.lvl[2] === 3 && d6.lvl[5] === 3,
    "v5: the drum track through TRACK_STEP: lanes <-> GM notes");
  ok(E.DRUM_LANES.length === 16 && E.DRUM_LANES[0][0] === 36 && E.DRUM_LANES[15][0] === 56 && E.LV_NAMES.join() === "NORM,GHOST,SOFT,HARD",
    "v5: the 16 lanes (kick .. cowbell), 4 levels");
  const dc = readFileSync(join(HERE, "../firmware/src/drums.c"), "utf8");
  const lanes = ((/LANE_NOTE\[DRUM_LANES\] = \{([^}]*)\}/.exec(dc) || [])[1] || "").split(",").map((x) => +x);
  ok(lanes.join() === E.DRUM_LANES.map((x) => x[0]).join(), "v5: lane notes == drums.c LANE_NOTE");
  /* the kit: the drum track's P_E0 */
  await rq(E.req.track(3));
  const kit = E.parse[C.DESC](await rq(E.req.desc(0, info.pe0)));
  const dk = (/DRUM_KIT_NAMES\[\] = \{([^}]*)\}/.exec(dc) || [])[1] || "";
  const gen = join(HERE, "../build/gen/felucca_drumkits.h");
  const dsList = existsSync(gen) ? ((/#define DS_KIT_NAME_LIST (.*)/.exec(readFileSync(gen, "utf8")) || [])[1] || "") : null;
  const fwKits = dsList == null ? null : dk.replace("DS_KIT_NAME_LIST", dsList).split(",").map((x) => x.trim().replace(/"/g, ""));
  ok(kit.label === "KIT" && kit.names[5] === "808" && kit.names.length === kit.max + 1 && (!fwKits || fwKits.join() === kit.names.join()),
    `v5: the drum track's KIT (${kit.names.length} kits${fwKits ? ", == drums.c" : ""})`);
  /* TRACK ends with the solo mask */
  m.state.solo = 0b0101;
  const tr = E.parse[C.TRACK](await rq(E.req.track()));
  ok(tr.solo === 5 && tr.sel === 3 && tr.tracks.length === 4, "v5: TRACK reports the soloed tracks");
  ok(!ev.unknown.length, "v5: no unmatched replies");
  done();
  /* firmware 0.8 (v3): no DRUM_STEP, no protocol byte, steps without the extra bytes */
  const o = attachMock({ v3: true });
  const oi = E.parse[C.INFO](await o.rq(E.req.info()));
  const os = E.parse[C.STEP_GET](await o.rq(E.req.stepGet(0)));
  const nd = await o.rq(E.req.drumStep(0), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  ok(oi.proto === 0 && os.lvl === undefined && nd === "none", "v5: older firmware -> proto 0, no DRUM_STEP (the editor keeps GM notes)");
  o.done();
}

/* ----------------------------- editor protocol v7: nudges and parameter locks (SLOOP 2.4) --- */
async function editorV7() {
  const C = E.CMD;
  const { m, rq, ev, done } = attachMock({ watchMs: 1000 });
  const info = E.parse[C.INFO](await rq(E.req.info()));
  ok(info.proto === 19, "v7: INFO ends with 19 (v19 includes v7)");
  /* the lockable set == seq.c p_lockable (the ids as core.h names them) */
  const sc = readFileSync(join(HERE, "../firmware/src/seq.c"), "utf8"), ch = readFileSync(join(HERE, "../firmware/src/core.h"), "utf8");
  const ids = {}; let n = 0;
  for (const nm of (/enum \{\s*\/\* per-track parameters \*\/([^}]*)\}/.exec(ch) || [])[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim()).filter(Boolean)) ids[nm] = n++;
  const lockableC = (id) => id <= ids.P_LD_AMP || id === ids.P_SGATE || (id >= ids.P_DIST && id <= ids.P_REV) || id === ids.P_GLIDE || id === ids.P_PAN
    || id === ids.P_DETUNE || (id >= ids.P_SLCR && id <= ids.P_SLDEPTH) || (id >= ids.P_E0 && id <= ids.P_E7) || id === ids.P_TFLT
    || (id >= ids.P_IA && id <= ids.P_IMIX);   /* 2.6: the INSERT's values */
  let same = ids.P_COUNT === 71 && ids.P_E0 === 63;
  for (let id = 0; id < 71; id++) same = same && !!E.lockable(id, 63) === !!lockableC(id);
  for (let id = 0; id < 61; id++) same = same && !!E.lockable(id, 53) === (id >= 53 || !!lockableC(id));   /* (older firmware: E 53..60) */
  ok(same && /id <= P_LD_AMP \|\| id == P_SGATE \|\| \(id >= P_DIST && id <= P_REV\) \|\| id == P_GLIDE \|\| id == P_PAN/.test(sc)
    && !E.lockable(ids.P_SLEN) && !E.lockable(ids.P_AMODE) && !E.lockable(ids.P_VOICE) && !E.lockable(ids.P_CHORD) && E.lockable(ids.P_E7),
    "v7: the lockable parameters (editor == seq.c p_lockable; LEN, ARP, VOICE, CHORD are not)");
  /* MICRO: 64 bytes offset by 64; a set clamps to -32..31 */
  const mg = E.parse[C.MICRO_GET](await rq(E.req.microGet(0)));
  ok(mg.track === 0 && mg.micro.length === 64 && mg.micro.every((x) => x === 0), "v7: MICRO_GET: 64 nudges, all 0");
  const ms = E.parse[C.MICRO_SET](await rq(E.req.microSet(0, 4, -8)));
  const ms2 = E.parse[C.MICRO_SET](await rq(E.req.microSet(0, 5, 100)));
  const ms3 = E.parse[C.MICRO_SET](await rq(E.req.microSet(0, 6, -100)));
  const mg2 = E.parse[C.MICRO_GET](await rq(E.req.microGet(0)));
  ok(ms.step === 4 && ms.micro === -8 && ms2.micro === 31 && ms3.micro === -32 && mg2.micro[4] === -8 && mg2.micro[5] === 31 && mg2.micro[6] === -32
    && E.req.microSet(0, 4, -8)[1].join() === "0,4,56" && E.req.microSet(0, 4, 31)[1][2] === 95 && E.req.microSet(0, 4, -32)[1][2] === 32,
    "v7: MICRO_SET (sent + 64: -8 -> 56, 31 -> 95, -32 -> 32), clamped to -32..31");
  /* LOCK: set, move, list, delete; refused on a non-lockable parameter, bounded */
  const l1 = E.parse[C.LOCK_SET](await rq(E.req.lockSet(0, 2, ids.P_E0, 1)));
  const l2 = E.parse[C.LOCK_SET](await rq(E.req.lockSet(0, 2, ids.P_DIST, 500)));
  const l3 = E.parse[C.LOCK_SET](await rq(E.req.lockSet(0, 2, ids.P_SLEN, 8)));
  const l4 = E.parse[C.LOCK_SET](await rq(E.req.lockSet(0, 70, ids.P_E0, 1)));
  const lg = E.parse[C.LOCK_GET](await rq(E.req.lockGet(0)));
  ok(l1.rc === 0 && l1.has === 1 && l1.value === 1 && l2.rc === 0 && l2.value === 127 && l3.rc === 2 && !l3.has && l3.value === null && l4.rc === 1
    && lg.track === 0 && lg.locks.length === 2 && lg.locks[0].step === 2 && lg.locks[0].param === ids.P_E0 && lg.locks[1].value === 127
    && E.req.lockSet(0, 2, 5, -30)[1].length === 5 && E.req.lockSet(0, 2, 5)[1].length === 3,
    "v7: LOCK_SET makes and clamps a lock (DIST 500 -> 127), refuses LEN (rc 2) and step 70 (rc 1); LOCK_GET lists them");
  const l5 = E.parse[C.LOCK_SET](await rq(E.req.lockSet(0, 2, ids.P_E0, 3)));
  const l6 = E.parse[C.LOCK_SET](await rq(E.req.lockSet(0, 2, ids.P_E0)));
  const lg2 = E.parse[C.LOCK_GET](await rq(E.req.lockGet(0)));
  ok(l5.value === 3 && l6.rc === 0 && l6.has === 0 && lg2.locks.length === 1 && lg2.locks[0].param === ids.P_DIST,
    "v7: LOCK_SET again moves the lock; without a value it deletes it");
  for (let i = 0; i < 23; i++) await rq(E.req.lockSet(0, i, ids.P_LEVEL, 100));   /* 24 in all */
  const full = E.parse[C.LOCK_SET](await rq(E.req.lockSet(0, 40, ids.P_LEVEL, 100)));
  ok(full.rc === 3 && E.parse[C.LOCK_GET](await rq(E.req.lockGet(0))).locks.length === 24, "v7: the 25th lock is refused (rc 3, 24 a track)");
  /* another track is untouched; a device-side nudge pushes STEP_CHANGED */
  const lg3 = E.parse[C.LOCK_GET](await rq(E.req.lockGet(1)));
  await rq(E.req.watch(1));
  m.sim.nudge(7, 12);
  await sleep(30);
  const sc7 = ev.pushes.find((f) => f.cmd === C.STEP_CHANGED && f.a[0] === 7);
  ok(lg3.locks.length === 0 && !!sc7 && E.parse[C.MICRO_GET](await rq(E.req.microGet(0))).micro[7] === 12,
    "v7: other tracks untouched; a nudge on the device -> STEP_CHANGED of its step");
  ok(!ev.unknown.length, "v7: no unmatched replies");
  done();
  /* a v6 device (SLOOP 2.3): INFO 6, no reply to the v7 commands */
  const o = attachMock({ noBackup: true });
  const oi = E.parse[C.INFO](await o.rq(E.req.info()));
  const nl = await o.rq(E.req.lockGet(0), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  ok(oi.proto === 5 && nl === "none", "v7: a device without the commands: no reply (the editor hides the step detail)");
  o.done();
}

/* ----------------------------- editor protocol v8: fill conditions (SLOOP 2.4) --- */
async function editorV8() {
  const C = E.CMD;
  const { m, rq, ev, done } = attachMock({ watchMs: 1000 });
  const info = E.parse[C.INFO](await rq(E.req.info()));
  ok(info.proto === 19, "v8: INFO ends with 19 (v19 includes v8)");
  /* the condition codes == core.h FC_*; the bit layout of a 2-bit step field */
  const ch = readFileSync(join(HERE, "../firmware/src/core.h"), "utf8"), sc = readFileSync(join(HERE, "../firmware/src/seq.c"), "utf8");
  ok(/enum \{ FC_NORM, FC_FILL, FC_NOFILL \}/.test(ch) && /uint8_t fill\[NSTEP \/ 4\];/.test(ch)
    && /t->fill\[idx \/ 4u\] >> \(2u \* \(idx % 4u\)\)\) & 3u/.test(sc) && E.FC.FILL === 1 && E.FC.NOFILL === 2,
    "v8: FC codes and the 2-bit layout == core.h / seq.c step_fill");
  const g0 = E.parse[C.FILL_GET](await rq(E.req.fillGet(0)));
  ok(g0.track === 0 && g0.fill.length === 16 && g0.fill.every((x) => x === 0), "v8: FILL_GET: 16 bytes, every step normal");
  const s1 = E.parse[C.FILL_SET](await rq(E.req.fillSet(0, 4, E.FC.FILL)));
  const s2 = E.parse[C.FILL_SET](await rq(E.req.fillSet(0, 3, E.FC.NOFILL)));   /* (bits 6..7 of byte 0: the top bit crosses pack7) */
  const s3 = E.parse[C.FILL_SET](await rq(E.req.fillSet(0, 63, 3)));            /* 3: normal */
  const g1 = E.parse[C.FILL_GET](await rq(E.req.fillGet(0)));
  ok(s1.step === 4 && s1.cond === 1 && s2.cond === 2 && s3.cond === 0 && g1.fill[1] === 1 && g1.fill[0] === 0x80 && g1.fill[15] === 0
    && E.fillGet(g1.fill, 4) === 1 && E.fillGet(g1.fill, 3) === 2 && E.fillGet(g1.fill, 5) === 0
    && E.req.fillSet(0, 4, 1)[1].join() === "0,4,1" && E.req.fillGet(2)[1].join() === "2",
    "v8: FILL_SET sets a step (3 -> normal); FILL_GET returns the bytes as stored (0x80 through pack7)");
  {
    const b = new Uint8Array(16); E.fillSet(b, 7, 2); E.fillSet(b, 0, 1); E.fillSet(b, 7, 0);
    const rt = E.unpack7(E.pack7(Uint8Array.from([0x80, 0xFF, 0x01, 0x7F, 0x00, 0xC3, 0x55, 0xAA, 0x01, 0x80, 0, 0, 0, 0, 0, 0x40])));
    ok(E.fillGet(b, 0) === 1 && E.fillGet(b, 7) === 0 && b[1] === 0 && rt.length === 16 && rt[0] === 0x80 && rt[1] === 0xFF && rt[7] === 0xAA && rt[15] === 0x40,
      "v8: fillSet / fillGet on the client; pack7 keeps the top bits of 16 bytes (3 groups)");
  }
  /* another track untouched; a device-side change (SEQ + step + OCT+) pushes STEP_CHANGED */
  const g2 = E.parse[C.FILL_GET](await rq(E.req.fillGet(1)));
  await rq(E.req.watch(1));
  m.sim.fill(9, 2);
  await sleep(30);
  const sc9 = ev.pushes.find((f) => f.cmd === C.STEP_CHANGED && f.a[0] === 9);
  ok(g2.fill.every((x) => x === 0) && !!sc9 && E.fillGet(E.parse[C.FILL_GET](await rq(E.req.fillGet(0))).fill, 9) === 2,
    "v8: other tracks untouched; a condition set on the device -> STEP_CHANGED of its step");
  ok(!ev.unknown.length, "v8: no unmatched replies");
  done();
  /* a v7 device: INFO 7, no reply to the v8 commands */
  const o = attachMock({ v7: true });
  const oi = E.parse[C.INFO](await o.rq(E.req.info()));
  const nf = await o.rq(E.req.fillGet(0), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  const ml = await o.rq(E.req.microGet(0), { timeout: 200, retries: 0, quiet: true }).then(() => "reply", () => "none");
  ok(oi.proto === 7 && nf === "none" && ml === "reply", "v8: a v7 device: INFO 7, locks yes, no reply to FILL_GET (the editor hides the condition)");
  o.done();
}

/* ------------------------------------------------- 2.4: the drum kit page --- */
await (async () => {
  const lanes = { "BD Kick 808.wav": 0, "Snare_01.wav": 2, "HH closed.wav": 4, "OH open.wav": 5, "Crash cymbal.wav": 11, "Clap.wav": 3,
    "Low Tom.wav": 9, "Hi Tom.wav": 10, "rimshot.aif": 7, "Cowbell 1.wav": 15, "shaker.wav": 13, "Conga hi.wav": 14, "ride.wav": 12,
    "pedal hat.wav": 6, "piano C4.wav": -1, "kick2.wav": 1, "Snare 2.wav": 8 };
  const got = Object.entries(lanes).filter(([n, l]) => E.kitLaneOf(n) !== l).map(([n]) => `${n}->${E.kitLaneOf(n)}`);
  ok(!got.length, "drum kit: file names sorted onto the lanes" + (got.length ? ` (${got.join(", ")})` : ""));
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));
  const pads = Array(16).fill(null);
  pads[0] = { s: s(8000), fname: "kick.wav", tune: 0, gain: 0, len: 0 };
  ok(E.kitPlace(pads, "BD second kick.wav") === 1 && E.kitPlace(pads, "piano.wav") === 1 && E.kitPlace(pads, "x.wav", 9) === 9,
    "drum kit: a taken lane gives way (KICK -> KICK 2), unknown names the first free pad, a drop its pad");
  pads[2] = { s: s(6000), fname: "snare.wav", tune: 12, gain: -6, len: 0 };
  pads[5] = { s: s(20000), fname: "oh.wav", tune: 0, gain: 0, len: 4410 };
  const p2 = E.kitPad(pads[2]), p5 = E.kitPad(pads[5]);
  const pk = (x) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  ok(p2.length === 6000 && Math.abs(pk(p2) / 20000 - 0.501) < 0.03 && E.kitLen(pads[2]) === 6000 && Math.abs(E.kitPlayLen(pads[2]) - 3000) <= 1,
    "drum kit: +12 st plays it twice as fast (kitPlayLen half the stored length), -6 dB half the level (2.8.13: the tune is no longer baked into the audio)");
  ok(p5.length === 4410 && Math.abs(p5[4409]) < 400 && pk(p5.subarray(0, 4000)) > 15000, "drum kit: LENGTH cuts it, with a 4 ms fade (no click)");
  const zs = E.kitZones(pads), b = E.buildSlot("KIT", zs);
  const hz = (j) => { const o = 32 + j * 28; return [b.hdr[o + 25], b.hdr[o + 26], new DataView(b.hdr.buffer).getInt16(o + 20, true) / 16]; };
  ok(zs.length === 3 && b.hdr[6] === 3 && [0, 1, 2].every((j) => { const [lo, hi, root] = hz(j); return lo === hi && hi === root; })
    && [hz(0)[0], hz(1)[0], hz(2)[0]].join() === "36,38,46",
    "drum kit: one zone per pad, lo = hi = root = the lane's note (drums.c LANE_NOTE: KICK 36, SNARE 38, OPEN HAT 46)");
  const big = Array(16).fill(null).map((_, l) => ({ s: s(30000), fname: l + ".wav", tune: 0, gain: 0, len: 0 }));
  ok(E.kitBytes(big) > 81408 && E.kitFit(big, 81408 - 64) && E.kitBytes(big) <= 81408 - 64 && E.kitBytes(big) > 81408 - 64 - 64,
    "drum kit: FIT shortens the longest pads to fill the slot, no more");
  {   /* KIT USR3+4: a big kit shared out over two slots, each pad whole in one */
    const R = 81408 - 64, mk = (secs) => ({ s: s(Math.round(secs * 22050)), fname: "x.wav", tune: 0, gain: 0, len: 0 });
    const kit = Array(16).fill(null);
    [0.6, 0.3, 0.3, 0.15, 2.5, 1.0, 0.2, 0.2, 0.3, 0.6, 0.6, 3.0, 2.5, 0.3, 0.4, 0.3].forEach((x, l) => { kit[l] = mk(x); });
    const tot = E.kitBytes(kit), sp = E.kitSplit(kit, R);
    const load = (ls) => ls.reduce((a, l) => a + ((E.kitLen(kit[l]) + 1) >> 1), 0);
    ok(tot > R && tot <= 2 * R && sp && sp[0].length + sp[1].length === 16 && load(sp[0]) <= R && load(sp[1]) <= R
      && new Set([...sp[0], ...sp[1]]).size === 16,
      `drum kit: USR3+4 takes a ${(tot * 2 / 22050).toFixed(1)} s kit no slot could, every pad whole in one of the two`);
    const huge = Array(16).fill(null).map(() => mk(1.5));
    ok(!E.kitSplit(huge, R) && E.kitFit(huge, R, 2) && E.kitSplit(huge, R) && E.kitBytes(huge) > 2 * R * 0.9,
      "drum kit: ... FIT for the pair fills both slots (no more than they hold)");
    const one = Array(16).fill(null); one[0] = mk(9);
    ok(!E.kitSplit(one, R) && E.kitFit(one, R, 2) && E.kitSplit(one, R) && E.kitSplit(one, R)[1].length === 0,
      "drum kit: ... a sound longer than a slot is cut to one slot");
  }
  {   /* SLOOP 2.6: levels heard (loudDb: K-weighted, the loudest 100 ms) and MATCH LEVELS (matchGains) */
    const R = E.SMP.RATE, sine = (f, n, a) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(2 * Math.PI * f * i / R)));
    const d6 = E.loudDb(sine(1000, R, 16000)) - E.loudDb(sine(1000, R, 8000));
    ok(Math.abs(d6 - 6.02) < 0.05, `levels: half the amplitude is 6 dB quieter (${d6.toFixed(2)} dB)`);
    const lowHigh = E.loudDb(sine(3000, R, 16000)) - E.loudDb(sine(40, R, 16000));
    ok(lowHigh > 3, `levels: as the ear hears it, a 40 Hz tone counts less than 3 kHz at the same peak (${lowHigh.toFixed(1)} dB)`);
    const click = E.loudDb(sine(1000, Math.round(R * 0.01), 16000)) - E.loudDb(sine(1000, R, 16000));
    ok(click < -8 && click > -12, `levels: a 10 ms click counts over 100 ms, as heard (${click.toFixed(1)} dB)`);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const kick = Int16Array.from({ length: Math.round(R * 0.4) }, (_, i) => Math.round(30000 * Math.exp(-i / (R * 0.08)) * Math.sin(2 * Math.PI * 55 * i / R)));
    const hat = Int16Array.from({ length: Math.round(R * 0.06) }, (_, i) => Math.round(30000 * Math.exp(-i / (R * 0.012)) * rnd()));
    const snare = Int16Array.from({ length: Math.round(R * 0.25) }, (_, i) => Math.round(30000 * Math.exp(-i / (R * 0.05)) * (0.5 * rnd() + 0.5 * Math.sin(2 * Math.PI * 190 * i / R))));
    const g = E.matchGains([kick, null, snare, hat]);
    const after = [kick, snare, hat].map((x, j) => E.loudDb(E.withGain(x, [g[0], g[2], g[3]][j])));
    const spread = Math.max(...after) - Math.min(...after);
    ok(g[1] === null && [g[0], g[2], g[3]].every((v) => v <= 0 && v >= E.LEVEL_MIN) && Math.max(g[0], g[2], g[3]) === 0 && spread < 1.2,
      `levels: MATCH LEVELS: kick ${g[0]}, snare ${g[2]}, hat ${g[3]} dB: heard within ${spread.toFixed(2)} dB, the quietest untouched`);
    const far = E.matchGains([sine(1000, R, 30000), sine(1000, R, 100)]);
    ok(far[0] === E.LEVEL_MIN && far[1] === 0, "levels: never more than 24 dB down (a near-silent sound does not mute the rest)");
    const half = E.withGain(Int16Array.of(20000, -20000), -6);
    ok(Math.abs(half[0] - 10024) < 3 && Math.abs(half[1] + 10024) < 3 && E.withGain(half, 0) === half, "levels: a file's Gain (-6 dB: half), 0 dB as it came");
    const kp = { s: kick, fname: "k.wav", tune: 0, gain: g[0], len: 0 };
    ok(Math.abs(E.loudDb(E.kitPad(kp)) - after[0]) < 0.1, "levels: the drum kit pad sends what was matched (kitPad, its Gain)");
  }
  const files = [{ name: "KIT/01 KICK.wav", data: new Uint8Array([1, 2, 3]) }, { name: "KIT/03 SNARE.wav", data: new Uint8Array(1000).fill(7) }];
  const back = await E.zipRead(E.zipStore(files));
  ok(back.length === 2 && back[0].name === "KIT/01 KICK.wav" && back[1].data.length === 1000 && back[1].data[999] === 7, "drum kit: a kit ZIP reads back (zipRead)");
  const dfl = await (async () => {                     /* a deflated entry, as zip tools write them */
    const raw = new Uint8Array(await new Response(new Blob([new Uint8Array(500).fill(65)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const z = E.zipStore([{ name: "a.wav", data: raw }]);
    z[8] = 8; z[raw.length + 30 + 5 + 10] = 8;          /* method 8 in the local header and in the directory */
    return (await E.zipRead(z))[0];
  })();
  ok(dfl.data.length === 500 && dfl.data[499] === 65, "drum kit: ... deflated ZIP entries too");
})();

/* ------------------------------ SLOOP 2.5: length, piano roll, MIDI files, song --- */
/* ------------------------------------------- Lowtide 2.8.8: the drum kit slices --- */
async function editorKitSlices() {
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));
  /* imaStateAt: the decoder state at a slice start — the same loop as imaEncode (its loop state) */
  const sig = s(8000);
  const enc = E.imaEncode(sig, 2000);
  const st = E.imaStateAt(sig, 2000);
  ok(st[0] === enc.pred && st[1] === enc.idx, "kit slices: imaStateAt matches imaEncode's state at the slice start");
  const cuts = [0, 1, 100, 7999];
  ok(cuts.every((at) => { const e2 = E.imaEncode(sig, at); const s2 = E.imaStateAt(sig, at); return s2[0] === e2.pred && s2[1] === e2.idx; }),
    "kit slices: imaStateAt matches imaEncode's state at every cut point (0, 1, 100, the last sample)");
  /* the marker store (backup object 13): the mirror round-trips, with the firmware's layout */
  E.kitSliceDev.fill(0);
  E.kitSlicePutEntry(2, 0, 2000, 4000, 12000, 5);
  const e = E.kitSliceEntry(2, 0);
  ok(e && e.start === 2000 && e.end === 4000 && e.pred === 12000 && e.idx === 5, "kit slices: an entry reads back as written");
  const v = new DataView(E.kitSliceDev.buffer, E.kitSliceDev.byteOffset + (2 * 16 + 0) * 12, 12);
  ok(v.getUint32(0, true) === 2000 && v.getUint32(4, true) === 4000 && v.getInt16(8, true) === 12000 && v.getUint8(10) === 5,
    "kit slices: the entry is start u32, end u32, pred i16, idx u8 (the firmware's kit_slice_t)");
  ok(E.kitSliceEntry(2, 1) === null && E.kitSliceEntry(0, 0) === null, "kit slices: an all-zero entry is no slice");
  E.kitSlicePutEntry(3, 15, 100, 200, -300, 88);
  ok(E.kitSliceEntry(3, 15).pred === -300 && E.kitSliceEntry(3, 15).idx === 88, "kit slices: the last slot and lane have their own entry");
  /* kitSliceRange: the slice, clamped to the pad, or the whole pad */
  const p = { s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0 };
  ok(JSON.stringify(E.kitSliceRange(p)) === JSON.stringify({ start: 0, end: 8000 }), "kit slices: no slice plays the whole pad");
  p.slice = { start: 2000, end: 4000 };
  ok(JSON.stringify(E.kitSliceRange(p)) === JSON.stringify({ start: 2000, end: 4000 }), "kit slices: a slice plays its range");
  p.slice = { start: 7000, end: 99999 };
  ok(E.kitSliceRange(p).end === 8000, "kit slices: a slice past the pad's end is clamped");
  /* kitPadDrop: a swap when the target has a sample, a move when it is empty (the pad object moves whole) */
  const dropSrc = html.slice(html.indexOf("function kitPadDrop"), html.indexOf("/* ---- the slicing panel"));
  const dropBox = { console, kitWriteNow: () => {} };   /* (2.8.9) the drop writes to the FM-1 at once; the test only checks the swap / move */
  const K = vm.runInNewContext(dropSrc + `\n;({ kitPadDrop })`, dropBox);
  const A = { s: s(1000), fname: "kick.wav", tune: 2, gain: -3, len: 500, slice: { start: 100, end: 400 } };
  const B = { s: s(2000), fname: "snare.wav", tune: -1, gain: 0, len: 0 };
  dropBox.kitDraft = { pads: Array(16).fill(null), sel: 0, picked: null };
  dropBox.kitDraft.pads[0] = A; dropBox.kitDraft.pads[2] = B;
  dropBox.renderKits = () => {};
  K.kitPadDrop(0, 2);
  ok(dropBox.kitDraft.pads[2] === A && dropBox.kitDraft.pads[0] === B && dropBox.kitDraft.sel === 2
    && dropBox.kitDraft.pads[2].tune === 2 && dropBox.kitDraft.pads[2].gain === -3 && dropBox.kitDraft.pads[2].slice.start === 100,
    "kit drag: a drop on a taken pad swaps them, pitch, gain, length and slice carried over");
  K.kitPadDrop(2, 5);
  ok(dropBox.kitDraft.pads[5] === A && dropBox.kitDraft.pads[2] === null && dropBox.kitDraft.sel === 5,
    "kit drag: a drop on an empty pad moves it there, and the selection follows");
  K.kitPadDrop(5, 5);
  ok(dropBox.kitDraft.pads[5] === A, "kit drag: a drop on itself changes nothing");
  /* kit export / import: the whole kit (name, per-pad settings, slices) round-trips through the ZIP */
  const exSrc = html.slice(html.indexOf("function kitExport()"), html.indexOf("async function smpInfo()"));
  const decSrc = html.slice(html.indexOf("async function decodeFile"), html.indexOf("/* ---- the Samples page"));
  const exBox = { console, TextEncoder, TextDecoder, File, Blob, Response,
    DRUM_LANES: E.DRUM_LANES, KIT: E.KIT, kitLen: E.kitLen, kitPad: E.kitPad, wavFile: E.wavFile,
    imaEncode: E.imaEncode, imaDecode: E.imaDecode, kitWriteNow: () => {},   /* (2.8.9) the export is ADPCM now, and the import writes at once */
    zipStore: E.zipStore, zipRead: E.zipRead, parseWav: E.parseWav, resample: E.resample, KIT_MIN_CHOP: E.KIT_MIN_CHOP, kitMinChop: E.kitMinChop,
    normalize: E.normalize, rootFromName: E.rootFromName, SMP: E.SMP, LOOP: E.LOOP,
    dev: null,   /* (2.8.14) no device here, so the export takes the old-firmware path: the gain stays baked, kit.json keeps 0 */
    fileSlug: (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patch",
    sayK: () => {}, renderKits: () => {}, t: (k) => k };
  const X = vm.runInNewContext(exSrc + "\n" + decSrc + `\n;({ kitExport, kitImport, kitZipParse })`, exBox);
  let exported = null;
  exBox.downloadBytes = (name, bytes) => { exported = { name, bytes }; };
  exBox.kitDraft = { name: "MYKIT", slot: 4, pads: Array(16).fill(null), sel: -1, sent: false };
  exBox.kitDraft.pads[0] = { s: s(8000), fname: "kick.wav", tune: 0, gain: 0, len: 0, slice: { start: 2000, end: 4000 } };
  exBox.kitDraft.pads[2] = { s: s(6000), fname: "snare.wav", tune: 3, gain: -6, len: 0 };
  exBox.kitDraft.pads[5] = { s: s(12000), fname: "oh.wav", tune: 0, gain: 0, len: 4410, slice: { start: 100, end: 500 } };
  const baked2 = E.kitPad(exBox.kitDraft.pads[2]).length;   /* (2.8.9) v2 bakes the gain into the audio; (2.8.13) the tune is not baked anymore */
  X.kitExport();
  ok(exported && exported.bytes.length > 1000, "kit export: a ZIP is downloaded");
  const kj = JSON.parse(new TextDecoder().decode((await E.zipRead(exported.bytes)).find((x) => x.name === "kit.json").data));
  const zNames = (await E.zipRead(exported.bytes)).map((x) => x.name);
  ok(kj.format === "lowtide-drum-kit" && kj.version === 2 && kj.name === "MYKIT" && kj.pads.length === 3
    && kj.pads[0].lane === 0 && kj.pads[0].adpcm === "01 KICK.adpcm" && kj.pads[0].tune === 0 && kj.pads[0].gain === 0 && kj.pads[0].len === 8000
    && kj.pads[0].slice.start === 2000 && kj.pads[0].slice.end === 4000
    && kj.pads[1].lane === 2 && kj.pads[1].adpcm === "03 SNARE.adpcm" && kj.pads[1].tune === 3 && kj.pads[1].gain === 0 && kj.pads[1].len === baked2
    && kj.pads[2].lane === 5 && kj.pads[2].adpcm === "06 OPEN HAT.adpcm" && kj.pads[2].tune === 0 && kj.pads[2].gain === 0 && kj.pads[2].len === 4410
    && kj.pads[2].slice.start === 100 && !kj.pads.some((p) => "wav" in p) && zNames.every((n) => n === "kit.json" || n.endsWith(".adpcm")),
    "kit export: kit.json v2 holds the name, the adpcm field, the tune (2.8.13: it survives in kit.json now), baked gain (0) and len = the sample count, and slices; no WAV");
  exBox.kitDraft.pads = Array(16).fill(null); exBox.kitDraft.name = "";
  await X.kitImport(new File([exported.bytes], "mykit-kit.zip"));
  const ip = exBox.kitDraft.pads;
  ok(exBox.kitDraft.name === "MYKIT" && ip[0] && ip[0].fname === "kick.wav" && ip[0].s.length === 8000 && ip[0].adpcm && ip[0].adpcm.length === 4000
    && ip[0].slice && ip[0].slice.start === 2000 && ip[0].slice.end === 2000 + E.KIT_MIN_CHOP
    && ip[2] && ip[2].tune === 3 && ip[2].gain === 0 && ip[2].len === 0 && ip[2].s.length === baked2 && !ip[2].slice
    && ip[5] && ip[5].tune === 0 && ip[5].gain === 0 && ip[5].len === 0 && ip[5].s.length === 4410 && ip[5].slice && ip[5].slice.start === 100 && ip[5].slice.end === 100 + E.KIT_MIN_CHOP,
    "kit import: the kit comes back with its samples (ADPCM decoded), its tune (2.8.13: it survives the round-trip now), baked gain and slices (a sub-120 ms slice is widened to the 120 ms minimum on import)");
  await X.kitImport(new File([E.zipStore([{ name: "x.wav", data: new Uint8Array(10) }])], "bad.zip"));
  ok(exBox.kitDraft.name === "MYKIT" && ip[0] && ip[0].fname === "kick.wav", "kit import: a ZIP without kit.json is rejected, the kit stays");
  /* (2.8.9) a v1 (WAV) kit is refused with the old-version message, and the kit stays; a future
     version and a kit.json that is not a kit are refused too */
  const v1zip = E.zipStore([{ name: "kit.json", data: new TextEncoder().encode(JSON.stringify({ format: "lowtide-drum-kit", version: 1, name: "OLDKIT",
    pads: [{ lane: 0, file: "kick.wav", wav: "01 KICK.wav", tune: 0, gain: 0, len: 8000 }] })) }, { name: "01 KICK.wav", data: E.wavFile(s(8000)) }]);
  const errOf = async (f) => X.kitZipParse(f).then(() => "", (e) => e.message);
  ok((await errOf(new File([v1zip], "old-kit.zip"))) === "kitImportOld"
    && /kitImportOld: "This kit is the old version 1 \(WAV\) format and can't be imported\."/.test(html),
    "kit import: a v1 (WAV) kit is refused with the old-version message");
  await X.kitImport(new File([v1zip], "old-kit.zip"));
  ok(exBox.kitDraft.name === "MYKIT" && ip[0] && ip[0].fname === "kick.wav", "kit import: a v1 (WAV) kit is refused, the kit stays");
  const v3zip = E.zipStore([{ name: "kit.json", data: new TextEncoder().encode(JSON.stringify({ format: "lowtide-drum-kit", version: 3, name: "NEW", pads: [] })) }]);
  const notKitZip = E.zipStore([{ name: "kit.json", data: new TextEncoder().encode(JSON.stringify({ format: "something-else", version: 2, pads: [] })) }]);
  ok((await errOf(new File([v3zip], "v3.zip"))) === "kitImportBadkit.json" && (await errOf(new File([notKitZip], "notkit.zip"))) === "kitImportBadkit.json",
    "kit import: a future version and a kit.json that is not a kit are refused");
  /* the mock device (protocol 16): object 13 is listed only when non-default, and a write reads back */
  const { m, rq, done } = attachMock();
  const list = async () => E.parse[E.CMD.BK_LIST](await rq(E.req.bkList(), { timeout: 5000, retries: 0 }));
  ok(!(await list()).items.some((x) => x.id === 13), "kit slices: object 13 is absent when the store is default");
  const bytes = new Uint8Array(768);
  const w = new DataView(bytes.buffer);
  w.setUint32((2 * 16 + 0) * 12, 2000, true); w.setUint32((2 * 16 + 0) * 12 + 4, 4000, true);
  w.setInt16((2 * 16 + 0) * 12 + 8, 12000, true); w.setUint8((2 * 16 + 0) * 12 + 10, 5);
  await E.bkWriteObj(rq, 13, bytes);
  const L = await list();
  ok(L.items.some((x) => x.id === 13 && x.len === 768), "kit slices: object 13 is listed once a slice is written");
  const it = L.items.find((x) => x.id === 13);
  const back = await E.bkReadObj(rq, it);
  ok(back.length === 768 && back[(2 * 16 + 0) * 12 + 10] === 5 && new DataView(back.buffer).getUint32((2 * 16 + 0) * 12, true) === 2000,
    "kit slices: object 13 reads back as written (BK_PUT / BK_GET, 768 bytes)");
  done();
  /* the old firmware (protocol 15, opt.v15): no object 13, and the editor's kitSliceWrite refuses it */
  const old = attachMock({ v15: true });
  const oldList = E.parse[E.CMD.BK_LIST](await old.rq(E.req.bkList(), { timeout: 5000, retries: 0 }));
  ok(!oldList.items.some((x) => x.id === 13), "kit slices: a v15 device never lists object 13");
  const oldInfo = E.parse[E.CMD.INFO](await old.rq(E.req.info()));
  ok(oldInfo.proto === 15, "kit slices: opt.v15 is the old protocol (15)");
  old.done();
}

/* ------------------------------------------- Lowtide 2.8.9: Route B, v2 kits, pick-a-slot --- */
async function editorKit289() {
  const C = E.CMD;
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));
  /* ADPCM decode: decoding then re-encoding reproduces the original bytes (the decode is the
     inverse of the encode, nibble for nibble) — on a smooth signal, a harsh one and noise, and on
     an odd sample count. The decoded samples themselves are lossy, so only the bytes are compared. */
  const sigs = { smooth: s(8000), harsh: Int16Array.from({ length: 8000 }, (_, i) => (i % 2 ? 1 : -1) * 20000),
    noise: Int16Array.from({ length: 8000 }, (_, i) => Math.round((((i * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1)) * 20000) };
  const rt = Object.entries(sigs).map(([k, v]) => {
    const enc = E.imaEncode(v).data, dec = E.imaDecode(enc, v.length), re = E.imaEncode(dec).data;
    return `${k}:${eq(enc, re) && dec.length === v.length}`;
  });
  const odd = Int16Array.from({ length: 7999 }, (_, i) => Math.round(15000 * Math.sin(i / 11)));
  const oe = E.imaEncode(odd).data, oddOk = eq(oe, E.imaEncode(E.imaDecode(oe, odd.length)).data);
  ok(rt.every((x) => x.endsWith(":true")) && oddOk, `kit v2: imaDecode round trip (decode -> re-encode: the same bytes; ${rt.join(", ")}; odd length too)`);
  ok(JSON.stringify([...E.imaDecode(new Uint8Array([0x00]), 2)]) === "[0,0]"
    && JSON.stringify([...E.imaDecode(new Uint8Array([0x77]), 2)]) === "[11,41]"
    && JSON.stringify([...E.imaDecode(new Uint8Array([0xff]), 2)]) === "[-11,-41]"
    && JSON.stringify([...E.imaDecode(new Uint8Array([0x77, 0x00]), 3)]) === "[11,41,45]",
    "kit v2: imaDecode of known vectors (silence 0, 0x77 -> 11 / 41, 0xff -> -11 / -41)");
  /* a slice's decode starts from the encoder's state at the cut (imaStateAt), not from zero */
  const full = E.imaDecode(E.imaEncode(sigs.smooth).data, 8000);
  const st = E.imaStateAt(sigs.smooth, 2000);
  const tail = E.imaDecode(E.imaEncode(sigs.smooth).data.subarray(1000), 6000, st[0], st[1]);
  ok(eq(tail, full.subarray(2000)), "kit v2: imaDecode from the state at a slice start decodes the tail as the whole file does");

  /* Route B: the commands, the requests, the parsers, the protocol version */
  ok(C.KITS_MODE === 80 && C.KITS_STOP === 81 && !!E.req.kitsMode && !!E.req.kitsStop && !!E.parse[80] && !!E.parse[81]
    && E.req.kitsMode(3)[1].join() === "3" && E.req.kitsStop(0xFF)[1].join() === "127",
    "route B: KITS_MODE 80, KITS_STOP 81 (requests and parsers; KITS_STOP never sends 0xFF, masked to 127)");
  const { m, rq, done } = attachMock({});
  const info = E.parse[C.INFO](await rq(E.req.info()));
  ok(info.proto === 19, "route B: protocol version is 19");
  const m3 = E.parse[C.KITS_MODE](await rq(E.req.kitsMode(3)));
  const st3 = m.state.kitsMode;
  const m5 = E.parse[C.KITS_MODE](await rq(E.req.kitsMode(5)));
  const st5 = m.state.kitsMode;
  const m0 = E.parse[C.KITS_MODE](await rq(E.req.kitsMode(0)));
  const st0 = m.state.kitsMode;
  ok(m3.mode === 3 && m3.rc === 0 && st3 === 3 && m5.mode === 5 && st5 === 5 && m0.mode === 0 && st0 === 0,
    "route B: KITS_MODE 3 (USR3), 5 (USR3+4), 0 (off) — the mode the editor last set, read back");
  const badMode = await rq(E.req.kitsMode(6), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  ok(badMode === "none", "route B: KITS_MODE 6 (no such mode) gets no reply");
  const s5 = E.parse[C.KITS_STOP](await rq(E.req.kitsStop(5)));
  const sAll = E.parse[C.KITS_STOP](await rq(E.req.kitsStop(127)));
  const sFF = E.parse[C.KITS_STOP](await rq(E.req.kitsStop(0xFF)));
  ok(s5.lane === 5 && s5.rc === 0 && m.state.kitsStop.includes(5) && sAll.lane === 127 && m.state.kitsStop.includes(127) && sFF.lane === 127,
    "route B: KITS_STOP 5 stops lane 5, 127 stops all lanes, 0xFF arrives as 127 (a 7-bit SysEx data byte)");
  const badLane = await rq(E.req.kitsStop(16), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  ok(badLane === "none", "route B: KITS_STOP 16 (no such lane) gets no reply");
  done();
  const o16 = attachMock({ v16: true });
  const oi = E.parse[C.INFO](await o16.rq(E.req.info()));
  const noMode = await o16.rq(E.req.kitsMode(1), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  const noStop = await o16.rq(E.req.kitsStop(0), { timeout: 60, retries: 0, quiet: true }).then(() => "reply", () => "none");
  ok(oi.proto === 16 && noMode === "none" && noStop === "none", "route B: a v16 device answers neither KITS_MODE nor KITS_STOP");
  o16.done();

  /* the editor sends KITS_MODE on entering the Kits tab (the picked slot, or 0), on leaving (0),
     and on pick change — kitsModeUpdate / kitPickSlot, run in a sandbox with a recording link */
  const modeSrc = html.slice(html.indexOf("const kitDraft = "), html.indexOf("let kitUi = null;"));
  const pickSrc = html.slice(html.indexOf("async function kitPickSlot"), html.indexOf("/* (2.8.9) the draft kit as a v2 ZIP"));
  const sent = [], writes = [];
  const modeBox = { console, dev: { info: { proto: 18 } }, tab: "kits", SMP: E.SMP,
    req: E.req, rq: async (r) => { sent.push(r); }, report: () => {},
    confirm: () => true, t: (k) => k, kitWriteNow: async () => { writes.push(1); }, renderKits: () => {}, setTimeout, clearTimeout,
    bkReadRange: async () => new Uint8Array(480), kitSlotKind: () => "kit" };   /* (2.8.10) every slot reads as holding a kit; (2.8.17) a pick asks first only when the draft is unsent */
  const M = vm.runInNewContext(modeSrc + "\n" + pickSrc + `\n;({ kitDraft, kitsModeUpdate, kitsStopSend, kitPickSlot })`, modeBox);
  await M.kitsModeUpdate();
  await M.kitsModeUpdate();   /* the same value again: not sent twice */
  M.kitDraft.slot = 2; await M.kitsModeUpdate();
  M.kitDraft.slot = 4; await M.kitsModeUpdate();   /* USR3+4 */
  modeBox.tab = "sound"; await M.kitsModeUpdate();   /* leaving the Kits tab */
  ok(JSON.stringify(sent) === JSON.stringify([[80, [0]], [80, [3]], [80, [5]], [80, [0]]]),
    "route B: KITS_MODE on entering (0 with no pick), on pick change (3 USR3, 5 USR3+4), on leaving (0); unchanged values not resent");
  modeBox.tab = "kits";
  await M.kitPickSlot(1);   /* no pads in the draft: no confirm, no write, the slot's kit is read back (empty here) */
  ok(M.kitDraft.slot === 1 && sent.at(-1).join() === "80,2" && writes.length === 0 && M.kitDraft.pads.every((p) => !p),
    "route B: picking a slot with an empty draft reads that slot back (empty here) instead of writing");
  M.kitDraft.pads[0] = { s: s(1000), fname: "k.wav", tune: 0, gain: 0, len: 0 };
  await M.kitPickSlot(3); await sleep(10);
  ok(M.kitDraft.slot === 3 && sent.at(-1).join() === "80,4" && writes.length === 0 && M.kitDraft.pads.every((p) => !p),
    "route B: picking another slot with the kit already written reads the new slot back (empty here); the old slot keeps its copy");
  modeBox.confirm = () => false;
  M.kitDraft.pads[0] = { s: s(1000), fname: "k.wav", tune: 0, gain: 0, len: 0 };
  M.kitDraft.sent = false;   /* (2.8.17) the draft is unsent now, so the pick asks (kitSwitchConfirm) and can be refused — a safe draft no longer asks at all */
  await M.kitPickSlot(0);
  ok(M.kitDraft.slot === 3 && sent.at(-1).join() === "80,4" && writes.length === 0,
    "route B: refusing the pick keeps the slot, the mode and the kit (no read-back, no write)");
  modeBox.confirm = () => true;
  M.kitDraft.slot = null; M.kitDraft.sent = false;   /* an imported kit with no slot yet: never written anywhere */
  M.kitDraft.pads[0] = { s: s(1000), fname: "k.wav", tune: 0, gain: 0, len: 0 };
  await M.kitPickSlot(2); await sleep(10);
  ok(M.kitDraft.slot === 2 && sent.at(-1).join() === "80,3" && writes.length === 1 && M.kitDraft.pads[0] && M.kitDraft.pads[0].fname === "k.wav",
    "route B: picking a slot with an unwritten draft writes the draft there (the import is not lost)");
  modeBox.confirm = () => true;
  await M.kitsStopSend(7); await M.kitsStopSend(0xFF);
  ok(JSON.stringify(sent.slice(-2)) === JSON.stringify([[81, [7]], [81, [127]]]),
    "route B: kitsStopSend sends the lane, and 0xFF as 127");
  ok(/if \(prev === "kits" && name !== "kits"\) kitsModeUpdate\(\);/.test(html)
    && /kitsModeUpdate\(\);   \/\* \(2\.8\.9\) entering the Kits tab/.test(html),
    "route B: showTab calls kitsModeUpdate on leaving the Kits tab, renderPanels on entering it");

  /* pick-a-slot gating: the grid and the Chop panel are locked until a slot is picked; the
     per-slot Export works without a pick (the per-slot Import ZIP is gone, #30) */
  ok(/\.kitlocked \.pads, \.kitlocked \.slice \{ opacity: \.38; pointer-events: none; \}/.test(html)
    && /\.kitlocked \.lockbanner \{ display: flex; \}/.test(html)
    && /u\.card\.classList\.toggle\("kitlocked", kitDraft\.slot == null\)/.test(html)
    && /slot: null/.test(modeSrc),
    "pick-a-slot: no slot picked -> the grid and Chop panel are inert (kitlocked) with a banner; the draft starts with no slot");
  const writeSrc = html.slice(html.indexOf("async function kitWriteNow()"), html.indexOf("function kitWriteSoon"));
  const commitSrc = html.slice(html.indexOf("async function kitSliceCommit"), html.indexOf("function kitSliceZoom"));
  ok(/if \(!dev \|\| kitDraft\.slot == null\) return;/.test(writeSrc) && /if \(!dev \|\| kitDraft\.slot == null\) return "failed";/.test(commitSrc),
    "pick-a-slot: with no slot picked, neither a kit write nor a marker write leaves the editor");
  ok(/onclick: \(\) => kitExportSlot\(d\)/.test(html) && !/kitImportSlot/.test(html) && !/t\("kitImportZip"\)/.test(html) && !/slotFile/.test(html)
    && /async function kitExportSlot\(k\)/.test(html) && /const slots = kitSlots\(k\)/.test(html)
    && !html.slice(html.indexOf("async function kitExportSlot"), html.indexOf("/* (2.8.9) a v2 kit ZIP into the draft")).includes("kitDraft.slot"),
    "pick-a-slot: each slot card's own Export works on that slot (kitExportSlot(k), no picked slot needed); the Import ZIP button is gone (#30)");
  {   /* kitZipParse restores the gain from kit.json (2.8.14), clamped to -24..0, and defaults
       to 0 when an older kit has no gain field (the gain was baked into its audio) */
    const impSrc = html.slice(html.indexOf("async function kitZipParse"), html.indexOf("async function kitUploadPads"));
    const impBox = { console, TextEncoder, TextDecoder, File, Blob, zipRead: E.zipRead, imaDecode: E.imaDecode, KIT_MIN_CHOP: E.KIT_MIN_CHOP, kitMinChop: E.kitMinChop,
      kitUploadPads: async () => true, kitSlotKinds: null, kitDraft: { name: "", slot: null, pads: Array(16).fill(null), sel: -1, sent: true }, kitWrittenSlot: null,
      renderKits: () => {}, sayK: () => {}, t: (k) => k, dev: {} };
    const I = vm.runInNewContext(impSrc + `\n;({ kitZipParse })`, impBox);
    const ad = E.imaEncode(s(8000)).data;
    const mkZip = (gain) => E.zipStore([{ name: "kit.json", data: new TextEncoder().encode(JSON.stringify({ format: "lowtide-drum-kit", version: 2, name: "MYKIT",
      pads: [{ lane: 0, file: "kick.wav", adpcm: "01 KICK.adpcm", tune: 0, gain, len: 8000, slice: { start: 2000, end: 4000 } }] })) },
      { name: "01 KICK.adpcm", data: ad }]);
    const withGain = await I.kitZipParse(new File([mkZip(-6)], "mykit-kit.zip"));
    ok(withGain.pads[0] && withGain.pads[0].gain === -6 && withGain.pads[0].s.length === 8000 && withGain.pads[0].slice.start === 2000,
      "pick-a-slot: a kit ZIP with gain -6 in kit.json imports at -6 dB (2.8.14)");
    const noGain = await I.kitZipParse(new File([mkZip(undefined)], "old-kit.zip"));
    ok(noGain.pads[0] && noGain.pads[0].gain === 0,
      "pick-a-slot: a kit ZIP with no gain field imports at 0 dB (an older kit, its gain baked in)");
    const tooLow = await I.kitZipParse(new File([mkZip(-30)], "loud-kit.zip"));
    ok(tooLow.pads[0] && tooLow.pads[0].gain === -24,
      "pick-a-slot: an out-of-range gain in kit.json is clamped to -24 dB on import");
  }

  /* the Stop button flips back to Play after the estimated play length (the chop range's length) */
  const playSrc = html.slice(html.indexOf("function kitTogglePlay"), html.indexOf("function kitDrawWave"));
  const notesOn = [], notesOff = [], stops = [];
  const playBox = { console, setTimeout, clearTimeout, t: (k) => k, kitUi: null,
    kitDraft: { name: "", slot: 2, pads: Array(16).fill(null), sel: -1, sent: true }, kitPlaying: new Map(),
    kitSliceRange: E.kitSliceRange, kitRate: E.kitRate, drumPadsHearNote: () => -1, DRUM_LANES: E.DRUM_LANES, SMP: E.SMP,
    lvNoteOn: (tok, tr, note, vel) => { notesOn.push([tok, tr, note, vel]); },
    lvNoteOff: (tok) => { notesOff.push(tok); },
    kitsStopSend: async (l) => { stops.push(l); } };
  const P = vm.runInNewContext(playSrc + `\n;({ kitDraft, kitTogglePlay, kitStartLane, kitStopLane, kitStopAll, kitPlaying })`, playBox);
  P.kitDraft.pads[0] = { s: s(2205), fname: "k.wav", tune: 0, gain: 0, len: 0 };   /* 0.1 s at 22050 Hz */
  P.kitTogglePlay(0);
  ok(notesOn.length === 1 && notesOn[0][2] === 36 && P.kitPlaying.has(0), "stop-timer: Play starts the lane on the FM-1 (note 36) and the Stop timer runs");
  notesOff.length = 0; stops.length = 0;   /* (starting a lane stops it first: clear that, so only the timer's stop counts) */
  await sleep(250);
  ok(!P.kitPlaying.has(0) && stops.includes(0) && notesOff.includes("kit:0"),
    "stop-timer: after the estimated play length (0.1 s) the lane stops and the button flips back to Play");
  notesOn.length = 0; notesOff.length = 0; stops.length = 0;
  P.kitDraft.pads[1] = { s: s(22050), fname: "o.wav", tune: 0, gain: 0, len: 0, slice: { start: 0, end: 4410 } };   /* a 1 s pad, chopped to 0.2 s */
  P.kitTogglePlay(1);
  stops.length = 0;
  await sleep(100);
  const still = P.kitPlaying.has(1) && stops.length === 0;
  await sleep(250);
  ok(still && !P.kitPlaying.has(1) && stops.includes(1),
    "stop-timer: the timer is the chop range's length (0.2 s), not the whole pad (1 s)");
  P.kitDraft.pads[2] = { s: s(22050), fname: "long.wav", tune: 0, gain: 0, len: 0 };
  P.kitTogglePlay(2);
  await sleep(50);
  P.kitTogglePlay(2);   /* a second tap stops it at once */
  ok(!P.kitPlaying.has(2) && stops.includes(2) && notesOff.includes("kit:2"),
    "stop-timer: a second tap stops the lane at once (Stop -> Play)");
  P.kitTogglePlay(3);   /* an empty pad: nothing plays, no timer */
  ok(notesOn.length === 2 && !P.kitPlaying.has(3) && !stops.includes(3),
    "stop-timer: an empty pad plays nothing and sets no timer");
  notesOn.length = 0; stops.length = 0;
  P.kitTogglePlay(0); P.kitTogglePlay(1);
  stops.length = 0;   /* (starting a lane stops it first: clear that, so only Stop All's stops count) */
  P.kitStopAll();
  ok(!P.kitPlaying.size && stops.length === 2 && stops.includes(0) && stops.includes(1),
    "stop-timer: Stop All ends every lane's timer and stops each voice");

  /* the settle delay: pitch / gain / length writes wait 500 ms for the control to stop moving;
     chop marker writes go immediately, with no delay at all */
  ok(/function kitWriteSoon\(ms = 500\)/.test(html), "settle: kitWriteSoon debounces 500 ms by default");
  const soonSrc = html.slice(html.indexOf("function kitWriteSoon"), html.indexOf("async function kitEraseSlot"));
  let soonCalls = 0;
  const soonBox = { console, setTimeout, clearTimeout, kitWriteNow: async () => { soonCalls++; } };
  const S = vm.runInNewContext(`let kitWriteTimer = null;\n` + soonSrc + `\n;({ kitWriteSoon })`, soonBox);
  S.kitWriteSoon(); S.kitWriteSoon(); S.kitWriteSoon();
  await sleep(200);
  const early = soonCalls;
  await sleep(450);
  ok(early === 0 && soonCalls === 1, "settle: three pitch/gain writes in a row -> one write, 500 ms after the last");
  S.kitWriteSoon(); await sleep(200); S.kitWriteSoon(); await sleep(650);
  ok(soonCalls === 2, "settle: a write 200 ms in restarts the 500 ms delay (still one write)");
  const cTimers = [], cWrites = [], cSyncs = [];
  const commitBox = { console, dev: {}, setTimeout: (fn, ms) => { cTimers.push(ms); return 1; }, clearTimeout: () => {},
    kitDraft: { slot: 2, sent: false }, kitWriteNow: async () => { cWrites.push(1); commitBox.kitDraft.sent = true; },
    kitSliceSyncFromDraft: async () => { cSyncs.push(1); }, report: () => {}, kitSlicePending: false, bkReport: () => {} };
  const K = vm.runInNewContext(commitSrc + `\n;({ kitSliceCommit })`, commitBox);
  await K.kitSliceCommit();
  ok(cWrites.length === 1 && cSyncs.length === 1 && cTimers.length === 0,
    "settle: a chop marker write goes immediately (the kit first, then its markers; no timer set)");
  await K.kitSliceCommit();   /* the kit is on the FM-1 now: only the markers go */
  ok(cWrites.length === 1 && cSyncs.length === 2 && cTimers.length === 0,
    "settle: a marker write with the kit already sent writes only the markers, still at once");
  commitBox.kitDraft.slot = null;
  await K.kitSliceCommit();
  ok(cWrites.length === 1 && cSyncs.length === 2, "settle: a marker write with no slot picked writes nothing");
}

/* ------------------------------------------- Lowtide 2.8.10: the 2.8.9 bug fixes --- */
async function editorKit2810() {
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));

  /* #13: picking a slot reads that slot's kit back (its ADPCM as-is, its markers from object 13);
     an empty slot empties the draft; an unwritten draft is written to the picked slot instead */
  const modeSrc = html.slice(html.indexOf("const kitDraft = "), html.indexOf("let kitUi = null;"));
  const pickSrc = html.slice(html.indexOf("async function kitPickSlot"), html.indexOf("/* (2.8.9) the draft kit as a v2 ZIP"));
  const hdrSrc = html.slice(html.indexOf("/* a slot's header:"), html.indexOf("/* (2.8.9) what each USR slot holds"));
  const kitSig = s(8000), kitAdpcm = E.imaEncode(kitSig).data;
  const built = E.buildSlot("TESTKIT", [{ s: kitSig, adpcm: kitAdpcm, root: 36, lo: 36, hi: 36 }]);
  const kitRaw = new Uint8Array(E.SMP.DATA_OFF + built.data.length);
  kitRaw.set(built.hdr, 0); kitRaw.set(built.data, E.SMP.DATA_OFF);
  const emptyRaw = new Uint8Array(E.SMP.HDR_LEN);   /* no magic: an empty slot */
  const sent = [], writes = [], confirms = [];
  let confirmOk = true;
  const rbBox = { console, TextEncoder, TextDecoder, dev: { info: { proto: 18 } }, tab: "kits", SMP: E.SMP, DRUM_LANES: E.DRUM_LANES,
    imaDecode: E.imaDecode, kitSliceEntry: E.kitSliceEntry, kitSliceLoaded: false,
    kitSliceRead: async () => { E.kitSliceDev.fill(0); E.kitSlicePutEntry(2, 0, 1000, 3000, 0, 0); },
    bkReadSlot: async (k) => (k === 2 ? kitRaw : emptyRaw),
    bkReadRange: async (id) => (id === 34 || id === 35 ? kitRaw.subarray(0, 480) : emptyRaw.subarray(0, 480)),
    req: E.req, rq: async (r) => { sent.push(r); }, report: () => {},
    confirm: (m) => { confirms.push(m); return confirmOk; }, t: (k) => k,
    kitWriteNow: async () => { writes.push(1); }, renderKits: () => {}, setTimeout, clearTimeout };
  const RB = vm.runInNewContext(modeSrc + "\n" + pickSrc + "\n" + hdrSrc + `\n;({ kitDraft, kitsModeUpdate, kitsStopSend, kitPickSlot })`, rbBox);
  await RB.kitPickSlot(2);
  ok(RB.kitDraft.slot === 2 && RB.kitDraft.name === "TESTKIT" && RB.kitDraft.pads[0] && RB.kitDraft.pads[0].fname === "TESTKIT"
    && RB.kitDraft.pads[0].s.length === 8000 && eq(RB.kitDraft.pads[0].adpcm, kitAdpcm)
    && RB.kitDraft.pads[0].slice && RB.kitDraft.pads[0].slice.start === 1000 && RB.kitDraft.pads[0].slice.end === 3000
    && writes.length === 0 && sent.at(-1).join() === "80,3" && confirms.join() === "",
    "slot read-back: picking a slot loads its kit (name, ADPCM as-is, chop markers) without asking — it does not overwrite the slot");
  await RB.kitPickSlot(3);
  ok(RB.kitDraft.slot === 3 && RB.kitDraft.name === "" && RB.kitDraft.pads.every((p) => !p) && writes.length === 0,
    "slot read-back: picking an empty slot empties the draft");
  RB.kitDraft.slot = null; RB.kitDraft.sent = false;   /* an imported kit with no slot yet */
  RB.kitDraft.pads[0] = { s: s(1000), fname: "k.wav", tune: 0, gain: 0, len: 0 };
  await RB.kitPickSlot(2);
  ok(RB.kitDraft.slot === 2 && writes.length === 1 && RB.kitDraft.pads[0].fname === "k.wav" && confirms.at(-1) === "kitConfirm",
    "slot read-back: an unwritten draft is written to the picked slot instead (the import survives)");
  confirmOk = false;
  await RB.kitPickSlot(3);
  ok(RB.kitDraft.slot === 2 && writes.length === 1 && confirms.at(-1) === "kitSwitchConfirm",
    "slot read-back: refusing the pick keeps the slot and the draft");
  ok(confirms.join() === "kitConfirm,kitSwitchConfirm",
    "slot read-back: the pick asks with the write message when the draft is unsent, and does not ask when the target is a kit and the draft is safe");

  /* #12: importing a kit ZIP with no slot picked waits in the draft (no success reported) until a slot is picked */
  const exSrc = html.slice(html.indexOf("function kitExport()"), html.indexOf("async function smpInfo()"));
  const decSrc = html.slice(html.indexOf("async function decodeFile"), html.indexOf("/* ---- the Samples page"));
  const said = [];
  const exBox = { console, TextEncoder, TextDecoder, File, Blob, Response,
    DRUM_LANES: E.DRUM_LANES, KIT: E.KIT, kitLen: E.kitLen, kitPad: E.kitPad, wavFile: E.wavFile,
    imaEncode: E.imaEncode, imaDecode: E.imaDecode, zipStore: E.zipStore, zipRead: E.zipRead, parseWav: E.parseWav, resample: E.resample, KIT_MIN_CHOP: E.KIT_MIN_CHOP, kitMinChop: E.kitMinChop,
    normalize: E.normalize, rootFromName: E.rootFromName, SMP: E.SMP, LOOP: E.LOOP,
    fileSlug: (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patch",
    sayK: (k) => { said.push(k); }, renderKits: () => {}, t: (k) => k,
    kitWriteNow: async () => { exBox.kitDraft.sent = true; } };
  const X2 = vm.runInNewContext(exSrc + "\n" + decSrc + `\n;({ kitExport, kitImport, kitZipParse })`, exBox);
  const ad = E.imaEncode(s(8000)).data;
  const v2 = E.zipStore([{ name: "kit.json", data: new TextEncoder().encode(JSON.stringify({ format: "lowtide-drum-kit", version: 2, name: "MYKIT",
    pads: [{ lane: 0, file: "kick.wav", adpcm: "01 KICK.adpcm", tune: 0, gain: 0, len: 8000, slice: { start: 2000, end: 4000 } }] })) },
    { name: "01 KICK.adpcm", data: ad }]);
  exBox.kitDraft = { name: "", slot: null, pads: Array(16).fill(null), sel: -1, sent: true };
  await X2.kitImport(new File([v2], "mykit-kit.zip"));
  ok(said.includes("kitNeedSlot") && !said.includes("kitImported") && exBox.kitDraft.pads[0] && exBox.kitDraft.sent === false,
    "kit import: with no slot picked the kit waits in the draft (no success reported) until a slot is picked");
  exBox.kitDraft.slot = 2;
  await X2.kitImport(new File([v2], "mykit-kit.zip"));
  ok(said.includes("kitImported") && exBox.kitDraft.sent === true,
    "kit import: with a slot picked the kit is written there and only then is the import reported");

  /* #2: a nudge writes the markers before the preview plays; a kit that never landed fails loudly */
  const nudgeSrc = html.slice(html.indexOf("function kitSliceNudge"), html.indexOf("function kitSliceRender"));
  const order = [];
  const nBox = { console, kitDraft: { sel: 0, pads: [{ s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0, slice: { start: 1000, end: 3000 } }] },
    kitSliceRange: E.kitSliceRange, kitRate: E.kitRate, kitSliceSet: () => { order.push("set"); },
    kitSliceCommit: async () => { await sleep(20); order.push("commit"); return "ok"; }, kitStartLane: () => { order.push("start"); }, SMP: E.SMP };
  const N = vm.runInNewContext(nudgeSrc + `\n;({ kitSliceNudge })`, nBox);
  N.kitSliceNudge("start", 10);
  await sleep(50);
  ok(order.join() === "set,commit,start", "slice commit: a nudge writes the markers before the preview plays (commit, then start)");
  ok(/if \(\(await kitSliceCommit\(\)\) === "ok"\) kitStartLane\(kitDraft\.sel\)/.test(html),
    "slice commit: on release the audition awaits the commit and plays only when it landed, so it plays the new start");
  const commitSrc = html.slice(html.indexOf("async function kitSliceCommit"), html.indexOf("function kitSliceZoom"));
  const said2 = [];
  const commitBox = { console, dev: {}, kitDraft: { slot: 2, sent: false }, kitWriteNow: async () => { /* the write fails: sent stays false */ },
    kitSliceSyncFromDraft: async () => { said2.push("sync"); }, report: () => {}, sayK: (k) => { said2.push(k); },
    kitSlicePending: false, bkReport: () => {} };
  const K2 = vm.runInNewContext(commitSrc + `\n;({ kitSliceCommit })`, commitBox);
  await K2.kitSliceCommit();
  ok(said2.join() === "kitSliceWriteFail", "slice commit: a kit that never landed fails loudly (status message, no marker sync)");

  /* #8 / #9: the chop canvas hit test — the START / END tabs are draggable, and the nearest marker wins */
  const hitSrc = html.slice(html.indexOf("function kitSliceHit"), html.indexOf("function renderKits"));
  const fakeCv = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 140 }),
    getContext: () => ({ font: "", measureText: (t) => ({ width: t.length * 7 }) }) };
  const hitBox = { console, kitUi: { sliceCv: fakeCv },
    kitDraft: { sel: 0, pads: [{ s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0, slice: { start: 1000, end: 1200 } }] },
    kitSliceView: { a: 0, b: 8000, for: 0 }, kitSliceRange: E.kitSliceRange };
  const H = vm.runInNewContext(hitSrc + `\n;({ kitSliceHit })`, hitBox);
  ok(H.kitSliceHit(110, 7) === "start" && H.kitSliceHit(85, 7) === "end" && H.kitSliceHit(84, 100) === "end"
    && H.kitSliceHit(80, 100) === "start" && H.kitSliceHit(300, 100) === "pan",
    "chop hit test: the tab strip grabs its marker (START at 110, END over START at 85), and the nearer line wins (end at 84, start at 80)");
  ok(!/const ms1\b/.test(html) && /kitSliceHit\(x, e\.clientY - r\.top\)/.test(html),
    "chop hit test: the pointerdown uses the tab-aware test, and the dead ms1 variable is gone");

  /* #3: the box-preview markers multiply by the retune ratio (baked x the ratio = original) */
  const waveSrc = html.slice(html.indexOf("function kitDrawWave"), html.indexOf("/* (2.8.8) move a sample assignment"));
  const rects = [];
  const fakeCtx = { fillStyle: "", fillRect: (x, y, w, h) => { rects.push([x, y, w, h]); }, clearRect: () => {} };
  const waveCv = { clientWidth: 200, width: 0, height: 0, getContext: () => fakeCtx };
  const waveBox = { console, kitLen: E.kitLen, kitSliceRange: E.kitSliceRange,
    getComputedStyle: () => ({ getPropertyValue: (k) => (k === "--t2" ? "#1ecc70" : "#ff621a") }) };
  const W = vm.runInNewContext(waveSrc + `\n;({ kitDrawWave })`, waveBox);
  W.kitDrawWave(waveCv, { s: s(8000), fname: "k.wav", tune: 12, gain: 0, len: 0, slice: { start: 2000, end: 4000 } });
  const marks = rects.filter((r) => r[2] === 2 && r[1] === 0 && r[3] === 48).map((r) => r[0]);
  ok(JSON.stringify(marks) === "[50,100]", "box preview: the chop markers are in stored samples, so a retune moves them no more (2.8.13: start 2000, end 4000, of 8000 over 200 px, at any tune)");

  /* #4: a slice can never be written with end == 0 (kitSliceSet clamps the end past the start; the marker sync skips a degenerate range) */
  const setSrc = html.slice(html.indexOf("function kitSliceSet"), html.indexOf("async function kitSliceCommit"));
  const setBox = { console, kitDraft: { pads: [{ s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0 }] }, kitLen: E.kitLen, kitSliceRender: () => {}, KIT_MIN_CHOP: E.KIT_MIN_CHOP, kitMinChop: E.kitMinChop };
  const ST = vm.runInNewContext(setSrc + `\n;({ kitSliceSet })`, setBox);
  ST.kitSliceSet(0, 100, 0);
  ok(setBox.kitDraft.pads[0].slice.end === 100 + E.KIT_MIN_CHOP && setBox.kitDraft.pads[0].slice.start === 100,
    "slice end==0: kitSliceSet clamps the end to the 120 ms minimum chop past the start (never end == 0 with start > 0)");
  ST.kitSliceSet(0, 0, 8000);
  ok(!setBox.kitDraft.pads[0].slice, "slice end==0: a full range is no slice");
  ok(/if \(s\.end <= s\.start\) return;/.test(html.slice(html.indexOf("function kitSliceSyncPads"), html.indexOf("function kitSliceClearSlot"))),
    "slice end==0: the marker sync skips a degenerate range instead of writing it");

  /* #7 / #11 / #14 / #1 / #10 / #5 / #6 / #15 / #16: the smaller fixes, by shape */
  ok(/u\.sliceFit\.disabled = false;/.test(html.slice(html.indexOf("function kitSliceRender"), html.indexOf("function kitSliceDraw"))),
    "fit button: the pad-selected branch re-enables Fit (it stayed disabled after any no-pad render)");
  ok(!/u\.use = el\("button"/.test(html) && /u\.use = el\("span", \{ class: "dim" \}\)/.test(html) && !/function kitUse\(/.test(html)
    && /u\.use\.textContent = t\("kitUse"\)/.test(html) && !/u\.use\.disabled/.test(html),
    "use label: the drum-track button is a label now (no button, no onclick, no kitUse)");
  ok(!/function kitZip\(\)/.test(html) && !/u\.zip/.test(html) && !/kitZip: "/.test(html),
    "save as ZIP: the button and the old WAV export are gone (Export kit and per-slot Export stay)");
  ok(/\.slot-io button \{[^}]*min-height: 0;/.test(html) && /\.dest \.cell\.selected \.slot-io button \{ background: var\(--s2\);/.test(html),
    "slot cards: the footer strip is thin (min-height 0, not the pick button's 92 px) and the picked highlight covers the whole card");
  ok(/kitStep2: "Drum Kit Constructor",/.test(html), "step 2: the duplicate kitStep2 key reads 'Drum Kit Constructor'");
  ok(!/−½/.test(html) && !/\+½/.test(html) && /kitSliceFine: "Fine"/.test(html)
    && /title: "Fine zoom out \(0\.5 zoom level\)"/.test(html) && /title: "Fine zoom in \(0\.5 zoom level\)"/.test(html)
    && /class: "zoombox" \}, el\("span", \{ text: t\("kitSliceZoom"\) \}\)/.test(html)
    && /class: "zoombox" \}, el\("span", \{ text: t\("kitSliceFineZoom"\) \}\)/.test(html)
    && /kitSliceZoom: "Zoom"/.test(html) && /kitSliceFineZoom: "Fine Zoom"/.test(html),
    "zoom boxes: the 1.0x zoom is in its own Zoom box and the 0.5x zoom in its own Fine Zoom box, with plain − / + buttons (no ½ labels) and tooltips for the 0.5 zoom-level step");
  const kitsRender = html.slice(html.indexOf("function renderKits()"), html.indexOf("function kitPadUpdate"));
  ok(/u\.prog = el\("progress", \{ max: 1, value: 0, style: "visibility:hidden" \}\)/.test(kitsRender)
    && /prog\.style\.visibility = "visible"/.test(html)
    && /sliderFocused/.test(kitsRender) && /if \(!sliderFocused\)/.test(kitsRender),
    "gain slider: the write progress bar reserves its space (visibility, not hidden) and the grid is not re-appended while a slider has focus");
  ok(/const order = \[\.\.\.Array\(16\)\.keys\(\)\]/.test(kitsRender) && /const cur = \[\.\.\.u\.grid\.children\]/.test(kitsRender)
    && /if \(order\.some\(\(l, i\) => l !== cur\[i\]\)\)/.test(kitsRender)
    && /const y = window\.scrollY;/.test(kitsRender) && /if \(window\.scrollY !== y\) window\.scrollTo\(0, y\);/.test(kitsRender),
    "#37: the grid is only re-appended when the pad order actually changed, and the scroll position is preserved across it — a slider release does not jump the page");
  const hdrUpSrc = html.slice(html.indexOf("async function smpUploadHeader"), html.indexOf("async function smpUpload(k,"));
  ok(!/^\s*renderKits\(\);/m.test(hdrUpSrc),
    "#37: the header-only write performs no re-render of its own (the kitWriteNow tail re-renders once after the write)");
  ok(/const scrollY0 = window\.scrollY;/.test(kitsRender) && /holdScroll\(\);/.test(kitsRender) && /requestAnimationFrame\(holdScroll\);/.test(kitsRender),
    "#40: renderKits holds the scroll position across the whole render (a slider release or a write completion does not jump the page)");
  const fullUpSrc = html.slice(html.indexOf("async function smpUpload(k,"), html.indexOf("async function smpErase"));
  ok((fullUpSrc.match(/renderKits\(\);/g) || []).length === 1 && /finally \{[\s\S]*?renderKits\(\);/.test(fullUpSrc),
    "#40: the full write re-renders only in its finally (no render at its start — the kitWriteNow tail re-renders once after the write)");
  ok(/if \(lpFired && !kitDraft\.dragging && kitDraft\.picked && kitDraft\.picked\.lane === l && kitDraft\.picked\.kind === kind\)/.test(kitsRender)
    && /kitDraft\.picked = null;[\s\S]{0,400}?kitDraft\.justPicked = true;/.test(kitsRender),
    "long-press pick-up: releasing on the same box without dragging disarms the move (picked cleared, outline gone) and re-arms the click swallow, so the release click does not select or play the pad");
  ok(/kitFullWrite = true;/.test(html) && !/kitFullWrite = true;/.test(hdrUpSrc)
    && /\.kitwriting \.pads, \.kitwriting \.kithead \.bar/.test(html) && /\.kitlocked \.kithead \.bar/.test(html),
    "write lock: only a full upload sets kitFullWrite, and the grid + header bar lock while it is in flight (and with no slot picked)");
  ok(/kitExportZip: "Export"/.test(html) && /kitExportZip: "エクスポート"/.test(html),
    "export rename: the per-slot button reads Export (エクスポート in Japanese)");
  ok(/if \(msg && !confirm\(msg\)\)/.test(html) && /currently contains an instrument sound/.test(html),
    "kit-load prompt: picking a kit slot no longer asks, the instrument prompt remains");
  ok((html.match(/kind !== "box" && !kitDraft\.pads\[/g) || []).length === 2,
    "empty box: the label can be the drag source (pick-up and dragstart drop the !pads guard for kind box; dragstart reads the picked lane)");
  ok(/await kitReadSlotKit\(d\)/.test(html) && /sayK\("kitNeedSlot"\)/.test(html) && /if \(kitDraft\.sent\) sayK\("kitImported"/.test(html),
    "slot read-back / import: the pick reads the slot back, and the import only reports success once written");
}

/* ------------------------------------------- Lowtide 2.8.11: the markers land --- */
async function editorKit2811() {
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));

  /* the scoping bug: the kit-slice helpers lived in the protocol section, where kitDraft/dev/rq
     (declared inside the UI's IIFE) are out of scope — every marker commit threw "kitDraft is not
     defined" and every marker read "dev is not defined", so the markers never landed (2.8.8–2.8.10).
     Two guards: the structural check (the helpers are defined inside the IIFE) and, when acorn is
     installed, a scope walk over the whole script that fails on ANY function referencing a variable
     declared only inside the IIFE. */
  const iifeAt = html.indexOf('if (typeof document !== "undefined") (() => {');
  const pwaAt = html.indexOf("/*PWA*/");
  const sliceHelpers = ["kitSliceSlot", "kitSliceRead", "kitSliceWrite", "kitSliceSyncFromDraft", "kitSliceSyncPads", "kitSliceClearSlot", "kitSliceSlotFor"];
  const proto = html.slice(0, iifeAt);
  ok(iifeAt > 0 && pwaAt > iifeAt
    && sliceHelpers.every((h) => { const i = html.indexOf(`function ${h}(`); return i > iifeAt && i < pwaAt; })
    && ["const kitDraft = ", "let dev = null", "const rq = "].every((d) => { const i = html.indexOf(d); return i > iifeAt && i < pwaAt; })
    && sliceHelpers.every((h) => !new RegExp(`function ${h}\\(`).test(proto)),
    "scope: the kit-slice helpers live inside the UI's IIFE, next to kitDraft/dev/rq (not in the protocol section)");
  let acorn = null;
  try { acorn = cjsRequire("acorn"); } catch { /* optional: the structural check above still runs */ }
  if (acorn) {
    const scriptStart = html.indexOf("<script>\n") + "<script>\n".length;
    const script = html.slice(scriptStart, html.indexOf("</script>", scriptStart));
    const LINE0 = html.slice(0, scriptStart).split("\n").length - 1;   /* file line = acorn line + LINE0 */
    const ast = acorn.parse(script, { ecmaVersion: 2024, locations: true, sourceType: "script" });
    const GLOBALS = new Set(["document", "window", "navigator", "location", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "performance", "fetch", "URL", "Blob", "FileReader", "TextEncoder", "TextDecoder", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "DataView", "ArrayBuffer", "Promise", "JSON", "Math", "Error", "TypeError", "ReferenceError", "RangeError", "Object", "Array", "String", "Number", "Boolean", "Symbol", "Map", "Set", "WeakMap", "Date", "RegExp", "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "alert", "confirm", "indexedDB", "localStorage", "sessionStorage", "crypto", "WebAssembly", "AudioContext", "webkitAudioContext", "history", "screen", "event", "CustomEvent", "Event", "KeyboardEvent", "PointerEvent", "DragEvent", "ClipboardEvent", "File", "FileList", "DataTransfer", "DOMParser", "XMLSerializer", "MutationObserver", "ResizeObserver", "IntersectionObserver", "Worker", "SharedWorker", "BroadcastChannel", "MessageChannel", "Image", "Option", "Proxy", "Reflect", "Generator", "AsyncGenerator", "BigInt", "BigInt64Array", "BigUint64Array", "Atomics", "globalThis", "undefined", "NaN", "Infinity"]);
    const TARGETS = new Set(["kitDraft", "dev", "rq", "kitSlicePending", "kitSliceReadP", "KIT_PAIR", "kitSliceDev", "kitSlotKinds", "t"]);   /* (2.8.12) KIT_PAIR is what the 2.8.11 walk missed (#29): kitSliceSlotFor referenced it from outside the IIFE */
    let guarded = new Set();   /* (2.8.12) names a `typeof` guard on the left of && protects on the right (lockable, editor.html:1422) */
    const scopes = [{ names: new Set(), kind: "top", line: 1 }];
    const problems = [];
    const declare = (name) => { scopes[scopes.length - 1].names.add(name); };
    const declarePattern = (pat) => {
      if (!pat) return;
      if (pat.type === "Identifier") declare(pat.name);
      else if (pat.type === "ObjectPattern") for (const p of pat.properties) declarePattern(p.type === "RestElement" ? p.argument : p.value);
      else if (pat.type === "ArrayPattern") for (const e of pat.elements) if (e) declarePattern(e.type === "RestElement" ? e.argument : e);
      else if (pat.type === "AssignmentPattern") declarePattern(pat.left);
      else if (pat.type === "RestElement") declarePattern(pat.argument);
    };
    /* `let`/`const` are hoisted to their block (TDZ aside): a function defined before the
       declaration still sees it when it runs, so each block's own declarations are registered
       before any of its statements are walked — otherwise every IIFE function defined before
       `let dev` (or `const kitDraft` / `const rq`) would be a false positive. */
    const hoist = (stmts) => {
      for (const st of stmts || []) {
        if (!st) continue;
        if (st.type === "VariableDeclaration") for (const d of st.declarations) declarePattern(d.id);
        else if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) declare(st.id.name);
      }
    };
    const visible = (name) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].names.has(name)) return true; return GLOBALS.has(name); };
    const currentFn = () => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].fnName) return scopes[i].fnName + "@" + (scopes[i].line + LINE0); return "(top)"; };
    const walk = (node, parent) => {
      if (!node || typeof node.type !== "string") return;
      switch (node.type) {
        case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": {
          if (node.type === "FunctionDeclaration" && node.id) declare(node.id.name);
          const fnName = node.id ? node.id.name : "(anon)";
          scopes.push({ names: new Set(), kind: "fn", line: node.loc.start.line, fnName });
          if (node.id && node.type !== "FunctionDeclaration") scopes[scopes.length - 1].names.add(node.id.name);
          /* (2.8.12) parameter default values are expressions too: walk them, so a default that
             reaches for an IIFE-only variable is caught (the walk missed `dev` in lockable's default
             at editor.html:1422 until now) */
          const walkDefaults = (pat) => {
            if (!pat) return;
            if (pat.type === "AssignmentPattern") { walk(pat.right, node); walkDefaults(pat.left); }
            else if (pat.type === "ObjectPattern") for (const pr of pat.properties) walkDefaults(pr.type === "RestElement" ? pr.argument : pr.value);
            else if (pat.type === "ArrayPattern") for (const e of pat.elements) if (e) walkDefaults(e.type === "RestElement" ? e.argument : e);
            else if (pat.type === "RestElement") walkDefaults(pat.argument);
          };
          for (const p of node.params) { declarePattern(p); walkDefaults(p); }
          walk(node.body, node);
          scopes.pop();
          return;
        }
        case "Program": {
          hoist(node.body);
          for (const st of node.body) walk(st, node);
          return;
        }
        case "BlockStatement": {
          scopes.push({ names: new Set(), kind: "block", line: node.loc.start.line });
          hoist(node.body);
          for (const st of node.body) walk(st, node);
          scopes.pop();
          return;
        }
        case "VariableDeclaration": {
          for (const d of node.declarations) { declarePattern(d.id); if (d.init) walk(d.init, node); }
          return;
        }
        case "CatchClause": {
          scopes.push({ names: new Set(), kind: "catch", line: node.loc.start.line });
          if (node.param) declarePattern(node.param);
          walk(node.body, node);
          scopes.pop();
          return;
        }
        case "ForStatement": case "ForInStatement": case "ForOfStatement": {
          scopes.push({ names: new Set(), kind: "for", line: node.loc.start.line });
          for (const k of Object.keys(node)) { if (k === "type" || k === "loc" || k === "start" || k === "end") continue; const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, node)); else walk(v, node); }
          scopes.pop();
          return;
        }
        case "ConditionalExpression": {
          /* (2.8.12) the consequent only runs when the test is truthy: a `typeof x !== "undefined"`
             conjunct in the test means x is declared there (lockable's `... ? dev.info.pe0 : 63`,
             editor.html:1422) */
          const guardedHere = new Set();
          const findNeqTypeof = (n) => {
            if (!n || typeof n.type !== "string") return;
            if (n.type === "BinaryExpression" && (n.operator === "!==" || n.operator === "!=")
              && n.left && n.left.type === "UnaryExpression" && n.left.operator === "typeof"
              && n.left.argument && n.left.argument.type === "Identifier") guardedHere.add(n.left.argument.name);
            else if (n.type === "LogicalExpression" && n.operator === "&&") { findNeqTypeof(n.left); findNeqTypeof(n.right); }
          };
          findNeqTypeof(node.test);
          walk(node.test, node);
          if (guardedHere.size) {
            const prev = guarded;
            guarded = new Set([...prev, ...guardedHere]);
            walk(node.consequent, node);
            guarded = prev;
          } else walk(node.consequent, node);
          walk(node.alternate, node);
          return;
        }
        case "Identifier": {
          const isPropKey = parent && ((parent.type === "MemberExpression" && parent.property === node && !parent.computed)
            || ((parent.type === "Property" || parent.type === "PropertyDefinition") && parent.key === node && !parent.computed && parent.value !== node)
            || (parent.type === "ObjectPattern" && parent.key === node));
          const isDecl = parent && ((parent.type === "VariableDeclarator" && parent.id === node)
            || (parent.type === "FunctionDeclaration" && parent.id === node) || (parent.type === "FunctionExpression" && parent.id === node));
          const isTypeof = parent && parent.type === "UnaryExpression" && parent.operator === "typeof";   /* (2.8.12) `typeof x` never throws on an undeclared name: the deliberate guard in lockable (editor.html:1422) is safe by construction */
          if (!isPropKey && !isDecl && !isTypeof && !guarded.has(node.name) && TARGETS.has(node.name) && !visible(node.name)) {
            problems.push({ name: node.name, line: node.loc.start.line + LINE0, fn: currentFn() });
          }
          return;
        }
        default: {
          if (node.type === "LogicalExpression" && node.operator === "&&") {
            /* (2.8.12) a `typeof x` guard on the left of && protects the right: `typeof dev !==
               "undefined" && dev && dev.info` never evaluates `dev` when it is undeclared, so the
               bare references on the right are safe (lockable, editor.html:1422) */
            const guardedHere = new Set();
            const findTypeof = (n) => {
              if (!n || typeof n.type !== "string") return;
              if (n.type === "UnaryExpression" && n.operator === "typeof" && n.argument && n.argument.type === "Identifier") guardedHere.add(n.argument.name);
              for (const k of Object.keys(n)) {
                if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
                const v = n[k];
                if (Array.isArray(v)) v.forEach(findTypeof);
                else findTypeof(v);
              }
            };
            findTypeof(node.left);
            walk(node.left, node);
            if (guardedHere.size) {
              const prev = guarded;
              guarded = new Set([...prev, ...guardedHere]);
              walk(node.right, node);
              guarded = prev;
            } else walk(node.right, node);
            return;
          }
          for (const k of Object.keys(node)) {
            if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach((c) => walk(c, node));
            else walk(v, node);
          }
          return;
        }
      }
    };
    walk(ast, null);
    ok(problems.length === 0,
      `scope walk: no function references a variable declared only inside the IIFE (${problems.length} found${problems.length ? ": " + problems.slice(0, 5).map((p) => `${p.name}@${p.line} in ${p.fn}`).join(", ") : ""})`);
  } else {
    console.log("scope walk skipped: acorn is not installed (npm install in web/)");
  }

  /* v18: an entry with start > 0 and end == 0 is a slice to the sample end, not "no slice" */
  E.kitSliceDev.fill(0);
  E.kitSlicePutEntry(2, 3, 1000, 0, 0, 0);
  const e18 = E.kitSliceEntry(2, 3);
  ok(e18 && e18.start === 1000 && e18.end === 0, "v18: an entry with start > 0 and end == 0 is a slice to the sample end (not null)");
  E.kitSliceDev.fill(0);
  ok(E.kitSliceEntry(2, 3) === null, "v18: only an all-zero entry is no slice");

  /* rc-3 deferral: a marker commit refused while the song plays is deferred, not dropped; and a
     kit that never landed defers the same way. The next marker change retries the deferred commit. */
  const commitSrc3 = html.slice(html.indexOf("async function kitSliceCommit"), html.indexOf("function kitSliceZoom"));
  const reported = [], saidC = [];
  let syncFails = true;
  const stopErr = () => { const e = new Error("stop the song first"); e.code = "bkStop"; return e; };
  const pollStarts = [];
  const commitBox3 = { console, dev: {}, kitDraft: { slot: 2, sent: false },
    kitWriteNow: async () => { /* the write fails: sent stays false */ },
    kitSliceSyncFromDraft: async () => { if (syncFails) throw stopErr(); },
    report: () => {}, sayK: (k) => { saidC.push(k); }, bkReport: (e) => { reported.push(e.code); }, kitSlicePending: false,
    setInterval: (fn, ms) => { pollStarts.push(ms); return pollStarts.length; }, clearInterval: () => {} };
  const K3 = vm.runInNewContext(commitSrc3 + `\n;({ kitSliceCommit })`, commitBox3);
  ok((await K3.kitSliceCommit()) === "deferred" && saidC.join() === "kitSliceWriteFail" && commitBox3.kitSlicePending === true,
    "rc-3 deferral: a kit that never landed still fails loudly — and the marker write is pending, not dropped");
  commitBox3.kitDraft.sent = true;
  ok((await K3.kitSliceCommit()) === "deferred" && saidC.includes("kitSliceStop") && !reported.length
    && commitBox3.kitSlicePending === true && pollStarts.join() === "1000",
    "rc-3 deferral: a commit refused while the song plays is deferred (pending set, the marker stop message shown, the transport poll started)");
  syncFails = false;
  ok((await K3.kitSliceCommit()) === "ok" && commitBox3.kitSlicePending === false && reported.length === 0,
    "rc-3 deferral: the next marker change retries the deferred commit and clears it once it lands");

  /* the kit write's tail flushes a pending marker write once the kit lands — and not when it fails */
  const modeSrcW = html.slice(html.indexOf("const kitDraft = "), html.indexOf("let kitUi = null;"));
  const writeSrcW = html.slice(html.indexOf("async function kitWriteNow()"), html.indexOf("function kitWriteSoon"));
  const commits = [];
  const writeBox = { console, setTimeout, clearTimeout, t: (k) => k, kitUi: null, dev: {},
    kitUploadPads: async () => true, kitSliceCommit: async () => { commits.push(1); },
    kitSlicePending: true, renderKits: () => {} };
  const W = vm.runInNewContext(modeSrcW + "\n" + writeSrcW + `\n;({ kitDraft, kitWriteNow })`, writeBox);
  W.kitDraft.slot = 2; W.kitDraft.pads[0] = { s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0 }; W.kitDraft.sent = false;
  await W.kitWriteNow();
  ok(W.kitDraft.sent === true && commits.length === 1 && writeBox.kitSlicePending === false,
    "rc-3 deferral: once the kit lands, the pending marker write is flushed from the kit write's tail");
  writeBox.kitUploadPads = async () => false; writeBox.kitSlicePending = true; commits.length = 0;
  W.kitDraft.sent = false;
  await W.kitWriteNow();
  ok(W.kitDraft.sent === false && commits.length === 0 && writeBox.kitSlicePending === true,
    "rc-3 deferral: a kit write that fails leaves the pending marker write pending");

  /* #20/#22: the slider's change handler cancels the settle timer, writes now, drains any queued
     write, then previews — so the preview is the new pitch/gain, not the old one or nothing */
  ok(/inp\.addEventListener\("change", async \(\) => \{/.test(html)
    && /if \(kitWriteTimer\) \{ clearTimeout\(kitWriteTimer\); kitWriteTimer = null; \}\s*await kitWriteNow\(\);\s*await kitWriteDrain\(\);\s*kitStartLane\(l\);/.test(html),
    "#20/#22: the slider's change handler cancels the settle timer, writes now, drains any queued write, then previews");
  const drainSrc = html.slice(html.indexOf("async function kitWriteDrain"), html.indexOf("async function kitEraseSlot"));
  const drainBox = { console, setTimeout, clearTimeout, kitWriteBusy: true, kitWritePending: true };
  const D = vm.runInNewContext(drainSrc + `\n;({ kitWriteDrain })`, drainBox);
  const t0 = Date.now();
  setTimeout(() => { drainBox.kitWriteBusy = false; drainBox.kitWritePending = false; }, 120);
  await D.kitWriteDrain();
  ok(Date.now() - t0 >= 100 && Date.now() - t0 < 2000, "slider preview: the drain waits until no kit write is running or queued");
  drainBox.kitWriteBusy = true;
  const t1 = Date.now();
  await D.kitWriteDrain(200);
  ok(Date.now() - t1 >= 150 && Date.now() - t1 < 2000, "slider preview: the drain gives up after its timeout instead of waiting forever");

  /* #20/#22: stopping a lane that is not playing sends no KITS_STOP; a playing lane still stops */
  const playSrc2 = html.slice(html.indexOf("function kitTogglePlay"), html.indexOf("function kitDrawWave"));
  const stops2 = [], notesOff2 = [];
  const playBox2 = { console, setTimeout, clearTimeout, t: (k) => k, kitUi: null,
    kitDraft: { name: "", slot: 2, pads: Array(16).fill(null), sel: -1, sent: true }, kitPlaying: new Map(),
    kitSliceRange: E.kitSliceRange, kitRate: E.kitRate, drumPadsHearNote: () => -1, DRUM_LANES: E.DRUM_LANES, SMP: E.SMP,
    lvNoteOn: () => {}, lvNoteOff: (tok) => { notesOff2.push(tok); },
    kitsStopSend: async (l) => { stops2.push(l); } };
  const P2 = vm.runInNewContext(playSrc2 + `\n;({ kitDraft, kitTogglePlay, kitStartLane, kitStopLane, kitPlaying })`, playBox2);
  P2.kitDraft.pads[0] = { s: s(2205), fname: "k.wav", tune: 0, gain: 0, len: 0 };
  P2.kitTogglePlay(0);
  ok(stops2.length === 0 && P2.kitPlaying.has(0), "#20/#22: starting a lane that is not playing sends no KITS_STOP (only a sounding lane is stopped)");
  await sleep(250);
  ok(stops2.includes(0) && !P2.kitPlaying.has(0), "#20/#22: the stop timer still stops a playing lane");

  /* #18: picking a slot that holds an instrument warns about the instrument (native confirm, OK
     continues) instead of asking to load a kit that is not there */
  const modeSrc18 = html.slice(html.indexOf("const kitDraft = "), html.indexOf("let kitUi = null;"));
  const pickSrc18 = html.slice(html.indexOf("async function kitPickSlot"), html.indexOf("/* (2.8.9) the draft kit as a v2 ZIP"));
  const hdrSrc18 = html.slice(html.indexOf("/* a slot's header:"), html.indexOf("/* (2.8.9) what each USR slot holds"));
  const instBuilt = E.buildSlot("INST", [{ s: s(8000), root: 60, lo: 0, hi: 127 }]);
  const instRaw = new Uint8Array(E.SMP.DATA_OFF + instBuilt.data.length);
  instRaw.set(instBuilt.hdr, 0); instRaw.set(instBuilt.data, E.SMP.DATA_OFF);
  const emptyRaw18 = new Uint8Array(E.SMP.HDR_LEN);
  const confirms18 = [];
  const rbBox18 = { console, TextEncoder, TextDecoder, dev: { info: { proto: 18 } }, tab: "kits", SMP: E.SMP, DRUM_LANES: E.DRUM_LANES,
    imaDecode: E.imaDecode, kitSliceEntry: E.kitSliceEntry, kitSliceLoaded: false,
    kitSliceRead: async () => { E.kitSliceDev.fill(0); },
    bkReadSlot: async (k) => (k === 2 ? instRaw : emptyRaw18),
    bkReadRange: async (id) => (id === 34 ? instRaw.subarray(0, 480) : emptyRaw18.subarray(0, 480)),
    req: E.req, rq: async () => {}, report: () => {},
    confirm: (m) => { confirms18.push(m); return true; }, t: (k) => k,
    kitWriteNow: async () => {}, renderKits: () => {}, setTimeout, clearTimeout };
  const RB18 = vm.runInNewContext(modeSrc18 + "\n" + pickSrc18 + "\n" + hdrSrc18 + `\n;({ kitDraft, kitsModeUpdate, kitsStopSend, kitPickSlot })`, rbBox18);
  await RB18.kitPickSlot(2);
  ok(confirms18.length === 1 && confirms18[0] === "USR3 currently contains an instrument sound. Selecting this slot will overwrite it. Export it first if you want to save it."
    && RB18.kitDraft.slot === 2 && RB18.kitDraft.pads.every((p) => !p),
    "#18: picking a slot that holds an instrument warns about the instrument (native confirm, OK continues)");

  /* #27: a too-long sample is rejected before its box is populated — the box stays untouched, and
     a sample that fits is assigned and written as before */
  const addSrc = html.slice(html.indexOf("async function kitAddFiles"), html.indexOf("async function kitOpenZip"));
  const modeSrc27 = html.slice(html.indexOf("const kitDraft = "), html.indexOf("let kitUi = null;"));
  const said27 = [], writes27 = [];
  const addBox = { console, TextEncoder, TextDecoder, SMP: E.SMP, DRUM_LANES: E.DRUM_LANES,
    imaEncode: E.imaEncode, kitBytes: E.kitBytes, kitPlace: E.kitPlace,
    decodeFile: async (f) => ({ s: f._s }),
    sayK: (k, arg) => { said27.push([k, arg]); }, kitWriteNow: async () => { writes27.push(1); }, renderKits: () => {} };
  const A27 = vm.runInNewContext(modeSrc27 + "\n" + addSrc + `\n;({ kitDraft, kitAddFiles })`, addBox);
  A27.kitDraft.slot = 0;
  await A27.kitAddFiles([{ name: "huge.wav", _s: s(173460) }]);
  ok(A27.kitDraft.pads.every((p) => !p) && said27.some(([k, a]) => k === "smpFail" && a === "too long: 86730 B (max 81408 B)") && writes27.length === 0,
    "#27: a too-long sample is rejected before its box is populated (no pad, no write)");
  await A27.kitAddFiles([{ name: "kick.wav", _s: s(8000) }]);
  ok(A27.kitDraft.pads[0] && A27.kitDraft.pads[0].fname === "kick.wav" && writes27.length === 1,
    "#27: a sample that fits is assigned and written as before");
  A27.kitDraft.pads = Array(16).fill(null);   /* a fresh draft for the cumulative case */
  await A27.kitAddFiles([{ name: "big.wav", _s: s(160000) }]);
  await A27.kitAddFiles([{ name: "snare.wav", _s: s(4000) }]);
  ok(A27.kitDraft.pads[2] === null && said27.some(([k, a]) => k === "smpFail" && a === "too long: 82000 B (max 81408 B)"),
    "#27: a sample that would push the slot over the limit is rejected too (the kit stays as it was)");

  /* the mirror: a read sets loaded only once it succeeds; two reads at once share one LIST+GET;
     a failed read leaves the mirror unloaded, so the next read retries instead of trusting it */
  const readSrc = html.slice(html.indexOf("async function kitSliceRead"), html.indexOf("async function kitSliceWrite"));
  const { m: mR, rq: rqR, done: doneR } = attachMock();
  let lists = 0;
  const rqCount = async (r, o) => { if (r[0] === E.CMD.BK_LIST) lists++; return rqR(r, o); };
  const readBox = { console, dev: { info: { proto: 18 } }, rq: rqCount, req: E.req, parse: E.parse, CMD: E.CMD,
    bkMutex: E.bkMutex, bkReadObj: E.bkReadObj, KITSLICE: { OBJ: 13, LEN: 768, ENTRY: 12 }, kitSliceDev: E.kitSliceDev,
    kitSliceLoaded: false, kitSliceReadP: null, setTimeout, clearTimeout };
  const R = vm.runInNewContext(readSrc + `\n;({ kitSliceRead })`, readBox);
  E.kitSliceDev.fill(0);
  await R.kitSliceRead();
  ok(readBox.kitSliceLoaded === true && E.kitSliceDev.every((b) => b === 0),
    "mirror: a read with no slices on the FM-1 loads an empty mirror and marks it loaded");
  const sliceBytes = new Uint8Array(768);
  new DataView(sliceBytes.buffer).setUint32((2 * 16 + 0) * 12, 2000, true);
  new DataView(sliceBytes.buffer).setUint32((2 * 16 + 0) * 12 + 4, 4000, true);
  await E.bkWriteObj(rqR, 13, sliceBytes);
  E.kitSliceDev.fill(0); readBox.kitSliceLoaded = false; lists = 0;
  const p1 = R.kitSliceRead(), p2 = R.kitSliceRead();
  await Promise.all([p1, p2]);
  ok(readBox.kitSliceLoaded === true && E.kitSliceEntry(2, 0).start === 2000 && E.kitSliceEntry(2, 0).end === 4000 && lists === 1,
    "mirror: two reads at once share one LIST+GET, and the mirror holds the FM-1's slices");
  const failBox = { console, dev: { info: { proto: 18 } }, rq: async () => { throw new Error("link down"); },
    req: E.req, parse: E.parse, CMD: E.CMD, bkMutex: E.bkMutex, bkReadObj: E.bkReadObj, KITSLICE: { OBJ: 13, LEN: 768, ENTRY: 12 },
    kitSliceDev: E.kitSliceDev, kitSliceLoaded: false, kitSliceReadP: null, setTimeout, clearTimeout };
  const RF = vm.runInNewContext(readSrc + `\n;({ kitSliceRead })`, failBox);
  await RF.kitSliceRead();
  ok(failBox.kitSliceLoaded === false, "mirror: a failed read leaves the mirror unloaded, so the next read retries instead of trusting it");
  doneR();

  /* a marker write on a device too old for markers throws instead of silently dropping them;
     with no device it still returns false, and on a current device the mirror is written */
  const writeSliceSrc = html.slice(html.indexOf("async function kitSliceWrite"), html.indexOf("function kitSliceSyncFromDraft"));
  const { m: mW, rq: rqW, done: doneW } = attachMock();
  const wsBox = { console, dev: { info: { proto: 15 } }, rq: rqW, req: E.req, parse: E.parse, CMD: E.CMD,
    bkWriteObj: E.bkWriteObj, KITSLICE: { OBJ: 13, LEN: 768, ENTRY: 12 }, kitSliceDev: E.kitSliceDev, t: (k) => k };
  const WS = vm.runInNewContext(writeSliceSrc + `\n;({ kitSliceWrite })`, wsBox);
  let threw = "";
  try { await WS.kitSliceWrite(); } catch (e) { threw = e.message; }
  ok(threw === "kitSliceOld", "marker write: on a device too old for markers (proto 15) the write throws instead of silently dropping them");
  wsBox.dev = null;
  ok((await WS.kitSliceWrite()) === false, "marker write: with no device it still returns false (nothing to write)");
  wsBox.dev = { info: { proto: 18 } };
  E.kitSliceDev.fill(0);
  E.kitSlicePutEntry(2, 0, 2000, 4000, 0, 0);
  ok((await WS.kitSliceWrite()) === true, "marker write: on a current device the mirror is written");
  const LW = E.parse[E.CMD.BK_LIST](await rqW(E.req.bkList(), { timeout: 5000, retries: 0 }));
  ok(LW.items.some((x) => x.id === 13 && x.len === 768), "marker write: object 13 is listed after the write");
  doneW();

  /* read-back: a read refused with rc 5 asks for a fresh list, then retries once and returns the
     bytes; any other refusal still throws at once, with no list */
  const rangeSrc = html.slice(html.indexOf("async function bkReadRange"), html.indexOf("async function bkReadSlot"));
  const u35 = (n) => [0, 1, 2, 3, 4].map((i) => (n >> (7 * i)) & 0x7F);
  const getReply = (id, rc, off, data) => new Uint8Array([id, rc, ...u35(off), data.length & 0x7F, (data.length >> 7) & 0x7F, ...E.pack7(data)]);
  const data16 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const calls = [];
  let gets = 0;
  const fakeRq = async (r) => {
    calls.push(r[0]);
    if (r[0] === E.CMD.BK_LIST) return new Uint8Array(0);   /* the LIST's reply is not read: only that it was asked for */
    gets++;
    if (gets === 1) return getReply(0, 5, 0, new Uint8Array(0));   /* the FM-1 refuses a read until a fresh list */
    return getReply(0, 0, 0, data16);
  };
  const rangeBox = { console, parse: E.parse, CMD: E.CMD, req: E.req, rq: fakeRq, bkMutex: E.bkMutex };
  const G = vm.runInNewContext(rangeSrc + `\n;({ bkReadRange })`, rangeBox);
  const got = await G.bkReadRange(0, 0, 16);
  ok(eq([...got], [...data16]) && calls.join() === [E.CMD.BK_GET, E.CMD.BK_LIST, E.CMD.BK_GET].join(),
    "read-back: a read refused with rc 5 asks for a fresh list, then retries once and returns the bytes");
  const calls1 = [];
  const fakeRq1 = async (r) => { calls1.push(r[0]); return getReply(0, 1, 0, new Uint8Array(0)); };
  const rangeBox1 = { console, parse: E.parse, CMD: E.CMD, req: E.req, rq: fakeRq1, bkMutex: E.bkMutex };
  const G1 = vm.runInNewContext(rangeSrc + `\n;({ bkReadRange })`, rangeBox1);
  let rc1 = "";
  try { await G1.bkReadRange(0, 0, 16); } catch (e) { rc1 = e.message; }
  ok(rc1 === "bk get rc 1" && !calls1.includes(E.CMD.BK_LIST), "read-back: any other refusal (rc 1) still throws at once, with no list");

  /* a slot with a kit reads back whole (header, then its data); a slot the FM-1 does not list
     (rc 1) reads as empty instead of throwing */
  const slotSrc = html.slice(html.indexOf("async function bkReadSlot"), html.indexOf("function parseSlotHeader"));
  const kitSig = s(8000), kitAdpcm = E.imaEncode(kitSig).data;
  const built = E.buildSlot("TESTKIT", [{ s: kitSig, adpcm: kitAdpcm, root: 36, lo: 36, hi: 36 }]);
  const kitRaw = new Uint8Array(E.SMP.DATA_OFF + built.data.length);
  kitRaw.set(built.hdr, 0); kitRaw.set(built.data, E.SMP.DATA_OFF);
  const slotRq = async (r) => {
    const a = r[1], id = a[0], off = a.slice(1, 6).reduce((n, b, i) => n | (b << (7 * i)), 0), n = a[6] | (a[7] << 7);
    return getReply(id, 0, off, kitRaw.subarray(off, off + n));
  };
  const slotBox = { console, parse: E.parse, CMD: E.CMD, req: E.req, rq: slotRq, SMP: E.SMP, bkMutex: E.bkMutex };
  const SL = vm.runInNewContext(rangeSrc + "\n" + slotSrc + `\n;({ bkReadSlot })`, slotBox);
  const backRaw = await SL.bkReadSlot(0);
  ok(backRaw.length === kitRaw.length && eq([...backRaw.subarray(0, 4)], [0x46, 0x53, 0x4D, 0x50]),
    "read-back: a slot with a kit reads back whole (header, then its data)");
  const emptyRq = async (r) => (r[0] === E.CMD.BK_LIST ? new Uint8Array(0) : getReply(32, 1, 0, new Uint8Array(0)));
  const slotBox2 = { console, parse: E.parse, CMD: E.CMD, req: E.req, rq: emptyRq, SMP: E.SMP, bkMutex: E.bkMutex };
  const SL2 = vm.runInNewContext(rangeSrc + "\n" + slotSrc + `\n;({ bkReadSlot })`, slotBox2);
  const emptyHead = await SL2.bkReadSlot(0);
  ok(emptyHead.length === E.SMP.HDR_LEN && emptyHead.every((b) => b === 0),
    "read-back: a slot the FM-1 does not list (rc 1) reads as empty instead of throwing");

  /* the pair split: the marker slot follows the upload split (kitRoom), so a lane the upload puts
     in USR4 has its markers in USR4 too */
  const slotForSrc = html.slice(html.indexOf("function kitSliceSlotFor"), html.indexOf("function kitSliceSlot("));   /* (2.8.12) kitSliceSlotFor lives inside the IIFE now, next to kitSliceSlot (#29) */
  const SF = vm.runInNewContext(slotForSrc + `\n;({ kitSliceSlotFor })`, { console, KIT_PAIR: 4, kitSplit: E.kitSplit, kitRoom: () => E.SMP.MAX_DATA - 64 });
  const pairPads = Array(16).fill(null);
  pairPads[0] = { s: s(162600), tune: 0, gain: 0, len: 0 };   /* 81300 bytes: fills one slot, with 44 bytes to spare */
  pairPads[1] = { s: s(200), tune: 0, gain: 0, len: 0 };   /* 100 bytes */
  ok(SF.kitSliceSlotFor(1, 4, pairPads) === 3 && SF.kitSliceSlotFor(0, 4, pairPads) === 2,
    "pair split: the marker slot follows the upload split (kitRoom), so the second lane's markers go to USR4, not USR3");

  /* a mirror entry with end == 0 reads back as a slice to the sample end (v18), not no slice */
  const rawsSrc = html.slice(html.indexOf("function kitPadsFromRaws"), html.indexOf("function kitExport()"));
  const hdrSrc2 = html.slice(html.indexOf("function parseSlotHeader"), html.indexOf("function kitSlotKind("));
  const rawsBox = { console, TextDecoder, kitSliceEntry: E.kitSliceEntry, DRUM_LANES: E.DRUM_LANES, imaDecode: E.imaDecode, SMP: E.SMP };
  const F = vm.runInNewContext(rawsSrc + "\n" + hdrSrc2 + `\n;({ kitPadsFromRaws })`, rawsBox);
  E.kitSliceDev.fill(0);
  E.kitSlicePutEntry(2, 0, 1000, 0, 0, 0);   /* (v18) start 1000, end 0: a slice to the sample end */
  const pads18 = F.kitPadsFromRaws([2], [kitRaw]).pads;
  ok(pads18[0] && pads18[0].slice && pads18[0].slice.start === 1000 && pads18[0].slice.end === 8000,
    "v18: a mirror entry with end == 0 reads back as a slice to the sample end, not no slice");
  E.kitSliceDev.fill(0);
  E.kitSlicePutEntry(2, 0, 2000, 4000, 0, 0);
  const pads18b = F.kitPadsFromRaws([2], [kitRaw]).pads;
  ok(pads18b[0] && pads18b[0].slice && pads18b[0].slice.start === 2000 && pads18b[0].slice.end === 4000,
    "v18: a mirror entry with an explicit end still reads back as written");

  /* disconnect clears the marker mirror, its loaded flag and any pending marker write; a kit
     import whose markers fail does not report success (a refused-while-playing commit defers) */
  const discSrc = html.slice(html.indexOf("function disconnect("), html.indexOf("function onState("));
  ok(/kitSliceLoaded = false;/.test(discSrc) && /kitSliceDev\.fill\(0\)/.test(discSrc) && /kitSlicePending = false;/.test(discSrc),
    "mirror: disconnect clears the marker mirror, its loaded flag and any pending marker write");
  const upSrc = html.slice(html.indexOf("async function kitUploadPads"), html.indexOf("/* read part of a backup object"));
  ok(/if \(e && e\.code === "bkStop"\) \{ kitSlicePending = true; sayK\("kitSliceStop"\); kitSlicePollStart\(\); \}/.test(upSrc)
    && /else \{ report\(e\); done = false; \}/.test(upSrc),
    "kit import: a marker write that fails loses the import's success report (a refused-while-playing commit defers instead, with the marker stop message and the transport poll)");

  /* the protocol doc states the rc-3 rule for object 13, keeps the v18 end == 0 meaning, and
     documents v19 (pred-as-gain) and the header version 2 */
  const protoDoc = readFileSync(join(HERE, "EDITOR_PROTOCOL.md"), "utf8");
  ok(/object 13 answers rc 3\s+while the song plays/i.test(protoDoc) && !/end == 0 is no slice/i.test(protoDoc) && /## v19/.test(protoDoc)
    && /pred-as-gain/i.test(protoDoc) && /header version 2/i.test(protoDoc),
    "protocol doc: object-13 commits answer rc 3 while the song plays; no stale pre-v18 'end == 0 is no slice'; v19 documents pred-as-gain and header version 2");

  /* Lowtide 2.8.12: the 120 ms minimum chop (#9), the kit-name reset on Clear all (#32),
     and the kitSlotKinds cache invalidated on every slot write (#31) */
  ok(E.KIT_MIN_CHOP === 2646, "2.8.12 #9: KIT_MIN_CHOP is 2646 samples — 120 ms at 22050 Hz");
  const setSrc12 = html.slice(html.indexOf("function kitSliceSet"), html.indexOf("async function kitSliceCommit"));
  const setBox12 = { console, kitDraft: { pads: [{ s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0 }, { s: s(1000), fname: "short.wav", tune: 0, gain: 0, len: 0 }] }, kitLen: E.kitLen, kitSliceRender: () => {}, KIT_MIN_CHOP: E.KIT_MIN_CHOP, kitMinChop: E.kitMinChop };
  const ST12 = vm.runInNewContext(setSrc12 + `\n;({ kitSliceSet })`, setBox12);
  ST12.kitSliceSet(0, 100, 200);
  ok(setBox12.kitDraft.pads[0].slice.end === 100 + E.KIT_MIN_CHOP && setBox12.kitDraft.pads[0].slice.start === 100,
    "2.8.12 #9: a sub-120 ms chop is widened to the 120 ms minimum (end pushed out)");
  ST12.kitSliceSet(0, 7800, 8000);
  ok(setBox12.kitDraft.pads[0].slice.start === 8000 - E.KIT_MIN_CHOP && setBox12.kitDraft.pads[0].slice.end === 8000,
    "2.8.12 #9: a chop ending at the sample end is widened by pulling the start back (end never passes the sample)");
  ST12.kitSliceSet(1, 100, 900);
  ok(!setBox12.kitDraft.pads[1].slice,
    "2.8.12 #9: a sample shorter than 120 ms keeps the whole sample (no slice)");
  ok(/rng\.end - kitMinChop\(p\)/.test(html) && /rng\.start \+ kitMinChop\(p\)/.test(html),
    "2.8.12 #9: the drag handler clamps the moving marker 120 ms from the other one (2.8.13: the clamp is rate-aware, in stored samples)");
  ok(/kitDraft\.name = ""/.test(html.slice(html.indexOf('u.clear = el("button"'), html.indexOf('u.exp = el("button"'))),
    "2.8.12 #32: Clear all resets the kit name as well as the pads and the selection");
  const eraseSrc12 = html.slice(html.indexOf("async function kitEraseSlot"), html.indexOf("async function kitPickSlot"));
  const smpUpSrc12 = html.slice(html.indexOf("async function smpUpload"), html.indexOf("async function smpErase"));
  ok(/kitSlotKinds = null;/.test(upSrc) && /kitSlotKinds = null;/.test(eraseSrc12) && /kitSlotKinds = null;/.test(smpUpSrc12),
    "2.8.12 #31: the kitSlotKinds cache is invalidated after a kit upload, an instrument upload and an erase");
}

async function editor25() {
  const { ROLL, SMF, ARR } = E, R = ROLL.rest, len = 16;
  const apply = (st, m) => { const o = st.map((x) => ({ ...x })); for (const [i, v] of m) o[i] = v; return o; };
  const shape = (st) => st.slice(0, len).map((x) => (x.time === 0 && x.n ? "N" + x.notes.slice(0, x.n).join("+") : x.time === 1 ? "-" : ".")).join(" ");
  /* the piano roll */
  let st = Array.from({ length: 64 }, R);
  ok(ROLL.steps(1 / 4, 2) === 4 && ROLL.steps(1, 2) === 16 && ROLL.steps(1 / 16, 7) === 1 && ROLL.steps(1 / 2, 4) === 6 && ROLL.steps(1 / 8, 8) === 1,
    "roll: a note length in steps (1/4 at 1/16 = 4, 1BAR = 1, at least 1, triplets)");
  st = apply(st, ROLL.place(st, len, 0, 60, 4));
  st = apply(st, ROLL.place(st, len, 0, 64, 1));            /* same step: into the chord, its length kept */
  st = apply(st, ROLL.place(st, len, 8, 67, 2));
  ok(shape(st) === "N60+64 - - - . . . . N67 - . . . . . ." && ROLL.chords(st, len).map((c) => `${c.at}:${c.dur}`).join() === "0:4,8:2",
    "roll: place a note, a chord on its first step, a second note");
  const full = apply(st, new Map([[0, { ...st[0], n: 4, notes: [60, 64, 67, 71] }]]));
  ok(ROLL.place(full, len, 0, 72, 1).size === 0 && ROLL.place(st, len, 0, 60, 1).size === 0, "roll: a fifth note, or the same note twice: nothing changes");
  let s2 = apply(st, ROLL.place(st, len, 2, 50, 4));         /* inside the held chord: it ends there */
  ok(shape(s2) === "N60+64 - N50 - - - . . N67 - . . . . . ." && ROLL.owner(s2, 5) === 2 && ROLL.owner(s2, 7) === -1, "roll: a note inside a held chord ends it; owner()");
  s2 = apply(st, ROLL.place(st, len, 6, 48, 6));             /* stops before the next chord */
  ok(shape(s2) === "N60+64 - - - . . N48 - N67 - . . . . . .", "roll: a long note stops before the next chord");
  s2 = apply(st, ROLL.resize(st, len, 0, 7));
  ok(shape(s2) === "N60+64 - - - - - - . N67 - . . . . . ." && shape(apply(st, ROLL.resize(st, len, 0, 12))) === "N60+64 - - - - - - - N67 - . . . . . ."
    && shape(apply(st, ROLL.resize(st, len, 0, 1))) === "N60+64 . . . . . . . N67 - . . . . . ." && shape(apply(st, ROLL.resize(st, len, 8, 99))) === "N60+64 - - - . . . . N67 - - - - - - -",
    "roll: drag a length: longer (ties, up to the next chord or the end), shorter (rests)");
  s2 = apply(st, ROLL.remove(st, len, 0, 64));
  const s3 = apply(s2, ROLL.remove(s2, len, 0, 60));
  ok(shape(s2) === "N60 - - - . . . . N67 - . . . . . ." && shape(s3) === ". . . . . . . . N67 - . . . . . ." && ROLL.remove(st, len, 0, 99).size === 0,
    "roll: remove a chord's note; the last one leaves rests (ties too)");
  /* MIDI files */
  const steps = apply(st, new Map([[8, { ...st[8], flags: 1 }], [0, { ...st[0], vel: 80, lvl: 1 << 2 }]]));
  const notes = SMF.fromSteps(steps, len, 2);
  ok(notes.length === 3 && notes[0].t === 0 && notes[0].dur === 4 * 24 - 1 && notes[0].vel === 80 && notes[1].vel === 42 && notes[2].t === 8 * 24 && notes[2].vel === 127,
    "midi: a track's steps -> notes (ties as lengths; velocity, level, accent as the device plays them)");
  const file = SMF.write(notes, { bpm: 97, ch: 2, name: "Lowtide track 3" });
  const back = SMF.read(file);
  ok(back.format === 0 && back.ppq === 96 && back.bpm === 97 && back.tracks.length === 1 && back.tracks[0].name === "Lowtide track 3"
    && js(back.tracks[0].notes.map((n) => [n.t, n.dur, n.key, n.vel, n.ch])) === js(notes.slice().sort((a, b) => a.t - b.t || a.key - b.key).map((n) => [n.t, n.dur, n.key, n.vel, 2])),
    "midi: write -> read: the same notes, tempo, name, channel");
  const plan = SMF.toSteps(back.tracks[0].notes, back.ppq, 2, 64);
  ok(shape(plan.steps) === shape(steps) && plan.len === 10 && plan.steps[0].vel === 80 && plan.steps[8].vel === 127 && js(Object.values(plan.report)) === js([3, 10, 0, 0, 0, 0, 0]),
    "midi: read back onto the grid: the same chords and lengths, a clean report");
  const py2 = py(`import struct,sys
def vlq(n):
    b=[n&127]; n>>=7
    while n: b.insert(0,128|(n&127)); n>>=7
    return bytes(b)
ev=[(0,b'\\xff\\x51\\x03\\x07\\xa1\\x20')]
def note(t,d,k,v,ch=0): ev.extend([(t,bytes([0x90|ch,k,v])),(t+d,bytes([0x80|ch,k,0]))])
for k in (60,62,64,65,67): note(0,240,k,30+k)          # 5 notes at once: one is cut
note(480,96,72,100); note(520,96,72,90)                 # 520: off the grid (a quarter step = 30) -> the same step, merged
note(960,960,74,100); note(1200,96,76,100)              # cut short by the next chord
note(480*33,96,40,100)                                  # past 64 steps at 1/16
ev.sort(key=lambda e:e[0]); t=0; tr=b''
for at,b in ev: tr+=vlq(at-t)+b; t=at
tr+=b'\\x00\\xff\\x2f\\x00'
hd=b'MThd'+struct.pack('>IHHH',6,1,2,480)
t1=b'MTrk'+struct.pack('>I',4)+b'\\x00\\xff\\x2f\\x00'
sys.stdout.buffer.write(hd+t1+b'MTrk'+struct.pack('>I',len(tr))+tr)`);
  const f2 = SMF.read(new Uint8Array(py2)), p2 = SMF.toSteps(f2.tracks[1].notes, f2.ppq, 2, 64);
  ok(f2.format === 1 && f2.bpm === 120 && f2.tracks.length === 2 && !f2.tracks[0].notes.length && f2.tracks[1].notes.length === 10
    && js(p2.report) === js({ notes: 10, steps: 11, moved: 1, chordCut: 1, overlap: 1, dropped: 1, merged: 1 })
    && p2.steps[0].n === 4 && js(p2.steps[0].notes) === js([62, 64, 65, 67]) && p2.steps[0].vel === 97 && shape(p2.steps).startsWith("N62+64+65+67 - . . N72 . . . N74 - N76 . ."),
    "midi: a format 1 file from Python (480 ppq): 4 notes a step (loudest), merged, moved, cut short, past the end");
  let caught = "";
  try { SMF.read(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])); } catch (e) { caught = e.message; }
  ok(caught === "not a MIDI file" && (() => { try { SMF.read(file.slice(0, 20)); return true; } catch (e) { return false; } })(), "midi: a non-MIDI file is refused; a cut one reads what is there");
  const ds = Array.from({ length: 64 }, E.emptyDrum);
  ds[0].on = 1 | (1 << 4); ds[0].lvl[4] = 1; ds[4].on = 1 << 2; ds[4].lvl[2] = 3; ds[6].on = 1 << 15; ds[6].lvl[15] = 2;
  const dn = SMF.fromDrums(ds, 16, 2), dp = SMF.toSteps(SMF.read(SMF.write(dn, { ch: 9 })).tracks[0].notes, 96, 2, 64, true);
  ok(dn.map((n) => n.key).join() === "36,42,38,56" && dp.len === 7 && [0, 4, 6].every((i) => dp.dsteps[i].on === ds[i].on && js(dp.dsteps[i].lvl) === js(ds[i].lvl))
    && SMF.laneOf(36) === 0 && SMF.laneOf(35) === 1 && SMF.laneOf(57) === 11 && SMF.laneOf(20) === 0 && SMF.laneOf(90) === 13,
    "midi: the drum track: lanes as GM notes and back, levels ghost..hard kept (drums.c LANE_OF_GM)");
  const dc = readFileSync(join(HERE, "../firmware/src/drums.c"), "utf8");
  const tbl = (/LANE_OF_GM\[81 - 35 \+ 1\] = \{([^}]*)\}/.exec(dc) || [, ""])[1].replace(/\/\*[^*]*\*\//g, "").split(",").map((x) => x.trim());
  /* (2.8.6) single-note toms: the firmware's LANE_OF_GM had DRUM_LANE_NONE for the tom's other notes
     (indices 6, 10, 12, 15 = notes 41, 45, 47, 50); the MIDI-file import keeps the old multi-note
     toms. (2.8.7) the filled default grid: the firmware now plays those notes as KICK 2 (1), SHAKER
     (13), CONGA (14) and COWBELL (15), so the two tables differ only there — and the firmware table
     has no DRUM_LANE_NONE left. The divergence is deliberate: import keeps the old GM meaning. */
  ok(tbl.length === 47 && tbl.filter((v) => v === "DRUM_LANE_NONE").length === 0
    && [6, 10, 12, 15].every((idx, k) => +tbl[idx] === [1, 13, 14, 15][k])
    && tbl.every((v, i) => [6, 10, 12, 15].includes(i) ? true : +v === SMF.LANE_OF_GM[i]),
    "midi: LANE_OF_GM == drums.c except the four filled-default notes (KICK 2 / SHAKER / CONGA / COWBELL in the firmware, toms on import)");
  /* the song order */
  const sb = E.mockSettings(), song = ARR.decode(sb);
  ok(ARR.ok(sb) && sb.length === 88 && !song.loop && js(song.entries) === js([0, 1, 2, 3].map((scene) => ({ scene, bars: 4 }))), "song: the settings' song order (PER3, arr_defaults)");
  const rows = ARR.group([{ scene: 0, bars: 4 }, { scene: 0, bars: 4 }, { scene: 1, bars: 8 }, { scene: 0, bars: 4 }]);
  ok(js(rows) === js([{ scene: 0, bars: 4, times: 2 }, { scene: 1, bars: 8, times: 1 }, { scene: 0, bars: 4, times: 1 }]) && ARR.expand(rows).length === 4,
    "song: rows (a section n times) <-> entries");
  const enc = ARR.encode(sb, { loop: true, entries: ARR.expand(rows) });
  ok(js(ARR.decode(enc)) === js({ loop: true, entries: ARR.expand(rows) }) && enc.subarray(0, 48).every((v, i) => v === sb[i]) && enc.subarray(84).every((v, i) => v === sb[84 + i]),
    "song: encode keeps the rest of the settings");
  ok(!ARR.valid({ entries: [] }) && !ARR.valid({ entries: Array(17).fill({ scene: 0, bars: 1 }) }) && !ARR.valid({ entries: [{ scene: 4, bars: 1 }] })
    && !ARR.valid({ entries: [{ scene: 0, bars: 65 }] }) && ARR.valid({ entries: Array(16).fill({ scene: 3, bars: 64 }) }), "song: valid == arranger.h arr_valid (1..16 entries, A..D, 1..64 bars)");
  const pc = readFileSync(join(HERE, "../firmware/src/project.c"), "utf8"), ah = readFileSync(join(HERE, "../firmware/src/arranger.h"), "utf8");
  const pt = (/typedef struct \{([^}]*)\} persist_t;/.exec(pc) || [, ""])[1];
  ok(/PERSIST_MAGIC 0x50455233u/.test(pc) && /arr_config_t arrangement;/.test(pt) && /ARR_STEPS 16u/.test(ah)
    && /if \(\(song\.playing \|\| transport_req\) && memcmp\(&p\.arrangement, &arrangement, sizeof arrangement\)\)\s*return 3;/.test(pc),
    "song: PER3, persist_t has the arrangement, 16 steps; a new order refused while playing (project.c)");
  /* read and send it through the backup objects, as the Song page does */
  const { m, rq, done } = attachMock({});
  const get1 = async () => { const L = E.parse[E.CMD.BK_LIST](await rq(E.req.bkList())); const it = L.items.find((x) => x.id === 1);
    return E.parse[E.CMD.BK_GET](await rq(E.req.bkGet(1, 0, it.len))).data; };
  const put1 = async (d) => {
    await rq(E.req.bkBegin(1, d.length, E.crc32(d)));
    await rq(E.req.bkData(1, 0, d));
    return E.parse[E.CMD.BK_PUT](await rq(E.req.bkCommit(1))).rc;
  };
  const cur = await get1();
  const mine = ARR.encode(cur, { loop: true, entries: [{ scene: 2, bars: 8 }, { scene: 3, bars: 2 }] });
  const rc1 = await put1(mine), now = await get1();
  const bad = ARR.encode(cur, { loop: false, entries: [{ scene: 0, bars: 4 }] }); bad[ARR.OFF + 5] = 0;
  const rc2 = await put1(bad);
  m.sim.play(true);
  const rc3 = await put1(ARR.encode(cur, { loop: false, entries: [{ scene: 1, bars: 1 }] }));
  const rc4 = await put1(now);                                 /* the same order while playing: fine */
  m.sim.play(false);
  ok(ARR.ok(cur) && rc1 === 0 && js(ARR.decode(now)) === js({ loop: true, entries: [{ scene: 2, bars: 8 }, { scene: 3, bars: 2 }] }) && rc2 === 2 && rc3 === 3 && rc4 === 0
    && js(ARR.decode(await get1())) === js(ARR.decode(now)), "song: mock: read, send (rc 0), a bad one (rc 2), a new one while playing (rc 3)");
  done();
  /* the page */
  ok(/id="lenval" type="number" min="1" max="64"/.test(html) && /if \(!s && id === pSlen\(\)\) lenChanged\(\);/.test(html) && /if \(!\$\("roll"\)\.hidden\) renderRoll\(\);/.test(html),
    "editor: the LEN control (1..64), the grid and roll redrawn when LEN changes");
}

/* ------------------------------------- SLOOP 2.5: the DRUM SYNTH page (v10) --- */
async function editorDsyn() {
  const { DSYN } = E, C = E.CMD;
  const dsc = readFileSync(join(HERE, "../firmware/src/drum_synth.c"), "utf8");
  const st = (/typedef struct \{([\s\S]*?)\} dsnd_t;/.exec(dsc) || [, ""])[1].replace(/\/\*[\s\S]*?\*\//g, "");
  const fields = [...st.matchAll(/(?:u?int8_t)\s+([^;]+);/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()));
  ok(js(fields) === js(DSYN.FIELDS) && DSYN.SIZE === 22, "dsyn: the 22 fields in dsnd_t's order (drum_synth.c)");
  const ln = ((/DS_LANE_NOTE\[DS_LANES\] = \{([^}]*)\}/.exec(dsc) || [, ""])[1]).split(",").map((x) => +x.trim());
  ok(js(ln) === js(DSYN.LANE_NOTE) && DSYN.LANES_N.length === 16, "dsyn: the lanes' notes == DS_LANE_NOTE");
  ok(/sizeof\(dsu_bank_t\) == 1464u/.test(dsc) && /DSU_MAGIC 0x31555344u/.test(dsc) && DSYN.BANK_SIZE === 1464, "dsyn: backup object 9 == dsu_bank_t (1464 bytes, DSU1)");
  /* the mock's factory kits == the firmware's (when built) */
  const raw = E.b64dec(E.DSYN_MOCK_KITS);
  let hdr = null;
  try { hdr = readFileSync(join(HERE, "../build/gen/felucca_drumkits.h"), "utf8"); } catch (e) { /* (not built) */ }
  if (hdr) {
    const kits = [...hdr.matchAll(/\{"([^"]*)", "[^"]*", (0x[0-9A-Fa-f]+|\d+), \{([\s\S]*?)\}\},/g)];
    const bytes = kits.flatMap((k) => [Number(k[2]), ...[...k[3].matchAll(/\{([^{}]*)\},/g)].flatMap((r) => r[1].split(",").map((x) => +x & 255))]);
    ok(kits.length === 32 && js(kits.map((k) => k[1])) === js(E.DSYN_MOCK_NAMES) && js(Array.from(raw)) === js(bytes),
      "dsyn: the mock's 32 kits == build/gen/felucca_drumkits.h");
  }
  /* viewing never changes a value: decode / encode give every factory sound back */
  let same = true;
  for (let i = 0; i < 32 * 16; i++) {
    const at = Math.floor(i / 16) * 353 + 1 + (i % 16) * 22, b = raw.slice(at, at + 22);
    same = same && js(Array.from(DSYN.encode(DSYN.decode(b)))) === js(Array.from(b));
  }
  const wild = DSYN.decode(DSYN.encode({ wave: 9, noise: 7, clap: 1, pitch: 300, fine: 40, bend: 200, btime: 999, hold: 999, decay: -5,
    tlev: 500, t2: 999, t2lev: 999, click: 999, nlev: 999, nhold: 999, ndec: 999, fmode: 7, fall: 1, res: 99, fcut: 999, fenv: -999, hpf: 999, chip: 999, drive: 999, level: 999 }));
  ok(same && wild.wave === 5 && wild.noise === 4 && wild.clap === 1 && wild.pitch === 127 && wild.fine === 15 && wild.bend === 96 && wild.decay === 0
    && wild.fmode === 3 && wild.res === 31 && wild.fenv === -128 && wild.level === 255 && wild.drive === 127,
    "dsyn: decode / encode: all 512 factory sounds unchanged; out-of-range values into the firmware's ranges");
  ok(Math.round(DSYN.hz(69)) === 440 && Math.round(DSYN.decayMs(127)) === 4000 && Math.round(DSYN.cutHz(0)) === 30 && DSYN.db(132) === 1,
    "dsyn: the units (Hz, ms, cutoff, dB) as tools/gen_tables.py");
  /* files and the backup object */
  const kit = { name: "MY 808", crush: 0x21, src: 0, sounds: Array.from({ length: 16 }, (_, l) => raw.slice(1 + l * 22, 23 + l * 22)) };
  const back = DSYN.fromFile(JSON.parse(JSON.stringify(DSYN.toFile(kit))));
  let bad = "";
  try { DSYN.fromFile({ format: "sloop-drumsynth", sounds: [[1, 2]] }); } catch (e) { bad = e.message; }
  const bank = DSYN.bankEncode([kit, kit, kit, kit]), dec = DSYN.bankDecode(bank);
  ok(back.name === "MY 808" && back.crush === 0x21 && js(back.sounds.map((x) => Array.from(x))) === js(kit.sounds.map((x) => Array.from(x))) && /not a Lowtide/.test(bad)
    && bank.length === 1464 && dec && dec[3].name === "MY 808" && dec[2].crush === 0x21 && js(Array.from(dec[1].sounds[15])) === js(Array.from(kit.sounds[15]))
    && DSYN.bankDecode(bank.slice(1)) === null, "dsyn: a kit file and the backup object, there and back; a wrong file refused");
  /* the device (mock): LIST / GET / PUT / STORE / PLAY */
  const { m, rq, done } = attachMock({});
  let L = E.parse[C.DSYN_LIST](await rq(E.req.dsynList()));
  const g0 = E.parse[C.DSYN_GET](await rq(E.req.dsynGet(DSYN.USER)));
  const f5 = E.parse[C.DSYN_GET](await rq(E.req.dsynGet(5)));
  ok(L.factory === 32 && L.user === 4 && L.stored && L.names[0] === "808" && L.kits.map((k) => k.name).join() === "808,909,TRAP,TECHNO"
    && g0.rc === 0 && g0.name === "808" && g0.src === 0 && js(g0.sounds.map((x) => Array.from(x))) === js(kit.sounds.map((x) => Array.from(x)))
    && f5.rc === 0 && f5.name === "TRAP", "dsyn: LIST (32 + 4, stored), GET SYN1 = the 808, GET a factory kit");
  const o = DSYN.decode(g0.sounds[0]); o.decay = 20; o.wave = 4;
  const p1 = E.parse[C.DSYN_PUT](await rq(E.req.dsynSound(0, 0, DSYN.encode(o))));
  const p2 = E.parse[C.DSYN_PUT](await rq(E.req.dsynHead(0, "BOOM", 0x10, 0)));
  const p3 = E.parse[C.DSYN_PUT](await rq(E.req.dsynCopy(3, 25)));
  const pl = E.parse[C.DSYN_PLAY](await rq(E.req.dsynPlay(0, 0, 100)));
  const g1 = E.parse[C.DSYN_GET](await rq(E.req.dsynGet(DSYN.USER)));
  L = E.parse[C.DSYN_LIST](await rq(E.req.dsynList()));
  ok(p1.rc === 0 && p2.rc === 0 && p3.rc === 0 && pl.rc === 0 && g1.name === "BOOM" && g1.crush === 0x10 && DSYN.decode(g1.sounds[0]).decay === 20
    && DSYN.decode(g1.sounds[0]).wave === 4 && L.kits[3].name === "CHIP" && !L.stored && m.state.dsynPlayed.length === 1 && m.state.dsynPlayed[0].sound[7] === 20,
    "dsyn: PUT a sound, the name and crush, a factory copy; PLAY hears the edit; LIST: not stored");
  m.sim.play(true);
  const s3 = E.parse[C.DSYN_STORE](await rq(E.req.dsynStore()));
  m.sim.play(false);
  const s0 = E.parse[C.DSYN_STORE](await rq(E.req.dsynStore()));
  L = E.parse[C.DSYN_LIST](await rq(E.req.dsynList()));
  const bp = E.parse[C.DSYN_PLAY](await rq(E.req.dsynPlay(0, 16)));
  ok(s3.rc === 3 && s0.rc === 0 && L.stored && bp.rc === 1, "dsyn: STORE while playing: rc 3; stopped: stored; PLAY of no lane: rc 1");
  /* a backup carries the kits, a restore puts them back */
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const A = await E.backupCapture(rq, info);
  await rq(E.req.dsynCopy(0, 1));
  await E.backupRestore(rq, JSON.parse(JSON.stringify(A)));
  const g2 = E.parse[C.DSYN_GET](await rq(E.req.dsynGet(DSYN.USER)));
  ok(A.objects.some((x) => x.id === 9 && x.len === 1464) && g2.name === "BOOM", "dsyn: a backup holds the SYN kits (object 9); a restore puts them back");
  /* 2.6: the MIDI LEARN map, object 10, in a backup only while something is learned */
  const ml = new Uint8Array(72);                            /* (2.6: the map, then GLO > MIDI: 2, 11, 8, drums 10, BEND) */
  ml[0] = 21, ml[1] = (1 << 1) | (34 << 1);                 /* CC 21 -> track 1 (bits 7..8), code 34 (bits 9..15) */
  ml[64] = 2, ml[65] = 11, ml[66] = 8, ml[67] = 10, ml[68] = 2;
  m.state.ml = ml.slice();
  const M = await E.backupCapture(rq, info);
  m.state.ml = new Uint8Array(64);
  const N = await E.backupCapture(rq, info);
  m.state.ml = new Uint8Array(72);
  await E.backupRestore(rq, JSON.parse(JSON.stringify(M)));
  ok(M.objects.some((x) => x.id === 10 && x.len === 72) && !N.objects.some((x) => x.id === 10) && m.state.ml[0] === 21 && m.state.ml[1] === ml[1]
    && m.state.ml[65] === 11, "midi learn: a backup holds the learned CCs and GLO > MIDI (object 10, only when not the default); a restore puts them back");
  {   /* 2.6: a 2.6 backup without object 10 (the defaults then): restored as the defaults, not left as they are now */
    const N1 = JSON.parse(JSON.stringify(N));
    N1.firmware = "LOWTIDE 2.6";
    await E.backupRestore(rq, N1);
    ok(m.state.ml.length === 72 && m.state.ml.slice(0, 64).every((x) => x === 0) && m.state.ml[64] === 1 && m.state.ml[65] === 2
      && m.state.ml[66] === 3 && m.state.ml[67] === 10 && m.state.ml[68] === 2,
      "backup: a 2.6 one without object 10 resets MIDI LEARN and GLO > MIDI to the defaults (they were then)");
  }
  {   /* 2.6: a backup with projects newer than the device reads: refused before anything is written */
    const f6 = Uint8Array.of(0x36, 0x4E, 0x55, 0x46, 1), f5 = Uint8Array.of(0x35, 0x4E, 0x55, 0x46);
    ok(E.bkProjFormat(f6) === 6 && E.bkProjFormat(f5) === 5 && E.bkProjFormat(Uint8Array.of(1, 2, 3, 4)) === 0
      && E.bkDevFormat({ pcount: 71 }) === 6 && E.bkDevFormat({ pcount: 61 }) === 5 && E.bkDevFormat({ pcount: 53 }) === 4
      && E.bkFwAtLeast("LOWTIDE 2.6", [2, 5, 1]) && E.bkFwAtLeast("LOWTIDE 2.6", [2, 5, 1]) && !E.bkFwAtLeast("LOWTIDE 2.5", [2, 5, 1])
      && !E.bkFwAtLeast("FELUCCA LOWTIDE 2.0 (MOCK)", [2, 5, 1]),
      "backup: the project format of an object, what a device reads (INFO), the firmware compared");
    let err = null, writes = 0;
    const rq25 = async (r, o) => {                    /* a 2.5 FM-1 (INFO: 61 parameters); anything else counts as a write */
      if (r[0] === C.INFO) return { info25: { ...E.parse[C.INFO](await rq(r, o)), pcount: 61, pe0: 53 } };
      writes++;
      return rq(r, o);
    };
    const B6 = JSON.parse(JSON.stringify(M));
    const p2 = B6.objects.find((x) => x.id === 2);
    if (p2) {
      const d = E.b64dec(p2.data);
      d.set([0x36, 0x4E, 0x55, 0x46], 0);
      p2.data = E.b64enc(d);
      p2.crc = E.crc32(d) >>> 0;
    }
    const parse0 = E.parse[C.INFO];
    E.parse[C.INFO] = (a) => (a && a.info25 ? a.info25 : parse0(a));
    try { await E.backupRestore(rq25, B6); } catch (e) { err = e; }
    E.parse[C.INFO] = parse0;
    ok(!!p2 && err && err.code === "bkNewer" && writes === 0, "backup: 2.6 projects into a 2.5 FM-1: refused (bkNewer), nothing written");
  }
  done();
  const old = attachMock({ v9: true });
  const oi = E.parse[C.INFO](await old.rq(E.req.info()));
  const B = await E.backupCapture(old.rq, oi);
  ok(oi.proto === 9 && !B.objects.some((x) => x.id === 9), "dsyn: a v9 device says 9 (the page says it needs 2.5), no object 9");
  await E.backupRestore(old.rq, JSON.parse(JSON.stringify(A)));    /* a 2.5 backup into a v9 device: object 9 skipped */
  ok(true, "dsyn: a 2.5 backup restores into a v9 device (object 9 skipped)");
  await E.backupRestore(old.rq, JSON.parse(JSON.stringify(M)));    /* a 2.6 backup with CCs learned into an older device */
  ok(true, "midi learn: a 2.6 backup with learned CCs restores into an older device (object 10 skipped)");
  old.done();
}

/* ------------------------------------------- 2.5: a DX7 cartridge into the bank --- */
async function editorCart() {
  const C = E.CMD, F = E.FM6;
  const fc = readFileSync(join(HERE, "../firmware/src/fm6_bank.c"), "utf8");
  const voices = Array.from({ length: 32 }, (_, k) => { const v = F.factory(k % F.FACTORY_PK.length); F.setName(v, `CART ${k + 1}`); return v; });
  const pb = F.parseSysex(F.bankSysex(voices));
  const slots = new Array(27).fill(null); slots[0] = F.pack(voices[0]); slots[26] = F.pack(voices[5]);
  const o = F.bankObj(slots), u = F.bankUnobj(o);
  const bad = Uint8Array.from(o); bad[16 + 3] = 200;
  const wrong = Uint8Array.from(o); wrong[6] = 32;
  ok(/sizeof\(fm6_bank_t\) == 3472u/.test(fc) && /FM6_BANK_MAGIC 0x42364D46u/.test(fc) && o.length === 3472
    && js(Array.from(o.subarray(0, 12))) === js([0x46, 0x4D, 0x36, 0x42, 1, 0, 27, 0, 1, 0, 0, 4])
    && u[0] && u[26] && !u[1] && js(Array.from(u[26])) === js(Array.from(slots[26])) && F.bankUnobj(new Uint8Array(0)).every((x) => x === null)
    && F.bankUnobj(bad) === null && F.bankUnobj(wrong) === null && F.bankUnobj(o.subarray(1)) === null,
  "cart: the bank object == fm6_bank_t (3472 bytes, FM6B, 27 slots); a bad one is refused");
  const { m, rq, sent, done } = attachMock({});
  const mine = F.factory(3); F.setName(mine, "MY BELL");
  await rq(E.req.fm6Put(F.TARGET.BANK, 4, F.pack(mine)), { timeout: 3000 });     /* B5 */
  await rq(E.req.fm6Put(F.TARGET.BANK, 1, F.pack(mine)), { timeout: 3000 });     /* B2 */
  const packs = [0, 1, 2].map((k) => F.pack(pb.voices[k].v));
  m.sim.play(true);
  const r3 = await E.fm6CartWrite(rq, packs);
  let L = E.parse[C.FM6_LIST](await rq(E.req.fm6List()));
  ok(r3 === 3 && L.slots[8 + 1].name.trim() === "MY BELL" && L.slots[8].name.trim() === "MY TINES", "cart: while the song plays: rc 3, the bank unchanged");
  m.sim.play(false);
  const p0 = sent[C.BK_PUT] || 0, r0 = await E.fm6CartWrite(rq, packs), puts = sent[C.BK_PUT] - p0;
  L = E.parse[C.FM6_LIST](await rq(E.req.fm6List()));
  const g = E.parse[C.FM6_GET](await rq(E.req.fm6Get(F.TARGET.BANK, 2)));
  ok(r0 === 0 && L.slots.slice(8, 11).map((x) => x.name.trim()).join() === "CART 1,CART 2,CART 3" && L.slots[8 + 4].name.trim() === "MY BELL"
    && !L.slots[8 + 3].used && js(Array.from(F.unpack(g.packed))) === js(Array.from(pb.voices[2].v)) && puts === 2 + Math.ceil(3472 / 256),
  "cart: 3 voices -> B1-B3 in one write (B2 replaced, B5 kept, B4 still empty)");
  const all = pb.voices.slice(0, 27).map((x) => F.pack(x.v));
  const rAll = await E.fm6CartWrite(rq, all);
  L = E.parse[C.FM6_LIST](await rq(E.req.fm6List()));
  let tooMany = "";
  try { await E.fm6CartWrite(rq, pb.voices.map((x) => F.pack(x.v))); } catch (e) { tooMany = e.message; }
  ok(rAll === 0 && L.slots.slice(8).every((x, k) => x.used && x.name.trim() === `CART ${k + 1}`) && /32 voices/.test(tooMany),
    "cart: the first 27 of a 32-voice cartridge fill B1-B27; 32 at once refused");
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const A = await E.backupCapture(rq, info);
  ok(A.objects.some((x) => x.id === 8 && x.len === 3472), "cart: a backup holds the filled bank (object 8)");
  /* 2.5: also as user presets, named after the voices, each on its bank slot */
  const fake = { total: 32, slots: Array.from({ length: 32 }, (_, s) => ({ slot: s, used: s === 0 || s === 2 ? 1 : 0, name: s ? "X" : "MINE" })) };
  ok(js(E.fm6CartSlots(fake, 3, "free")) === js([1, 3, 4]) && js(E.fm6CartSlots(fake, 3, 29)) === js([29, 30, 31])
    && E.fm6CartSlots(fake, 3, 30) === null && E.fm6CartSlots(fake, 31, "free") === null && E.fm6CartSlots(fake, 30, "free").length === 30,
  "cart: preset slots: the first free ones, or from a slot; null when they do not fit");
  const base = Array.from({ length: info.pcount }, (_, i) => i % 3);
  const pr = E.fm6CartPreset(info, base, 8, 4, "  BRASS 1   "), pr0 = E.fm6CartPreset(info, base, 8, 0, "");
  ok(pr.engine === 9 && pr.name === "BRASS 1" && pr.p.length === 71 && pr.p[info.pe0 + 7] === 12 && pr.p[info.pe0 + 6] === base[info.pe0 + 6]
    && pr.p[0] === base[0] && pr0.name === "FM6 B1" && pr0.p[info.pe0 + 7] === 8, "cart: a preset = FM6, the voice's name, PTCH = its B slot, the rest as given");
  const ul = await E.bank.list(rq);
  const free = E.fm6CartSlots(ul, 3, "free");
  const ups = free.map((s, i) => ({ slot: s, pt: E.fm6CartPreset(info, base, 8, i, pb.voices[i].name) }));
  m.sim.play(true);
  const u3 = await E.fm6CartPresets(rq, ups);
  m.sim.play(false);
  const u0 = await E.fm6CartPresets(rq, ups);
  const ul2 = await E.bank.list(rq), g2 = await E.bank.get(rq, info, free[2]);
  ok(u3 === 3 && u0 === 0 && free.every((s, i) => ul2.slots[s].used && ul2.slots[s].name === `CART ${i + 1}` && ul2.slots[s].engine === 9)
    && g2.engine === 9 && g2.p[info.pe0 + 7] === 10 && ul.slots.filter((x) => x.used).every((x) => ul2.slots[x.slot].name === x.name),
  "cart: user presets CART 1-3 in the free slots (FM6, PTCH B1-B3), the others kept; refused while the song plays");
  done();
  const old = attachMock({ v8: true });
  ok(await old.rq(E.req.info()) && (await E.fm6CartWrite(old.rq, packs)) === "old", "cart: a device before v9: 'old' (the page says it needs 2.4)");
  old.done();
}

/* ------------------------------------------------- editor tabs and strings --- */
/* ------------------------------------- SLOOP 2.7: the LIVE page (v12, LIVE = 77) --- */
async function editorLivePage() {
  const C = E.CMD, L = E.LIVE;
  const lv = readFileSync(join(HERE, "../firmware/src/editor_live.c"), "utf8"), ec = readFileSync(join(HERE, "../firmware/src/editor.c"), "utf8");
  const pu = readFileSync(join(HERE, "../firmware/src/punch.c"), "utf8"), sq = readFileSync(join(HERE, "../firmware/src/seq.c"), "utf8");
  const fxNames = [...((/PUNCH_NAME\[PUNCH_NFX\] = \{([^}]*)\}/.exec(pu) || [])[1] || "").matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  const ly = ((/enum \{ LY_PLAY, ([^}]*)\}/.exec(sq) || [])[1] || "").split(",").map((x) => x.trim());
  ok(C.LIVE === 77 && /#define ED_LIVE 77u/.test(lv) && /#include "editor_live.c"/.test(ec) && /case ED_LIVE:/.test(ec)
    && js(fxNames) === js(L.FX_NAMES) && ly.indexOf("LY_SCALE") + 1 === L.LY_KEY && ly.indexOf("LY_MIX") + 1 === L.LY_MIX
    && ly.indexOf("LY_SONG") + 1 === L.LY_SONG, "live page: LIVE = 77 (editor_live.c), the 27 effects == punch.c, the layers == seq.c");
  const { m, rq, done } = attachMock({ watchMs: 1000 });
  const live = async (op, ...a) => E.parse[C.LIVE](await rq(E.req.live(op, ...a)));
  const info = E.parse[C.INFO](await rq(E.req.info()));
  let s = await live(L.STATE);
  const raw = await rq(E.req.live(L.STATE));
  ok(info.proto === 19 && raw.length === 50 && s.pro && s.master === -1 && s.dtw.length === 16 && s.dtw[0].tune === 0 && !s.playing && s.ready === 1 && s.tracks.length === 4 && s.bpm === m.state.g[0] && s.sec === -1 && s.fx === -1,
    "live page: the state (50 bytes as editor_live.c): stopped, 4 tracks, BPM, no section, no effect, A stored, the master on its knob, the pads as the kit");
  s = await live(L.PLAY, 1);
  ok(s.playing && m.state.playing, "live page: PLAY plays");
  await live(L.KEY, L.LY_MIX, L.MUTE + 1, 1); s = await live(L.KEY, L.LY_MIX, L.MUTE + 1, 0);
  const muted = s.mutes === 2;
  await live(L.KEY, L.LY_MIX, L.SOLO + 2, 1); s = await live(L.KEY, L.LY_MIX, L.SOLO + 2, 0);
  ok(muted && s.solo === 4 && m.state.tracks[1].p[40] === 1, "live page: GLO keys: track 2 muted, track 3 soloed");
  s = await live(L.KEY, L.LY_MIX, L.FILL, 1); const held = s.fillNow;
  s = await live(L.KEY, L.LY_MIX, L.FILL, 0);
  ok(held && !s.fillNow, "live page: fill while held");
  s = await live(L.KEY, L.LY_SONG, L.SEC + 1, 1);
  const empty = s.next === -1;
  await live(L.KEY, L.LY_SONG, L.STORE + 1, 1); s = await live(L.KEY, L.LY_SONG, L.STORE + 1, 0);
  const stored = s.sec === 1 && !!m.state.slots[1] && s.ready === 3;
  await live(L.KEY, L.LY_SONG, L.STORE + 1, 1); s = await live(L.STATE);
  const asks = !!m.state.slots[1] && m.state.live.armed === 1;
  s = await live(L.KEY, L.LY_SONG, L.SEC + 1, 1);
  ok(empty && stored && asks && s.next === 1, "live page: an empty section is not played; B stored (again over a used one: asks); B asked for the next bar");
  s = await live(L.FX, 4, 1); const on = s.fx === 4;
  s = await live(L.FX, 4, 0);
  ok(on && s.fx === -1, "live page: a punch-in effect while held");
  await live(L.PLAY, 0);
  s = await live(L.REC); const armed = s.recWait;
  s = await live(L.REC);
  ok(armed && !s.recWait && !s.playing, "live page: stopped; REC arms, again disarms");
  { const sl = m.state.slots.slice(); m.state.slots.fill(null);            /* an empty project: armed, a note: a free take */
    await live(L.REC); [...m.access.outputs.values()][0].send([0x90, 60, 100]);
    const ft = (await live(L.STATE)).freeTake;
    s = await live(L.REC);
    ok(ft && !s.freeTake && s.playing && !s.recWait, "live page: a free take; REC again closes the loop (it plays)");
    await live(L.PLAY, 0); m.state.slots.splice(0, 4, ...sl); m.state.midiIn.length = 0; }
  {   /* (2.7) the page's own: ops 6..12 */
    const lv = (/case 6:[\s\S]*case 12:[\s\S]*?break;/.exec(readFileSync(join(HERE, "../firmware/src/editor_live.c"), "utf8")) || [""])[0];
    ok(L.ROLL === 6 && L.ERASE === 7 && L.PATTERN === 8 && L.CHAIN === 9 && L.THROW === 10 && L.MASTER === 11 && L.DRUM_TW === 12
      && /roll_start/.test(lv) && /erase_now/.test(lv) && /pattern_length/.test(lv) && /chain_sec/.test(lv) && /thr_ed/.test(lv) && /ed_master/.test(lv)
      && /drum_tune/.test(lv), "live page: ops 6..12 == editor_live.c (roll, erase, pattern, chain, throw, master, drum tune / decay)");
    s = await live(L.THROW, 2); const thr = s.throws === 2; await live(L.THROW, 0);
    s = await live(L.MASTER, 63); const mst = s.master === 63; s = await live(L.MASTER, 127);
    const knob = s.master === -1;
    s = await live(L.DRUM_TW, 2, 11, 2);
    ok(thr && mst && knob && s.dtw[2].tune === 3 && s.dtw[2].dec === -2, "live page: THROW, the master (127: the knob again), a pad's TUNE / DECAY in the state");
    await live(L.ROLL, 3, 2, 0, 1); const rolled = m.state.live.rolls.has("3:2"); await live(L.ROLL, 3, 2, 0, 0);
    await live(L.ERASE, 0, 60, 1); const er = m.state.live.erase.has("0:60"); await live(L.ERASE, 0, 60, 0);
    const len = m.state.tracks[0].p[29]; await live(L.PATTERN, 0, 1, 1);
    ok(rolled && !m.state.live.rolls.size && er && !m.state.live.erase.size && m.state.tracks[0].p[29] === Math.min(64, len * 2),
      "live page: ROLL and ERASE while held, the pattern x2");
    await live(L.PATTERN, 0, 1, 0);
  }
  [...m.access.outputs.values()][0].send([0x90, 60, 100]);
  [...m.access.outputs.values()][0].send([0x80, 60, 0]);
  ok(js(m.state.midiIn) === js([[0x90, 60, 100], [0x80, 60, 0]]), "live page: notes go out as plain MIDI (the mock keeps them)");
  done();
  const old = attachMock({ v11: true });
  const oi = E.parse[C.INFO](await old.rq(E.req.info()));
  let none = false;
  try { await old.rq(E.req.live(L.STATE), { timeout: 60, retries: 0, quiet: true }); } catch (e) { none = true; }
  ok(oi.proto === 11 && none, "live page: an FM-1 before v12 has no LIVE (the page says it needs 2.7)");
  old.done();
}

/* ------------------------------------- LIVE pro (editor only): scenes, morph, MIDI learn, the set's WAV --- */
function editorLivePro() {
  const X = E.LVX, ch = readFileSync(join(HERE, "../firmware/src/core.h"), "utf8");
  const ids = {};
  let n = 0;
  for (const nm of (/enum \{\s*\/\* per-track parameters \*\/([^}]*)\}/.exec(ch) || [])[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim()).filter(Boolean)) ids[nm] = n++;
  const want = ["P_PAN", "P_TFLT", "P_REV", "P_DLY", "P_CHOR", "P_DIST", "P_ED_FLT", "P_ED_PIT", "P_ED_SHP", "P_ATK", "P_DEC", "P_SUS", "P_REL", "P_GLIDE",
    "P_LRATE", "P_LD_PIT", "P_LD_FLT", "P_LD_SHP", "P_LD_AMP", "P_ITYPE", "P_IA", "P_IB", "P_IC", "P_IMIX", "P_AMODE", "P_ARATE", "P_AOCT", "P_AGATE",
    "P_ASWING", "P_AHOLD", "P_AORDER"].map((k) => ids[k]);
  const gn = ((/enum \{\s*\/\* global parameters \*\/([^}]*)\}/.exec(ch) || [])[1] || "").replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim()).filter(Boolean);
  const gwant = ["G_FILT", "G_DUST", "G_DUCK", "G_DRREV", "G_DRDLY", "G_DTIME", "G_DFDBK", "G_DCOLOR", "G_DMIX", "G_RSIZE", "G_RDAMP", "G_CRATE", "G_CDEPTH",
    "G_TXSRC", "G_TXLVL", "G_TXTONE", "G_TXMOVE", "G_TXRATE", "G_TXWHEN", "G_TXDUCK", "G_SWING"].map((k) => gn.indexOf(k));
  ok(js(X.TP) === js(want) && ids.P_E0 === X.E0 && js(X.GP) === js(gwant) && gn.indexOf("G_BPM") === X.BPM,
    "live pro: the scenes' parameters == core.h P_* / G_* (P_E0 63)");
  const p = (lvl, pan, flt, ins, e0) => { const a = []; a[39] = pan; a[50] = flt; a[53] = ins; a[63] = e0; return { level: lvl, mute: 0, engine: 0, preset: 0, p: a }; };
  const A = X.capture([p(100, -20, 0, 0, 10), p(80, 0, 0, 0, 0)], { 29: 0, 27: 0, 0: 90 });
  const B = X.capture([p(20, 40, 30, 2, 50), { ...p(80, 0, 0, 0, 0), engine: 3 }], { 29: 40, 27: 60, 0: 120 }, { tempo: true });
  const h = X.mix(A, B, 0.5), z = X.mix(A, B, 0), o = X.mix(A, B, 1);
  ok(h.tracks[0].level === 60 && h.tracks[0].p[39] === 10 && h.tracks[0].p[50] === 15 && h.tracks[0].p[53] === 2 && h.tracks[0].e[0] === 30
    && h.tracks[1].e === null && h.g[29] === 20 && z.tracks[0].p[53] === 0 && o.tracks[0].level === 20 && A.bpm === 90 && B.tempo && !A.tempo,
    "live pro: a morph: glided values half way, the INSERT TYPE switched, the engine values only onto the same engine");
  ok(X.morphMs(4, 120) === 8000 && X.morphMs(0, 120) === 0, "live pro: a morph of 4 bars at 120 BPM lasts 8 s");
  const cc = X.midiKey([0xB2, 20, 127]), on = X.midiKey([0x90, 36, 100]), off = X.midiKey([0x90, 36, 0]), off2 = X.midiKey([0x80, 36, 0]);
  ok(cc.key === "cc:2:20" && cc.value === 1 && on.key === "note:0:36" && on.on && !off.on && off.key === on.key && !off2.on
    && X.midiKey([0xF8]) === null && X.midiKey([0xD0, 10, 0]) === null && X.midiValue(cc, 0, 127) === 127 && X.midiValue({ value: 0.5 }, -64, 63) === 0,
    "live pro: MIDI learn reads CCs and notes (velocity 0 = off), the value over a control's range");
  const w = X.wav([X.pcm16(Float32Array.from([0, 1, -1, 0.5]))], 48000, 2);
  const dv = new DataView(w.buffer);
  ok(String.fromCharCode(...w.slice(0, 4)) === "RIFF" && String.fromCharCode(...w.slice(8, 12)) === "WAVE" && dv.getUint32(24, true) === 48000
    && dv.getUint16(22, true) === 2 && dv.getUint32(40, true) === 8 && dv.getInt16(46, true) === 32767 && dv.getInt16(48, true) === -32768 && w.length === 52,
    "live pro: the set recorded as a 16-bit WAV");
  ok(X.clock(3723000) === "1:02:03" && X.clock(65000) === "1:05", "live pro: the set's clock");
}

/* ------------------------------------- SLOOP 2.7: a song as one file (the LIVE playlist) --- */
async function editorSongFile() {
  const { m, rq, done } = attachMock({ watchMs: 1000 });
  const info = E.parse[E.CMD.INFO](await rq(E.req.info()));
  const st = m.state, js2 = (x) => JSON.stringify(x);
  st.slots[1] = JSON.parse(js2(st.slots[0])); st.slots[1].g[0] = 123;          /* A (seeded) and B (BPM 123) stored */
  st.slots[2] = st.slots[3] = null;
  const O = E.SONGF.ORDER_OFF;
  st.settings[O] = 3; st.settings[O + 4] = 1; st.settings[O + 5] = 8;           /* the order: B for 8 bars first, 3 entries */
  const want = st.settings.slice(O, O + E.SONGF.ORDER_LEN);
  const song = await E.songCapture(rq, info, "My song");
  const ok1 = song.format === "sloop-song" && song.name === "My song" && song.objects.map((o) => o.id).join() === "0,2,3" && !!song.order;
  const keep = js2(st.slots.slice(0, 2));
  st.slots[0] = st.slots[1] = null; st.slots[3] = JSON.parse(keep)[0];          /* another song on the FM-1 (D used) */
  st.settings[O] = 4; st.settings[O + 4] = 3;
  st.settings[20] ^= 7; const col = st.settings[20];
  st.playing = true;
  let stopped = false;
  try { await E.songLoad(rq, song); } catch (e) { stopped = e.code === "bkStop"; }
  st.playing = false;
  await E.songLoad(rq, song);
  ok(ok1 && stopped && js2(st.slots.slice(0, 2)) === keep && st.slots[2] === null && st.slots[3] === null
    && js2(Array.from(st.settings.slice(O, O + E.SONGF.ORDER_LEN))) === js2(Array.from(want)) && st.settings[20] === col,
    "song file: A-D, the loop and the order out; back in (stopped only): the sections, empty ones emptied, the order, the rest of the settings kept");
  let bad = false;
  try { E.songObjects({ ...song, objects: song.objects.map((o, k) => (k ? o : { ...o, crc: o.crc ^ 1 })) }); } catch (e) { bad = e.code === "songBadFile"; }
  ok(bad, "song file: a damaged one is refused before anything is written");
  done();
}

/* ------------------------------------- SLOOP 2.7: your theme (v11, backup object 11) --- */
async function editorTheme() {
  const C = E.CMD, T = E.THEME;
  const gfx = readFileSync(join(HERE, "../firmware/src/gfx.c"), "utf8");
  const rgb = (s) => [...s.matchAll(/RGB\((\d+), (\d+), (\d+)\)/g)].map((m) => [+m[1], +m[2], +m[3]]);
  const pals = [...gfx.matchAll(/\{"(\w+)", \{(RGB[^}]*)\}\}/g)].map((m) => [m[1], rgb(m[2])]);
  const tdef = rgb((/TE_COL_DEF\[4\] = \{([^}]*)\}/.exec(gfx) || [])[1] || "");
  ok(js(pals) === js(T.BUILTIN) && js(tdef) === js(T.TRACKS), "theme: the built-in palettes and track colours == gfx.c (PALETTES, TE_COL_DEF)");
  ok(/#define THEME_MAGIC 0x324D4854u/.test(gfx) && /#define THEME_MAGIC1 0x314D4854u/.test(gfx)
    && /char name\[8\];[^]*uint16_t c\[5\];[^]*uint16_t trk\[4\];[^]*uint16_t bg;[^]*uint16_t hi;[^]*uint16_t rsv;[^]*uint32_t crc;/.test(gfx)
    && /sizeof\(theme_t\) == 40u/.test(gfx) && T.SIZE === 40 && T.MAGIC === 0x324D4854 && T.MAGIC1 === 0x314D4854,
    "theme: the record == gfx.c theme_t (THM2, name 8, 5 + 4 colours, background, accent, CRC: 40 bytes)");
  const mine = { name: "Sunset!", c: [[40, 10, 30], [90, 20, 60], [150, 50, 90], [220, 100, 80], [255, 200, 120]],
    trk: [[255, 0, 128], [0, 255, 255], [255, 255, 0], [120, 60, 255]], bg: [24, 8, 40], hi: [255, 240, 0] };
  const d = T.encode(mine), back = T.decode(d);
  ok(d.length === 40 && d[0] === 0x54 && d[3] === 0x32 && js(back.hi) === js(T.shown(mine.hi)) && String.fromCharCode(...d.slice(4, 11)) === "SUNSET!" && back && back.name === "SUNSET!"
    && js(back.c) === js(mine.c.map(T.shown)) && js(back.trk) === js(mine.trk.map(T.shown)) && js(back.bg) === js(T.shown(mine.bg)) && T.to565([255, 98, 26]) === ((255 >> 3) << 11 | (98 >> 2) << 5 | 26 >> 3),
    "theme: encode / decode (name in capitals, colours and background through RGB565 as the FM-1 shows them)");
  const code = T.code(mine), bad = d.slice();
  bad[14] ^= 1;
  ok(/^SLOOP-THEME-1:[A-Za-z0-9+/=]{56}$/.test(code) && js(T.fromCode("look: " + code + " !")) === js(back) && !T.decode(bad) && !T.fromCode("SLOOP-THEME-1:abc") && !T.fromCode("hello"),
    "theme: the share line (56 characters of base64, found inside a comment); a changed byte or a wrong line refused");
  const dark = { ...mine, c: mine.c.map(() => [40, 40, 40]) };
  const noBg = T.encode({ ...mine, bg: undefined, hi: undefined });   /* (no background: black; no accent: white) */
  const lightOk = { ...mine, bg: [250, 250, 250], c: [...mine.c.slice(0, 4), [20, 20, 60]], hi: [0, 0, 0] };
  ok(T.readable(mine) && T.readable(T.builtin(4)) && T.BUILTIN.every((_, i) => T.readable(T.builtin(i))) && !T.readable(dark)
    && !T.readable({ ...mine, bg: [255, 200, 120] }) && T.readable(lightOk)
    && !T.readable({ ...lightOk, hi: [255, 255, 255] }) && T.problems({ ...lightOk, hi: [255, 255, 255] }).acc && !T.problems({ ...lightOk, hi: [255, 255, 255] }).val
    && noBg[30] === 0 && noBg[31] === 0 && js(T.decode(noBg).bg) === js([0, 0, 0]) && js(T.decode(noBg).hi) === js([255, 255, 255]),
    "theme: readable (gfx.c theme_check): values and accent apart from the background (dark on light too); no background = black, no accent = white");
  /* the first beta's THM1 (36 bytes, CRC at 32): read, with a white accent (black on a light background) */
  const v1 = (t) => { const b = T.encode(t).slice(0, 36), w = new DataView(b.buffer); w.setUint32(0, T.MAGIC1, true); w.setUint32(32, E.crc32(b.subarray(0, 32)), true); return b; };
  const o1 = T.decode(v1(mine)), o2 = T.decode(v1({ ...lightOk, hi: [9, 9, 9] }));
  ok(o1 && js(o1.c) === js(back.c) && js(o1.hi) === js([255, 255, 255]) && o2 && js(o2.hi) === js([0, 0, 0]) && T.readable(o2) && T.encode(o1).length === 40,
    "theme: a first-beta THM1 (36 bytes) decodes: accent white, black on a light background; sent again as THM2");
  /* the light-background helpers: Make it readable, Light <-> dark (the five the other way, white, a black accent), the ramp */
  const wh = { ...T.builtin(0), bg: [255, 255, 255] }, fx = T.fix(wh), inv = T.invert(T.builtin(0)), inv2 = T.invert(inv);
  const rl = T.ramp([56, 200, 92], [255, 255, 255]);
  ok(!T.readable(wh) && T.readable(fx) && js(fx.c.slice(0, 4)) === js(wh.c.slice(0, 4)) && js(T.fix(mine).c) === js(mine.c)
    && T.readable(inv) && js(inv.bg) === js([255, 255, 255]) && js(inv.hi) === js([0, 0, 0]) && js(inv.c[4]) === js(T.BUILTIN[0][1][0])
    && T.readable(inv2) && js(inv2.bg) === js([0, 0, 0]) && js(inv2.c) === js(T.BUILTIN[0][1]) && js(inv2.hi) === js([255, 255, 255])
    && rl[0][1] > rl[2][1] && js(rl[3]) === js([56, 200, 92]) && T.readable({ c: rl, bg: [255, 255, 255], hi: [0, 0, 0] }),
    "theme: Make it readable (only the values and accent move), Light <-> dark and back, the ramp on white (faint first)");
  const r5 = T.ramp([56, 200, 92]);
  ok(r5.length === 5 && js(r5[3]) === js([56, 200, 92]) && r5[0][1] < r5[1][1] && r5[1][1] < r5[2][1] && r5[4][1] > 200 && T.readable({ c: r5 }),
    "theme: five steps from one colour (darkest first, the colour 4th, lighter 5th)");
  /* the device: send, read, refuse, remove; a backup carries it */
  const put = async (rq, bytes) => {
    let r = E.parse[C.BK_PUT](await rq(E.req.bkBegin(11, bytes.length, E.crc32(bytes))));
    if (r.rc) return r.rc;
    if (bytes.length) r = E.parse[C.BK_PUT](await rq(E.req.bkData(11, 0, bytes)));
    if (r.rc) return r.rc;
    return E.parse[C.BK_PUT](await rq(E.req.bkCommit(11))).rc;
  };
  const list = async (rq) => E.parse[C.BK_LIST](await rq(E.req.bkList())).items;
  const { rq, done } = attachMock({});
  const info = E.parse[C.INFO](await rq(E.req.info()));
  const none = !(await list(rq)).some((x) => x.id === 11);
  const sent = await put(rq, d);
  const it = (await list(rq)).find((x) => x.id === 11);
  const g = it && E.parse[C.BK_GET](await rq(E.req.bkGet(11, 0, it.len)));
  ok(info.proto >= 11 && none && sent === 0 && it && it.len === 40 && js(T.decode(Uint8Array.from(g.data))) === js(back),
    "theme: v11 FM-1: no object 11 until a theme is sent; sent, it is listed and reads back");
  const refused = await put(rq, T.encode(dark));
  const A = await E.backupCapture(rq, info);
  const sent1 = await put(rq, v1(mine)), it1 = (await list(rq)).find((x) => x.id === 11);
  await put(rq, d);
  ok(refused === 2 && sent1 === 0 && it1 && it1.len === 40 && A.objects.some((o) => o.id === 11 && o.len === 40), "theme: a dark one refused (2); a backup holds the theme (object 11)");
  const gone = await put(rq, new Uint8Array(0));
  ok(gone === 0 && !(await list(rq)).some((x) => x.id === 11), "theme: removed (0 bytes): no longer listed");
  await E.backupRestore(rq, JSON.parse(JSON.stringify(A)));
  ok((await list(rq)).some((x) => x.id === 11), "theme: restored with the backup");
  done();
  const old = attachMock({ v10: true });
  const oi = E.parse[C.INFO](await old.rq(E.req.info()));
  const r10 = await put(old.rq, d);
  await E.backupRestore(old.rq, JSON.parse(JSON.stringify(A)));      /* a 2.7 backup into a 2.6 FM-1: object 11 skipped */
  const l10 = await list(old.rq);
  ok(oi.proto === 10 && r10 === 5 && !l10.some((x) => x.id === 11), "theme: a v10 FM-1 (2.6): INFO 10, object 11 unknown (5, as editor.c answers), a 2.7 backup restores without it");
  old.done();
  /* the page */
  ok(/data-tab="theme"/.test(html) && /id="thprev"/.test(html) && /const thOk = \(\) => !!dev && !!dev\.info && dev\.info\.proto >= 11;/.test(html),
    "theme: the Theme page (preview, works without an FM-1, Send from protocol 11)");
}

function editorTabs() {
  const tabs = [...html.matchAll(/<button role="tab" data-tab="(\w+)"/g)].map((x) => x[1]);
  const panels = [...html.matchAll(/<section class="panel" id="p-(\w+)" data-tab="(\w+)"/g)].map((x) => [x[1], x[2]]);
  const TABS = JSON.parse((/const TABS = (\[[^\]]*\]);/.exec(html) || [])[1] || "[]");
  ok(tabs.length === 13 && js(tabs) === js(TABS) && js(panels.map((x) => x[1])) === js(TABS) && panels.every(([a, b]) => a === b),
    `editor: ${tabs.length} tabs, one panel each (${tabs.join(" ")})`);
  {   /* (2.8.4) Drum Pads is its own tab under Device (after Settings, before Theme), with its own panel;
       the Kits tab keeps only the kit builder */
    const nav = html.slice(html.indexOf('data-t="navDevice"'), html.indexOf("</nav>"));
    const kitsPanel = html.slice(html.indexOf('id="p-kits"'), html.indexOf('id="p-drumsynth"'));
    ok(/data-tab="projects"[\s\S]*data-tab="settings"[\s\S]*data-tab="drumpads"[\s\S]*data-tab="theme"/.test(nav)
      && /<section class="panel" id="p-drumpads" data-tab="drumpads" data-dev hidden>/.test(html)
      && !kitsPanel.includes("drumpads"),
      "editor: Drum Pads is a tab under Device with its own panel; the Kits tab has no Drum Pads in it");
  }
  ok(/localStorage\.setItem\(TAB_KEY/.test(html) && /try \{ localStorage/.test(html) && /history\.replaceState\([^)]*"#" \+ name\)/.test(html)
    && /addEventListener\("hashchange"/.test(html), "editor: last tab in localStorage (try/catch) and in the URL hash");
  /* every string key in both languages */
  const tb = html.slice(html.indexOf("const TEXT = {"), html.indexOf("\n};", html.indexOf("const TEXT = {")) + 2);
  const TEXT = vm.runInNewContext(tb.replace("const TEXT =", "(") + ")");
  const ja = new Set(Object.keys(TEXT.ja)), en = new Set(Object.keys(TEXT.en));
  const used = new Set([...html.matchAll(/data-t="(\w+)"|\bt\("(\w+)"\)|sayK\("(\w+)"|hint = "(\w+)"/g)].map((x) => x[1] || x[2] || x[3] || x[4]));
  for (const k of ["needDevice", "smpNone", "bankConnect", "bankNone", "selectedTrack", "selectTrack", "drumHelp", "notesHelp", "live", "polling"]) used.add(k);
  const miss = [...used].filter((k) => !ja.has(k) || !en.has(k));
  const odd = [...ja].filter((k) => !en.has(k)).concat([...en].filter((k) => !ja.has(k)));
  ok(!miss.length && !odd.length, `editor: every string in ja and en (${used.size} used${miss.length ? ", missing " + miss : ""}${odd.length ? ", one language only " + odd : ""})`);
  /* the page script parses (the browser's view of it) */
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  let err = null;
  try { new vm.Script(script); } catch (e) { err = e.message; }
  ok(!err, "editor: page script compiles" + (err ? ` (${err})` : ""));
  {   /* 2.4: the device's palette as tokens (:root), used through var(--...); outside them only #000 (text on a colour) */
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>")).replace(/:root\s*\{[^}]*\}/g, "");
    const hex = [...css.matchAll(/#[0-9a-f]{3,6}\b/gi)].map((m) => m[0].toLowerCase()).filter((c) => c !== "#000");
    ok(!hex.length && /--t1: #287cff; --t2: #1ecc70; --t3: #ffc618; --t4: #ff621a;/.test(html),
      "editor: the track colours of the device (gfx.c TE_COL_DEF), colours only as tokens" + (hex.length ? ` (${hex.join(" ")})` : ""));
    const te = readFileSync(join(HERE, "../firmware/src/gfx.c"), "utf8");   /* (2.7: TE_COL_DEF, a theme may change them) */
    ok(/TE_COL_DEF\[4\] = \{RGB\(40, 124, 255\), RGB\(30, 204, 112\), RGB\(255, 198, 24\), RGB\(255, 98, 26\)\}/.test(te),
      "editor: ... the same four as the firmware's TE_COL");
    ok(/LOWTIDE-FONT\*\/url\(data:font\/ttf;base64,[A-Za-z0-9+\/=]{20000,}\)/.test(html), "editor: the device's Terminus font inlined (tools/gen_webfont.py)");
  }
}

/* ------------------------------------------------- editor icons (Fukiai) --- */
function editorIcons() {
  const blk = html.slice(html.indexOf("const GLYPH = {"), html.indexOf("};", html.indexOf("const GLYPH = {")));
  const names = new Set([...blk.matchAll(/(\w+): 0x[0-9A-F]{4}/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/data-ic="(\w+)"|ic: "(\w+)"|: "((?:waveform|function|symbol|control|port|ui|note)_\w+)"/g)].map((m) => m[1] || m[2] || m[3]));
  const missing = [...used].filter((n) => !names.has(n));
  ok(names.size > 0 && !missing.length, `editor: every icon name is in GLYPH (${used.size} used${missing.length ? ", missing " + missing : ""})`);
  const ttf = existsSync(join(HERE, "fukiai.ttf")) && readFileSync(join(HERE, "fukiai.ttf"));
  ok(ttf && ttf.readUInt32BE(0) === 0x00010000 && existsSync(join(HERE, "FUKIAI-LICENSE.txt")) && html.includes('href="FUKIAI-LICENSE.txt"'),
    "editor: fukiai.ttf and FUKIAI-LICENSE.txt next to editor.html");
  ok(/html:not\(\.fk\) \.ic \{ display: none; \}/.test(html) && html.includes('classList.add("fk")'), "editor: icons hidden until the font has loaded");
}

/* ------------------------------------------- user samples: JS == sampleio.py --- */
function wav(sr, ch, bits, float, frames, f) {
  const bps = bits / 8, data = Buffer.alloc(frames * ch * bps);
  for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) {
    const v = f(i, c), o = (i * ch + c) * bps;
    if (float) data.writeFloatLE(v, o);
    else if (bits === 8) data[o] = Math.max(0, Math.min(255, Math.round(v * 127 + 128)));
    else if (bits === 16) data.writeInt16LE(Math.round(v * 32000), o);
    else if (bits === 24) data.writeIntLE(Math.round(v * 8000000), o, 3);
  }
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(float ? 3 : 1, 0); fmt.writeUInt16LE(ch, 2); fmt.writeUInt32LE(sr, 4);
  fmt.writeUInt32LE(sr * ch * bps, 8); fmt.writeUInt16LE(ch * bps, 12); fmt.writeUInt16LE(bits, 14);
  const chunk = (id, b) => Buffer.concat([Buffer.from(id), Buffer.from(Uint32Array.of(b.length).buffer), b]);
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", fmt), chunk("data", data)]);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from(Uint32Array.of(body.length).buffer), body]);
}

function samplesMatch() {
  const dir = mkdtempSync(join(tmpdir(), "felucca-web-"));
  const files = [
    ["tone_A4.wav", wav(44100, 1, 16, false, 9000, (i) => Math.sin(i * 0.0627) * Math.exp(-i / 4000))],
    ["pad C3.wav", wav(48000, 2, 24, false, 7000, (i, c) => Math.sin(i * (c ? 0.031 : 0.0313)) * 0.7)],
    ["Bb2 float.wav", wav(22050, 1, 32, true, 5000, (i) => ((i % 97) / 48 - 1) * 0.5)],
    ["BD1 lofi.wav", wav(96000, 1, 8, false, 12000, (i) => Math.sin(i * 0.01) * Math.exp(-i / 3000))],
  ].map(([n, b]) => { const p = join(dir, n); writeFileSync(p, b); return p; });
  const zones = files.map((p) => {
    const w = E.parseWav(readFileSync(p));
    const s = E.normalize(E.resample(w.x, w.sr, E.SMP.RATE));
    return { s, root: E.rootFromName(p.split("/").pop().replace(/\.[^.]*$/, "")) };
  });
  const js = E.buildSlot("Mix ä 12345", zones);
  execFileSync(PYTHON, [join(HERE, "../tools/fm1_sample_upload.py"), "build", "Mix ä 12345", join(dir, "slot"), ...files]);
  const pyHdr = readFileSync(join(dir, "slot.hdr")), pyData = readFileSync(join(dir, "slot.bin"));
  ok(eq(js.hdr, pyHdr) && eq(js.data, pyData), `samples: editor == sampleio.py (${files.length} WAV formats, ${js.data.length} B)`);
}

/* ------------------------------------------------------- CHOP (pure helpers) --- */
function chopTests() {
  const R = E.SMP.RATE, N = R * 4;
  /* a break: 8 hits (kick-like and snare-like, loud and ghost) on a quiet noise floor */
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = rnd() * 0.002;
  const HITS = [0.10, 0.52, 0.93, 1.31, 1.80, 2.26, 2.70, 3.33].map((t) => Math.round(t * R));
  const AMP = [1, 0.8, 0.25, 0.9, 1, 0.3, 0.85, 0.7];
  HITS.forEach((h, k) => {
    for (let i = 0; i < R * 0.3 && h + i < N; i++) {
      const env = Math.exp(-i / (k % 2 ? 1500 : 3000)) * AMP[k];
      x[h + i] += env * (k % 2 ? rnd() * 0.8 : Math.sin(2 * Math.PI * 60 * i / R) * 0.9 + rnd() * 0.1);
    }
  });
  const nov = E.chopNovelty(x), hits = E.chopHits(x, nov, 5);
  const near = (a, b, ms) => Math.abs(a - b) <= ms * R / 1000;
  ok(hits.length === HITS.length && hits.every((h, i) => near(h, HITS[i] - E.CHOP.PRE, 3)),
    `chop: hits found (${hits.length} of ${HITS.length}, each within 3 ms of its attack)`);
  ok(E.chopHits(x, nov, 1).length < HITS.length && E.chopHits(x, nov, 1).length >= 4, "chop: low sensitivity keeps the hard hits only");
  const late = E.chopSnap(x, nov, HITS[3] + 0.035 * R), early = E.chopSnap(x, nov, HITS[4] - 0.03 * R), none = E.chopSnap(x, nov, 1.1 * R);
  ok(near(late, HITS[3] - E.CHOP.PRE, 3) && near(early, HITS[4] - E.CHOP.PRE, 3) && none === Math.round(1.1 * R),
    "chop: a TAP 35 ms late / 30 ms early lands on its hit; away from hits it stays");
  const grid = E.chopGrid(0, Math.round(R * 60 / 90 * 16), 90, 1);
  ok(grid.length === 16 && grid[1] === Math.round(R * 60 / 90) && E.chopEqual(100, 900, 4).join() === "100,300,500,700",
    "chop: grid (16 beats at 90 BPM) and equal parts");
  const list = E.chopList([10, 50, 400], 1000, 100);
  ok(list.map((c) => `${c.start}-${c.end}`).join() === "10-50,50-150,400-500", "chop: chops end at the next marker or the max length");
  const chops = E.chopList(hits, N), zones = E.chopZones(x, chops, 60, 0);
  const peak = (s) => s.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  ok(zones.length === 8 && zones.every((z, i) => z.root === 60 + i && z.lo === z.root && z.hi === z.root && z.s[0] === 0)
    && Math.abs(peak(zones[2].s) / peak(zones[0].s) - 0.25) < 0.05 && zones[0].fname === "CHOP01_C4.wav" && zones[1].fname === "CHOP02_C#4.wav",
    "chop: one key each from C4, levels kept (a ghost stays quiet), faded in");
  const one = E.chopZones(x, chops, 60, 1, 3);
  ok(one.length === 1 && one[0].root === 60 && one[0].lo === 0 && one[0].hi === 127 && one[0].fname === "CHOP04_C4.wav",
    "chop: one chop over the whole keyboard");
  const slot = E.buildSlot("BREAK", zones), v = new DataView(slot.hdr.buffer);
  ok(slot.hdr[6] === 8 && slot.hdr[32 + 25] === 60 && slot.hdr[32 + 26] === 60 && slot.hdr[32 + 7 * 28 + 25] === 67 && v.getInt16(32 + 20, true) === 60 * 16
    && slot.data.length <= E.SMP.MAX_DATA, "chop: slot header (8 zones, one key each)");
  const w = E.parseWav(E.wavFile(zones[1].s));
  ok(w.sr === R && w.x.length === zones[1].s.length && Math.abs(w.x[100] * 32768 - zones[1].s[100]) < 2, "chop: WAV writer round trip");
  const dir = mkdtempSync(join(tmpdir(), "sloop-chop-")), zp = join(dir, "c.zip");
  writeFileSync(zp, E.zipStore(zones.slice(0, 3).map((z) => ({ name: "BREAK/" + z.fname, data: E.wavFile(z.s) }))));
  const r = py(`import sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(",".join(i.filename + ":" + str(i.file_size) for i in z.infolist()))`, zp).toString().trim();
  ok(r === zones.slice(0, 3).map((z) => `BREAK/${z.fname}:${44 + z.s.length * 2}`).join(), "chop: ZIP of the WAVs (Python reads it)");

  /* keep / leave out, own lengths, fit: a recording longer than a slot */
  const opt = [null, { off: true }, { len: 30 }];
  const kl = E.chopList([10, 50, 400], 1000, 100, opt);
  ok(kl.map((c) => `${c.start}-${c.end}${c.off ? "x" : ""}/${c.full}`).join() === "10-50/50,50-150x/400,400-430/1000"
    && E.chopList([10, 400], 1000, 0, [{ len: 9999 }])[0].end === 400,
    "chop: options (left out, own length over the max, never past the next marker)");
  const kz = E.chopZones(x, E.chopList(hits, N, 0, [{}, { off: true }, {}, { off: true }]), 60, 0);
  ok(kz.length === 6 && kz.map((z) => z.root).join() === "60,61,62,63,64,65" && kz[1].fname === "CHOP03_C#4.wav" && kz[2].fname === "CHOP05_D4.wav",
    "chop: left-out chops: the kept ones on consecutive keys, files keep their numbers");
  const L = R * 20, long = new Float64Array(L);
  for (let i = 0; i < L; i++) long[i] = Math.sin(i * 0.05) * 0.5;
  const marks = E.chopEqual(0, L, 40), room = E.SMP.MAX_DATA * 2;
  const all = E.chopList(marks, L), pick = E.chopPick(all);
  ok(pick.length === 16 && pick[15].i === 15 && E.chopPick(all, 1, 7)[0].i === 7, "chop: 40 chops: the first 16 kept go to the slot; mode 1 the selected");
  const lo = E.chopList(marks, L, 0, marks.map((_, i) => ({ off: i % 4 !== 0 })));   /* keep 10 of 40 (each 0.5 s) */
  ok(E.chopPick(lo).length === 10 && E.chopFit(E.chopPick(lo), room) === Infinity, "chop: 20 s recording, 10 chops kept: they fit");
  const many = E.chopPick(E.chopList(marks, L, 0, marks.map((_, i) => ({ off: i >= 16 })))), Lf = E.chopFit(many, room - many.length);
  const fitted = many.map((c) => ({ ...c, end: Math.min(c.end, c.start + Lf) }));
  let built = null;
  try { built = E.buildSlot("LONG", E.chopZones(long, fitted, 60, 0)); } catch (e) { built = null; }
  ok(Lf < R * 0.5 && Lf > R * 0.4 && built && built.data.length <= E.SMP.MAX_DATA && built.hdr[6] === 16,
    `chop: Fit to slot: 16 x 0.5 s cut to ${(Lf / R).toFixed(3)} s each, the slot builds`);
  ok(E.chopFit([{ start: 0, end: 100 }, { start: 0, end: 300 }], 250) === 150, "chop: fit keeps short chops whole, cuts the long ones");
}

/* ------------------------------------------------------- packages: JS == Python --- */
async function packages() {
  const pkg = join(HERE, "../build/lowtide.fwsc");
  if (!existsSync(pkg)) {
    console.log("packages: skipped (run ./build.sh first)");
    return;
  }
  const raw = readFileSync(pkg);
  const logical = py(`import sys; raw = open(sys.argv[1], "rb").read()
sys.stdout.buffer.write(b"".join(raw[i * 48:i * 48 + 47] for i in range(20)) + raw[960:])`, pkg);
  ok(eq(logicalImage(raw), logical), "fm1pkg.js logicalImage");
  ok(/^FM-1_9\d\d$/.test(productOf(raw)), "fm1pkg.js productOf");
}

/* ------------------------------------------------- update protocol (fm1ota.js) --- */
const HS = [0xF0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7F, 0xF7];
const UPGRADE = [0xF0, 0x22, 0x24, 0x35, 0x7F, 0xF7];

/* an FM-1 on WebMIDI: identity, then "device asks, host answers" reads of the image */
class FakeFM1 {
  constructor(image, { unplugAfter = Infinity, finalIdentity = "FM-1_900", name = "FM-1", identity = "FM-1_015", loaderName = "Felucca Update" } = {}) {
    this.image = image; this.unplugAfter = unplugAfter; this.served = 0; this.bad = 0;
    this.finalIdentity = finalIdentity; this.loaderName = loaderName;
    this.access = { inputs: new Map(), outputs: new Map() };
    this.boot(identity, name);
  }
  boot(identity, name) {
    this.identity = identity; this.waiting = null; this.queue = [];
    for (const m of [this.access.inputs, this.access.outputs]) { for (const p of m.values()) p.state = "disconnected"; m.clear(); }
    const id = Math.random().toString(36).slice(2);
    this.input = { id: "i" + id, name, state: "connected", onmidimessage: null, open: async () => {} };
    this.output = { id: "o" + id, name, state: "connected", open: async () => {}, send: (d) => {
      if (this.output.state !== "connected") throw new Error("InvalidStateError");
      setTimeout(() => this.rx(Array.from(d)), 1);
    } };
    this.access.inputs.set(this.input.id, this.input);
    this.access.outputs.set(this.output.id, this.output);
  }
  tx(bytes) { const i = this.input; setTimeout(() => { if (i.state === "connected" && i.onmidimessage) i.onmidimessage({ data: Uint8Array.from(bytes) }); }, 1); }
  rx(d) {
    if (eq(d, HS)) {
      const t = [...new TextEncoder().encode(this.identity)];
      const body = [0, 0x59, 0x11, 0, 0, 0, ...t, ...new Array(28 - t.length).fill(0)];
      this.tx([0xF0, ...pack7(body), 0xF7]);
    } else if (eq(d, UPGRADE)) {
      this.queue = this.identity.startsWith("ota-")
        ? [...Array.from({ length: 6 }, (_, k) => [k * 512, 512]), [0xF0000000, 8]]
        : [[0, 64], [0x40, 160], [0x1000, 512], [0xE0000000, 8]];
      this.next();
    } else if (this.waiting) {
      const u = unpack7(d.slice(1, -1));
      const [addr, len] = this.waiting;
      const got = u.slice(14, 14 + (addr >= 0xE0000000 ? 8 : len));
      const want = addr >= 0xE0000000 ? [...new TextEncoder().encode("success"), 0] : Array.from(this.image.subarray(addr, addr + len));
      if (!eq(got, want)) this.bad++;
      this.waiting = null;
      this.served++;
      if (this.served >= this.unplugAfter) { this.input.state = this.output.state = "disconnected"; return; }
      if (addr === 0xE0000000) setTimeout(() => this.boot("ota-FM-1_900", this.loaderName), 300);
      else if (addr === 0xF0000000) setTimeout(() => this.boot(this.finalIdentity, "Felucca"), 300);
      else this.next();
    }
  }
  next() {
    const r = this.queue.shift();
    if (!r) return;
    this.waiting = r;
    const [addr, len] = r;
    const u = [0, 0x59, 0x30, 0, 0, 0, 0, addr & 0xFF, (addr >>> 8) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 24) & 0xFF, len & 0xFF, len >> 8, 0];
    let s = 0;
    for (let i = 6; i < 14; i++) s += u[i];
    u.push(~s & 0xFF);
    this.tx([0xF0, ...pack7(u), 0xF7]);
  }
}

async function updater() {
  const image = Uint8Array.from({ length: 0x2000 }, (_, i) => (i * 7) & 0xFF);
  const dev = new FakeFM1(image);
  const steps = [];
  const got = await new Updater(dev.access).install(image, "FM-1_900", (k) => steps.push(k));
  ok(got === "FM-1_900" && dev.bad === 0 && steps.includes("write") && steps.at(-1) === "done",
    `fm1ota.js: install: running firmware -> loader -> Felucca (${dev.served} reads)`);

  {   /* Windows names the re-enumerated update loader generically ("USB MIDI Device"): the name filter
         misses it, so the installer must find it by its handshake or the loader "does not appear" (#loader) */
    const win = new FakeFM1(image, { loaderName: "USB MIDI Device" });
    const ws = [];
    const g = await new Updater(win.access).install(image, "FM-1_900", (k) => ws.push(k));
    ok(g === "FM-1_900" && win.bad === 0 && ws.at(-1) === "done" && !FM1_PORT.test("USB MIDI Device"),
      "fm1ota.js: a generically-named update loader (USB MIDI Device) is still found by the handshake");
  }
  {   /* the same loader, but the device is already stuck in update mode: resume must find it too */
    const win2 = new FakeFM1(image, { loaderName: "USB MIDI Device" });
    win2.boot("ota-FM-1_900", "USB MIDI Device");
    const done = await new Updater(win2.access).resume(image);
    ok(done === true && win2.bad === 0, "fm1ota.js: resume finds a generically-named loader already in update mode");
  }

  const rescue = new FakeFM1(image);
  rescue.boot("FM-1_000", "Felucca");
  const recovered = await new Updater(rescue.access).install(image, "FM-1_900");
  ok(recovered === "FM-1_900" && rescue.bad === 0, "fm1ota.js: recovery mode -> loader -> normal firmware");
  const failedBoot = new FakeFM1(image, { finalIdentity: "FM-1_000" });
  const rescueSteps = [];
  const bootError = await new Updater(failedBoot.access).install(image, "FM-1_900", (k) => rescueSteps.push(k)).then(() => null, (e) => e);
  ok(bootError?.code === "mismatch" && !rescueSteps.includes("done"), "fm1ota.js: boot into recovery is not reported as successful installation");

  const dev2 = new FakeFM1(image, { unplugAfter: 3 });
  dev2.boot("ota-FM-1_900", "Felucca Update");
  const t0 = Date.now();
  const done = await new Updater(dev2.access).resume(image);
  ok(done === false && Date.now() - t0 < 6000, "fm1ota.js: unplugged during the write -> stops at once");

  const dev3 = new FakeFM1(image, { unplugAfter: 2 });
  const e = await new Updater(dev3.access).install(image, "FM-1_900").then(() => null, (x) => x);
  ok(e && e.code === "lost", "fm1ota.js: unplugged in step 1 -> error code 'lost'");
  const e2 = await new Updater({ inputs: new Map(), outputs: new Map() }).install(image, "FM-1_900").then(() => null, (x) => x);
  ok(e2 && e2.code === "notfound", "fm1ota.js: no device -> error code 'notfound'");
  {   /* an FM-1 running CLIPPER (USB name "Clipper", Lowtide's sister firmware) installs Lowtide like any FM-1 */
    const cl = new FakeFM1(image, { name: "Clipper", identity: "FM-1_901" });
    const g = await new Updater(cl.access).install(image, "FM-1_900");
    ok(g === "FM-1_900" && cl.bad === 0, "fm1ota.js: an FM-1 under CLIPPER (port 'Clipper') -> found and installed");
    /* other gear is never probed, and "not found" names the MIDI ports there are */
    const other = new FakeFM1(image, { name: "Arturia KeyStep Pro" });
    const e6 = await new Updater(other.access).install(image, "FM-1_900").then(() => null, (x) => x);
    ok(e6 && e6.code === "notfound" && other.served === 0 && /Arturia KeyStep Pro/.test(e6.detail),
       `fm1ota.js: a port of other gear is left alone; 'not found' lists it${e6 ? e6.detail : ""}`);
    ok(["FM-1", "Felucca", "Felucca Update", "Clipper", "SLOOP", "LOWTIDE", "MIDIIN2 (Clipper)", "USB-MIDI"].every((n) => FM1_PORT.test(n)) &&
       !["Arturia KeyStep Pro", "loopMIDI Port", "Microsoft GS Wavetable Synth"].some((n) => FM1_PORT.test(n)),
       "fm1ota.js: FM1_PORT takes the FM-1's names (SLOOP, CLIPPER, the loader, the stock firmware), not other gear");
    /* the editor finds the FM-1 by the installer's names (a port name kept from another firmware: "X0X FM-1") */
    ok(E.FM1_PORT_ED.source === FM1_PORT.source && E.FM1_PORT_ED.flags === FM1_PORT.flags,
       "editor: its FM1_PORT is the installer's");
    const port = (name, type, state = "connected") => ({ id: `${type}-${name}`, name, type, state });
    const acc = (names, gone = []) => ({
      inputs: new Map([...names, ...gone].map((n) => [n, port(n, "input", gone.includes(n) ? "disconnected" : "connected")])),
      outputs: new Map([...names, ...gone].map((n) => [n, port(n, "output", gone.includes(n) ? "disconnected" : "connected")])),
    });
    const pn = (a) => E.fm1Ports(a).map((x) => x.input.name + "/" + x.output.name).join(",");
    ok(pn(acc(["X0X FM-1"])) === "X0X FM-1/X0X FM-1", "editor: a port named after another firmware (X0X FM-1) is found");
    ok(pn(acc(["Arturia KeyStep Pro", "USB-MIDI", "X0X FM-1", "Felucca"], ["SLOOP"])) ===
       "Felucca/Felucca,X0X FM-1/X0X FM-1,USB-MIDI/USB-MIDI",
       "editor: Felucca first, then FM-1, then generic names; other gear and unplugged ports left out");
    ok(pn(acc(["Arturia KeyStep Pro", "loopMIDI Port"])) === "", "editor: no FM-1 name: nothing to try");
  }
  const stock = new FakeFM1(image);
  stock.boot("ota-FM-1_015", "FM-1 Update");
  const e3 = await new Updater(stock.access).resume(image).then(() => null, (x) => x);
  ok(e3 && e3.code === "foreign" && e3.detail === "ota-FM-1_015" && stock.served === 0, "fm1ota.js: another firmware's loader is never resumed ('foreign')");
  const back = new FakeFM1(image, { finalIdentity: "FM-1_015" });   /* the return to the official V15, interrupted */
  back.boot("ota-FM-1_015", "FM-1 Update");
  const st = [];
  const r4 = await new Updater(back.access).resume(image, (k) => st.push(k), { product: "FM-1_015" });
  ok(r4 === true && back.bad === 0 && st.at(-1) === "done", "fm1ota.js: return to official: its own loader resumed, V15 checked when back");
  const wrong = new FakeFM1(image, { finalIdentity: "FM-1_900" });
  wrong.boot("ota-FM-1_015", "FM-1 Update");
  const e5 = await new Updater(wrong.access).resume(image, null, { product: "FM-1_015" }).then(() => null, (x) => x);
  ok(e5 && e5.code === "mismatch", "fm1ota.js: return to official: another firmware coming back is not 'done'");
  const pk = await import(join(HERE, "fm1pkg.js"));
  const notStock = new Uint8Array(pk.STOCK_V15_SIZE);
  const e6 = await pk.validateStockPackage(notStock).then(() => null, (x) => x);
  ok(e6 && /official FM-1 V15/.test(e6.message), "fm1pkg.js: only the exact official V15 is accepted (SHA-256)");
}

/* ------------------------------------------- Lowtide 2.8.13: #33, #34, #35 --- */
async function editorKit2813() {
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));

  /* #33: the backup mutex serialises whole operations — tasks that read, await and write a
     shared value never interleave */
  {
    let x = 0, bad = 0;
    const inc = () => E.bkMutex(async () => { const v = x; await sleep(10); if (x !== v) bad++; x = v + 1; });
    await Promise.all([inc(), inc(), inc()]);
    ok(x === 3 && bad === 0, "#33: bkMutex serialises whole operations (three read-await-write tasks land in order, none interleaves)");
  }
  /* #33: a background slot-kind read interleaved with a marker write, against the mock — which
     enforces the firmware's ed_bk_put rule (a BK_LIST clears an in-progress BK_PUT begin, so the
     next data chunk answers rc 5; a BK_PUT also clears the mock's LIST snapshot, so a GET needs a
     fresh LIST first). With the mutex, no BK_LIST lands while the write is in flight, and both
     operations succeed. */
  {
    const { rq, done } = attachMock();
    const L0 = E.parse[E.CMD.BK_LIST](await rq(E.req.bkList()));
    const it0 = L0.items.find((x) => x.id === 0);
    const bytes = new Uint8Array(768);
    new DataView(bytes.buffer).setUint32(0, 2000, true);
    /* a LIST counts only while a BK_PUT begin is actually in flight on the device (begin seen,
       commit not yet) — that is the window in which a LIST clears the firmware's begin */
    let listsDuringWrite = 0, putActive = false;
    const countingRq = async (r, o) => {
      if (r[0] === E.CMD.BK_PUT) { if (r[1][0] === 0) putActive = true; else if (r[1][0] === 2 || r[1][0] === 3) putActive = false; }
      if (putActive && r[0] === E.CMD.BK_LIST) listsDuringWrite++;
      return rq(r, o);
    };
    /* the background read is a whole-object read (LIST, then GETs) in one mutex hold, as
       kitSliceRead does: the LIST is the tripwire — a LIST during a BK_PUT clears the firmware's
       begin, so the next data chunk answers rc 5 */
    const writeP = E.bkWriteObj(countingRq, 13, bytes);
    const readP = E.bkMutex(async () => {
      const L = E.parse[E.CMD.BK_LIST](await countingRq(E.req.bkList()));
      return E.bkReadObj(countingRq, L.items.find((x) => x.id === 0));
    });
    const [wrote, read] = await Promise.allSettled([writeP, readP]);
    ok(wrote.status === "fulfilled" && read.status === "fulfilled" && read.value.length === it0.len && listsDuringWrite === 0,
      `#33: a background read interleaved with a marker write lands no BK_LIST inside the write (${listsDuringWrite} lists) and both operations succeed`);
    const L = E.parse[E.CMD.BK_LIST](await rq(E.req.bkList()));
    ok(L.items.some((x) => x.id === 13 && x.len === 768), "#33: the marker write itself landed (object 13 listed, 768 bytes)");
    done();
  }

  /* #34: a re-preview sends no KITS_STOP; a deliberate stop and the timer expiry still do */
  {
    const playSrc34 = html.slice(html.indexOf("function kitTogglePlay"), html.indexOf("function kitDrawWave"));
    const stops34 = [], notesOn34 = [];
    const playBox34 = { console, setTimeout, clearTimeout, t: (k) => k, kitUi: null,
      kitDraft: { name: "", slot: 2, pads: Array(16).fill(null), sel: -1, sent: true }, kitPlaying: new Map(),
      kitSliceRange: E.kitSliceRange, kitRate: E.kitRate, drumPadsHearNote: () => -1, DRUM_LANES: E.DRUM_LANES, SMP: E.SMP,
      lvNoteOn: (tok) => { notesOn34.push(tok); }, lvNoteOff: () => {},
      kitsStopSend: async (l) => { stops34.push(l); } };
    const P34 = vm.runInNewContext(playSrc34 + `\n;({ kitDraft, kitTogglePlay, kitStartLane, kitStopLane, kitPlaying })`, playBox34);
    P34.kitDraft.pads[0] = { s: s(2205), fname: "k.wav", tune: 0, gain: 0, len: 0 };
    P34.kitTogglePlay(0);
    P34.kitStartLane(0);   /* a re-preview while the first is still sounding */
    ok(notesOn34.length === 2 && stops34.length === 0 && P34.kitPlaying.has(0),
      "#34: a re-preview sends no KITS_STOP (the new note-on is not killed by the old preview's stop)");
    P34.kitTogglePlay(0);   /* a deliberate stop */
    ok(stops34.length === 1 && stops34[0] === 0 && !P34.kitPlaying.has(0),
      "#34: a deliberate stop still sends KITS_STOP");
    P34.kitTogglePlay(0);
    await sleep(250);   /* the timer expiry */
    ok(stops34.length === 2 && !P34.kitPlaying.has(0),
      "#34: the stop timer's expiry still sends KITS_STOP");
  }

  /* #35: the tune lives in the zone rate (buildSlot), and the audio bytes do not change with it */
  {
    const sig = s(6000);
    const tuned = E.buildSlot("KIT", [{ s: sig, root: 36, tune: 12 }, { s: sig, root: 38, tune: -12 }, { s: sig, root: 42 }]);
    const plain = E.buildSlot("KIT", [{ s: sig, root: 36 }, { s: sig, root: 38 }, { s: sig, root: 42 }]);
    const rateAt = (b, j) => new DataView(b.hdr.buffer).getUint32(32 + j * 28 + 16, true);
    ok(rateAt(tuned, 0) === 65536 && rateAt(tuned, 1) === 16384 && rateAt(tuned, 2) === 32768,
      "#35: buildSlot writes the tune into the zone rate (+12 st: 65536, -12 st: 16384, no tune: 32768)");
    ok(tuned.data.length === plain.data.length && tuned.data.every((v, i) => v === plain.data[i]),
      "#35: the audio bytes are identical with and without a tune (the tune is not baked into the audio)");
  }
  /* #35: kitPad no longer resamples for tune; kitLen is the stored length, kitPlayLen the heard
     one; a tuned pad reuses its original ADPCM; the slot accounting does not shrink with the tune;
     the markers do not move with the tune, and the 120 ms chop clamp scales with the rate */
  {
    const sig = s(6000);
    const p = { s: sig, fname: "k.wav", tune: 12, gain: 0, len: 0, adpcm: E.imaEncode(sig).data, slice: { start: 1000, end: 2000 } };
    const zs = E.kitZones([p]);
    ok(E.kitPad(p).length === 6000 && E.kitLen(p) === 6000 && E.kitPlayLen(p) === 3000 && zs[0].adpcm === p.adpcm && zs[0].tune === 12
      && E.kitBytes([p]) === E.kitBytes([{ ...p, tune: 0 }]) && E.kitBytes([p]) === 3000,
      "#35: a +12 pad keeps its 6000 stored samples (plays 3000), reuses its original ADPCM, and takes the same slot bytes as untuned");
    p.tune = -12;
    ok(JSON.stringify(E.kitSliceRange(p)) === JSON.stringify({ start: 1000, end: 2000 }) && E.kitPlayLen(p) === 12000,
      "#35: retuning a pad moves no markers (the slice stays 1000..2000 in stored samples) and plays twice as long at -12");
    ok(E.kitMinChop({ tune: 0 }) === 2646 && E.kitMinChop({ tune: 12 }) === 5292 && E.kitMinChop({ tune: -12 }) === 1323,
      "#35: the 120 ms minimum chop scales with the rate (2646 stored samples at 0 st, 5292 at +12, 1323 at -12)");
    const setSrc35 = html.slice(html.indexOf("function kitSliceSet"), html.indexOf("async function kitSliceCommit"));
    const setBox35 = { console, kitDraft: { pads: [{ s: s(8000), fname: "k.wav", tune: 12, gain: 0, len: 0 }] }, kitLen: E.kitLen, kitSliceRender: () => {}, KIT_MIN_CHOP: E.KIT_MIN_CHOP, kitMinChop: E.kitMinChop };
    const ST35 = vm.runInNewContext(setSrc35 + `\n;({ kitSliceSet })`, setBox35);
    ST35.kitSliceSet(0, 100, 200);
    ok(setBox35.kitDraft.pads[0].slice.end === 100 + 5292 && setBox35.kitDraft.pads[0].slice.start === 100,
      "#35: kitSliceSet clamps a sub-120 ms chop to the rate-aware minimum (a +12 pad: 5292 stored samples)");
  }
  /* #35: the header-only update against the mock — a bare BEGIN + END fails its CRC (the BEGIN
     erase took the first sector's data with it), while BEGIN + the first sector's data bytes +
     END lands the new rate and leaves the audio intact */
  {
    const { rq, done } = attachMock();
    const sig = s(20000);
    const full = E.buildSlot("KIT", [{ s: sig, root: 36, tune: 0 }]);
    let rc = E.parse[E.CMD.SMP_BEGIN](await rq(E.req.smpBegin(1))).rc;
    for (let off = 0; off < full.data.length && !rc; off += 256)
      rc = E.parse[E.CMD.SMP_WRITE](await rq(E.req.smpWrite(1, E.SMP.DATA_OFF + off, full.data.subarray(off, off + 256)))).rc;
    rc = rc || E.parse[E.CMD.SMP_END](await rq(E.req.smpEnd(1, full.hdr))).rc;
    ok(rc === 0, "#35: the full upload lands first (the header-only update needs a slot to update)");
    const fast = E.buildSlot("KIT", [{ s: sig, root: 36, tune: 12 }]);
    let bare = E.parse[E.CMD.SMP_BEGIN](await rq(E.req.smpBegin(1))).rc;
    bare = bare || E.parse[E.CMD.SMP_END](await rq(E.req.smpEnd(1, fast.hdr))).rc;
    ok(bare === 3, "#35: a bare BEGIN + END header update fails its CRC (rc 3: the BEGIN erase took the first sector's data with it)");
    let fixed = E.parse[E.CMD.SMP_BEGIN](await rq(E.req.smpBegin(1))).rc;
    const first = Math.min(fast.data.length, 4096 - E.SMP.DATA_OFF);
    for (let off = 0; off < first && !fixed; off += 256)
      fixed = E.parse[E.CMD.SMP_WRITE](await rq(E.req.smpWrite(1, E.SMP.DATA_OFF + off, fast.data.subarray(off, off + 256)))).rc;
    fixed = fixed || E.parse[E.CMD.SMP_END](await rq(E.req.smpEnd(1, fast.hdr))).rc;
    ok(fixed === 0, "#35: BEGIN + the first sector's data bytes + END lands the new header (16 requests, not ~320)");
    const L = E.parse[E.CMD.BK_LIST](await rq(E.req.bkList()));
    const it = L.items.find((x) => x.id === 33);
    const back = await E.bkReadObj(rq, it);
    ok(new DataView(back.buffer).getUint32(48, true) === 65536
      && back.subarray(E.SMP.DATA_OFF, E.SMP.DATA_OFF + fast.data.length).every((v, i) => v === fast.data[i]),
      "#35: the slot now holds the +12 rate (65536) with the audio bytes intact");
    done();
  }
  /* #35: reading a slot back restores the tune from the zone rate */
  {
    const built = E.buildSlot("KIT", [{ s: s(8000), root: 36, tune: 12 }]);
    const raw = new Uint8Array(E.SMP.DATA_OFF + built.data.length);
    raw.set(built.hdr, 0); raw.set(built.data, E.SMP.DATA_OFF);
    const padsSrc = html.slice(html.indexOf("function kitPadsFromRaws"), html.indexOf("/* (2.8.9) the draft kit as a v2 ZIP"));
    const hdrSrc35 = html.slice(html.indexOf("/* a slot's header:"), html.indexOf("/* (2.8.9) what each USR slot holds"));
    const box35 = { console, TextDecoder, DRUM_LANES: E.DRUM_LANES, imaDecode: E.imaDecode, kitSliceEntry: E.kitSliceEntry, SMP: E.SMP };
    const F35 = vm.runInNewContext(padsSrc + "\n" + hdrSrc35 + `\n;({ kitPadsFromRaws })`, box35);
    const pads = F35.kitPadsFromRaws([2], [raw]).pads;
    ok(pads[0] && pads[0].tune === 12 && pads[0].s.length === 8000,
      "#35: reading a slot back restores the tune from the zone rate (+12)");
  }
}

/* ------------------------------------------- Lowtide 2.8.14: #36, #30, pred-as-gain --- */
async function editorKit2814() {
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));

  /* #36: a pending marker write is flushed when the transport state flips playing -> stopped,
     and no write is attempted while the song still plays */
  {
    const commitSrc = html.slice(html.indexOf("async function kitSliceCommit"), html.indexOf("function kitSliceZoom"));
    const { rq, done } = attachMock({});
    await rq(E.req.live(E.LIVE.PLAY, 1));   /* the mock song is playing now */
    let syncs = 0, refuse = true;
    const stopErr = () => { const e = new Error("stop the song first"); e.code = "bkStop"; return e; };
    const pollFns = [], cleared = [];
    const box = { console, dev: { info: { proto: 18 }, link: { idle: true } },
      kitDraft: { slot: 2, sent: true }, kitWriteNow: async () => {}, busy: 0,
      kitSliceSyncFromDraft: async () => { syncs++; if (refuse) throw stopErr(); },
      report: () => {}, sayK: () => {}, bkReport: () => {}, kitSlicePending: false,
      rq, req: E.req, parse: E.parse, CMD: E.CMD, LIVE: E.LIVE,
      setInterval: (fn, ms) => { pollFns.push(fn); return pollFns.length; },
      clearInterval: (id) => { cleared.push(id); } };
    const K = vm.runInNewContext(commitSrc + `\n;({ kitSliceCommit, kitSlicePollTick, kitSlicePollStop })`, box);
    ok((await K.kitSliceCommit()) === "deferred" && box.kitSlicePending === true && pollFns.length === 1,
      "#36: a marker commit refused while the song plays defers and starts the transport poll (once a second)");
    await K.kitSlicePollTick();   /* still playing: the state is read, but no write is attempted */
    ok(syncs === 1 && box.kitSlicePending === true && cleared.length === 0,
      "#36: while the song still plays, the poll reads the state and attempts no write");
    refuse = false;
    await rq(E.req.live(E.LIVE.PLAY, 0));   /* the song stops */
    await K.kitSlicePollTick();
    ok(syncs === 2 && box.kitSlicePending === false && cleared.length === 1,
      "#36: when the transport flips to stopped, the poll commits once and stops");
    done();
  }
  /* #36: the drag-release and nudge previews are gated on the commit landing */
  ok(/if \(\(await kitSliceCommit\(\)\) === "ok"\) kitStartLane\(kitDraft\.sel\);/.test(html),
    "#36: sliceEnd previews only when the marker commit landed (a deferred commit plays nothing)");
  ok(/kitSliceCommit\(\)\.then\(\(r\) => \{ if \(r === "ok"\) kitStartLane\(l\); \}\);/.test(html),
    "#36: the nudge buttons preview only when the marker commit landed");

  /* #30: no Import ZIP button remains anywhere in the editor (no button, label, handler or
     file input for it), and nothing references the removed code; Export stays */
  ok(!/t\("kitImportZip"\)/.test(html) && !/kitImportSlot/.test(html) && !/slotFile/.test(html) && !/kitImportZip:/.test(html)
    && /onclick: \(\) => kitExportSlot\(d\)/.test(html),
    "#30: no Import ZIP button remains (no button, label, handler or file input); Export stays");

  /* pred-as-gain: the Q15 values, the zone pred and the header version */
  {
    ok(E.gainQ15(0) === 32767 && E.gainQ15(-24) === 2068 && E.gainQ15(-6) === 16423
      && E.gainDbFromQ15(32767) === 0 && E.gainDbFromQ15(2068) === -24,
      "gain fast path: gainQ15 (0 dB -> 32767, -24 dB -> 2068) and back");
    const sig = s(6000), ad = E.imaEncode(sig).data;
    const predAt = (b, j) => new DataView(b.hdr.buffer).getInt16(32 + j * 28 + 22, true);
    const verOf = (b) => new DataView(b.hdr.buffer).getUint16(4, true);
    const withPred = E.buildSlot("KIT", [{ s: sig, adpcm: ad, root: 36, gain: -6 }], { gainPred: true });
    const plain = E.buildSlot("KIT", [{ s: sig, adpcm: ad, root: 36, gain: -6 }]);
    ok(verOf(withPred) === 2 && predAt(withPred, 0) === 16423 && verOf(plain) === 1 && predAt(plain, 0) === 0,
      "gain fast path: buildSlot writes the gain into the zone pred as Q15 with header version 2 (version 1 and the predictor pred on the old path)");
    ok(withPred.data.length === plain.data.length && withPred.data.every((v, i) => v === plain.data[i]),
      "gain fast path: the audio bytes are identical with and without a gain (the gain is not baked into the audio)");
    const p = { s: sig, fname: "k.wav", tune: 0, gain: -6, len: 0, adpcm: ad };
    const pk = (x) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
    ok(Math.abs(pk(E.kitPad(p)) / 20000 - 0.501) < 0.03 && Math.abs(pk(E.kitPad(p, { gainPred: true })) / 20000 - 1) < 0.03,
      "gain fast path: kitPad bakes the gain on the old path and leaves the audio alone with pred-gain");
    ok(E.kitZones([p])[0].adpcm !== ad && E.kitZones([p], { gainPred: true })[0].adpcm === ad
      && E.kitZones([p], { gainPred: true })[0].gain === -6,
      "gain fast path: a gain-only pad reuses its original ADPCM with pred-gain (and the zone carries the gain); the old path re-encodes it");
  }
  /* pred-as-gain: a gain-only change is a header-only write on protocol 19, and still a full
     re-upload on protocol 18 */
  {
    const upSrc = html.slice(html.indexOf("async function kitUploadPads"), html.indexOf("/* read part of a backup object"));
    const hdrCalls = [], fullCalls = [], syncCalls = [];
    const upBox = { console, dev: { info: { proto: 19 } }, kitSlots: (d) => [d], kitSplit: E.kitSplit, kitRoom: () => E.SMP.MAX_DATA - 64,
      kitZones: E.kitZones, buildSlot: E.buildSlot, kitSent: {}, kitSlotKinds: null, kitSlicePending: false,
      smpUploadHeader: async (k) => { hdrCalls.push(k); return true; },
      smpUpload: async () => { fullCalls.push(1); return true; },
      kitProg: () => ({}), kitEraseSlot: async () => true,
      kitSliceSyncPads: async () => { syncCalls.push(1); },
      sayK: () => {}, report: () => {}, bkReport: () => {}, kitSlicePollStart: () => {}, t: (k) => k,
      kitGainPred: () => upBox.dev.info.proto >= 19 };
    const U = vm.runInNewContext(upSrc + `\n;({ kitUploadPads })`, upBox);
    const sig = s(8000), ad = E.imaEncode(sig).data;
    const pads = Array(16).fill(null);
    pads[0] = { s: sig, fname: "kick.wav", tune: 0, gain: 0, len: 0, adpcm: ad };
    ok(await U.kitUploadPads(pads, "KIT", 0) && fullCalls.length === 1 && hdrCalls.length === 0,
      "gain fast path: the first upload is still a full upload (nothing sent yet)");
    pads[0].gain = -6;
    ok(await U.kitUploadPads(pads, "KIT", 0) && hdrCalls.length === 1 && fullCalls.length === 1,
      "gain fast path: a gain-only change on protocol 19 is a header-only write (sameAudio true, smpUploadHeader taken, no full upload)");
    upBox.dev.info.proto = 18;
    const prev18 = E.buildSlot("KIT", E.kitZones([{ ...pads[0], gain: 0 }]));
    upBox.kitSent[0] = { data: prev18.data, hdr: prev18.hdr };
    hdrCalls.length = 0; fullCalls.length = 0;
    ok(await U.kitUploadPads(pads, "KIT", 0) && fullCalls.length === 1 && hdrCalls.length === 0,
      "gain fast path: on protocol 18 the same gain change still bakes the gain and re-uploads the whole slot");
  }
  /* pred-as-gain: the export stores the original audio + the gain in kit.json, and the import
     restores it; reading a slot back restores the gain from the zone pred (v2 only) */
  {
    const exportSrc = html.slice(html.indexOf("function kitExport()"), html.indexOf("async function kitZipParse"));
    const zipSrc = html.slice(html.indexOf("async function kitZipParse"), html.indexOf("async function kitUploadPads"));
    const saved = [];
    const sig = s(8000), ad = E.imaEncode(sig).data;
    const exBox = { console, TextEncoder, TextDecoder, File, Blob, zipStore: E.zipStore, zipRead: E.zipRead,
      imaEncode: E.imaEncode, imaDecode: E.imaDecode, kitPad: E.kitPad, DRUM_LANES: E.DRUM_LANES,
      KIT_MIN_CHOP: E.KIT_MIN_CHOP, kitMinChop: E.kitMinChop, dev: { info: { proto: 19 } },
      kitDraft: { name: "MYKIT", slot: 0, pads: Array(16).fill(null), sel: -1, sent: true },
      downloadBytes: (name, bytes) => { saved.push({ name, bytes }); },
      fileSlug: (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      sayK: () => {}, t: (k) => k,
      kitUploadPads: async () => true, kitSlotKinds: null, kitWrittenSlot: null, renderKits: () => {} };
    exBox.kitDraft.pads[0] = { s: sig, fname: "kick.wav", tune: 0, gain: -6, len: 0, adpcm: ad };
    const X = vm.runInNewContext(exportSrc + "\n" + zipSrc + `\n;({ kitExport, kitZipParse, kitGainPred })`, exBox);
    X.kitExport();
    ok(saved.length === 1, "gain fast path: the export writes one ZIP");
    const entries = await E.zipRead(saved[0].bytes);
    const json = JSON.parse(new TextDecoder().decode(entries.find((x) => x.name === "kit.json").data));
    ok(json.pads[0].gain === -6, "gain fast path: a 2.8.14 export stores the gain in kit.json");
    const blob = entries.find((x) => x.name === "01 KICK.adpcm");
    ok(blob && blob.data.length === ad.length && blob.data.every((v, i) => v === ad[i]),
      "gain fast path: a 2.8.14 export stores the original (unbaked) audio");
    const parsed = await X.kitZipParse(new File([saved[0].bytes], "mykit-kit.zip"));
    ok(parsed.pads[0] && parsed.pads[0].gain === -6 && parsed.pads[0].s.length === 8000,
      "gain fast path: the exported kit imports back at -6 dB");
    exBox.dev.info.proto = 18; saved.length = 0;
    X.kitExport();
    const json18 = JSON.parse(new TextDecoder().decode((await E.zipRead(saved[0].bytes)).find((x) => x.name === "kit.json").data));
    ok(json18.pads[0].gain === 0, "gain fast path: on protocol 18 the export still bakes the gain and stores 0 in kit.json");
  }
  {
    const padsSrc = html.slice(html.indexOf("function kitPadsFromRaws"), html.indexOf("function kitExport()"));
    const hdrSrc = html.slice(html.indexOf("/* a slot's header:"), html.indexOf("/* (2.8.9) what each USR slot holds"));
    const box = { console, TextDecoder, DRUM_LANES: E.DRUM_LANES, imaDecode: E.imaDecode, kitSliceEntry: E.kitSliceEntry, SMP: E.SMP, gainDbFromQ15: E.gainDbFromQ15 };
    const F = vm.runInNewContext(padsSrc + "\n" + hdrSrc + `\n;({ kitPadsFromRaws })`, box);
    const sig = s(8000), ad = E.imaEncode(sig).data;
    const mkRaw = (gainPred) => {
      const b = E.buildSlot("KIT", [{ s: sig, adpcm: ad, root: 36, gain: -6 }], gainPred ? { gainPred: true } : undefined);
      const raw = new Uint8Array(E.SMP.DATA_OFF + b.data.length);
      raw.set(b.hdr, 0); raw.set(b.data, E.SMP.DATA_OFF);
      return raw;
    };
    E.kitSliceDev.fill(0);
    ok(F.kitPadsFromRaws([2], [mkRaw(true)]).pads[0].gain === -6,
      "gain fast path: reading a version-2 slot back restores the gain from the zone pred (-6 dB)");
    ok(F.kitPadsFromRaws([2], [mkRaw(false)]).pads[0].gain === 0,
      "gain fast path: reading a version-1 slot back keeps the gain at 0 (its pred is the ADPCM predictor, not a gain)");
  }
}

async function editorKit2815() {
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));

  /* #38: the full upload after an import carries the gain — the written header is version 2
     with pred = gainQ15(gain), and the last-upload record matches what was actually written.
     Runs the real kitUploadPads -> smpUpload path with an empty kitSent (as after a fresh
     connect + pick, when the first kit write is always a full upload) against the mock device. */
  {
    const { rq, done } = attachMock({});
    const seenHdr = [];
    const reqW = { ...E.req, smpEnd: (k, hdr) => { seenHdr.push(new Uint8Array(hdr)); return E.req.smpEnd(k, hdr); } };
    const upSrc = html.slice(html.indexOf("function kitGainPred()"), html.indexOf("/* read part of a backup object"));
    const smpSrc = html.slice(html.indexOf("async function smpUpload(k,"), html.indexOf("async function smpErase"));
    const box = { console, performance, dev: { info: { proto: 19 } },
      kitSlots: (d) => [d], kitSplit: E.kitSplit, kitRoom: () => E.SMP.MAX_DATA - 64,
      kitZones: E.kitZones, buildSlot: E.buildSlot, withGain: E.withGain,
      kitSent: {}, kitSlotKinds: null, kitSlicePending: false,
      smpUploadHeader: async () => { throw new Error("header path taken"); },
      kitProg: () => ({ isConnected: true, hidden: false, style: {}, value: 0 }),
      kitEraseSlot: async () => true,
      kitSliceSyncPads: async () => {}, kitSlicePollStart: () => {},
      sayK: () => {}, report: () => {}, bkReport: () => {}, t: (k) => k,
      rq, req: reqW, parse: E.parse, CMD: E.CMD, SMP: E.SMP, SMP_RC: {}, kib: (n) => `${n} B`,
      renderSamples: () => {}, renderKits: () => {}, smpInfo: async () => {},
      smpSentSig: [null, null, null, null], chopSentSig: [null, null, null, null],
      busy: 0, smpBusy: false, confirm: () => true, kitSliceClearSlot: async () => {} };
    const U = vm.runInNewContext(upSrc + "\n" + smpSrc + `\n;({ kitUploadPads })`, box);
    const sig = s(8000), ad = E.imaEncode(sig).data;
    const pads = Array(16).fill(null);
    pads[0] = { s: sig, fname: "kick.wav", tune: 0, gain: -6, len: 0, adpcm: ad };
    ok(await U.kitUploadPads(pads, "KIT", 0) && seenHdr.length === 1,
      "#38: a kit upload with an empty last-upload record takes the full path and writes one slot header");
    const dv = new DataView(seenHdr[0].buffer);
    ok(dv.getUint16(4, true) === 2 && dv.getInt16(54, true) === E.gainQ15(-6),
      "#38: the full upload writes header version 2 with pred = gainQ15(-6) (16423), not version 1 with pred 0");
    ok(box.kitSent[0] && box.kitSent[0].hdr.length === seenHdr[0].length
      && box.kitSent[0].hdr.every((v, i) => v === seenHdr[0][i]),
      "#38: the last-upload record matches the header actually written (no v2 claim over a v1 write)");
    const si = E.parse[E.CMD.SMP_INFO](await rq(E.req.smpInfo()));
    ok(si.slots[0].zones === 1 && si.slots[0].name === "KIT",
      "#38: the mock device accepted the version-2 slot (one zone, name KIT)");
    done();
  }
}

/* ------------------------------------------- Lowtide 2.8.16: #39, markers on the miniatures, the kits-mode display, long-press the sample --- */
async function editorKit2816() {
  const s = (n, a = 20000) => Int16Array.from({ length: n }, (_, i) => Math.round(a * Math.sin(i / 7)));

  /* #39: the flash is on the box itself, not only on its waveform canvas — an empty box hides
     its canvas, so the canvas-only outline was invisible on it. The canvas rule stays for full boxes. */
  ok(/\.pad\.flash \{ outline: 1px solid var\(--c\); outline-offset: -2px; \}/.test(html)
    && /\.pad\.flash canvas \{ outline: 1px solid var\(--c\); \}/.test(html),
    "#39: the flash outlines the pad box itself (visible on an empty box), and still the canvas on a full one");
  const flashSrc = html.slice(html.indexOf("function kitFlashLane"), html.indexOf("function kitDrawWave"));
  ok(/clearTimeout\(kitFlashTimers\.get\(l\)\)/.test(flashSrc) && /kitFlashTimers\.set\(l, setTimeout\(/.test(flashSrc)
    && /pu\.box\.classList\.add\("flash"\)/.test(flashSrc),
    "#39: a re-hit restarts the 140 ms flash timer (per-lane timers, as drumPadsFlash does)");

  /* A: the miniature greys out outside the chop and always shows its markers — an unchopped pad
     shows them at its start and end. Runs the real kitDrawWave in the vm harness. */
  const waveSrc = html.slice(html.indexOf("function kitDrawWave"), html.indexOf("/* (2.8.8) move a sample assignment"));
  ok(/const rng = kitSliceRange\(p\);/.test(waveSrc),
    "miniature markers: kitDrawWave reads the chop range (the whole pad when unchopped), not p.slice");
  const draws = [];
  const fakeCtx = { fillStyle: "", fillRect: (x, y, w, h) => { draws.push([x, y, w, h, fakeCtx.fillStyle]); }, clearRect: () => {} };
  const waveCv = { clientWidth: 200, width: 0, height: 0, getContext: () => fakeCtx };
  const waveBox = { console, kitLen: E.kitLen, kitSliceRange: E.kitSliceRange,
    getComputedStyle: () => ({ getPropertyValue: (k) => (k === "--t2" ? "#1ecc70" : "#ff621a") }) };
  const W = vm.runInNewContext(waveSrc + `\n;({ kitDrawWave })`, waveBox);
  W.kitDrawWave(waveCv, { s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0 });
  const marks0 = draws.filter((r) => r[2] === 2 && r[1] === 0 && r[3] === 48).map((r) => r[0]);
  ok(JSON.stringify(marks0) === "[1,198]",
    "miniature markers: an unchopped pad shows its markers at both edges (1 and w-2 over 200 px)");
  draws.length = 0;
  W.kitDrawWave(waveCv, { s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0, slice: { start: 2000, end: 4000 } });
  const cols = draws.filter((r) => r[2] === 1);
  ok(cols.length === 200 && cols.every((r) => (r[0] >= 50 && r[0] < 100 ? r[4] === "#ff621a" : r[4] === "#36363c")),
    "miniature markers: outside the chop the waveform is dimmed (columns 0-49 and 100-199), inside it is the pad colour");
  const marks1 = draws.filter((r) => r[2] === 2 && r[1] === 0 && r[3] === 48).map((r) => r[0]);
  ok(JSON.stringify(marks1) === "[50,100]",
    "miniature markers: a chopped pad keeps its markers at the chop (start 2000, end 4000, of 8000 over 200 px)");

  /* A: the miniature hit test — the nearest marker line within ±10 px, or null; no tabs, no zoom. */
  const miniHitSrc = html.slice(html.indexOf("function kitMiniHit"), html.indexOf("function renderKits"));
  const miniBox = { console, kitLen: E.kitLen, kitSliceRange: E.kitSliceRange,
    kitDraft: { pads: [{ s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0, slice: { start: 2000, end: 4000 } }] } };
  const M = vm.runInNewContext(miniHitSrc + `\n;({ kitMiniHit })`, miniBox);
  ok(M.kitMiniHit(0, 55, 200) === "start" && M.kitMiniHit(0, 95, 200) === "end" && M.kitMiniHit(0, 150, 200) === null
    && M.kitMiniHit(0, 58, 200) === "start" && M.kitMiniHit(0, 73, 200) === null,
    "miniature hit test: the nearer marker wins (start at 55, end at 95), and mid-waveform grabs nothing");
  miniBox.kitDraft.pads[0] = { s: s(8000), fname: "k.wav", tune: 0, gain: 0, len: 0 };
  ok(M.kitMiniHit(0, 5, 200) === "start" && M.kitMiniHit(0, 195, 200) === "end",
    "miniature hit test: an unchopped pad's edge markers grab (start at 5, end at 195 over 200 px)");

  /* A: the miniature drag wiring — claim on pointerdown (long-press cleared, HTML5 drag off,
     pointer captured), live redraw while dragging, commit-then-preview on release; the hover
     cursor is ew-resize on a marker, pointer elsewhere; touch must not scroll off a waveform. */
  const kitsRender = html.slice(html.indexOf("function renderKits()"), html.indexOf("function kitPadUpdate"));
  ok(/kitMiniHit\(l, e\.clientX - r\.left, r\.width\)/.test(kitsRender) && /clearCvLp\(\);/.test(kitsRender)
    && /pu\.cv\.draggable = false;/.test(kitsRender) && /pu\.cv\.setPointerCapture\(e\.pointerId\)/.test(kitsRender)
    && /kitDraft\.sel = l;/.test(kitsRender),
    "miniature drag: a marker grab clears the long-press timer, turns the HTML5 drag off, captures the pointer and selects the pad");
  ok(/const miniEnd = async/.test(kitsRender) && /if \(\(await kitSliceCommit\(\)\) === "ok"\) kitStartLane\(l\)/.test(kitsRender)
    && /miniSuppressClick = true;/.test(kitsRender) && /kitDrawWave\(pu\.cv, p\);/.test(kitsRender),
    "miniature drag: on release the markers are committed before the preview plays, the click is suppressed, and the miniature redraws live");
  ok(/if \(kitSliceDrag\.which !== "pan"\) \{ const pu = kitUi\.pads\[kitDraft\.sel\]; if \(pu\) kitDrawWave\(pu\.cv, p\); \}/.test(kitsRender),
    "miniature drag: a Chop-panel marker drag redraws the pad miniature live too (not only on release)");
  ok(/pu\.cv\.style\.cursor = kitMiniHit\(l, e\.clientX - r\.left, r\.width\) \? "ew-resize" : "pointer";/.test(kitsRender)
    && /\.pad canvas \{[^}]*touch-action: none;/.test(html),
    "miniature drag: hovering a marker shows ew-resize (pointer elsewhere), and touch does not scroll off a pad waveform");

  /* A: the Chop button is now "Fine Chop" (both locales); the Chop panel's heading stays "Chop". */
  ok(/kitChop: "Fine Chop",/.test(html) && /kitChop: "ファイン・チョップ",/.test(html)
    && /kitSliceTitle: "Chop",/.test(html) && /kitSliceTitle: "チョップ",/.test(html),
    "fine chop: the per-pad button reads 'Fine Chop' (EN) / 'ファイン・チョップ' (JA); the panel heading is still 'Chop'");

  /* B: the firmware shows the kits-mode slot on all four display sites, redraws on a real mode
     change, and stops the sequencer when a slot is selected. The EDIT-page KIT param still shows
     the stored preset. */
  const drumsC = readFileSync(join(HERE, "../firmware/src/drums.c"), "utf8");
  const edC = readFileSync(join(HERE, "../firmware/src/editor.c"), "utf8");
  const studioC = readFileSync(join(HERE, "../firmware/src/ui_studio.c"), "utf8");
  const drawC = readFileSync(join(HERE, "../firmware/src/ui_draw.c"), "utf8");
  const paramsC = readFileSync(join(HERE, "../firmware/src/params.c"), "utf8");
  ok(/static uint32_t kits_disp_kit\(void\) \{ return kits_mode \? kits_kit\(\) : drum_kit\(\); \}/.test(drumsC)
    && /static uint32_t kits_mode_set\(uint32_t mode\)/.test(drumsC),
    "kits display: kits_disp_kit() returns the slot while kits mode is on, the preset otherwise; kits_mode_set reports a real change");
  ok(/kit = kits_disp_kit\(\)/.test(studioC) && (studioC.match(/DRUM_KIT_NAMES\[kits_disp_kit\(\)\]/g) || []).length === 3
    && !/DRUM_KIT_NAMES\[drum_kit\(\)\]/.test(studioC) && /DRUM_KIT_NAMES\[kits_disp_kit\(\)\]/.test(drawC)
    && !/DRUM_KIT_NAMES\[drum_kit\(\)\]/.test(drawC),
    "kits display: the DRUMS screen, TRACKS row and both REC rows (studio) and the footer (draw) all read the display kit, never the preset");
  const kitsModeHandler = edC.slice(edC.indexOf("case ED_KITS_MODE"), edC.indexOf("case ED_KITS_STOP"));
  ok(/if \(kits_mode_set\(a\[0\]\)\) \{/.test(kitsModeHandler) && /ui\.force = 1;/.test(kitsModeHandler)
    && /if \(a\[0\] && \(song\.playing \|\| transport_req\)\)/.test(kitsModeHandler) && /transport_req = 2;/.test(kitsModeHandler),
    "kits display: on a real mode change the handler forces a redraw, and selecting a slot stops the sequencer (transport request 2)");
  ok(/PE\("KIT", DRUM_KIT_NAMES, 0\)/.test(paramsC),
    "kits display: the EDIT-page KIT parameter still shows the stored preset");

  /* C: the pick-up outline follows the kind — the waveform for a sample, the box for a box — and
     the release click of a long-press is swallowed, as on the Drum Pads tab. A drag after a
     pick-up is the picked kind, and a cancelled drag leaves no stale pick-up behind. */
  ok(/\.pad canvas\.picked \{ outline: 2px dashed var\(--fg\); outline-offset: -2px; \}/.test(html)
    && /pu\.box\.classList\.toggle\("picked", !!\(kitDraft\.picked && kitDraft\.picked\.lane === l && kitDraft\.picked\.kind === "box"\)\)/.test(html)
    && /pu\.cv\.classList\.toggle\("picked", !!\(kitDraft\.picked && kitDraft\.picked\.lane === l && kitDraft\.picked\.kind === "sample"\)\)/.test(html),
    "long-press sample: the dashed outline is on the waveform for a sample pick-up, on the box for a box pick-up");
  ok((html.match(/if \(kitDraft\.justPicked\) \{ kitDraft\.justPicked = false; return; \}/g) || []).length === 2,
    "long-press sample: the waveform and empty-area clicks swallow the long-press release click (justPicked, as on the Drum Pads tab)");
  ok(/if \(kitDraft\.picked\) kind = kitDraft\.picked\.kind;/.test(kitsRender)
    && /const fromLane = kitDraft\.picked \? kitDraft\.picked\.lane : l;/.test(kitsRender)
    && /if \(kitDraft\.picked\) \{ kitDraft\.picked = null; renderKits\(\); \}/.test(kitsRender),
    "long-press sample: a drag after a pick-up moves the picked kind and lane, and a cancelled drag clears the pick-up");
  ok(/Long-press a waveform to pick the sample up/.test(html) && /波形を長押しすると音だけを持ち上げます/.test(html),
    "long-press sample: the help text says so (EN and JA)");
}

await editorMock();
await editorLibrarian();
await editorLive();
await editorTracks();
await editorSetGate();
await editorMixer();
await editorTrackParam();
await editorV5();
await editorV7();
await editorV8();
await editorV9();
await editorBackup();
await editorDrumMap();
await editorKitSlices();
await editorKit289();
await editorKit2810();
await editorKit2811();
await editorKit2813();
await editorKit2814();
await editorKit2815();
await editorKit2816();
await editor25();
await editorDsyn();
await editorCart();
await editorTheme();
await editorLivePage();
editorLivePro();
await editorSongFile();
editorTabs();
editorIcons();
samplesMatch();
chopTests();
await packages();
await updater();
console.log(failed ? `WEB TESTS FAILED (${failed})` : "web tests passed");
process.exit(failed ? 1 : 0);
