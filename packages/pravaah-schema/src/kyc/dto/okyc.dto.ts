import { z } from 'zod'

export const OkycCallbackSchema = z.object({
  providerRefId: z.string().min(1),
  /**
   * The DigiLocker access code the user copies off the provider's completion
   * page. Optional because it only exists when the session ran WITHOUT a
   * redirect URL — with one configured, the provider hands the code back
   * server-to-server and the session id alone is enough.
   *
   * Deliberately loose: this is an opaque provider token, and a length/charset
   * guess that is too tight would reject a valid code the user pasted
   * correctly. Trimmed because copying off a web page picks up whitespace.
   */
  code: z.string().trim().min(8).max(512).optional(),
  status: z.string().optional(),
})
export type OkycCallbackDto = z.infer<typeof OkycCallbackSchema>
