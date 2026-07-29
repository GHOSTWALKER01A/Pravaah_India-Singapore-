import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The balance is concealed by default and resolved by press-and-hold.
 *
 * This is a confidentiality control, not a flourish. A wallet balance is the one figure on the Pay
 * tab that a stranger standing behind someone on a train can read at a glance and act on, and the
 * scene PRODUCT.md describes — a mid-range Android, one hand, in public — is exactly that scene.
 *
 * The mechanism is the visual world's own: DESIGN.md commits the **latent image, revealed by
 * press-and-hold**, as the app's single authored motion moment. So concealment here costs nothing in
 * coherence — the note already conceals a value until the holder tilts it.
 *
 * Three decisions worth stating:
 *
 * 1. **Auto-conceals after `holdMs`.** A reveal that persisted would defeat the point the moment the
 *    user put the phone down. The window is generous enough to read a figure and short enough that
 *    walking away re-hides it.
 * 2. **Release re-conceals immediately.** Lifting the thumb is the user's own signal that they are
 *    done looking; waiting out the timer after that would be strictly worse.
 * 3. **Reduce Motion does NOT disable the concealment.** DESIGN.md says a latent panel governed by
 *    Reduce Motion is "simply resolved from mount — the reveal is never a gate on content the holder
 *    cannot open", and that rule is right for the SCORE, which is content. A balance is a secret.
 *    Reduce Motion suppresses the *animation* of the reveal, never the reveal's existence, because
 *    honouring it the other way would silently strip a security control from the users most likely
 *    to need assistive settings.
 */
export function useBalanceReveal(holdMs = 6_000) {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reveal = () => {
    clear();
    setRevealed(true);
    timer.current = setTimeout(() => {
      setRevealed(false);
      timer.current = null;
    }, holdMs);
  };

  const conceal = () => {
    clear();
    setRevealed(false);
  };

  // Clearing on unmount matters more than usual here: without it, leaving the tab mid-reveal leaves
  // a timer that calls setState on a gone component, and the balance would be revealed again the
  // next time this hook mounted with the same state.
  useEffect(() => clear, [clear]);

  return { revealed, reveal, conceal };
}
