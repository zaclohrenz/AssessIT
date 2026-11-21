# AssessIT

<img src="src-tauri/icons/app-icon.png" align="left" width="104" alt="AssessIT icon: the letters IT under a magnifying glass">

**Score a software vendor's risk and get an approve or deny decision, with the reasons behind it.** AI does the legwork of finding the evidence. A person reviews it. The math follows published guidance from NIST and CISA.

AssessIT is a free desktop app for macOS and Windows:

<br clear="left">

1. **Describe the request**: vendor, product, plan and what it'll be used for.
2. **Let AI research it.** It checks the vendor's trust center, privacy terms, breach history, lawsuits, sub-processors and SSO support, then pre-fills every question with notes and source links. You can change anything.
3. **Get the decision.** You get a risk score, band, decision (Approved / Approved with Conditions / Denied), the biggest risk drivers, a path to approval and a ready-to-send message.
4. **Send it for approval** to a SharePoint list (or any webhook), or **export a PDF**.

The left-hand pane shows what's left: yellow **TODO**, purple **REVIEW** for AI answers nobody has checked yet, green **OK**. You can still submit early. **Submit YOLO 🤠** sends it anyway, after a warning, with every open issue flagged at the top for the approvers.

## Install

### macOS (Homebrew)

```sh
brew tap zaclohrenz/assessit https://github.com/zaclohrenz/AssessIT
brew trust --cask zaclohrenz/assessit/assessit
brew install --cask assessit
```

Homebrew 7 won't load casks from third-party taps until you trust them; `brew trust` approves just this one cask.

If your organization gave you a config URL, install with it instead. AssessIT then starts with your org's approval destination, scoring policy and locks:

```sh
brew tap zaclohrenz/assessit https://github.com/zaclohrenz/AssessIT
brew trust --cask zaclohrenz/assessit/assessit
HOMEBREW_ASSESSIT_CONFIG_URL="https://…/assessit-config.json" brew install --cask assessit
```

