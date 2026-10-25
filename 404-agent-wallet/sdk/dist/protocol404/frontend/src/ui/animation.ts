/** Exact dot-matrix scenes recovered from the original interface.
 * @orig pretty/index-CVtw0LZh.js:30897-31443
 */

type DotTone = string;
type Scene = { period: number; still: number; min?: [number, number]; bare?: boolean; fade?: boolean; draw(grid: DotGrid, time: number): void };
type Colours = { dot: string; faint: string; text: string; panel: string };
type AnimationState = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; scene: Scene; maxPitch: number; visible: boolean; start: number; colours: Colours | null };

const DEFAULT_PITCH = 6,
  MIN_PITCH = 5,
  BORDER_CELLS = 2,
  FPS = 30,
  FADE_SECONDS = .9,
  EMPTY = 0,
  FAINT = 1,
  STRONG = 2;

class DotGrid {
    cols: number;
    rows: number;
    cells: Uint8Array;
    labels: Array<{ c: number; r: number; text: string; tone: DotTone }> = [];
    constructor(e: number, t: number) {
      this.cols = e, this.rows = t, this.cells = new Uint8Array(Math.max(0, e * t))
    }
    set(e: number, t: number, n: number) {
      e = Math.round(e), t = Math.round(t), e >= 0 && t >= 0 && e < this.cols && t < this.rows && (this.cells[t * this.cols + e] = n)
    }
    fill(e: number, t: number, n: number, r: number, i = STRONG) {
      for (let a = 0; a < r; a++)
        for (let r = 0; r < n; r++) this.set(e + r, t + a, i)
    }
    box(e: number, t: number, n: number, r: number, i = STRONG, a = 1 / 0) {
      for (let o = 0; o < n && e + o < a; o++) this.set(e + o, t, i), this.set(e + o, t + r - 1, i);
      for (let o = 0; o < r; o++) e < a && this.set(e, t + o, i), e + n - 1 < a && this.set(e + n - 1, t + o, i)
    }
    line(e: number, t: number, n: number, r = FAINT) {
      this.fill(e, t, n, 1, r)
    }
    text(e: number, t: number, n: string, r: DotTone = `quiet`, i = !1, a = 1 / 0) {
      let o = i ? e - n.length + 1 : e,
        s = n.slice(0, Math.max(0, Math.min(n.length, a - o)));
      s && this.labels.push({
        c: o,
        r: t,
        text: s,
        tone: r
      })
    }
    cipher(e: number, t: number, n: number, r: number, i: number, a = 0) {
      let o = Math.floor(i * 5);
      for (let i = 0; i < r; i++)
        for (let r = 0; r < n; r++) {
          let n = deterministicNoise(e + r, t + i, a * 131 + o);
          this.set(e + r, t + i, n > .58 ? STRONG : n > .22 ? FAINT : EMPTY)
        }
    }
}

function deterministicNoise(e: number, t: number, n = 0): number {
  let r = Math.imul(e | 0, 374761393) ^ Math.imul(t | 0, 668265263) ^ Math.imul(n | 0, 1442695041);
  return r = Math.imul(r ^ r >>> 13, 1274126177), r ^= r >>> 16, (r >>> 0) / 4294967296
}
const clamp01 = (e: number) => e < 0 ? 0 : e > 1 ? 1 : e,
  progress = (e: number, t: number, n: number) => clamp01((e - t) / (n - t)),
  smoothstep = (e: number) => e * e * (3 - 2 * e),
  revealText = (e: string, t: number, n: number, r = 14) => e.slice(0, Math.max(0, Math.floor((t - n) * r)));

function centeredBox(e: DotGrid, t: number, n: number) {
  return t = Math.min(t, e.cols), n = Math.min(n, e.rows), {
    x: Math.floor((e.cols - t) / 2),
    y: Math.floor((e.rows - n) / 2),
    w: t,
    h: n
  }
}

