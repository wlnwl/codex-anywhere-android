import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { getAppearance, setAppearance, subscribeAppearance, type Appearance } from './appearance';
import { t } from './i18n';
import './appearance-toggle.css';

const patterns = {
  day: [
    '.....#.....',
    '.#...#...#.',
    '..#.....#..',
    '....###....',
    '...#####...',
    '##.#####.##',
    '...#####...',
    '....###....',
    '..#.....#..',
    '.#...#...#.',
    '.....#.....',
  ],
  night: [
    '.....###...',
    '...####....',
    '..####.....',
    '.####......',
    '.####......',
    '.####......',
    '.#####.....',
    '..######..#',
    '...#######.',
    '....#####..',
    '.....##....',
  ],
} satisfies Record<Appearance, string[]>;

function PixelSymbol({ appearance, phase }: {
  appearance: Appearance;
  phase?: 'assembling' | 'dispersing';
}) {
  return (
    <svg className={`appearance-symbol ${appearance} ${phase || ''}`} viewBox="0 0 11 11" aria-hidden="true">
      {patterns[appearance].flatMap((row, y) => Array.from(row, (cell, x) => {
        if (cell !== '#') return null;
        // Fixed offsets let the pixels follow the same path on repeated toggles.
        const spread = 0.48 + ((x * 7 + y * 3) % 5) * 0.18;
        const pixelStyle = {
          '--drift-x': `${(x - 5) * spread + (appearance === 'night' ? 2 : -2)}px`,
          '--drift-y': `${(y - 5) * spread}px`,
          '--pixel-delay': `${((x * 11 + y * 7) % 6) * 12}ms`,
        } as CSSProperties;
        return <rect key={y * 11 + x} x={x + .09} y={y + .09} width=".82" height=".82" rx=".12" style={pixelStyle} />;
      }))}
    </svg>
  );
}

export function AppearanceToggle() {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const [previous, setPrevious] = useState<Appearance | null>(null);
  const [sequence, setSequence] = useState(0);

  useEffect(() => {
    if (!previous) return;
    const timer = window.setTimeout(() => setPrevious(null), 620);
    return () => window.clearTimeout(timer);
  }, [previous, sequence]);

  const night = appearance === 'night';
  return (
    <button
      type="button"
      className="appearance-toggle"
      role="switch"
      aria-checked={night}
      aria-label={t('夜间模式', 'Night mode')}
      title={night ? t('切换到日间模式', 'Switch to day mode') : t('切换到夜间模式', 'Switch to night mode')}
      onClick={() => {
        setPrevious(appearance);
        setSequence(value => value + 1);
        setAppearance(night ? 'day' : 'night');
      }}
    >
      <span className="appearance-stop appearance-stop-day" aria-hidden="true" />
      <span className="appearance-stop appearance-stop-night" aria-hidden="true" />
      <span className="appearance-thumb" aria-hidden="true">
        {previous && <PixelSymbol key={`out-${sequence}`} appearance={previous} phase="dispersing" />}
        <PixelSymbol key={`in-${sequence}`} appearance={appearance} phase={previous ? 'assembling' : undefined} />
      </span>
    </button>
  );
}
