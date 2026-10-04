/**
 * Ambient sound, synthesized live (no audio files): wind in the grass, rain
 * (muffled to a drum on the roof when you're inside), songbirds by day with
 * a dawn chorus in spring, spring peepers on cool March–April nights, and
 * crickets on warm summer nights chirping at the rate their temperature sets
 * (Dolbear's law: chirps per minute ≈ 4 × (°F − 40)), and thunder in storms.
 *
 * Browsers only allow sound after a click, so `start()` is called from the
 * start screen. M mutes.
 */
import { isPrecipitating, temperatureAt, type DayWeather } from "../time/climate";

export interface SoundEnv {
  doy: number;
  minutes: number;
  weather: DayWeather;
  indoors: boolean;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private muffle!: BiquadFilterNode;
  private windGain!: GainNode;
  private rainGain!: GainNode;
  private noise!: AudioBuffer;
  private nextBird = 2;
  private nextChirp = 1;
  private nextPeep = 1;
  private nextThunder = 20;
  muted = false;

  start() {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
    } catch {
      return; // no audio here
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.7;
    this.muffle = c.createBiquadFilter();
    this.muffle.type = "lowpass";
    this.muffle.frequency.value = 16000;
    this.muffle.connect(this.master);
    this.master.connect(c.destination);

    // Two seconds of noise, reused by every noisy sound.
    this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = this.noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      d[i] = white * 0.5 + brown * 3;
    }
    const loop = (filterType: BiquadFilterType, freq: number, q: number) => {
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = c.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.muffle);
      src.start();
      return g;
    };
    this.windGain = loop("bandpass", 380, 0.6);
    this.rainGain = loop("highpass", 1400, 0.3);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.7;
    return this.muted;
  }

  update(env: SoundEnv, dt: number) {
    const c = this.ctx;
    if (!c || this.muted) return;
    if (c.state === "suspended") void c.resume();
    const now = c.currentTime;
    const w = env.weather;
    const raining = isPrecipitating(w, env.minutes) && w.condition !== "snow";
    const tempF = temperatureAt(w, env.minutes);
    const hour = env.minutes / 60;
    const day = hour > 5.5 && hour < 20;

    this.muffle.frequency.setTargetAtTime(env.indoors ? 700 : 16000, now, 0.3);
    const windLevel = (0.015 + 0.06 * w.wind + (w.condition === "storm" ? 0.05 : 0)) * (env.indoors ? 0.5 : 1);
    this.windGain.gain.setTargetAtTime(windLevel, now, 1.5);
    const rainLevel = raining ? Math.min(0.22, 0.05 + w.precipMm / 120) * (env.indoors ? 1.6 : 1) : 0;
    this.rainGain.gain.setTargetAtTime(rainLevel, now, 1.2);

    // Songbirds: by day, not in heavy rain; a dawn chorus in spring; quiet in winter.
    const birdSeason = env.doy > 60 && env.doy < 290;
    if (day && !raining && birdSeason) {
      this.nextBird -= dt;
      if (this.nextBird <= 0) {
        const dawn = hour < 8.5 && env.doy < 200;
        this.bird();
        this.nextBird = (dawn ? 0.4 : 1.8) + Math.random() * (dawn ? 1.5 : 6);
      }
    }
    // Spring peepers: cool, damp March–April evenings.
    if (!day && env.doy > 60 && env.doy < 135 && tempF > 40) {
      this.nextPeep -= dt;
      if (this.nextPeep <= 0) {
        this.peep();
        this.nextPeep = 0.25 + Math.random() * 0.9;
      }
    }
    // Crickets: warm nights, June to the first hard frosts.
    if (!day && env.doy > 160 && env.doy < 300 && tempF > 55) {
      this.nextChirp -= dt;
      if (this.nextChirp <= 0) {
        this.cricket();
        const perMinute = Math.max(20, 4 * (tempF - 40));
        this.nextChirp = 60 / perMinute;
      }
    }
    // Thunder in storms.
    if (raining && w.condition === "storm") {
      this.nextThunder -= dt;
      if (this.nextThunder <= 0) {
        this.thunder();
        this.nextThunder = 8 + Math.random() * 25;
      }
    }
  }

  private out(gain: number, when: number, dur: number) {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + Math.min(0.02, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const pan = c.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    g.connect(pan).connect(this.muffle);
    return g;
  }

  private bird() {
    const c = this.ctx!;
    const t = c.currentTime;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2200 + Math.random() * 2200;
    for (let k = 0; k < notes; k++) {
      const when = t + k * (0.09 + Math.random() * 0.08);
      const o = c.createOscillator();
      o.type = "sine";
      const f0 = base * (0.85 + Math.random() * 0.4);
      o.frequency.setValueAtTime(f0, when);
      o.frequency.exponentialRampToValueAtTime(f0 * (Math.random() < 0.5 ? 1.4 : 0.7), when + 0.08);
      o.connect(this.out(0.03 + Math.random() * 0.03, when, 0.11));
      o.start(when);
      o.stop(when + 0.13);
    }
  }

  private peep() {
    const c = this.ctx!;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(2500, t);
    o.frequency.linearRampToValueAtTime(3000, t + 0.12);
    o.connect(this.out(0.018, t, 0.15));
    o.start(t);
    o.stop(t + 0.16);
  }

  private cricket() {
    const c = this.ctx!;
    const t = c.currentTime;
    for (let k = 0; k < 3; k++) {
      const when = t + k * 0.035;
      const o = c.createOscillator();
      o.type = "triangle";
      o.frequency.value = 4500;
      o.connect(this.out(0.012, when, 0.03));
      o.start(when);
      o.stop(when + 0.035);
    }
  }

  private thunder() {
    const c = this.ctx!;
    const t = c.currentTime + Math.random() * 2;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 140;
    src.connect(f).connect(this.out(0.5, t, 3.5));
    src.start(t);
    src.stop(t + 3.6);
  }
}
