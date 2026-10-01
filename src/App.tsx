import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { AnimatePresence, motion, useMotionValue, useSpring, type MotionValue } from 'framer-motion';
import { X } from 'lucide-react';
import NotFound from './pages/NotFound';

import '@solana/wallet-adapter-react-ui/styles.css';

/* ---------- Helpers ---------- */

type Entry = { id: number; text: string; tags: string[]; createdAt: number };
type RGB = [number, number, number];

const STORAGE_KEY = 'astra-journal-entries';
const DRIFT = [0.22, 1, 0.36, 1] as const;
const TAU = Math.PI * 2;

/** Deterministic PRNG so stars and noise are stable across renders. */
const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const normalizeTag = (raw: string) =>
    raw.replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);

const loadEntries = (): Entry[] => {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Entry[];
    } catch {
        return [];
    }
};

/** Reads an HSL triplet token (e.g. "270 70% 82%") from :root. */
const readToken = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** HSL token → RGB, needed for per-pixel color math. */
const tokenRgb = (name: string): RGB => {
    const [h, sp, lp] = readToken(name).split(/\s+/).map(parseFloat);
    const s = sp / 100;
    const l = lp / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
    };
    return [f(0), f(8), f(4)];
};

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/** Classic 2D simplex noise, output ≈ [-1, 1]. */
const createNoise2D = (rand: () => number) => {
    const p = new Uint8Array(256).map((_, i) => i);
    for (let i = 255; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const GX = [1, -1, 1, -1, 1, -1, 0, 0];
    const GY = [1, 1, -1, -1, 0, 0, 1, -1];
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;

    return (x: number, y: number) => {
        const s = (x + y) * F2;
        const i = Math.floor(x + s);
        const j = Math.floor(y + s);
        const t = (i + j) * G2;
        const x0 = x - (i - t);
        const y0 = y - (j - t);
        const i1 = x0 > y0 ? 1 : 0;
        const j1 = 1 - i1;
        const x1 = x0 - i1 + G2;
        const y1 = y0 - j1 + G2;
        const x2 = x0 - 1 + 2 * G2;
        const y2 = y0 - 1 + 2 * G2;
        const ii = i & 255;
        const jj = j & 255;
        let n = 0;
        let t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 > 0) {
            const g = perm[ii + perm[jj]] & 7;
            t0 *= t0;
            n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
        }
        let t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 > 0) {
            const g = perm[ii + i1 + perm[jj + j1]] & 7;
            t1 *= t1;
            n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
        }
        let t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 > 0) {
            const g = perm[ii + 1 + perm[jj + 1]] & 7;
            t2 *= t2;
            n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
        }
        return 70 * n;
    };
};

