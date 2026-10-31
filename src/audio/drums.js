// Synthesized drum voices (no samples). Each hit builds short-lived nodes that
// stop themselves; playHit() then disconnects them so they can be collected.
//
// Voice signature: (v, P) where
//   v = { ctx, out, noise, kit, t, acc }  (kit holds per-machine state like hat chokes)
//   P(key) -> knob value 0..1 for the voice's group

const T60 = 1 / 6.9; // setTargetAtTime tau factor: reaches -60 dB at `decay`
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800]; // inharmonic square bank

const lvl = (x) => x * x * 1.3;

function env(v, peak, decay, attack = 0.0015, at = v.t) {
  const g = v.ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + attack);
  g.gain.setTargetAtTime(0, at + attack, decay * T60);
  return g;
}

// ReBirth's sample voices hold the sample at full gain for `hold`, then fade fast
// (0.998 per sample pair: ~23 ms). A gain stage of its own after the voice's
// envelope: more events on one gain param spiked the attack in long renders.
const HOLD_FADE = 2 / 44100 / -Math.log(0.998);
function holdGate(v, hold) {
  const g = v.ctx.createGain();
  g.gain.setValueAtTime(1, v.t);
  g.gain.setTargetAtTime(0, v.t + hold, HOLD_FADE);
  return g;
}

// A fast drop to `tail` (fraction of the peak) followed by a long decay: metal
// voices ring on long after their bright attack.
function env2(v, peak, fast, tail, slow, attack = 0.001) {
  const g = v.ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(0, v.t);
  p.linearRampToValueAtTime(peak, v.t + attack);
  p.setTargetAtTime(peak * tail, v.t + attack, fast * T60);
  p.setTargetAtTime(0, v.t + attack + fast * 0.5, slow * T60);
  return g;
}

function osc(v, type, hz) {
  const o = v.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(hz, v.t);
  return o;
}

function noise(v) {
  const n = v.ctx.createBufferSource();
  n.buffer = v.noise;
  n.loop = true;
  return n;
}

