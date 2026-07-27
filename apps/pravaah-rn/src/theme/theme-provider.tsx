/**
 * Resolves the OS appearance into a palette, once, at the top of the tree.
 *
 * There is deliberately no in-app theme switch. A printed object does not have
 * one, and the OS setting is already the control the user reached for. What the
 * app DOES do — unlike the web sheet — is honour that setting, because the use
 * scene is a phone read outdoors in daylight and in a dim room at night.
 */
import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { useReducedMotion } from 'react-native-reanimated';

// The project's own hook, not RN's: the `.web` variant defers to 'light' until
// hydration so static web rendering does not flash the wrong scheme. On native it
// is a straight re-export of RN's hook.
import { useColorScheme } from '@/hooks/use-color-scheme';

import {
  BAND_INK,
  Palette as Palettes,
  type BandInk,
  type Palette,
} from './tokens';

type Scheme = 'light' | 'dark';

interface ThemeValue {
  scheme: Scheme;
  palette: Palette;
  /** Score-band inks for the active scheme. */
  band: BandInk;
  /** False when the OS asks for reduced motion. */
  motionOk: boolean;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const os = useColorScheme();
  // Reanimated reads the OS Reduce Motion / Remove animations setting and updates
  // live, so a user turning it on mid-session gets the static app immediately.
  const reduced = useReducedMotion();

  const value = useMemo<ThemeValue>(() => {
    const scheme: Scheme = os === 'dark' ? 'dark' : 'light';
    return {
      scheme,
      palette: Palettes[scheme],
      band: BAND_INK[scheme],
      motionOk: !reduced,
    };
  }, [os, reduced]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

/** The active palette. The hook nearly every component wants. */
export function usePalette(): Palette {
  return useTheme().palette;
}

export function useScheme(): Scheme {
  return useTheme().scheme;
}

export function useIsDark(): boolean {
  return useTheme().scheme === 'dark';
}

/**
 * Score-band inks for the active scheme.
 *
 * Returns a resolver rather than the record so a caller with a possibly-null band
 * (an uncomputed score) does not have to special-case it at every use site.
 */
export function useBand(): (band: string | null | undefined) => string {
  const { band, palette } = useTheme();
  return (b) => (b && b in band ? band[b as keyof BandInk] : palette.inkDim);
}

/**
 * Whether animation may run. Every animated component checks this and jumps
 * straight to its final value when false — never to a hidden one.
 */
export function useMotionOk(): boolean {
  return useTheme().motionOk;
}
