/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments */
/* GM drum part (track 4): the SAMPLE engine's KIT set (General MIDI percussion map,
 * tools/gen_samples.py GM_KIT), played by its step pattern, the keys when track 4
 * is selected, and its own MIDI channel (GLO -> DRUMS, default 10). Its own voices
 * (outside the parts' voice budget). One-shots: note-offs are ignored; a closed or
 * pedal hi-hat chokes the open one. LEVEL / REV / DLY: GLO > DRUMS (G_DRLVL, G_DRREV, G_DRDLY);
 * PAN and MUTE: the drum track's P_PAN / P_MUTE. Rendered from the audio ISR. */
#ifndef NDRUM                    /* (a host may give the drums more voices: Kraken) */
#define NDRUM 6
#endif
/* a host's own treatment of each drum voice before the mix (Kraken: a level, a pan, a filter per sound);
 * on the FM-1, nothing */
#ifndef DRUM_VOICE_FX
#define DRUM_VOICE_FX(k, s) (s)
#define DRUM_VOICE_GL(k, g) (g)
#define DRUM_VOICE_GR(k, g) (g)
#endif
#include "drum_synth.c"       /* synthesised kits (DS_KITS) */
/* P_E0 was unused on the drum track: it holds the kit. 0..4: the GM sample kit and its four
 * treatments (as before: old projects keep their kit), 5..: the synthesised kits, then (2.4) USR1..USR4:
 * a user sample slot as a kit (the web editor's DRUM KIT: a sound per lane, zone lo..hi = the lane's note),
 * and USR3+4: one kit over the slots USR3 and USR4 (a lane's sound in either) */
#define DRUM_SAMPLED 5u
#define DRUM_USR (DRUM_SAMPLED + DS_NKITS)
#define DRUM_PAIR (DRUM_USR + SMP_USER_SLOTS)   /* USR3+4: one kit in two slots (the editor splits it), ~15 s */
#define DRUM_SYN (DRUM_PAIR + 1u)                /* SLOOP 2.5: SYN1..SYN4, your synthesised kits (drum_synth.c dsu) */
#define DRUM_KITS (DRUM_SYN + DSU_N)
static const char *const DRUM_KIT_NAMES[] = {"ACOUSTIC", "DEEP", "TIGHT", "BRIGHT", "DUST", DS_KIT_NAME_LIST,
                                             "USR1", "USR2", "USR3", "USR4", "USR3+4",
                                             "SYN1", "SYN2", "SYN3", "SYN4"};
static const char *const DRUM_KIT_STYLES[] = {"STUDIO", "SOFT", "PUNCHY", "BRIGHT", "DUSTY", DS_KIT_STYLE_LIST,
                                              "YOUR KIT", "YOUR KIT", "YOUR KIT", "YOUR KIT", "BIG KIT",
                                              "YOUR SYNTH", "YOUR SYNTH", "YOUR SYNTH", "YOUR SYNTH"};
_Static_assert(sizeof(DRUM_KIT_NAMES) / sizeof(DRUM_KIT_NAMES[0]) == DRUM_KITS, "a name per kit");
static uint32_t drum_kit(void) { return (uint32_t)clamp(TDRUM->p[P_E0], 0, DRUM_KITS - 1); }
#define DRUM_DEFAULT_KIT DRUM_SAMPLED   /* power-on: 808 */

static struct {
    voice_t v[NDRUM];
    uint32_t age;
    int16_t set;                 /* SMP_SETS index of "PERC" (GM map), -1 = none */
    int32_t tail;                /* declick: the last output of cut voices, decaying */
    int32_t peak;                /* largest |output| since the UI last looked (TRACKS meter) */
    uint8_t kit[NDRUM];
    int32_t filter[NDRUM], env[NDRUM], denv[NDRUM];   /* denv (2.7): the DECAY's fade, Q15 */
    uint16_t dk[NDRUM];          /* (2.7) its factor a sample (DECAY_K), 0: none */
    uint8_t synth[NDRUM];        /* the voice plays a synthesised kit (ds[]) */
    dsv_t ds[NDRUM];
    volatile uint16_t hits;      /* bit per lane hit since the UI last looked (pads, key LEDs) */
    volatile uint8_t kick;       /* a kick was hit (fx.c DUCK) */
    int32_t a0, a1;              /* the drum track's mute / solo attenuation over this block (fx.c), Q15, 0 = heard */
    int32_t glv, ggl, ggr;       /* (2.7) LEVEL and PAN as last mixed: a change glides (~3 ms, fx.c mix_glide) */
    uint8_t gon;
} drums = {.set = -2};

static int32_t ds_buf[CTL];

/* (2.7) LEVEL and PAN glide: a knob's detent (or a new sound's trim) moves a quarter of the way each block of CTL
 * samples (0.73 ms), ~3 ms in all, instead of a step a detent (after JIANT FM 0.6.8, github.com/juanjiant-bit/JIANT:
 * "LEVEL and PAN glide (~3 ms) instead of stepping at each knob move"). The last few units: at once */
