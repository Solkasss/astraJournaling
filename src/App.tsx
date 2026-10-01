import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { motion, useMotionValue, useSpring, type MotionValue } from 'framer-motion';
import { Hash, X } from 'lucide-react';
import NotFound from './pages/NotFound';

import '@solana/wallet-adapter-react-ui/styles.css';

/* ---------- Types & helpers ---------- */

type Entry = { id: number; text: string; tags: string[]; createdAt: number };

const STORAGE_KEY = 'astra-journal-entries';

/** Deterministic PRNG so the starfield is stable across renders. */
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

/** Typing "energy": spikes on keystrokes, decays smoothly every frame. */
const useTypingEnergy = () => {
    const raw = useMotionValue(0);
    const energy = useSpring(raw, { stiffness: 140, damping: 18 });

    useEffect(() => {
        let id = 0;
        const tick = () => {
            const v = raw.get();
            if (v > 0.001) raw.set(v * 0.95);
            id = requestAnimationFrame(tick);
        };
        id = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(id);
    }, [raw]);

    const bump = useCallback((amount: number) => raw.set(Math.min(1, raw.get() + amount)), [raw]);
    return { energy, bump };
};

/* ---------- Starfield ---------- */

const StarField = () => {
    const stars = useMemo(() => {
        const r = mulberry32(11);
        const tones = ['star--lavender', 'star--cyan', 'star--white'];
        return Array.from({ length: 120 }, (_, i) => ({
            id: i,
            x: r() * 100,
            y: r() * 100,
            size: r() < 0.08 ? 2.4 + r() * 1.4 : 0.8 + r() * 1.3,
            delay: r() * 6,
            duration: 3 + r() * 5,
            tone: tones[Math.floor(r() * tones.length)],
        }));
    }, []);

    return (
        <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
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
    );
};

/* ---------- Nebula (canvas) ---------- */

const TAU = Math.PI * 2;

