import { useCallback, useEffect, useRef, useState } from "react";
import "./RouletteWheel.css";

// Actual number order of a European wheel (starting at 0, clockwise)
const ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const N = ORDER.length;
const SEG = 360 / N;
const START = 500;
const CHIPS = [[5, "#5b2a86"], [10, "#8a1230"], [25, "#0f5c6e"], [100, "#7a5a10"]];
const S = 440; // canvas logical size
const TRACK_R = 184, POCKET_R = 143;

// Outside bets: [label, test, payout multiplier]
const OUT = {
  red: ["Red", (n) => RED.has(n), 1], black: ["Black", (n) => n > 0 && !RED.has(n), 1],
  odd: ["Odd", (n) => n > 0 && n % 2 === 1, 1], even: ["Even", (n) => n > 0 && n % 2 === 0, 1],
  low: ["1-18", (n) => n >= 1 && n <= 18, 1], high: ["19-36", (n) => n >= 19, 1],
  d1: ["1st 12", (n) => n >= 1 && n <= 12, 2], d2: ["2nd 12", (n) => n >= 13 && n <= 24, 2], d3: ["3rd 12", (n) => n >= 25, 2],
};
const wins = (k, n) => (k[0] === "n" ? Number(k.slice(1)) === n : OUT[k][1](n));
const mult = (k) => (k[0] === "n" ? 35 : OUT[k][2]);
const colorOf = (n) => (n === 0 ? "green" : RED.has(n) ? "red" : "black");
const pillBg = (n) => (n === 0 ? "#13795b" : RED.has(n) ? "#b3122a" : "#14110f");

