import { Country, KycStatus } from '@/api/kyc/kyc.schema';

export interface CurrentUser {
  id: string;
  /** The user's permanent public identity, `PVH-XXXX-XXXX-XXXX`. */
  pravaahId: string;
  phone?: string | null;
  email?: string | null;
  primaryCountry: Country;
  kycStatus: KycStatus;
}
