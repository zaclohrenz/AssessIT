import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bandFor, cautiousChoice, compute, draftMessage, formatDate, isIgnored, optionTone, pathToApproval, summary, toneWords, type Result } from "./engine";
import { chooseConfig, sanitizeConfig, type ConfigChoice } from "./orgconfig";
import { reportPdf } from "./pdf";
import { APP_VERSION, changedFromAi, STATUSES, decisionTone, fmtPts, listFields, REQUIRED_DETAILS, reviewFlags, scoreBreakdown, scoreCaptionPlain, scoreHeadline, SHAREPOINT_COLUMNS, webhookPayload, xlsxSheets, ZONE_LABEL } from "./report";
import { extractUrls, linkLabel } from "./links";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { percent, releaseUrl, type UpdateState } from "./update";
import { aiAnswerCount, navStatus, sectionStatus, type Bubble, type BubbleKind } from "./status";
import { manualPrompt, mergeResearch, parseManualResponse, researchPrompt, researchSchema, type ResearchOutput } from "./research";
import {
  activePolicy, blankAssessment, effectiveSettings, loadCurrent, migrateAssessment, loadUserSettings, lockedPaths,
  orgRules, saveCurrent,
  saveUserSettings, validatePolicy, type OrgConfig, type UserSettings,
} from "./settings";
import { approvalLimit, clonePolicy, DECISIONS, diffPolicy, maxPossibleScore, newQuestion, reasonProblem, setApprovalLimit, TEXT_LIMITS, validateScoring, withEdits } from "./scoring";
import type { Answer, Details, Factor, Policy, Reference, Section } from "./types";
import {
  answerChip,
  cisaResult,
  decisionProgress,
  DECISION_KEYS,
  DECISION_MEANING,
  missionWellBeing,
  normalizeCveId,
  prefillFromCisa,
  summarizeCve,
  timelineProgress,
  TIMELINE_KEYS,
  timelineResult,
  TIMELINE_MEANING,
  triageText,
  VULN_QUESTIONS,
  whatIf,
  type AnswerSource,
  type CveSummary,
  type KevEntry,
  type VulnAnswers,
  type VulnKey,
} from "./ssvc";

type Tab = "request" | "questions" | "report" | "settings" | "scoring" | "vuln";
type Filter = "all" | "review" | "unanswered";

interface ClaudeStatus { path: string | null; version: string | null; logged_in: boolean; account: string | null; error: string | null }
interface DeviceCode { device_code: string; user_code: string; verification_uri: string; message: string; interval: number; expires_in: number }

interface RemoteConfig {
  choice: ConfigChoice;
  config: OrgConfig | null;
  loading: boolean;
  fetchedAt: number | null;
  stale: boolean;
  error: string;
}

/** Vulnerability triage page. Kept separately from the assessment; it isn't part of a vendor review. */
interface VulnState {
  input: string;
  loading: boolean;
  error: string;
  cve: CveSummary | null;
  kev: KevEntry | null;
  kevInfo: { version: string; fetchedAt: number; stale: boolean } | null;
  answers: VulnAnswers;
  sources: Partial<Record<VulnKey, AnswerSource>>;
  notes: string[];
  cisaAnalyzed?: string;
}
const VULN_KEY = "assessit.vuln";
const blankVuln = (): VulnState => ({ input: "", loading: false, error: "", cve: null, kev: null, kevInfo: null, answers: {}, sources: {}, notes: [] });
function loadVuln(): VulnState {
  try {
    return { ...blankVuln(), ...JSON.parse(localStorage.getItem(VULN_KEY) ?? "{}"), loading: false, error: "" };
  } catch {
    return blankVuln();
  }
}
function saveVuln() {
  try {
    localStorage.setItem(VULN_KEY, JSON.stringify(S.vuln));
  } catch {
    /* storage unavailable */
  }
}

const user: UserSettings = loadUserSettings();

const S = {
  user,
  remote: { choice: { kind: "default", url: null }, config: null, loading: true, fetchedAt: null, stale: false, error: "" } as RemoteConfig,
  /** Effective settings: defaults + org config + the user's edits (see effectiveSettings). */
  settings: effectiveSettings(user, null),
  a: loadCurrent(),
  tab: "request" as Tab,
  filter: "all" as Filter,
  research: { running: false, log: [] as { kind: string; text: string }[], error: "", done: "" },
  /** "Other AI" copy & paste panel */
  manual: { open: false, paste: "" },
  claude: null as ClaudeStatus | null,
  update: { kind: "checking" } as UpdateState,
  graphAccount: null as string | null,
  device: null as DeviceCode | null,
  submitting: false,
  vuln: loadVuln(),
  /** The scoring editor's working copy. Nothing is saved until the person saves it. */
  sc: null as null | { draft: Policy; reason: string; tab: ScTab },
  /** Last bubble state per nav item, so a change can "pop". */
  bubbles: {} as Record<string, string>,
};

const SECTIONS: Section[] = ["Likelihood", "Impact", "Preference", "Mitigation"];
const SECTION_LABEL: Record<Section, string> = {
  Likelihood: "Likelihood",
  Impact: "Impact",
  Preference: "Org preferences",
  Mitigation: "Mitigations",
};

function recomputeSettings() {
  S.settings = effectiveSettings(S.user, S.remote.config);
}
const isLocked = (path: string) => lockedPaths(S.remote.config).has(path);
const rules = () => orgRules(S.remote.config);

/** Rules apply to opened files too: an override saved elsewhere doesn't count where overrides aren't allowed. */
function applyRules() {
  if (rules().allowOverride || !S.a.details.override) return;
  S.a.details.override = "";
  persist();
}

const policy = () => activePolicy(S.settings);
const result = (): Result => compute(policy(), S.a);

/** Brings the open assessment in line with the policy in use (stamps its version; swaps Yes/No on questions a newer default policy turned around). Run whenever the assessment or the policy changes. */
function migrateCurrent() {
  const before = JSON.stringify(S.a);
  migrateAssessment(S.a, policy());
  if (JSON.stringify(S.a) !== before) persist();
}
migrateCurrent();
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** -0.05 -> "−5%", 0 -> "0%" */
const pct = (x: number) => (Math.round(x * 100) === 0 ? "0%" : `${x < 0 ? "−" : ""}${Math.abs(Math.round(x * 100))}%`);
const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

function toast(msg: string, ms = 3500) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** Text boxes grow to fit their contents, so AI notes and source lists are readable without scrolling inside them. */
function autosize(el: HTMLTextAreaElement) {
  if (!el.offsetParent) return; // hidden (e.g. a closed panel): measure when it's shown
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}
const fitTextareas = () => document.querySelectorAll("textarea").forEach(autosize);
let autosizeQueued = false;
function autosizeAll() {
  if (autosizeQueued) return;
  autosizeQueued = true;
  requestAnimationFrame(() => {
    autosizeQueued = false;
    fitTextareas();
  });
}

function persist() {
  saveCurrent(S.a);
}

// ---------------- Shell ----------------

// The app icon: "IT" under a magnifying glass.
const LOGO = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#1f3a5f"/><path d="M15.2 15.2l4.6 4.6" stroke="#fff4c2" stroke-width="2.6" stroke-linecap="round"/><circle cx="10.6" cy="10.6" r="6.3" fill="#1f3a5f" stroke="#fff4c2" stroke-width="1.5"/><text x="10.6" y="13.4" text-anchor="middle" font-family="Futura, 'Avenir Next', 'Segoe UI', sans-serif" font-weight="800" font-size="7.6" fill="#f0be3c">IT</text></svg>`;

function render() {
  $("#app")!.innerHTML = `
  <div class="shell">
    <header class="top">
      <div class="brand">${LOGO}AssessIT</div>
      <div class="title" id="doc-title"></div>
      <span id="score-pill"></span>
      <button class="btn small" data-action="new">New</button>
      <button class="btn small" data-action="open">Open…</button>
      <button class="btn small" data-action="save">Save…</button>
    </header>
    <nav id="nav"></nav>
    <main><div class="page" id="page"></div></main>
  </div>`;
  renderNav();
  renderPage();
  refreshHeader();
}

function bubble(key: string, kind: BubbleKind, text: string): string {
  // "pop" when an item flips state, e.g. TODO -> OK.
  const prev = S.bubbles[key];
  S.bubbles[key] = kind + text;
  const pop = prev !== undefined && prev !== kind + text ? " pop" : "";
  return `<span class="bubble ${kind}${pop}">${esc(text)}</span>`;
}

function renderNav() {
  const st = navStatus(policy(), S.a, S.settings.submit);
  const item = (t: Tab, label: string, b: Bubble) =>
    `<button class="${S.tab === t || (t === "settings" && S.tab === "scoring") ? "active" : ""}" data-tab="${t}"><span>${label}</span>${bubble(t, ...b)}</button>`;
  const subs = SECTIONS.filter((sec) => policy().factors.some((f) => f.section === sec && f.enabled))
    .map((sec) => `<button class="sub" data-section="${sec}"><span>${SECTION_LABEL[sec]}</span>${bubble(`sec-${sec}`, ...sectionStatus(policy(), S.a, sec))}</button>`)
    .join("");
  $("#nav")!.innerHTML =
    item("request", "1. Request", st.request) +
    item("questions", "2. Questionnaire", st.questions) +
    `<div class="subs">${subs}</div>` +
    item("report", "3. Report", st.report) +
    item("settings", "Settings", st.settings) +
    `<div class="navsep">Tools</div>` +
    item("vuln", "Vulnerability triage", vulnBubble()) +
    `<div class="spacer"></div><div class="foot">${esc(policy().name)} v${esc(policy().version)}<br>${esc(configLabel())}
      <div class="verrow"><button class="verlink" data-url="${releaseUrl(APP_VERSION)}" title="Release notes for v${APP_VERSION} on GitHub">v${APP_VERSION} ↗</button>${updateBadge()}</div></div>`;
}

/** The dot next to the version: green = latest, yellow = newer release (click to install), grey = couldn't check. */
function updateBadge(): string {
  const u = S.update;
  if (u.kind === "available") {
    const v = esc(u.latest.replace(/^v/, ""));
    if (u.failed)
      return `<button class="upd warn" data-action="install-update" title="${esc(u.failed)}. Click to try again."><span class="udot"></span>Update failed. Retry</button>` +
        `<button class="upd" data-url="${releaseUrl(u.latest)}" title="Download v${v} from GitHub instead">Download ↗</button>`;
    return `<button class="upd warn" data-action="install-update" title="Download v${v}, install it and restart AssessIT"><span class="udot"></span>Update to v${v}</button>`;
  }
  if (u.kind === "installing")
    return `<span class="upd warn"><span class="udot"></span>${u.pct === null ? "Downloading…" : u.pct >= 100 ? "Installing…" : `Downloading ${u.pct}%`}</span>`;
  if (u.kind === "latest") return `<button class="upd ok" data-action="check-update" title="You're on the latest release. Click to check again."><span class="udot"></span>Up to date</button>`;
  if (u.kind === "checking") return `<span class="upd"><span class="udot"></span>Checking…</span>`;
  return `<button class="upd" data-action="check-update" title="${esc(u.message)}. Click to try again."><span class="udot"></span>Can't check</button>`;
}

/** The update found by the last check, kept so "Update" can install it without asking GitHub again. */
let pendingUpdate: Update | null = null;

async function checkForUpdate() {
  S.update = { kind: "checking" };
  renderNav();
  try {
    pendingUpdate = await check({ timeout: 15000 });
    S.update = pendingUpdate ? { kind: "available", latest: pendingUpdate.version } : { kind: "latest" };
  } catch (e) {
    pendingUpdate = null;
    S.update = { kind: "error", message: errText(e) };
  }
  renderNav();
}

/** Downloads the update (the plugin refuses anything not signed with our key), installs it and restarts. */
async function installUpdate() {
  const u = pendingUpdate;
  if (!u || S.update.kind !== "available") return;
  const go = await ask(
    `Install AssessIT ${u.version} and restart?\n\nRestarting closes this assessment, so export or submit anything you want to keep first.`,
    { title: "Update AssessIT", kind: "info", okLabel: "Install & restart", cancelLabel: "Not now" },
  );
  if (!go) return;
  let received = 0;
  let total = 0;
  S.update = { kind: "installing", latest: u.version, pct: null };
  renderNav();
  try {
    await u.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") received += ev.data.chunkLength;
      else if (ev.event === "Finished") received = total;
      const pct = percent(received, total);
      if (S.update.kind === "installing" && pct !== S.update.pct) {
        S.update = { kind: "installing", latest: u.version, pct };
        renderNav();
      }
    });
    await relaunch();
  } catch (e) {
    S.update = { kind: "available", latest: u.version, failed: errText(e) };
    renderNav();
  }
}

// ---------------- "i" breakdown popover ----------------

/** The small "i": hover, click or focus it to see where the score comes from. */
const infoButton = () => `<button type="button" class="info" aria-label="How is this score calculated?" aria-expanded="false">i</button>`;

function limitBlock(b: NonNullable<ReturnType<typeof scoreBreakdown>>): string {
  const l = b.limit;
  if (!l) return "";
  return `<dl class="ilimit">
      <dt>Approval limit</dt><dd>${esc(l.limit)} <span class="muted">set by your policy</span></dd>
      <dt>This vendor's score</dt><dd>${esc(b.score)} <span class="muted">(${esc(b.beforeMitigation)} before mitigations)</span></dd>
      <dt>${esc(l.deltaLabel)}</dt><dd class="z-${l.zone}"><b>${esc(l.deltaAmount)}</b></dd>
    </dl>
    <div class="ibar2" role="img" aria-label="${l.percent}% of the approval limit"><i class="z-${l.zone}" style="width:${Math.round(l.fillTo * 100)}%"></i><u style="left:${Math.round(l.markAt * 100)}%"></u></div>
    <div class="ibar2-note"><span class="z-${l.zone}"><b>${l.percent}%</b> of the limit</span><span class="muted">100% = the limit</span></div>
    <div class="idetail">${esc(l.note)}</div>`;
}