static int32_t mix_glide(int32_t from, int32_t to)
{
    int32_t d = to - from;
    return d <= 8 && d >= -8 ? to : from + d / 4;
}

static int32_t drum_set(void)
{
    uint32_t i;
    if (drums.set == -2) {
        drums.set = -1;
        for (i = 0; i < SMP_NSETS; i++)
            if (str_eq(SMP_SETS[i].name, "PERC"))
                drums.set = (int16_t)i;
    }
    return drums.set;
}

/* ------------------------------------------------------------ lanes --- */
/* The drum track's 16 sounds, one per white key, F3 (kick) .. G5 (cowbell): kicks, snare and clap,
 * the hi-hats, rim and a second snare, the toms, the cymbals, the percussion. Each plays a GM note
 * (the sampled kits: their samples; the synthesised kits: drum_synth.c DS_MAP). A black key plays
 * the lane of the white key left of it (two fingers on one sound). */
static const uint8_t LANE_NOTE[DRUM_LANES] = {36, 35, 38, 39, 42, 46, 44, 37, 40, 43, 48, 49, 51, 70, 63, 56};
static const char *const LANE_NAME[DRUM_LANES] = {
    "KICK", "KICK 2", "SNARE", "CLAP", "HAT", "OPEN HAT", "PEDAL", "RIM",
    "SNARE 2", "LOW TOM", "HI TOM", "CRASH", "RIDE", "SHAKER", "CONGA", "COWBELL"};
static const char *const LANE_SHORT[DRUM_LANES] = {           /* 5 characters: tiles, dials */
    "kick", "kick2", "snare", "clap", "hat", "open", "pedal", "rim",
    "snr 2", "tom l", "tom h", "crash", "ride", "shake", "conga", "bell"};
/* a GM note (MIDI in, old projects) -> its lane: the nearest sound of the 16 (35..81; below: kick, above: shaker).
 * (2.8.6) single-note toms: a tom answers only its home note (LOW TOM G1 43, HI TOM C2 48).
 * (2.8.7) the filled default grid: the tom's other notes now play the four sounds that had no pad
 * (F1 41 KICK 2, A1 45 SHAKER, B1 47 CONGA, D2 50 COWBELL), so all 16 pads have a sound by default
 * and there is no Off the grid tray. LOW TOM only on G1 and HI TOM only on C2 still hold. */
#define DRUM_LANE_NONE 16u                     /* (2.8.6) a GM note with no lane: it plays nothing */
static const uint8_t LANE_OF_GM[81 - 35 + 1] = {
    /* 35 */ 1, 0, 7, 2, 3, 8, 1, 4, 9, 6,
    /* 45 */ 13, 5, 14, 10, 11, 15, 12, 11, 12, 13,
    /* 55 */ 11, 15, 11, 13, 12, 14, 14, 14, 14, 14,
    /* 65 */ 14, 14, 15, 15, 13, 13, 15, 15, 13, 13,
    /* 75 */ 7, 7, 7, 14, 14, 15, 15};
/* SLOOP 2.7, the DRUMS screen's SOUND page: each of the 16 sounds' TUNE (-8 .. +7 semitones) and DECAY (-4 .. +3,
 * 0 as the kit has it), on every kit; kept with the project and each section (project.c: in the drum track's free
 * engine values) */
#define DRUM_TUNE_MIN (-8)
#define DRUM_TUNE_MAX 7
#define DRUM_DEC_MIN (-4)
#define DRUM_DEC_MAX 3
static int8_t drum_tune[DRUM_LANES], drum_dec[DRUM_LANES];
static const uint8_t DK_SMP[4] = {47, 60, 74, 87};   /* a sample's DECAY -4 .. -1: -60 dB in 60, 120, 250, 500 ms */
/* (2.8.8) the kit slices: per user slot (0..3) and lane (0..15), the start and end of the sample (baked
 * samples, end exclusive) and the ADPCM state at the start (pred, idx), so a sliced voice starts there
 * without decoding from the sample start. Stored apart from the sample data — a fifth part of the settings
 * object, backup object 13 — so the editor rewrites them without re-uploading the audio. All zero = no
 * slice: the voice plays the zone whole, as before. */