/** Soft radial glow sprite for trail particles. */
const makeSprite = (tone: string, core: string) => {
    const s = 32;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    if (!g) return c;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, `hsl(${core} / 0.9)`);
    grad.addColorStop(0.25, `hsl(${tone} / 0.5)`);
    grad.addColorStop(1, `hsl(${tone} / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c;
};

/** Typing energy: rises gently per keystroke, fades slowly. */
const useTypingEnergy = () => {
    const raw = useMotionValue(0);
    const energy = useSpring(raw, { stiffness: 40, damping: 22, mass: 1.4 });

    useEffect(() => {
        let id = 0;
        const tick = () => {
            const v = raw.get();
            if (v > 0.001) raw.set(v * 0.985);
            id = requestAnimationFrame(tick);
        };
        id = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(id);
    }, [raw]);

    const bump = useCallback((amount: number) => raw.set(Math.min(1, raw.get() + amount)), [raw]);
    return { energy, bump };
};

/* ---------- Background stars ---------- */

const Atmosphere = () => {
    const stars = useMemo(() => {
        const r = mulberry32(11);
        const tones = ['star--lavender', 'star--cyan', 'star--white'];
        return Array.from({ length: 90 }, (_, i) => ({
            id: i,
            x: r() * 100,
            y: r() * 100,
            size: r() < 0.06 ? 2 + r() : 0.6 + r() * 1.1,
            delay: r() * 10,
            duration: 6 + r() * 8,
            tone: tones[Math.floor(r() * tones.length)],
        }));
    }, []);

    return (
        <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
            <div className="aurora aurora--violet left-[-15%] top-[5%] size-[70vmax]" />
            <div className="aurora aurora--cyan bottom-[-25%] right-[-20%] size-[60vmax]" />
            <div className="star-layer absolute -inset-12">
                {stars.map((s) => (
                    <span
                        key={s.id}
                        className={`star ${s.tone}`}
                        style={{
                            left: `${s.x}%`,
                            top: `${s.y}%`,
                            width: s.size,
                            height: s.size,
                            animationDelay: `${s.delay}s`,
                            animationDuration: `${s.duration}s`,
                        }}
                    />
                ))}
            </div>
            <div className="sky-vignette absolute inset-0" />
        </div>
    );
};

/* ---------- Nebula (noise field + particle trails) ---------- */

const PIXEL_BUDGET = 15000; // low-res field, upscaled + blurred → smoke
const CENTER_Y = 0.42;
const PARTICLES = 240;

type Mote = { x: number; y: number; life: number; max: number; size: number; tone: number };

const Nebula = ({ energy }: { energy: MotionValue<number> }) => {
    const wrapRef = useRef<HTMLDivElement>(null);
    const fieldRef = useRef<HTMLCanvasElement>(null);
    const trailRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const wrap = wrapRef.current;
        const field = fieldRef.current;
        const trail = trailRef.current;
        const fctx = field?.getContext('2d');
        const tctx = trail?.getContext('2d');
        if (!wrap || !field || !trail || !fctx || !tctx) return;

        const noise = createNoise2D(mulberry32(1337));
        const violet = tokenRgb('--nebula-violet');
        const lilac = tokenRgb('--nebula-lilac');
        const cyan = tokenRgb('--nebula-cyan');
        const icy = tokenRgb('--text-icy');
        const icyToken = readToken('--text-icy');
        const sprites = ['--nebula-cyan', '--nebula-lilac', '--nebula-violet'].map((n) => makeSprite(readToken(n), icyToken));
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const fbm = (x: number, y: number, oct: number) => {
            let sum = 0;
            let amp = 0.5;
            let f = 1;
            let norm = 0;
            for (let o = 0; o < oct; o++) {
                sum += amp * noise(x * f, y * f);
                norm += amp;
                amp *= 0.5;
                f *= 2.03;
            }
            return sum / norm;
        };

        let w = 0;
        let h = 0;
        let gw = 0;
        let gh = 0;
        let img: ImageData | null = null;

        const resize = () => {
            const rect = wrap.getBoundingClientRect();
            w = rect.width;
            h = rect.height;
            const aspect = w / Math.max(1, h);
            gh = Math.max(40, Math.round(Math.sqrt(PIXEL_BUDGET / aspect)));
            gw = Math.max(40, Math.round(gh * aspect));
            field.width = gw;
            field.height = gh;
            img = fctx.createImageData(gw, gh);
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            trail.width = Math.round(w * dpr);
            trail.height = Math.round(h * dpr);
            tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(wrap);

        /** Domain-warped fbm cloud with an irregular, noise-driven falloff. */
        const renderField = (t: number, glow: number) => {
            if (!img) return;
            const data = img.data;
            const cxg = gw * 0.5;
            const cyg = gh * CENTER_Y;
            const inv = 1 / (Math.min(gw, gh) * 0.5);
            const coreGain = 0.45 + glow * 0.75;
            let i = 0;

            for (let y = 0; y < gh; y++) {
                const ny = (y - cyg) * inv;
                const v = (y / (gh - 1)) * 2 - 1;
                const wy = 1 - v * v;
                for (let x = 0; x < gw; x++, i += 4) {
                    const nx = (x - cxg) * inv;
                    const u = (x / (gw - 1)) * 2 - 1;
                    const win = wy * (1 - u * u);
                    const win2 = win * win; // guarantees zero at canvas edges
                    const r = Math.sqrt(nx * nx + ny * ny);
                    if (win2 < 0.002 || r > 2) {
                        data[i + 3] = 0;
                        continue;
                    }

                    // Slowly evolving warp → matter dissolves and re-forms.
                    const qx = fbm(nx * 1.3 + t * 0.05, ny * 1.3 - t * 0.035, 2);
                    const qy = fbm(nx * 1.3 + 5.2 - t * 0.04, ny * 1.3 + 1.7 + t * 0.045, 2);

                    // Irregular radius: the boundary itself is noise, so no circle survives.
                    const rr = r * (1 + qx * 0.75 + qy * 0.35);
                    let fall = 1 - rr / 1.05;
                    if (fall <= 0) {
                        data[i + 3] = 0;
                        continue;
                    }
                    fall = fall * fall * (3 - 2 * fall);

                    // Static twist near the core gives swirl without rigid rotation.
                    const tw = 1.4 * Math.exp(-r * 1.6);
                    const cs = Math.cos(tw);
                    const sn = Math.sin(tw);
                    const sx = nx * cs - ny * sn;
                    const sy = nx * sn + ny * cs;

                    const d = fbm(sx * 1.9 + qx * 1.8 + t * 0.02, sy * 1.9 + qy * 1.8 - t * 0.015, 4) * 0.5 + 0.5;
                    const clump = smoothstep(0.42, 0.8, d);
                    const ridge = Math.max(0, 1 - Math.abs(fbm(sx * 3.2 + qy * 2.2, sy * 3.2 + qx * 2.2 + t * 0.03, 2)) * 2.4);
                    const tendril = ridge * ridge * ridge * ridge;
                    const core = Math.exp(-rr * rr * 7) * coreGain;

                    let a = (clump * 0.55 + tendril * 0.32 * (0.4 + d)) * fall + core * (0.5 + 0.5 * d);
                    a = Math.min(1, a * win2);

                    // Violet → lilac → pale cyan, drifting with the warp field.
                    const cm = Math.max(0, Math.min(1, qy * 0.9 + 0.5 + (d - 0.5) * 0.6));
                    let cr: number;
                    let cg: number;
                    let cb: number;
                    if (cm < 0.5) {
                        const k = cm * 2;
                        cr = violet[0] + (lilac[0] - violet[0]) * k;
                        cg = violet[1] + (lilac[1] - violet[1]) * k;
                        cb = violet[2] + (lilac[2] - violet[2]) * k;
                    } else {
                        const k = (cm - 0.5) * 2;
                        cr = lilac[0] + (cyan[0] - lilac[0]) * k;
                        cg = lilac[1] + (cyan[1] - lilac[1]) * k;
                        cb = lilac[2] + (cyan[2] - lilac[2]) * k;
                    }
                    const hot = Math.min(1, core * 0.8);
                    data[i] = cr + (icy[0] - cr) * hot;
                    data[i + 1] = cg + (icy[1] - cg) * hot;
                    data[i + 2] = cb + (icy[2] - cb) * hot;
                    data[i + 3] = a * 230;
                }
            }
            fctx.putImageData(img, 0, 0);
        };

        // Trail motes, advected by a curl-noise flow field.
        const spawn = (m: Mote, fresh = false) => {
            const a = Math.random() * TAU;
            const rad = Math.pow(Math.random(), 1.6) * 0.6;
            m.x = Math.cos(a) * rad;
            m.y = Math.sin(a) * rad * 0.8;
            m.max = 4 + Math.random() * 7;
            m.life = fresh ? Math.random() * m.max : 0;
            m.size = 3 + Math.random() * 9;
            m.tone = Math.floor(Math.random() * 3);
        };
        const motes: Mote[] = Array.from({ length: PARTICLES }, () => {
            const m = { x: 0, y: 0, life: 0, max: 1, size: 1, tone: 0 };
            spawn(m, true);
            return m;
        });

        let t = 0;
        let acc = 1;
        let last = performance.now();
        let id = 0;
        const EPS = 0.01;
        const FREQ = 1.1;

        const frame = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const e = energy.get();
            const pace = (reduced ? 0.2 : 1) * (1 + e * 1.6);
            t += dt * pace;

            // Field is slow-moving smoke — 30fps is indistinguishable and halves the cost.
            acc += dt;
            if (acc >= 1 / 30) {
                acc = 0;
                renderField(t, e);
            }

            const cx = w * 0.5;
            const cy = h * CENTER_Y;
            const S = Math.min(w, h) * 0.5;

            tctx.globalCompositeOperation = 'destination-out';
            tctx.globalAlpha = 1 - Math.pow(0.92, dt * 60);
            tctx.fillRect(0, 0, w, h);
            tctx.globalCompositeOperation = 'lighter';

            const tf = t * 0.04;
            for (const m of motes) {
                m.life += dt * pace;
                const r = Math.sqrt(m.x * m.x + m.y * m.y);
                if (m.life >= m.max || r > 1.2) {
                    spawn(m);
                    continue;
                }
                const a1 = noise(m.x * FREQ, (m.y + EPS) * FREQ + tf);
                const a2 = noise(m.x * FREQ, (m.y - EPS) * FREQ + tf);
                const b1 = noise((m.x + EPS) * FREQ, m.y * FREQ + tf);
                const b2 = noise((m.x - EPS) * FREQ, m.y * FREQ + tf);
                const vx = (a1 - a2) / (2 * EPS);
                const vy = -(b1 - b2) / (2 * EPS);
                m.x += (vx * 0.05 + m.x * 0.02) * dt * pace;
                m.y += (vy * 0.05 + m.y * 0.02) * dt * pace;

                const fade = Math.sin((Math.PI * m.life) / m.max);
                const fall = Math.max(0, 1 - r / 1.2);
                tctx.globalAlpha = fade * fall * 0.5 * (0.7 + e * 0.5);
                const s = m.size;
                tctx.drawImage(sprites[m.tone], cx + m.x * S - s / 2, cy + m.y * S - s / 2, s, s);
            }

            tctx.globalAlpha = 1;
            id = requestAnimationFrame(frame);
        };
        id = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(id);
            ro.disconnect();
        };
    }, [energy]);

    return (
        <div ref={wrapRef} className="pointer-events-none absolute inset-0" aria-hidden>
            <canvas ref={fieldRef} className="nebula-field absolute inset-0 size-full" />
            <canvas ref={trailRef} className="nebula-trails absolute inset-0 size-full" />
        </div>
    );
};

/* ---------- Journal ---------- */

const Journal = () => {
    const { energy, bump } = useTypingEnergy();

    const [text, setText] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [tagDraft, setTagDraft] = useState('');

    const addTag = (raw: string) => {
        const tag = normalizeTag(raw);
        if (tag && !tags.includes(tag) && tags.length < 8) {
            setTags((t) => [...t, tag]);
            bump(0.15);
        }
        setTagDraft('');
    };

    const onTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (['Enter', ',', ' ', 'Tab'].includes(e.key) && tagDraft.trim()) {
            e.preventDefault();
            addTag(tagDraft);
        } else if (e.key === 'Backspace' && !tagDraft && tags.length) {
            setTags((t) => t.slice(0, -1));
        }
    };

    const onTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
        setText(e.target.value);
        bump(0.07);
    };

    const save = () => {
        if (!text.trim()) return;
        const pending = normalizeTag(tagDraft);
        const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
        const entry: Entry = { id: Date.now(), text: text.trim(), tags: finalTags, createdAt: Date.now() };
        localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...loadEntries()].slice(0, 100)));
        setText('');
        setTags([]);
        setTagDraft('');
        bump(0.8);
    };

    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    return (
        <div className="sky-bg relative flex h-[100dvh] min-h-[560px] flex-col overflow-hidden">
            <Atmosphere />

            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 3, ease: DRIFT }}
                className="absolute inset-0"
            >
                <Nebula energy={energy} />
            </motion.div>

            <motion.header
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 2, ease: DRIFT }}
                className="relative z-10 flex items-center justify-between px-6 py-7 sm:px-12"
            >
                <span className="text-soft text-sm font-light uppercase tracking-[0.35em]">Astra</span>
                <span className="text-faint text-xs font-light tracking-[0.12em]">{today}</span>
            </motion.header>

            <div className="flex-1" />

            <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1.8, delay: 0.6, ease: DRIFT }}
                className="relative z-10 mx-auto w-full max-w-2xl px-4 pb-5 sm:pb-8"
            >
                <div className="glass glass-focus rounded-[var(--radius)] px-6 py-5 sm:px-8 sm:py-6">
                    <textarea
                        value={text}
                        onChange={onTextChange}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
                        }}
                        placeholder="What's drifting through your mind tonight?"
                        rows={3}
                        className="journal-field scrollbar-none w-full resize-none text-base leading-loose sm:text-lg"
                        aria-label="Journal entry"
                    />

                    <div className="glass-soft mt-4 flex flex-wrap items-center gap-2 rounded-full px-4 py-2.5">
                        <span className="tag-accent text-sm font-extralight" aria-hidden>
                            #
                        </span>
                        <AnimatePresence initial={false}>
                            {tags.map((tag) => (
                                <motion.span
                                    key={tag}
                                    layout
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.9 }}
                                    transition={{ duration: 0.6, ease: DRIFT }}
                                    className="tag-chip inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs tracking-wide"
                                >
                                    {tag}
                                    <button
                                        type="button"
                                        onClick={() => setTags((t) => t.filter((x) => x !== tag))}
                                        className="opacity-50 transition-opacity duration-700 hover:opacity-100"
                                        aria-label={`Remove ${tag}`}
                                    >
                                        <X className="size-3" strokeWidth={1.5} />
                                    </button>
                                </motion.span>
                            ))}
                        </AnimatePresence>
                        <input
                            value={tagDraft}
                            onChange={(e) => {
                                setTagDraft(e.target.value);
                                bump(0.03);
                            }}
                            onKeyDown={onTagKeyDown}
                            onBlur={() => tagDraft.trim() && addTag(tagDraft)}
                            placeholder={tags.length ? '' : 'tags'}
                            className="journal-field min-w-[5rem] flex-1 text-sm"
                            aria-label="Tags"
                        />
                    </div>

                    <div className="mt-5 flex items-center justify-between gap-4">
                        <span className="text-faint text-xs font-light tracking-[0.12em]">
                            {words} {words === 1 ? 'word' : 'words'}
                        </span>
                        <button
                            type="button"
                            onClick={save}
                            disabled={!text.trim()}
                            className="soft-btn h-11 rounded-full px-7 text-sm"
                        >
                            Release to the stars
                        </button>
                    </div>
                </div>
            </motion.section>
        </div>
    );
};

/* ---------- App ---------- */

const App = () => {
    const network = WalletAdapterNetwork.Devnet;
    const endpoint = useMemo(() => clusterApiUrl(network), [network]);
    const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <Routes>
                        <Route path="/" element={<Journal />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                    <Toaster />
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
};

export default App;
