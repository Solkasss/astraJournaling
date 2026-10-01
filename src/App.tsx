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

/* ---------- Types & helpers ---------- */

type Entry = { id: number; text: string; tags: string[]; createdAt: number };

const STORAGE_KEY = 'astra-journal-entries';
const DRIFT = [0.22, 1, 0.36, 1] as const;

/** Deterministic PRNG so the starfield and galaxy are stable across renders. */
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

/** Typing "energy": rises gently on keystrokes, fades slowly — never jumpy. */
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

/* ---------- Atmosphere ---------- */

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

/* ---------- Galaxy (canvas) ---------- */

const TAU = Math.PI * 2;
const ARMS = 3;
const TWIST = 4.2; // radians of spiral wind from core to rim

/** Reads an HSL triplet token (e.g. "190 75% 70%") from :root. */
const readToken = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Pre-rendered soft glow sprite — much cheaper than shadowBlur per particle. */
const makeSprite = (tone: string, core?: string) => {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    if (!g) return c;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, `hsl(${core ?? tone} / 0.9)`);
    grad.addColorStop(0.22, `hsl(${tone} / 0.55)`);
    grad.addColorStop(0.55, `hsl(${tone} / 0.12)`);
    grad.addColorStop(1, `hsl(${tone} / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c;
};

type Mote = {
    r: number; // normalized radius 0..1
    off: number; // angular offset along arm
    sx: number; // perpendicular scatter
    sy: number;
    phase: number;
    wf: number;
    size: number;
    tone: number;
    hot: boolean;
    alpha: number;
    lag: number; // per-mote angular drift, gives chaotic shimmer
};

const Galaxy = ({ energy }: { energy: MotionValue<number> }) => {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const tones = ['--neon-cyan', '--neon-indigo', '--neon-purple'].map(readToken);
        const icy = readToken('--text-icy');
        const dust = tones.map((t) => makeSprite(t));
        const hot = tones.map((t) => makeSprite(t, icy));
        const coreSprite = makeSprite(readToken('--star-lavender'), icy);
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const rand = mulberry32(21);

        let w = 0;
        let h = 0;
        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            w = rect.width;
            h = rect.height;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        // Spiral-arm dust plus a diffuse central bulge.
        const motes: Mote[] = Array.from({ length: 380 }, (_, i) => {
            const bulge = rand() < 0.18;
            const r = bulge ? rand() * 0.22 : 0.08 + Math.pow(rand(), 0.85) * 0.92;
            const spread = bulge ? 0.14 : 0.05 + r * 0.11;
            // Inner arms are cyan/indigo, outer arms drift toward violet.
            const tone = bulge ? Math.floor(rand() * 2) : r < 0.4 ? Math.floor(rand() * 2) : 1 + Math.floor(rand() * 2);
            return {
                r,
                off: (i % ARMS) * (TAU / ARMS) + (bulge ? rand() * TAU : (rand() - 0.5) * 0.5),
                sx: (rand() - 0.5) * 2 * spread,
                sy: (rand() - 0.5) * 2 * spread,
                phase: rand() * TAU,
                wf: 0.15 + rand() * 0.35,
                size: rand() < 0.2 ? 18 + rand() * 30 : 3 + rand() * 9,
                tone,
                hot: rand() < 0.12,
                alpha: 0.18 + rand() * 0.45,
                lag: (rand() - 0.5) * 0.04,
            };
        });

        let t = 0;
        let rot = 0;
        let last = performance.now();
        let id = 0;

        const frame = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const e = energy.get();
            const pace = (reduced ? 0.25 : 1) * (1 + e * 1.1);
            t += dt * pace;
            rot += dt * 0.045 * pace;

            const cx = w / 2;
            const cy = h / 2;
            const R = Math.min(w, h) * 0.36 * (1 + e * 0.06);
            const tilt = 0.58 + Math.sin(t * 0.07) * 0.06;
            const bright = 0.75 + e * 0.45;

            // Fade rather than clear → long, silky trails.
            ctx.globalCompositeOperation = 'destination-out';
            ctx.globalAlpha = reduced ? 1 : 0.1;
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';

            // Breathing core glow.
            const coreSize = R * (1.15 + 0.08 * Math.sin(t * 0.4)) * (1 + e * 0.15);
            ctx.globalAlpha = 0.05 + e * 0.04;
            ctx.drawImage(coreSprite, cx - coreSize / 2, cy - (coreSize * tilt) / 2, coreSize, coreSize * tilt);

            const warp = R * 0.06 * (1 + e * 0.6);
            for (const m of motes) {
                m.off += m.lag * dt * pace;
                const sway = Math.sin(t * m.wf + m.phase) * 0.06;
                const ang = rot * (1.25 - m.r * 0.5) + m.off + m.r * TWIST + sway;
                const rad = m.r * R * (1 + 0.04 * Math.sin(t * 0.3 + m.phase));
                let x = Math.cos(ang) * rad + m.sx * R;
                let y = Math.sin(ang) * rad + m.sy * R;
                // Gentle flow-field so the dust never moves in a perfect circle.
                x += Math.sin(y * 0.02 + t * 0.35 + m.phase) * warp;
                y += Math.cos(x * 0.018 - t * 0.3) * warp;

                const px = cx + x;
                const py = cy + y * tilt;
                const twinkle = 0.6 + 0.4 * Math.sin(t * 0.8 + m.phase * 3);
                ctx.globalAlpha = Math.min(1, m.alpha * twinkle * bright * (m.size > 16 ? 0.28 : 1));
                const s = m.size * (1 + e * 0.2);
                ctx.drawImage(m.hot ? hot[m.tone] : dust[m.tone], px - s / 2, py - s / 2, s, s);
            }

            ctx.globalAlpha = 1;
            id = requestAnimationFrame(frame);
        };
        id = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(id);
            ro.disconnect();
        };
    }, [energy]);

    return (
        <div className="nebula-mask relative size-[340px] sm:size-[480px]" aria-hidden>
            <canvas ref={ref} className="absolute inset-0 size-full" />
        </div>
    );
};

/* ---------- Journal ---------- */

const Journal = () => {
    const { energy, bump } = useTypingEnergy();

    const [text, setText] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [tagDraft, setTagDraft] = useState('');
    const [entries, setEntries] = useState<Entry[]>(loadEntries);

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
        bump(0.06);
    };

    const save = () => {
        if (!text.trim()) return;
        const pending = normalizeTag(tagDraft);
        const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
        const next = [{ id: Date.now(), text: text.trim(), tags: finalTags, createdAt: Date.now() }, ...entries].slice(0, 30);
        setEntries(next);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setText('');
        setTags([]);
        setTagDraft('');
        bump(0.7);
    };

    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    return (
        <div className="sky-bg relative min-h-screen overflow-x-hidden">
            <Atmosphere />

            <motion.header
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 2, ease: DRIFT }}
                className="relative z-10 flex items-center justify-between px-6 py-7 sm:px-12"
            >
                <span className="text-soft text-sm font-light uppercase tracking-[0.35em]">Astra</span>
                <span className="text-faint text-xs font-light tracking-[0.12em]">{today}</span>
            </motion.header>

            <main className="relative z-10 mx-auto flex w-full max-w-xl flex-col items-center px-5 pb-24">
                <motion.div
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 2.4, ease: DRIFT }}
                    className="-my-10 sm:-my-14"
                >
                    <Galaxy energy={energy} />
                </motion.div>

                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 2, delay: 0.8, ease: DRIFT }}
                    className="text-faint relative mb-8 text-center text-sm font-extralight tracking-[0.18em]"
                >
                    breathe in, let it out
                </motion.p>

                <motion.section
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 1.8, delay: 0.5, ease: DRIFT }}
                    className="glass glass-focus w-full rounded-[var(--radius)] px-6 py-6 sm:px-8 sm:py-7"
                >
                    <textarea
                        value={text}
                        onChange={onTextChange}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
                        }}
                        placeholder="What's drifting through your mind tonight?"
                        rows={5}
                        className="journal-field scrollbar-none w-full resize-none text-base leading-loose sm:text-lg"
                        aria-label="Journal entry"
                    />

                    <div className="glass-soft mt-5 flex flex-wrap items-center gap-2 rounded-full px-4 py-2.5">
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

                    <div className="mt-6 flex items-center justify-between gap-4">
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
                </motion.section>

                {entries.length > 0 && (
                    <motion.section
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 2, delay: 1, ease: DRIFT }}
                        className="mt-12 flex w-full flex-col gap-3"
                    >
                        <h2 className="text-faint px-2 text-[11px] font-light uppercase tracking-[0.3em]">Recent</h2>
                        <AnimatePresence initial={false}>
                            {entries.slice(0, 3).map((entry) => (
                                <motion.article
                                    key={entry.id}
                                    layout
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 1.2, ease: DRIFT }}
                                    className="glass-soft rounded-3xl px-5 py-4"
                                >
                                    <p className="text-soft line-clamp-2 text-sm font-light leading-relaxed">{entry.text}</p>
                                    <div className="text-faint mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-light tracking-wide">
                                        <span>
                                            {new Date(entry.createdAt).toLocaleTimeString(undefined, {
                                                hour: 'numeric',
                                                minute: '2-digit',
                                            })}
                                        </span>
                                        {entry.tags.map((t) => (
                                            <span key={t} className="tag-accent">
                                                #{t}
                                            </span>
                                        ))}
                                    </div>
                                </motion.article>
                            ))}
                        </AnimatePresence>
                    </motion.section>
                )}
            </main>
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