typedef struct { uint32_t start, end; int16_t pred; uint8_t idx, rsv; } kit_slice_t;
#define KIT_SLICE_PART_N (4u * 16u * 12u)           /* the settings part / backup object 13: 768 bytes */
static kit_slice_t kit_slice[4][16];
/* the part bytes, little-endian (12 per entry: start, end, pred, idx, 0) */
static void kit_slice_fill(uint8_t *b)
{
    uint32_t k, l, o = 0;
    for (k = 0; k < 4u; k++)
        for (l = 0; l < 16u; l++) {
            const kit_slice_t *s = &kit_slice[k][l];
            b[o++] = (uint8_t)s->start; b[o++] = (uint8_t)(s->start >> 8); b[o++] = (uint8_t)(s->start >> 16); b[o++] = (uint8_t)(s->start >> 24);
            b[o++] = (uint8_t)s->end; b[o++] = (uint8_t)(s->end >> 8); b[o++] = (uint8_t)(s->end >> 16); b[o++] = (uint8_t)(s->end >> 24);
            b[o++] = (uint8_t)s->pred; b[o++] = (uint8_t)(s->pred >> 8); b[o++] = s->idx; b[o++] = 0;
        }
}
static int kit_slice_default(const uint8_t *b)
{
    uint32_t i;
    for (i = 0; i < KIT_SLICE_PART_N; i++)
        if (b[i])
            return 0;
    return 1;
}
/* n: KIT_SLICE_PART_N; every entry checked (an off entry is all zero; a set one starts before it ends, its
 * step index 0..88, its end inside the slot's data). A bad entry reads as off, never as a wild slice. */
static void kit_slice_read(const uint8_t *b, uint32_t n)
{
    uint32_t k, l, o = 0;
    if (n != KIT_SLICE_PART_N)
        return;
    for (k = 0; k < 4u; k++)
        for (l = 0; l < 16u; l++) {
            kit_slice_t *s = &kit_slice[k][l];
            s->start = (uint32_t)b[o] | (uint32_t)b[o + 1] << 8 | (uint32_t)b[o + 2] << 16 | (uint32_t)b[o + 3] << 24;
            s->end = (uint32_t)b[o + 4] | (uint32_t)b[o + 5] << 8 | (uint32_t)b[o + 6] << 16 | (uint32_t)b[o + 7] << 24;
            s->pred = (int16_t)((uint32_t)b[o + 8] | (uint32_t)b[o + 9] << 8);
            s->idx = b[o + 10];
            s->rsv = 0;
            o += 12;
            if (s->end && (s->start >= s->end || s->idx > 88u || s->end > 2u * SMP_USER_SIZE))
                *s = (kit_slice_t){0, 0, 0, 0, 0};
        }
}
#define DRUM_CLICK(n) ((n) == 76u || (n) == 77u)    /* (the click's wood block: no lane, never tuned) */
static uint32_t lane_of_note(uint32_t note);
static int drum_tweaked(void)
{
    uint32_t l;
    for (l = 0; l < DRUM_LANES; l++)
        if (drum_tune[l] || drum_dec[l])
            return 1;
    return 0;
}
static uint32_t lane_of_note(uint32_t note)
{
    return note < 35u ? 0u : note > 81u ? 13u : LANE_OF_GM[note - 35u];
}
/* the lane of key k (0 = F3 .. 26 = G5): white keys in order, a black key the white key left of it */
static uint32_t lane_of_key(uint32_t k)
{
    static const int8_t W[12] = {0, -1, 1, -1, 2, -1, 3, 4, -1, 5, -1, 6};   /* from F */
    int32_t i = W[k % 12u];
    if (i < 0)
        i = W[(k - 1u) % 12u];
    return (uint32_t)((int32_t)(k / 12u) * 7 + i) & 15u;
}
/* the white key of lane l (key index), for the key LEDs */
static uint32_t key_of_lane(uint32_t l)
{
    static const uint8_t K[7] = {0, 2, 4, 6, 7, 9, 11};      /* F G A B C D E */
    return (l / 7u) * 12u + K[l % 7u];
}

/* drum steps: a lane's bit, level, ratchet */
static int dstep_has(const dstep_t *s, uint32_t l) { return (s->on[(l >> 3) & 1u] >> (l & 7u)) & 1u; }
static uint32_t dstep_lvl(const dstep_t *s, uint32_t l) { return (s->lvl[(l >> 2) & 3u] >> ((l & 3u) * 2u)) & 3u; }
static uint32_t dstep_rat(const dstep_t *s, uint32_t l) { return (s->rat[(l >> 2) & 3u] >> ((l & 3u) * 2u)) & 3u; }
static uint32_t dstep_mask(const dstep_t *s) { return (uint32_t)s->on[0] | (uint32_t)s->on[1] << 8; }
static void dstep_set(dstep_t *s, uint32_t l, uint32_t lvl, uint32_t rat)   /* lane on, with its level and ratchet */
{
    uint32_t sh = (l & 3u) * 2u, b = (l >> 2) & 3u;
    s->on[(l >> 3) & 1u] |= (uint8_t)(1u << (l & 7u));
    s->lvl[b] = (uint8_t)((s->lvl[b] & ~(3u << sh)) | (lvl & 3u) << sh);
    s->rat[b] = (uint8_t)((s->rat[b] & ~(3u << sh)) | (rat & 3u) << sh);
}
static void dstep_clr(dstep_t *s, uint32_t l)                                /* lane off */
{
    uint32_t sh = (l & 3u) * 2u, b = (l >> 2) & 3u;
    s->on[(l >> 3) & 1u] &= (uint8_t)~(1u << (l & 7u));
    s->lvl[b] &= (uint8_t)~(3u << sh);
    s->rat[b] &= (uint8_t)~(3u << sh);
}