function breakdownHtml(): string {
  const r = result();
  const b = scoreBreakdown(r, policy());
  if (!b)
    return `<h4>How the score works</h4><p class="muted">Answer every required question to see it. ${r.requiredUnanswered.length} left.</p>`;
  const rows = b.parts
    .map(
      (x) => `<div class="irow"><div class="ihead"><span>${esc(x.label)}</span><b>${esc(x.value)}</b></div>
        <div class="ibar" aria-hidden="true"><i class="${x.key === "mitigation" ? "good" : ""}" style="width:${Math.round(x.fill * 100)}%"></i></div>
        <div class="idetail">${esc(x.detail)}</div></div>`,
    )
    .join("");
  return `<h4>Where the score comes from</h4>
    ${rows}
    <div class="iresult"><div class="iterms">${b.terms.map((t, i) => `${i ? `<span class="ix">×</span>` : ""}<div class="iterm"><b>${esc(t.value)}</b><small>${esc(t.label)}</small></div>`).join("")}<span class="ix">=</span><div class="iterm"><b>${esc(b.score)}</b><small>Score</small></div></div></div>
    ${limitBlock(b)}
    <p class="muted ifoot">The Report tab shows every answer behind these.</p>`;
}

let infoPop: HTMLDivElement | null = null;
let pinnedInfo: HTMLElement | null = null;
let infoHideTimer: number | undefined;

function showInfo(btn: HTMLElement) {
  window.clearTimeout(infoHideTimer);
  if (!infoPop) {
    infoPop = document.createElement("div");
    infoPop.className = "infopop";
    infoPop.setAttribute("role", "dialog");
    infoPop.addEventListener("mouseenter", () => window.clearTimeout(infoHideTimer));
    infoPop.addEventListener("mouseleave", () => !pinnedInfo && scheduleHideInfo());
    document.body.appendChild(infoPop);
  }
  infoPop.innerHTML = breakdownHtml();
  infoPop.hidden = false;
  document.querySelectorAll(".info[aria-expanded=true]").forEach((el) => el.setAttribute("aria-expanded", "false"));
  btn.setAttribute("aria-expanded", "true");
  const r = btn.getBoundingClientRect();
  const w = Math.min(340, window.innerWidth - 16);
  infoPop.style.width = `${w}px`;
  infoPop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  const below = r.bottom + 8;
  infoPop.style.top = `${below}px`;
  // Not enough room underneath: open upwards.
  if (below + infoPop.offsetHeight > window.innerHeight - 8) infoPop.style.top = `${Math.max(8, r.top - 8 - infoPop.offsetHeight)}px`;
}

function hideInfo() {
  window.clearTimeout(infoHideTimer);
  pinnedInfo = null;
  if (infoPop) infoPop.hidden = true;
  document.querySelectorAll(".info[aria-expanded=true]").forEach((el) => el.setAttribute("aria-expanded", "false"));
}
const scheduleHideInfo = () => {
  window.clearTimeout(infoHideTimer);
  infoHideTimer = window.setTimeout(hideInfo, 180);
};

document.addEventListener("mouseover", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".info");
  if (btn && !pinnedInfo) showInfo(btn);
});
document.addEventListener("mouseout", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".info");
  if (btn && !pinnedInfo) scheduleHideInfo();
});
document.addEventListener("focusin", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".info");
  if (btn && !pinnedInfo) showInfo(btn);
});
document.addEventListener("focusout", (e) => {
  if ((e.target as HTMLElement).closest(".info") && !pinnedInfo) scheduleHideInfo();
});
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>(".info");
  if (btn) {
    // Click pins it open (handy on touch screens); click again to close.
    if (pinnedInfo === btn) return hideInfo();
    pinnedInfo = btn;
    return showInfo(btn);
  }
  if (!t.closest(".infopop")) hideInfo();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideInfo();
});

function refreshHeader() {
  const r = result();
  const d = S.a.details;
  $("#doc-title")!.textContent = [d.product, d.vendor].filter(Boolean).join(" · ") || "New assessment";
  const tone = decisionTone(r.finalDecision);
  // The app shows a percentage of the approval limit, never raw points; the numbers are one hover away.
  const score = r.finalDecision === "Incomplete" ? `${r.requiredUnanswered.length} required left` : r.meter ? `${r.meter.percent}%` : r.band.name;
  $("#score-pill")!.innerHTML = `<span class="pill ${tone}">${esc(r.finalDecision)} <span style="font-weight:400">${esc(score)}${r.meter ? " of limit" : ""}</span></span>${infoButton()}`;
  if (pinnedInfo && !pinnedInfo.isConnected) hideInfo();
}

let renderedTab: Tab | null = null;

function renderPage() {
  hideInfo(); // the "i" buttons are about to be replaced
  const page = $("#page")!;
  if (S.tab === "request") page.innerHTML = requestPage();
  if (S.tab === "questions") page.innerHTML = questionsPage();
  if (S.tab === "report") page.innerHTML = reportPage();
  if (S.tab === "settings") page.innerHTML = settingsPage();
  if (S.tab === "scoring") page.innerHTML = scoringPage();
  if (S.tab === "vuln") page.innerHTML = vulnPage();
  // Re-rendering the same tab (status changes, filters) keeps the reader's place.
  if (renderedTab !== S.tab) $("main")!.scrollTop = 0;
  renderedTab = S.tab;
}

/** Called after any answer change: update everything derived without touching inputs being typed in. */
function refreshDerived() {
  refreshHeader();
  renderNav();
  if (S.tab === "questions") {
    const c = $("#ai-count");
    if (c) c.textContent = String(aiCount());
    for (const sec of ["Likelihood", "Impact", "Preference", "Mitigation"] as Section[]) {
      const el = $(`#sec-total-${sec}`);
      if (el) el.innerHTML = sectionTotal(sec);
    }
  }
  if (S.tab === "report") {
    $("#report-body")!.innerHTML = reportBody();
    const sc = $("#send-card");
    if (sc) sc.innerHTML = sendCard();
  }
}

// ---------------- 1. Request ----------------

const DETAIL_FIELDS: [keyof Details, string, string, boolean?][] = [
  ["vendor", "Vendor name", "Note the parent company if different."],
  ["product", "Software / product name(s)", "e.g., ExampleApp Enterprise"],
  ["plan", "Plan / tier being purchased", "Security features often differ by tier (SSO, retention)."],
  ["requestingTeam", "Requesting team", "Used in the draft message."],
  ["businessOwner", "Business owner", "Person accountable for the tool after approval."],
  ["assessmentDate", "Assessment date", "Drives the re-review date."],
  ["assessors", "Your name", "Printed on the report and sent with your submission. If more than one person is doing the evaluation, list everyone."],
  ["intendedUse", "Intended use", "What it will do and what data it will touch. Claude uses this to judge the internal questions.", true],
];

function requestPage(): string {
  const d = S.a.details;
  const fields = DETAIL_FIELDS.map(([k, label, hint, wide]) => {
    const input =
      k === "intendedUse"
        ? `<textarea data-detail="${k}" rows="3">${esc(d[k])}</textarea>`
        : `<input ${k === "assessmentDate" ? 'type="date"' : 'type="text"'} data-detail="${k}" value="${esc(d[k])}">`;
    const req = REQUIRED_DETAILS.some(([r]) => r === k);
    const empty = req && !String(d[k] ?? "").trim();
    return `<label class="f ${wide ? "full" : ""}${empty ? " missing" : ""}" ${req ? `data-required="${k}"` : ""}><span>${label}${req ? ' <span class="req-mark" title="Required">*</span>' : ""}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ""}</label>`;
  }).join("");
  return `
    <div><h1>What's being requested?</h1><p class="lede">Fill in the request, then let Claude research the vendor and pre-fill the questionnaire. You can change anything it finds.</p></div>
    <div class="card"><div class="grid2">${fields}</div></div>
    <div class="card" id="research-card">${researchCard()}</div>
    <div class="card"><label class="f">Resources consulted<textarea data-detail="resources" rows="3">${esc(d.resources)}</textarea><small>Trust center, DPA, SOC 2 report, rating tool, news searches… Claude fills this in if blank.</small></label></div>
    <div class="row"><button class="btn primary" data-tab="questions">Continue to questionnaire →</button></div>`;
}

function claudeStatusHtml(): string {
  const c = S.claude;
  if (!c) return `<div class="status"><div class="spinner"></div>Looking for Claude Code…</div>`;
  if (c.logged_in)
    return `<div class="status ok"><span class="dot"></span>Claude Code is ready${c.account ? ` (${esc(c.account)})` : ""}.</div>`;
  const why = c.path
    ? "Claude Code is installed but not signed in."
    : "Claude Code isn't installed. It's free to install; research uses your existing Claude subscription, no API keys.";
  return `<div class="status bad"><span class="dot"></span><div style="flex:1">${esc(why)}</div>
    <button class="btn small" data-action="claude-setup">${c.path ? "Sign in…" : "Install & sign in…"}</button>
    <button class="btn small" data-action="claude-check">Check again</button></div>`;
}

function researchCard(): string {
  const R = S.research;
  const ready = !!S.claude?.logged_in;
  const btn = R.running
    ? `<button class="btn" data-action="research-cancel">Cancel</button>`
    : `<button class="btn primary" data-action="research" ${ready ? "" : "disabled"}>Research &amp; pre-fill with Claude</button>`;
  const log = R.log
    .slice()
    .reverse()
    .map((l) => `<div><b>${esc({ search: "Search", fetch: "Read", note: "Note", status: "Status", error: "Error" }[l.kind] ?? l.kind)}</b><span>${esc(l.text)}</span></div>`)
    .join("");
  return `
    <div class="section-head"><h2>AI research</h2><span class="muted">Usually 1–5 minutes</span></div>
    ${claudeStatusHtml()}
    <p class="muted" style="margin:10px 0">Claude searches the vendor's trust center, privacy terms, breach history and news, then proposes an answer with notes and sources for each question. Internal questions (like data classification) are inferred from the intended use and flagged for you to confirm. Answers you've typed are never overwritten.</p>
    <div class="row">${btn}${R.running ? `<div class="spinner"></div><span class="muted">${R.log.length} steps so far…</span>` : ""}
      ${R.done ? `<span class="muted">${esc(R.done)}</span> <button class="btn small" data-tab="questions">Review answers →</button>` : ""}</div>
    ${R.error ? `<p class="err">${esc(R.error)}</p>` : ""}
    ${log ? `<div class="log" id="research-log">${log}</div>` : ""}
    ${manualPanel(ready)}`;
}

const OTHER_AIS: [string, string][] = [
  ["ChatGPT", "https://chatgpt.com/"],
  ["Gemini", "https://gemini.google.com/app"],
  ["Copilot", "https://copilot.microsoft.com/"],
];

function manualPanel(claudeReady: boolean): string {
  const M = S.manual;
  const links = OTHER_AIS.map(([n, u]) => `<button class="btn small" data-url="${u}">Open ${n}</button>`).join("");
  return `<details data-manual ${M.open || !claudeReady ? "open" : ""} style="margin-top:14px">
    <summary>Use another AI instead (ChatGPT, Gemini, Copilot…)</summary>
    <p class="muted">Works with any AI chat that can search the web, including desktop apps. No setup.</p>
    <ol style="padding-left:20px;display:flex;flex-direction:column;gap:12px">
      <li><b>Copy the research prompt</b> and paste it into a new chat.
        <div class="row" style="margin-top:6px"><button class="btn small primary" data-action="copy-prompt">Copy prompt</button>${links}</div></li>
      <li><b>Paste the AI's whole reply here</b>, then import. Answers you've typed are kept.
        <textarea data-paste rows="5" style="margin-top:6px" placeholder="Paste the full reply, including the json block">${esc(M.paste)}</textarea>
        <div class="row" style="margin-top:6px"><button class="btn small primary" data-action="manual-import">Import answers</button></div></li>
    </ol></details>`;
}

function refreshResearchCard() {
  const el = $("#research-card");
  if (el) el.innerHTML = researchCard();
}

async function checkClaude() {
  S.claude = null;
  refreshResearchCard();
  try {
    S.claude = await invoke<ClaudeStatus>("claude_status");
  } catch (e) {
    S.claude = { path: null, version: null, logged_in: false, account: null, error: errText(e) };
  }
  refreshResearchCard();
  if (S.tab === "settings") renderPage();
}

async function runResearch() {
  const d = S.a.details;
  if (!d.vendor.trim() && !d.product.trim()) return toast("Enter the vendor or product name first.");
  const R = S.research;
  Object.assign(R, { running: true, log: [{ kind: "status", text: "Starting Claude Code…" }], error: "", done: "" });
  refreshResearchCard();
  const unlisten = await listen<{ kind: string; text: string }>("research-progress", (e) => {
    R.log.push(e.payload);
    refreshResearchCard();
  });
  try {
    const out = await invoke<ResearchOutput>("research_start", {
      prompt: researchPrompt(policy(), d, new Date().toLocaleDateString("en-CA")),
      schema: researchSchema(policy()),
      model: S.settings.model,
    });
    const { filled, skipped } = mergeResearch(policy(), S.a, out);
    persist();
    R.done = `Pre-filled ${filled} question${filled === 1 ? "" : "s"}${skipped ? `, kept ${skipped} you'd already answered` : ""}.`;
    R.log.push({ kind: "status", text: R.done });
    toast(R.done);
  } catch (e) {
    R.error = errText(e);
  } finally {
    unlisten();
    R.running = false;
    refreshResearchCard();
    refreshDerived();
  }
}

// ---------------- 2. Questionnaire ----------------

