// sound.js — self-contained WebAudio SFX for the mahjong client.
// No external files: every sound is synthesized. The AudioContext is created and
// resumed lazily on the first user gesture (browser autoplay policy), and every
// play function no-ops cleanly when muted or before that gesture has unlocked
// audio. The on/off preference is persisted in localStorage (default ON).

const PREF_KEY = "mj_soundOn";

let soundOn = (() => {
  try { return localStorage.getItem(PREF_KEY) !== "0"; } catch (e) { return true; }
})();

let ctx = null;      // shared AudioContext (created on first gesture)
let master = null;   // master gain node

// Create the AudioContext + master bus. Safe to call repeatedly. Returns the
// context or null when WebAudio is unavailable.
function ensureCtx() {
  if (ctx) return ctx;
  const AC = (typeof window !== "undefined") && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;   // keep everything tasteful / quiet
    master.connect(ctx.destination);
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

// Resume a suspended context (only succeeds inside/after a user gesture).
function resume() {
  const c = ensureCtx();
  if (c && c.state === "suspended") { try { c.resume(); } catch (e) {} }
}

// ---- first-gesture unlock ---------------------------------------------------
// Any of these interactions counts as the required user gesture; each listener
// removes itself after firing once. This makes the very first clack/ding after
// the player clicks Start (or anywhere) audible without any wiring elsewhere.
if (typeof window !== "undefined") {
  const unlock = () => resume();
  for (const ev of ["pointerdown", "touchstart", "keydown", "click"]) {
    window.addEventListener(ev, unlock, { once: true, passive: true });
  }
}

// True only when we actually have a running context to schedule on.
function ready() {
  if (!soundOn) return false;
  const c = ensureCtx();
  if (!c) return false;
  if (c.state === "suspended") { resume(); return false; }
  return c.state === "running";
}

// ---- public API -------------------------------------------------------------

// A soft, short wooden click/clack: a quick filtered noise burst plus a low
// resonant "thock" body, both decaying fast. Tasteful, low volume.
export function playTileClack() {
  if (!ready()) return;
  const c = ctx;
  const now = c.currentTime;

  // Noise burst through a bandpass — the bright "click" of the tile face.
  const dur = 0.09;
  const buffer = c.createBuffer(1, Math.max(1, Math.ceil(c.sampleRate * dur)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1900 + Math.random() * 500;   // slight per-hit variation
  bp.Q.value = 1.1;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.exponentialRampToValueAtTime(0.2, now + 0.004);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(bp); bp.connect(ng); ng.connect(master);
  src.start(now);
  src.stop(now + dur);

  // Low "thock" body — the wooden knock under the click.
  const osc = c.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(230, now);
  osc.frequency.exponentialRampToValueAtTime(120, now + 0.07);
  const og = c.createGain();
  og.gain.setValueAtTime(0.0001, now);
  og.gain.exponentialRampToValueAtTime(0.14, now + 0.006);
  og.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
  osc.connect(og); og.connect(master);
  osc.start(now);
  osc.stop(now + 0.12);
}

// A gentle, pleasant two-note chime for "it's your turn".
export function playTurnDing() {
  if (!ready()) return;
  const c = ctx;
  const now = c.currentTime;
  // A5 → D6, soft sine bells with a little overlap.
  const notes = [[880.0, 0.0], [1174.66, 0.13]];
  for (const [freq, delay] of notes) {
    const t0 = now + delay;
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    osc.connect(g); g.connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.65);
  }
}

export function setSoundOn(on) {
  soundOn = !!on;
  try { localStorage.setItem(PREF_KEY, soundOn ? "1" : "0"); } catch (e) {}
  if (soundOn) resume();   // the click that turned it on is itself a gesture
  return soundOn;
}

export function isSoundOn() { return soundOn; }
