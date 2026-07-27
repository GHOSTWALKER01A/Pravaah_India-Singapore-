/**
 * Loads the three faces of the note.
 *
 * Only the weights the design actually uses are loaded. Each `@expo-google-fonts`
 * family ships 18 files; importing the whole family would put roughly 2MB of
 * unused TTF into the bundle for an audience explicitly on metered mobile data.
 */
/*
 * Imported by WEIGHT SUBPATH, not from the package root, and that is load-bearing.
 *
 * Each `@expo-google-fonts` family ships 18 `.ttf` files and its root `index.js`
 * `require`s every one of them. Importing from the root therefore pulls all 54
 * files into the bundle — verified: `expo export` listed every weight of all three
 * families, about 2MB of TTF the design never uses, for an audience explicitly on
 * metered mobile data. Each weight is its own module, so importing those directly
 * bundles exactly the eight faces below.
 */
import { BodoniModa_500Medium } from '@expo-google-fonts/bodoni-moda/500Medium';
import { BodoniModa_600SemiBold } from '@expo-google-fonts/bodoni-moda/600SemiBold';
import { Archivo_400Regular } from '@expo-google-fonts/archivo/400Regular';
import { Archivo_500Medium } from '@expo-google-fonts/archivo/500Medium';
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Archivo_700Bold } from '@expo-google-fonts/archivo/700Bold';
import { AzeretMono_500Medium } from '@expo-google-fonts/azeret-mono/500Medium';
import { AzeretMono_600SemiBold } from '@expo-google-fonts/azeret-mono/600SemiBold';
import { useFonts } from 'expo-font';

/** Keyed by the exact names `Family` in type.ts refers to, so they cannot drift. */
export const FONT_MAP = {
  BodoniModa_500Medium,
  BodoniModa_600SemiBold,
  Archivo_400Regular,
  Archivo_500Medium,
  Archivo_600SemiBold,
  Archivo_700Bold,
  AzeretMono_500Medium,
  AzeretMono_600SemiBold,
} as const;

/**
 * Returns true once the faces are ready. The caller holds the splash screen until
 * then rather than rendering a frame in the system font and reflowing: a didone
 * and the system sans set at wildly different widths, so the swap is a visible
 * jump on exactly the screen that has to look most trustworthy.
 *
 * On failure it still returns true. A font that will not load is not a reason to
 * strand someone on a splash screen mid-verification — they get the system face
 * and a working app.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(FONT_MAP);
  return loaded || error != null;
}