/** How far through a section you are. The points it adds are in the hover, not on the page. */
function sectionTotal(sec: Section): string {
  const r = result();
  const fs = policy().factors.filter((f) => f.section === sec && f.enabled && !isIgnored(f, S.a.answers[f.id]));
  const done = fs.filter((f) => S.a.answers[f.id]?.response).length;
  const detail =
    sec === "Preference"
      ? `Preference multiplier ×${r.preference.toFixed(1)}`
      : sec === "Mitigation"
        ? `Credit ${pct(-r.mitigationApplied)} (cap ${Math.round(policy().maxMitigationCredit * 100)}%)`
        : sec === "Likelihood"
          ? `${r.likelihood} of ${r.likelihoodMax} points`
          : `${r.impact} of ${r.impactMax} points`;
  return `<span title="${esc(detail)}">${done} of ${fs.length} answered</span>`;
}

const SECTION_BLURB: Record<Section, string> = {
  Likelihood: "Signs an incident is more likely.",
  Impact: "How bad an incident would be for us.",
  Preference:
    "Things many organizations care about where NIST and CISA don't yet say how much they should count. These are value choices, so each concern scales the whole score instead of adding points.",
  Mitigation: "Controls we have in place. They cut the final score, and become conditions of approval.",
};

function visible(f: Factor): boolean {
  const ans = S.a.answers[f.id];
  if (S.filter === "review") return ans?.origin === "ai";
  if (S.filter === "unanswered") return !ans?.response && !ans?.ignored;
  return true;
}

function questionsPage(): string {
  const p = policy();
  const aiN = aiCount();
  const sections = SECTIONS
    .map((sec) => {
      // Ignorable (pure value-choice) questions go last in their section so they read as a group.
      const fs = p.factors.filter((f) => f.section === sec && f.enabled && visible(f)).sort((x, y) => Number(!!x.ignorable) - Number(!!y.ignorable));
      if (!fs.length) return "";
      return `<div class="card" id="sec-${sec}"><div class="section-head"><h2>${sec === "Preference" ? "Organization preferences" : sec}</h2><span class="muted" id="sec-total-${sec}">${sectionTotal(sec)}</span></div>
        <p class="muted" style="margin:-6px 0 6px">${SECTION_BLURB[sec]}</p>
        ${fs.map(qRow).join("")}</div>`;
    })
    .join("");
  const chip = (f: Filter, label: string) => `<button class="chip ${S.filter === f ? "on" : ""}" data-filter="${f}">${label}</button>`;
  return `
    <div class="section-head"><div><h1>Questionnaire</h1><p class="lede">Pick an answer for every required question. Add notes and sources as evidence; the report quotes them. Not sure about one? The line under it says what to do: usually pick the cautious answer, since unknowns count against approval and a tool never scores better than the evidence supports.</p></div></div>
    <div class="row"><div class="filters">${chip("all", "All")}${chip("review", `From AI (<span id="ai-count">${aiN}</span>)`)}${chip("unanswered", "Unanswered")}</div></div>
    ${sections || `<div class="card muted">Nothing matches this filter.</div>`}
    <div class="row"><button class="btn primary" data-tab="report">See the report →</button></div>`;
}

/** Answers still coming from AI research (ignores AI rows that came back empty). */
const aiCount = () => aiAnswerCount(S.a);

function badges(f: Factor): string {
  const ans = S.a.answers[f.id];
  let b = f.required ? `<span class="badge req">Required</span>` : "";
  if (ans?.origin === "ai") {
    b += `<span class="badge ai" title="Proposed by AI research. Check the notes and sources.">AI · ${esc(ans.confidence ?? "?")} confidence</span>`;
    if (ans.needsConfirmation) b += `<span class="badge confirm" title="Only your organization can confirm this.">Confirm internally</span>`;
  } else if (ans && (ans.response || ans.notes) && ans.confidence) {
    b += `<span class="badge edited">Edited by you</span>`;
  }
  return b;
}

function qRow(f: Factor): string {
  const ans = S.a.answers[f.id];
  const resp = ans?.response ?? "";
  if (isIgnored(f, ans))
    return `<div class="q ignored" id="q-${esc(f.id)}">
    <div class="id">${esc(f.id)}</div>
    <div><span class="text">${esc(f.question)}</span><span id="badges-${esc(f.id)}"><span class="badge edited">Ignored</span></span>
      <div class="guide">Not scored, not required. Your report will say you ignored it.</div>
      ${whyItMatters(f)}</div>
    <div class="body"><div class="opts"><button class="opt on" data-ignore="${esc(f.id)}" data-val="" title="Score this question again">Ignored · include it again</button></div></div></div>`;
  const opts = f.options
    .map((o) => {
      const tone = optionTone(f, o.label);
      return `<button class="opt ${resp === o.label ? "on" : ""}" data-tone="${tone}" data-opt="${esc(f.id)}" data-val="${esc(o.label)}" title="${esc(fmtPts(o.points, f.section))} · ${toneWords(tone)}">${esc(o.label)}</button>`;
    })
    .join("");
  return `<div class="q ${f.required && !resp ? "unanswered-req" : ""}" id="q-${esc(f.id)}">
    <div class="id">${esc(f.id)}</div>
    <div><span class="text">${esc(f.question)}</span><span id="badges-${esc(f.id)}">${badges(f)}</span>
      ${f.guidance ? `<div class="guide">${esc(f.guidance)}</div>` : ""}
      ${lookWhere(f)}
      ${optionMeanings(f)}
      ${unsureHint(f)}
      ${basisChips(f) ? `<div class="refs">${basisChips(f)}</div>` : ""}
      ${whyItMatters(f)}</div>
    <div class="body">
      <div class="opts">${opts}${f.ignorable ? `<button class="opt" data-ignore="${esc(f.id)}" data-val="1" title="Skip this question. It won't be scored or required.">Ignore</button>` : ""}${resp ? `<button class="btn small" data-opt="${esc(f.id)}" data-val="">Clear</button>` : ""}</div>
      <div class="ev">
        <textarea placeholder="Notes / evidence" data-ans="${esc(f.id)}" data-field="notes">${esc(ans?.notes ?? "")}</textarea>
        <textarea placeholder="Source URL(s)" data-ans="${esc(f.id)}" data-field="sources">${esc(ans?.sources ?? "")}</textarea>
        <div class="srclinks" id="src-${esc(f.id)}">${sourceLinks(ans?.sources ?? "")}</div>
      </div>
    </div></div>`;
}

/** "Not sure?" line under a question: the answer that counts most against approval, and why. */
function unsureHint(f: Factor): string {
  if (f.unsure) return `<div class="unsure">${esc(f.unsure)}</div>`;
  const pick = cautiousChoice(f);
  if (!pick) return "";
  const unknown = /^(unknown|not rated)$/i.test(pick.trim());
  const lead = f.research === "internal" ? "Not sure? Ask the requesting team or business owner. If you can't, choose" : "Not sure? Check the places above first. If you still can't tell, choose";
  // Neither direction gets a free pass: a gap is never scored as a clean bill of health, and never as an accusation.
  const why = unknown
    ? "it counts partway against approval, so a gap is never scored as a clean bill of health"
    : f.section === "Mitigation"
      ? "credit is only given for what you can confirm"
      : "credit is only given for what you can show, so it counts against approval until someone confirms it";
  return `<div class="unsure">${lead} <b>${esc(pick)}</b>: ${why}.</div>`;
}

/** Common places to look, as examples: the same list the AI gets. */
function lookWhere(f: Factor): string {
  return f.lookWhere ? `<div class="where"><b>Where to look:</b> ${esc(f.lookWhere)}.</div>` : "";
}

/** What each answer means, in plain words, so a negatively worded question can't be answered backwards. */
function optionMeanings(f: Factor): string {
  const rows = f.options.filter((o) => o.hint);
  if (!rows.length) return "";
  return `<div class="means">${rows.map((o) => `<div><b>${esc(o.label)}</b> = ${esc(o.hint)}</div>`).join("")}</div>`;
}

/** Clickable links for the https URLs typed or found in a "Source URL(s)" box (opened in the browser). */
function sourceLinks(text: string): string {
  return extractUrls(text)
    .map((u) => `<button class="srclink" data-url="${esc(u)}" title="${esc(u)}">${esc(linkLabel(u))} ↗</button>`)
    .join("");
}

const refLabel = (r: Reference) => `${r.source}${r.id ? ` ${r.id}` : ""}`;

/** Small tag on the question line: only org preferences get one. Citations live under "Why it matters". */
function basisChips(f: Factor): string {
  return f.basis === "preference" ? `<span class="ref pref" title="A values choice, not published guidance. Each concern scales the whole score.">Org preference</span>` : "";
}

/** Collapsed by default: the rationale, then the NIST / CISA / OWASP sources behind it. */
function whyItMatters(f: Factor): string {
  const links = f.references
    .map((r) => `<button class="ref" data-url="${esc(r.url)}" title="${esc(r.title)}">${esc(refLabel(r))}</button>`)
    .join("");
  if (!f.justification && !links) return "";
  return `<details class="why"><summary>Why it matters</summary>
    ${f.justification ? `<p>${esc(f.justification)}</p>` : ""}
    ${f.ignorable && f.ignoreNote ? `<p><b>Why you can ignore this:</b> ${esc(f.ignoreNote)}</p>` : ""}
    ${links ? `<div class="refs"><span class="muted">${f.basis === "preference" ? "Related guidance:" : "Sources:"}</span>${links}</div>` : ""}</details>`;
}

function answer(id: string): Answer {
  return (S.a.answers[id] ??= { response: "", notes: "", sources: "", origin: "user" });
}

/** Redraws one question, keeping "Why it matters" open if the reader had it open. */
function rerenderRow(id: string) {
  const f = policy().factors.find((x) => x.id === id)!;
  const row = $(`#q-${id}`);
  const open = !!row?.querySelector("details.why[open]");
  if (row && visible(f)) {
    row.outerHTML = qRow(f);
    if (open) $(`#q-${id} details.why`)?.setAttribute("open", "");
  } else row?.remove();
}

/** Any edit by the person makes the answer theirs. */
function touch(id: string) {
  const ans = answer(id);
  if (ans.origin === "ai") {
    ans.origin = "user";
    ans.needsConfirmation = false;
    const b = $(`#badges-${id}`);
    const f = policy().factors.find((x) => x.id === id);
    if (b && f) b.innerHTML = badges(f);
  }
}

// ---------------- 3. Report ----------------

function reportPage(): string {
  const d = S.a.details;
  const opt = (v: string) => `<option ${d.override === v ? "selected" : ""} value="${v}">${v || "Use calculated decision"}</option>`;
  return `
    <div><h1>Risk report</h1><p class="lede">${esc(d.product || "[Software]")} · ${esc(d.vendor || "[Vendor]")} · assessed ${esc(formatDate(d.assessmentDate))} by ${esc(d.assessors || "[assessor]")}</p></div>
    <div id="report-body" class="page" style="max-width:none">${reportBody()}</div>
    ${
      rules().allowOverride
        ? `<div class="card"><h2>Decision override (optional)</h2>
      <div class="grid2">
        <label class="f">Override<select data-detail="override">${["", "Approved", "Approved with Conditions", "Denied"].map(opt).join("")}</select><small>Leave as calculated unless you have a documented reason.</small></label>
        <label class="f">Risk accepted by<input type="text" data-detail="riskAcceptedBy" value="${esc(d.riskAcceptedBy)}"><small>Name / title of the leader formally accepting residual risk.</small></label>
        <label class="f full">Override justification<textarea data-detail="overrideJustification">${esc(d.overrideJustification)}</textarea><small>Required if you override.</small></label>
      </div></div>`
        : `<div class="card"><h2>Risk acceptance</h2>
      <p class="muted" style="margin-top:0">🔒 Your organization doesn't allow overriding the calculated decision here. Reviewers can still accept the risk when they decide.</p>
      <label class="f">Risk accepted by<input type="text" data-detail="riskAcceptedBy" value="${esc(d.riskAcceptedBy)}"><small>Name / title of the leader formally accepting residual risk.</small></label></div>`
    }
    <div class="card" id="send-card">${sendCard()}</div>`;
}

/** A bar from 0% to past the approval limit: green inside it, yellow where mitigations could still help, red beyond. */
function meterHtml(r: Result): string {
  const m = r.meter;
  if (!m) return "";
  const max = Math.max(m.yellowUntilPercent * 1.25, m.percent * 1.1, 130);
  const w = (from: number, to: number) => `${(((to - from) / max) * 100).toFixed(2)}%`;
  const at = `${Math.min(100, (m.percent / max) * 100).toFixed(2)}%`;
  return `<div class="meter" role="img" aria-label="Risk score is ${m.percent}% of the approval limit. ${esc(ZONE_LABEL[m.zone])}.">
    <div class="track"><span class="seg green" style="width:${w(0, 100)}"></span><span class="seg yellow" style="width:${w(100, m.yellowUntilPercent)}"></span><span class="seg red" style="flex:1"></span>
      <span class="mark z-${m.zone}" style="left:${at}"></span></div>
    <div class="meter-note z-${m.zone}"><b>${m.percent}%</b> of the approval limit · ${esc(ZONE_LABEL[m.zone])}</div></div>`;
}