/* the zone a sampled drum voice plays (drum_on: v->s[4]): SMP_ZONES[i], or a user kit's, DZ_USR + slot * 16 + zone */
#define DZ_USR (1 << 16)                 /* (above every SMP_ZONES index) */
static const smp_zone_t *drum_zone_of(const voice_t *v)
{
    int32_t z = v->s[4];
    return z >= DZ_USR ? &usr_zone[((uint32_t)(z - DZ_USR) >> 4) % SMP_USER_SLOTS][(uint32_t)z & 15u] : &SMP_ZONES[(uint32_t)z];
}
/* a user kit (KIT USR1..3): the zone of slot k for the lane note ln (the lane's GM note), -1 = none */
static int32_t drum_usr_zone(uint32_t k, uint32_t ln)
{
    uint32_t j;
    for (j = 0; j < usr_nz[k] && j < 16u; j++)
        if (ln >= usr_zone[k][j].lo && ln <= usr_zone[k][j].hi)
            return DZ_USR + (int32_t)(k * 16u + j);
    return -1;
}

/* the velocity of a level: as played (LV_NORM: vel), ghost, soft, hard */
static uint32_t lvl_vel(uint32_t lvl, uint32_t vel)
{
    static const uint8_t V[4] = {0, 42, 72, 127};
    return lvl & 3u ? V[lvl & 3u] : vel;
}
/* a MIDI velocity -> the level it records as (keys play 100: LV_NORM) */
static uint32_t vel_lvl(uint32_t vel)
{
    return vel < 56u ? LV_GHOST : vel < 88u ? LV_SOFT : vel < 116u ? LV_NORM : LV_HARD;
}

/* the metronome (GLO > GLOBAL > CLICK, and the REC count-in), 2.4.1: a voice of its own, mixed after the drum
 * track (fx.c mix_block), so it is heard with every kit (a user kit has no wood block: it was silent), whatever
 * the drum track's mute, a solo, its filter or slicer. A short sine tick: 1568 Hz on a bar's first beat, 1047 Hz
 * on the others, about 12 ms to fade by 1/e; its level follows GLO > DRUMS > LVL (100: as loud as the old
 * wood block). It costs a few hundred cycles a block while it sounds, nothing after */
static struct { uint32_t ph, inc; int32_t env, gain; } click;   /* env: Q30, 0 = silent */
static uint32_t click_n;                         /* clicks so far, and the last one's accent (the host tests count them) */
static uint8_t click_acc;
static void click_on(int accent)
{
    click.ph = 0;
    click.inc = accent ? (uint32_t)(((uint64_t)1568u << 32) / FS) : (uint32_t)(((uint64_t)1047u << 32) / FS);
    click.gain = accent ? 20000 : 12000;
    click.env = 1 << 30;
    click_acc = (uint8_t)(accent != 0);
    click_n++;
}
static void click_render(int32_t *ml, int32_t *mr, uint32_t n)
{
    uint32_t i;
    int32_t g;
    if (!click.env)
        return;
    g = (int32_t)((int64_t)click.gain * song.g[G_DRLVL] / 100);
    for (i = 0; i < n; i++) {
        int32_t v = (int32_t)(((int64_t)sine_i(click.ph) * (click.env >> 15) >> 15) * g >> 15);
        ml[i] += v;
        mr[i] += v;
        click.ph += click.inc;
        click.env -= click.env >> 9;                 /* about 12 ms to 1/e */
    }
    if (click.env < (1 << 18))
        click.env = 0;                                /* (-72 dB: done, about 100 ms) */
}

/* (2.8.3) the voice for a drum hit: a free voice; all busy, the sound's own voice if it still sounds (it starts over,
 * as on a drum machine: a 16th hi-hat no longer takes every voice with its own tails); else the oldest, a kick last.
 * Up to 2.8.2 the oldest went whatever it was: on a busy beat (16th hats, ride, crash, snare and clap) the kick lost its
 * voice after a step or two and was cut, or not heard at all (a tester's report, "Heads Will Roll") */