/** Reads an HSL triplet token (e.g. "188 90% 60%") from :root. */
const readToken = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Pre-renders a soft radial glow sprite — far cheaper than shadowBlur per particle. */
const makeSprite = (tone: string, core?: string) => {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    if (!g) return c;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, `hsl(${core ?? tone} / 1)`);
    grad.addColorStop(0.18, `hsl(${tone} / 0.75)`);
    grad.addColorStop(0.5, `hsl(${tone} / 0.16)`);
    grad.addColorStop(1, `hsl(${tone} / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c;
};

type Particle = { a: number; r: number; speed: number; phase: number; wf: number; size: number; tone: number; hot: boolean; alpha: number };
type Cloud = { tone: number; phase: number; orbit: number; size: number; fx: number; fy: number };
type Spark = { x: number; y: number; vx: number; vy: number; life: number; tone: number; size: number };

const Nebula = ({ energy }: { energy: MotionValue<number> }) => {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const tones = ['--neon-cyan', '--neon-indigo', '--neon-purple'].map(readToken);
        const fg = readToken('--foreground');
        const dust = tones.map((t) => makeSprite(t));
        const hot = tones.map((t) => makeSprite(t, fg));
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const rand = mulberry32(7);

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

        // Swirling dust: inner particles orbit faster (differential rotation), some counter-rotate for chaos.
        const particles: Particle[] = Array.from({ length: 230 }, () => {
            const r = Math.pow(rand(), 0.65);
            return {
                a: rand() * TAU,
                r,
                speed: (0.12 + rand() * 0.25) * (1.3 - r) * (rand() < 0.22 ? -1 : 1),
                phase: rand() * TAU,
                wf: 0.4 + rand() * 0.9,
                size: rand() < 0.15 ? 4 + rand() * 8 : 10 + rand() * 26,
                tone: Math.floor(rand() * 3),
                hot: rand() < 0.14,
                alpha: 0.25 + rand() * 0.55,
            };
        });

        // Large, faint plasma clouds that give the matter its fluid body.
        const clouds: Cloud[] = Array.from({ length: 7 }, (_, i) => ({
            tone: i % 3,
            phase: rand() * TAU,
            orbit: 0.15 + rand() * 0.45,
            size: 0.7 + rand() * 0.7,
            fx: 0.15 + rand() * 0.3,
            fy: 0.12 + rand() * 0.3,
        }));

        const sparks: Spark[] = [];
        let t = 0;
        let last = performance.now();
        let prevE = 0;
        let id = 0;

        const frame = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const e = energy.get();
            const pace = (reduced ? 0.3 : 1) * (1 + e * 2.6);
            t += dt * pace;

            const cx = w / 2;
            const cy = h / 2;
            const R = Math.min(w, h) * 0.3 * (1 + e * 0.22);

            // Fade previous frame instead of clearing → soft motion trails on a transparent canvas.
            ctx.globalCompositeOperation = 'destination-out';
            ctx.globalAlpha = reduced ? 1 : 0.2;
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';

            for (const c of clouds) {
                const x = cx + Math.cos(t * c.fx + c.phase) * R * c.orbit + Math.sin(t * 0.6 + c.phase) * R * 0.12;
                const y = cy + Math.sin(t * c.fy + c.phase * 1.3) * R * c.orbit * 0.8;
                const s = R * c.size * 2 * (1 + 0.15 * Math.sin(t * 1.1 + c.phase) + e * 0.35);
                ctx.globalAlpha = 0.07 + e * 0.1;
                ctx.drawImage(dust[c.tone], x - s / 2, y - s / 2, s, s);
            }

            const warp = R * 0.2 * (1 + e * 0.9);
            for (const p of particles) {
                p.a += p.speed * dt * pace;
                const breathe = 1 + 0.2 * Math.sin(t * p.wf + p.phase);
                const rad = p.r * R * breathe * (1 + e * 0.35);
                let x = cx + Math.cos(p.a) * rad;
                let y = cy + Math.sin(p.a) * rad * 0.82;
                // Pseudo flow-field warp for the organic, liquid drift.
                x += Math.sin(y * 0.017 + t * 0.9 + p.phase) * warp * 0.5;
                y += Math.cos(x * 0.015 - t * 0.7) * warp * 0.5;

                const twinkle = 0.55 + 0.45 * Math.sin(t * 2 + p.phase * 3);
                ctx.globalAlpha = Math.min(1, p.alpha * twinkle * (0.65 + e * 0.9));
                const s = p.size * (1 + e * 0.5);
                ctx.drawImage(p.hot ? hot[p.tone] : dust[p.tone], x - s / 2, y - s / 2, s, s);
            }

            // Rising energy throws off sparks.
            const rise = e - prevE;
            prevE = e;
            if (!reduced && rise > 0.01 && sparks.length < 140) {
                const n = Math.min(10, 2 + Math.floor(rise * 120));
                for (let i = 0; i < n; i++) {
                    const ang = Math.random() * TAU;
                    const v = R * (0.5 + Math.random() * 1.3);
                    const off = R * 0.25 * Math.random();
                    sparks.push({
                        x: cx + Math.cos(ang) * off,
                        y: cy + Math.sin(ang) * off,
                        vx: Math.cos(ang) * v,
                        vy: Math.sin(ang) * v * 0.82,
                        life: 1,
                        tone: Math.floor(Math.random() * 3),
                        size: 6 + Math.random() * 10,
                    });
                }
            }
            for (let i = sparks.length - 1; i >= 0; i--) {
                const s = sparks[i];
                s.x += s.vx * dt;
                s.y += s.vy * dt;
                s.vx *= 0.97;
                s.vy *= 0.97;
                s.life -= dt * 1.1;
                if (s.life <= 0) {
                    sparks.splice(i, 1);
                    continue;
                }
                ctx.globalAlpha = s.life;
                ctx.drawImage(hot[s.tone], s.x - s.size / 2, s.y - s.size / 2, s.size, s.size);
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
        <div className="relative size-[300px] sm:size-[400px]" aria-hidden>
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

    const pulse = bump;

    const addTag = (raw: string) => {
        const tag = normalizeTag(raw);
        if (tag && !tags.includes(tag) && tags.length < 8) {
            setTags((t) => [...t, tag]);
            pulse(0.3);
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
        pulse(0.16 + Math.random() * 0.1);
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
        bump(1);
    };

    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    return (
        <div className="sky-bg relative min-h-screen overflow-x-hidden">
            <StarField />
            <div className="sky-vignette pointer-events-none fixed inset-0" aria-hidden />

            <header className="relative z-10 flex items-center justify-between px-6 py-6 sm:px-10">
                <span className="text-xl italic tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
                    AstraJournal
                </span>
                <span className="text-sm text-muted-foreground">{today}</span>
            </header>

            <main className="relative z-10 mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-5 pb-20 pt-2 sm:pt-4">
                <motion.div
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
                >
                    <Nebula energy={energy} />
                </motion.div>

                <motion.section
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.9, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    className="glass glass-focus w-full rounded-[var(--radius)] p-5 sm:p-6"
                >
                    <textarea
                        value={text}
                        onChange={onTextChange}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
                        }}
                        placeholder="What's drifting through your mind tonight?"
                        rows={5}
                        className="journal-field scrollbar-none w-full resize-none text-base leading-relaxed sm:text-lg"
                        aria-label="Journal entry"
                    />

                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-foreground/10 pt-4">
                        <Hash className="neon-text size-4 shrink-0" aria-hidden />
                        {tags.map((tag) => (
                            <span key={tag} className="tag-chip inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs">
                                #{tag}
                                <button
                                    type="button"
                                    onClick={() => setTags((t) => t.filter((x) => x !== tag))}
                                    className="opacity-60 transition-opacity hover:opacity-100"
                                    aria-label={`Remove ${tag}`}
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        ))}
                        <input
                            value={tagDraft}
                            onChange={(e) => {
                                setTagDraft(e.target.value);
                                bump(0.08);
                            }}
                            onKeyDown={onTagKeyDown}
                            onBlur={() => tagDraft.trim() && addTag(tagDraft)}
                            placeholder={tags.length ? '' : 'add tags'}
                            className="journal-field min-w-[6rem] flex-1 text-sm"
                            aria-label="Tags"
                        />
                    </div>

                    <div className="mt-5 flex items-center justify-between gap-4">
                        <span className="text-xs text-muted-foreground">
                            {words} {words === 1 ? 'word' : 'words'}
                        </span>
                        <button
                            type="button"
                            onClick={save}
                            disabled={!text.trim()}
                            className="neon-btn h-11 rounded-full px-6 text-sm font-semibold"
                        >
                            Release to the stars
                        </button>
                    </div>
                </motion.section>

                {entries.length > 0 && (
                    <section className="flex w-full flex-col gap-3">
                        <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Recent</h2>
                        {entries.slice(0, 3).map((entry) => (
                            <motion.article
                                key={entry.id}
                                layout
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="glass rounded-2xl px-4 py-3"
                            >
                                <p className="line-clamp-2 text-sm text-foreground/90">{entry.text}</p>
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                    <span>
                                        {new Date(entry.createdAt).toLocaleTimeString(undefined, {
                                            hour: 'numeric',
                                            minute: '2-digit',
                                        })}
                                    </span>
                                    {entry.tags.map((t) => (
                                        <span key={t} className="neon-text">
                                            #{t}
                                        </span>
                                    ))}
                                </div>
                            </motion.article>
                        ))}
                    </section>
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
