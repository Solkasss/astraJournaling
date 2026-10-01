import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import NotFound from './pages/NotFound';

import '@solana/wallet-adapter-react-ui/styles.css';

/* =========================================================
   Shared helpers
   ========================================================= */

type Entry = { id: number; text: string; tags: string[]; createdAt: number };
/** Typing energy: `target` jumps on keystrokes and decays; `value` eases toward it each frame. */
type Energy = { target: number; value: number };
type EnergyRef = { current: Energy };

const STORAGE_KEY = 'astra-journal-entries';
const DRIFT = [0.22, 1, 0.36, 1] as const;
const TAU = Math.PI * 2;

/** Deterministic PRNG — stable starfield / nebula layout across mounts. */
const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Reads an HSL triplet design token from :root and returns a usable color string. */
const tokenColor = (name: string) =>
    `hsl(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`;

/** Compact 3D value noise (x, y, time) with smooth interpolation, range ≈ [-1, 1]. */
const makeNoise = (seed: number) => {
    const rand = mulberry32(seed);
    const perm = new Uint8Array(512);
    const base = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [base[i], base[j]] = [base[j], base[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
    const vals = Float32Array.from({ length: 256 }, () => rand() * 2 - 1);
    const fade = (t: number) => t * t * (3 - 2 * t);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const v = (x: number, y: number, z: number) => vals[perm[perm[perm[x] + y] + z]];

    return (x: number, y: number, z: number) => {
        const X = Math.floor(x);
        const Y = Math.floor(y);
        const Z = Math.floor(z);
        const xi = X & 255;
        const yi = Y & 255;
        const zi = Z & 255;
        const u = fade(x - X);
        const w = fade(y - Y);
        const s = fade(z - Z);
        const a = lerp(lerp(v(xi, yi, zi), v(xi + 1, yi, zi), u), lerp(v(xi, yi + 1, zi), v(xi + 1, yi + 1, zi), u), w);
        const b = lerp(
            lerp(v(xi, yi, zi + 1), v(xi + 1, yi, zi + 1), u),
            lerp(v(xi, yi + 1, zi + 1), v(xi + 1, yi + 1, zi + 1), u),
            w,
        );
        return lerp(a, b, s);
    };
};

/** Sizes a canvas to its CSS box at device pixel ratio (capped at 2 for performance). */
const fitCanvas = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    const { width, height } = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: width, h: height };
};

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const normalizeTag = (raw: string) =>
    raw.replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);

const persistEntry = (entry: Entry) => {
    let prev: Entry[] = [];
    try {
        prev = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Entry[];
    } catch {
        prev = [];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...prev].slice(0, 100)));
};

/* =========================================================
   Background star particles (fullscreen canvas)
   ========================================================= */

const StarField = () => {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const tones = ['--star-lavender', '--star-cyan', '--text-icy'].map(tokenColor);
        const reduced = prefersReducedMotion();
        const rand = mulberry32(11);
        let { w, h } = fitCanvas(canvas, ctx);
        const onResize = () => ({ w, h } = fitCanvas(canvas, ctx));
        window.addEventListener('resize', onResize);

        // z = depth: nearer stars are bigger, brighter, and drift faster (parallax).
        const stars = Array.from({ length: 150 }, () => {
            const z = 0.2 + rand() * 0.8;
            return { x: rand(), y: rand(), z, r: 0.35 + z * 1.05, phase: rand() * TAU, tw: 0.3 + rand() * 0.9, tone: Math.floor(rand() * 3) };
        });

        let t = 0;
        let last = performance.now();
        let id = 0;
        const frame = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000) * (reduced ? 0.2 : 1);
            last = now;
            t += dt;
            ctx.clearRect(0, 0, w, h);

            for (const s of stars) {
                s.x = (s.x - 0.0035 * s.z * dt + 1) % 1;
                s.y = (s.y - 0.006 * s.z * dt + 1) % 1;
                const a = (0.2 + 0.5 * s.z) * (0.55 + 0.45 * Math.sin(t * s.tw + s.phase));
                const x = s.x * w;
                const y = s.y * h;
                ctx.fillStyle = tones[s.tone];
                if (s.z > 0.85) {
                    ctx.globalAlpha = a * 0.12;
                    ctx.beginPath();
                    ctx.arc(x, y, s.r * 3.5, 0, TAU);
                    ctx.fill();
                }
                ctx.globalAlpha = a;
                ctx.beginPath();
                ctx.arc(x, y, s.r, 0, TAU);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            id = requestAnimationFrame(frame);
        };
        id = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(id);
            window.removeEventListener('resize', onResize);
        };
    }, []);

    return <canvas ref={ref} className="pointer-events-none fixed inset-0 size-full" aria-hidden />;
};