function sendCard(): string {
  const flags = reviewFlags(result(), S.a, policy());
  const yolo = flags.length > 0;
  const blocked = yolo && !rules().allowYolo;
  const sent = S.a.submitted;
  const changed = changedFromAi(S.a);
  const aiN = aiCount();
  return `<h2>Send it</h2>
    <p class="muted" style="margin-top:0">${submitBlurb()}</p>
    ${yolo ? `<div class="status warn" style="margin-bottom:12px"><span class="dot"></span><div>${blocked ? "🔒 Your organization requires these to be resolved before submitting" : "Not quite ready"}: ${esc(flags.join(" "))}</div></div>` : ""}
    ${changed.length ? `<p class="muted">You changed ${changed.length} answer${changed.length === 1 ? "" : "s"} from what AI research found (${esc(changed.map((c) => c.id).join(", "))}). Approvers will see the AI's original answer next to yours.</p>` : ""}
    ${aiN ? `<p class="muted attest-note">${aiN} answer${aiN === 1 ? "" : "s"} came from AI research. Give ${aiN === 1 ? "it" : "them"} a look before you send this: you're the one vouching for the result.</p>
    <label class="attest ${S.a.aiAttestation ? "on" : ""}"><input type="checkbox" data-action="toggle-attest" ${S.a.aiAttestation ? "checked" : ""}><span>I agree with the AI's research</span></label>` : ""}
    ${sent ? `<div class="status ok" style="margin-bottom:12px"><span class="dot"></span><div>Sent for approval ${esc(new Date(sent.at).toLocaleString())}${sent.flagged ? " (YOLO, with open issues flagged)" : ""}.</div></div>` : ""}
    <div class="row">
      <button class="btn go ${yolo && !blocked ? "yolo" : ""}" data-action="submit" ${S.submitting || blocked ? "disabled" : ""}>${S.submitting ? "Sending…" : blocked ? "Submit for Approval" : yolo ? "Submit YOLO 🤠" : sent ? "Submit again" : "Submit for Approval"}</button>
      <button class="btn go" data-action="export-pdf">Export to PDF</button>
      <span style="flex:1"></span>
      <button class="btn small" data-action="export-xlsx">Excel…</button>
      <button class="btn small" data-action="copy-msg">Copy draft message</button>
    </div>`;
}

function submitBlurb(): string {
  const s = S.settings.submit;
  if (s.method === "webhook") return "Sends the results to your organization's approval workflow (Power Automate / webhook).";
  if (s.method === "sharepoint") return `Adds an item to the SharePoint list “${esc(s.listName)}” as ${esc(S.graphAccount ?? "you (sign-in required)")}.`;
  return "No approval destination is set up yet. An admin can configure one in Settings. You can still export the report.";
}

function heatMap(r: Result): string {
  const p = policy();
  const k = r.preference * (1 - r.mitigationApplied);
  const L = Math.max(1, Math.min(12, Math.round(r.likelihood)));
  const I = Math.max(1, Math.min(12, Math.round(r.impact)));
  let cells = "";
  for (let i = 12; i >= 1; i--) {
    cells += `<div class="ax">${i === 12 ? "high" : i === 1 ? "low" : ""}</div>`;
    for (let l = 1; l <= 12; l++) {
      const v = l * i * k;
      const idx = p.bands.indexOf(bandFor(p.bands, "scoreMin", v));
      const color = `var(--band-${Math.min(4, Math.round((idx / Math.max(1, p.bands.length - 1)) * 4))})`;
      const me = l === L && i === I && r.finalDecision !== "Incomplete";
      cells += `<div class="${me ? "me" : ""}" style="background:${color}" title="Likelihood ${l} × Impact ${i} = ${v.toFixed(1)}"></div>`;
    }
  }
  cells += `<div class="ax"></div>` + Array.from({ length: 12 }, (_, j) => `<div class="ax">${j === 0 ? "low" : j === 11 ? "high" : ""}</div>`).join("");
  const legend = p.bands
    .map((b, idx) => `<span><i style="background:var(--band-${Math.min(4, Math.round((idx / Math.max(1, p.bands.length - 1)) * 4))})"></i>${esc(b.name)} → ${esc(b.decision)}</span>`)
    .join("");
  return `<div class="heat">${cells}</div><div class="muted" style="font-size:12px;margin-top:4px">Across: how likely an incident is. Up: how bad it would be. Colors include this assessment's preference concerns and mitigations. Outlined = this assessment. Hover a square for its numbers.</div><div class="legend">${legend}</div>`;
}

/** A score amount as a share of the approval limit, so the page speaks one language (percent). The points are in the hover. */
function shareOf(r: Result, x: number): string {
  const base = r.meter?.limit ?? Math.max(r.score, 1e-9);
  return `${Math.round((x / base) * 100)}%`;
}

function reportBody(): string {
  const p = policy();
  const r = result();
  const tone = decisionTone(r.finalDecision);
  const tile = (k: string, v: string, s: string, cls = "") => `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const drivers = r.drivers.length
    ? `<table><tr><th>#</th><th>Factor</th><th>Section</th><th>Answer</th><th>Would lower the score by</th><th>Evidence</th></tr>${r.drivers
        .map((x) => `<tr><td>${x.rank}</td><td>${esc(x.factor.factor)}</td><td>${x.factor.section}</td><td>${esc(x.response)}</td><td class="num" title="${x.scoreReduction.toFixed(1)} points">−${shareOf(r, x.scoreReduction)}</td><td>${esc(x.evidence)}</td></tr>`)
        .join("")}</table>`
    : `<p class="muted">No factors are adding to the score.</p>`;
  const mits = r.mitigations.length
    ? `<table><tr><th>Mitigation</th><th>Credit</th><th>Lowers the score by</th><th>Evidence</th></tr>${r.mitigations
        .map((x) => `<tr><td>${esc(x.factor.factor)}</td><td>${fmtPts(x.points, "Mitigation")}</td><td class="num" title="${x.scoreReduction.toFixed(1)} points">−${shareOf(r, x.scoreReduction)}</td><td>${esc(x.evidence)}</td></tr>`)
        .join("")}</table>${r.mitigationRaw > p.maxMitigationCredit ? `<p class="muted">Total credit capped at ${Math.round(p.maxMitigationCredit * 100)}% (raw ${Math.round(r.mitigationRaw * 100)}%).</p>` : ""}`
    : `<p class="muted">None credited.</p>`;
  const aiN = aiCount();
  return `
    <div class="banner ${tone}"><div class="d">${esc(r.finalDecision.toUpperCase())}${r.overridden ? " (OVERRIDE)" : ""}</div><div>${esc(summary(r, S.a, true))}</div></div>
    ${aiN ? `<div class="status"><span class="dot"></span><div style="flex:1">${aiN} answer${aiN === 1 ? "" : "s"} came from AI research. Look ${aiN === 1 ? "it" : "them"} over before you submit.</div><button class="btn small" data-action="review-ai">Review ${aiN === 1 ? "it" : "them"}</button></div>` : ""}
    ${meterHtml(r)}
    <div class="tiles">
      ${tile(`Risk vs. approval limit ${infoButton()}`, scoreHeadline(r), esc(scoreCaptionPlain(r)), r.meter ? `z-${r.meter.zone}` : "")}
      ${tile("Required answered", `${r.requiredCount - r.requiredUnanswered.length} / ${r.requiredCount}`, `+ ${r.optionalAnswered} optional answered`)}
      ${tile("Re-review by", esc(formatDate(r.reReviewDate) || "—"), `every ${r.reReviewMonths} months`)}
    </div>
    <div class="card"><h2>Biggest risk drivers</h2><p class="muted" style="margin-top:-6px">How far the final score would fall if this factor had its lowest-risk answer.</p>${drivers}</div>
    <div class="card"><h2>Mitigations credited</h2>${mits}</div>
    <div class="card"><h2>Hard stops &amp; path to approval</h2><div class="kv">
      <b>Hard stops</b><span>${esc(r.hardStops.join("; ") || "None triggered.")}</span>
      <b>Path to approval</b><span>${esc(pathToApproval(r, p.maxMitigationCredit, true))}</span></div></div>
    <div class="card"><h2>Heat map</h2>${heatMap(r)}</div>
    <div class="card"><h2>Draft outcome message</h2><pre class="msg">${esc(draftMessage(r, S.a, S.settings.org, true))}</pre></div>`;
}

// ---------------- Settings ----------------

function settingsPage(): string {
  const s = S.settings;
  const sub = s.submit;
  const c = S.claude;
  const lock = (path: string) => (isLocked(path) ? " disabled" : "");
  const lockNote = (path: string) => (isLocked(path) ? ` <span class="lock" title="Set by your organization's config">🔒 managed</span>` : "");
  const field = (path: string, label: string, value: string, hint = "", type = "text") =>
    `<label class="f">${label}${lockNote(path)}<input type="${type}" data-setting="${path}" value="${esc(value)}"${lock(path)}>${hint ? `<small>${hint}</small>` : ""}</label>`;
  const radio = (m: string, label: string, hint: string) =>
    `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0"><input type="radio" name="method" data-setting="submit.method" value="${m}" ${sub.method === m ? "checked" : ""}${lock("submit.method")}><span><b>${label}</b><br><small class="muted">${hint}</small></span></label>`;
  let graph = "";
  if (sub.method === "sharepoint") {
    const dev = S.device;
    graph = `
      <div class="grid2" style="margin-top:10px">
        ${field("submit.siteUrl", "SharePoint site URL", sub.siteUrl, "e.g., https://contoso.sharepoint.com/sites/ITRisk")}
        ${field("submit.listName", "List name", sub.listName)}
        ${field("submit.tenant", "Tenant ID or domain", sub.tenant, "e.g., contoso.onmicrosoft.com. Blank = any work account.")}
        ${field("submit.clientId", "Entra app (client) ID", sub.clientId, "Public client app with delegated Sites.ReadWrite.All. See docs/sharepoint-setup.md.")}
      </div>
      <div class="row" style="margin-top:10px">
        ${S.graphAccount !== null ? `<span class="status ok"><span class="dot"></span>Signed in as ${esc(S.graphAccount || "Microsoft 365 user")}</span><button class="btn small" data-action="graph-signout">Sign out</button>` : `<button class="btn" data-action="graph-signin">Sign in to Microsoft 365…</button>`}
      </div>
      ${dev ? `<div class="status" style="margin-top:10px;flex-wrap:wrap"><div style="flex:1">Enter this code on the Microsoft page that just opened:</div><span class="code">${esc(dev.user_code)}</span><button class="btn small" data-action="graph-open">Open page again</button><div class="spinner"></div></div>` : ""}
      <details style="margin-top:12px"><summary>List columns the app writes</summary>
        <p class="muted">Create these columns on the list (exact internal names). Title is built in. Status is a Choice column: ${STATUSES.join(", ")}. See docs/sharepoint-setup.md for the review columns, permissions and note rule.</p>
        <table><tr><th>Column</th><th>Type</th></tr>${SHAREPOINT_COLUMNS.map((x) => `<tr><td>${x.name}</td><td>${x.type}</td></tr>`).join("")}</table>
      </details>`;
  }

  return `
    <div><h1>Settings</h1><p class="lede">Usually set once by an admin and shared through an org config, so users never touch this page.</p></div>
    ${scoringCard()}
    <div class="card" id="config-card">${configCard()}</div>
    <div class="card"><h2>Organization</h2><div class="grid2">
      ${field("org.orgName", "Organization name", s.org.orgName, "Used in the draft outcome message.")}
      ${field("org.reviewTeam", "Review team name", s.org.reviewTeam, "Signs the draft outcome message.")}
      <div class="full">${field("org.policyLink", "Policy link or name", s.org.policyLink, "Quoted in messages so requesters know how risk acceptance works.")}</div>
    </div></div>
    <div class="card"><h2>AI research</h2>
      ${claudeStatusHtml()}
      ${c?.path ? `<p class="muted">Using <code>${esc(c.path)}</code>${c.version ? ` (${esc(c.version)})` : ""}.</p>` : ""}
      <label class="f" style="max-width:320px">Model${lockNote("model")}<select data-setting="model"${lock("model")}>
        ${[["sonnet", "Sonnet (faster, recommended)"], ["opus", "Opus (most thorough, slower)"], ["haiku", "Haiku (fastest)"]].map(([v, l]) => `<option value="${v}" ${s.model === v ? "selected" : ""}>${l}</option>`).join("")}
      </select></label>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="claude-check">Check again</button></div>
    </div>
    <div class="card"><h2>Approval destination</h2>
      ${radio("none", "None", "Export reports and send them by hand.")}
      ${radio("sharepoint", "SharePoint list (recommended)", "Adds the request to your SharePoint list as the signed-in user, so every submission is tied to a verified Microsoft 365 account. Your review group decides on the list, and SharePoint records who did what.")}
      ${radio("webhook", "Webhook", "POSTs to Power Automate or any HTTPS endpoint. No sign-in, so it can't prove who submitted.")}
      ${sub.method === "webhook" ? `<div style="margin-top:10px">${field("submit.webhookUrl", "Webhook URL", sub.webhookUrl, "Treat this URL like a password if the flow allows anonymous calls.", "url")}<div class="row" style="margin-top:8px"><button class="btn small" data-action="webhook-test">Send test</button></div></div>` : ""}
      ${graph}
    </div>
    <div class="card"><h2>Share these settings</h2><p class="muted" style="margin-top:0">Export everything on this page as an org config file. Host it anywhere HTTPS (SharePoint, an intranet, a GitHub repo), then point everyone's AssessIT at it. See “Rolling it out” in the README.</p>
      <div class="row"><button class="btn small" data-action="config-export">Export org config…</button><button class="btn small" data-action="config-import">Import a config file…</button></div></div>`;
}


// ---------------- Scoring: summary on Settings, editor on its own page ----------------

/** The weights as the org (or the built-in defaults) ship them, ignoring this person's own edits. */
const baselinePolicy = (): Policy => activePolicy(effectiveSettings({ ...S.user, policy: undefined }, S.remote.config));

const RESEARCH_NOTE = "These weights follow NIST CSF 2.0, the NIST AI RMF and CISA guidance, and each question shows its basis. They are not meant to be tuned to change the result for one vendor.";