// The result comes from the browser's secure RNG; the animation only stops on that result
const rand = (n) => {
  const a = new Uint32Array(1), lim = Math.floor(2 ** 32 / n) * n;
  do { crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % n;
};
const randFloat = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
const circ = (ctx, x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function RouletteWheel() {
  const [coins, setCoins] = useState(START);
  const [stack, setStack] = useState([]);   // [{k, v}] chips placed on the board
  const [last, setLast] = useState([]);
  const [chip, setChip] = useState(5);
  const [spinning, setSpinning] = useState(false);
  const [hist, setHist] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [winNum, setWinNum] = useState(null);

  const canvasRef = useRef(null);
  const sim = useRef({ wa: 0, ba: 0, br: TRACK_R, trail: [] }); // wheel angle, ball angle (ground), ball radius, motion trail
  const rumble = useRef(null);
  const raf = useRef(0);
  const audio = useRef(null);
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  const staked = stack.reduce((s, b) => s + b.v, 0);
  const free = coins - staked;

  // ---------- Sound (WebAudio, no audio files needed) ----------
  const ping = useCallback((freq, dur, vol, type = "triangle") => {
    const a = audio.current;
    if (!a || mutedRef.current) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  }, []);

  // Ball rolling on the track: filtered noise whose pitch and volume follow the ball speed
  const startRumble = useCallback(() => {
    const a = audio.current;
    if (!a || mutedRef.current) return;
    const len = a.sampleRate * 2, buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; src.loop = true; f.type = "bandpass"; f.Q.value = 0.8; g.gain.value = 0;
    src.connect(f).connect(g).connect(a.destination); src.start();
    rumble.current = { src, f, g };
  }, []);
  const setRumble = useCallback((v) => { // v = ball speed, 0..1
    const r = rumble.current, a = audio.current;
    if (!r) return;
    r.f.frequency.setTargetAtTime(300 + 900 * v, a.currentTime, 0.05);
    r.g.gain.setTargetAtTime(mutedRef.current ? 0 : 0.06 * v, a.currentTime, 0.05);
  }, []);
  const stopRumble = useCallback(() => {
    const r = rumble.current, a = audio.current;
    if (!r) return;
    r.g.gain.setTargetAtTime(0, a.currentTime, 0.04);
    r.src.stop(a.currentTime + 0.3);
    rumble.current = null;
  }, []);

  // ---------- Canvas drawing ----------
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d"), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== S * dpr) cv.width = cv.height = S * dpr;
    const { wa, ba, br } = sim.current, m = S / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    // outer wooden frame
    let g = ctx.createRadialGradient(m - 50, m - 60, 60, m, m, 220);
    g.addColorStop(0, "#80502a"); g.addColorStop(0.6, "#4a2610"); g.addColorStop(1, "#1f0d05");
    circ(ctx, m, m, 217, g);
    // brass ring (metallic shine via conic gradient)
    if (ctx.createConicGradient) {
      g = ctx.createConicGradient(-0.7, m, m);
      [[0, "#f6d98a"], [0.2, "#8a5d14"], [0.4, "#f2c767"], [0.6, "#7a4f10"], [0.8, "#f6d98a"], [1, "#f6d98a"]].forEach(([o, c]) => g.addColorStop(o, c));
    } else g = "#c28a22";
    circ(ctx, m, m, 207, g);
    // ball track: sloped mahogany bowl
    g = ctx.createRadialGradient(m, m, 166, m, m, 200);
    g.addColorStop(0, "#150803"); g.addColorStop(0.55, "#3b1d0c"); g.addColorStop(1, "#63380f");
    circ(ctx, m, m, 200, g);
    // 8 deflector frets (the ball bounces off these)
    for (let k = 0; k < 8; k++) {
      ctx.save(); ctx.translate(m, m); ctx.rotate(((k * 45 + 22.5) * Math.PI) / 180); ctx.translate(0, -183);
      ctx.fillStyle = "#e8c36a"; ctx.strokeStyle = "#5b3a08"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(4.5, 0); ctx.lineTo(0, 9); ctx.lineTo(-4.5, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // wheel (the rotating part)
    ctx.save(); ctx.translate(m, m); ctx.rotate((wa * Math.PI) / 180);
    for (let i = 0; i < N; i++) {
      const n = ORDER[i], a0 = ((i * SEG - SEG / 2 - 90) * Math.PI) / 180, a1 = ((i * SEG + SEG / 2 - 90) * Math.PI) / 180;
      ctx.fillStyle = n === 0 ? "#13795b" : RED.has(n) ? "#b3122a" : "#16120f";
      ctx.beginPath(); ctx.moveTo(Math.cos(a0) * 118, Math.sin(a0) * 118); ctx.arc(0, 0, 168, a0, a1); ctx.arc(0, 0, 118, a1, a0, true); ctx.closePath(); ctx.fill();
    }
    // pocket depth: dark inside, light edge outside
    g = ctx.createRadialGradient(0, 0, 118, 0, 0, 168);
    g.addColorStop(0, "rgba(0,0,0,.5)"); g.addColorStop(0.55, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(255,255,255,.14)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 168, 0, Math.PI * 2); ctx.arc(0, 0, 118, 0, Math.PI * 2, true); ctx.fill("evenodd");
    // metal frets + numbers
    for (let i = 0; i < N; i++) {
      const a = ((i * SEG - SEG / 2 - 90) * Math.PI) / 180;
      ctx.strokeStyle = "#caa24e"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * 118, Math.sin(a) * 118); ctx.lineTo(Math.cos(a) * 168, Math.sin(a) * 168); ctx.stroke();
      ctx.strokeStyle = "rgba(255,245,200,.55)"; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * 118 - 0.8, Math.sin(a) * 118); ctx.lineTo(Math.cos(a) * 168 - 0.8, Math.sin(a) * 168); ctx.stroke();
      ctx.save(); ctx.rotate((i * SEG * Math.PI) / 180); ctx.translate(0, -156);
      ctx.fillStyle = "#f6ecd4"; ctx.font = "800 11px Figtree, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(ORDER[i], 0, 0); ctx.restore();
    }
    circ(ctx, 0, 0, 120, "#b88a2e"); // inner brass ring
    g = ctx.createRadialGradient(-20, -24, 10, 0, 0, 112);
    g.addColorStop(0, "#6e1b31"); g.addColorStop(1, "#1e050b");
    circ(ctx, 0, 0, 114, g);
    g = ctx.createRadialGradient(-14, -18, 4, 0, 0, 70);
    g.addColorStop(0, "#fbe3a0"); g.addColorStop(0.5, "#c28a22"); g.addColorStop(1, "#5b3a08");
    circ(ctx, 0, 0, 70, g);
    for (let k = 0; k < 4; k++) { // turret spokes
      ctx.save(); ctx.rotate((k * Math.PI) / 2);
      const sg = ctx.createLinearGradient(-6, 0, 6, 0); sg.addColorStop(0, "#8a5d14"); sg.addColorStop(0.5, "#fbe3a0"); sg.addColorStop(1, "#8a5d14");
      ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(-3, -18); ctx.lineTo(-6, -104); ctx.lineTo(6, -104); ctx.lineTo(3, -18); ctx.closePath(); ctx.fill();
      circ(ctx, 0, -104, 7, "#e8c36a"); ctx.restore();
    }
    g = ctx.createRadialGradient(-5, -6, 1, 0, 0, 20);
    g.addColorStop(0, "#fff7d6"); g.addColorStop(1, "#9a6b14");
    circ(ctx, 0, 0, 19, g);
    ctx.restore();

    // light glare (over the wheel, does not rotate)
    ctx.save(); ctx.beginPath(); ctx.arc(m, m, 200, 0, Math.PI * 2); ctx.clip();
    g = ctx.createLinearGradient(m - 160, m - 200, m + 60, m + 80);
    g.addColorStop(0, "rgba(255,255,255,.22)"); g.addColorStop(0.45, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S); ctx.restore();

    // ball: shadow + glossy sphere
    const r = (ba * Math.PI) / 180, bx = m + br * Math.sin(r), by = m - br * Math.cos(r);
    const tr = sim.current.trail || []; // motion blur: faint ghosts of the last few positions
    tr.forEach(([a, rr], i) => {
      const q = (a * Math.PI) / 180;
      ctx.globalAlpha = 0.28 * ((i + 1) / tr.length);
      circ(ctx, m + rr * Math.sin(q), m - rr * Math.cos(q), 5.6, "#ffffff");
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(0,0,0,.38)"; ctx.beginPath(); ctx.ellipse(bx + 3, by + 4, 6.5, 5.5, 0, 0, Math.PI * 2); ctx.fill();
    g = ctx.createRadialGradient(bx - 2.2, by - 2.4, 0.5, bx, by, 7);
    g.addColorStop(0, "#ffffff"); g.addColorStop(0.55, "#dcdcdc"); g.addColorStop(1, "#8a8a8a");
    circ(ctx, bx, by, 6.5, g);
  }, []);

  useEffect(() => { draw(); return () => { cancelAnimationFrame(raf.current); stopRumble(); }; }, [draw, stopRumble]);

  // ---------- Betting ----------
  const place = (k) => {
    if (spinning) return;
    if (chip > free) { setError(`Not enough coins. Remaining: ${free}.`); return; }
    setError(""); setStack((s) => [...s, { k, v: chip }]);
  };
  const onBoard = (k) => stack.filter((b) => b.k === k).reduce((s, b) => s + b.v, 0);

  // ---------- Spin ----------
  const spin = () => {
    if (spinning || !stack.length) return;
    if (!audio.current) audio.current = new (window.AudioContext || window.webkitAudioContext)();
    audio.current.resume?.();
    const idx = rand(N), number = ORDER[idx], bets = stack;
    const reduce = reducedMotion(), T = reduce ? 1200 : 8500;
    const w0 = sim.current.wa, wTotal = 360 * (3 + rand(2)) + randFloat() * 360, wEnd = w0 + wTotal;
    const turns = reduce ? 1 : 9 + rand(3);
    const pa = idx * SEG + (randFloat() - 0.5) * SEG * 0.45; // anywhere inside the pocket
    const t0 = performance.now();
    let prevPocket = -1, prevDefl = -1, prevNow = t0;

    Object.assign(sim.current, { kick: 0, jit: 0, jitV: 0, trail: [] });
    if (!reduce) startRumble();
    setCoins((c) => c - staked); setLast(bets); setStack([]); setError(""); setVerdict(null); setWinNum(null); setSpinning(true);

    const step = (now) => {
      const t = Math.min(1, (now - t0) / T), s = sim.current;
      const k = Math.min(3, (now - prevNow) / 16.7); prevNow = now; // frame-rate independent decay
      const v = (1 - t) ** 1.2;                                       // ball speed, 1 -> 0
      s.wa = w0 + wTotal * (1 - (1 - t) ** 2.4);                      // wheel slows down with friction
      const gb = wEnd + pa + 360 * turns * (1 - t) ** 2.2;            // ball runs AGAINST the wheel, slowing down
      let bounce = 0;
      if (t > 0.84) { const u = (t - 0.84) / 0.16; bounce = SEG * 2.6 * (1 - u) ** 2 * Math.sin(u * 28); } // hopping between pockets

      // deflector frets: the ball hits one, gets kicked outward and knocked sideways
      s.kick *= 0.88 ** k; s.jitV *= 0.85 ** k; s.jit = (s.jit + s.jitV * k) * 0.95 ** k;
      const dIdx = Math.floor((((gb - 22.5) % 360) + 360) % 360 / 45);
      if (t > 0.6 && t < 0.88 && s.br > POCKET_R + 14 && prevDefl !== -1 && dIdx !== prevDefl) {
        s.kick += 3 + randFloat() * 4; s.jitV += (randFloat() - 0.5) * 1.6;
        ping(1900 + randFloat() * 700, 0.07, 0.2);
      }
      prevDefl = dIdx;
      const calm = t > 0.9 ? Math.max(0, 1 - (t - 0.9) / 0.1) : 1;   // all chaos fades out so it lands in the chosen pocket

      s.ba = gb + bounce + s.jit * calm;
      let br;
      if (t < 0.6) br = TRACK_R + Math.sin(t * 160) * 0.7 * v;        // slight rattle on the rim
      else {                                                           // spiral inward, then bounce
        const u = (t - 0.6) / 0.4, e = u * u * (3 - 2 * u);
        br = TRACK_R + (POCKET_R - TRACK_R) * e + (u > 0.55 ? 7 * Math.abs(Math.sin(u * 26)) * (1 - u) ** 2 : 0);
      }
      s.br = br + s.kick * calm;

      if (rumble.current) { if (t < 0.6) setRumble(v); else stopRumble(); }
      if (t > 0.6) { // tick whenever the ball crosses a fret
        const p = Math.floor((((s.ba - s.wa) % 360) + 360) % 360 / SEG + 0.5);
        if (p !== prevPocket) { if (prevPocket !== -1) ping(1300 + randFloat() * 900, 0.045, 0.1 + 0.12 * t); prevPocket = p; }
      }
      s.trail.push([s.ba, s.br]); if (s.trail.length > 9) s.trail.shift();
      draw();
      if (t < 1) raf.current = requestAnimationFrame(step);
      else finish(number, bets);
    };
    raf.current = requestAnimationFrame(step);
  };

  const finish = (number, bets) => {
    sim.current.br = POCKET_R; sim.current.trail = []; draw(); ping(240, 0.2, 0.3, "sine"); setWinNum(number);
    const total = bets.reduce((s, b) => s + b.v, 0);
    const back = bets.reduce((s, b) => s + (wins(b.k, number) ? b.v * (mult(b.k) + 1) : 0), 0);
    const net = back - total, name = `${number} ${colorOf(number)}`;
    setCoins((c) => c + back);
    setHist((h) => [number, ...h].slice(0, 30));
    setVerdict(net > 0 ? { type: "win", title: `${name}. +${net} coins`, sub: `${back} coins returned.` }
      : net === 0 ? { type: "push", title: `${name}. Break even`, sub: "No win, no loss." }
      : { type: "lose", title: `${name}. ${net} coins`, sub: back ? `${back} coins returned.` : "No winning bets." });
    setSpinning(false);
  };

  const reset = () => {
    cancelAnimationFrame(raf.current);
    stopRumble();
    sim.current = { wa: 0, ba: 0, br: TRACK_R, trail: [] };
    setWinNum(null); setCoins(START); setStack([]); setLast([]); setHist([]); setVerdict(null); setError(""); setSpinning(false);
    requestAnimationFrame(draw);
  };

  const cell = (k, text, cls = "", aria) => (
    <button key={k} type="button" className={`rl-cell ${cls}`} style={k === "n" + winNum ? { boxShadow: "0 0 0 3px #f6d27c, 0 0 14px #f6d27c" } : undefined} disabled={spinning} onClick={() => place(k)} aria-label={aria || text}>
      {text}{onBoard(k) > 0 && <span className="rl-bd">{onBoard(k)}</span>}
    </button>
  );
  const gameOver = coins === 0 && !spinning && !stack.length;
  const canRebet = !spinning && stack.length === 0 && last.length > 0 && last.reduce((s, b) => s + b.v, 0) <= coins;

  return (
    <div className="rl">
      <section className="rl-left">
        <canvas ref={canvasRef} className="rl-canvas" style={{ width: "100%", maxWidth: S, aspectRatio: "1" }} role="img" aria-label="Roulette wheel with a spinning ball" />
        <div className={`rl-verdict ${verdict ? verdict.type : ""}`} role="status" aria-live="polite">
          {spinning ? <b>Rien ne va plus…</b> : verdict ? <><b>{verdict.title}</b><span>{verdict.sub}</span></> : <b>{gameOver ? "Out of coins. Press Reset." : "Place your chips and spin"}</b>}
        </div>
        <div className="rl-hist" aria-label="Recent numbers">
          {hist.slice(0, 12).map((n, i) => <span key={i} className="rl-pill" style={{ background: pillBg(n) }}>{n}</span>)}
        </div>
      </section>

      <section className="rl-right">
        <div className="rl-bank">
          <span>Coins {staked > 0 && <small>(staked {staked})</small>}</span>
          <b>{free}</b>
        </div>
        <div className="rl-chips" role="group" aria-label="Chip value">
          {CHIPS.map(([v, c]) => (
            <button key={v} type="button" className="rl-chip" style={{ "--c": c }} aria-pressed={chip === v} disabled={spinning} onClick={() => setChip(v)}>{v}</button>
          ))}
        </div>

        <div className="rl-board"><div className="rl-grid">
          {cell("n0", "0", "g", "Bet on 0")}
          {[3, 2, 1].flatMap((row) => Array.from({ length: 12 }, (_, c) => {
            const n = c * 3 + row;
            return cell("n" + n, n, RED.has(n) ? "r" : "", `Bet on ${n}, ${colorOf(n)}`);
          }))}
          <span />
          {["d1", "d2", "d3"].map((k) => cell(k, OUT[k][0], "out s4"))}
          <span />
          {["low", "even", "red", "black", "odd", "high"].map((k) => cell(k, OUT[k][0], `out s2 ${k === "red" ? "r" : ""}`))}
        </div></div>

        <p className="rl-err" role="alert">{error}</p>
        <div className="rl-row">
          <button type="button" className="rl-btn rl-spin" onClick={spin} disabled={spinning || !stack.length}>
            {spinning ? "Spinning…" : stack.length ? `Spin (${staked})` : "Place chips"}
          </button>
          <button type="button" className="rl-btn" disabled={spinning || !stack.length} onClick={() => setStack((s) => s.slice(0, -1))}>Undo</button>
          <button type="button" className="rl-btn" disabled={spinning || !stack.length} onClick={() => setStack([])}>Clear</button>
          <button type="button" className="rl-btn" disabled={!canRebet} onClick={() => setStack(last.map((b) => ({ ...b })))}>Rebet</button>
          <button type="button" className="rl-btn" aria-pressed={muted} onClick={() => setMuted((m) => !m)}>{muted ? "Sound off" : "Sound on"}</button>
          <button type="button" className="rl-btn" disabled={spinning} onClick={reset}>Reset</button>
        </div>
        <p className="rl-note">European wheel, 37 pockets. A single number pays 35 to 1, dozens pay 2 to 1, and red/black/odd/even/low/high pay 1 to 1. The zero gives the house a 2.7% edge. Play coins only, no real money.</p>
      </section>
    </div>
  );
}