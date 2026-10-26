# MyPRAVAAH — 16-Minute Demo Narration Script
### Voice-over script for the recorded demo · Singapore–India Hackathon 2026 · FinTech / InsurTech track
### Speaker: Divyaraj · BIT Sindri · Team Rover Solution

---

## How to use this

- **Total narration: ~2,000 words**, written for ~130 words/minute — a natural, unhurried presenting pace. That leaves roughly 90 seconds of headroom across 16 minutes for the `[PAUSE]` beats where the UI does the talking.
- **Timings are estimates**, derived from your five recorded statements, not from the video itself. To lock them exactly: export the video's captions (SRT/VTT) or paste a timestamped outline, and every block can be re-timed to the second.
- `[ON SCREEN]` = what should be visible when that line lands. `[PAUSE]` = stop talking and let the action complete.
- **Bold** = land the emphasis. These are the lines a judge will remember.
- Read it aloud twice before recording. Anything that trips your tongue, change — the sentences are deliberately short so you can breathe.

**Pronunciation:** *MyPRAVAAH* → "my pra-VAAH." Say the full name; don't shorten it to "Pravaah" mid-demo, and never to "my app."

---

## Segment 1 · The problem (0:00 – 1:45)

`[ON SCREEN]` Title card, then Ravi's story visual.

> Meet Ravi.
>
> For eleven years, he lived in India. Every rent paid on time. Every bill paid on time. **Eleven years of proof that this man can be trusted.**
>
> Then he takes a job in Singapore. And at the airport, his reputation stays behind. **Because trust does not travel.**
>
> In Singapore, Ravi is not a bad borrower. He is something worse. **He is unreadable.**
>
> No credit file — so no loan. No rental history — so six months of deposit, up front. No claim record — so insurance he can barely afford. Eleven years of good behaviour, reset to zero.
>
> And Ravi is not rare. India has the largest diaspora in the world — **around eighteen million people living outside the country.** Every one of them crosses the same border, and hits the same wall.
>
> I'm Divyaraj, from BIT Sindri, representing Team Rover Solution. We built MyPRAVAAH to fix exactly this. **Your financial reputation, wherever you go.** Built for the FinTech and InsurTech track.
>
> What you're about to see is the complete product. Eight modules, end to end.

---

## Segment 2 · What it is, and how it's built (1:45 – 3:15)

`[ON SCREEN]` Architecture diagram, then the security section.

> One line, before we open the app. **MyPRAVAAH makes sure that when a person moves, their trust and their financial identity move with them — instead of being left behind at the border.**
>
> The project is divided into eight modules. Identity. Consent and data aggregation. The reputation engine. The passport itself. Cross-border payments. Micro-insurance. Fraud and risk. And the partner console.
>
> Each one is independent, and each one earns its place.
>
> `[ON SCREEN]` architecture diagram
>
> On screen is the architecture. A React Native app. A NestJS backend that is **the only thing allowed to touch money or data rails** — the app never holds a payment credential or a decryption key. Supabase for auth and storage. And a separate Python service for the machine-learning model, kept separate so a model crash can never take down payments.
>
> `[ON SCREEN]` security section
>
> And the security is layered twice over. First, the layers the regulators define: **the UPI PIN never touches our servers**, two-factor authentication on payments, device and SIM binding, and consent artefacts that are cryptographically signed and verified.
>
> Then, on top of that, MyPRAVAAH's own layer: field-level encryption, an append-only audit trail, and a risk engine that scores every sensitive action *before* it happens.
>
> Now let's move into the demo.

---

## Segment 3 · Login, biometrics, PIN (3:15 – 5:15)

`[ON SCREEN]` Login screen → OTP → biometric prompt → PIN setup.

> We start where every user starts. A phone number, and an OTP.
>
> `[PAUSE — OTP arrives]`
>
> The OTP is delivered through Supabase send hooks into MSG91 for SMS, with email handled separately. And the number is verified server-side — never on the device.
>
> On the very first login, the app asks for biometrics. **This is a key detail, so I'll be precise about it.** The biometric is not the password. It's a gate on the session. The app is bound to this device, and to this SIM.
>
> If the SIM changes, that binding is treated as a suspected swap, and high-value actions are frozen until the user re-verifies. **That single control is what stops a SIM-swap attacker who has the OTP but not the phone.**
>
> Since this is a first-time login, it asks for the same now.
>
> `[PAUSE — biometric]`
>
> Next, an OTP for the net-banking transaction.
>
> `[PAUSE]`
>
> And then the app asks the user to set a PIN. **The PIN is the payment factor.** Every transaction from here on is confirmed with it — and it is verified on the server, never trusted from the client.
>
> That's onboarding. Identity established, device bound, payment factor set.

---

## Segment 4 · Passport dashboard & KYC (5:15 – 8:15)

`[ON SCREEN]` Passport dashboard → India 6-layer flow → Singapore 4-layer → consent screen.