function scoringCard(): string {
  const p = policy();
  const locked = isLocked("policy");
  return `<div class="card" id="scoring-card"><h2>Scoring</h2>
    <p class="muted" style="margin-top:0">${RESEARCH_NOTE} See SCORING.md.</p>
    <div class="row"><b>${esc(p.name)} v${esc(p.version)}</b><span class="muted">${policySourceLabel()}</span>${locked ? ` <span class="lock" title="Set by your organization's config">🔒 managed</span>` : ""}
      ${p.edits ? `<span class="tag warn">edited locally</span>` : ""}</div>
    <p class="muted" style="margin:6px 0 0">Threshold of acceptable risk: <b>${approvalLimit(p) ?? "none"}</b>${approvalLimit(p) !== approvalLimit(baselinePolicy()) ? ` (standard ${approvalLimit(baselinePolicy())})` : ""}. ${p.factors.filter((f) => f.enabled).length} questions on.</p>
    ${p.edits ? `<p class="muted">Changed ${esc(p.edits.at.slice(0, 10))}${p.edits.reason ? `: “${esc(p.edits.reason)}”` : ""} (${p.edits.changes.length} change${p.edits.changes.length === 1 ? "" : "s"}). Every report made with these weights says so.</p>` : ""}
    <div class="row" style="margin-top:8px">
      <button class="btn small" data-action="scoring-open">${locked ? "View scoring" : "✎ Edit scoring"}</button>
      ${locked ? "" : `<button class="btn small" data-action="policy-import">Import policy…</button>`}
      <button class="btn small" data-action="policy-export">Export policy…</button>
      ${S.user.policy && !locked ? `<button class="btn small" data-action="policy-reset">Back to ${S.remote.config?.policy ? "organization" : "standard"} weights</button>` : ""}
    </div></div>`;
}

/** A small "i" that explains a term on hover or keyboard focus (the text is in data-tip, shown by CSS). */
const tip = (text: string) => `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">i</span>`;
const HARD_STOP_TIP = "A dealbreaker. If this answer is chosen, the vendor is Denied no matter how low the score is, and the score can't be mitigated back under it. Leave it at “none” for questions that should only add risk.";

const UNIT: Record<Section, string> = { Likelihood: "pts", Impact: "pts", Preference: "× added", Mitigation: "% credit" };
const pointsShown = (sec: Section, v: number) => (Number.isFinite(v) ? String(Math.round((sec === "Mitigation" ? v * 100 : v) * 1000) / 1000) : "");
const SC_TABS: [ScTab, string][] = [["questions", "Questions"], ["thresholds", "Thresholds"]];
type ScTab = "questions" | "thresholds";