Open **AssessIT** from Applications or Launchpad. Updates arrive with `brew upgrade` and keep the config URL. You can also set it later in **Settings → Organization config**, unless your org locked it. For MDM and other options, see [Rolling it out](#rolling-it-out-to-your-organization).

> **Why Homebrew?** AssessIT is free, so it isn't signed with a paid Apple Developer ID. When you install through this cask, it clears macOS's download quarantine flag, so the app opens with a normal double-click. If you download the zip by hand instead, right-click the app → **Open** the first time.

### Windows

Download `AssessIT_x.y.z_x64-setup.exe` from [Releases](https://github.com/zaclohrenz/AssessIT/releases). Windows SmartScreen may warn about an unrecognized app because it isn't code-signed. Click **More info → Run anyway**.

To use your organization's config URL, run this once in a terminal before opening AssessIT, or paste the URL into **Settings → Organization config**:

```bat
reg add HKCU\Software\AssessIT /v ConfigURL /d "https://…/assessit-config.json" /f
```

## AI research: no API keys

- **Claude Code (automatic).** If you have a Claude subscription, AssessIT runs your own [Claude Code](https://claude.com/product/claude-code) in the background with web search and web fetch only: no file access, no shell, no MCP servers. You can watch each search as it happens. If Claude Code isn't set up, the **Install & sign in** button opens a Terminal window that does it for you.
- **Any other AI (copy & paste).** Click **Copy prompt**, paste it into ChatGPT, Gemini, Copilot or any chat that can browse the web, then paste the whole reply back. AssessIT extracts the answers and checks every answer against the allowed options.

AI answers stay tagged **AI · confidence** until a person reviews or edits them, and questions only your organization can answer are flagged **Confirm internally**. Answers you typed are never overwritten.

## How the score works

```
Risk Score = Likelihood × Impact × Preference multiplier × (1 − Mitigation credit)
```

[**SCORING.md**](SCORING.md) explains it in one page, with a worked example and the basis for every question. In short:

- **Every default question cites published guidance:** NIST CSF 2.0 supplier risk (GV.SC), NIST SP 800-30, the NIST AI RMF and Generative AI Profile, CISA Secure by Demand, OWASP. The app shows the citation under each question.
- **Organization preferences** are things many organizations care about that NIST and CISA don't yet say how to weigh, such as an AI vendor producing harmful content. They're labeled as preferences and scale the whole score.
- **The defaults only change when the guidance changes** ([CONTRIBUTING.md](CONTRIBUTING.md)). If your organization weighs things differently, use your own policy in an org config.
- **The scoring can't silently break.** CI replays 45 golden scenarios whose expected numbers were computed by the original reference spreadsheet's formulas ([`tests/scoring-cases.csv`](tests/scoring-cases.csv)).

## Rolling it out to your organization

An **org config** is one JSON file that sets your organization's name, where submissions go, the AI model and (optionally) your own scoring policy. Host it anywhere reachable over HTTPS, such as SharePoint, an intranet or a GitHub repo, and point AssessIT at it. Users then just install and go.

The easiest way to make one: set everything up in **Settings**, then click **Export org config**. There are two starting points in [`config/`](config/).

### Defaults users can change: [`example-org-config.json`](config/example-org-config.json)

```json
{
  "assessitConfig": 1,
  "name": "Contoso AssessIT config",
  "org": { "orgName": "Contoso", "reviewTeam": "Contoso IT Risk Review" },
  "submit": { "method": "sharepoint", "tenant": "contoso.onmicrosoft.com", "clientId": "…your Entra app ID…",
              "siteUrl": "https://contoso.sharepoint.com/sites/ITRisk", "listName": "Software Risk Assessments" }
}
```

Without `lock`, everything here is a pre-filled default. Users get your approval destination out of the box, but can change it (or anything else) in Settings.

### Locked down: [`example-locked-org-config.json`](config/example-locked-org-config.json)

```json
{
  "assessitConfig": 1,
  "name": "Contoso AssessIT config (managed)",
  "lock": true,
  "rules": { "allowOverride": false, "allowYolo": false, "allowBulkReview": false },
  "org": { "orgName": "Contoso", "reviewTeam": "Contoso IT Risk Review" },
  "submit": { "method": "sharepoint", "tenant": "contoso.onmicrosoft.com", "clientId": "…your Entra app ID…",
              "siteUrl": "https://contoso.sharepoint.com/sites/ITRisk", "listName": "Software Risk Assessments" },
  "policyUrl": "https://github.com/zaclohrenz/AssessIT/releases/latest/download/default-policy.json"
}
```

| Option | What it does |
|---|---|
| `"lock": true` | Users can't change anything the file sets. It also **pins the scoring policy** (yours, or the default), so nobody can import a more lenient one. Set at install time, it also pins the config URL: see "Changing a locked URL" below. |
| `"lock": ["submit", "policy"]` | Lock only some parts. Any of `org`, `submit`, `model`, `policy`. |
| `rules.allowOverride: false` | Hides **Decision override**. The calculated decision is what gets submitted; approvers can still accept risk when they decide. |
| `rules.allowYolo: false` | No submitting with open issues: every required question answered and every AI answer reviewed first. |
| `rules.allowBulkReview: false` | Removes **Mark all AI answers reviewed**, so each AI answer gets looked at. |
| `policy` / `policyUrl` | Your own scoring policy, embedded or hosted. Leave both out to use the public defaults. |

**Always on, no config needed:** when someone changes an answer that AI research proposed (for example a breach finding from Yes to No), the submission, the PDF and the `ChangedFromAI` SharePoint column show the AI's original answer next to theirs. Talking a score down is visible to approvers.

### Pointing users at it

Admin-managed settings win. Next, a URL typed in Settings beats the install-time one, unless the install-time config is locked:

| How | Who it's for | What to do |
|---|---|---|
| **MDM / Group Policy** | IT-managed fleets | macOS: deploy a configuration profile, or `sudo defaults write /Library/Preferences/io.github.zaclohrenz.assessit ConfigURL "https://…"`. Windows: set registry value `HKLM\Software\AssessIT\ConfigURL` (REG_SZ) via Intune or GPO. Only admins can set these, so users can't change them. (The same value set without admin rights counts like an install-time URL.) |
| **At install time** | Homebrew users | `HOMEBREW_ASSESSIT_CONFIG_URL="https://…" brew install --cask assessit`. Homebrew only passes through variables starting with `HOMEBREW_`. Later `brew upgrade`s keep the URL. If that config has `lock`, users can't swap it for another URL in Settings. |
| **Settings → Organization config** | Anyone | Paste the URL once. |
| **Nothing** | Everyone else | AssessIT uses the public defaults attached to this project's latest release. |

**How strong is a lock?** It stops anyone changing values in the app. Whoever owns the Mac can still uninstall and reinstall without the install-time URL, so for enforcement:
- deploy the URL through MDM / Group Policy (an admin-owned setting users can't edit);
- have reviewers check the `policy` name and version in each submission.

**Changing a locked URL.** A locked config set at install time pins its own URL, so users can't switch it in Settings. Plan for that:
- **Keep the URL alive.** Edit the file in place and every Mac picks up the change at next launch. If you have to move it, redirect the old URL to the new one: AssessIT follows HTTP redirects.
- **If the URL goes away**, AssessIT keeps using the last copy it downloaded: still locked, never updated.
- **To repoint a Mac by hand**, reinstall *with* the new URL (`HOMEBREW_ASSESSIT_CONFIG_URL=… brew reinstall --cask assessit`), or run `brew uninstall --zap --cask assessit` to clear it. A plain `brew reinstall` keeps the old URL.
- With MDM / Group Policy, just change the URL centrally.

**The public default config can never set where submissions go,** lock anything or set rules: it can only update the scoring policy. That way a bad edit to this project's GitHub release can't redirect anyone's data. Your own config has no such limit. The app caches the last good config, so it keeps working offline.

If you'd rather have your own one-line install, copy [`Casks/assessit.rb`](Casks/assessit.rb) into your own tap and replace `ENV.fetch("HOMEBREW_ASSESSIT_CONFIG_URL", "")` with your URL. Then `brew trust --cask yourco/tap/assessit && brew install --cask yourco/tap/assessit` installs with your config built in.

## Sending results for approval

**SharePoint list (recommended).** AssessIT adds each request to a SharePoint list **as the signed-in user**, so every submission is tied to a verified Microsoft 365 account. Your review group decides right on the list item, using only built-in SharePoint features (no Power Automate):

```
Submitted ──► In review ──► Approved
  (app)      (reviewer)  ├► Approved with conditions   ← note required
                         └► Denied                     ← note required
```

- **Who did what is recorded:** the submitter is the item's *Created By*, and version history records every change with who made it and when.
- **Notes are enforced:** list validation won't save *Approved with conditions* or *Denied* without a *DecisionNote*.
- **Only reviewers decide.** Requesters can add items but not edit them; reviewers can edit but not add or delete.
- **The raw form values are stored as well:** every answer exactly as entered goes in the *AssessmentJSON* column, alongside readable columns for list views.

Setup takes about 20 minutes for a SharePoint admin: the list, permissions, a free Entra app registration, a validation rule and notification rules. Follow **[docs/sharepoint-setup.md](docs/sharepoint-setup.md)**.

**Webhook (alternative).** AssessIT can instead POST JSON to Power Automate or any HTTPS endpoint (Zapier, n8n, Jira automation). Nobody signs in, so a webhook can't prove who submitted. Either way, submissions sent with open issues carry `ReviewFlags`, and changed AI answers carry `ChangedFromAI`.

## Where data goes

- Assessments stay on your computer: autosaved in the app, or saved as `.assessit.json` files.
- AI research sends the vendor, product, plan and intended use to whichever AI you choose.
- Submitting sends the assessment only to the destination in your settings.
- At launch, the app downloads your org config: the public defaults from GitHub unless you've set your own URL or turned it off in Settings. No telemetry.

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please), the same setup many large open-source projects use:

1. **Merge PRs with [Conventional Commit](https://www.conventionalcommits.org/) titles:** `fix: …` (patch), `feat: …` (minor), `feat!: …` (major). A check on every PR enforces this.
2. **release-please keeps a "Release PR" open.** It collects every change since the last release into `CHANGELOG.md` and bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`. It updates itself as more PRs merge.
3. **Merge the Release PR when you want to ship.** That creates a draft GitHub release with those notes and tags `vX.Y.Z`. The workflow then builds and attaches:
   - the universal macOS zip and the Windows installer;
   - the public default config and policy.

   Once everything is attached, it publishes the release and commits an updated `Casks/assessit.rb` (new version and checksum) to `main`. The repo uses GitHub's immutable releases, so a published release can't be changed; if a build fails, the release stays a draft until you re-run the failed job.
4. **Homebrew users get it on their next `brew upgrade`**, since Homebrew refreshes taps automatically. Organizations can schedule this with `brew autoupdate` or their MDM.

## Development

Requirements: Node 22+, Rust (stable), and on macOS the Xcode command line tools.

```sh
npm install
npm test                 # unit tests, golden scoring cases, citation and docs checks
npm run tauri dev        # run the app with hot reload
npm run docs:scoring     # regenerate SCORING.md tables after editing the policy
scripts/package-mac.sh   # universal macOS .app → release/*.zip (+ sha256)
```

| Path | What |
|---|---|
| `src/engine.ts` | Scoring. Read `riskScore()` first: the formula is one line. |
| `src/policy/default-policy.json` | Default questions, points, bands and citations |
| `tests/scoring-cases.csv` | 45 golden scenarios computed by the original spreadsheet |
| `src/research.ts` | Research prompt, JSON schema, copy & paste parsing |
| `src/orgconfig.ts`, `src-tauri/src/config.rs` | Org config lookup, MDM / registry, download and cache |
| `src/pdf.ts` | The PDF report |
| `src/report.ts` | SharePoint fields, webhook payload, Excel layout |
| `src/main.ts` | The UI |
| `src-tauri/src/claude.rs` | Runs Claude Code headlessly and streams progress |
| `src-tauri/src/submit.rs` | Webhook and Microsoft Graph |
| `Casks/assessit.rb` | Homebrew cask (this repo is also the tap) |

## License

MIT