static voice_t *drum_pick(uint32_t note)
{
    voice_t *v = 0;
    uint32_t i, best = 0xFFFFFFFFu;
    for (i = 0; i < NDRUM; i++)
        if (!drums.v[i].active)
            return &drums.v[i];
    for (i = 0; i < NDRUM; i++)
        if (drums.v[i].note == note)
            return &drums.v[i];
    for (i = 0; i < NDRUM; i++) {                   /* the oldest that is not a kick; all kicks: the oldest */
        uint32_t kick = drums.v[i].note == 35u || drums.v[i].note == 36u;
        uint32_t key = (kick ? 0x80000000u : 0u) | (drums.v[i].age & 0x7FFFFFFFu);
        if (key < best) {
            best = key;
            v = &drums.v[i];
        }
    }
    return v ? v : &drums.v[0];
}
/* a synthesised voice: note on the 16 sounds snd (a factory kit, SYN1..4), the oldest voice stolen.
 * Returns the drum voice it plays on (2.8.9: kits mode tracks its voice per lane). */
static uint32_t __attribute__((noinline)) drum_synth_on(uint32_t note, uint32_t vel, uint32_t kit, const dsnd_t *snd, uint32_t crush,
                                                    int tweak)
{
    voice_t *v = &drums.v[0];
    uint32_t i;
    if (note == 42u || note == 44u)                 /* hi-hat choke */
        for (i = 0; i < NDRUM; i++)
            if (drums.v[i].active && drums.v[i].note == 46u) {
                drums.v[i].active = 0;
                drums.tail += drums.v[i].s[7];
            }
    v = drum_pick(note);
    if (v->active)
        drums.tail += v->s[7];
    i = (uint32_t)(v - drums.v);
    v->note = (uint8_t)note;
    v->vel = (uint8_t)vel;
    v->active = 1;
    v->s[7] = 0;
    v->age = ++drums.age;
    drums.synth[i] = 1;
    drums.kit[i] = (uint8_t)kit;
    {
        uint32_t ln = lane_of_note(note);
        tweak = tweak && !DRUM_CLICK(note);
        ds_on(&drums.ds[i], snd, crush, note, vel, tweak ? drum_tune[ln] * 16 : 0, tweak ? (uint32_t)(drum_dec[ln] + 4) : 4u);
    }
    return i;
}
/* the editor's audition (editor_dsyn.c DSYN_PLAY): queued, played by the audio ISR (drum_audition_poll) */
static volatile uint8_t dsu_aud_k, dsu_aud_lane, dsu_aud_vel;
static void drum_audition_poll(void)
{
    uint32_t vel = dsu_aud_vel;
    if (!vel)
        return;
    dsu_aud_vel = 0;
    {
        const dsu_kit_t *u = dsu_kit(dsu_aud_k);
        drum_synth_on(DS_LANE_NOTE[dsu_aud_lane % DS_LANES], vel, DRUM_SYN + dsu_aud_k % DSU_N, u->s, u->crush, 0);   /* (as designed) */
    }
}

/* A drum hit on the selected preset's kit (drum_on), or on a forced kit (drum_on_kit: kits mode forces
 * the user kit being edited). Returns the drum voice it plays on, or -1 when nothing plays (a note with
 * no lane, an empty slot, no sound on the lane). The sequencer and live hits both come through here
 * (voice.c trk_note_on); kits mode does not change this function, it only forces the kit for live hits
 * (drum_kit_on below, called from drum_input instead of trk_note_on). */