> This is the passport dashboard. This is where the user proves who they are, using their **origin-country** credentials.
>
> For India, there are **six layers.** PAN. Aadhaar OKYC through DigiLocker. A bank penny-drop, which matches the name registered at the bank. Liveness. Face match. And a sanctions and PEP screening — PEP meaning politically exposed person.
>
> For Singapore, **four layers.** Singpass Myinfo. Liveness. Face match. And the same sanctions and PEP screening.
>
> `[PAUSE — run a check]`
>
> The Indian credentials are validated live against the **Decentro** sandbox. The Singapore leg runs on **Singpass test personas**, behind the same interface the real API uses — so going live is a credential swap, not a rewrite.
>
> Notice what the name-matching does here. PAN, Aadhaar and the bank account rarely agree perfectly — initials, honorifics, transliteration. So **a low name-match score never rejects a user. It routes them to a human.** That is the single most common real-world KYC failure, handled properly.
>
> `[ON SCREEN]` consent screen
>
> Then account aggregation. This is the heart of the product.
>
> The user consents — and the consent screen shows exactly what is shared, for what purpose, and for how long. For India, that's the **Account Aggregator** rail, through **Setu**, with **Finvu** as the alternative. For Singapore, **SGFinDex**.
>
> Consent is revocable at any moment, and revoking it purges the data.
>
> And here is the design decision I'd underline: **the raw financial data never leaves India. Only the derived score crosses the border.** That's the answer to the data-residency question — designed in, not bolted on.

---

## Segment 5 · Admin console, approval, score, passport QR (8:15 – 11:15)

`[ON SCREEN]` Admin dashboard → KYC queue → Review → approve → verified tag → score → passport QR.

> Our KYC and aggregation are done, and the request has gone to the admin.
>
> This is the admin dashboard, and it's a **single unified console** — KYC, Aadhaar OKYC, transactions, insurance, the partner network. Everything that happens in this app lands here.
>
> The user's request arrives in the KYC queue. The admin opens Review.
>
> `[PAUSE — open review]`
>
> From here, the admin sees everything the user submitted. Every document. Every check, with its confidence score.
>
> They claim the case — and **only one reviewer can hold a case at a time**, so two admins can never decide the same file. They leave a comment, which is mandatory. Then they approve or reject.
>
> I'll approve.
>
> `[PAUSE — approval lands]`
>
> And the profile is now verified. You can see the verified tag appear here.
>
> `[ON SCREEN]` score section
>
> Now the score. When I click into the score section, the machine-learning service runs — and **I want to be exact about what it scores.**
>
> It does not score the documents. It scores **consented financial behaviour**, pulled over the Account Aggregator rail: how regular the income is, how well savings are retained, the ratio of obligations to inflow, how long the history runs.
>
> XGBoost produces the score. **SHAP produces the reasons** — so every score ships with a plain-language explanation of what helped, what hurt, and what would raise it.
>
> And that matters legally, not just cosmetically. **A score you cannot explain is a liability.**
>
> `[ON SCREEN]` passport dashboard with QR
>
> That finalises the passport status. Back on the passport dashboard, the user now has their QR code. This is peer-to-peer verification — a lender, a landlord, or another customer scans it to check and verify the credit.
>
> **And here is the part I'd point a judge at.** What crosses in that scan is not the number.
>
> The verifier asks a question: *is this identity verified, and is the reputation band good or better?* The user approves. And the answer that comes back is **yes.**
>
> Not the score. Not a single transaction. A signed, cryptographic yes. **The reputation crosses the border even though the data never does.**

---

## Segment 6 · The card (11:15 – 12:15)

`[ON SCREEN]` Virtual card, front and back.

> This is the physical card, shown here as a virtual one. It's delivered once the user is fully verified — a hard copy for fast verification. Tap it, scan the QR, or use the ID.
>
> The form factor is deliberate. It's ATM-card size, which is also the **ICAO TD1 travel-document standard** — the correct international shape for an identity document. NFC inside, QR on the back.
>
> And one detail that matters. **The card does not carry the credential. It carries a reference.** Scanning it opens a verification session that still needs the holder's phone to approve and sign.
>
> So a photographed QR, or a stolen card, is inert. And if it's lost, one tap revokes it.

---

## Segment 7 · Transactions & the two-in-one QR (12:15 – 14:30)

`[ON SCREEN]` Transaction screen → limits → UPI / PayNow options → name confirm → QR scanner.

