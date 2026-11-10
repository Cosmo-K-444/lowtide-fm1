/* SPDX-License-Identifier: GPL-3.0-only */
/* Lowtide 2.8.9: kits mode (protocol v17, firmware/src/drums.c kits_mode). Lowtide 2.8.10 (protocol
 * v18): a slice with end == 0 runs to the end of the sample, and the markers reach the firmware
 * through kit_slice_read (backup object 13) as well as through RAM. Through hostsim.c, the slots
 * in a RAM image of the flash (SMP_USER_XIP) read by smp_user_scan as at boot (as tests/userkit_test.c):
 *   kits off: a live hit (drum_input) plays the selected preset; kits on: it plays the user kit in the
 *     slot KITS_MODE names, keyed by lane note, with the chop markers (kit_slice); an empty lane is silent
 *   a second hit on a sounding lane restarts it (its age moves on); KITS_STOP stops one lane, 127 stops all
 *   the sequencer's path (drum_on) keeps the selected preset while kits mode is on
 *   changing the mode (including back to 0) stops the kit voices sounding; the same mode again does not
 *   USR3+4 (mode 5) takes a lane's sound from USR3, else USR4 */
#include <stdint.h>
static uint32_t host_slots[4u * 0x14000u / 4u];          /* USR1..4 (a RAM image: the flash has USR4 elsewhere) */
#define SMP_USER_XIP(k) ((const uint8_t *)host_slots + (k) * SMP_USER_SIZE)
#define main hostsim_main
#include "hostsim.c"
#undef main
#include "../firmware/hal/fm1_flash.h"                /* (the flash map: FL_STORE_OK; nothing of it runs here) */

static int fails;
static void check(int ok, const char *what) { printf("kitsmode: %-70s %s\n", what, ok ? "ok" : "FAIL"); fails += !ok; }

/* slot k: a zone per (note, samples) pair; ADPCM nibbles alternating up / down (a square-ish wave) */
static void slot_build(uint32_t k, const uint8_t *notes, const uint32_t *lens, uint32_t nz)
{
    uint8_t *img = (uint8_t *)host_slots + k * SMP_USER_SIZE, *d = img + SMP_USER_DATA;
    smp_user_hdr_t *h = (smp_user_hdr_t *)img;
    uint32_t i, off = 0, j;
    memset(img, 0xFF, SMP_USER_SIZE);
    memset(h, 0, sizeof *h);
    h->magic = SMP_USER_MAGIC;
    h->version = 1;
    h->nz = (uint8_t)nz;
    memcpy(h->name, "KIT", 4);
    for (i = 0; i < nz; i++) {
        smp_zone_t *z = &h->zone[i];
        uint32_t bytes = (lens[i] + 1u) / 2u;
        for (j = 0; j < bytes; j++)
            d[off + j] = (j / 8u) & 1u ? 0xFFu : 0x77u;  /* up a while, then down (big steps) */
        z->off = off; z->n = lens[i]; z->ls = 0; z->le = lens[i] - 1u;
        z->rate = 0x8000u;                               /* 22050 / 44100 */
        z->root16 = (int16_t)(notes[i] * 16);
        z->pred = 0; z->idx = 0; z->lo = notes[i]; z->hi = notes[i]; z->looped = 0;
        off += bytes;
    }
    h->data_len = off;
    smp_user_scan(k);
}

static int32_t run_peak(uint32_t blocks)
{
    static int32_t o[CTL * 2];
    int32_t pk = 0;
    uint32_t b, i;
    for (b = 0; b < blocks; b++) {
        mix_block(o, CTL);
        for (i = 0; i < CTL * 2u; i++) { int32_t a = o[i] < 0 ? -o[i] : o[i]; if (a > pk) pk = a; }
    }
    return pk;
}
static void quiet(void) { uint32_t i; for (i = 0; i < NDRUM; i++) drums.v[i].active = 0; drums.tail = 0; run_peak(3u * FS / CTL); }
static int kit_voice_idx(int32_t zid)   /* the active sampled voice playing zone zid, or -1 */
{
    uint32_t i;
    for (i = 0; i < NDRUM; i++)
        if (drums.v[i].active && !drums.synth[i] && drums.v[i].s[4] == zid)
            return (int)i;
    return -1;
}
static uint32_t synth_on(void)
{
    uint32_t i, n = 0;
    for (i = 0; i < NDRUM; i++)
        n += drums.v[i].active && drums.synth[i];
    return n;
}