function drawSearchIcon(e: DotGrid, t: number, n: number) {
  e.set(t, n - 1, STRONG), e.set(t - 1, n, STRONG), e.set(t + 1, n, STRONG), e.set(t, n + 1, STRONG), e.set(t + 1, n + 1, FAINT), e.set(t + 2, n + 2, STRONG)
}

function drawCursor(e: DotGrid, t: number, n: number, r: number, i: number) {
  Math.floor(i * 2.5) % 2 == 0 && e.fill(t + r, n - 1, 1, 3)
}
const scenes: Record<string, Scene> = {
    hero: {
      period: 11,
      still: 8.4,
      min: [44, 31],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 66, 31);
        e.box(n, r, i, a), e.text(n + 3, r + 3, `Private transfer`, `strong`), e.text(n + i - 4, r + 3, `Protocol 404`, `quiet`, !0), e.line(n + 2, r + 6, i - 4);
        let o = [
            [`From`, `0x41c0…9e2d`],
            [`To`, `0x9d2b…71a4`],
            [`Amount`, `4,200.00 native`]
          ],
          s = n + 13,
          c = Math.min(i - 16, 16),
          l = s - 1 + Math.round(smoothstep(progress(t, 3.4, 5.2)) * (c + 1));
        o.forEach(([i, a], o) => {
          let u = r + 10 + o * 4;
          e.text(n + 3, u, i);
          let d = Math.max(0, Math.min(c, l - s));
          d > 0 && e.cipher(s, u - 1, d, 3, t, o + 1);
          let f = revealText(a, t, 1 + o * .75);
          f.length > d && e.text(s + d, u, f.slice(d), `strong`), l >= s && l < s + c && e.fill(l, u - 1, 1, 3)
        }), e.line(n + 2, r + 21, i - 4);
        let u = Math.min(i - 16, 30);
        e.text(n + 3, r + 24, `Proof`), e.line(s, r + 24, u), e.fill(s, r + 24, Math.round(smoothstep(progress(t, 5.5, 7.2)) * u), 1), e.text(n + 3, r + 27, `Status`), e.text(s, r + 27, revealText(`Sent. Fully private.`, t, 7.3), `strong`)
      }
    },
    cash: {
      period: 7,
      still: 3.4,
      min: [40, 24],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 44, 24);
        e.box(n, r, 10, 7), e.text(n + 3, r + 3, `You`, `strong`), e.box(n + i - 10, r, 10, 7), e.text(n + i - 10 + 3, r + 3, `Them`, `strong`);
        let o = i - 20 - 2;
        e.line(n + 10 + 1, r + 3, o);
        let s = n + 10 + 1 + Math.round(smoothstep(progress(t, 1, 3.2)) * (o - 6));
        e.fill(s, r + 2, 6, 3), e.set(s + 2, r + 3, FAINT), e.set(s + 3, r + 3, FAINT);
        let c = r + 7 + 4;
        e.box(n, c, i, a - 7 - 4, FAINT), e.text(n + 3, c + 3, `Ledger`), e.text(n + 12, c + 3, revealText(`no entry`, t, 3.4), `strong`), e.line(n + 3, c + 6, i - 6), e.line(n + 3, c + 9, i - 6)
      }
    },
    bank: {
      period: 7,
      still: 4.8,
      min: [40, 24],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 44, 24);
        e.box(n, r, i, a), e.box(n + 1, r + 1, i - 2, a - 2), e.text(n + 4, r + 4, `Bank ledger`, `strong`), [18, 11, 16, 13].forEach((a, o) => {
          let s = r + 8 + o * 3;
          e.text(n + 4, s, `Payment`), e.fill(n + 13, s, Math.round(progress(t, .9 + o * .7, 1.5 + o * .7) * Math.min(a, i - 26)), 1)
        });
        let o = n + i - 10,
          s = r + a - 8;
        e.fill(o + 1, s, 5, 1), e.fill(o + 1, s, 1, 3), e.fill(o + 5, s, 1, 3), e.fill(o, s + 3, 7, 5), (t < 4 || Math.floor(t * 2) % 2 == 0) && (e.set(o + 3, s + 5, FAINT), e.set(o + 3, s + 6, FAINT))
      }
    },
    public: {
      period: 8,
      still: 5,
      min: [40, 24],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 44, 24);
        e.box(n, r, i, 5), drawSearchIcon(e, n + 3, r + 2);
        let o = revealText(`0x7a3e…f19c`, t, .9, 10);
        e.text(n + 7, r + 2, o, `strong`), o.length < 11 && drawCursor(e, n + 7, r + 2, o.length, t);
        let s = [
            [`0x41c0…9e2d`, `4,200.00`],
            [`0x7a3e…f19c`, `18,350.00`],
            [`0x9d2b…71a4`, `250.00`],
            [`0x5be1…c04f`, `9,800.00`],
            [`0x1d8f…a07c`, `1,120.00`],
            [`0x2f9c…41d7`, `73.40`]
          ],
          c = r + 7,
          l = t * 1.4,
          u = Math.floor(l);
        for (let o = 0; o < 8; o++) {
          let d = c + 1 + o * 3 - Math.round((l - u) * 3);
          if (d < c || d > r + a - 1) continue;
          let [f, p] = s[(u + o) % s.length], m = t > 2.1 && f === `0x7a3e…f19c`;
          e.set(n + 1, d, m ? STRONG : FAINT), e.text(n + 3, d, f, m ? `strong` : `quiet`), e.text(n + i - 2, d, p, `strong`, !0)
        }
      }
    },
    glass: {
      period: 10,
      still: 7.2,
      min: [40, 28],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 62, 30), o = i < 50;
        e.box(n, r, i, 5), drawSearchIcon(e, n + 3, r + 2);
        let s = revealText(`0x7a3e…f19c`, t, .9, 10);
        e.text(n + 7, r + 2, s, `strong`), (s.length < 11 || t < 2.2) && drawCursor(e, n + 7, r + 2, s.length, t);
        let c = [
          [`Salary`, `from 0x41c0…9e2d`, `+4,200.00`],
          [`Savings`, `balance`, `18,350.00`],
          [`Donation`, `to 0x9d2b…71a4`, `−250.00`],
          [`Invoice`, `to 0x5be1…c04f`, `−9,800.00`]
        ];
        if (c.forEach(([a, s, l], u) => {
            let d = r + 9 + u * 4,
              f = progress(t, 2.2 + u * .45, 2.9 + u * .45);
            if (f <= 0) return;
            let p = n + Math.round(f * i);
            e.text(n + 2, d, a, `strong`, !1, p), e.text(n + (o ? 11 : 13), d, o ? s.replace(/^(from|to) /, ``) : s, `quiet`, !1, p), e.text(n + i - 3, d, l, `strong`, !0, p), f < 1 ? e.fill(p, d - 1, 1, 3) : u < c.length - 1 && e.line(n + 1, d + 2, i - 2)
          }), t > 4.6) {
          let o = n + i - 18 - 3;
          e.box(o - 2, r + a - 5, 22, 5, STRONG, o - 2 + Math.round(progress(t, 4.6, 5.1) * 22)), e.text(o, r + a - 3, revealText(`Public. Permanent.`, t, 5), `strong`)
        }
      }
    },
    envelope: {
      period: 6,
      still: 0,
      bare: !0,
      fade: !1,
      draw(e, t) {
        let n = Math.floor((e.cols - 16) / 2),
          r = Math.floor((e.rows - 12) / 2),
          i = (e: number) => Math.round((e <= 7 ? e : 15 - e) * 5 / 7);
        for (let a = 1; a < 11; a++)
          for (let o = 1; o < 15; o++)(a < i(o) || a > i(o) && Math.sin(t * 2.2 - (o + a) * .45) > .75) && e.set(n + o, r + a, FAINT);
        e.box(n, r, 16, 12);
        for (let t = 0; t < 16; t++) e.set(n + t, r + i(t), STRONG)
      }
    },
    record: {
      period: 6,
      still: 0,
      bare: !0,
      fade: !1,
      draw(e, t) {
        let n = Math.floor((e.cols - 12) / 2),
          r = Math.floor((e.rows - 15) / 2);
        e.fill(n, r, 9, 1);
        for (let t = 1; t <= 3; t++) e.set(n + 8 + t, r + t, STRONG);
        e.fill(n, r, 1, 15), e.fill(n + 11, r + 3, 1, 12), e.fill(n, r + 14, 12, 1);
        let i = Math.sin(t * 2.4) > -.3 ? STRONG : FAINT;
        e.fill(n + 5, r + 3, 2, 7, i), e.fill(n + 2, r + 5, 8, 2, i), e.line(n + 2, r + 12, 8)
      }
    },
    paper: {
      period: 6,
      still: 0,
      bare: !0,
      fade: !1,
      draw(e, t) {
        let n = Math.floor((e.cols - 16) / 2),
          r = Math.floor((e.rows - 13) / 2);
        e.box(n, r, 16, 13), e.fill(n + 2, r + 2, 12, 2);
        for (let t of [6, 8, 10]) e.line(n + 2, r + t, 5), e.line(n + 9, r + t, 5);
        e.fill(n + 9, r + 8, Math.round(smoothstep(.5 - .5 * Math.cos(t * 1.3)) * 5), 1), e.fill(n + 9, r + 6, Math.round(smoothstep(.5 - .5 * Math.cos(t * 1.3 - 1)) * 5), 1)
      }
    },
    mint: {
      period: 9,
      still: 6.6,
      min: [40, 30],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 60, 30);
        e.box(n, r, i, a), e.text(n + 3, r + 3, `Mint 404`, `strong`), e.text(n + i - 4, r + 3, `Protocol 404`, `quiet`, !0), e.line(n + 2, r + 6, i - 4), e.text(n + 3, r + 9, `Pay from`), e.text(n + 16, r + 9, `Private native`, `strong`), e.text(n + 3, r + 12, `Lots`), e.text(n + 16, r + 12, String(1 + Math.min(2, Math.floor(progress(t, 1, 2.6) * 3))), `strong`);
        let o = Math.min(16, Math.floor((i - 10) / 3));
        for (let i = 0; i < 3; i++) {
          let a = progress(t, 3 + i * .55, 3.6 + i * .55);
          if (a <= 0) continue;
          let s = n + 3 + i * (o + 2),
            c = s + Math.round(a * o);
          e.box(s, r + 16, o, 5, STRONG, c), e.text(s + 2, r + 18, o >= 12 ? `1,000 404` : `1,000`, `strong`, !1, c)
        }
        e.line(n + 2, r + a - 7, i - 4), e.text(n + 3, r + a - 4, `Your address`), e.text(n + 18, r + a - 4, revealText(`never shown`, t, 5.2), `strong`)
      }
    },
    send: {
      period: 8,
      still: 4.4,
      min: [40, 30],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 60, 30), o = r + 2;
        e.box(n, o, 12, 7), e.text(n + 3, o + 3, `You`, `strong`), e.box(n + i - 12, o, 12, 7), e.text(n + i - 12 + 3, o + 3, `Payee`, `strong`);
        let s = n + 12 + 1,
          c = n + i - 12 - 2;
        e.line(s, o + 3, c - s + 1), t > .9 && t < 3.7 && e.cipher(s + Math.round(smoothstep(progress(t, 1, 3.6)) * (c - s - 5)), o + 2, 6, 3, t, 7), e.text(n + i - 12, o + 7 + 2, revealText(`received`, t, 3.7), `strong`);
        let l = r + a - 10;
        e.line(n, l - 2, i);
        let u = Math.floor(i / 3);
        [`Sender`, `Recipient`, `Amount`].forEach((r, i) => {
          let a = n + i * u;
          e.text(a + 1, l + 1, r), e.cipher(a + 1, l + 3, u - 4, 3, t, 11 + i)
        })
      }
    },
    trade: {
      period: 9,
      still: 6.2,
      min: [40, 30],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 60, 30), o = Math.min(14, Math.floor(i * .22)), s = a - 6, c = r + 4, l = smoothstep(progress(t, 1.6, 4.4)), u = (t: number, n: string, i: number) => {
          e.text(t + 1, r + 1, n, `strong`), e.box(t, c, o, s);
          let a = Math.round(i * (s - 2));
          for (let n = 0; n < s - 2; n++)
            for (let r = 1; r < o - 1; r++) e.set(t + r, c + s - 2 - n, n < a ? STRONG : n === a ? FAINT : EMPTY)
        };
        u(n, `404`, .42 + .22 * l), u(n + i - o, `Native`, .62 - .18 * l);
        let d = n + o + 3,
          f = i - 2 * o - 6;
        e.text(d + Math.floor((f - 9) / 2), r + 6, `x · y = k`, `strong`);
        let p = r + 12,
          m = r + 17;
        if (e.line(d, p, f), e.line(d, m, f), e.set(d + f - 1, p, STRONG), e.set(d + f - 2, p - 1, STRONG), e.set(d + f - 2, p + 1, STRONG), e.set(d, m, STRONG), e.set(d + 1, m - 1, STRONG), e.set(d + 1, m + 1, STRONG), t > 1.4 && t < 4.6)
          for (let n = 0; n < 3; n++) {
            let r = Math.floor(t * 9 + n * 4) % f;
            e.set(d + r, p, STRONG), e.set(d + f - 1 - r, m, STRONG)
          }
        e.text(d, r + 23, revealText(f >= 19 ? `Who swapped: hidden` : `Trader: hidden`, t, 4.9), `strong`)
      }
    },
    market: {
      period: 9,
      still: 4.2,
      min: [40, 30],
      draw(e, t) {
        let {
          x: n,
          y: r,
          w: i,
          h: a
        } = centeredBox(e, 60, 30);
        e.text(n + 1, r + 1, `Listings`, `strong`), e.text(n + i - 2, r + 1, `Native / 1,000 404`, `quiet`, !0), e.line(n, r + 3, i);
        let o: Array<[string, number]> = [
            [`0.0118`, 1600],
            [`0.0120`, 2400],
            [`0.0123`, 1100],
            [`0.0125`, 3e3],
            [`0.0130`, 1800]
          ],
          s = n + 18,
          c = i - 20;
        o.forEach(([i, a], o) => {
          let l = r + 6 + o * 4,
            u = o === 0 ? Math.round(a * (1 - smoothstep(progress(t, 2, 3.4)))) : a;
          e.text(n + 1, l, i, `strong`), e.text(n + 9, l, a.toLocaleString(`en-US`), `quiet`);
          let d = o === 0 && t > 3.4;
          e.line(d ? s + 8 : s, l, d ? c - 8 : c);
          let f = Math.round(u / 3e3 * c);
          e.fill(s + c - f, l, f, 1), d && e.text(s, l, revealText(`Filled`, t, 3.5), `strong`)
        });
        let l = r + a - 6;
        e.line(n, l, i);
        let u = Math.floor(i / 2);
        [`Maker`, `Taker`].forEach((r, i) => {
          e.text(n + i * u + 1, l + 3, r), e.cipher(n + i * u + 8, l + 2, u - 11, 3, t, 21 + i)
        })
      }
    },
    coin: {
      period: 8,
      still: 0,
      bare: !0,
      fade: !1,
      draw(e, t) {
        let n = (e.cols - 1) / 2,
          r = (e.rows - 1) / 2,
          i = Math.min(e.cols, e.rows) / 2 - 1,
          a = Math.floor(t * 3);
        for (let t = 0; t < e.rows; t++)
          for (let o = 0; o < e.cols; o++) {
            let s = Math.hypot(o - n, t - r);
            s > i + .3 || (s > i - 1.1 || o < n - .75 ? e.set(o, t, STRONG) : o > n + .75 && e.set(o, t, ((o - t + a) % 4 + 4) % 4 == 0 ? STRONG : FAINT))
          }
      }
    }
  };

