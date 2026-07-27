/**
 * The camera surface — a viewfinder, not a photo booth.
 *
 * The incumbent's architecture is kept: the parent supplies the overlay and
 * decides when capture becomes available, so one primitive serves both the
 * liveness challenge and document capture. That was the right split.
 *
 * What changes:
 *   - the permission state was a 📷 emoji and a `type="subtitle"` (32/44!) heading
 *     inside the camera frame, which overflowed on a narrow phone;
 *   - permission DENIAL was indistinguishable from "not asked yet" — tapping
 *     "Allow camera" a second time after a hard denial silently did nothing,
 *     because the OS never shows the dialog twice. It now routes to Settings;
 *   - the frame is now an engraved reticle with corner marks, and the shutter is
 *     a real shutter with a haptic, not a full-width form button.
 */
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { useRef, useState, type ReactNode } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Hairline, HitSize, Radius, Space, usePalette } from '@/theme';

import { Button } from './button';
import { haptic } from './haptics';
import { Icon } from './icon';
import { Press } from './pressable';
import { Spinner } from './spinner';
import { Micro, Text } from './text';

interface CameraCaptureProps {
  facing: CameraType;
  /** Drawn over the live preview: framing reticle, gesture prompt. */
  overlay?: ReactNode;
  captureLabel: string;
  /** Capture stays disabled until the parent says the user is ready. */
  canCapture: boolean;
  busy?: boolean;
  onCaptured: (uri: string) => void;
}

export function CameraCapture({
  facing,
  overlay,
  captureLabel,
  canCapture,
  busy = false,
  onCaptured,
}: CameraCaptureProps) {
  const p = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [shooting, setShooting] = useState(false);

  async function capture() {
    if (shooting || busy) return;
    setShooting(true);
    haptic.commit();
    try {
      const photo = await camera.current?.takePictureAsync({
        quality: 0.6,
        skipProcessing: true,
      });
      if (photo?.uri) onCaptured(photo.uri);
    } finally {
      setShooting(false);
    }
  }

  if (!permission) {
    return (
      <View style={[styles.frame, styles.center, { backgroundColor: p.lens }]}>
        <Spinner size={22} color={p.onFieldDim} label="Checking camera access" />
      </View>
    );
  }

  if (!permission.granted) {
    // `canAskAgain === false` means the OS will never show the dialog again, so
    // the in-app button is a dead end and the only real recovery is Settings.
    const blocked = !permission.canAskAgain;
    return (
      <View style={[styles.permission, { borderColor: p.rule, backgroundColor: p.panel }]}>
        <Icon name="camera" size={26} color={p.latent} />
        <Text role="heading" center>
          {blocked ? 'Camera access is turned off' : 'We need your camera'}
        </Text>
        <Text role="bodySm" tone="dim" center style={styles.permissionBody}>
          {blocked
            ? 'Camera permission was declined for Pravaah. You can turn it back on in Settings — this step cannot be completed without it.'
            : 'To confirm you are a real, present person and to read your ID document. Nothing is recorded until you tap the shutter.'}
        </Text>
        <Button
          label={blocked ? 'Open Settings' : 'Allow camera'}
          onPress={() => {
            if (blocked) void Linking.openSettings();
            else void requestPermission();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={[styles.frame, { backgroundColor: p.lens }]}>
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing={facing} />
        {overlay ? <View style={StyleSheet.absoluteFill}>{overlay}</View> : null}
      </View>

      <View style={styles.shutterRow}>
        <Press
          onPress={() => void capture()}
          disabled={!canCapture || busy || shooting}
          depth="full"
          radius={Radius.pill}
          ink={false}
          accessibilityRole="button"
          accessibilityLabel={captureLabel}
          accessibilityState={{ disabled: !canCapture || busy }}
          style={styles.shutterOuter}
        >
          <View
            style={[
              styles.shutter,
              { borderColor: canCapture ? p.latent : p.rule },
              !canCapture && styles.dim,
            ]}
          >
            {busy || shooting ? (
              <Spinner size={26} color={p.latent} />
            ) : (
              <View style={[styles.shutterCore, { backgroundColor: canCapture ? p.field : p.rule }]} />
            )}
          </View>
        </Press>

        <Micro center tone={canCapture ? 'dim' : 'faint'} style={styles.shutterLabel}>
          {captureLabel}
        </Micro>
      </View>
    </View>
  );
}

/**
 * The reticle drawn over the preview: four engraved corner marks. Used by both
 * capture screens so the framing language is the same for a face and a document.
 */
export function Reticle({
  ratio,
  round = false,
  color = 'rgba(238,239,231,0.92)',
}: {
  ratio: number;
  /** An oval for a face; a rectangle for a document. */
  round?: boolean;
  color?: string;
}) {
  const arm = 22;
  return (
    <View style={styles.reticleWrap} pointerEvents="none">
      <View style={[styles.reticle, { aspectRatio: ratio }]}>
        {round ? (
          <View style={[styles.oval, { borderColor: color }]} />
        ) : (
          <>
            <View style={[styles.corner, styles.tl, { borderColor: color, width: arm, height: arm }]} />
            <View style={[styles.corner, styles.tr, { borderColor: color, width: arm, height: arm }]} />
            <View style={[styles.corner, styles.bl, { borderColor: color, width: arm, height: arm }]} />
            <View style={[styles.corner, styles.br, { borderColor: color, width: arm, height: arm }]} />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Space.lg },
  frame: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  center: { alignItems: 'center', justifyContent: 'center' },

  permission: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.xl,
    gap: Space.md,
    alignItems: 'center',
  },
  permissionBody: { maxWidth: 380 },

  shutterRow: { alignItems: 'center', gap: Space.sm },
  shutterOuter: { alignSelf: 'center' },
  shutter: {
    width: HitSize + 20,
    height: HitSize + 20,
    borderRadius: Radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterCore: { width: 44, height: 44, borderRadius: Radius.pill },
  dim: { opacity: 0.5 },
  shutterLabel: { maxWidth: 260 },

  reticleWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xxl },
  reticle: { width: '84%', position: 'relative' },
  oval: { ...StyleSheet.absoluteFillObject, borderRadius: 999, borderWidth: 2 },
  corner: { position: 'absolute', borderColor: '#fff' },
  tl: { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2 },
  tr: { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2 },
  br: { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2 },
});