static int drum_on_kit(uint32_t note, uint32_t vel, int32_t kit_force)
{
    int32_t si = drum_set();
    const smp_set_t *set;
    voice_t *v = &drums.v[0];
    uint32_t i, zi = 0xFFFFu, kit = kit_force >= 0 ? (uint32_t)kit_force : drum_kit();
    uint32_t lane = DRUM_LANE_NONE, uslot = 0;      /* (2.8.8) the lane hit, and the user slot it plays from */
    int32_t zid = -1;
    if (lane_of_note(note) == DRUM_LANE_NONE)
        return -1;                                  /* a note with no lane plays nothing */
    lane = lane_of_note(note);
    if (note != 76u && note != 77u)                 /* the pads and key LEDs (not the click's wood block) */
        drums.hits |= (uint16_t)(1u << lane);
    if (note == 35u || note == 36u)
        drums.kick = 1;                             /* (DUCK) */
    if (kit >= DRUM_SYN) {                          /* SYN1..SYN4: your synthesised kit */
        const dsu_kit_t *u = dsu_kit(kit - DRUM_SYN);
        return (int)drum_synth_on(note, vel, kit, u->s, u->crush, 1);
    }
    if (kit >= DRUM_USR) {                          /* a user kit: the lane's sound, as its note (the hat choke) */
        if (note == 76u || note == 77u)
            return -1;                              /* (the click's wood block: not a lane) */
        note = LANE_NOTE[lane];
        if (kit == DRUM_PAIR) {                     /* USR3+4: the lane's sound in USR3, else in USR4 */
            zid = drum_usr_zone(2, note);
            uslot = 2;
            if (zid < 0) {
                zid = drum_usr_zone(3, note);
                uslot = 3;
            }
        } else {
            uslot = kit - DRUM_USR;
            zid = drum_usr_zone(uslot, note);
        }
        if (zid < 0)
            return -1;                              /* (an empty slot, or no sound on this lane) */
    } else if (kit >= DRUM_SAMPLED) {               /* synthesised kit */
        return (int)drum_synth_on(note, vel, kit, DS_KITS[kit - DRUM_SAMPLED].s, DS_KITS[kit - DRUM_SAMPLED].crush, 1);
    }
    if (zid < 0) {                                  /* the GM sample kit */
        if (si < 0)
            return -1;
        set = &SMP_SETS[si];
        for (i = 0; i < set->nz; i++)
            if (note >= SMP_ZONES[set->z0 + i].lo && note <= SMP_ZONES[set->z0 + i].hi)
                zi = set->z0 + i;
        if (zi == 0xFFFFu)
            return -1;
        zid = (int32_t)zi;
    }
    if (note == 42u || note == 44u)                 /* hi-hat choke */
        for (i = 0; i < NDRUM; i++)
            if (drums.v[i].active && drums.v[i].note == 46u) {
                drums.v[i].active = 0;
                drums.tail += drums.v[i].s[7];          /* fade what it was playing, not a step */
            }
    v = drum_pick(note);                            /* (2.8.3: a free one, its own, else the oldest but a kick) */
    if (v->active)
        drums.tail += v->s[7];                      /* stolen voice: fade its last value */
    v->note = (uint8_t)note;
    v->vel = (uint8_t)vel;
    v->active = 1;
    v->s[7] = 0;
    v->age = ++drums.age;
    v->s[4] = zid;
    v->ph[0] = v->ph[1] = 0;
    v->s[0] = v->s[1] = v->s[2] = 0;
    v->s[6] = 0;                                    /* (2.8.8) the slice end, 0 = the zone whole */
    {
        const smp_zone_t *z = drum_zone_of(v);
        /* (2.8.8) a sliced user-kit voice starts at the slice, with the ADPCM state there, and ends at
         * its end (clamped to the zone: a slice past the zone plays to the zone's end) */
        if (kit >= DRUM_USR && lane < DRUM_LANES) {
            const kit_slice_t *sl = &kit_slice[uslot][lane];
            if (sl->end && sl->start < z->n) {
                v->ph[0] = sl->start;
                v->s[0] = sl->pred;
                v->s[1] = sl->idx;
                v->s[6] = (int32_t)(sl->end < z->n ? sl->end : z->n);
            }
        }
        v->s[3] = sample_next(z, v, 0);
        /* (after 2.8.3) clamped: a user kit zone's root is not checked (a typed root of 300 shifted by 2^20) */
        v->s[5] = (int32_t)((pow2_q16(clamp((int32_t)note * 16 - z->root16, -1536, 2047)) >> 8) * (z->rate >> 8));
    }
    {
        uint32_t vi = (uint32_t)(v - drums.v);
        uint32_t ln = lane_of_note(v->note), tw = !DRUM_CLICK(v->note);
        int32_t shift = kit == 1u ? (note <= 36u ? -5 : -2) : kit == 3u ? 2 : kit == 4u ? -1 : 0;
        drums.kit[vi] = (uint8_t)kit;
        drums.synth[vi] = 0;
        drums.filter[vi] = 0;
        drums.env[vi] = 32767;
        drums.denv[vi] = 32767;                     /* (2.7) DECAY below 0: a fade to -60 dB in 60 .. 500 ms (DK_SMP) */
        drums.dk[vi] = tw && drum_dec[ln] < 0 ? DECAY_K[DK_SMP[drum_dec[ln] + 4]] : 0u;
        shift = shift * 16 + (tw ? drum_tune[ln] * 16 : 0);    /* (2.7) TUNE: the sound's semitones */
        if (shift) {
            const smp_zone_t *z = drum_zone_of(v);
            v->s[5] = (int32_t)((pow2_q16(clamp((int32_t)note * 16 + shift - z->root16, -1536, 2047)) >> 8) * (z->rate >> 8));
        }
    }
    return (int)(v - drums.v);
}
static void drum_on(uint32_t note, uint32_t vel) { (void)drum_on_kit(note, vel, -1); }   /* the preset's kit */

/* (2.8.9) KITS MODE (protocol v17): while the editor's Kits tab is active it sends KITS_MODE with the
 * slot being edited (1..4 USR1..USR4, 5 USR3+4); live drum hits then play that user kit instead of the
 * selected preset (drum_input, seq.c), with the chop markers (kit_slice) as a preset kit would. The
 * sequencer never goes through here (it calls trk_note_on, voice.c), so its playback keeps the preset.
 * Per-lane voice tracking (kit_voice / kit_age) is for KITS_STOP: a lane's voice is the drum voice that
 * started its sample, found again by its age (a stolen or restarted voice has another age, so a stop
 * never silences a preset sound that took the voice). A second hit on a sounding lane restarts it the
 * way drum_on always has: drum_pick takes its own voice again and its last output fades through
 * drums.tail, so the sample starts from silence (cf. voice.c 2.8.3, the SAMPLE / SLICE retrigger rule:
 * a sample played again on a voice still sounding fades it out first and starts from silence). */