int main(void)
{
    static const uint8_t notes1[4] = {36, 38, 42, 46};     /* USR1: KICK, SNARE, HAT, OPEN HAT */
    static const uint32_t lens1[4] = {40000, 3000, 2000, 16000};   /* the kick is long (for KITS_STOP) */
    static const uint8_t notes3[1] = {38};                 /* USR3: SNARE only */
    static const uint32_t lens3[1] = {3000};
    static const uint8_t notes4[1] = {42};                 /* USR4: HAT only */
    static const uint32_t lens4[1] = {2000};
    int32_t pk;
    int vi;
    uint32_t age0;
    if ((uintptr_t)host_slots < (uintptr_t)SMP_DATA || (uintptr_t)host_slots - (uintptr_t)SMP_DATA > 0xF0000000u) {
        printf("kitsmode: the slot image must lie above SMP_DATA within 4 GiB (32-bit offsets)\n");
        return 1;
    }
    host_tracks_init();
    song.g[G_BPM] = 120;
    song.g[G_DRREV] = 0;                                 /* (no reverb tail between the checks) */
    slot_build(0, notes1, lens1, 4);
    slot_build(2, notes3, lens3, 1);
    slot_build(3, notes4, lens4, 1);
    check(usr_nz[0] == 4u && !usr_nz[1] && usr_nz[2] == 1u && usr_nz[3] == 1u, "USR1 / USR3 / USR4 read by smp_user_scan; USR2 empty");

    TDRUM->p[P_E0] = (int16_t)DRUM_SAMPLED;              /* 808: the selected preset */
    quiet();
    drum_input(0, LV_NORM, 0, 1);                        /* kits mode off: the preset, not USR1 */
    check(synth_on() == 1u && kit_voice_idx(DZ_USR + 0) < 0, "kits off: a live hit plays the selected preset (808)");
    quiet();

    kits_mode_set(1);                                    /* USR1 */
    drum_input(0, LV_NORM, 0, 1);
    check(kit_voice_idx(DZ_USR + 0) >= 0 && synth_on() == 0u && run_peak(10) > 2000,
          "kits on (USR1): a live hit plays the slot's KICK, not the preset");
    quiet();
    drum_input(8, LV_NORM, 0, 1);                        /* SNARE 2 (note 40): no sound in USR1 */
    check(kit_voice_idx(DZ_USR + 0) < 0 && synth_on() == 0u && run_peak(10) < 64,
          "kits on: a lane with no sample plays nothing");
    quiet();

    {   /* the chop markers (2.8.8): the voice starts at the slice, with its end, and ends there */
        kit_slice[0][0].start = 4000; kit_slice[0][0].end = 6000; kit_slice[0][0].pred = 0; kit_slice[0][0].idx = 0;
        drum_input(0, LV_NORM, 0, 1);
        vi = kit_voice_idx(DZ_USR + 0);
        check(vi >= 0 && drums.v[vi].ph[0] >= 4000u && drums.v[vi].ph[0] < 4020u && drums.v[vi].s[6] == 6000,
              "kits on: a sliced voice starts at the slice start and ends at its end");
        pk = run_peak(10);
        check(pk > 2000 && kit_voice_idx(DZ_USR + 0) >= 0, "... and it sounds");
        run_peak(200);
        check(kit_voice_idx(DZ_USR + 0) < 0, "... and it ends at the slice end, not the zone end");
        memset(kit_slice, 0, sizeof kit_slice);          /* (no slices for the tests after) */
    }
    quiet();

    {   /* (2.8.10) all zero is still no slice: the voice plays the zone whole, from 0 */
        drum_input(0, LV_NORM, 0, 1);
        vi = kit_voice_idx(DZ_USR + 0);
        check(vi >= 0 && drums.v[vi].ph[0] < 20u && drums.v[vi].s[6] == 0,
              "no slice: start 0, end 0 plays the zone whole from 0");
        pk = run_peak(10);
        check(pk > 2000 && kit_voice_idx(DZ_USR + 0) >= 0, "... and it sounds");
    }
    quiet();

    {   /* (2.8.10) a slice with a start and end == 0 runs from the start to the sample end */
        kit_slice[0][0].start = 4000; kit_slice[0][0].end = 0; kit_slice[0][0].pred = 0; kit_slice[0][0].idx = 0;
        drum_input(0, LV_NORM, 0, 1);
        vi = kit_voice_idx(DZ_USR + 0);
        check(vi >= 0 && drums.v[vi].ph[0] >= 4000u && drums.v[vi].ph[0] < 4020u && drums.v[vi].s[6] == 40000,
              "end == 0: a sliced voice starts at the slice start and ends at the zone end");
        pk = run_peak(10);
        check(pk > 2000 && kit_voice_idx(DZ_USR + 0) >= 0, "... and it sounds");
        run_peak(200);                                   /* (36000 samples to play: far more than 200 blocks) */
        check(kit_voice_idx(DZ_USR + 0) >= 0, "... and it is still sounding past the old slice length");
        run_peak(2300);
        check(kit_voice_idx(DZ_USR + 0) < 0, "... and it ends at the zone end");
        memset(kit_slice, 0, sizeof kit_slice);
    }
    quiet();

    {   /* (2.8.10) the markers through kit_slice_read (backup object 13, as BK_PUT commits them):
         * a marker edit after a first hit applies to the next hit, and bad entries read as off */
        static uint8_t part[KIT_SLICE_PART_N];
        drum_input(0, LV_NORM, 0, 1);                    /* (a first hit with no slice) */
        vi = kit_voice_idx(DZ_USR + 0);
        check(vi >= 0 && drums.v[vi].s[6] == 0, "markers via object 13: the first hit plays the zone whole");
        quiet();
        memset(part, 0, sizeof part);
        /* slot 0 lane 0: start 4000, end 0 (to the sample end); lane 1: start past end (bad);
         * lane 2: end 0 but a step index past 88 (bad) */
        part[0] = 4000 & 255; part[1] = (4000 >> 8) & 255;
        part[12] = 6000 & 255; part[13] = (6000 >> 8) & 255; part[16] = 4000 & 255; part[17] = (4000 >> 8) & 255;
        part[24] = 1000 & 255; part[25] = (1000 >> 8) & 255; part[34] = 89;
        kit_slice_read(part, KIT_SLICE_PART_N);
        check(kit_slice[0][0].start == 4000u && kit_slice[0][0].end == 0u &&
              !kit_slice[0][1].start && !kit_slice[0][1].end &&
              !kit_slice[0][2].start && !kit_slice[0][2].end,
              "... the read keeps a start with end == 0 and zeroes the bad entries");
        drum_input(0, LV_NORM, 0, 1);
        vi = kit_voice_idx(DZ_USR + 0);
        check(vi >= 0 && drums.v[vi].ph[0] >= 4000u && drums.v[vi].ph[0] < 4020u && drums.v[vi].s[6] == 40000,
              "... and the next hit uses the written markers");
        memset(kit_slice, 0, sizeof kit_slice);
    }
    quiet();

    {   /* a second hit on a sounding lane restarts it (its age moves on) */
        drum_input(0, LV_NORM, 0, 1);
        run_peak(2);
        vi = kit_voice_idx(DZ_USR + 0);
        check(vi >= 0, "retrigger: the first hit sounds");
        age0 = drums.v[vi].age;
        drum_input(0, LV_NORM, 0, 1);
        vi = kit_voice_idx(DZ_USR + 0);
        check(vi >= 0 && drums.v[vi].age > age0, "... a second hit restarts the same lane's voice");
    }
    quiet();

    {   /* KITS_STOP: one lane, then all (127) */
        drum_input(0, LV_NORM, 0, 1);
        drum_input(2, LV_NORM, 0, 1);
        run_peak(2);
        check(kit_voice_idx(DZ_USR + 0) >= 0 && kit_voice_idx(DZ_USR + 1) >= 0, "stop: two lanes sounding");
        drum_kit_stop(0);
        check(kit_voice_idx(DZ_USR + 0) < 0 && kit_voice_idx(DZ_USR + 1) >= 0,
              "... KITS_STOP 0 stops only that lane");
        drum_kit_stop(127);
        check(kit_voice_idx(DZ_USR + 1) < 0, "... KITS_STOP 127 stops all kit voices");
        drum_kit_stop(3);                                /* (nothing sounding: no crash, no voice) */
        check(kit_voice_idx(DZ_USR + 0) < 0 && synth_on() == 0u, "... stopping a silent lane stops nothing");
    }
    quiet();

    {   /* the sequencer keeps the preset while kits mode is on (drum_on, the sequencer's path) */
        drum_on(36, 110);
        check(synth_on() == 1u && kit_voice_idx(DZ_USR + 0) < 0, "sequencer: drum_on plays the preset, not the kit");
    }
    quiet();

    {   /* changing the mode stops the kit voices sounding; the same mode again does not */
        drum_input(0, LV_NORM, 0, 1);
        run_peak(2);
        check(kit_voice_idx(DZ_USR + 0) >= 0, "mode change: a kit voice sounding");
        kits_mode_set(1);                                /* (the same mode: not cut) */
        check(kit_voice_idx(DZ_USR + 0) >= 0, "... re-sending the same mode does not cut it");
        kits_mode_set(2);                                /* USR2 (empty): the old slot's voice ends */
        check(kit_voice_idx(DZ_USR + 0) < 0, "... changing the slot stops the old slot's voice");
        kits_mode_set(0);
        drum_input(0, LV_NORM, 0, 1);
        check(synth_on() == 1u && kit_voice_idx(DZ_USR + 0) < 0, "... mode off: a live hit plays the preset again");
    }
    quiet();

    {   /* USR3+4 (mode 5): the lane's sound from USR3, else USR4; a lane in neither is silent */
        kits_mode_set(5);
        drum_input(2, LV_NORM, 0, 1);                    /* SNARE: USR3, zone 0 */
        check(kit_voice_idx(DZ_USR + 2u * 16u + 0) >= 0, "USR3+4: SNARE comes from USR3");
        quiet();
        drum_input(4, LV_NORM, 0, 1);                    /* HAT: USR4, zone 0 */
        check(kit_voice_idx(DZ_USR + 3u * 16u + 0) >= 0, "... HAT comes from USR4");
        quiet();
        drum_input(0, LV_NORM, 0, 1);                    /* KICK: in neither slot */
        check(synth_on() == 0u && run_peak(10) < 64, "... KICK, in neither slot, is silent");
        kits_mode_set(0);
    }
    quiet();
    printf("kitsmode: %s\n", fails ? "FAILED" : "kits mode (v18) PASS");
    return fails != 0;
}