/* =========================================================
   Nebula — noise flow field + particle trails
   ========================================================= */

type Mote = { x: number; y: number; px: number; py: number; vx: number; vy: number; life: number; max: number };

const Nebula = ({ energy }: { energy: EnergyRef }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const coreRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        // Lilac, violet, pale cyan.
        const tones = ['--star-lavender', '--neon-purple', '--star-cyan'].map(tokenColor);
        const reduced = prefersReducedMotion();
        const noise = makeNoise(9);
        const rand = mulberry32(4);

        let { w, h } = fitCanvas(canvas, ctx);
        let R = Math.min(w, h) * 0.42;
        const ro = new ResizeObserver(() => {
            ({ w, h } = fitCanvas(canvas, ctx));
            R = Math.min(w, h) * 0.42;
        });
        ro.observe(canvas);

        // Motes are stored relative to the center; bucketed by tone so each color is one batched stroke.
        const spawn = (m: Mote) => {
            const a = rand() * TAU;
            const r = R * 0.7 * Math.sqrt(rand());
            m.x = m.px = Math.cos(a) * r;
            m.y = m.py = Math.sin(a) * r;
            m.vx = m.vy = 0;
            m.life = 0;
            m.max = 3 + rand() * 6;
            return m;
        };
        const perTone = w < 420 ? 170 : 270;
        const buckets: Mote[][] = tones.map(() =>
            Array.from({ length: perTone }, () => {
                const m = spawn({ x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, life: 0, max: 0 });
                m.life = rand() * m.max; // desync lifetimes
                return m;
            }),
        );

        const e = energy.current;
        let t = 0;
        let last = performance.now();
        let id = 0;

        const frame = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;

            // Energy: target decays toward 0, value glides toward target → smooth, never jumpy.
            e.target *= Math.pow(0.35, dt);
            e.value += (e.target - e.value) * Math.min(1, dt * 2.5);
            const k = e.value;

            const sdt = dt * (reduced ? 0.35 : 1) * (1 + k * 1.8); // typing speeds up time
            t += sdt;
            const damp = Math.pow(0.25, sdt);
            const flow = R * 0.32;
            const swirl = R * 0.16;
            const cx = w / 2;
            const cy = h / 2;

            for (const bucket of buckets) {
                for (const m of bucket) {
                    const d = Math.hypot(m.x, m.y) + 1e-3;
                    const ang = noise((m.x / R) * 1.4 + 10, (m.y / R) * 1.4 + 10, t * 0.08) * TAU * 1.6;
                    let ax = Math.cos(ang) * flow;
                    let ay = Math.sin(ang) * flow;
                    // Gentle galactic swirl, stronger near the core.
                    const sw = swirl * (1.2 - d / R);
                    ax += (-m.y / d) * sw;
                    ay += (m.x / d) * sw;
                    // Soft containment beyond ~60% radius.
                    const pull = Math.max(0, d / R - 0.6) * R * 2.2;
                    ax -= (m.x / d) * pull;
                    ay -= (m.y / d) * pull;

                    m.vx = (m.vx + ax * sdt) * damp;
                    m.vy = (m.vy + ay * sdt) * damp;
                    m.px = m.x;
                    m.py = m.y;
                    m.x += m.vx * sdt;
                    m.y += m.vy * sdt;
                    m.life += sdt;
                    if (m.life > m.max || d > R) spawn(m);
                }
            }

            // Fade instead of clear → silky trails on a transparent canvas.
            ctx.globalCompositeOperation = 'destination-out';
            ctx.globalAlpha = reduced ? 0.3 : 0.08;
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';

            const bright = 0.7 + k * 0.6;
            for (let i = 0; i < buckets.length; i++) {
                ctx.beginPath();
                for (const m of buckets[i]) {
                    if (m.life < 0.1) continue;
                    ctx.moveTo(cx + m.px, cy + m.py);
                    ctx.lineTo(cx + m.x, cy + m.y);
                }
                ctx.strokeStyle = tones[i];
                ctx.lineWidth = 3.5; // wide haze pass
                ctx.globalAlpha = 0.03 * bright;
                ctx.stroke();
                ctx.lineWidth = 1; // fine filament pass
                ctx.globalAlpha = 0.2 * bright;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            // Core glow brightness + breathing scale driven by typing energy.
            const core = coreRef.current;
            if (core) {
                core.style.opacity = String(0.35 + k * 0.65);
                core.style.transform = `translate(-50%, -50%) scale(${1 + k * 0.25 + 0.04 * Math.sin(t * 0.5)})`;
            }

            id = requestAnimationFrame(frame);
        };
        id = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(id);
            ro.disconnect();
        };
    }, [energy]);

    return (
        <div className="nebula-mask relative size-[min(92vw,58dvh,620px)]" aria-hidden>
            <div
                className="absolute inset-[12%] rounded-full blur-3xl"
                style={{
                    background:
                        'radial-gradient(circle, hsl(var(--neon-purple) / 0.16), hsl(var(--neon-indigo) / 0.08) 45%, transparent 70%)',
                }}
            />
            <canvas ref={canvasRef} className="absolute inset-0 size-full" />
            <div
                ref={coreRef}
                className="absolute left-1/2 top-1/2 size-[42%] rounded-full blur-md"
                style={{
                    background:
                        'radial-gradient(circle, hsl(var(--text-icy) / 0.55) 0%, hsl(var(--star-lavender) / 0.32) 16%, hsl(var(--neon-purple) / 0.14) 40%, transparent 68%)',
                    mixBlendMode: 'screen',
                    transform: 'translate(-50%, -50%)',
                    opacity: 0.35,
                }}
            />
        </div>
    );
};