function scoringPage(): string {
  const sc = (S.sc ??= { draft: clonePolicy(policy()), reason: "", tab: "questions" });
  const d = sc.draft;
  const ro = isLocked("policy");
  const dis = ro ? " disabled" : "";
  const base = baselinePolicy();
  const num = (attrs: string, v: number | string) => `<input type="number" step="any" ${attrs} value="${esc(String(v))}"${dis}>`;
  const txt = (f: Factor, k: string, label: string, hint = "", rows = 2) =>
    `<label class="f">${label}${hint ? `<small>${hint}</small>` : ""}<textarea rows="${rows}" data-sc="text" data-f="${esc(f.id)}" data-k="${k}"${dis}>${esc(String((f as unknown as Record<string, string | undefined>)[k] ?? ""))}</textarea></label>`;

  const limit = approvalLimit(d) ?? 0;
  const top = Math.max(maxPossibleScore(d), 1);
  const pct = Math.min(100, Math.round((limit / top) * 1000) / 10);
  const thresholds = `<div class="card"><h2>Threshold of acceptable risk</h2>
      <p class="muted" style="margin-top:0">Where a vendor stops being approvable. Every percentage in the app is measured against it: 100% is this line. With the current weights, the highest score a vendor could reach is <b id="sc-top">${top}</b>. Standard: <b>${approvalLimit(base) ?? "none"}</b> (${Math.round(((approvalLimit(base) ?? 0) / Math.max(maxPossibleScore(base), 1)) * 1000) / 10}% of ${maxPossibleScore(base)}).</p>
      <div class="slider"><span class="muted">Stricter</span>
        <input type="range" id="sc-limit" data-sc="limit" min="0" max="100" step="0.1" value="${pct}"${dis} aria-label="Threshold of acceptable risk, as a percent of the highest possible score">
        <span class="muted">More accepting</span><output id="sc-limit-val"><b>${limit}</b> <span class="muted">${pct}% of ${top}</span></output></div>
      <p class="muted" id="sc-limit-note"></p></div>
    <div class="card"><h2>Overall</h2><div class="grid2">
      <label class="f">Maximum mitigation credit (%)<small>The most the mitigations together can cut a score.</small>${num('data-sc="glob" data-k="maxMitigationCredit"', pointsShown("Mitigation", d.maxMitigationCredit))}</label>
      <label class="f">Base preference multiplier<small>1 = organization preferences add nothing until a concern is found.</small>${num('data-sc="glob" data-k="basePreferenceMultiplier"', d.basePreferenceMultiplier)}</label>
      <label class="f" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" data-sc="cond"${d.mitigationsMakeConditional ? " checked" : ""}${dis}> Mitigations make an approval conditional</label>
    </div></div>
    <div class="card"><h2>Bands &amp; decisions</h2>
    <p class="muted" style="margin-top:0">Scores run from 0 to ${top} with the current weights, and each band covers the scores shown.</p>
    <table class="sctable"><tr><th>Band</th><th>Covers scores</th><th>Score from</th><th>Likelihood from</th><th>Impact from</th><th>Decision</th><th>Re-review (months)</th></tr>
    ${d.bands.map((b, i) => `<tr><td>${esc(b.name)}</td><td class="muted num">${b.scoreMin}–${i + 1 < d.bands.length ? d.bands[i + 1].scoreMin - 1 : Math.max(top, b.scoreMin)}</td>
      <td>${num(`data-sc="band" data-i="${i}" data-k="scoreMin"`, b.scoreMin)}</td>
      <td>${num(`data-sc="band" data-i="${i}" data-k="likelihoodMin"`, b.likelihoodMin)}</td>
      <td>${num(`data-sc="band" data-i="${i}" data-k="impactMin"`, b.impactMin)}</td>
      <td><select data-sc="band" data-i="${i}" data-k="decision"${dis}>${DECISIONS.map((x) => `<option${b.decision === x ? " selected" : ""}>${x}</option>`).join("")}</select></td>
      <td>${num(`data-sc="band" data-i="${i}" data-k="reReviewMonths"`, b.reReviewMonths)}</td></tr>`).join("")}</table></div>`;

  const factorCard = (f: Factor) => {
    const custom = !base.factors.some((x) => x.id === f.id);
    const fid = esc(f.id);
    const optRow = (o: Factor["options"][number], i: number) => `<div class="scoptrow">
        ${custom ? `<input type="text" class="sclabel" data-sc="label" data-f="${fid}" data-i="${i}" value="${esc(o.label)}" maxlength="${TEXT_LIMITS.label}"${dis} aria-label="Answer">` : `<span class="sclabel">${esc(o.label)}</span>`}
        ${num(`data-sc="pts" data-f="${fid}" data-i="${i}"`, pointsShown(f.section, o.points))}<small>${UNIT[f.section]}</small>
        <input type="text" class="schint" data-sc="hint" data-f="${fid}" data-i="${i}" value="${esc(o.hint ?? "")}" placeholder="What choosing this means" maxlength="${TEXT_LIMITS.hint}"${dis} aria-label="Hint for ${esc(o.label)}">
        ${custom && !ro && f.options.length > 2 ? `<button class="btn small" data-scact="delopt" data-f="${fid}" data-i="${i}" title="Remove this answer">✕</button>` : ""}</div>`;
    return `<div class="scf" id="scf-${fid}">
      <div class="schead"><b>${fid}</b><span class="scq">${esc(f.question || f.factor)}</span>
        <span class="tag ${f.basis === "preference" ? "pref" : ""}">${custom ? "added by you" : f.basis === "preference" ? "your organization's value" : "standard"}</span></div>
      <div class="scopts">${f.options.map(optRow).join("")}</div>
      ${custom && !ro ? `<div class="row" style="margin-bottom:6px"><button class="btn small" data-scact="addopt" data-f="${fid}">+ Add an answer</button></div>` : ""}
      <div class="scflags">
        <label><input type="checkbox" data-sc="en" data-f="${fid}"${f.enabled ? " checked" : ""}${dis}> On</label>
        <label><input type="checkbox" data-sc="req" data-f="${fid}"${f.required ? " checked" : ""}${f.enabled ? "" : " disabled"}${dis}> Required</label>
        <label>Hard stop ${tip(HARD_STOP_TIP)} <select data-sc="hs" data-f="${fid}"${dis}><option value="">none</option>${f.options.map((o) => `<option${f.hardStop === o.label ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>
        ${custom && !ro ? `<button class="btn small" data-scact="del" data-f="${fid}" style="margin-left:auto">Delete question</button>` : ""}
      </div>
      <details class="scedit"><summary>Edit wording, guidance and settings</summary>
        <label class="f">Short name<input type="text" data-sc="text" data-f="${fid}" data-k="factor" value="${esc(f.factor)}" maxlength="${TEXT_LIMITS.factor}"${dis}></label>
        ${txt(f, "question", "Question", `Word it so “Yes” is the good answer, like the standard questions.`)}
        ${txt(f, "guidance", "How to find the answer", "Shown under the question and given to the AI.", 3)}
        ${txt(f, "lookWhere", "Common places to look", "Examples, not a limit.")}
        ${txt(f, "unsure", "If you can't tell", "Overrides the standard “check the places above” line.")}
        ${txt(f, "justification", "Why it matters", "", 3)}
        <div class="grid2">
          <label class="f">Where the answer comes from<select data-sc="research" data-f="${fid}"${dis}><option value="public"${f.research === "public" ? " selected" : ""}>Public sources (AI can research it)</option><option value="internal"${f.research === "internal" ? " selected" : ""}>Inside the organization</option></select></label>
          <label class="f">Basis<select data-sc="basis" data-f="${fid}"${dis}><option value="standard"${f.basis === "standard" ? " selected" : ""}>Standard (published guidance)</option><option value="preference"${f.basis === "preference" ? " selected" : ""}>Organization's value choice</option></select></label>
        </div>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" data-sc="ign" data-f="${fid}"${f.ignorable ? " checked" : ""}${dis}> Assessors may ignore this question for one assessment</label>
      </details></div>`;
  };
  const section = (sec: Section) => `<div class="card"><h2>${SECTION_LABEL[sec]}</h2>
      ${d.factors.filter((f) => f.section === sec).map(factorCard).join("") || `<p class="muted">No questions.</p>`}
      ${ro ? "" : `<div class="row" style="margin-top:10px"><button class="btn small" data-scact="add" data-sec="${sec}">+ Add a question</button><span class="muted">It appears in the questionnaire after you save.</span></div>`}</div>`;
  const tabs = `<div class="sctabs" role="tablist">${SC_TABS.map(([t, label]) => `<button class="${sc.tab === t ? "active" : ""}" role="tab" aria-selected="${sc.tab === t}" data-sctab="${t}">${label}</button>`).join("")}</div>`;
  return `<div class="row"><button class="btn small" data-action="scoring-discard">← Settings</button></div>
    <div><h1>Scoring</h1>
      <p class="lede">${ro ? "Your organization manages these, so they are read-only here." : "The whole policy, editable here: the threshold, the points, and each question's wording. Nothing changes until you save."}</p></div>
    <div class="status warn scnote"><div><b>Please don't tune these for one vendor.</b> ${RESEARCH_NOTE} Changing them changes every assessment made on this computer. Reports, PDFs and exports made with edited weights say so, and list what changed.</div></div>
    ${tabs}
    ${sc.tab === "thresholds" ? thresholds : SECTIONS.map(section).join("")}
    ${ro ? "" : `<div class="scfoot card"><div id="sc-status"></div>
      <label class="f">Note (optional)<textarea id="sc-reason" data-sc="reason" rows="2" placeholder="Why, if you want it kept with the policy">${esc(sc.reason)}</textarea></label>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="sc-save" data-action="scoring-save" disabled>Save</button><button class="btn" data-action="scoring-discard">Discard changes</button></div></div>`}`;
}

function scoringClick(ds: DOMStringMap) {
  const sc = S.sc;
  if (!sc || isLocked("policy")) return;
  const d = sc.draft;
  const f = ds.f ? d.factors.find((x) => x.id === ds.f) : undefined;
  if (ds.sctab) sc.tab = ds.sctab as typeof sc.tab;
  else if (ds.scact === "add") {
    const q = newQuestion(d, ds.sec as Section);
    d.factors.push(q);
    // Keep each section's questions together, in order.
    d.factors.sort((x, y) => SECTIONS.indexOf(x.section) - SECTIONS.indexOf(y.section));
  } else if (ds.scact === "del" && f) {
    d.factors = d.factors.filter((x) => x !== f);
  } else if (ds.scact === "addopt" && f) {
    let n = f.options.length + 1;
    while (f.options.some((o) => o.label === `Answer ${n}`)) n++;
    f.options.push({ label: `Answer ${n}`, points: 0 });
  } else if (ds.scact === "delopt" && f && f.options.length > 2) {
    const [gone] = f.options.splice(Number(ds.i), 1);
    if (f.hardStop === gone.label) f.hardStop = null;
  }
  renderPage();
  refreshScoring();
}

function refreshScoring() {
  const sc = S.sc;
  if (!sc) return;
  const errs = validateScoring(sc.draft);
  const changes = diffPolicy(baselinePolicy(), sc.draft);
  const rp = reasonProblem(sc.reason);
  const box = $("#sc-status");
  if (box)
    box.innerHTML = errs.length
      ? `<div class="status bad"><div><b>Can't save yet:</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div></div>`
      : changes.length
        ? `<details open><summary><b>${changes.length} change${changes.length === 1 ? "" : "s"}</b> from the ${S.remote.config?.policy ? "organization" : "standard"} weights</summary><ul class="sclist">${changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>${rp ? `<p class="muted">${esc(rp)}</p>` : ""}`
        : `<p class="muted">No changes yet.</p>`;
  const note = $("#sc-limit-note");
  if (note) {
    const now = approvalLimit(sc.draft), was = approvalLimit(baselinePolicy());
    note.textContent = now === null || was === null || now === was ? "This is the standard threshold." : now > was ? `More accepting than standard: vendors up to ${now - 1} would be approvable, ${now - was} higher than standard.` : `Stricter than standard: vendors scoring ${now} or more are not approvable, ${was - now} lower than standard.`;
  }
  const save = $<HTMLButtonElement>("#sc-save");
  if (save) save.disabled = !!errs.length || !changes.length || !!rp;
  const hit = new Set(changes.map((c) => c.split(/[ :]/)[0]));
  document.querySelectorAll<HTMLElement>(".scf").forEach((el) => el.classList.toggle("changed", hit.has(el.id.replace(/^scf-/, ""))));
}

/** One edit to the working copy. Values are clamped to numbers here; validateScoring reports what is out of range. */
function scoringInput(el: HTMLInputElement | HTMLSelectElement) {
  const sc = S.sc;
  if (!sc || isLocked("policy")) return;
  const ds = el.dataset;
  const d = sc.draft;
  const n = () => (el.value.trim() === "" ? NaN : Number(el.value));
  const f = ds.f ? d.factors.find((x) => x.id === ds.f) : undefined;
  if (ds.sc === "pts" && f) {
    const v = n();
    f.options[Number(ds.i)].points = f.section === "Mitigation" ? Math.round(v * 100) / 10000 : v;
  } else if (ds.sc === "glob") {
    const k = ds.k as "maxMitigationCredit" | "basePreferenceMultiplier";
    d[k] = k === "maxMitigationCredit" ? Math.round(n() * 100) / 10000 : n();
  } else if (ds.sc === "cond") {
    d.mitigationsMakeConditional = (el as HTMLInputElement).checked;
  } else if (ds.sc === "en" && f) {
    f.enabled = (el as HTMLInputElement).checked;
    if (!f.enabled) f.required = false;
    const req = el.closest(".scf")?.querySelector<HTMLInputElement>("[data-sc=req]");
    if (req) (req.disabled = !f.enabled), (req.checked = f.required);
  } else if (ds.sc === "req" && f) {
    f.required = (el as HTMLInputElement).checked;
  } else if (ds.sc === "hs" && f) {
    f.hardStop = el.value || null;
  } else if (ds.sc === "band") {
    const b = d.bands[Number(ds.i)];
    if (!b) return;
    if (ds.k === "decision") b.decision = el.value as (typeof b)["decision"];
    else (b as unknown as Record<string, number>)[ds.k!] = n();
  } else if (ds.sc === "reason") {
    sc.reason = el.value;
  } else if (ds.sc === "limit") {
    const v = setApprovalLimit(d, (Number(el.value) / 100) * Math.max(maxPossibleScore(d), 1));
    // Keep the numbers on this page in step: the band cut-offs move with the limit.
    document.querySelectorAll<HTMLInputElement>('[data-sc=band][data-k=scoreMin]').forEach((inp) => {
      const b = d.bands[Number(inp.dataset.i)];
      if (b) inp.value = String(b.scoreMin);
    });
    const out = $("#sc-limit-val");
    const top = Math.max(maxPossibleScore(d), 1);
    if (out) out.innerHTML = `<b>${v}</b> <span class="muted">${Math.round((v / top) * 1000) / 10}% of ${top}</span>`;
    // The clamp may have moved it (it can't go below the band beneath), so show where it really landed.
    (el as HTMLInputElement).value = String(Math.min(100, Math.round((v / top) * 1000) / 10));
  } else if (f && ds.sc === "text") {
    (f as unknown as Record<string, string>)[ds.k!] = el.value;
    if (ds.k === "question" || ds.k === "factor") {
      const q = el.closest(".scf")?.querySelector(".scq");
      if (q) q.textContent = f.question || f.factor;
    }
  } else if (f && ds.sc === "hint") {
    f.options[Number(ds.i)].hint = el.value;
  } else if (f && ds.sc === "label") {
    const o = f.options[Number(ds.i)];
    if (f.hardStop === o.label) f.hardStop = el.value;
    o.label = el.value;
  } else if (f && ds.sc === "research") {
    f.research = el.value as Factor["research"];
  } else if (f && ds.sc === "basis") {
    f.basis = el.value as Factor["basis"];
  } else if (f && ds.sc === "ign") {
    f.ignorable = (el as HTMLInputElement).checked;
  }
  refreshScoring();
}

/** Records a user edit (stored apart from org config, so org updates still flow through). */
function setSetting(path: string, value: string) {
  if (isLocked(path)) return;
  const [a, b] = path.split(".") as [keyof UserSettings, string?];
  const u = S.user as Record<string, any>;
  if (b) u[a] = { ...(u[a] ?? {}), [b]: value };
  else u[a] = value;
  saveUserSettings(S.user);
  recomputeSettings();
}

// ---------------- Org config ----------------

const KIND_LABEL: Record<ConfigChoice["kind"], string> = {
  managed: "Managed by your IT department",
  user: "Set by you",
  install: "Set when AssessIT was installed",
  default: "Public defaults",
  off: "Off",
};

function configLabel(): string {
  const R = S.remote;
  if (R.loading) return "Loading config…";
  if (R.choice.kind === "off") return "Org config: off";
  // Public defaults unreachable (offline, or no release yet): the built-in policy is identical, so stay quiet.
  if (R.error && !R.config) return R.choice.kind === "default" ? "Built-in defaults" : "Org config: couldn't load";
  return R.choice.kind === "default" ? "Public defaults" : R.config?.name || KIND_LABEL[R.choice.kind];
}

function policySourceLabel(): string {
  if (S.user.policy && !isLocked("policy")) return "imported by you";
  if (S.remote.config?.policy) return S.remote.choice.kind === "default" ? "public defaults (latest release)" : "from your organization's config";
  return "built-in";
}

function configCard(): string {
  const R = S.remote;
  const c = R.choice;
  const when = R.fetchedAt ? new Date(R.fetchedAt * 1000).toLocaleString() : "";
  const status = R.loading
    ? `<div class="status"><div class="spinner"></div>Loading…</div>`
    : c.kind === "off"
      ? `<div class="status"><span class="dot"></span>Remote config is off. Using built-in defaults and your own settings.</div>`
      : R.error && !R.config && c.kind === "default"
        ? `<div class="status"><span class="dot"></span>Using built-in defaults. The public defaults aren't reachable right now (offline, or no release published yet); they're the same policy.</div>`
      : R.error && !R.config
        ? `<div class="status bad"><span class="dot"></span>Couldn't load: ${esc(R.error)}</div>`
        : `<div class="status ${R.stale ? "warn" : "ok"}"><span class="dot"></span>${R.stale ? `Offline. Using the copy from ${esc(when)}.` : `Loaded ${esc(when)}.`}${R.config?.lock ? " Locked: settings it provides can't be changed here." : ""}</div>`;
  const pinned = c.kind === "managed" || (c.kind === "install" && !!R.config?.lock);
  const editable = !pinned;
  const rl = rules();
  const ruleNotes = [
    !rl.allowOverride && "decision overrides are off",
    !rl.allowYolo && "submitting with open issues is off",
  ].filter(Boolean);
  return `<h2>Organization config</h2>
    <div class="kv" style="margin-bottom:10px"><b>Source</b><span>${esc(KIND_LABEL[c.kind])}${R.config?.name ? ` · ${esc(R.config.name)}` : ""}</span>
      <b>URL</b><span style="overflow-wrap:anywhere">${c.url ? esc(c.url) : "—"}</span></div>
    ${status}
    ${ruleNotes.length ? `<p class="muted">🔒 Organization rules: ${esc(ruleNotes.join("; "))}.</p>` : ""}
    ${c.kind === "default" ? `<p class="muted">The public defaults only update the scoring policy, from this project's latest release, and never set where submissions go. Your organization's own config can set (and lock) the approval destination, the policy and more.</p>` : ""}
    ${editable ? `<div class="row" style="margin-top:10px"><input type="url" id="config-url" placeholder="https://… your organization's assessit-config.json" value="${esc(S.user.configUrl ?? "")}" style="flex:1;min-width:260px">
      <button class="btn small" data-action="config-url-save">Use this URL</button>
      ${S.user.configUrl !== undefined ? `<button class="btn small" data-action="config-url-auto">Automatic</button>` : ""}
      ${c.kind !== "off" ? `<button class="btn small" data-action="config-url-off">Turn off</button>` : ""}</div>` : `<p class="muted">${c.kind === "managed" ? "Your IT department manages this." : "Your organization set this up at install time and locked it."} Ask them to change it.</p>`}
    <div class="row" style="margin-top:8px">${c.url ? `<button class="btn small" data-action="config-refresh">Refresh now</button>` : ""}</div>`;
}

async function loadRemoteConfig() {
  S.remote.loading = true;
  refreshConfigViews();
  let os: { source: "managed" | "install" | "none"; url: string | null } = { source: "none", url: null };
  try {
    os = await invoke("config_source");
  } catch {
    /* not running inside the app (tests / browser preview) */
  }
  // A locked install-time config can't be swapped out from Settings, so check it before honoring the user's URL.
  let installLocked = false;
  if (os.source === "install" && os.url && S.user.configUrl !== undefined) {
    try {
      const got = await invoke<{ body: unknown }>("fetch_config", { url: os.url });
      installLocked = !!sanitizeConfig("install", got.body).lock;
    } catch {
      /* unreachable: fall back to the user's choice */
    }
  }
  const choice = chooseConfig(os, S.user, installLocked);
  const next: RemoteConfig = { choice, config: null, loading: false, fetchedAt: null, stale: false, error: "" };
  if (choice.url) {
    try {
      const got = await invoke<{ body: unknown; fetched_at: number; stale: boolean; error: string | null }>("fetch_config", { url: choice.url });
      const cfg = sanitizeConfig(choice.kind, got.body);
      if (!cfg.policy && cfg.policyUrl) {
        const pol = await invoke<{ body: unknown }>("fetch_config", { url: cfg.policyUrl });
        cfg.policy = validatePolicy(pol.body);
      }
      Object.assign(next, { config: cfg, fetchedAt: got.fetched_at, stale: got.stale, error: got.error ?? "" });
    } catch (e) {
      next.error = errText(e);
    }
  }
  S.remote = next;
  recomputeSettings();
  migrateCurrent();
  applyRules();
  refreshConfigViews();
}

function refreshConfigViews() {
  if (!$("#nav")) return;
  renderNav();
  refreshHeader();
  if (S.tab === "settings") renderPage();
  if (S.tab === "questions" || S.tab === "report") renderPage();
}

// ---------------- Vulnerability triage (SSVC) ----------------

function vulnBubble(): Bubble {
  // Settled counts even before every question is answered: "Act" is already "Act".
  const d = decisionProgress(S.vuln.answers).settled;
  if (d === "Act") return ["hot", "ACT"];
  if (d === "Attend") return ["warm", "ATTEND"];
  if (d) return ["opt", d.toUpperCase()];
  const left = VULN_QUESTIONS.filter((q) => !S.vuln.answers[q.key]).length;
  return left < VULN_QUESTIONS.length ? ["todo", `TODO ${left}`] : ["opt", "SSVC"];
}

const SOURCE_LABEL: Record<AnswerSource, string> = { cisa: "CISA SSVC analysis", kev: "CISA KEV catalog", you: "You" };

function vulnPage(): string {
  return `
    <div><h1>Vulnerability triage</h1><p class="lede">Look up a CVE. AssessIT pulls CISA's KEV catalog and CISA's own SSVC analysis, then asks only what your organization knows. You get CISA's SSVC decision and a suggested remediation timeline based on CISA's BOD 26-04.</p></div>
    <div class="card" id="vuln-lookup">${vulnLookupCard()}</div>
    <div id="vuln-body">${vulnBody()}</div>`;
}

function vulnLookupCard(): string {
  const V = S.vuln;
  const kevNote = V.kevInfo
    ? `KEV catalog ${esc(V.kevInfo.version)}${V.kevInfo.stale ? ` (offline copy from ${esc(new Date(V.kevInfo.fetchedAt * 1000).toLocaleString())})` : ""}`
    : "";
  return `<div class="row">
      <input type="text" id="cve-input" data-vinput placeholder="CVE-2024-3400" value="${esc(V.input)}" style="flex:1;min-width:200px;font-size:15px" autocomplete="off" spellcheck="false">
      <button class="btn primary" data-action="vuln-lookup" ${V.loading ? "disabled" : ""}>${V.loading ? "Looking up…" : "Look up"}</button>
      <button class="btn small" data-action="vuln-clear">Start over</button>
    </div>
    ${V.error ? `<div class="status bad" style="margin-top:10px"><span class="dot"></span>${esc(V.error)}</div>` : ""}
    <p class="muted" style="margin:8px 0 0">No CVE? Just answer the questions below. ${kevNote}</p>`;
}

function vulnBody(): string {
  const V = S.vuln;
  const x = V.answers;
  const d = cisaResult(x);
  const tl = timelineResult(x);
  const missing = (feed: "decision" | "timeline") => VULN_QUESTIONS.filter((q) => q.feeds.includes(feed) && !x[q.key]).map((q) => q.label);

  const cve = V.cve
    ? `<div class="card"><div class="section-head"><h2>${esc(V.cve.id)}</h2><span class="muted">${esc([V.cve.vendor, V.cve.product].filter(Boolean).join(" · "))}${V.cve.published ? ` · published ${esc(V.cve.published)}` : ""}</span></div>
        ${V.cve.title ? `<p style="font-weight:600;margin:4px 0">${esc(V.cve.title)}</p>` : ""}
        <p class="muted" style="margin:4px 0 10px">${esc(V.cve.description.length > 600 ? V.cve.description.slice(0, 600) + "…" : V.cve.description)}</p>
        ${
          V.kev
            ? `<div class="status bad"><span class="dot"></span><div><b>In CISA's KEV catalog</b> since ${esc(V.kev.dateAdded ?? "?")}. Federal due date ${esc(V.kev.dueDate ?? "?")}${V.kev.knownRansomwareCampaignUse === "Known" ? " · <b>known ransomware use</b>" : ""}${V.kev.forensicTriage === "Yes" ? " · forensic triage required" : ""}.${V.kev.requiredAction ? `<br><small>${esc(V.kev.requiredAction)}</small>` : ""}</div></div>`
            : `<div class="status"><span class="dot"></span>Not in CISA's KEV catalog.</div>`
        }
        ${V.notes.map((n) => `<p class="muted" style="margin:8px 0 0">ℹ️ ${esc(n)}</p>`).join("")}
        <div class="refs" style="margin-top:8px"><button class="ref" data-url="https://www.cve.org/CVERecord?id=${esc(V.cve.id)}">CVE record</button><button class="ref" data-url="https://nvd.nist.gov/vuln/detail/${esc(V.cve.id)}">NVD</button>${V.kev ? `<button class="ref" data-url="https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${esc(V.cve.id)}">KEV entry</button>` : ""}</div></div>`
    : "";

  const decisionCard = resultBanner({
    title: "CISA SSVC decision",
    done: d,
    progress: decisionProgress(x),
    keys: DECISION_KEYS,
    meaning: (r) => ({ label: r, summary: DECISION_MEANING[r].summary, detail: DECISION_MEANING[r].detail, tone: DECISION_MEANING[r].tone }),
    pathHtml: vulnPath(),
    missing: missing("decision"),
  });
  const timelineCard = resultBanner({
    title: "Suggested timeline · based on BOD 26-04",
    done: tl,
    progress: timelineProgress(x),
    keys: TIMELINE_KEYS,
    meaning: (r) => ({ label: TIMELINE_MEANING[r].label, summary: "", detail: TIMELINE_MEANING[r].detail, tone: TIMELINE_MEANING[r].tone }),
    footer: `<div style="margin-top:8px;font-size:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="opacity:.85">Based on CISA's patching schedule for U.S. federal civilian agencies. It doesn't bind private organizations, but it's a useful benchmark for how fast to fix. The clock starts when CISA adds it to KEV or you find it on an asset, and it shortens or lengthens as facts change (for example, taking it off the internet).</span><button class="ref" data-url="${BOD_URL}">BOD 26-04 patching schedule (Appendix A, Table 1) ↗</button></div>`,
    missing: missing("timeline"),
  });

  const group = (from: "cisa" | "org", title: string, blurb: string) =>
    `<div class="card"><div class="section-head"><h2>${title}</h2></div><p class="muted" style="margin-top:0">${blurb}</p>${VULN_QUESTIONS.filter((q) => q.from === from)
      .map(vulnQuestion)
      .join("")}</div>`;

  return `${cve}
    <div class="vuln-results">${decisionCard}${timelineCard}</div>
    ${group("org", "Only you know these", "About the affected system in your organization. Each option shows what the result would become.")}
    ${group("cisa", "About the vulnerability", "Filled in from CISA when you look up a CVE. Change any answer if you know better.")}
    <div class="row"><button class="btn" data-action="vuln-copy">Copy summary</button>
      <span class="muted">Sources: <button class="ref" data-url="https://www.cisa.gov/stakeholder-specific-vulnerability-categorization-ssvc">CISA SSVC</button>
      <button class="ref" data-url="https://www.cisa.gov/news-events/directives/bod-26-04-prioritizing-security-updates-based-risk">BOD 26-04</button></span></div>`;
}

