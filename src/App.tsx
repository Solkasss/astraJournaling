import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'framer-motion';
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

/* ---------- Orb ---------- */

const Orb = ({ energy, ripples }: { energy: MotionValue<number>; ripples: number[] }) => {
    const coreScale = useTransform(energy, [0, 1], [1, 1.14]);
    const glowScale = useTransform(energy, [0, 1], [1, 1.6]);
    const glowOpacity = useTransform(energy, [0, 1], [0.55, 1]);
    const filter = useTransform(
        energy,
        [0, 1],
        ['hue-rotate(0deg) saturate(1) brightness(1)', 'hue-rotate(-55deg) saturate(1.35) brightness(1.15)'],
    );

    return (
        <div className="relative grid size-[200px] place-items-center sm:size-[260px]">
            <motion.div
                className="orb-glow absolute -inset-[45%] rounded-full"
                style={{ scale: glowScale, opacity: glowOpacity }}
            />
            {ripples.map((id) => (
                <motion.span
                    key={id}
                    className="orb-ring absolute inset-0 rounded-full"
                    initial={{ scale: 0.9, opacity: 0.75 }}
                    animate={{ scale: 2, opacity: 0 }}
                    transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
                />
            ))}
            <div className="orb-breathe relative size-full">
                <motion.div
                    className="orb-core absolute inset-0 overflow-hidden rounded-full"
                    style={{ scale: coreScale, filter }}
                >
                    <div className="orb-swirl absolute -inset-1/4" />
                    <div className="orb-highlight absolute" />
                </motion.div>
            </div>
        </div>
    );
};

/* ---------- Journal ---------- */

const Journal = () => {
    const { energy, bump } = useTypingEnergy();
    const [ripples, setRipples] = useState<number[]>([]);
    const lastRipple = useRef(0);

    const [text, setText] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [tagDraft, setTagDraft] = useState('');
    const [entries, setEntries] = useState<Entry[]>(loadEntries);

    const spawnRipple = useCallback((force = false) => {
        const now = performance.now();
        if (!force && now - lastRipple.current < 140) return;
        lastRipple.current = now;
        const id = now + Math.random();
        setRipples((r) => [...r.slice(-6), id]);
        window.setTimeout(() => setRipples((r) => r.filter((x) => x !== id)), 1500);
    }, []);

    const pulse = useCallback(
        (amount: number) => {
            bump(amount);
            spawnRipple();
        },
        [bump, spawnRipple],
    );

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
        [0, 180, 360].forEach((d) => window.setTimeout(() => spawnRipple(true), d));
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

            <main className="relative z-10 mx-auto flex w-full max-w-xl flex-col items-center gap-12 px-5 pb-20 pt-6 sm:pt-10">
                <motion.div
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
                >
                    <Orb energy={energy} ripples={ripples} />
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
