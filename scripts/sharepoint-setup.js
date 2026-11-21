// Sets up a SharePoint list for AssessIT approvals (docs/sharepoint-setup.md, steps 2, 3 and most of 5).
//
// How to run:
//   1. Sign in to SharePoint as a site owner and open any page on the site.
//   2. Edit the settings below.
//   3. Open the browser's developer console (F12, or Cmd+Option+J on a Mac), paste this whole file, press Enter.
//      Chrome may ask you to type "allow pasting" first.
//
// It runs as you, through SharePoint's own REST API: no PowerShell, no app registration.
// Safe to run again: anything that already exists is left alone.

(async () => {
  // ---- Settings ------------------------------------------------------------------------------
  const LIST = "Software Risk Assessments"; // display name; created if missing
  const REQUESTERS_GROUP = "AssessIT Requesters";
  const REVIEWERS_GROUP = "AssessIT Reviewers";
  // Who may submit. "everyone" = everyone in your organization except guests. Or emails, in quotes: ["alex@example.com"]
  const REQUESTERS = ["everyone"];
  // Your review group: emails of the people who decide requests, in quotes: ["alex@example.com", "sam@example.com"].
  // Empty = add them later (see the message at the end).
  const REVIEWERS = [];
  // true = requesters see only their own requests (reviewers still see all).
  const REQUESTERS_SEE_ONLY_THEIR_OWN = false;
  // ---------------------------------------------------------------------------------------------

  const STATUSES = ["Submitted", "In review", "Approved", "Approved with conditions", "Denied"];
  // [internal name, type]. Must match SHAREPOINT_COLUMNS and REVIEW_COLUMNS in src/report.ts.
  const COLUMNS = [
    ["Vendor", "Text"], ["Product", "Text"], ["Plan", "Text"], ["RequestingTeam", "Text"], ["BusinessOwner", "Text"],
    ["IntendedUse", "Note"], ["AssessmentDate", "Text"], ["Assessors", "Text"], ["RiskScore", "Number2"], ["RiskBand", "Text"],
    ["LikelihoodScore", "Number"], ["ImpactScore", "Number"], ["Decision", "Text"], ["CalculatedDecision", "Text"],
    ["OverrideJustification", "Note"], ["RiskAcceptedBy", "Text"], ["ReReviewDate", "Text"], ["Conditions", "Note"],
    ["Summary", "Note"], ["DraftMessage", "Note"], ["Answers", "Note"], ["ReviewFlags", "Note"], ["ChangedFromAI", "Note"],
    ["AssessmentJSON", "Note"], ["Status", "Status"],
    ["DecisionNote", "Text"], ["DecisionDetails", "AppendNote"],
  ];
  const DEFAULT_VIEW = ["Vendor", "Product", "RiskScore", "Decision", "Status", "Author", "Created"];
  const REVIEW_VIEW = ["Vendor", "Product", "RiskScore", "RiskBand", "Decision", "ReviewFlags", "Status", "Author", "Created"];
  const FORMULA = '=IF(OR([Status]="Approved with conditions",[Status]="Denied"),LEN(TRIM([DecisionNote]))>0,TRUE)';
  const FORMULA_MESSAGE = "Approved with conditions and Denied need a DecisionNote explaining why.";
  // SP.PermissionKind values added on top of the built-in Read level.
  const KIND = { AddListItems: 2, EditListItems: 3, CancelCheckout: 9 /* "Override List Behaviors" */ };

  const ctx = window._spPageContextInfo;
  const web = ctx?.webAbsoluteUrl ?? location.href.match(/^https:\/\/[^/]+\/(sites|teams)\/[^/]+/i)?.[0];
  if (!web) throw new Error("Open a page on your SharePoint site first, then run this again.");
  const q = (s) => s.replace(/'/g, "''");
  const listApi = `${web}/_api/web/lists/getbytitle('${encodeURIComponent(q(LIST))}')`;
  const log = (...a) => console.log("%cAssessIT", "font-weight:bold;color:#2b7fff", ...a);

  let digest = "";
  async function sp(method, url, body, extra = {}) {
    const res = await fetch(url.startsWith("http") ? url : `${web}/_api/${url}`, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json;odata=verbose",
        "Content-Type": "application/json;odata=verbose",
        ...(method === "GET" ? {} : { "X-RequestDigest": digest }),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text).d : {};
  }
  // Everything in a collection. Used to check what exists: SharePoint answers "not found" inconsistently (404 or 400).
  const all = async (url) => (await sp("GET", url)).results;
  digest = (await sp("POST", "contextinfo")).GetContextWebInformation.FormDigestValue;

  // ---- The list ----
  let list = await sp("GET", listApi);
  if (!list) {
    list = await sp("POST", "web/lists", { __metadata: { type: "SP.List" }, Title: LIST, BaseTemplate: 100 });
    log(`Created list "${LIST}".`);
  } else log(`Found list "${LIST}".`);

  // Versioning first: append-only notes depend on it.
  await sp("POST", listApi, { __metadata: { type: "SP.List" }, EnableVersioning: true, MajorVersionLimit: 500 }, { "X-HTTP-Method": "MERGE", "IF-MATCH": "*" });
  log("Versioning on, keeping 500 versions.");

  // ---- Columns ----
  const xml = (name, type) => {
    const id = `Name="${name}" StaticName="${name}" DisplayName="${name}"`;
    switch (type) {
      case "Text": return `<Field Type="Text" ${id} MaxLength="255" />`;
      case "Note": return `<Field Type="Note" ${id} NumLines="6" RichText="FALSE" />`;
      case "AppendNote": return `<Field Type="Note" ${id} NumLines="6" RichText="FALSE" AppendOnly="TRUE" />`;
      case "Number": return `<Field Type="Number" ${id} />`;
      case "Number2": return `<Field Type="Number" ${id} Decimals="2" />`;
      case "Status": return `<Field Type="Choice" ${id} Format="Dropdown" FillInChoice="FALSE"><Default>${STATUSES[0]}</Default><CHOICES>${STATUSES.map((s) => `<CHOICE>${s}</CHOICE>`).join("")}</CHOICES></Field>`;
    }
  };
  let added = 0;
  const fields = await all(`${listApi}/fields?$select=InternalName,Title&$top=500`);
  for (const [name, type] of COLUMNS) {
    const existing = fields.find((f) => f.InternalName === name) ?? fields.find((f) => f.Title === name);
    if (existing) {
      if (existing.InternalName !== name) console.warn(`A column titled "${name}" exists with internal name "${existing.InternalName}". AssessIT writes "${name}", so delete or rename that column and run this again.`);
      continue;
    }
    // Options 9 = add to the item content type (so it shows in forms) + use Name as the internal name.
    await sp("POST", `${listApi}/fields/createfieldasxml`, {
      parameters: { __metadata: { type: "SP.XmlSchemaFieldCreationInformation" }, SchemaXml: xml(name, type), Options: 9 },
    });
    added++;
  }
  log(`Columns: ${added} added, ${COLUMNS.length - added} already there.`);

  // ---- Note rule ----
  await sp("POST", listApi, { __metadata: { type: "SP.List" }, ValidationFormula: FORMULA, ValidationMessage: FORMULA_MESSAGE }, { "X-HTTP-Method": "MERGE", "IF-MATCH": "*" });
  log("Note rule set: Approved with conditions and Denied need a DecisionNote.");

  // ---- Views ----
  async function setViewFields(viewApi, fields) {
    await sp("POST", `${viewApi}/viewfields/removeallviewfields`);
    for (const f of ["LinkTitle", ...fields]) await sp("POST", `${viewApi}/viewfields/addviewfield('${f}')`);
  }
  await setViewFields(`${listApi}/defaultview`, DEFAULT_VIEW);
  const views = await all(`${listApi}/views?$select=Title`);
  if (!views.some((v) => v.Title === "Needs review")) {
    const where = `<Where><Or><Eq><FieldRef Name="Status" /><Value Type="Text">Submitted</Value></Eq><Eq><FieldRef Name="Status" /><Value Type="Text">In review</Value></Eq></Or></Where><OrderBy><FieldRef Name="Created" Ascending="TRUE" /></OrderBy>`;
    await sp("POST", `${listApi}/views`, { __metadata: { type: "SP.View" }, Title: "Needs review", PersonalView: false, ViewQuery: where, RowLimit: 100 });
    await setViewFields(`${listApi}/views/getbytitle('Needs review')`, REVIEW_VIEW);
    log('Created view "Needs review" (Submitted or In review, oldest first).');
  }

  // ---- Permission levels: built-in Read plus a few rights ----
  const levels = await all("web/roledefinitions");
  const read = levels.find((r) => r.RoleTypeKind === 2); // built-in Read
  const mask = (extra) => {
    let m = (BigInt(read.BasePermissions.High) << 32n) | BigInt(read.BasePermissions.Low);
    for (const k of extra) m |= 1n << BigInt(k - 1);
    return { __metadata: { type: "SP.BasePermissions" }, High: String(m >> 32n), Low: String(m & 0xffffffffn) };
  };
  async function level(name, description, extra) {
    const found = levels.find((r) => r.Name === name);
    if (found) return found.Id;
    const r = await sp("POST", "web/roledefinitions", { __metadata: { type: "SP.RoleDefinition" }, Name: name, Description: description, BasePermissions: mask(extra) });
    log(`Created permission level "${name}".`);
    return r.Id;
  }
  const submitLevel = await level("Submit requests", "AssessIT requesters: Read, plus add items. Can't edit or delete.", [KIND.AddListItems]);
  const reviewLevel = await level("Review requests", "AssessIT reviewers: Read, plus edit items and see everyone's items. Can't add or delete.", [KIND.EditListItems, KIND.CancelCheckout]);

  // ---- Groups ----
  const groups = await all("web/sitegroups?$select=Id,Title&$top=5000");
  async function group(name, description) {
    const g = groups.find((x) => x.Title === name) ?? (await sp("POST", "web/sitegroups", { __metadata: { type: "SP.Group" }, Title: name, Description: description }));
    return g.Id;
  }
  // Not every SharePoint page exposes the tenant ID, so fall back to Microsoft's public sign-in metadata
  // for <tenant>.onmicrosoft.com (the name in front of .sharepoint.com).
  async function tenantId() {
    if (ctx?.aadTenantId) return ctx.aadTenantId;
    try {
      const name = location.hostname.split(".")[0];
      const meta = await (await fetch(`https://login.microsoftonline.com/${name}.onmicrosoft.com/v2.0/.well-known/openid-configuration`)).json();
      return meta.issuer.match(/[0-9a-f-]{36}/)?.[0];
    } catch {
      return undefined;
    }
  }
  async function addMembers(groupId, people) {
    for (const p of people) {
      let login;
      if (p === "everyone") {
        const tid = await tenantId();
        if (!tid) { console.warn('Couldn\'t find your tenant ID. Add "Everyone except external users" to the group by hand.'); continue; }
        login = `c:0-.f|rolemanager|spo-grid-all-users/${tid}`;
      } else login = `i:0#.f|membership|${p.trim().toLowerCase()}`;
      try {
        await sp("POST", `web/sitegroups/getbyid(${groupId})/users`, { __metadata: { type: "SP.User" }, LoginName: login });
      } catch (e) {
        console.warn(`Couldn't add ${p}: ${e.message}`);
      }
    }
  }
  const requesters = await group(REQUESTERS_GROUP, "Can submit AssessIT requests.");
  const reviewers = await group(REVIEWERS_GROUP, "Decides AssessIT requests.");
  await addMembers(requesters, REQUESTERS);
  await addMembers(reviewers, REVIEWERS);
  log(`Groups ready: "${REQUESTERS_GROUP}", "${REVIEWERS_GROUP}".`);

  // ---- List permissions: only owners, requesters and reviewers ----
  const owners = (await sp("GET", "web/associatedownergroup")).Id;
  const fresh = await sp("GET", `${listApi}?$select=HasUniqueRoleAssignments`);
  if (!fresh.HasUniqueRoleAssignments) await sp("POST", `${listApi}/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=true)`);
  const assignments = (await sp("GET", `${listApi}/roleassignments?$expand=Member`)).results;
  for (const a of assignments) {
    if (![owners, requesters, reviewers].includes(a.PrincipalId)) {
      await sp("POST", `${listApi}/roleassignments/getbyprincipalid(${a.PrincipalId})/deleteobject`);
      log(`Removed "${a.Member.Title}" from the list.`);
    }
  }
  for (const [principal, role] of [[requesters, submitLevel], [reviewers, reviewLevel]]) {
    if (assignments.some((a) => a.PrincipalId === principal)) await sp("POST", `${listApi}/roleassignments/getbyprincipalid(${principal})/deleteobject`);
    await sp("POST", `${listApi}/roleassignments/addroleassignment(principalid=${principal},roledefid=${role})`);
  }
  log(`List permissions: Owners full control, "${REQUESTERS_GROUP}" Submit requests, "${REVIEWERS_GROUP}" Review requests.`);

  if (REQUESTERS_SEE_ONLY_THEIR_OWN) {
    await sp("POST", listApi, { __metadata: { type: "SP.List" }, ReadSecurity: 2 }, { "X-HTTP-Method": "MERGE", "IF-MATCH": "*" });
    log("Requesters see only their own requests.");
  }

  log(`Done. Still to do by hand (docs/sharepoint-setup.md):
  • Add reviewers to "${REVIEWERS_GROUP}" if you didn't list them above: ${web}/_layouts/15/groups.aspx
    (The groups only have access to this list, so they don't appear on the Site permissions page.)
  • Step 4: register the AssessIT app in Microsoft Entra.
  • Step 5: on the list, Automate → Create a rule for the two notification emails.
  • In AssessIT, Settings → SharePoint list: Site URL ${web}, List name "${LIST}".`);
})().catch((e) => console.error("AssessIT setup stopped:", e.message));