const BOD_URL = "https://www.cisa.gov/news-events/directives/bod-26-04-prioritizing-security-updates-based-risk";

type Tone = "ok" | "info" | "warn" | "bad";

/**
 * One result card that updates as answers come in. Finished: the result. Not finished but settled: the result
 * plus the answers that already force it. Otherwise: what's still possible and what's still needed.
 */
function resultBanner<R extends string>(o: {
  title: string;
  done: R | null;
  progress: { possible: R[]; settled: R | null; decidedBy: VulnKey[] };
  keys: VulnKey[];
  meaning: (r: R) => { label: string; summary: string; detail: string; tone: Tone };
  pathHtml?: string;
  footer?: string;
  missing: string[];
}): string {
  const x = S.vuln.answers;
  const foot = o.footer ?? "";
  if (o.done) {
    const m = o.meaning(o.done);
    return `<div class="banner ${m.tone}"><div class="k">${esc(o.title)}</div><div class="d">${esc(m.label.toUpperCase())}</div>${m.summary ? `<div style="font-weight:600">${esc(m.summary)}</div>` : ""}<div style="margin-top:6px">${esc(m.detail)}</div>${o.pathHtml ?? ""}${foot}</div>`;
  }
  const { settled, possible, decidedBy } = o.progress;
  if (settled) {
    const m = o.meaning(settled);
    const chips = decidedBy.map((k) => `<span class="step">${esc(answerChip(x, k))}</span>`).join("");
    return `<div class="banner ${m.tone}"><div class="k">${esc(o.title)} · already settled</div><div class="d">${esc(m.label.toUpperCase())}</div>${m.summary ? `<div style="font-weight:600">${esc(m.summary)}</div>` : ""}<div style="margin-top:6px">${esc(m.detail)}</div>
      <div style="margin-top:8px;font-size:12.5px">Whatever you answer for ${esc(o.missing.join(", "))}, it lands here. Decided by:</div><div class="path" style="margin-top:4px">${chips}</div>${foot}</div>`;
  }
  const answered = o.keys.some((k) => x[k]);
  const range = possible.map((r) => o.meaning(r).label).join(" · ");
  return `<div class="banner muted"><div class="k">${esc(o.title)}</div><div class="d">—</div>${answered ? `<div>Still possible: ${esc(range)}</div>` : ""}<div style="margin-top:4px">Still needed: ${esc(o.missing.join(", "))}</div>${foot}</div>`;
}

/** The branch taken through CISA's tree, e.g. "Active → Automatable → Total → High → Act". */
function vulnPath(): string {
  const x = S.vuln.answers;
  if (!x.missionPrevalence || !x.wellBeing) return "";
  const step = (k: string, v: string) => `<span class="step"><small>${esc(k)}</small>${esc(v)}</span>`;
  const label = (key: VulnKey) => VULN_QUESTIONS.find((q) => q.key === key)!.options.find((o) => o.value === x[key])?.label ?? "";
  const mwb = missionWellBeing(x.missionPrevalence, x.wellBeing);
  return `<div class="path">${step("Exploitation", label("exploitation"))}${step("Automatable", label("automatable"))}${step("Technical impact", label("technicalImpact"))}${step(
    "Mission & well-being",
    mwb[0].toUpperCase() + mwb.slice(1),
  )}</div>`;
}

function vulnQuestion(q: (typeof VULN_QUESTIONS)[number]): string {
  const V = S.vuln;
  const cur = V.answers[q.key];
  const src = V.sources[q.key];
  const opts = q.options
    .map((o) => {
      const w = whatIf(V.answers, q.key, o.value as never);
      const preview = [q.feeds.includes("decision") && w.decision, q.feeds.includes("timeline") && w.timeline && TIMELINE_MEANING[w.timeline].label]
        .filter(Boolean)
        .join(" · ");
      return `<button class="opt vopt ${cur === o.value ? "on" : ""}" data-vopt="${q.key}" data-val="${o.value}" title="${esc(o.meaning)}">${esc(o.label)}${preview ? `<small>→ ${esc(preview)}</small>` : ""}</button>`;
    })
    .join("");
  const meaning = cur
    ? `<div class="guide">${esc(q.options.find((o) => o.value === cur)?.meaning ?? "")}</div>`
    : `<ul class="meanings">${q.options.map((o) => `<li><b>${esc(o.label)}:</b> ${esc(o.meaning)}</li>`).join("")}</ul>`;
  return `<div class="q vq"><div class="id">${q.from === "org" ? "🏢" : "🛡️"}</div>
    <div><span class="text">${esc(q.question)}</span>${src ? `<span class="badge ${src === "you" ? "edited" : "ai"}">${esc(SOURCE_LABEL[src])}${src === "cisa" && V.cisaAnalyzed ? ` · ${esc(V.cisaAnalyzed)}` : ""}</span>` : ""}</div>
    <div class="body"><div class="opts">${opts}</div>${meaning}</div></div>`;
}

function refreshVuln() {
  if (S.tab !== "vuln") return renderNav();
  const card = $("#vuln-lookup");
  if (card) card.innerHTML = vulnLookupCard();
  const body = $("#vuln-body");
  if (body) body.innerHTML = vulnBody();
  renderNav();
}

async function vulnLookup() {
  const V = S.vuln;
  const id = normalizeCveId(V.input);
  if (!id) {
    V.error = "Enter a CVE ID, like CVE-2024-3400.";
    return refreshVuln();
  }
  V.loading = true;
  V.error = "";
  refreshVuln();
  const [rec, kev] = await Promise.allSettled([
    invoke<unknown>("cve_record", { id }),
    invoke<{ entry: KevEntry | null; catalog_version: string; fetched_at: number; stale: boolean }>("kev_lookup", { id }),
  ]);
  V.loading = false;
  if (rec.status === "rejected") {
    V.error = errText(rec.reason);
    return refreshVuln();
  }
  if (!rec.value) {
    V.error = `${id} isn't in the CVE list. Check the number, or answer the questions by hand.`;
    return refreshVuln();
  }
  const kevEntry = kev.status === "fulfilled" ? kev.value.entry : null;
  const pre = prefillFromCisa(rec.value, kevEntry);
  if (kev.status === "rejected") pre.notes.push(`Couldn't check the KEV catalog (${errText(kev.reason)}), so KEV status comes from the CVE record alone.`);
  // Same CVE again: keep what the user answered. A new CVE starts fresh.
  const same = V.cve?.id === id;
  const mine = same ? Object.fromEntries(Object.entries(V.answers).filter(([k]) => V.sources[k as VulnKey] === "you")) : {};
  V.cve = summarizeCve(rec.value);
  V.kev = kevEntry;
  V.kevInfo = kev.status === "fulfilled" ? { version: kev.value.catalog_version, fetchedAt: kev.value.fetched_at, stale: kev.value.stale } : null;
  V.answers = { ...pre.answers, ...mine };
  V.sources = { ...pre.sources, ...Object.fromEntries(Object.keys(mine).map((k) => [k, "you"])) };
  V.notes = pre.notes;
  V.cisaAnalyzed = pre.cisaAnalyzed;
  V.input = id;
  saveVuln();
  refreshVuln();
}

// ---------------- Files ----------------

const slug = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "assessment";
const baseName = () => slug([S.a.details.vendor, S.a.details.product].filter(Boolean).join(" ") || "assessment");

// The frontend never names a file: Rust shows the save/open dialog and touches only what the person picks
// (src-tauri/src/export.rs). Each helper resolves false/null when they cancel.
const fileKind = (name: string, ...extensions: string[]) => ({ name, extensions });
const JSON_ASSESSMENT = fileKind("AssessIT assessment", "json");
const saveJson = (defaultName: string, kind: ReturnType<typeof fileKind>, data: unknown) =>
  invoke<boolean>("save_text_file", { defaultName, filter: kind, contents: JSON.stringify(data, null, 2) });
const openJson = async (kind: ReturnType<typeof fileKind>): Promise<unknown> => {
  const text = await invoke<string | null>("open_text_file", { filter: kind });
  return text === null ? null : JSON.parse(text);
};

async function saveFile() {
  if (await saveJson(`${baseName()}.assessit.json`, JSON_ASSESSMENT, { assessit: 1, policy: policy().name, ...S.a })) toast("Saved.");
}

async function openFile() {
  const data = (await openJson(JSON_ASSESSMENT)) as any;
  if (!data) return;
  if (!data.details || !data.answers) throw new Error("That file isn't an AssessIT assessment.");
  S.a = { details: { ...blankAssessment().details, ...data.details }, answers: data.answers, submitted: data.submitted, aiAttestation: data.aiAttestation, policyVersion: data.policyVersion };
  migrateCurrent();
  applyRules();
  persist();
  S.research = { running: false, log: [], error: "", done: "" };
  render();
  toast("Opened.");
}

async function newAssessment() {
  if (!(await ask("Start a new assessment? Anything you haven't saved will be cleared.", { title: "New assessment", kind: "warning" }))) return;
  S.a = blankAssessment();
  migrateCurrent();
  S.research = { running: false, log: [], error: "", done: "" };
  persist();
  S.tab = "request";
  render();
}

async function exportXlsx() {
  await invoke("save_xlsx", { defaultName: `${baseName()}-risk-assessment.xlsx`, filter: fileKind("Excel", "xlsx"), sheets: xlsxSheets(policy(), S.a, S.settings.org), openAfter: true });
}

async function exportPdf() {
  // Loaded on demand: the PDF engine and its fonts are ~2 MB.
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  pdfMake.addVirtualFileSystem(vfs);
  const base64 = await pdfMake.createPdf(reportPdf(policy(), S.a, S.settings.org)).getBase64();
  await invoke("save_binary_file", { defaultName: `${baseName()}-risk-report.pdf`, filter: fileKind("PDF", "pdf"), base64, openAfter: true });
}

// ---------------- Submit ----------------

