import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { bandFor, compute, draftMessage, formatDate, pathToApproval, summary, type Result } from "./engine";
import { chooseConfig, sanitizeConfig, type ConfigChoice } from "./orgconfig";
import { reportPdf } from "./pdf";
import { changedFromAi, STATUSES, decisionTone, fmtPts, listFields, REQUIRED_DETAILS, reviewFlags, SHAREPOINT_COLUMNS, webhookPayload, xlsxSheets } from "./report";
import { navStatus, sectionStatus, unreviewedAi as countUnreviewedAi, type Bubble, type BubbleKind } from "./status";
import { manualPrompt, mergeResearch, parseManualResponse, researchPrompt, researchSchema, type ResearchOutput } from "./research";
import {
  activePolicy, blankAssessment, effectiveSettings, loadCurrent, migrateAssessment, loadUserSettings, lockedPaths,
  orgRules, saveCurrent,
  saveUserSettings, validatePolicy, type OrgConfig, type UserSettings,
} from "./settings";
import type { Answer, Details, Factor, Reference, Section } from "./types";
import {
  cisaResult,
  DECISION_MEANING,
  missionWellBeing,
  normalizeCveId,
  prefillFromCisa,
  summarizeCve,
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

type Tab = "request" | "questions" | "report" | "settings" | "vuln";
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
  graphAccount: null as string | null,
  device: null as DeviceCode | null,
  submitting: false,
  vuln: loadVuln(),
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
    `<button class="${S.tab === t ? "active" : ""}" data-tab="${t}"><span>${label}</span>${bubble(t, ...b)}</button>`;
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
    `<div class="spacer"></div><div class="foot">${esc(policy().name)} v${policy().version}<br>${esc(configLabel())}</div>`;
}

function refreshHeader() {
  const r = result();
  const d = S.a.details;
  $("#doc-title")!.textContent = [d.product, d.vendor].filter(Boolean).join(" · ") || "New assessment";
  const tone = decisionTone(r.finalDecision);
  const score = r.finalDecision === "Incomplete" ? `${r.requiredUnanswered.length} required left` : `${r.score.toFixed(1)} · ${r.band.name}`;
  $("#score-pill")!.innerHTML = `<span class="pill ${tone}">${esc(r.finalDecision)} <span style="font-weight:400">${esc(score)}</span></span>`;
}

let renderedTab: Tab | null = null;

