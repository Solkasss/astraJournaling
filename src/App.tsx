import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { AnimatePresence, motion, useMotionValue, useSpring, type MotionValue } from 'framer-motion';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import NotFound from './pages/NotFound';

import '@solana/wallet-adapter-react-ui/styles.css';

/* ---------- Helpers ---------- */

type Entry = { id: number; text: string; tags: string[]; createdAt: number };
type Tab = 'write' | 'sky';

const TABS: { id: Tab; label: string }[] = [
    { id: 'write', label: 'Write' },
    { id: 'sky', label: 'Sky Map' },
];

const STORAGE_KEY = 'astra-journal-entries';
const DRIFT = [0.22, 1, 0.36, 1] as const;
const TAU = Math.PI * 2;

/** Deterministic PRNG so the starfield and galaxy layout are stable across mounts. */
const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Unicode-aware tag sanitizer: keeps letters/digits in any script (Cyrillic, Latin, CJK…),
 * lowercases, and returns the canonical "#tag" form — or '' if nothing usable remains.
 */
const normalizeTag = (raw: string) => {
    const core = raw
        .replace(/^#+/, '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}_-]/gu, '')
        .slice(0, 32);
    return core ? `#${core}` : '';
};

const MAX_TAGS = 12;

/** "#думки #код" or "думки, код" → ['#думки', '#код'] (deduped). */
const parseTags = (raw: string) => {
    const parsed = [...new Set(raw.split(/[\s,;#]+/).map(normalizeTag).filter(Boolean))];
    // Never drop input entirely — e.g. emoji-only tags fall back to a slug of the raw text.
    if (!parsed.length && raw.trim()) {
        const slug = raw.trim().toLocaleLowerCase().replace(/^#+/, '').replace(/[\s,;#]+/g, '-').slice(0, 32);
        if (slug) return [`#${slug}`];
    }
    return parsed;
};

/** Every inline #hashtag in free text, e.g. "сьогодні #думки про #код" → ['#думки', '#код']. */
const extractHashtags = (text: string) =>
    [...new Set((text.match(/#[\p{L}\p{N}_-]+/gu) ?? []).map(normalizeTag).filter(Boolean))];

const mergeTags = (...lists: string[][]) => [...new Set(lists.flat().map(normalizeTag).filter(Boolean))].slice(0, MAX_TAGS);

/** Loads entries and migrates older ones (tags saved without '#', mixed case) to canonical form. */
const loadEntries = (): Entry[] => {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Entry[];
        // Only legacy entries without a tags array fall back to inline #hashtags, so edited tags stick.
        return raw.map((e) => ({
            ...e,
            tags: Array.isArray(e.tags) ? mergeTags(e.tags) : extractHashtags(e.text ?? ''),
        }));
    } catch {
        return [];
    }
};

/** Reads an HSL triplet token (e.g. "271 91% 65%") from :root. */
const readToken = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/** Pre-rendered soft dust sprite — a gradient with no edge at all. */
const makeDust = (tone: string) => {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    if (!g) return c;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, `hsl(${tone} / 0.6)`);
    grad.addColorStop(0.35, `hsl(${tone} / 0.25)`);
    grad.addColorStop(0.7, `hsl(${tone} / 0.06)`);
    grad.addColorStop(1, `hsl(${tone} / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c;
};

/** Pre-rendered star sprite — bright pinpoint with a soft halo. */
const makeStar = (tone: string, core: string) => {
    const s = 32;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    if (!g) return c;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, `hsl(${core} / 1)`);
    grad.addColorStop(0.1, `hsl(${core} / 0.9)`);
    grad.addColorStop(0.25, `hsl(${tone} / 0.35)`);
    grad.addColorStop(0.6, `hsl(${tone} / 0.06)`);
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

/* ---------- Spiral galaxy (logarithmic spiral particle canvas) ---------- */

const ARMS = 3;
const SPIRAL_A = 0.06; // r = a · e^(bθ), normalized so the arm tip sits at r = 1
const THETA_MAX = 2.3 * Math.PI;
const SPIRAL_B = Math.log(1 / SPIRAL_A) / THETA_MAX;
const TILT = 0.74; // gentle perspective squash of the galactic plane
const PLANE = -0.38; // diagonal orientation of the plane on screen
const CENTER_Y = 0.4;

/** Galaxy-plane particle in polar coordinates; alpha already includes radial falloff. */
type Particle = {
    r: number;
    a: number;
    size: number; // fraction of R for dust, px for stars
    alpha: number;
    sprite: HTMLCanvasElement;
    tw: number; // twinkle speed (0 = steady)
    ph: number;
};

/** Density/brightness falloff: dense core, fading arms, dissolving to nothing by r ≈ 1.45. */
const falloff = (r: number) => Math.exp(-r * r * 1.3) * (1 - smoothstep(0.9, 1.45, r));

const buildGalaxy = (sprites: {
    dust: HTMLCanvasElement[]; // [purple, orchid, lavender]
    coreDust: HTMLCanvasElement;
    stars: HTMLCanvasElement[]; // [white, orchid, lavender]
}) => {
    const rand = mulberry32(2024);
    const gauss = () => {
        let u = 0;
        while (!u) u = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand());
    };
    const toPolar = (x: number, y: number) => ({ r: Math.hypot(x, y), a: Math.atan2(y, x) });

    /** A point on arm `k` at spiral angle θ, scattered perpendicular-ish by `spread`. */
    const armPoint = (k: number, theta: number, spread: number) => {
        const r = SPIRAL_A * Math.exp(SPIRAL_B * theta);
        const base = theta + (k * TAU) / ARMS;
        const s = spread * (0.35 + r);
        return toPolar(Math.cos(base) * r + gauss() * s, Math.sin(base) * r + gauss() * s);
    };

    const dust: Particle[] = [];
    const stars: Particle[] = [];

    // Bulge haze — dense, bright white-lavender.
    for (let i = 0; i < 70; i++) {
        const p = toPolar(gauss() * 0.11, gauss() * 0.11);
        dust.push({ ...p, size: 0.14 + rand() * 0.22, alpha: 0.07 + rand() * 0.06, sprite: sprites.coreDust, tw: 0, ph: rand() * TAU });
    }

    // Arm dust — medium density purple / orchid clouds.
    for (let k = 0; k < ARMS; k++) {
        for (let i = 0; i < 300; i++) {
            const theta = THETA_MAX * Math.pow(rand(), 0.9);
            const p = armPoint(k, theta, 0.075);
            const tone = p.r < 0.3 ? (rand() < 0.6 ? 2 : 1) : rand() < 0.55 ? 0 : 1;
            dust.push({
                ...p,
                size: 0.05 + rand() * 0.13 * (0.6 + p.r),
                alpha: (0.06 + rand() * 0.1) * falloff(p.r * 0.85),
                sprite: sprites.dust[tone],
                tw: 0,
                ph: rand() * TAU,
            });
        }
    }

    // Sparse outer dust — dissolving into deep space.
    for (let i = 0; i < 160; i++) {
        const p = toPolar(gauss() * 0.6, gauss() * 0.6);
        dust.push({ ...p, size: 0.1 + rand() * 0.2, alpha: 0.03 * falloff(p.r * 0.7), sprite: sprites.dust[rand() < 0.5 ? 0 : 1], tw: 0, ph: rand() * TAU });
    }

    // Core stars — tightly packed glitter.
    for (let i = 0; i < 260; i++) {
        const p = toPolar(gauss() * 0.075, gauss() * 0.075);
        stars.push({ ...p, size: 2 + rand() * 4, alpha: 0.4 + rand() * 0.5, sprite: sprites.stars[rand() < 0.6 ? 0 : 2], tw: 0.5 + rand() * 1.5, ph: rand() * TAU });
    }

    // Arm star clusters — little constellations strung along each arm.
    for (let k = 0; k < ARMS; k++) {
        for (let c = 0; c < 16; c++) {
            const theta = THETA_MAX * (0.15 + rand() * 0.85);
            const centre = armPoint(k, theta, 0.03);
            const cx = Math.cos(centre.a) * centre.r;
            const cy = Math.sin(centre.a) * centre.r;
            const n = 5 + Math.floor(rand() * 10);
            for (let i = 0; i < n; i++) {
                const p = toPolar(cx + gauss() * 0.022, cy + gauss() * 0.022);
                stars.push({
                    ...p,
                    size: 2 + rand() * 5,
                    alpha: (0.45 + rand() * 0.5) * falloff(p.r * 0.7),
                    sprite: sprites.stars[Math.floor(rand() * 3)],
                    tw: 0.4 + rand() * 1.4,
                    ph: rand() * TAU,
                });
            }
        }
        // Loose stars tracing the arm.
        for (let i = 0; i < 110; i++) {
            const p = armPoint(k, THETA_MAX * rand(), 0.06);
            stars.push({
                ...p,
                size: 1.5 + rand() * 3.5,
                alpha: (0.3 + rand() * 0.5) * falloff(p.r * 0.75),
                sprite: sprites.stars[Math.floor(rand() * 3)],
                tw: 0.3 + rand() * 1.2,
                ph: rand() * TAU,
            });
        }
    }

    // Faint field stars around the galaxy.
    for (let i = 0; i < 90; i++) {
        const p = toPolar((rand() * 2 - 1) * 1.4, (rand() * 2 - 1) * 1.4);
        stars.push({ ...p, size: 1.5 + rand() * 2.5, alpha: 0.25 * falloff(p.r * 0.6), sprite: sprites.stars[0], tw: 0.3 + rand(), ph: rand() * TAU });
    }

    return { dust, stars };
};

const SpiralGalaxy = ({ energy }: { energy: MotionValue<number> }) => {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const purple = readToken('--galaxy-purple');
        const orchid = readToken('--galaxy-orchid');
        const lavender = readToken('--star-lavender');
        const core = readToken('--galaxy-core');

        const coreGlow = makeDust(core);
        const { dust, stars } = buildGalaxy({
            dust: [makeDust(purple), makeDust(orchid), makeDust(lavender)],
            coreDust: coreGlow,
            stars: [makeStar(lavender, core), makeStar(orchid, core), makeStar(purple, core)],
        });

        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const cosP = Math.cos(PLANE);
        const sinP = Math.sin(PLANE);

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

        let t = 0;
        let rot = 0;
        let last = performance.now();
        let id = 0;

        const frame = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const e = energy.get();
            const pace = (reduced ? 0.25 : 1) * (1 + e * 1.4);
            t += dt * pace;
            rot += dt * 0.03 * pace; // ~3.5 minutes per revolution

            const cx = w * 0.5;
            const cy = h * CENTER_Y;
            const R = Math.min(w * 0.44, h * 0.4);

            ctx.clearRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';

            /** Galaxy-plane polar → screen, with rigid rotation, tilt and diagonal plane. */
            const project = (r: number, a: number) => {
                const ang = a + rot;
                const x = Math.cos(ang) * r * R;
                const y = Math.sin(ang) * r * R * TILT;
                return [cx + x * cosP - y * sinP, cy + x * sinP + y * cosP] as const;
            };

            // Wide, soft halo under everything.
            const halo = R * 1.5 * (1 + e * 0.1);
            ctx.globalAlpha = 0.14 + e * 0.1;
            ctx.drawImage(coreGlow, cx - halo / 2, cy - halo / 2, halo, halo);

            for (const p of dust) {
                const breathe = 1 + 0.02 * Math.sin(t * 0.25 + p.ph);
                const [x, y] = project(p.r * breathe, p.a);
                const s = p.size * R;
                ctx.globalAlpha = Math.min(1, p.alpha * (0.85 + e * 0.35));
                ctx.drawImage(p.sprite, x - s / 2, y - s / 2, s, s);
            }

            for (const p of stars) {
                const [x, y] = project(p.r, p.a);
                const twinkle = 0.55 + 0.45 * Math.sin(t * p.tw + p.ph);
                ctx.globalAlpha = Math.min(1, p.alpha * twinkle * (0.9 + e * 0.3));
                const s = p.size * 2.4;
                ctx.drawImage(p.sprite, x - s / 2, y - s / 2, s, s);
            }

            // Bright, hazy core — glow brightness follows typing energy.
            const pulse = 1 + 0.04 * Math.sin(t * 0.5);
            const inner = R * 0.42 * pulse * (1 + e * 0.25);
            ctx.globalAlpha = Math.min(1, 0.5 + e * 0.4);
            ctx.drawImage(coreGlow, cx - inner / 2, cy - inner / 2, inner, inner);
            const hot = inner * 0.38;
            ctx.globalAlpha = Math.min(1, 0.65 + e * 0.35);
            ctx.drawImage(coreGlow, cx - hot / 2, cy - hot / 2, hot, hot);

            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            id = requestAnimationFrame(frame);
        };
        id = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(id);
            ro.disconnect();
        };
    }, [energy]);

    return <canvas ref={ref} className="pointer-events-none absolute inset-0 size-full" aria-hidden />;
};

/* ---------- Sky Map ---------- */

/** Stable position for each saved entry, derived from its id. */
const starPosition = (id: number) => {
    const r = mulberry32(id);
    return { x: 8 + r() * 84, y: 16 + r() * 66 };
};

/** A pair of entries that share at least one tag. */
type Link = { a: number; b: number; tags: string[] };
/** Physics body for an entry star (pixel space). */
type Body = { x: number; y: number; vx: number; vy: number };

// Force tuning (all scaled by the short side of the viewport, S).
const REPULSION = 0.0016; // strangers push apart (~1/d²)
const KIN_REPULSION = 0.3; // stars sharing tags only resist overlapping
const SPRING = 2.2; // attraction per shared tag (capped at 3 shared)
const REST_MIN = 0.03; // rest length = S · (REST_MIN + REST_SPAN / sharedTags²) → 2+ tags pull much closer
const REST_SPAN = 0.12;

/** Shared-tag counts for every pair, plus the linked pairs and tag groups. */
const buildGraph = (entries: Entry[]) => {
    const n = entries.length;
    const shared = new Uint8Array(n * n);
    const pairs: Link[] = [];
    const byTag = new Map<string, number[]>();
    // Case-insensitive comparison: canonicalize every tag before matching.
    const norm = entries.map((e) => mergeTags(e.tags));
    const sets = norm.map((t) => new Set(t));

    norm.forEach((tags, i) =>
        tags.forEach((t) => {
            const list = byTag.get(t) ?? [];
            list.push(i);
            byTag.set(t, list);
        }),
    );

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const tags = norm[j].filter((t) => sets[i].has(t));
            if (!tags.length) continue;
            shared[i * n + j] = shared[j * n + i] = Math.min(255, tags.length);
            pairs.push({ a: i, b: j, tags });
        }
    }

    return { shared, pairs, byTag, norm };
};

const formatDate = (ts: number) =>
    new Date(ts).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Two-step clear: first click arms it for 3s, second click within that window clears. */
const ClearButton = ({ onConfirm }: { onConfirm: () => void }) => {
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (!armed) return;
        const id = window.setTimeout(() => setArmed(false), 3000);
        return () => window.clearTimeout(id);
    }, [armed]);

    return (
        <button
            type="button"
            onClick={() => {
                if (armed) {
                    setArmed(false);
                    onConfirm();
                } else {
                    setArmed(true);
                }
            }}
            className={`glass-soft h-11 rounded-full px-5 text-xs tracking-[0.12em] transition-colors duration-500 ${
                armed ? 'tag-chip text-soft' : 'text-faint hover:text-soft'
            }`}
            aria-live="polite"
        >
            {armed ? 'Ви точно хочете очистити?' : 'Очистити'}
        </button>
    );
};

/** Inline hashtag editor + delete action shown inside the star modal. */
const EntryActions = ({
    tags,
    onSaveTags,
    onDelete,
}: {
    tags: string[];
    onSaveTags: (tags: string[]) => void;
    onDelete: () => void;
}) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');

    const startEdit = () => {
        setDraft(tags.join(' '));
        setEditing(true);
    };
    const commit = () => {
        onSaveTags(mergeTags(parseTags(draft)));
        setEditing(false);
    };

    return (
        <div className="mt-6 flex flex-col gap-4">
            {editing ? (
                <div className="glass-soft flex items-center gap-2 rounded-full py-1 pl-4 pr-1">
                    <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                commit();
                            } else if (e.key === 'Escape') {
                                e.stopPropagation();
                                setEditing(false);
                            }
                        }}
                        placeholder="#думки #код"
                        aria-label="Edit hashtags"
                        className="text-soft min-w-0 flex-1 bg-transparent text-sm tracking-wide outline-none placeholder:text-muted-foreground/50"
                    />
                    <button
                        type="button"
                        onClick={() => setEditing(false)}
                        className="text-faint grid size-9 place-items-center rounded-full transition-colors duration-500 hover:text-soft"
                        aria-label="Cancel editing"
                    >
                        <X className="size-4" strokeWidth={1.5} />
                    </button>
                    <button
                        type="button"
                        onClick={commit}
                        className="tag-chip text-soft grid size-9 place-items-center rounded-full transition-opacity duration-500 hover:opacity-80"
                        aria-label="Save hashtags"
                    >
                        <Check className="size-4" strokeWidth={1.5} />
                    </button>
                </div>
            ) : (
                tags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                        {tags.map((tag) => (
                            <span key={tag} className="tag-chip rounded-full px-3 py-1 text-xs tracking-wide">
                                {tag}
                            </span>
                        ))}
                    </div>
                )
            )}

            {!editing && (
                <div className="flex items-center justify-between gap-3">
                    <button
                        type="button"
                        onClick={startEdit}
                        className="glass-soft text-faint inline-flex h-10 items-center gap-2 rounded-full px-4 text-xs tracking-[0.12em] transition-colors duration-500 hover:text-soft"
                    >
                        <Pencil className="size-3.5" strokeWidth={1.5} />
                        Редагувати теги
                    </button>
                    <button
                        type="button"
                        onClick={onDelete}
                        className="glass-soft text-faint inline-flex h-10 items-center gap-2 rounded-full px-4 text-xs tracking-[0.12em] transition-colors duration-500 hover:text-destructive"
                    >
                        <Trash2 className="size-3.5" strokeWidth={1.5} />
                        Видалити
                    </button>
                </div>
            )}
        </div>
    );
};

const SkyMap = ({
    entries,
    onClear,
    onDelete,
    onUpdateTags,
}: {
    entries: Entry[];
    onClear: () => void;
    onDelete: (id: number) => void;
    onUpdateTags: (id: number, tags: string[]) => void;
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const pointsRef = useRef<Body[]>([]);
    const bodiesRef = useRef(new Map<number, Body>());
    const hoverRef = useRef(-1);
    const selectedRef = useRef(-1);
    const [selected, setSelected] = useState<number | null>(null);
    const graph = useMemo(() => buildGraph(entries), [entries]);

    useEffect(() => {
        selectedRef.current = selected ?? -1;
        if (selected === null) return;
        const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setSelected(null);
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selected]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const core = readToken('--galaxy-core');
        const orchid = readToken('--galaxy-orchid');
        const cyan = readToken('--star-cyan');
        const halos = [makeDust(orchid), makeDust(cyan)];
        const starSprites = [makeStar(orchid, core), makeStar(cyan, core)];
        const labelTone = `hsl(${core} / 0.75)`;
        const font = getComputedStyle(document.body).fontFamily;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const rand = mulberry32(77);
        const ambient = Array.from({ length: 220 }, () => ({
            x: rand(),
            y: rand(),
            r: rand() < 0.08 ? 1.1 + rand() * 0.6 : 0.4 + rand() * 0.6,
            ph: rand() * TAU,
            tw: 0.3 + rand() * 1.2,
        }));
        const phases = entries.map((e) => mulberry32(e.id ^ 0x9e37)() * TAU);
        const bodies = bodiesRef.current;
        const n = entries.length;
        // Drop physics state for stars that no longer exist (e.g. after clearing).
        const alive = new Set(entries.map((e) => e.id));
        for (const key of bodies.keys()) if (!alive.has(key)) bodies.delete(key);

        let w = 0;
        let h = 0;
        let pw = 0;
        let ph = 0;
        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            w = rect.width;
            h = rect.height;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            // Keep stars where they were, proportionally, when the viewport changes.
            if (pw && ph) {
                for (const b of bodies.values()) {
                    b.x *= w / pw;
                    b.y *= h / ph;
                }
            }
            pw = w;
            ph = h;
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        // One body per entry: existing stars keep their state, new ones appear at their seeded spot.
        const list = entries.map((e) => {
            let b = bodies.get(e.id);
            if (!b) {
                const p = starPosition(e.id);
                b = { x: (p.x / 100) * w, y: (p.y / 100) * h, vx: 0, vy: 0 };
                bodies.set(e.id, b);
            }
            return b;
        });
        const ax = new Float32Array(n);
        const ay = new Float32Array(n);

        /** Force-directed step: shared tags attract (springs), strangers repel, soft walls frame the sky. */
        const step = (dt: number) => {
            const S = Math.min(w, h);
            const left = 32;
            const right = w - 32;
            const top = 104;
            const bottom = h - 48;
            const soft2 = (S * 0.03) ** 2;
            const rep = S * S * S * REPULSION;
            ax.fill(0);
            ay.fill(0);

            for (let i = 0; i < n; i++) {
                const a = list[i];
                for (let j = i + 1; j < n; j++) {
                    const b = list[j];
                    let dx = b.x - a.x;
                    let dy = b.y - a.y;
                    let d2 = dx * dx + dy * dy;
                    if (d2 < 1e-4) {
                        dx = Math.random() - 0.5;
                        dy = Math.random() - 0.5;
                        d2 = dx * dx + dy * dy;
                    }
                    const d = Math.sqrt(d2);
                    const k = graph.shared[i * n + j];
                    let f = (rep * (k ? KIN_REPULSION : 1)) / (d2 + soft2);
                    if (k) {
                        const kk = Math.min(3, k);
                        f -= SPRING * kk * (d - S * (REST_MIN + REST_SPAN / (kk * kk)));
                    }
                    const fx = (dx / d) * f;
                    const fy = (dy / d) * f;
                    ax[i] -= fx;
                    ay[i] -= fy;
                    ax[j] += fx;
                    ay[j] += fy;
                }
            }

            const damp = Math.pow(0.15, dt);
            const vmax = S * 0.35;
            const midY = (top + bottom) / 2;
            for (let i = 0; i < n; i++) {
                const b = list[i];
                let fx = ax[i] + (w / 2 - b.x) * 0.015;
                let fy = ay[i] + (midY - b.y) * 0.015;
                if (b.x < left) fx += (left - b.x) * 6;
                else if (b.x > right) fx -= (b.x - right) * 6;
                if (b.y < top) fy += (top - b.y) * 6;
                else if (b.y > bottom) fy -= (b.y - bottom) * 6;

                b.vx = (b.vx + fx * dt) * damp;
                b.vy = (b.vy + fy * dt) * damp;
                const sp = Math.hypot(b.vx, b.vy);
                if (sp > vmax) {
                    b.vx *= vmax / sp;
                    b.vy *= vmax / sp;
                }
                b.x += b.vx * dt;
                b.y += b.vy * dt;
            }
        };

        let t = 0;
        let last = performance.now();
        let id = 0;

        const frame = (now: number) => {
            const dt = Math.min(1 / 30, (now - last) / 1000);
            last = now;
            t += dt * (reduced ? 0.25 : 1);

            step(dt);
            const pts = list;
            pointsRef.current = pts;

            const focus = hoverRef.current >= 0 ? hoverRef.current : selectedRef.current;
            const focusTags = new Set(focus >= 0 ? graph.norm[focus] ?? [] : []);
            const related = (i: number) => i === focus || graph.norm[i].some((tg) => focusTags.has(tg));
            const hasFocus = focus >= 0;

            ctx.clearRect(0, 0, w, h);

            // Ambient background stars.
            ctx.fillStyle = `hsl(${core})`;
            for (const s of ambient) {
                ctx.globalAlpha = 0.12 + 0.28 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph));
                ctx.beginPath();
                ctx.arc(s.x * w, s.y * h, s.r, 0, TAU);
                ctx.fill();
            }

            // No connecting lines — clusters emerge purely from the tag-attraction physics.
            ctx.globalCompositeOperation = 'lighter';

            // Entry stars — pulsing pinpoint over a soft purple / cyan halo.
            entries.forEach((entry, i) => {
                const p = pts[i];
                const pulse = 0.5 + 0.5 * Math.sin(t * 1.1 + phases[i]);
                const lit = related(i);
                const dim = hasFocus && !lit ? 0.35 : 1;
                const tone = entry.id % 2;
                const base = 1 + Math.min(1.2, entry.text.length / 300);

                const halo = (34 + pulse * 10) * base * (i === focus ? 1.5 : 1);
                ctx.globalAlpha = (0.35 + pulse * 0.2) * dim;
                ctx.drawImage(halos[tone], p.x - halo / 2, p.y - halo / 2, halo, halo);

                const s = (16 + pulse * 4) * base * (i === focus ? 1.3 : 1);
                ctx.globalAlpha = Math.min(1, (0.75 + pulse * 0.25) * dim);
                ctx.drawImage(starSprites[tone], p.x - s / 2, p.y - s / 2, s, s);
            });

            // Tag labels at the centroid of each highlighted constellation.
            ctx.globalCompositeOperation = 'source-over';
            if (hasFocus) {
                ctx.font = `300 12px ${font}`;
                ctx.textAlign = 'center';
                ctx.fillStyle = labelTone;
                ctx.globalAlpha = 1;
                focusTags.forEach((tag) => {
                    const idx = graph.byTag.get(tag) ?? [];
                    if (!idx.length) return;
                    const cx = idx.reduce((a, i) => a + pts[i].x, 0) / idx.length;
                    const cy = idx.reduce((a, i) => a + pts[i].y, 0) / idx.length;
                    ctx.fillText(tag, cx, cy - (idx.length > 1 ? 18 : 26));
                });
            }

            ctx.globalAlpha = 1;
            id = requestAnimationFrame(frame);
        };
        id = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(id);
            ro.disconnect();
        };
    }, [entries, graph]);

    /** Nearest entry star within a forgiving touch radius. */
    const pick = (clientX: number, clientY: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return -1;
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        let best = 24 * 24;
        let hit = -1;
        pointsRef.current.forEach((p, i) => {
            const d = (p.x - x) ** 2 + (p.y - y) ** 2;
            if (d < best) [best, hit] = [d, i];
        });
        return hit;
    };

    const entry = selected !== null ? entries[selected] : null;
    const entryTags = selected !== null ? graph.norm[selected] ?? [] : [];
    const linked =
        selected !== null ? graph.pairs.filter((p) => p.a === selected || p.b === selected).length : 0;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.2, ease: DRIFT }}
            className="absolute inset-0"
        >
            <canvas
                ref={canvasRef}
                className="absolute inset-0 size-full"
                aria-label="Constellation map of saved entries"
                onPointerMove={(e) => {
                    hoverRef.current = pick(e.clientX, e.clientY);
                    e.currentTarget.style.cursor = hoverRef.current >= 0 ? 'pointer' : 'default';
                }}
                onPointerLeave={() => (hoverRef.current = -1)}
                onClick={(e) => {
                    const hit = pick(e.clientX, e.clientY);
                    setSelected(hit >= 0 ? hit : null);
                }}
            />

            {entries.length > 0 && (
                <div className="absolute bottom-6 right-6 z-10 sm:bottom-8 sm:right-12">
                    <ClearButton
                        onConfirm={() => {
                            setSelected(null);
                            hoverRef.current = -1;
                            onClear();
                        }}
                    />
                </div>
            )}

            {entries.length === 0 && (
                <p className="text-faint pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm font-light tracking-[0.12em]">
                    No stars yet. Write something and release it.
                </p>
            )}

            <AnimatePresence>
                {entry && (
                    <motion.div
                        key="entry-modal"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.5, ease: DRIFT }}
                        className="fixed inset-0 z-30 flex items-center justify-center px-4"
                    >
                        <button
                            type="button"
                            aria-label="Close entry"
                            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
                            onClick={() => setSelected(null)}
                        />
                        <motion.article
                            role="dialog"
                            aria-modal="true"
                            aria-label="Journal entry"
                            initial={{ opacity: 0, y: 16, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.98 }}
                            transition={{ duration: 0.6, ease: DRIFT }}
                            className="glass relative w-full max-w-lg rounded-[var(--radius)] px-6 py-6 sm:px-8 sm:py-7"
                        >
                            <div className="flex items-start justify-between gap-4">
                                <span className="text-faint text-xs font-light uppercase tracking-[0.2em]">
                                    {formatDate(entry.createdAt)}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setSelected(null)}
                                    className="text-faint -mr-2 -mt-2 grid size-9 place-items-center rounded-full transition-colors duration-500 hover:text-soft"
                                    aria-label="Close"
                                >
                                    <X className="size-4" strokeWidth={1.5} />
                                </button>
                            </div>

                            <p className="text-soft scrollbar-none mt-4 max-h-[50dvh] overflow-y-auto whitespace-pre-wrap text-base leading-loose sm:text-lg">
                                {entry.text}
                            </p>

                            <EntryActions
                                key={entry.id}
                                tags={entryTags}
                                onSaveTags={(next) => onUpdateTags(entry.id, next)}
                                onDelete={() => {
                                    setSelected(null);
                                    hoverRef.current = -1;
                                    onDelete(entry.id);
                                }}
                            />

                            <p className="text-faint mt-5 text-xs font-light tracking-[0.12em]">
                                {entryTags.length === 0
                                    ? 'No tags on this star'
                                    : linked > 0
                                      ? `Clustered with ${linked} ${linked === 1 ? 'star' : 'stars'} through ${entryTags.join(' ')}`
                                      : `No other stars share ${entryTags.join(' ')} yet`}
                            </p>
                        </motion.article>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};

/* ---------- Journal ---------- */

const Journal = () => {
    const { energy, bump } = useTypingEnergy();

    const [text, setText] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [tagDraft, setTagDraft] = useState('');
    const [tab, setTab] = useState<Tab>('write');
    const [entries, setEntries] = useState<Entry[]>(loadEntries);

    /** Updates state and localStorage together. */
    const persist = (next: Entry[]) => {
        setEntries(next);
        if (next.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        else localStorage.removeItem(STORAGE_KEY);
    };

    /** Adds every tag found in `raw` (space / comma / # separated). */
    const addTags = (raw: string) => {
        const incoming = parseTags(raw);
        if (!incoming.length) return;
        setTags((t) => mergeTags(t, incoming));
        bump(0.1 + 0.05 * incoming.length);
    };

    /** Commits every finished token as you type or paste; the trailing fragment stays as a draft. */
    const onTagChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        bump(0.03);
        const match = value.match(/^(.*[\s,])([^\s,]*)$/);
        if (match) {
            addTags(match[1]);
            setTagDraft(match[2]);
        } else {
            setTagDraft(value);
        }
    };

    const commitDraft = () => {
        if (!tagDraft.trim()) return;
        addTags(tagDraft);
        setTagDraft('');
    };

    const onTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && tagDraft.trim()) {
            e.preventDefault();
            commitDraft();
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
        // Chips + unfinished draft + any inline #hashtags in the entry text.
        const finalTags = mergeTags(tags, parseTags(tagDraft), extractHashtags(text));
        const entry: Entry = { id: Date.now(), text: text.trim(), tags: finalTags, createdAt: Date.now() };
        const next = [entry, ...entries].slice(0, 100);
        setEntries(next);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setText('');
        setTags([]);
        setTagDraft('');
        setTab('sky');
    };

    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    return (
        <div className="sky-bg relative flex h-[100dvh] min-h-[560px] flex-col overflow-hidden">
            {tab === 'write' && <Atmosphere />}

            {tab === 'write' ? (
                <motion.div
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 3, ease: DRIFT }}
                    className="absolute inset-0"
                >
                    <SpiralGalaxy energy={energy} />
                </motion.div>
            ) : (
                <SkyMap
                    entries={entries}
                    onClear={() => persist([])}
                    onDelete={(id) => persist(entries.filter((e) => e.id !== id))}
                    onUpdateTags={(id, next) =>
                        persist(entries.map((e) => (e.id === id ? { ...e, tags: next } : e)))
                    }
                />
            )}

            <motion.header
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 2, ease: DRIFT }}
                className="relative z-10 flex items-center justify-between px-6 py-7 sm:px-12"
            >
                <span className="text-soft text-sm font-light uppercase tracking-[0.35em]">Astra</span>
                <nav className="glass-soft flex items-center gap-1 rounded-full p-1" role="tablist">
                    {TABS.map(({ id, label }) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={tab === id}
                            onClick={() => setTab(id)}
                            className={`h-9 rounded-full px-4 text-xs tracking-[0.12em] transition-colors duration-500 ${
                                tab === id ? 'tag-chip text-soft' : 'text-faint hover:text-soft'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </nav>
                <span className="text-faint hidden text-xs font-light tracking-[0.12em] sm:inline">{today}</span>
            </motion.header>

            <div className="flex-1" />

            {tab === 'write' && (
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
                            onChange={onTagChange}
                            onKeyDown={onTagKeyDown}
                            onBlur={commitDraft}
                            placeholder={tags.length ? '' : '#dreams #night #thoughts'}
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
            )}
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