const animations: AnimationState[] = [];
const animationByCanvas = new Map<Element, AnimationState>();
const dotSpriteCache = new Map<string, HTMLCanvasElement>();
let reducedMotion: MediaQueryList;
let monoFont = `monospace`;
let initialized = false;

function readColours(e: Element): Colours {
  let t = getComputedStyle(e),
    n = (e: string, n: string) => t.getPropertyValue(e).trim() || n;
  return {
    dot: n(`--dot`, t.color),
    faint: n(`--dot-faint`, t.color),
    text: n(`--dot-text`, t.color),
    panel: n(`--dot-panel`, `transparent`)
  }
}

function dotSprite(e: string, t: boolean, n: number, r: number): HTMLCanvasElement {
  let i = `${e}|${t}|${n}|${r}`,
    a = dotSpriteCache.get(i);
  if (a) return a;
  a = document.createElement(`canvas`);
  let o = Math.ceil(n * r);
  a.width = a.height = o;
  let s = a.getContext(`2d`)!;
  return s.beginPath(), t ? (s.lineWidth = .15 * n * r, s.strokeStyle = e, s.arc(o / 2, o / 2, .24 * n * r, 0, Math.PI * 2), s.stroke()) : (s.fillStyle = e, s.arc(o / 2, o / 2, .27 * n * r, 0, Math.PI * 2), s.fill()), dotSpriteCache.set(i, a), a
}

