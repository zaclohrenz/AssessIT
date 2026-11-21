import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  cisaDecision,
  cisaResult,
  decisionProgress,
  timelineProgress,
  missionWellBeing,
  normalizeCveId,
  prefillFromCisa,
  remediationTimeline,
  summarizeCve,
  timelineResult,
  TIMELINE_MEANING,
  VULN_QUESTIONS,
  whatIf,
  type Exploitation,
  type MissionWellBeing,
  type TechnicalImpact,
  type Timeline,
  type YesNo,
} from "../src/ssvc";

const csv = (f: string) =>
  readFileSync(new URL(`./ssvc/${f}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .slice(1)
    .map((l) => l.split(","));

describe("CISA SSVC decision tree (SSVC Guide, Table 9)", () => {
  const rows = csv("cisa-decisions.csv");
  it("covers all 36 combinations", () => expect(rows).toHaveLength(36));
  it.each(rows)("%s / automatable %s / %s / %s -> %s", (e, a, t, mwb, decision) => {
    expect(cisaDecision(e as Exploitation, a as YesNo, t as TechnicalImpact, mwb as MissionWellBeing)).toBe(decision);
  });
});

describe("Mission & well-being (SSVC Guide, Table 8)", () => {
  it.each([
    ["minimal", "minimal", "low"],
    ["minimal", "material", "medium"],
    ["minimal", "irreversible", "high"],
    ["support", "minimal", "medium"],
    ["support", "material", "medium"],
    ["support", "irreversible", "high"],
    ["essential", "minimal", "high"],
    ["essential", "material", "high"],
    ["essential", "irreversible", "high"],
  ] as const)("%s prevalence + %s well-being -> %s", (mp, wb, out) => expect(missionWellBeing(mp, wb)).toBe(out));
});

describe("BOD 26-04 remediation timelines (Table 1)", () => {
  const rows = csv("bod-26-04.csv");
  it("covers all 16 combinations", () => expect(rows).toHaveLength(16));
  it.each(rows)("row %s: exposed %s, KEV %s, automatable %s, %s -> %s", (_row, exposed, kev, a, t, timeline) => {
    const got = remediationTimeline(exposed as YesNo, kev as YesNo, a as YesNo, t as TechnicalImpact);
    expect(TIMELINE_MEANING[got as Timeline].label.toLowerCase()).toBe(timeline.toLowerCase().replace("&", "+"));
  });
});

describe("answers -> results", () => {
  it("needs every input before giving a result", () => {
    expect(cisaResult({ exploitation: "active", automatable: "yes", technicalImpact: "total" })).toBeNull();
    expect(timelineResult({ inKev: "yes", automatable: "yes", technicalImpact: "total" })).toBeNull();
  });
  it("what-if previews show the result each option would give", () => {
    const x = { exploitation: "active", automatable: "yes", technicalImpact: "total", inKev: "yes", missionPrevalence: "minimal" } as const;
    expect(whatIf(x, "wellBeing", "minimal").decision).toBe("Attend");
    expect(whatIf(x, "wellBeing", "irreversible").decision).toBe("Act");
    expect(whatIf(x, "publiclyExposed", "no").timeline).toBe("3d+forensic");
  });
  it("every question's options are valid answers", () => {
    for (const q of VULN_QUESTIONS) expect(q.options.length).toBeGreaterThan(1);
  });
});

describe("pre-filling from CISA data", () => {
  const record = JSON.parse(readFileSync(new URL("./ssvc/cve-2024-3400.json", import.meta.url), "utf8"));

  it("reads CISA's Vulnrichment SSVC answers and KEV status from the CVE record", () => {
    const p = prefillFromCisa(record, null);
    expect(p.answers).toEqual({ exploitation: "active", automatable: "yes", technicalImpact: "total", inKev: "yes" });
    expect(p.sources.exploitation).toBe("cisa");
    expect(p.cisaAnalyzed).toBe("2024-04-17");
  });

  it("KEV overrides an out-of-date exploitation value", () => {
    const stale = structuredClone(record);
    stale.containers.adp[0].metrics[0].other.content.options[0] = { Exploitation: "poc" };
    const p = prefillFromCisa(stale, { cveID: "CVE-2024-3400" });
    expect(p.answers.exploitation).toBe("active");
    expect(p.sources.exploitation).toBe("kev");
    expect(p.notes[0]).toMatch(/now in KEV/);
  });

  it("without CISA analysis, asks the user and says why", () => {
    const bare = { cveMetadata: { cveId: "CVE-2026-0001" }, containers: { cna: {} } };
    const p = prefillFromCisa(bare, null);
    expect(p.answers).toEqual({ inKev: "no" });
    expect(p.notes.join(" ")).toMatch(/hasn't published an SSVC analysis/);
  });

  it("summarizes the CVE", () => {
    const s = summarizeCve(record);
    expect(s).toMatchObject({ id: "CVE-2024-3400", vendor: "Palo Alto Networks", product: "PAN-OS", published: "2024-04-12" });
    expect(s.description).toMatch(/GlobalProtect/);
  });

  it("accepts CVE IDs the way people type them", () => {
    expect(normalizeCveId(" cve-2024-3400 ")).toBe("CVE-2024-3400");
    expect(normalizeCveId("CVE-2026-129448")).toBe("CVE-2026-129448");
    expect(normalizeCveId("2024-3400")).toBeNull();
  });
});

describe("partial answers", () => {
  it("nothing answered: every result is still possible", () => {
    const p = decisionProgress({});
    expect(p.possible).toEqual(["Track", "Track*", "Attend", "Act"]);
    expect(p.settled).toBeNull();
  });

  it("active exploitation alone rules out Track*", () => {
    expect(decisionProgress({ exploitation: "active" }).possible).toEqual(["Track", "Attend", "Act"]);
  });

  it("settles early and names the answers that force the result", () => {
    // None + not automatable + partial impact is Track for every mission and well-being answer.
    const p = decisionProgress({ exploitation: "none", automatable: "no", technicalImpact: "partial" });
    expect(p.settled).toBe("Track");
    expect(p.decidedBy.sort()).toEqual(["automatable", "exploitation", "technicalImpact"]);
  });

  it("leaves out answers that don't matter", () => {
    const p = decisionProgress({ exploitation: "none", automatable: "no", technicalImpact: "partial", missionPrevalence: "essential" });
    expect(p.decidedBy).not.toContain("missionPrevalence");
  });

  it("timeline: KEV + total impact + exposed is 3 days + forensic triage whatever automatable is", () => {
    const p = timelineProgress({ inKev: "yes", technicalImpact: "total", publiclyExposed: "yes" });
    expect(p.settled).toBe("3d+forensic");
    expect(p.decidedBy.sort()).toEqual(["inKev", "publiclyExposed", "technicalImpact"]);
  });

  it("agrees with the full tables once everything is answered", () => {
    const x = { exploitation: "active", automatable: "yes", technicalImpact: "total", missionPrevalence: "support", wellBeing: "minimal" } as const;
    expect(decisionProgress(x).settled).toBe(cisaResult(x));
  });
});
