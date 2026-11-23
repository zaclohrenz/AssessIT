# How AssessIT scores a vendor

The whole model is one line:

```
Risk Score = Likelihood × Impact × Preference multiplier × (1 − Mitigation credit)
```

| Part | What it is | How it's built |
|---|---|---|
| **Likelihood** | How likely an incident is | Add up the points from the Likelihood answers |
| **Impact** | How bad an incident would be for you | Add up the points from the Impact answers |
| **Preference multiplier** | Values your organization cares about | Start at 1.0; add 0.5 for each organization-preference concern (the answer scored +0.5×) |
| **Mitigation credit** | Controls you already have in place | Add up the mitigation percentages, then cap the total (25% by default) |

Then:

1. **Band:** find the highest band whose minimum the score reaches (table below).
2. **Decision:** the band's decision, with these overrides, checked in order:
   - Any **required** question unanswered → **Incomplete**. A blank form can never look low-risk.
   - Any **hard-stop** answer → **Denied**, regardless of score. None are set by default; an organization can add them.
   - Band says Approved **and** a mitigation was credited → **Approved with Conditions**. The mitigations become the conditions.
3. **Re-review date:** the assessment date plus the band's re-review period.

The code is a direct copy of this: [`riskScore()` in `src/engine.ts`](src/engine.ts).

## When you can't find it: two kinds of question

Not finding something means different things depending on what the question asks. AssessIT handles the two kinds differently, on purpose, so that **a gap is never scored as a clean bill of health, and never as an accusation.**

### "Does the vendor have X?": it has to be shown

A certification, single sign-on with MFA, a written deletion promise, a breach-notification deadline, a way to report flaws. For these, **credit is only given for what can be shown.** If you can't find it, or the contract isn't public, the answer is **No**, and an AI answer is flagged for you to confirm with the vendor.

Why: a control you can't verify is a control you can't rely on. A vendor that can't produce a SOC 2 report shouldn't score like one that can, and a deletion promise that exists only in a contract you haven't seen protects nobody. There is deliberately **no Unknown** here. It would let "I didn't look" and "they don't have it" hide behind each other.

### "Did something bad happen?": a missed search proves nothing

A breach, a lawsuit or regulator action, an ownership change, data stored abroad. Here the burden is on whoever is checking, because **finding nothing doesn't prove nothing happened**. Search engines miss things, court dockets aren't all indexed, and breach notices are scattered across regulators. So there are three honest answers:

| Answer | What it means |
|---|---|
| **Yes** | You can point to it: a source that describes it. |
| **No** | You checked **at least two kinds of source** (for example a regulator or court record *and* news) and found nothing. The notes say what you checked. |
| **Unknown** | You tried and couldn't establish it either way: thin or conflicting sources, or sources you couldn't reach. It scores **about half** of what a Yes does. |

Why half. Zero would score a gap as a clean record, which rewards vendors that are hard to research. The full penalty would accuse a vendor of something nobody has shown, and would treat an obscure vendor the same as one with a documented breach. Half says "we don't know, and not knowing carries some risk."

Unknown is for *"I tried and couldn't tell"*, not for *"I only ran one search"*. Do the second check first.

**Questions with an Unknown answer:** L2, L3, L4, L8, L10, L13, P4, P5, P7, P8. Two older questions follow the same idea with their own wording: L7 scores "Not rated" at 2 of 3, and L9 scores "Unknown" the same as Yes, because you can't assess a chain of sub-processors you can't see.

The AI research follows the same rules. It gives credit only for what it can cite, answers No to a bad-event question only after checking two kinds of source, and otherwise says Unknown, with its notes and sources shown for you to check. When you aren't sure yourself, the line under each question says which answer to pick.

## Reading the result

The report shows the score as a **percentage of the approval limit**: the score where the policy starts denying (58 in the defaults). **Lower is better, and 100% is the line.**