function choosePitch(e: Scene, t: number, n: number, r: number): number {
  let i = e.bare ? 0 : 6,
    [a, o] = e.min ?? [0, 0];
  for (let e = r; e > MIN_PITCH; e--)
    if (Math.floor(t / e) - i >= a && Math.floor(n / e) - i >= o) return e;
  return MIN_PITCH
}

function sceneOpacity(e: Scene, t: number): number {
  return e.fade === !1 || reducedMotion.matches ? 1 : Math.min(progress(t, 0, FADE_SECONDS), 1 - progress(t, e.period - FADE_SECONDS, e.period))
}

function renderAnimation(e: AnimationState, t: number): void {
  let {
    canvas: n,
    ctx: r,
    scene: i
  } = e, a = n.clientWidth, o = n.clientHeight;
  if (!a || !o) return;
  let s = window.devicePixelRatio || 1;
  (n.width !== Math.round(a * s) || n.height !== Math.round(o * s)) && (n.width = Math.round(a * s), n.height = Math.round(o * s)), e.colours ??= readColours(n);
  let c = e.colours;
  r.setTransform(s, 0, 0, s, 0, 0), r.clearRect(0, 0, a, o);
  let l = choosePitch(i, a, o, e.maxPitch),
    u = Math.floor(a / l),
    d = Math.floor(o / l),
    f = (a - (u - 1) * l) / 2,
    p = (o - (d - 1) * l) / 2,
    m = l / 2,
    h = (e: CanvasImageSource, t: number, n: number) => r.drawImage(e, f + t * l - m, p + n * l - m, l, l),
    g = 0;
  if (!i.bare) {
    g = 3;
    let e = Math.floor(a / DEFAULT_PITCH),
      t = Math.floor(o / DEFAULT_PITCH),
      n = (a - (e - 1) * DEFAULT_PITCH) / 2,
      i = (o - (t - 1) * DEFAULT_PITCH) / 2,
      l = dotSprite(c.faint, !0, DEFAULT_PITCH, s);
    for (let a = 0; a < t; a++)
      for (let o = 0; o < e; o++)(o < BORDER_CELLS || a < BORDER_CELLS || o >= e - BORDER_CELLS || a >= t - BORDER_CELLS) && r.drawImage(l, n + o * DEFAULT_PITCH - DEFAULT_PITCH / 2, i + a * DEFAULT_PITCH - DEFAULT_PITCH / 2, DEFAULT_PITCH, DEFAULT_PITCH);
    let u = n + 12 - DEFAULT_PITCH / 2,
      d = i + 12 - DEFAULT_PITCH / 2;
    r.fillStyle = c.panel, r.beginPath(), r.roundRect(u, d, a - 2 * u, o - 2 * d, 8), r.fill()
  }
  let _ = new DotGrid(u - 2 * g, d - 2 * g);
  if (_.cols < 8 || _.rows < 8) return;
  i.draw(_, t);
  let v = sceneOpacity(i, t),
    y = (e: number, t: number) => .65 * deterministicNoise(e, t, 99) + .35 * (e / _.cols),
    b = dotSprite(c.dot, !1, l, s),
    x = dotSprite(c.dot, !0, l, s);
  for (let e = 0; e < _.rows; e++)
    for (let t = 0; t < _.cols; t++) {
      let n = _.cells[e * _.cols + t];
      if (n) {
        if (v < 1) {
          let r = y(t, e);
          if (r > v) continue;
          r > v - .2 && (n = FAINT)
        }
        h(n === STRONG ? b : x, t + g, e + g)
      }
    }
  r.font = `500 ${l*1.5}px ${monoFont}`, r.textAlign = `center`, r.textBaseline = `middle`;
  for (let e of _.labels) {
    r.fillStyle = e.tone === `strong` ? c.dot : c.text;
    for (let t = 0; t < e.text.length; t++) v < 1 && y(e.c + t, e.r) > v - .1 || r.fillText(e.text[t], f + (g + e.c + t) * l, p + (g + e.r) * l + .5)
  }
}
const sceneTime = (e: AnimationState, t: number) => reducedMotion.matches ? e.scene.still : (t - e.start) / 1e3 % e.scene.period;
let frameHandle = 0;
let lastFrame = 0;