static uint8_t kits_mode;                 /* 0 off, 1..4 the user slot, 5 the USR3+4 pair */
static int8_t kit_voice[DRUM_LANES] = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
static uint32_t kit_age[DRUM_LANES];
static uint32_t kits_kit(void) { return kits_mode == 5u ? DRUM_PAIR : DRUM_USR + kits_mode - 1u; }
/* stop one lane's kit voice (0..15) or all of them (0xFF; on the wire 127: a SysEx data byte is 7 bit,
 * as DP_LEARN's 127 sentinel). The voice is cut the way the hi-hat choke cuts one: its last output
 * joins the tail and it goes inactive, so there is no click. A lane whose voice ended or was stolen is
 * already gone (its age moved on): nothing to stop. Call with the audio IRQ off, or from the audio ISR. */
static void kit_stop_locked(uint32_t lane)
{
    uint32_t l, all = lane == 0xFFu || lane == 127u, from = all ? 0u : lane, n = all ? DRUM_LANES : lane + 1u;
    if (!all && lane >= DRUM_LANES)
        return;
    for (l = from; l < n; l++) {
        int vi = kit_voice[l];
        kit_voice[l] = -1;
        if (vi < 0 || vi >= (int)NDRUM)
            continue;
        if (drums.v[vi].active && drums.v[vi].age == kit_age[l] && !drums.synth[vi]) {
            drums.tail += drums.v[vi].s[7];
            drums.v[vi].active = 0;
        }
    }
}
static int drum_kit_on(uint32_t lane, uint32_t vel)   /* a live hit in kits mode: the slot's sound for the lane, or nothing */
{
    int vi;
    if (!kits_mode || lane >= DRUM_LANES)
        return -1;
    /* a second hit while the lane's voice still sounds restarts it: cut the old voice first (its last
     * output fades through the tail) and start from silence, as a SAMPLE / SLICE note played again on
     * its voice (voice.c 2.8.3) — drum_pick would otherwise take a free voice and layer a second copy */
    kit_stop_locked(lane);
    vi = drum_on_kit(LANE_NOTE[lane], vel, (int32_t)kits_kit());
    if (vi < 0)
        return -1;                                  /* (an empty box: play nothing) */
    kit_voice[lane] = (int8_t)vi;
    kit_age[lane] = drums.v[vi].age;
    return vi;
}
static void drum_kit_stop(uint32_t lane)   /* the editor's KITS_STOP (main loop): the audio IRQ off around the cut */
{
    fm1_irq_off();
    kit_stop_locked(lane);
    fm1_irq_on();
}
static void kits_mode_set(uint32_t mode)   /* the editor's KITS_MODE (main loop): 0 off, 1..4 a slot, 5 the pair */
{
    if (mode > 5u || mode == kits_mode)
        return;                                     /* (the same mode again: a playing preview is not cut) */
    fm1_irq_off();
    kits_mode = (uint8_t)mode;
    kit_stop_locked(0xFFu);                         /* a voice from the old slot must not outlive the mode */
    fm1_irq_on();
}

/* adds the drums into the dry mix and the reverb and delay sends; mono != 0: into mono instead, before
 * the pan and the sends (the SLICER, slicer.c slicer_drums, does those after it) */