| Color | Meaning |
|---|---|
| **Green** | Under the limit. |
| **Yellow** | Over the limit, but the mitigations the policy still offers could bring it under. |
| **Red** | Over the limit even with every mitigation, or a hard-stop answer was given. |

**The app shows percentages, not points.** The header, the report and the questionnaire never quote a raw score, a band or a point value on the page: the score is "74% of the approval limit", and each driver says how many percentage points it would take off. The full breakdown (the score, likelihood, impact, preference multiplier, mitigation credit and band) appears when you hover over the percentage. The PDF, Excel export and what's sent for approval keep the exact numbers, so approvers and auditors can see them.

The theoretical maximum (every answer at its worst) isn't shown, because no real vendor is near it and it makes every real score look tiny.

Each answer also carries a small marker for which way it pushes the score: a green circle lowers risk, a yellow diamond adds some, a red triangle adds the most. It follows the points, so it's right whichever way a question is worded. A mitigation you don't have shows no marker, because "no credit" isn't a bad answer.

## Worked example

From the original spreadsheet: an enterprise AI assistant with confidential (non-PII) data and admin-level integrations.

| Answer | Section | Points |
|---|---|---|
| Breach in last 3 years: Yes | Likelihood | 2 |
| Negative privacy record: Yes | Likelihood | 2 |
| Third-party security rating: Not rated | Likelihood | 2 |
| Sends data to other AI providers: Yes | Likelihood | 1 |
| A person approves every action: No (it acts on its own) | Likelihood | 2 |
| **Likelihood** | | **9** |
| Data classification: Confidential | Impact | 2 |
| Deployment scope: Multiple teams | Impact | 1 |
| Access to our systems: Admin or write access | Impact | 2 |
| **Impact** | | **5** |
| No organization-preference concerns | Preference | **× 1.0** |
| SSO + automated provisioning: Yes | Mitigation | **−5%** |

```
9 × 5 × 1.0 × (1 − 0.05) = 42.75   →   Low band (29+)   →   Approved
                                        + a mitigation was credited → Approved with Conditions
```

## Where the defaults come from

AssessIT's defaults follow published guidance. **NIST tells you *what* to assess, not how many points each thing is worth.** So the rules are:

