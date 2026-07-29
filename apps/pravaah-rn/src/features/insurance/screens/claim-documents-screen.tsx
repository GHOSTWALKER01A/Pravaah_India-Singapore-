/**
 * Attaching evidence, and submitting for review.
 *
 * ## Why this is a screen and not a section of the claim
 *
 * Uploading is a task with its own progress and its own failure modes — a photograph that
 * would not send, a document the reader could not make out — and it happens on a phone with
 * a patchy connection. Burying it inside a status screen would leave the claimant unsure
 * whether their bill had actually arrived, which for somebody holding a hospital invoice is
 * the worst thing this flow could do.
 *
 * ## Why the submit button is separate from the last upload
 *
 * `finalise` is what runs the fraud gate and starts the assessment. Firing it automatically
 * after the last document landed would take the decision out of the claimant's hands — they
 * may have one more thing to photograph, and there is no way back once a claim is under
 * review because the evidence set has to be stable at the moment of decision.
 */
import { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import * as ImagePicker from 'expo-image-picker';

import { ApiError } from '@/api';
import { claimsService, type ClaimUpload } from '@/api/insurance/services';
import {
  Button,
  Header,
  Icon,
  Legend,
  Micro,
  Notice,
  Panel,
  PassportSkeleton,
  Rule,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, usePalette } from '@/theme';

import { DocumentRow, DocumentSlot } from '@/features/insurance/components';
import { useClaim, useClaimUploads } from '@/features/insurance/use-claims';

/**
 * Which documents each cover asks for, and which are required.
 *
 * Mirrors `REQUIRED_CLAIM_DOCS` and `EXPECTED_CLAIM_DOCS` on the server. Duplicated as
 * guidance rather than imported, because the SERVER is the control: it decides whether a
 * claim has enough evidence, and a client list that drifted would at worst ask for one
 * document too many. The reverse arrangement — the client deciding — is what would let a
 * claim through with nothing to assess.
 */
const ASKS: Record<string, { docType: string; required: boolean }[]> = {
  INCOME_PROTECTION: [
    { docType: 'PAYSLIP', required: true },
    { docType: 'MEDICAL_BILL', required: false },
    { docType: 'OTHER', required: false },
  ],
  HEALTH_TOPUP: [
    { docType: 'MEDICAL_BILL', required: true },
    { docType: 'DISCHARGE_SUMMARY', required: false },
  ],
  TRAVEL_ACCIDENT: [
    { docType: 'POLICE_FIR', required: true },
    { docType: 'BOARDING_PASS', required: false },
    { docType: 'MEDICAL_BILL', required: false },
  ],
};

export function ClaimDocumentsScreen({ claimId }: { claimId: string }) {
  const router = useRouter();
  const p = usePalette();
  const { claim, loading, error, apply } = useClaim(claimId);
  const { uploading, pendingDocType, error: uploadError, upload, clearError } =
    useClaimUploads(claimId);

  const [finalising, setFinalising] = useState(false);
  const [finaliseError, setFinaliseError] = useState<string | null>(null);

  const asks = useMemo(
    () => (claim ? ASKS[claim.type] ?? [{ docType: 'OTHER', required: false }] : []),
    [claim],
  );

  /** Which required documents are still missing. Drives the submit button's honesty. */
  const missing = useMemo(() => {
    if (!claim) return [];
    const attached = new Set(claim.documents.map((doc) => doc.docType));
    return asks.filter((ask) => ask.required && !attached.has(ask.docType));
  }, [claim, asks]);

  /**
   * Pick an image and upload it.
   *
   * The camera and the library are offered as one action rather than two buttons per slot:
   * `launchImageLibraryAsync` covers the case where the claimant already photographed the
   * bill at the hospital, which is the common one, and the OS sheet on both platforms
   * offers the camera from inside the picker.
   *
   * Permission is requested at the moment of use rather than on mount, which is what iOS
   * expects and what makes the prompt legible — a permission dialog that appears when a
   * screen opens has no context attached to it.
   */
  const onPick = useCallback(
    async (docType: string) => {
      clearError();

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Photo access is needed',
          'To send a document we need permission to read the photo you choose. Nothing else is read.',
        );
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // No editing step: cropping a bill is how the total ends up outside the frame, and
        // the reader needs the whole page.
        allowsEditing: false,
        quality: 0.7,
      });
      if (picked.canceled || picked.assets.length === 0) return;

      const asset = picked.assets[0];
      if (!asset) return;

      const file: ClaimUpload = {
        uri: asset.uri,
        mimeType: asset.mimeType ?? 'image/jpeg',
        fileName: asset.fileName ?? `${docType.toLowerCase()}.jpg`,
      };

      const updated = await upload(docType, file);
      if (updated) apply(updated);
    },
    [upload, apply, clearError],
  );

  const onSubmit = async () => {
    setFinalising(true);
    setFinaliseError(null);
    try {
      const result = await claimsService.finalise(claimId);
      apply(result.claim);
      /**
       * `replace` back to the claim.
       *
       * The documents screen is spent: once a claim is under review the evidence set is
       * frozen, so leaving it in the stack would offer an upload slot that can only fail.
       */
      router.replace(ROUTES.INSURANCE.CLAIM(claimId));

      if (result.autoApproved) {
        Alert.alert('Approved', result.message);
      }
    } catch (err) {
      setFinaliseError(
        err instanceof ApiError
          ? err.message
          : 'Could not submit this claim for review.',
      );
    } finally {
      setFinalising(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <PassportSkeleton />
      </Screen>
    );
  }

  if (error || !claim) {
    return (
      <Screen>
        <View style={styles.sheet}>
          <Header title="Your documents" />
          <Notice tone="error">{error ?? 'This claim could not be found.'}</Notice>
        </View>
      </Screen>
    );
  }

  const frozen = claim.status !== 'SUBMITTED' && claim.status !== 'INFO_REQUESTED';

  return (
    <Screen
      footer={
        frozen ? undefined : (
          <View style={styles.footer}>
            <Button
              label={finalising ? 'Submitting…' : 'Submit for review'}
              onPress={() => void onSubmit()}
              loading={finalising}
              disabled={claim.documents.length === 0 || uploading}
            />
            {missing.length > 0 ? (
              /*
                Named, but not BLOCKING.

                The server decides whether a claim has enough evidence, and it holds a short
                claim at SUBMITTED with a list rather than rejecting it. So the button stays
                live and this line says what is likely to come back — which is more useful
                than a disabled button with no explanation.
              */
              <Micro tone="latent" center>
                A reviewer will probably ask for the {missing.length === 1 ? 'document' : 'documents'} still marked
                &ldquo;needed&rdquo; above.
              </Micro>
            ) : (
              <Micro tone="faint" center>
                Once you submit, the documents are locked and a reviewer takes over.
              </Micro>
            )}
          </View>
        )
      }
    >
      <View style={styles.sheet}>
        <Header
          title="Your documents"
          lede={
            frozen
              ? 'These are the documents attached to this claim.'
              : 'Photograph each document in full. A clear photo is the single biggest thing you can do to get paid quickly.'
          }
        />

        {uploadError ? <Notice tone="error">{uploadError}</Notice> : null}
        {finaliseError ? <Notice tone="error">{finaliseError}</Notice> : null}

        {/* ── attached ─────────────────────────────────────────────────────── */}
        {claim.documents.length > 0 ? (
          <View style={styles.section}>
            <SectionHead title="Sent" />
            <View style={styles.list}>
              {claim.documents.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} />
              ))}
            </View>
          </View>
        ) : null}

        {/* ── still to add ────────────────────────────────────────────────── */}
        {!frozen ? (
          <View style={styles.section}>
            <SectionHead
              title={claim.documents.length > 0 ? 'Add another' : 'What to send'}
            />
            <View style={styles.list}>
              {asks.map((ask) => (
                <DocumentSlot
                  key={ask.docType}
                  docType={ask.docType}
                  required={ask.required}
                  uploading={uploading && pendingDocType === ask.docType}
                  onPress={() => void onPick(ask.docType)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Rule />

        {/*
          What happens to a photograph of a hospital bill.

          A medical document names a diagnosis and a physician. Somebody being asked to
          upload one is entitled to know it is encrypted at rest and that opening it is
          attributable — and saying so here, at the moment of the ask, is worth more than a
          privacy policy nobody opens.
        */}
        <Panel pad="md" tone="sunk" notch={false}>
          <View style={styles.privacyRow}>
            <Icon name="lock" size={15} color={p.field} weight={1.6} />
            <Micro tone="dim" style={styles.privacyText}>
              Your documents are encrypted as soon as they arrive. A reviewer who opens one
              is recorded by name. They are used to assess this claim and nothing else.
            </Micro>
          </View>
        </Panel>

        {!frozen ? (
          <View style={styles.section}>
            <Legend small tone="faint">
              If a photo is hard to read
            </Legend>
            <Micro tone="dim">
              We will say so beside the document rather than refusing your claim. Retake it
              in better light and send it again — nothing is lost.
            </Micro>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
  section: { gap: Space.md },
  list: { gap: Space.sm },
  footer: { gap: Space.sm },
  privacyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  privacyText: { flex: 1 },
});