static inline void drums_mix(int32_t *ml, int32_t *mr, int32_t *rev, int32_t *dly, int32_t *mono, uint32_t n)
{
    uint32_t k, i;
    int32_t lvl = expr_gain(song.g[G_DRLVL] * 200, TRK_DRUM), send = send_thr(song.g[G_DRREV] * 258, thr_rev),
            dsend = send_thr(song.g[G_DRDLY] * 258, thr_dly), pk = drums.peak;   /* (2.6: the THROWs) */
    int32_t pan = trk[TRK_DRUM].p[P_PAN], gl = 4096 - (pan > 0 ? pan * 64 : 0), gr = 4096 + (pan < 0 ? pan * 64 : 0);
    if (!drums.gon)                                 /* (2.7) LEVEL and PAN glide, block by block (mix_glide) */
        drums.glv = lvl, drums.ggl = gl, drums.ggr = gr, drums.gon = 1;
    lvl = drums.glv = mix_glide(drums.glv, lvl);
    gl = drums.ggl = mix_glide(drums.ggl, gl);
    gr = drums.ggr = mix_glide(drums.ggr, gr);
    for (i = 0; i < n && drums.tail; i++) {         /* declick tail, ~0.4 ms */
        if (mono) {
            mono[i] += drums.tail;
        } else {
            ml[i] += drums.tail;
            mr[i] += drums.tail;
        }
        drums.tail -= drums.tail / 16 + (drums.tail > 0 ? 1 : drums.tail < 0 ? -1 : 0);
    }
    for (k = 0; k < NDRUM; k++) {               /* synthesised voices: render, then as below */
        voice_t *v = &drums.v[k];
        uint32_t m = n < CTL ? n : CTL;             /* (the mix runs in blocks of CTL) */
        if (!v->active || !drums.synth[k])
            continue;
        if (!ds_render(&drums.ds[k], ds_buf, m))
            v->active = 0;
        for (i = 0; i < m; i++) {
            int32_t s = mulq15(ds_buf[i], mulq15(lvl, 32767 - drums.a0 - (((drums.a1 - drums.a0) * (int32_t)i) >> CTL_LOG2)));
            s = DRUM_VOICE_FX(k, s);
            v->s[7] = s;
            if (s > pk || -s > pk)
                pk = s < 0 ? -s : s;
            if (mono) {
                mono[i] += s;
                continue;
            }
            ml[i] += (s * DRUM_VOICE_GL(k, gl)) >> 12;
            mr[i] += (s * DRUM_VOICE_GR(k, gr)) >> 12;
            if (send)
                rev[i] += mulq15(s, send);
            if (dsend)
                dly[i] += mulq15(s, dsend);
        }
        if (!v->active) {
            drums.tail += v->s[7];                  /* ended: no step at the end */
            v->s[7] = 0;
        }
    }
    for (k = 0; k < NDRUM; k++) {
        voice_t *v = &drums.v[k];
        const smp_zone_t *z;
        if (drums.synth[k])
            continue;
        z = drum_zone_of(v);
        uint32_t frac = v->ph[1], stepq = (uint32_t)v->s[5];   /* Q16 source samples per output (drum_on) */
        int32_t g;
        if (!v->active)
            continue;
        g = mulq15(lvl, v->vel * 258);
        g += g * 3 >> 2;                           /* x1.75 (+5 dB): as loud as the synthesised kits */
        for (i = 0; i < n; i++) {
            int32_t s;
            frac += stepq;
            while (frac >= 65536u) {
                frac -= 65536u;
                v->s[2] = v->s[3];
                if (v->ph[0] >= (v->s[6] ? (uint32_t)v->s[6] : z->n)) {   /* (2.8.8) a slice ends at its end */
                    v->active = 0;
                    break;
                }
                v->s[3] = sample_next(z, v, 0);
            }
            if (!v->active)
                break;
            s = v->s[2] + (((v->s[3] - v->s[2]) * (int32_t)(frac >> 1)) >> 15);
            s = mulq15(s, mulq15(g, 32767 - drums.a0 - (((drums.a1 - drums.a0) * (int32_t)i) >> CTL_LOG2)));
            if (drums.kit[k] == 1u || drums.kit[k] == 4u) {
                drums.filter[k] += (s - drums.filter[k]) >> (drums.kit[k] == 1u ? 2 : 1);
                s = drums.filter[k];
                if (drums.kit[k] == 4u) s = (s >> 8) * 256;
            } else if (drums.kit[k] == 2u) {
                s = mulq15(s, drums.env[k]);
                drums.env[k] -= (drums.env[k] >> 11) + 1;
                if (drums.env[k] <= 0) v->active = 0;
            }
            if (drums.dk[k]) {                      /* (2.7) a shorter DECAY: the sample fades out */
                s = mulq15(s, drums.denv[k]);
                drums.denv[k] = (int32_t)(((uint32_t)drums.denv[k] * drums.dk[k]) >> 16);
                if (drums.denv[k] < 8) v->active = 0;
            }
            s = DRUM_VOICE_FX(k, s);
            v->s[7] = s;
            if (s > pk || -s > pk)
                pk = s < 0 ? -s : s;
            if (mono) {
                mono[i] += s;
                continue;
            }
            ml[i] += (s * DRUM_VOICE_GL(k, gl)) >> 12;
            mr[i] += (s * DRUM_VOICE_GR(k, gr)) >> 12;
            if (send)
                rev[i] += mulq15(s, send);
            if (dsend)
                dly[i] += mulq15(s, dsend);
        }
        v->ph[1] = frac;
    }
    {   /* (2.8.9) kits mode: forget the lanes whose voice ended or was stolen (its age moved on) */
        uint32_t l;
        for (l = 0; l < DRUM_LANES; l++)
            if (kit_voice[l] >= 0 && (!drums.v[kit_voice[l]].active || drums.v[kit_voice[l]].age != kit_age[l]))
                kit_voice[l] = -1;
    }
    drums.peak = pk;
}
static void drums_render(int32_t *ml, int32_t *mr, int32_t *rev, int32_t *dly, uint32_t n) { drums_mix(ml, mr, rev, dly, 0, n); }
static void drums_render_mono(int32_t *mono, uint32_t n) { drums_mix(0, 0, 0, 0, mono, n); }