> Now the transaction side.
>
> At the top, the daily maximum, and what's been sent today. Those caps are enforced **on the server**, not in the UI, because they're regulatory limits — the cross-border corridor is capped at one thousand Singapore dollars a day, which is far tighter than the domestic limit.
>
> We support both sides of the corridor. Indian **UPI**, and Singapore **PayNow**.
>
> One honest note here, because naming it raises credibility rather than lowering it. **The domestic leg runs live on sandbox rails. The cross-border leg runs on a faithful simulator** — the UPI-to-PayNow link is a bank rail, not a weekend API. Every provider in this app sits behind an interface, so production is a credential swap and a regulated partner, not a rewrite.
>
> `[PAUSE — start a transfer]`
>
> Before this transfer goes anywhere, three things happen.
>
> The beneficiary's **bank-registered name** is shown, and must be confirmed — that's an NPCI mandate, and the best defence there is against social-engineering fraud.
>
> The FX rate is locked, with a countdown, and it expires.
>
> And the risk engine scores the transaction. A new device. An unusual amount. A payee added minutes ago. An impossible location. Any of those, and the transfer is either challenged with a second factor, or held for a human. **Money is never blocked by a model alone without a review path.**
>
> Underneath all of it, every movement posts to a **double-entry ledger** — append-only, in integer paise and cents, never floating point. Every transfer carries an idempotency key, so a retry can never debit twice. And a reconciliation job trusts the rail over our own record, so a payment we gave up on but which actually settled **self-corrects, instead of being lost.**
>
> `[ON SCREEN]` QR scanner
>
> And this is a two-in-one QR scanner. It reads both — **the passport QR and the transaction QR.** One scanner, both jobs, and it's robust.
>
> `[PAUSE — scan]`

---

## Segment 8 · Insurance (14:30 – 15:35)

`[ON SCREEN]` Insurance marketplace → quote → claim flow.

> Now the insurance side — the second half of our track.
>
> We've built the core flow end to end, and the valuation comes **straight off your score**. Three products: income protection, a health top-up, and travel and accident cover.
>
> Here's the point. **The same reputation that got Ravi a loan now gets him a premium.** A strong band pays less. A weak band pays more, with a longer waiting period. And a very weak band is declined — politely, with the reason, and with what would make them eligible.
>
> That is usage-based pricing for a population insurers currently price blindly, or refuse outright.
>
> The claim runs end to end too. File it, upload documents, OCR extracts the amount — and **a forged document is gated to human review instead of being auto-paid.** No physical verification needed.
>
> `[PAUSE]`

---

## Segment 9 · Close (15:35 – 16:00)

`[ON SCREEN]` Monorepo structure, then title card.

> And that's the whole project — one monorepo. The mobile app, the admin console, the NestJS backend, and the machine-learning service.
>
> Eight modules. One idea. **When a person moves, their trust moves with them.**
>
> I'm Divyaraj, Team Rover Solution, for the FinTech and InsurTech track. Thank you.

---

## Facts locked in this script — and what changed from your recording

Six things in the recorded audio would not survive a judge's follow-up question. All six are corrected above.

| You said | Script says | Why |
|---|---|---|
| "PEB test" | **PEP** — politically exposed person | PEP/sanctions screening is the actual check (`CheckType.SANCTIONS_PEP`) |
| "Twilio" for OTP | **Supabase send hooks → MSG91** | Twilio is listed as an option in the build bible, but is not what shipped |
| "Finbit" | **Finvu** for India; **SGFinDex** for Singapore | Finvu is the AA alternative to Setu. Singapore has no Indian AA — it has SGFinDex |
| "more than 80 million living outside" | **~18 million** (India's diaspora, the world's largest) | 80M isn't supported. Alternative if you prefer the global framing: *"~280 million people live outside their country of birth."* Pick one and keep it consistent |
| "the ML script makes the document reality into a score" | **the model scores consented financial behaviour, not documents** | This is the most important correction. Documents drive KYC; the score comes from AA cash-flow features via XGBoost + SHAP. A fintech judge catches this instantly |
| India's six layers, five named | **all six named**, including the bank penny-drop | You skipped penny-drop while claiming six |

**Two modules your recording never mentions**, though you claim eight: fraud/risk and the partner console. Both are now narrated — fraud is woven into Segments 2, 3 and 7 (SIM binding, risk scoring, held transfers), and the partner console is the predicate verification at the end of Segment 5. Those are your two strongest judge-facing modules: fraud is the credibility answer, and the partner console is the revenue answer.

---

## If you run long — cut in this order

1. Segment 7, the ledger paragraph ("Underneath all of it…") — **–30s**, and the least missed.
2. Segment 6, the ICAO TD1 sentence — **–12s**.
3. Segment 4, the name-matching paragraph — **–20s**. Only if you must; it's a genuine differentiator.
4. Segment 2, the second half of the security paragraph — **–20s**.

**Never cut:** the Ravi hook, the "raw data never leaves India" line, the correction about what the model actually scores, the signed-yes moment at the end of Segment 5, and the honesty note about the simulator. Those five are the script.

---

## Delivery notes

- **Slow down for the three numbers**: eighteen million, six layers, four layers. Numbers spoken fast don't land.
- **Full stop before every bolded line.** The pause is what makes it read as a claim rather than a clause.
- Segment 1 is the only place to use emotion. From Segment 2 onward, be flat and technical — the contrast is what makes the opening work.
- Say "MyPRAVAAH" in full at 0:50, 3:00, and 15:45. Three times is enough to make it stick; more sounds like an advert.
- Record each segment as a separate take. Nine short takes are easier to fix than one sixteen-minute run.