function onAnimationFrame(e: number): void {
  if (frameHandle = 0, e - lastFrame >= 1e3 / FPS - 2) {
    lastFrame = e;
    for (let t of animations) t.visible && renderAnimation(t, sceneTime(t, e))
  }
  scheduleFrame()
}

function scheduleFrame(): void {
  !frameHandle && !reducedMotion.matches && animations.some(e => e.visible) && (frameHandle = requestAnimationFrame(onAnimationFrame))
}

function renderVisible(): void {
  let e = performance.now();
  for (let t of animations) t.visible && renderAnimation(t, sceneTime(t, e))
}

export function initDotAnimations(): void {
  if (initialized) return;
  initialized = true;
  reducedMotion = matchMedia(`(prefers-reduced-motion: reduce)`);
  monoFont = getComputedStyle(document.documentElement).getPropertyValue(`--mono`).trim() || monoFont;
  let e = new IntersectionObserver(e => {
      for (let t of e) {
        let e = animationByCanvas.get(t.target);
        e && (t.isIntersecting && !e.visible && (e.start = performance.now()), e.visible = t.isIntersecting)
      }
      renderVisible(), scheduleFrame()
    }, {
      rootMargin: `60px`
    }),
    t = new ResizeObserver(e => {
      for (let t of e) {
        let e = animationByCanvas.get(t.target);
        e?.visible && renderAnimation(e, sceneTime(e, performance.now()))
      }
    });
  for (let n of document.querySelectorAll<HTMLCanvasElement>(`canvas[data-dots]`)) {
    let r = scenes[n.dataset.dots ?? ``],
      i = n.getContext(`2d`);
    if (!r || !i) continue;
    let a: AnimationState = {
      canvas: n,
      ctx: i,
      scene: r,
      maxPitch: Math.max(MIN_PITCH, Math.min(12, Number(n.dataset.pitch) || DEFAULT_PITCH)),
      visible: !1,
      start: performance.now(),
      colours: null
    };
    animations.push(a), animationByCanvas.set(n, a), e.observe(n), t.observe(n)
  }
  matchMedia(`(prefers-color-scheme: light)`).addEventListener(`change`, () => {
    for (let e of animations) e.colours = null;
    renderVisible()
  }), reducedMotion.addEventListener(`change`, () => {
    renderVisible(), scheduleFrame()
  })
}