/** In-app confirm dialog (styled, unlike the native one). Resolves true for the "yes" button. */
function confirmModal(title: string, bodyHtml: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal-back";
    m.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>${title}</h2>${bodyHtml}
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-m="no">${no}</button><button class="btn go yolo" data-m="yes">${yes}</button></div></div>`;
    const done = (v: boolean) => {
      m.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && done(false);
    m.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-m]");
      if (b) done(b.dataset.m === "yes");
      else if (e.target === m) done(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(m);
    m.querySelector<HTMLElement>('[data-m="no"]')?.focus();
  });
}

function confetti() {
  const colors = ["#f0be3c", "#2f9e5b", "#2f5d9b", "#e0607e", "#fff4c2"];
  const box = document.createElement("div");
  box.className = "confetti";
  for (let i = 0; i < 90; i++) {
    const c = document.createElement("i");
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = `${Math.random() * 0.4}s`;
    c.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
    c.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(c);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3200);
}

async function submit() {
  const r = result();
  const flags = reviewFlags(r, S.a, policy());
  const sub = S.settings.submit;
  if (sub.method === "none") {
    S.tab = "settings";
    render();
    return toast("Choose an approval destination first, or use Export to PDF.");
  }
  if (flags.length && !rules().allowYolo) return toast("Your organization requires every open issue to be resolved before submitting.", 6000);
  if (flags.length) {
    const ok = await confirmModal(
      "YOLO mode? 🤠",
      `<p>This assessment isn't finished:</p><ul>${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
       <p class="muted">You can send it anyway. Approvers will see every one of these issues flagged at the top of the request, and the decision will go out as <b>${esc(r.finalDecision)}</b>.</p>`,
      "Send it anyway",
      "Let me fix it",
    );
    if (!ok) return;
  }
  S.submitting = true;
  renderPage();
  try {
    if (sub.method === "webhook") {
      if (!sub.webhookUrl) throw new Error("Set the webhook URL in Settings.");
      await invoke("post_webhook", { url: sub.webhookUrl, payload: webhookPayload(policy(), S.a, S.settings.org) });
    } else {
      if (!sub.siteUrl || !sub.listName) throw new Error("Set the SharePoint site and list in Settings.");
      if (S.graphAccount === null) {
        S.tab = "settings";
        render();
        throw new Error("Sign in to Microsoft 365 first.");
      }
      const url = await invoke<string>("graph_create_item", { siteUrl: sub.siteUrl, listName: sub.listName, fields: listFields(policy(), S.a, S.settings.org) });
      if (url) toast("Added to SharePoint.", 5000);
    }
    S.a.submitted = { at: new Date().toISOString(), method: sub.method, flagged: flags.length > 0 };
    persist();
    confetti();
    toast(flags.length ? "Sent, YOLO-style. Approvers will see the open issues." : "Submitted for approval. 🎉", 5000);
  } catch (e) {
    toast(`Couldn't submit: ${errText(e)}`, 8000);
  } finally {
    S.submitting = false;
    renderNav();
    if (S.tab === "report") renderPage();
  }
}

async function graphSignIn() {
  const sub = S.settings.submit;
  try {
    const dev = await invoke<DeviceCode>("graph_sign_in_start", { tenant: sub.tenant, clientId: sub.clientId });
    S.device = dev;
    renderPage();
    await navigator.clipboard?.writeText(dev.user_code).catch(() => {});
    await openUrl(dev.verification_uri);
    S.graphAccount = await invoke<string>("graph_sign_in_wait", {
      tenant: sub.tenant, clientId: sub.clientId, deviceCode: dev.device_code, interval: dev.interval, expiresIn: dev.expires_in,
    });
    toast(`Signed in${S.graphAccount ? ` as ${S.graphAccount}` : ""}.`);
  } catch (e) {
    toast(`Sign-in failed: ${errText(e)}`, 8000);
  } finally {
    S.device = null;
    if (S.tab === "settings") renderPage();
  }
}

// ---------------- Events ----------------

const actions: Record<string, () => unknown> = {
  "check-update": () => checkForUpdate(),
  "install-update": () => installUpdate(),
  new: newAssessment,
  open: openFile,
  save: saveFile,
  research: runResearch,
  "copy-prompt": async () => {
    const d = S.a.details;
    if (!d.vendor.trim() && !d.product.trim()) return toast("Enter the vendor or product name first.");
    await navigator.clipboard.writeText(manualPrompt(policy(), d, new Date().toLocaleDateString("en-CA")));
    toast("Prompt copied. Paste it into your AI chat.");
  },
  "manual-import": () => {
    const out = parseManualResponse(policy(), S.manual.paste);
    const { filled, skipped } = mergeResearch(policy(), S.a, out);
    persist();
    S.manual.paste = "";
    S.research.done = `Imported ${filled} answer${filled === 1 ? "" : "s"}${skipped ? `, kept ${skipped} you'd already answered` : ""}.`;
    S.research.error = "";
    refreshResearchCard();
    refreshDerived();
    toast(S.research.done);
  },
  "research-cancel": async () => {
    await invoke("research_cancel");
    S.research.log.push({ kind: "status", text: "Cancelled." });
  },
  "claude-check": checkClaude,
  "claude-setup": async () => {
    await invoke("open_claude_setup");
    toast("Finish signing in from the Terminal window, then click “Check again”.", 6000);
  },
  "toggle-attest": () => {
    if (S.a.aiAttestation) delete S.a.aiAttestation;
    else S.a.aiAttestation = { by: S.a.details.assessors.trim(), at: new Date().toISOString() };
    persist();
    renderPage();
    renderNav();
  },
  "review-ai": () => {
    S.tab = "questions";
    S.filter = "review";
    render();
  },
  submit,
  "export-xlsx": exportXlsx,
  "export-pdf": exportPdf,
  "vuln-lookup": vulnLookup,
  "vuln-clear": () => {
    S.vuln = blankVuln();
    saveVuln();
    refreshVuln();
    $<HTMLInputElement>("#cve-input")?.focus();
  },
  "vuln-copy": async () => {
    await navigator.clipboard.writeText(triageText(S.vuln.cve, S.vuln.answers, S.vuln.kev));
    toast("Summary copied.");
  },
  "copy-msg": async () => {
    await navigator.clipboard.writeText(draftMessage(result(), S.a, S.settings.org, true));
    toast("Draft message copied.");
  },
  "webhook-test": async () => {
    const url = S.settings.submit.webhookUrl;
    if (!url) return toast("Enter the webhook URL first.");
    const payload = { ...webhookPayload(policy(), S.a, S.settings.org), test: true };
    const res = await invoke<string>("post_webhook", { url, payload });
    toast(`Webhook answered: ${res}`, 6000);
  },
  "config-url-save": async () => {
    const url = ($("#config-url") as HTMLInputElement | null)?.value.trim() ?? "";
    if (url && !/^https:\/\//.test(url)) return toast("Config URLs must start with https://");
    S.user.configUrl = url;
    saveUserSettings(S.user);
    await loadRemoteConfig();
  },
  "config-url-auto": async () => {
    delete S.user.configUrl;
    saveUserSettings(S.user);
    await loadRemoteConfig();
  },
  "config-url-off": async () => {
    S.user.configUrl = "";
    saveUserSettings(S.user);
    await loadRemoteConfig();
  },
  "config-refresh": loadRemoteConfig,
  "graph-signin": graphSignIn,
  "graph-open": () => S.device && openUrl(S.device.verification_uri),
  "graph-signout": async () => {
    await invoke("graph_sign_out");
    S.graphAccount = null;
    renderPage();
  },
  "scoring-open": () => {
    S.sc = null;
    S.tab = "scoring";
    renderNav();
    renderPage();
    refreshScoring();
  },
  "scoring-discard": async () => {
    const sc = S.sc;
    if (sc && !isLocked("policy") && diffPolicy(policy(), sc.draft).length && !(await ask("Throw away your unsaved changes to the weights?", { title: "Discard changes", kind: "warning" }))) return;
    S.sc = null;
    S.tab = "settings";
    renderNav();
    renderPage();
  },
  "scoring-save": async () => {
    const sc = S.sc;
    if (!sc || isLocked("policy")) return;
    const errs = validateScoring(sc.draft);
    if (errs.length) throw new Error(errs[0]);
    const rp = reasonProblem(sc.reason);
    if (rp) throw new Error(rp);
    const base = baselinePolicy();
    const edited = withEdits(base, sc.draft, sc.reason);
    if (!edited) {
      delete S.user.policy; // identical to the baseline: nothing to remember
    } else {
      S.user.policy = validatePolicy(edited);
    }
    saveUserSettings(S.user);
    recomputeSettings();
    S.sc = null;
    S.tab = "settings";
    render();
    toast(edited ? "Weights saved. Reports now note they were edited." : "Back to the standard weights.");
  },
  "policy-import": async () => {
    const file = await openJson(fileKind("Policy", "json"));
    if (!file) return;
    S.user.policy = validatePolicy(file);
    saveUserSettings(S.user);
    recomputeSettings();
    render();
    toast(`Loaded policy “${S.user.policy.name}”.`);
  },
  "policy-export": async () => {
    await saveJson("assessit-policy.json", fileKind("Policy", "json"), policy());
  },
  "policy-reset": async () => {
    if (!(await ask("Go back to the standard weights? Your imported or edited policy is removed.", { title: "Reset weights" }))) return;
    delete S.user.policy;
    saveUserSettings(S.user);
    recomputeSettings();
    render();
  },
  "config-export": async () => {
    const out: OrgConfig = { assessitConfig: 2, name: `${S.settings.org.orgName} AssessIT config`, lock: false, ...S.settings, policy: policy() };
    if (!(await saveJson("assessit-org-config.json", fileKind("Org config", "json"), out))) return;
    toast("Exported. Set \"lock\": true in the file to stop users changing these settings.", 6000);
  },
  "config-import": async () => {
    const file = await openJson(fileKind("Org config", "json"));
    if (!file) return;
    // A local file becomes the user's own settings (a hosted URL is better: it stays up to date).
    const cfg = sanitizeConfig("user", file);
    S.user = { ...S.user, org: cfg.org, submit: cfg.submit, model: cfg.model, ...(cfg.policy ? { policy: cfg.policy } : {}) };
    saveUserSettings(S.user);
    recomputeSettings();
    render();
    toast("Settings imported.");
  },
};

function onClick(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tab],[data-action],[data-opt],[data-ignore],[data-vopt],[data-filter],[data-url],[data-section],[data-scact],[data-sctab]");
  if (!el) return;
  const ds = el.dataset;
  if (ds.sctab || ds.scact) return scoringClick(ds);
  if (ds.vopt) {
    const key = ds.vopt as VulnKey;
    (S.vuln.answers as Record<string, string>)[key] = ds.val!;
    S.vuln.sources[key] = "you";
    saveVuln();
    return refreshVuln();
  }
  if (ds.section) {
    S.tab = "questions";
    S.filter = "all";
    renderNav();
    renderPage();
    fitTextareas(); // size the boxes first, or the target moves after the scroll starts
    $(`#sec-${ds.section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (ds.url) {
    openUrl(ds.url).catch((err) => toast(errText(err)));
  } else if (ds.tab) {
    S.tab = ds.tab as Tab;
    if (S.tab !== "questions") S.filter = "all";
    renderNav();
    renderPage();
  } else if (ds.filter) {
    S.filter = ds.filter as Filter;
    renderPage();
  } else if (ds.opt) {
    const id = ds.opt;
    touch(id);
    answer(id).response = ds.val ?? "";
    persist();
    rerenderRow(id);
    refreshDerived();
  } else if (ds.ignore) {
    const id = ds.ignore;
    const ans = answer(id);
    if (ds.val) {
      // Ignoring drops what was there, so an unreviewed AI answer can't linger on a skipped question.
      Object.assign(ans, { response: "", notes: "", sources: "", origin: "user", ignored: true, confidence: undefined, needsConfirmation: false, aiResponse: undefined });
    } else delete ans.ignored;
    persist();
    rerenderRow(id);
    refreshDerived();
  } else if (ds.action) {
    Promise.resolve(actions[ds.action]?.()).catch((err) => toast(errText(err), 8000));
  }
}

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  const ds = el.dataset;
  if (ds.detail) {
    (S.a.details as unknown as Record<string, string>)[ds.detail] = el.value;
    persist();
    $(`[data-required="${ds.detail}"]`)?.classList.toggle("missing", !el.value.trim());
    refreshDerived();
  } else if ("vinput" in ds) {
    S.vuln.input = el.value;
  } else if ("paste" in ds) {
    S.manual.paste = el.value;
  } else if (ds.ans && ds.field) {
    touch(ds.ans);
    (answer(ds.ans) as unknown as Record<string, string>)[ds.field] = el.value;
    if (ds.field === "sources") {
      const box = $(`#src-${ds.ans}`);
      if (box) box.innerHTML = sourceLinks(el.value);
    }
    persist();
    refreshDerived();
  } else if (ds.sc) {
    scoringInput(el);
  } else if (ds.setting) {
    if (el.type === "radio" && !el.checked) return;
    setSetting(ds.setting, el.value);
    if (ds.setting === "submit.method") renderPage();
    refreshHeader();
    renderNav();
  }
}

document.addEventListener("click", onClick);
// <details> toggle doesn't bubble; capture it so the panel stays open across re-renders.
document.addEventListener(
  "toggle",
  (e) => {
    const el = e.target as HTMLDetailsElement;
    if ("manual" in el.dataset) S.manual.open = el.open;
  },
  true,
);
document.addEventListener("input", onInput);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.target as HTMLElement).id === "cve-input") vulnLookup();
});
document.addEventListener("input", (e) => {
  if (e.target instanceof HTMLTextAreaElement) autosize(e.target);
});
// Re-fit after anything re-renders, a panel opens, or the window width changes the line wrapping.
new MutationObserver(autosizeAll).observe(document.body, { childList: true, subtree: true });
document.addEventListener("toggle", autosizeAll, true);
window.addEventListener("resize", autosizeAll);
document.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (el.tagName === "SELECT" || (el as HTMLInputElement).type === "radio") onInput(e);
});

render();
checkClaude();
checkForUpdate();
loadRemoteConfig();
invoke<string | null>("graph_status").then((who) => {
  S.graphAccount = who;
}).catch(() => {});