/* =========================================================
   Journal page
   ========================================================= */

const Journal = () => {
    const energy = useRef<Energy>({ target: 0, value: 0 });
    const bump = (amount: number) => {
        energy.current.target = Math.min(1, energy.current.target + amount);
    };

    const [text, setText] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [tagDraft, setTagDraft] = useState('');
    const [released, setReleased] = useState(false);

    useEffect(() => {
        if (!released) return;
        const id = window.setTimeout(() => setReleased(false), 2200);
        return () => window.clearTimeout(id);
    }, [released]);

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
        bump(0.12);
    };

    const save = () => {
        if (!text.trim()) return;
        const pending = normalizeTag(tagDraft);
        const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
        persistEntry({ id: Date.now(), text: text.trim(), tags: finalTags, createdAt: Date.now() });
        setText('');
        setTags([]);
        setTagDraft('');
        setReleased(true);
        bump(0.9);
    };

    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const today = useMemo(
        () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
        [],
    );

    return (
        <div className="sky-bg relative flex min-h-[100dvh] flex-col overflow-hidden">
            <StarField />
            <div className="sky-vignette pointer-events-none fixed inset-0" aria-hidden />

            <motion.header
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 2, ease: DRIFT }}
                className="relative z-10 flex items-center justify-between px-6 py-6 sm:px-12"
            >
                <span className="text-soft text-sm font-light uppercase tracking-[0.35em]">Astra</span>
                <span className="text-faint text-xs font-light tracking-[0.12em]">{today}</span>
            </motion.header>

            <main className="relative z-10 flex flex-1 items-center justify-center">
                <motion.div
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 2.4, ease: DRIFT }}
                >
                    <Nebula energy={energy} />
                </motion.div>
            </main>

            <motion.footer
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1.8, delay: 0.5, ease: DRIFT }}
                className="relative z-10 mx-auto w-full max-w-xl px-4 pb-5 sm:pb-8"
            >
                <section className="glass glass-focus rounded-[var(--radius)] px-6 py-5 sm:px-7">
                    <textarea
                        value={text}
                        onChange={onTextChange}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
                        }}
                        placeholder="What's drifting through your mind tonight?"
                        rows={3}
                        className="journal-field scrollbar-none w-full resize-none text-base leading-relaxed sm:text-lg"
                        aria-label="Journal entry"
                    />

                    <div className="glass-soft mt-4 flex flex-wrap items-center gap-2 rounded-full px-4 py-2">
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
                                bump(0.05);
                            }}
                            onKeyDown={onTagKeyDown}
                            onBlur={() => tagDraft.trim() && addTag(tagDraft)}
                            placeholder={tags.length ? '' : 'tags'}
                            className="journal-field min-w-[5rem] flex-1 text-sm"
                            aria-label="Tags"
                        />
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-4">
                        <span className="text-faint text-xs font-light tracking-[0.12em]">
                            {words} {words === 1 ? 'word' : 'words'}
                        </span>
                        <button
                            type="button"
                            onClick={save}
                            disabled={!text.trim()}
                            className="soft-btn h-11 rounded-full px-7 text-sm"
                        >
                            {released ? 'Released' : 'Release to the stars'}
                        </button>
                    </div>
                </section>
            </motion.footer>
        </div>
    );
};

/* =========================================================
   App
   ========================================================= */

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