function filter(v, type, hz, Q = 0.7) {
  const f = v.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = Q;
  return f;
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

// Noise starts somewhere new for each hit, picked from the hit's time rather than
// at random, so a song renders the same every time (stems add up to the mix).
const noiseOffset = (t, duration) => ((t * 7919.618) % 1) * (duration - 0.1);

function run(v, src, dur) {
  if (src.buffer) src.start(v.t, noiseOffset(v.t, src.buffer.duration));
  else src.start(v.t);
  src.stop(v.t + dur);
  if (v.t + dur >= v.end) {
    v.end = v.t + dur;
    v.last = src;
  }
}

// Every hit plays through its own bus, disconnected once its last source ends.
// Left connected, finished hits kept costing render time, which grew faster
// than the song length (offline renders slowed down more and more).
export function playHit(voice, v, P) {
  const bus = v.ctx.createGain();
  bus.connect(v.out);
  const hit = { ...v, out: bus, end: 0, last: null };
  voice(hit, P);
  if (hit.last) hit.last.onended = () => bus.disconnect();
  else bus.disconnect();
}

// Six detuned squares summed: the classic analog metallic source.
function metal(v, scale, dur) {
  const sum = v.ctx.createGain();
  sum.gain.value = 1 / METAL.length;
  for (const hz of METAL) {
    const o = osc(v, 'square', hz * scale);
    o.connect(sum);
    run(v, o, dur);
  }
  return sum;
}

// Pitch falls from base * sweep to base, either reaching it at sweepTime or, with
// `settle` (time constant), approaching it gradually.
// harm: level of a second harmonic that follows the same sweep.
function kick(v, { base, sweep, sweepTime, settle, decay, level, click, clickHz = 3500, harm = 0 }) {
  for (const [mul, gain] of harm ? [[1, 1], [2, harm]] : [[1, 1]]) {
    const o = osc(v, 'sine', base * sweep * mul);
    if (settle) o.frequency.setTargetAtTime(base * mul, v.t, settle);
    else o.frequency.exponentialRampToValueAtTime(base * mul, v.t + sweepTime);
    chain(o, env(v, level * gain, decay, 0.001), v.out);
    run(v, o, decay + 0.05);
  }
  if (click > 0) {
    const n = noise(v);
    chain(n, filter(v, 'lowpass', clickHz), env(v, level * click, 0.012, 0.0005), v.out);
    run(v, n, 0.03);
  }
}

// tones: [hz, level, decay, fast?] drum heads, sine, falling from hz * sweep over
// 20 ms; `fast` adds a quick drop to a fifth of the level before the decay.
// noiseHold: the noise as a ReBirth sample voice, cut by holdGate after noiseHold s.
function snare(v, { tones, sweep = 1, noiseHp, noiseLp, noiseDecay, noiseLevel, noiseHold = null }) {
  for (const [hz, level, decay, fast] of tones) {
    const o = osc(v, 'sine', hz * sweep);
    o.frequency.exponentialRampToValueAtTime(hz, v.t + 0.02);
    chain(o, fast ? env2(v, level, fast, 0.2, decay, 0.0015) : env(v, level, decay), v.out);
    run(v, o, decay + 0.05);
  }
  const n = noise(v);
  const out = chain(n, filter(v, 'highpass', noiseHp), filter(v, 'lowpass', noiseLp), env(v, noiseLevel, noiseDecay));
  if (noiseHold === null) out.connect(v.out);
  else chain(out, holdGate(v, noiseHold), v.out);
  run(v, n, (noiseHold === null ? noiseDecay : Math.min(noiseDecay, noiseHold + 0.1)) + 0.05);
}

// click: a short broadband noise burst on the attack.
function tom(v, { hz, decay, level, noiseAmt = 0, sweep = 1.35, sweepTime = 0.06, click = 0, attack = 0.0015 }) {
  const o = osc(v, 'sine', hz * sweep);
  o.frequency.exponentialRampToValueAtTime(hz, v.t + sweepTime);
  chain(o, env(v, level, decay, attack), v.out);
  run(v, o, decay + 0.05);
  if (click) {
    const n = noise(v);
    chain(n, filter(v, 'lowpass', 6000), env(v, level * click, 0.04, 0.0005), v.out);
    run(v, n, 0.06);
  }
  if (noiseAmt) {
    const n = noise(v);
    chain(n, filter(v, 'bandpass', hz * 4, 1), env(v, level * noiseAmt, decay * 0.3), v.out);
    run(v, n, decay * 0.3 + 0.05);
  }
}

function rim(v, level, bright = 1) {
  for (const [hz, type] of [[480, 'sine'], [1700 * bright, 'triangle']]) {
    const o = osc(v, type, hz);
    chain(o, filter(v, 'bandpass', 1700 * bright, 2), env(v, level * 1.6, 0.03, 0.0005), v.out);
    run(v, o, 0.06);
  }
}

// Damped sine partials [hz, relative level], plus a short noise tick.
function ring(v, { partials, decay, level, tick = 0, tickHz = 2500 }) {
  for (const [hz, rel] of partials) {
    const o = osc(v, 'sine', hz);
    chain(o, env(v, level * rel, decay, 0.0005), v.out);
    run(v, o, decay + 0.05);
  }
  if (tick) {
    const n = noise(v);
    chain(n, filter(v, 'bandpass', tickHz, 0.8), env(v, level * tick, 0.01, 0.0005), v.out);
    run(v, n, 0.03);
  }
}

// Several rapid noise bursts then a diffuse tail.
function clap(v, level, hz, tail, q = 1.6, tailLevel = 0.8, hp = 600) {
  const n = noise(v);
  const g = v.ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(0, v.t);
  for (let i = 0; i < 3; i++) {
    const at = v.t + i * 0.011;
    p.setValueAtTime(level, at);
    p.setTargetAtTime(0, at + 0.001, 0.0035);
  }
  p.setValueAtTime(level * tailLevel, v.t + 0.033);
  p.setTargetAtTime(0, v.t + 0.034, tail * T60);
  chain(n, filter(v, 'bandpass', hz, q), filter(v, 'highpass', hp), g, v.out);
  run(v, n, 0.04 + tail);
}

// body: level of the square bank's low partials leaking past the filters,
// heard as a metallic ring around 400 Hz on the 808 hats.
// hold: a ReBirth sample voice, `decay` (-60 dB) as the sample's own fade, cut by
// holdGate after `hold` seconds.
function hat(v, { level, decay, hold = null, scale = 1, bp = 10000, hp = 7000, lp = 20000, noiseMix = 0, metalMix = 1, body = 0, bodyDecay = 0.06, choke = false, chokeable = false }) {
  const out = env(v, level, decay, 0.0008);
  const length = hold === null ? decay : Math.min(decay, hold + 0.1);
  const mg = v.ctx.createGain();
  mg.gain.value = metalMix;
  const source = metal(v, scale, length + 0.05);
  chain(source, filter(v, 'bandpass', bp, 1), filter(v, 'highpass', hp), filter(v, 'lowpass', lp), mg, out);
  if (body) chain(source, filter(v, 'bandpass', 400, 2), env(v, level * body, bodyDecay, 0.0008), out);
  if (noiseMix) {
    const n = noise(v);
    const ng = v.ctx.createGain();
    ng.gain.value = noiseMix;
    chain(n, filter(v, 'highpass', hp), filter(v, 'lowpass', lp), ng, out);
    run(v, n, length + 0.05);
  }
  // The open hat goes through a separate gain so a closed hat can cut it off.
  const gate = v.ctx.createGain();
  if (hold === null) chain(out, gate, v.out);
  else chain(out, holdGate(v, hold), gate, v.out);
  // The gate is never automated before a choke, so pin its value explicitly first.
  if (choke && v.kit.openHat) {
    v.kit.openHat.gain.setValueAtTime(1, v.t);
    v.kit.openHat.gain.setTargetAtTime(0, v.t, 0.004);
  }
  if (chokeable) v.kit.openHat = gate;
}

// fast/tail: an optional quick initial drop before the main decay.
// lp: an optional lowpass on the result. fade: a ReBirth voice decay (time
// constant, s) on top of the sample's own envelope, as a gain stage of its own.
function cymbal(v, { level, decay, scale, hp, bp, noiseMix, fast = 0, tail = 1, lp = null, fade = null }) {
  const out = fast ? env2(v, level, fast, tail, decay) : env(v, level, decay, 0.001);
  const length = fade === null ? decay : Math.min(decay, fade * 7);
  let last = out;
  if (lp !== null) last = chain(out, filter(v, 'lowpass', lp));
  if (fade !== null) {
    const g = v.ctx.createGain();
    g.gain.setValueAtTime(1, v.t);
    g.gain.setTargetAtTime(0, v.t, fade);
    last = chain(last, g);
  }
  last.connect(v.out);
  chain(metal(v, scale, length + 0.05), filter(v, 'bandpass', bp, 0.6), filter(v, 'highpass', hp), out);
  if (noiseMix) {
    const n = noise(v);
    const ng = v.ctx.createGain();
    ng.gain.value = noiseMix;
    chain(n, filter(v, 'highpass', hp), ng, out);
    run(v, n, length + 0.05);
  }
}

// High-passed noise with a short envelope (the 808's maracas).
function shaker(v, { level, decay, hp }) {
  const n = noise(v);
  chain(n, filter(v, 'highpass', hp), env(v, level, decay, 0.002), v.out);
  run(v, n, decay + 0.05);
}

// Voices with a switch (808 toms / congas etc.): `alt` param on picks the second.
const pick = (standard, alternate) => (v, P) => (P('alt') >= 0.5 ? alternate : standard)(v, P);
// Levels x1.7: 4-5 dB under OpenRB-338's renders of ReBirth.
const tom808 = (hz, decay, level) => (v, P) => tom(v, { hz: hz * (0.8 + P('tuning') * 0.5), decay, level: lvl(P('level')) * v.acc * level * 1.7, sweep: 1.04, sweepTime: 0.02, attack: 0.005 });
// Knob response that stays close to linear below ~0.8 and stretches the top end
// (808 cymbal and open hat decays run several seconds at 127).
const stretch = (d, base, lin, top) => base + d * lin + d ** 8 * top;

const OH808_SAMPLE = 0.55;

// 808 voices fitted to isolated hits in ReBirth exports: a test song that plays
// every voice alone with all effects off, and earlier songs for knob ranges.
const R808 = {
  // ~50 Hz settling, starting near 62 Hz; -20 dB after ~170 ms at decay 64 and a
  // ~2 s ring (-60 dB) at decay 127. Even at full tone the click is faint.
  bd: ['bd', (v, P) => kick(v, { base: 50 + P('tone') * 6, sweep: 1.5, sweepTime: 0.03, decay: 0.12 * 4.25 ** (2 * P('decay')), level: lvl(P('level')) * v.acc * 1.4, click: P('tone') * 0.1 })],
  // Two pure drum heads, 179 and 332 Hz; tone raises the upper one from -15 dB
  // (tone 0) to +7 dB (tone 127). Snappy adds noise.
  // Levels fitted to OpenRB-338 renders of ReBirth: tone picks one of five head
  // samples (louder at the ends), a weaker partial near 520 Hz, and snappy adds a
  // broadband noise sample by snappy squared, whatever the tone.
  sd: ['sd', (v, P) => {
    const L = lvl(P('level')) * v.acc;
    const t = P('tone');
    const head = L * (t < 0.5 ? 1.34 - 0.76 * t : 0.96 - 0.18 * (t - 0.5));
    snare(v, { tones: [[179, head, 0.2], [332, head * 10 ** ((-15 + 22 * t) / 20), 0.07], [520, head * 0.4, 0.08]], noiseHp: 1500, noiseLp: 10000, noiseDecay: 0.18, noiseLevel: L * 4.2 * P('snappy') ** 2 });
  }],
  // Toms ~85/131/177 Hz, congas ~185/272/386 Hz at tuning 0.53; almost no sweep.
  lt: ['lt', pick(tom808(80, 0.57, 0.7), tom808(174, 0.45, 1.1))],
  mt: ['mt', pick(tom808(123, 0.4, 0.68), tom808(256, 0.38, 0.7))],
  ht: ['ht', pick(tom808(166, 0.3, 0.77), tom808(363, 0.2, 1.1))],
  // Rimshot: a short broadband click peaking ~495 Hz. Claves: a 2.5 kHz tick.
  rs: ['rs', pick(
    (v, P) => ring(v, { partials: [[495, 1], [1700, 0.35]], decay: 0.035, level: lvl(P('level')) * v.acc * 0.9, tick: 0.6, tickHz: 3000 }),
    (v, P) => ring(v, { partials: [[2517, 1]], decay: 0.06, level: lvl(P('level')) * v.acc * 0.5 }),
  )],
  // Clap: broadband from ~800 Hz up, -20 dB after ~90 ms. Maracas: short noise above 8 kHz.
  cp: ['cp', pick(
    // Its tail starts at the bursts' level (OpenRB-338 renders of ReBirth).
    (v, P) => clap(v, lvl(P('level')) * v.acc * 1.5, 1400, 0.24, 0.5, 1.0, 450),
    (v, P) => shaker(v, { level: lvl(P('level')) * v.acc * 1.0, decay: 0.07, hp: 8000 }),
  )],
  // Centred near 810 Hz: a quick drop, then a ring that lasts ~0.8 s.
  cb: ['cb', (v, P) => {
    const out = env2(v, lvl(P('level')) * v.acc * 0.8, 0.06, 0.18, 0.9);
    for (const hz of [540, 800]) {
      const o = osc(v, 'square', hz);
      chain(o, filter(v, 'bandpass', 1000, 1), out);
      run(v, o, 1);
    }
    out.connect(v.out);
  }],
  // Peaks near 7 kHz with real energy from ~1 kHz up; -20 dB after ~175 ms at
  // decay 100 and ~480 ms at 127, then a faint ring (-60 dB after ~6.8 s at 127).
  // Refitted to OpenRB-338 renders of ReBirth: the sample drops ~12 dB in its first
  // 100 ms, then fades slowly; the decay knob multiplies that by its own fade (time
  // constant ~41 ms at 0, ~0.15 s at 64, none at the top). Most energy is at 5-14 kHz;
  // tone takes out the mids and opens the top.
  cy: ['cy', (v, P) => {
    const d = Math.round(P('decay') * 127);
    const fade = d >= 120 ? null : 0.041 * (0.15 / 0.041) ** (d / 63.5);
    const t = P('tone');
    cymbal(v, { level: lvl(P('level')) * v.acc * 3.0, decay: 2.2, fast: 0.15, tail: 0.25, fade, scale: 1, hp: 4500 + t * 1500, bp: 8000, lp: 14000 + t * 4000, noiseMix: 0.2 });
  }],
  // ReBirth plays a ~0.55 s sample that fades ~27 dB/s on its own and holds it
  // for 4 x decay blocks of 64 samples, then fades fast (OpenRB-338's notes on
  // ReBirth.dll; levels fitted to OpenRB-338 renders).
  oh: ['oh', (v, P) => hat(v, { level: lvl(P('level')) * v.acc * 1.75, decay: 0.32 / T60, hold: Math.min(OH808_SAMPLE, (4 * Math.round(P('decay') * 127) * 64) / 44100), bp: 8000, hp: 6000, chokeable: true })],
  // Brighter than the open hat (~12.6 kHz centroid), -20 dB after ~50 ms.
  ch: ['ch', (v, P) => hat(v, { level: lvl(P('level')) * v.acc * 4.4, decay: 0.1, bp: 11000, hp: 8000, choke: true })],
};

// 909 voices fitted to isolated hits in ReBirth exports: a test song that plays
// every voice alone with all effects off (knob sweeps for tunes and decays), and
// earlier songs for centre settings.
// Levels of BD, RS, CP and the cymbals raised 1.4-3.3 dB to OpenRB-338's renders of ReBirth.
const R909 = {
  // The pitch always starts near 275 Hz and settles on 56 Hz; tune sets how long
  // the sweep takes (~5 ms at 0, ~11 ms at 64, ~30 ms from ~100 up). At 127 that's
  // ~115 Hz average over 20-60 ms and ~67 Hz over 60-120 ms. A weak second harmonic
  // carries the tail in the 100-200 Hz band. Decay (-60 dB) fitted between ~1.1 s
  // at 127 and ~0.7 s at 65. Attack 0 has no audible click.
  bd: ['bd', (v, P) => kick(v, { base: 56, sweep: 4.9, settle: 0.005 + 0.025 * Math.min(1, P('tune') / 0.78) ** 2.5, decay: 0.25 + P('decay') * 0.85, level: lvl(P('level')) * v.acc * 0.98, click: 0.06 * P('attack') ** 0.45, clickHz: 7000, harm: 0.07 })],
  // Two sine heads a ratio of 1.35 apart, the lower 9 dB louder: ~122 Hz at tune 0,
  // 180 Hz at 64, 241 Hz at 127, starting ~1.3x higher. -20 dB after ~60 ms, then a
  // tail to ~0.45 s. A little noise even at snappy 0; snappy adds more, its
  // brightness following tone.
  sd: ['sd', (v, P) => {
    const L = lvl(P('level')) * v.acc;
    const hz = 122 * (1 + 0.975 * P('tune') ** 1.1);
    // OpenRB-338's notes on ReBirth.dll: the snappy noise is its own sample, held for
    // tone + 30 blocks of 64 samples, then faded; tone sets no brightness. Levels and
    // spectrum fitted to OpenRB-338 renders (noise peaks at 5-9 kHz).
    const hold = ((Math.round(P('tone') * 127) + 30) * 64) / 44100;
    snare(v, { tones: [[hz, L * 1.45, 0.45, 0.06], [hz * 1.35, L * 0.5, 0.3, 0.06], [hz * 2.9, L * 0.3, 0.15]], sweep: 1.3, noiseHp: 2500, noiseLp: 8000, noiseDecay: 0.35, noiseHold: hold, noiseLevel: L * (0.02 + P('snappy') * 1.2) });
  }],
  // Toms ~95 / 118 / 128 Hz at tune 64, starting ~1.2x higher; -20 dB after
  // ~245 / ~170 / ~165 ms at max decay.
  lt: ['lt', (v, P) => tom(v, { hz: 90 * (0.8 + P('tune') * 0.5), decay: 0.75 * (0.3 + P('decay') * 0.7), level: lvl(P('level')) * v.acc * 1.6, sweep: 1.2, sweepTime: 0.04, click: 0.1 })],
  mt: ['mt', (v, P) => tom(v, { hz: 108 * (0.8 + P('tune') * 0.5), decay: 0.55 * (0.3 + P('decay') * 0.7), level: lvl(P('level')) * v.acc * 1.5, sweep: 1.2, sweepTime: 0.04, click: 0.12 })],
  ht: ['ht', (v, P) => tom(v, { hz: 122 * (0.8 + P('tune') * 0.5), decay: 0.5 * (0.3 + P('decay') * 0.7), level: lvl(P('level')) * v.acc * 1.9, sweep: 1.3, sweepTime: 0.05, click: 0.12 })],
  // Rimshot: a short click peaking ~220 Hz with a broad top, -20 dB after ~25 ms.
  rs: ['rs', (v, P) => ring(v, { partials: [[221, 1], [480, 0.45], [1000, 0.2], [1700, 0.1]], decay: 0.07, level: lvl(P('level')) * v.acc * 1.3, tick: 0.25 })],
  // Clap centred near 900 Hz, little below 600 Hz. The tail starts ~18 dB under
  // the bursts and fades over ~0.8 s.
  cp: ['cp', (v, P) => clap(v, lvl(P('level')) * v.acc * 9.5, 1100, 0.75, 1.3, 0.12)],
  // The 909's sampled hats are broadband (flat ~4-13 kHz in ReBirth recordings):
  // mostly high-passed noise with a lighter metallic layer.
  // Decays (-60 dB) ~0.28 s (closed) and ~0.85 s (open) at 127; peaks 5-8 kHz.
  ch: ['hh', (v, P) => hat(v, { level: lvl(P('level')) * v.acc * 1.05, decay: 0.03 + P('chDecay') * 0.25, scale: 1.3, hp: 2400, lp: 11000, noiseMix: 1, metalMix: 0.35, choke: true })],
  oh: ['hh', (v, P) => hat(v, { level: lvl(P('level')) * v.acc * 0.85, decay: 0.25 + P('ohDecay') * 0.6, scale: 1.3, hp: 2600, lp: 12000, noiseMix: 1, metalMix: 0.35, chokeable: true })],
  // Cymbals ring ~2 s with energy from ~600 Hz up.
  cr: ['cy', (v, P) => cymbal(v, { level: lvl(P('crLevel')) * v.acc * 0.87, decay: 2.1, scale: 1.7 * (0.7 + P('crTune') * 0.6), hp: 1500, bp: 5000, noiseMix: 0.5 })],
  rd: ['cy', (v, P) => cymbal(v, { level: lvl(P('rdLevel')) * v.acc * 1.53, decay: 2.0, scale: 2.3 * (0.7 + P('rdTune') * 0.6), hp: 2500, bp: 8000, noiseMix: 0.15 })],
};

// track id -> [knob group id, voice]
export const KITS = { r808: R808, r909: R909 };
