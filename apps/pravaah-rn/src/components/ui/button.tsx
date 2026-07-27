/**
 * Buttons.
 *
 * The incumbent had two variants — a filled indigo rectangle and a transparent one
 * with a border that did not change in dark mode — both 52dp tall with a 16pt
 * radius, both fading to 0.6 opacity when pressed OR disabled.
 *
 * Four variants here, because the app genuinely has four kinds of action, and one
 * of them (destructive) was previously rendered identically to "Back to dashboard":
 *
 *   primary      the drenched intaglio field. One per screen.
 *   secondary    an engraved plate with a keyline. The alternative, not the retreat.
 *   destructive  carmine — the second colour, the word under pressure. Revoke,
 *                delete, decline. Nothing else may use it.
 *   quiet        a text action for a genuinely tertiary path.
 *
 * A button on the intaglio field inverts: `onField` reverses primary out in rag,
 * because a green button on a green ground is not a button.
 */
import { StyleSheet, View } from 'react-native';

import {
  Hairline,
  HitSize,
  Radius,
  Space,
  usePalette,
} from '@/theme';

import { Icon, type IconName } from './icon';
import { Press } from './pressable';
import { Spinner } from './spinner';
import { Text } from './text';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'quiet';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  /** Leading icon. Use sparingly — a label that needs a picture is usually unclear. */
  icon?: IconName;
  /** Trailing icon. `external` for anything that leaves the app. */
  iconEnd?: IconName;
  /** Sit this button on the intaglio field and its tones invert. */
  onField?: boolean;
  /** Shrink to its content instead of filling the row. */
  inline?: boolean;
  /**
   * Extra context for a screen reader where the visible label is short but the
   * consequence is not — "Revoke" needs to announce that data will be deleted.
   */
  hint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
  iconEnd,
  onField = false,
  inline = false,
  hint,
}: ButtonProps) {
  const p = usePalette();
  const dead = disabled || loading;

  const skin = (() => {
    /**
     * A disabled button is NOT a dimmed filled button.
     *
     * Caught on device, in both themes at once: `opacity: 0.45` over the intaglio
     * field made the disabled primary the single most prominent block on the
     * sign-in screen in light mode — a big mid-green slab with an illegible label
     * — while in dark mode it nearly vanished into the ground. The same value
     * cannot serve both, because opacity moves a colour toward its BACKGROUND, and
     * the two themes have backgrounds on opposite sides of the field.
     *
     * So a disabled control drops the fill entirely and becomes a keylined ghost.
     * That reads identically in both themes, keeps the label legible, and stops a
     * not-yet-available action from shouting.
     */
    if (dead && (variant === 'primary' || variant === 'destructive')) {
      return {
        bg: 'transparent',
        ink: onField ? p.onFieldDim : p.inkDim,
        border: onField ? p.ruleOnField : p.rule,
      };
    }

    switch (variant) {
      case 'primary':
        return onField
          ? { bg: p.onField, ink: p.field, border: 'transparent' }
          : { bg: p.field, ink: p.onField, border: 'transparent' };
      case 'destructive':
        // Outlined rather than filled: a destructive action should be legible and
        // reachable, not the loudest thing on the screen inviting a mis-tap.
        return onField
          ? { bg: 'transparent', ink: p.onFieldCarmine, border: p.onFieldCarmine }
          : { bg: p.carmineWash, ink: p.carmine, border: p.carmine };
      case 'secondary':
        return onField
          ? { bg: 'transparent', ink: p.onField, border: p.ruleOnFieldStrong }
          : { bg: p.panel, ink: p.ink, border: p.ruleStrong };
      default:
        return {
          bg: 'transparent',
          ink: onField ? p.onFieldLatent : p.latent,
          border: 'transparent',
        };
    }
  })();

  return (
    <Press
      onPress={onPress}
      disabled={dead}
      radius={Radius.md}
      depth={variant === 'quiet' ? 'subtle' : 'full'}
      /**
       * No haptic. A button press is an ordinary tap, and DESIGN.md reserves the
       * haptic channel for events that MATTER — a step completing, a check
       * clearing, a revoke confirming. Firing `select` on every primary,
       * secondary and destructive button spent that channel on nothing, which
       * trains the user to ignore the buzz that was supposed to tell them their
       * verification passed. Screens that mean something by a press call
       * `haptic.commit()` / `haptic.refused()` at the point of the outcome.
       */
      feedback="none"
      ink={variant !== 'primary'}
      style={[inline ? styles.inline : styles.block, dead && styles.dead]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: dead, busy: loading }}
    >
      <View
        style={[
          styles.body,
          variant === 'quiet' ? styles.quietBody : null,
          {
            backgroundColor: skin.bg,
            borderColor: skin.border,
            borderWidth: skin.border === 'transparent' ? 0 : Hairline.base,
          },
        ]}
      >
        {loading ? (
          <Spinner size={18} color={skin.ink} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={18} color={skin.ink} /> : null}
            {/* No `numberOfLines`. `minHeight` on the body exists so the label can
                GROW the button at a large OS text size; capping it to one line
                defeated that and clipped the label instead — which is the failure
                the minHeight was added to prevent. */}
            <Text role="label" tone="inherit" style={{ color: skin.ink }}>
              {label}
            </Text>
            {iconEnd ? <Icon name={iconEnd} size={16} color={skin.ink} /> : null}
          </>
        )}
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  block: { alignSelf: 'stretch' },
  inline: { alignSelf: 'flex-start' },
  body: {
    // minHeight, not height: at large OS font sizes the label must be able to
    // grow the button rather than being clipped by it.
    minHeight: HitSize,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.xl,
    paddingVertical: Space.md,
  },
  quietBody: { paddingHorizontal: Space.sm, minHeight: HitSize },
  /**
   * A light touch only. The disabled LOOK is carried by the ghost skin above
   * (no fill, keyline, dimmed ink); this just takes the last of the emphasis off.
   * The incumbent used 0.6 for both pressed AND disabled, so the two states were
   * indistinguishable — press is now a scale and a darkening, which frees opacity
   * to mean exactly one thing.
   */
  dead: { opacity: 0.85 },
});