function renderPage() {
  const page = $("#page")!;
  if (S.tab === "request") page.innerHTML = requestPage();
  if (S.tab === "questions") page.innerHTML = questionsPage();
  if (S.tab === "report") page.innerHTML = reportPage();
  if (S.tab === "settings") page.innerHTML = settingsPage();
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
    if (c) c.textContent = String(unreviewedAi());
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
  ["assessors", "Assessor(s)", ""],
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

function sectionTotal(sec: Section): string {
  const r = result();
  if (sec === "Preference") return `multiplier ×${r.preference.toFixed(1)}`;
  if (sec === "Mitigation") return `credit ${pct(-r.mitigationApplied)} (cap ${Math.round(policy().maxMitigationCredit * 100)}%)`;
  return sec === "Likelihood" ? `${r.likelihood} of ${r.likelihoodMax} pts` : `${r.impact} of ${r.impactMax} pts`;
}

const SECTION_BLURB: Record<Section, string> = {
  Likelihood: "Signs an incident is more likely.",
  Impact: "How bad an incident would be for us.",
  Preference:
    "Things many organizations care about where NIST and CISA don't yet say how much they should count. These are value choices, so each 'Yes' scales the whole score instead of adding points.",
  Mitigation: "Controls we have in place. They cut the final score, and become conditions of approval.",
};

function visible(f: Factor): boolean {
  const ans = S.a.answers[f.id];
  if (S.filter === "review") return ans?.origin === "ai";
  if (S.filter === "unanswered") return !ans?.response;
  return true;
}

function questionsPage(): string {
  const p = policy();
  const aiCount = unreviewedAi();
  const sections = SECTIONS
    .map((sec) => {
      const fs = p.factors.filter((f) => f.section === sec && f.enabled && visible(f));
      if (!fs.length) return "";
      return `<div class="card" id="sec-${sec}"><div class="section-head"><h2>${sec === "Preference" ? "Organization preferences" : sec}</h2><span class="muted" id="sec-total-${sec}">${sectionTotal(sec)}</span></div>
        <p class="muted" style="margin:-6px 0 6px">${SECTION_BLURB[sec]}</p>
        ${fs.map(qRow).join("")}</div>`;
    })
    .join("");
  const chip = (f: Filter, label: string) => `<button class="chip ${S.filter === f ? "on" : ""}" data-filter="${f}">${label}</button>`;
  return `
    <div class="section-head"><div><h1>Questionnaire</h1><p class="lede">Pick an answer for every required question. Add notes and sources as evidence; the report quotes them.</p></div></div>
    <div class="row"><div class="filters">${chip("all", "All")}${chip("review", `From AI, not reviewed (<span id="ai-count">${aiCount}</span>)`)}${chip("unanswered", "Unanswered")}</div>
      <div style="flex:1"></div>${aiCount && rules().allowBulkReview ? `<button class="btn small" data-action="accept-all">Mark all AI answers reviewed</button>` : ""}</div>
    ${sections || `<div class="card muted">Nothing matches this filter.</div>`}
    <div class="row"><button class="btn primary" data-tab="report">See the report →</button></div>`;
}

/** AI answers nobody has reviewed yet (ignores AI rows that came back empty). */
const unreviewedAi = () => countUnreviewedAi(S.a);

function badges(f: Factor): string {
  const ans = S.a.answers[f.id];
  let b = f.required ? `<span class="badge req">Required</span>` : "";
  if (ans?.origin === "ai") {
    b += `<span class="badge ai" title="Proposed by AI research. Check the notes and sources.">AI · ${esc(ans.confidence ?? "?")} confidence</span>`;
    if (ans.needsConfirmation) b += `<span class="badge confirm" title="Only your organization can confirm this.">Confirm internally</span>`;
    b += ` <button class="btn small" data-accept="${f.id}">Mark reviewed</button>`;
  } else if (ans && (ans.response || ans.notes) && ans.confidence) {
    b += `<span class="badge edited">Reviewed</span>`;
  }
  return b;
}

function qRow(f: Factor): string {
  const ans = S.a.answers[f.id];
  const resp = ans?.response ?? "";
  const opts = f.options
    .map((o) => `<button class="opt ${resp === o.label ? "on" : ""}" data-opt="${f.id}" data-val="${esc(o.label)}" title="${esc(fmtPts(o.points, f.section))}">${esc(o.label)}</button>`)
    .join("");
  return `<div class="q ${f.required && !resp ? "unanswered-req" : ""}" id="q-${f.id}">
    <div class="id">${esc(f.id)}</div>
    <div><span class="text">${esc(f.question)}</span><span id="badges-${f.id}">${badges(f)}</span>
      ${f.guidance ? `<div class="guide">${esc(f.guidance)}</div>` : ""}
      <div class="refs">${basisChips(f)}</div></div>
    <div class="body">
      <div class="opts">${opts}${resp ? `<button class="btn small" data-opt="${f.id}" data-val="">Clear</button>` : ""}</div>
      <div class="ev">
        <textarea placeholder="Notes / evidence" data-ans="${f.id}" data-field="notes">${esc(ans?.notes ?? "")}</textarea>
        <textarea placeholder="Source URL(s)" data-ans="${f.id}" data-field="sources">${esc(ans?.sources ?? "")}</textarea>
      </div>
    </div></div>`;
}

const refLabel = (r: Reference) => `${r.source}${r.id ? ` ${r.id}` : ""}`;

function basisChips(f: Factor): string {
  const chips = f.references
    .map((r) => `<button class="ref" data-url="${esc(r.url)}" title="${esc(r.title)}">${esc(refLabel(r))}</button>`)
    .join("");
  if (f.basis === "preference")
    return `<span class="ref pref" title="${esc(f.justification)}">Org preference</span>${chips ? `<span class="muted" style="font-size:11px">related:</span>${chips}` : ""}`;
  return chips;
}

function answer(id: string): Answer {
  return (S.a.answers[id] ??= { response: "", notes: "", sources: "", origin: "user" });
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

function sendCard(): string {
  const flags = reviewFlags(result(), S.a);
  const yolo = flags.length > 0;
  const blocked = yolo && !rules().allowYolo;
  const sent = S.a.submitted;
  const changed = changedFromAi(S.a);
  return `<h2>Send it</h2>
    <p class="muted" style="margin-top:0">${submitBlurb()}</p>
    ${yolo ? `<div class="status warn" style="margin-bottom:12px"><span class="dot"></span><div>${blocked ? "🔒 Your organization requires these to be resolved before submitting" : "Not quite ready"}: ${esc(flags.join(" "))}</div></div>` : ""}
    ${changed.length ? `<p class="muted">You changed ${changed.length} answer${changed.length === 1 ? "" : "s"} from what AI research found (${esc(changed.map((c) => c.id).join(", "))}). Approvers will see the AI's original answer next to yours.</p>` : ""}
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
    cells += `<div class="ax">${i}</div>`;
    for (let l = 1; l <= 12; l++) {
      const v = l * i * k;
      const idx = p.bands.indexOf(bandFor(p.bands, "scoreMin", v));
      const color = `var(--band-${Math.min(4, Math.round((idx / Math.max(1, p.bands.length - 1)) * 4))})`;
      const me = l === L && i === I && r.finalDecision !== "Incomplete";
      cells += `<div class="${me ? "me" : ""}" style="background:${color}" title="Likelihood ${l} × Impact ${i} = ${v.toFixed(1)}">${Math.round(v)}</div>`;
    }
  }
  cells += `<div class="ax"></div>` + Array.from({ length: 12 }, (_, j) => `<div class="ax">${j + 1}</div>`).join("");
  const legend = p.bands
    .map((b, idx) => `<span><i style="background:var(--band-${Math.min(4, Math.round((idx / Math.max(1, p.bands.length - 1)) * 4))})"></i>${esc(b.name)} (${b.scoreMin}+) → ${esc(b.decision)}</span>`)
    .join("");
  return `<div class="heat">${cells}</div><div class="muted" style="font-size:12px;margin-top:4px">Likelihood → (rows = Impact). Cells include this assessment's preference multiplier and mitigation credit. Outlined = this assessment${r.likelihood > 12 || r.impact > 12 ? " (clamped at 12)" : ""}.</div><div class="legend">${legend}</div>`;
}

function reportBody(): string {
  const p = policy();
  const r = result();
  const tone = decisionTone(r.finalDecision);
  const tile = (k: string, v: string, s: string) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const drivers = r.drivers.length
    ? `<table><tr><th>#</th><th>Factor</th><th>Section</th><th>Answer</th><th>Score reduction</th><th>Evidence</th></tr>${r.drivers
        .map((x) => `<tr><td>${x.rank}</td><td>${esc(x.factor.factor)}</td><td>${x.factor.section}</td><td>${esc(x.response)}</td><td class="num">${x.scoreReduction.toFixed(1)}</td><td>${esc(x.evidence)}</td></tr>`)
        .join("")}</table>`
    : `<p class="muted">No factors are adding to the score.</p>`;
  const mits = r.mitigations.length
    ? `<table><tr><th>Mitigation</th><th>Credit</th><th>Score reduction</th><th>Evidence</th></tr>${r.mitigations
        .map((x) => `<tr><td>${esc(x.factor.factor)}</td><td>${fmtPts(x.points, "Mitigation")}</td><td class="num">${x.scoreReduction.toFixed(1)}</td><td>${esc(x.evidence)}</td></tr>`)
        .join("")}</table>${r.mitigationRaw > p.maxMitigationCredit ? `<p class="muted">Total credit capped at ${Math.round(p.maxMitigationCredit * 100)}% (raw ${Math.round(r.mitigationRaw * 100)}%).</p>` : ""}`
    : `<p class="muted">None credited.</p>`;
  const aiLeft = unreviewedAi();
  return `
    <div class="banner ${tone}"><div class="d">${esc(r.finalDecision.toUpperCase())}${r.overridden ? " (OVERRIDE)" : ""}</div><div>${esc(summary(r, S.a))}</div></div>
    ${aiLeft ? `<div class="status"><span class="dot"></span><div style="flex:1">${aiLeft} answer${aiLeft === 1 ? "" : "s"} came from AI research and haven't been reviewed.</div><button class="btn small" data-action="review-ai">Review them</button></div>` : ""}
    <div class="tiles">
      ${tile("Risk score", r.finalDecision === "Incomplete" ? "—" : r.score.toFixed(1), `of ${r.maxScore.toFixed(0)} max · ${r.unmitigated.toFixed(1)} before mitigation`)}
      ${tile("Risk band", esc(r.band.name), `Band policy: ${esc(r.band.decision)}`)}
      ${tile("Likelihood", String(r.likelihood), `${esc(r.likelihoodBand)} (max ${r.likelihoodMax})`)}
      ${tile("Impact", String(r.impact), `${esc(r.impactBand)} (max ${r.impactMax})`)}
      ${tile("Preference multiplier", `×${r.preference.toFixed(1)}`, `base ×${p.basePreferenceMultiplier.toFixed(1)}, max ×${r.preferenceMax.toFixed(1)}`)}
      ${tile("Mitigation credit", pct(-r.mitigationApplied), `cap ${Math.round(p.maxMitigationCredit * 100)}%`)}
      ${tile("Required answered", `${r.requiredCount - r.requiredUnanswered.length} / ${r.requiredCount}`, `+ ${r.optionalAnswered} optional answered`)}
      ${tile("Re-review by", esc(formatDate(r.reReviewDate) || "—"), `every ${r.reReviewMonths} months for this band`)}
    </div>
    <div class="card"><h2>Biggest risk drivers</h2><p class="muted" style="margin-top:-6px">How far the final score would fall if this factor had its lowest-risk answer.</p>${drivers}</div>
    <div class="card"><h2>Mitigations credited</h2>${mits}</div>
    <div class="card"><h2>Hard stops &amp; path to approval</h2><div class="kv">
      <b>Hard stops</b><span>${esc(r.hardStops.join("; ") || "None triggered.")}</span>
      <b>Path to approval</b><span>${esc(pathToApproval(r, p.maxMitigationCredit))}</span></div></div>
    <div class="card"><h2>Heat map</h2>${heatMap(r)}</div>
    <div class="card"><h2>Draft outcome message</h2><pre class="msg">${esc(draftMessage(r, S.a, S.settings.org))}</pre></div>`;
}

// ---------------- Settings ----------------

function settingsPage(): string {
  const s = S.settings;
  const sub = s.submit;
  const p = policy();
  const c = S.claude;
  const lock = (path: string) => (isLocked(path) ? " disabled" : "");
  const lockNote = (path: string) => (isLocked(path) ? ` <span class="lock" title="Set by your organization's config">🔒 managed</span>` : "");
  const field = (path: string, label: string, value: string, hint = "", type = "text") =>
    `<label class="f">${label}${lockNote(path)}<input type="${type}" data-setting="${path}" value="${esc(value)}"${lock(path)}>${hint ? `<small>${hint}</small>` : ""}</label>`;
  const radio = (m: string, label: string, hint: string) =>
    `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0"><input type="radio" name="method" data-setting="submit.method" value="${m}" ${sub.method === m ? "checked" : ""}${lock("submit.method")}><span><b>${label}</b><br><small class="muted">${hint}</small></span></label>`;
  const factorRows = p.factors
    .map((f) => `<tr><td>${esc(f.id)}</td><td>${f.section}</td><td>${esc(f.factor)}</td><td>${f.options.map((o) => `${esc(o.label)} = ${o.points}`).join(", ")}</td><td>${f.enabled ? (f.required ? "Required" : "Optional") : "Off"}</td><td>${esc(f.hardStop ?? "")}</td></tr>`)
    .join("");
  const bandRows = p.bands
    .map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${b.scoreMin}+</td><td>${esc(b.decision)}</td><td class="num">${b.reReviewMonths} mo</td></tr>`)
    .join("");

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
    <div class="card"><h2>Scoring policy</h2>
      <p class="muted" style="margin-top:0">Risk Score = Likelihood × Impact × Preference multiplier × (1 − Mitigation credit). Points, bands and hard stops come from the policy file. Users never do the math.</p>
      <div class="row"><b>${esc(p.name)} v${p.version}</b><span class="muted">${policySourceLabel()}</span>${lockNote("policy")}<div style="flex:1"></div>
        ${isLocked("policy") ? "" : `<button class="btn small" data-action="policy-import">Import policy…</button>`}
        <button class="btn small" data-action="policy-export">Export policy…</button>
        ${S.user.policy && !isLocked("policy") ? `<button class="btn small" data-action="policy-reset">Use ${S.remote.config?.policy ? "organization" : "default"} policy</button>` : ""}</div>
      <p class="muted">Defaults follow published guidance (NIST CSF 2.0, NIST AI RMF, CISA). Each question shows its basis; see SCORING.md.</p>
      <details style="margin-top:12px"><summary>Bands &amp; decisions</summary><table><tr><th>Band</th><th>Score</th><th>Decision</th><th>Re-review</th></tr>${bandRows}</table>
        <p class="muted">Max mitigation credit ${Math.round(p.maxMitigationCredit * 100)}% · base preference ×${p.basePreferenceMultiplier} · mitigations ${p.mitigationsMakeConditional ? "make" : "don't make"} approval conditional.</p></details>
      <details style="margin-top:8px"><summary>Factors (${p.factors.length})</summary><table><tr><th>ID</th><th>Section</th><th>Factor</th><th>Points</th><th>Status</th><th>Hard stop</th></tr>${factorRows}</table></details>
    </div>
    <div class="card"><h2>Share these settings</h2><p class="muted" style="margin-top:0">Export everything on this page as an org config file. Host it anywhere HTTPS (SharePoint, an intranet, a GitHub repo), then point everyone's AssessIT at it. See “Rolling it out” in the README.</p>
      <div class="row"><button class="btn small" data-action="config-export">Export org config…</button><button class="btn small" data-action="config-import">Import a config file…</button></div></div>`;
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
    !rl.allowBulkReview && "AI answers must be reviewed one by one",
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
  const d = cisaResult(S.vuln.answers);
  if (d === "Act") return ["hot", "ACT"];
  if (d === "Attend") return ["warm", "ATTEND"];
  if (d) return ["opt", d.toUpperCase()];
  const left = VULN_QUESTIONS.filter((q) => !S.vuln.answers[q.key]).length;
  return left < VULN_QUESTIONS.length ? ["todo", `TODO ${left}`] : ["opt", "SSVC"];
}

const SOURCE_LABEL: Record<AnswerSource, string> = { cisa: "CISA SSVC analysis", kev: "CISA KEV catalog", you: "You" };

function vulnPage(): string {
  return `
    <div><h1>Vulnerability triage</h1><p class="lede">Look up a CVE. AssessIT pulls CISA's KEV catalog and CISA's own SSVC analysis, then asks only what your organization knows. You get CISA's SSVC decision and the BOD 26-04 remediation deadline.</p></div>
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

  const decisionCard = d
    ? `<div class="banner ${DECISION_MEANING[d].tone}"><div class="k">CISA SSVC decision</div><div class="d">${esc(d.toUpperCase())}</div><div style="font-weight:600">${esc(DECISION_MEANING[d].summary)}</div><div style="margin-top:6px">${esc(DECISION_MEANING[d].detail)}</div>${vulnPath()}</div>`
    : `<div class="banner muted"><div class="k">CISA SSVC decision</div><div class="d">—</div><div>Still needed: ${esc(missing("decision").join(", "))}</div></div>`;
  const timelineCard = tl
    ? `<div class="banner ${TIMELINE_MEANING[tl].tone}"><div class="k">BOD 26-04 remediation deadline</div><div class="d">${esc(TIMELINE_MEANING[tl].label.toUpperCase())}</div><div style="margin-top:6px">${esc(TIMELINE_MEANING[tl].detail)}</div><div style="margin-top:6px;opacity:.85;font-size:12px">Binding on U.S. federal civilian agencies; CISA encourages everyone to follow it.</div></div>`
    : `<div class="banner muted"><div class="k">BOD 26-04 remediation deadline</div><div class="d">—</div><div>Still needed: ${esc(missing("timeline").join(", "))}</div></div>`;

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

async function saveFile() {
  const path = await saveDialog({ defaultPath: `${baseName()}.assessit.json`, filters: [{ name: "AssessIT assessment", extensions: ["json"] }] });
  if (!path) return;
  await invoke("write_text_file", { path, contents: JSON.stringify({ assessit: 1, policy: policy().name, ...S.a }, null, 2) });
  toast("Saved.");
}

async function openFile() {
  const path = await openDialog({ multiple: false, filters: [{ name: "AssessIT assessment", extensions: ["json"] }] });
  if (!path || Array.isArray(path)) return;
  const data = JSON.parse(await invoke<string>("read_text_file", { path }));
  if (!data.details || !data.answers) throw new Error("That file isn't an AssessIT assessment.");
  S.a = migrateAssessment({ details: { ...blankAssessment().details, ...data.details }, answers: data.answers, submitted: data.submitted });
  applyRules();
  persist();
  S.research = { running: false, log: [], error: "", done: "" };
  render();
  toast("Opened.");
}

async function newAssessment() {
  if (!(await ask("Start a new assessment? Anything you haven't saved will be cleared.", { title: "New assessment", kind: "warning" }))) return;
  S.a = blankAssessment();
  S.research = { running: false, log: [], error: "", done: "" };
  persist();
  S.tab = "request";
  render();
}

async function exportXlsx() {
  const path = await saveDialog({ defaultPath: `${baseName()}-risk-assessment.xlsx`, filters: [{ name: "Excel", extensions: ["xlsx"] }] });
  if (!path) return;
  await invoke("export_xlsx", { path, sheets: xlsxSheets(policy(), S.a, S.settings.org) });
  await openPath(path).catch(() => toast("Exported."));
}

async function exportPdf() {
  const path = await saveDialog({ defaultPath: `${baseName()}-risk-report.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!path) return;
  // Loaded on demand: the PDF engine and its fonts are ~2 MB.
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  pdfMake.addVirtualFileSystem(vfs);
  const base64 = await pdfMake.createPdf(reportPdf(policy(), S.a, S.settings.org)).getBase64();
  await invoke("write_binary_file", { path, base64 });
  await openPath(path).catch(() => toast("PDF saved."));
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
  const flags = reviewFlags(r, S.a);
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
  "accept-all": () => {
    if (!rules().allowBulkReview) return;
    for (const ans of Object.values(S.a.answers)) if (ans.origin === "ai") Object.assign(ans, { origin: "user", needsConfirmation: false });
    persist();
    renderPage();
    refreshDerived();
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
    await navigator.clipboard.writeText(draftMessage(result(), S.a, S.settings.org));
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
  "policy-import": async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Policy", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    S.user.policy = validatePolicy(JSON.parse(await invoke<string>("read_text_file", { path })));
    saveUserSettings(S.user);
    recomputeSettings();
    render();
    toast(`Loaded policy “${S.user.policy.name}”.`);
  },
  "policy-export": async () => {
    const path = await saveDialog({ defaultPath: "assessit-policy.json", filters: [{ name: "Policy", extensions: ["json"] }] });
    if (path) await invoke("write_text_file", { path, contents: JSON.stringify(policy(), null, 2) });
  },
  "policy-reset": async () => {
    if (!(await ask("Stop using the policy you imported?", { title: "Reset policy" }))) return;
    delete S.user.policy;
    saveUserSettings(S.user);
    recomputeSettings();
    render();
  },
  "config-export": async () => {
    const path = await saveDialog({ defaultPath: "assessit-org-config.json", filters: [{ name: "Org config", extensions: ["json"] }] });
    if (!path) return;
    const out: OrgConfig = { assessitConfig: 1, name: `${S.settings.org.orgName} AssessIT config`, lock: false, ...S.settings, policy: policy() };
    await invoke("write_text_file", { path, contents: JSON.stringify(out, null, 2) });
    toast("Exported. Set \"lock\": true in the file to stop users changing these settings.", 6000);
  },
  "config-import": async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Org config", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    // A local file becomes the user's own settings (a hosted URL is better: it stays up to date).
    const cfg = sanitizeConfig("user", JSON.parse(await invoke<string>("read_text_file", { path })));
    S.user = { ...S.user, org: cfg.org, submit: cfg.submit, model: cfg.model, ...(cfg.policy ? { policy: cfg.policy } : {}) };
    saveUserSettings(S.user);
    recomputeSettings();
    render();
    toast("Settings imported.");
  },
};

function onClick(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tab],[data-action],[data-opt],[data-vopt],[data-filter],[data-accept],[data-url],[data-section]");
  if (!el) return;
  const ds = el.dataset;
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
    const f = policy().factors.find((x) => x.id === id)!;
    const row = $(`#q-${id}`);
    if (row && visible(f)) row.outerHTML = qRow(f);
    else row?.remove();
    refreshDerived();
  } else if (ds.accept) {
    touch(ds.accept);
    persist();
    if (S.filter === "review") $(`#q-${ds.accept}`)?.remove();
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
    persist();
    refreshDerived();
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
loadRemoteConfig();
invoke<string | null>("graph_status").then((who) => {
  S.graphAccount = who;
}).catch(() => {});