- **Structure:** risk as likelihood × impact follows [NIST SP 800-30 Rev. 1](https://csrc.nist.gov/pubs/sp/800/30/r1/final). Supplier due diligence follows [NIST CSF 2.0](https://doi.org/10.6028/NIST.CSWP.29) GV.SC-06/07 and ID.RA-10. AI-specific risks follow the [NIST AI RMF](https://doi.org/10.6028/NIST.AI.100-1) and the [Generative AI Profile (NIST AI 600-1)](https://doi.org/10.6028/NIST.AI.600-1). Buyer questions follow [CISA's Secure by Demand guide](https://www.cisa.gov/news-events/news/cisa-releases-secure-demand-guide).
- **Every question cites its basis** (table below). A question with no published basis is labeled **Org preference**.
- **Point values, band thresholds and the 25% cap** are this project's own calibration: sensible defaults, not something a standard dictates. Where to draw the approve/deny line is your risk appetite, which NIST says each organization sets for itself ([CSF 2.0 GV.RM-02](https://doi.org/10.6028/NIST.CSWP.29)).
- **Organization preferences** are things many organizations care about that NIST and CISA don't (yet) say how to weigh. Examples: whether a vendor's AI produces harmful content, stores data outside your country, has sanctioned-country ties, reproduces copyrighted work, serves government surveillance, or makes it hard to leave. They scale the whole score instead of adding points, because they're about values rather than the odds of a breach. The ones that are purely a value choice (small vendor, data location, government use, lock-in) can be **ignored** for an assessment: an ignored question isn't scored or required, and the report says it was ignored. Each explains under "Why it matters" when ignoring it is reasonable.

These defaults only change when the guidance changes. See [CONTRIBUTING.md](CONTRIBUTING.md). If your organization weighs things differently, change the policy in your own org config; that's what it's for.

## The defaults

<!-- tables:start (generated by `npm run docs:scoring`; don't edit by hand) -->

#### Likelihood (points)

| ID | Factor | Answers | Required | Basis |
|---|---|---|---|---|
| L1 | Independent security audit | Yes = 0; No = 1 | Yes | [NIST CSF 2.0 ID.RA-10](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 GV.SC-06](https://doi.org/10.6028/NIST.CSWP.29), [CISA Software Acquisition Guide (2024)](https://www.cisa.gov/sites/default/files/2024-07/PDM24050%20Software%20Acquisition%20Guide%20for%20Government%20Enterprise%20ConsumersV2_508c.pdf) |
| L2 | Breach in the last 3 years | Yes = 2; No = 0; Unknown = 1 | Yes | [NIST CSF 2.0 GV.SC-06](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 GV.SC-07](https://doi.org/10.6028/NIST.CSWP.29) |
| L3 | Privacy trouble | Yes = 2; No = 0; Unknown = 1 | Yes | [NIST CSF 2.0 GV.SC-06](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 GV.SC-07](https://doi.org/10.6028/NIST.CSWP.29) |
| L4 | Small or young vendor | Yes = 1; No = 0; Unknown = 0.5 | Yes | **Org preference**; related: [NIST CSF 2.0 GV.SC-06](https://doi.org/10.6028/NIST.CSWP.29) |
| L5 | AI model disclosure | Yes = 0; No = 2 | Yes | [NIST AI RMF 1.0 MAP 4.1](https://doi.org/10.6028/NIST.AI.100-1), [NIST AI 600-1 2.12](https://doi.org/10.6028/NIST.AI.600-1) |
| L6 | Bought outside IT and Legal review | Yes = 1; No = 0 | Yes | [NIST CSF 2.0 GV.SC-05](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 GV.SC-06](https://doi.org/10.6028/NIST.CSWP.29) |
| L7 | Third-party security rating | 76-100 = 0; 51-75 = 1; 26-50 = 2; 0-25 = 3; Not rated = 2 | Yes | [NIST CSF 2.0 GV.SC-07](https://doi.org/10.6028/NIST.CSWP.29) |
| L8 | Recent ownership change | Yes = 1; No = 0; Unknown = 0.5 | No | [NIST CSF 2.0 GV.SC-07](https://doi.org/10.6028/NIST.CSWP.29) |
| L9 | Our data goes to other AI companies | Yes = 1; No = 0; Unknown = 1 | No | [NIST AI RMF 1.0 GOVERN 6.1](https://doi.org/10.6028/NIST.AI.100-1), [NIST CSF 2.0 GV.SC-07](https://doi.org/10.6028/NIST.CSWP.29) |
| L10 | Human approval of actions | Yes = 0; No = 2; Unknown = 1 | No | [OWASP Top 10 for LLM Apps 2025 LLM06](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/), [NIST AI 600-1 2.7](https://doi.org/10.6028/NIST.AI.600-1) |
| L11 | Single sign-on and MFA | Yes = 0; No = 1 | No | [NIST CSF 2.0 PR.AA-01](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 PR.AA-03](https://doi.org/10.6028/NIST.CSWP.29), [CISA Secure by Demand Guide (2024)](https://www.cisa.gov/news-events/news/cisa-releases-secure-demand-guide) |
| L12 | Written deletion promise | Yes = 0; No = 1 | No | [NIST CSF 2.0 GV.SC-10](https://doi.org/10.6028/NIST.CSWP.29), [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) |
| L13 | Downplayed or mishandled a breach | Yes = 2; No = 0; No breach on record = 0; Unknown = 1 | Yes | [NIST CSF 2.0 RS.CO-02](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 GV.SC-07](https://doi.org/10.6028/NIST.CSWP.29) |
| L14 | Incident-notification deadline | Yes = 0; No = 1 | Yes | [NIST CSF 2.0 GV.SC-05](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 GV.SC-08](https://doi.org/10.6028/NIST.CSWP.29) |
| L15 | Vulnerability reporting and fix record | Yes = 0; No = 1 | Yes | [NIST CSF 2.0 ID.RA-08](https://doi.org/10.6028/NIST.CSWP.29), [CISA Secure by Demand Guide (2024)](https://www.cisa.gov/news-events/news/cisa-releases-secure-demand-guide), [CISA Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) |

#### Impact (points)

| ID | Factor | Answers | Required | Basis |
|---|---|---|---|---|
| I1 | What if it failed or the vendor vanished? | Catastrophic = 3; Unacceptable = 2; Acceptable = 0 | Yes | [NIST CSF 2.0 GV.SC-04](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 ID.AM-05](https://doi.org/10.6028/NIST.CSWP.29) |
| I2 | Supports critical work | Yes = 3; No = 0 | Yes | [NIST CSF 2.0 GV.SC-04](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 ID.AM-05](https://doi.org/10.6028/NIST.CSWP.29) |
| I3 | Most sensitive data it will touch | Sensitive = 3; Confidential = 2; Internal = 1; Public = 0 | Yes | [FIPS 199](https://csrc.nist.gov/pubs/fips/199/final), [NIST CSF 2.0 ID.AM-05](https://doi.org/10.6028/NIST.CSWP.29) |
| I4 | Could exposure hurt people? | Yes = 3; No = 0 | Yes | [NIST SP 800-122](https://csrc.nist.gov/pubs/sp/800/122/final) |
| I5 | How widely it's used | Organization-wide = 2; Multiple teams = 1; Single team or pilot = 0 | No | [NIST CSF 2.0 ID.RA-04](https://doi.org/10.6028/NIST.CSWP.29) |
| I6 | Access to our systems | Admin or write access = 2; Read-only integration = 1; Standalone, no integration = 0 | No | [NIST CSF 2.0 PR.AA-05](https://doi.org/10.6028/NIST.CSWP.29) |
| I7 | Data about vulnerable people | Yes = 2; No = 0 | No | [NIST AI RMF 1.0 MAP 5.1](https://doi.org/10.6028/NIST.AI.100-1), [NIST SP 800-122](https://csrc.nist.gov/pubs/sp/800/122/final), [COPPA Rule 16 CFR Part 312](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312) |

#### Organization preferences (multiplier)

| ID | Factor | Answers | Required | Basis |
|---|---|---|---|---|
| P1 | AI content safeguards | Yes = +0×; No = +0.5× | Yes | **Org preference**; related: [NIST AI 600-1 2.3](https://doi.org/10.6028/NIST.AI.600-1), [NIST AI 600-1 2.11](https://doi.org/10.6028/NIST.AI.600-1) |
| P2 | Consent and protections for vulnerable people | Yes = +0×; No = +0.5× | Yes | **Org preference**; related: [NIST AI 600-1 2.4](https://doi.org/10.6028/NIST.AI.600-1), [NIST AI RMF 1.0 MAP 5.1](https://doi.org/10.6028/NIST.AI.100-1) |
| P3 | Training on our data, vendor access | Yes = +0×; No = +0.5× | Yes | **Org preference**; related: [NIST AI 600-1 2.4](https://doi.org/10.6028/NIST.AI.600-1), [NIST CSF 2.0 GV.SC-05](https://doi.org/10.6028/NIST.CSWP.29) |
| P4 | Data stored outside our country | Yes = +0.5×; No = +0×; Unknown = +0.25× | Yes | **Org preference**; related: [NIST CSF 2.0 GV.SC-05](https://doi.org/10.6028/NIST.CSWP.29), [NIST SP 800-161 Rev. 1](https://doi.org/10.6028/NIST.SP.800-161r1), [GDPR Art. 44](https://gdpr-info.eu/art-44-gdpr/) |
| P5 | Sanctioned country connection | Yes = +0.5×; No = +0×; Unknown = +0.25× | Yes | **Org preference**; related: [NIST CSF 2.0 GV.SC-06](https://doi.org/10.6028/NIST.CSWP.29), [NIST SP 800-161 Rev. 1](https://doi.org/10.6028/NIST.SP.800-161r1), [U.S. Treasury OFAC](https://ofac.treasury.gov/sanctions-programs-and-country-information) |
| P6 | Copyright indemnity for AI output | Yes = +0×; No = +0.5× | Yes | **Org preference**; related: [NIST AI 600-1 2.9](https://doi.org/10.6028/NIST.AI.600-1), [U.S. Copyright Office](https://www.copyright.gov/ai/) |
| P7 | Government surveillance or military use | Yes = +0.5×; No = +0×; Unknown = +0.25× | Yes | **Org preference**; related: [NIST CSF 2.0 GV.SC-06](https://doi.org/10.6028/NIST.CSWP.29), [NIST SP 800-161 Rev. 1](https://doi.org/10.6028/NIST.SP.800-161r1) |
| P8 | Hard to leave (lock-in) | Yes = +0.5×; No = +0×; Unknown = +0.25× | Yes | **Org preference**; related: [NIST CSF 2.0 GV.SC-10](https://doi.org/10.6028/NIST.CSWP.29), [NIST SP 800-161 Rev. 1](https://doi.org/10.6028/NIST.SP.800-161r1) |

#### Mitigations (score reduction)

| ID | Factor | Answers | Required | Basis |
|---|---|---|---|---|
| M1 | Signed DPA: no training, deletion | Yes = −10%; No = 0 | No | [NIST CSF 2.0 GV.SC-05](https://doi.org/10.6028/NIST.CSWP.29) |
| M2 | Zero-retention mode enforced | Yes = −10%; No = 0 | No | [NIST CSF 2.0 GV.SC-05](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 PR.DS-01](https://doi.org/10.6028/NIST.CSWP.29) |
| M3 | SSO with automatic provisioning | Yes = −5%; No = 0 | No | [NIST CSF 2.0 PR.AA-01](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 PR.AA-05](https://doi.org/10.6028/NIST.CSWP.29) |
| M4 | Sensitive data blocked by technical controls | Yes = −10%; No = 0 | No | [NIST CSF 2.0 PR.DS-01](https://doi.org/10.6028/NIST.CSWP.29), [NIST CSF 2.0 PR.DS-02](https://doi.org/10.6028/NIST.CSWP.29) |
| M5 | Time-limited pilot | Yes = −5%; No = 0 | No | [NIST CSF 2.0 GV.SC-07](https://doi.org/10.6028/NIST.CSWP.29) |

#### Risk bands

| Band | Score at least | Decision | Re-review |
|---|---|---|---|
| Very Low | 0 | Approved | every 24 months |
| Low | 29 | Approved | every 12 months |
| Moderate | 58 | Denied | every 12 months |
| High | 87 | Denied | every 6 months |
| Critical | 116 | Denied | every 6 months |

Mitigation credit is capped at **25%**. The preference multiplier starts at **1**. If any mitigation is credited and the band says Approved, the decision becomes **Approved with Conditions**.

<!-- tables:end -->

## How this is tested

- [`tests/scoring-cases.csv`](tests/scoring-cases.csv) holds 45 scenarios: edge cases, every band boundary, the mitigation cap, the preference multipliers, incomplete forms, and 20 seeded random assessments. **Their expected numbers were computed by the original spreadsheet's Excel formulas**, not by AssessIT. CI replays every row on every pull request. You can open the file in Excel and add your own rows.
- [`tests/policy.test.ts`](tests/policy.test.ts) fails if a question marked "standard" doesn't cite its guidance.
- [`tests/docs.test.ts`](tests/docs.test.ts) fails if the tables above drift from the policy file.
