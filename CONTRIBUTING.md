# Contributing to AssessIT

Thanks for helping. Bug fixes, UI improvements, new export formats and better research prompts are all welcome. Changes to the **default scoring** follow a stricter rule, explained below.

## The scoring rule

AssessIT's default scoring follows published guidance: NIST (CSF 2.0, SP 800-30, SP 800-161, the AI RMF and AI 600-1), CISA (Secure by Design / Secure by Demand) and similar public standards. [SCORING.md](SCORING.md) lists the basis for every question.

**The defaults change only when the guidance changes.** A pull request that changes default questions, points, bands, hard stops or the formula must:

1. Cite a specific, published, public document (for example "NIST CSF 2.1, GV.SC-11"), with a link and the relevant text.
2. Explain how that guidance changes what the default should be.
3. Keep `tests/scoring-cases.csv` passing, or update it with an explanation of every changed number.

Pull requests that change defaults because of opinion ("vendor X should score higher", "I'd weigh breaches more") will be closed, however **your organization can weigh things however it likes** using an org config with its own policy; see the README's "Rolling it out to your organization" section. Keeping the defaults tied to public guidance is what makes them trustworthy for everyone else.

### Organization preferences

Some things organizations reasonably care about don't have clear NIST or CISA guidance yet, such as whether a vendor's AI produces harmful content. These live in the **Organization preferences** section, are labeled `"basis": "preference"`, and scale the score instead of adding points. Adding a new default preference needs the same bar as above: show that it's widely held and explain why it belongs in the defaults rather than in an org config.

## Development

```sh
npm install
npm test               # all unit tests, including the golden scoring cases
npm run tauri dev      # run the app
npm run docs:scoring   # regenerate the tables in SCORING.md after editing the policy
```

Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`.

### Golden scoring cases

`tests/scoring-cases.csv` holds scenarios whose expected results were computed by the original reference spreadsheet's formulas. They're an independent check on `src/engine.ts`. Don't change expected numbers to make a test pass. If a number has to change, the PR must say which guidance changed and why. You can add rows by hand; SCORING.md shows how to work them out.

## Pull request titles

Each release's notes list the titles of the PRs merged since the last release, so use [Conventional Commits](https://www.conventionalcommits.org/) titles. A check on every PR enforces this.

| Title starts with | Meaning |
|---|---|
| `fix: …` | Bug fix |
| `feat: …` | New feature |
| `feat!: …` | Incompatible change, such as the policy file format |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | No user-facing change |

Titles don't trigger releases. A maintainer releases by hand (README → "Releasing") and picks the version then.

Use the `scoring` scope for anything that changes scoring results, for example `fix(scoring): …`, so organizations can spot those changes in the release notes.
