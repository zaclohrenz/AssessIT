# Setting up SharePoint approvals

Requests from AssessIT land in a SharePoint list as the person who submitted them. Your review group decides right on the list item. SharePoint itself enforces who can decide and that a note is given, and it records who did what. No Power Automate is needed.

```
AssessIT ──(signed in as the requester)──► SharePoint list ──► review group edits Status
                                           Status: Submitted     In review
                                                                 Approved
                                                                 Approved with conditions  (note required)
                                                                 Denied                    (note required)
```

**What you get:**
- **The submitter is verified.** Each item's *Created By* is the Microsoft 365 account that submitted it. Nobody can submit as someone else.
- **Requesters can't touch the outcome.** They can add requests but not edit them, so they can't set their own request to Approved.
- **Only your review group decides.** They get a permission level that can edit items but not add or delete them.
- **Notes are enforced.** List validation rejects *Approved with conditions* or *Denied* unless the reviewer writes a note.
- **Every action is attributed and kept.** Version history records each change: who made it, when, and the Status and note at that point. SharePoint fills in those names; nobody can type someone else's.
- **The raw form values are stored.** *AssessmentJSON* holds every answer, note and source exactly as the requester entered them.

You'll need a SharePoint site you own (step 1 creates one) and someone who can register an app in Microsoft Entra. Allow about 30 minutes.

> I wrote these steps from Microsoft's documentation and haven't tested them in a real tenant yet. Please run the checklist at the end with a test account, and open an issue if a step doesn't match what you see.

## 1. Create a site (if you don't have one)

You can put the list on any existing site. To give it its own site instead, use a **Communication site**. A regular team site also creates a Microsoft 365 group: a shared mailbox, a Teams link, and members who can edit by default. AssessIT needs none of that.

**From the SharePoint start page:**
1. Go to `https://<yourtenant>.sharepoint.com`, or pick **SharePoint** from the Microsoft 365 app launcher.
2. Select **+ Create site**, then **Communication site**.
3. Pick a template (**Blank** is fine) and select **Use template**.
4. Enter a site name, for example `IT Risk`. The address fills in from it, such as `/sites/ITRisk`; you can edit it.
5. Choose the default language and select **Create site**.
6. Add a second owner, so the site isn't tied to one person, then select **Finish**.

**If you don't see + Create site,** your admin has turned off site creation for users. A SharePoint admin can create it instead: in the **SharePoint admin center**, go to **Sites → Active sites → + Create**, pick **Communication site**, enter the name, address and owner, then select **Finish**. The admin center also offers **Team site (no Microsoft 365 group)**, which works just as well.

You don't need to add requesters or reviewers to the site itself. When you grant them access to the list in step 3, SharePoint gives them just enough site access to reach it.

The site's address, such as `https://contoso.sharepoint.com/sites/ITRisk`, is the **Site URL** you'll enter in AssessIT in step 6.

## Shortcut: run the setup script

[`scripts/sharepoint-setup.js`](../scripts/sharepoint-setup.js) does steps 2 and 3, plus the note rule and review view from step 5, so you don't have to create 27 columns by hand. It runs in your browser, signed in as you, through SharePoint's own REST API: no PowerShell and no app registration.

1. Open any page on your site as a site owner.
2. Open the script and edit the **Settings** block at the top: the list name, who can submit, and your reviewers' emails.
3. Open the browser's developer console (**F12**, or **Cmd+Option+J** on a Mac), paste the whole script and press **Enter**. Chrome may ask you to type `allow pasting` first.

It prints each thing it does, and it has been run successfully against SharePoint Online. It's safe to run again: anything that already exists is left alone. Afterwards, do step 4 (the Entra app), the notification rules in step 5, and step 6. The steps below describe what the script sets up, if you'd rather do it by hand or check its work.

## 2. Create the list

On your site, go to **New → List → Blank list** and name it, for example, **Software Risk Assessments**.

**Columns the app writes.** Create each one under **Add column**, using the name exactly as shown, with no spaces, so the internal name matches. **Title** is built in. The app also lists these under **Settings → Approval destination → List columns the app writes**.

| Column | Type | Notes |
|---|---|---|
| Vendor | Single line of text | |
| Product | Single line of text | |
| Plan | Single line of text | |
| RequestingTeam | Single line of text | |
| BusinessOwner | Single line of text | |
| IntendedUse | Multiple lines of text | |
| AssessmentDate | Single line of text | |
| Assessors | Single line of text | |
| RiskScore | Number | 2 decimal places |
| RiskBand | Single line of text | |
| LikelihoodScore | Number | |
| ImpactScore | Number | |
| Decision | Single line of text | What AssessIT calculated (or the requester's override, if your org allows overrides) |
| CalculatedDecision | Single line of text | |
| OverrideJustification | Multiple lines of text | |
| RiskAcceptedBy | Single line of text | |
| ReReviewDate | Single line of text | |
| Conditions | Multiple lines of text | |
| Summary | Multiple lines of text | |
| DraftMessage | Multiple lines of text | |
| Answers | Multiple lines of text | Readable version of every answer |
| ReviewFlags | Multiple lines of text | Open issues if the requester sent it anyway ("YOLO") |
| ChangedFromAI | Multiple lines of text | Answers the requester changed from what AI research found |
| AssessmentJSON | Multiple lines of text | Plain text. Every raw value from the form, as JSON |
| Status | Choice | Choices, one per line: `Submitted`, `In review`, `Approved`, `Approved with conditions`, `Denied`. Default value: `Submitted`. Turn off **Allow manually entered values**. |

**Columns reviewers fill in:**

| Column | Type | Notes |
|---|---|---|
| DecisionNote | Single line of text | The reason for the decision, up to 255 characters. Required for *Approved with conditions* and *Denied* (step 5). It must be single-line, because list validation can't read multi-line columns. |
| DecisionDetails | Multiple lines of text | Optional longer explanation, such as the full list of conditions. Plain text, with **Append changes to existing text** on (turn on versioning first). |

**Turn on versioning.** Go to **List settings → Versioning settings**:
- Set **Create a version each time you edit an item** to **Yes**.
- Keep plenty of versions, 500 or more.
- Leave **Require content approval for submitted items** at **No**. That's SharePoint's older approval feature; the Status column replaces it (see the end of this guide).

Version history is your audit trail. It's also what **Append changes to existing text** relies on: with too few versions, old notes eventually drop off.

## 3. Set permissions

Use groups for these, not individual people: for example, *AssessIT Requesters* (often everyone in the company) and *AssessIT Reviewers*. The Reviewers group is your review group: whoever your organization puts in it can decide requests. To change who's in either group later, open `<your site>/_layouts/15/groups.aspx`. Groups that only have access to this list don't appear on the **Site permissions** page.

1. **Create two permission levels.** Go to **Site settings → Site permissions → Advanced permissions settings → Permission Levels → Add a Permission Level**.
   Start each from the built-in **Read** level: open **Read**, then select **Copy Permission Level** at the bottom.
   - `Submit requests`: Read, plus **Add Items**. Leave **Edit Items** and **Delete Items** off.
   - `Review requests`: Read, plus **Edit Items** and **Override List Behaviors**. Leave **Add Items** and **Delete Items** off, so reviewers can't create requests or erase one along with its history. Override List Behaviors lets them see every request if you turn on the option in item 4.
2. **Give the list its own permissions.** Go to **List settings → Permissions for this list → Stop Inheriting Permissions**, then remove groups that shouldn't edit it, such as site Members.
3. **Grant access:**

   | Who | Permission on the list | Why |
   |---|---|---|
   | Requesters | **Submit requests** | Can add requests and read them, but never edit them, so they can't change the Status |
   | Reviewers | **Review requests** | Can set Status and write notes; can't add or delete requests |
   | List owners / admins | **Full Control** | Fixing mistakes; every change still shows in version history |

   Someone in both groups can edit their own request. Keep reviewers out of the Requesters group, or have a second reviewer decide their requests.
4. **Optional: let requesters see only their own requests.** Go to **List settings → Advanced settings → Item-level permissions → Read access: Read items that were created by the user**. This setting also limits reviewers, unless their permission level includes **Override List Behaviors**, as `Review requests` does. Test with a reviewer account that they can still see everyone's requests.

SharePoint has no per-column permissions, so reviewers can technically edit any column, including the requester's answers. Version history shows any such change and who made it.

## 4. Register the app in Microsoft Entra

AssessIT signs each user in with their own Microsoft 365 account. It needs an app registration in **your** tenant: AssessIT ships with no Microsoft credentials, and registrations are free.

1. Go to **Entra admin center → App registrations → New registration**:
   - Name: `AssessIT`
   - Supported account types: *Accounts in this organizational directory only*
   - No redirect URI is needed
2. Go to **Authentication → Advanced settings** and set **Allow public client flows** to **Yes**. This enables the device-code sign-in.
3. Go to **API permissions → Add → Microsoft Graph → Delegated permissions**:
   - Add `Sites.ReadWrite.All` and `User.Read`.
   - Click **Grant admin consent**.

   Delegated access never exceeds what the user can already do in SharePoint. With the permissions from step 3, a requester can only add items to this list.
4. Copy the **Application (client) ID** and your **Directory (tenant) ID**.

## 5. Set up reviewing

**Require a note.** Go to **List settings → Validation settings** (list validation, not a column's validation) and enter:

```
=IF(OR([Status]="Approved with conditions",[Status]="Denied"),LEN(TRIM([DecisionNote]))>0,TRUE)
```

User message: `Approved with conditions and Denied need a DecisionNote explaining why.`

If SharePoint rejects the formula, your regional settings may need semicolons instead of commas.

**Add a review view.** Create a view named **Needs review**, filtered to **Status** is `Submitted` *or* **Status** is `In review`. Show Title, Vendor, RiskScore, Decision, ReviewFlags, Status and **Created By**. Reviewers work from this view.

**Notify people with list rules.** On the list, go to **Automate → Create a rule**. Rules are built into SharePoint; their emails come from `no-reply@sharepointonline.com` and their text can't be customized.
- **New request:** *When a new item is created*, send email to your reviewers. Rules can email people or a Person column, but not a group email address, so add each reviewer.
- **Decision made:** *When Status changes*, send email to **Created By**. Requesters hear about every change, including *In review*.

**How a reviewer decides:**
1. Open the item from **Needs review**.
2. Optionally, set **Status** to `In review` to show you've picked it up.
3. Set **Status** to the decision. For *Approved with conditions* or *Denied*, write the reason in **DecisionNote**, and anything longer in **DecisionDetails**. If you change a decision later, update the note too: validation only checks that one exists.
4. Save. SharePoint records you as the person who made that change.

**Seeing who did what.** Open an item's **Version history**. Each version lists who saved it, when, and what changed, so you can see who submitted, who set it *In review*, who decided, and every note along the way. The list's **Modified By** column shows whoever changed the item last, which is usually the deciding reviewer.

## 6. Point AssessIT at the list

In **AssessIT → Settings → Approval destination**, choose **SharePoint list** and enter:
- **Site URL**, for example `https://contoso.sharepoint.com/sites/ITRisk`
- **List name**
- **Tenant**: your tenant ID or primary domain
- **Client ID**: from step 4

Click **Sign in to Microsoft 365** and complete the device-code sign-in, then submit a test request.

To roll this out to everyone, click **Export org config**, add `"lock": ["submit"]` (or `"lock": true`) and host the file. See the README's *Rolling it out* section. Each user signs in once. Their sign-in token is stored only on their computer, readable only by them, and **Sign out** deletes it:
- macOS: `~/Library/Application Support/io.github.zaclohrenz.assessit/graph-token.json`
- Windows: `%APPDATA%\io.github.zaclohrenz.assessit\`

## Checklist

Run through this with a test requester account and a test reviewer account:

- [ ] **Submitting:** submit from AssessIT as the requester. The item appears with **Created By** set to the requester and **Status** `Submitted`, and the reviewers get an email.
- [ ] **Read-only for requesters:** as the requester, open the item in SharePoint. There's no **Edit** button, and changing Status fails.
- [ ] **Note required:** as the reviewer, set Status to **Denied** with an empty DecisionNote and save. SharePoint refuses with your validation message.
- [ ] **Decision recorded:** add a note and save. The requester gets an email.
- [ ] **No deleting:** as the reviewer, there's no **Delete** option on the item.
- [ ] **Audit trail:** open **Version history** on the item. The submission, the decision, the reviewer's name and the note are all listed.
- [ ] **Raw values:** **AssessmentJSON** contains the full form.

## Why not SharePoint's built-in Approvals?

SharePoint has two approval features. Neither does what this guide needs, so leave both off.

- **Approvals in Lists** (**Automate → Configure approvals**) adds an *Approval status* column with Approve and Reject buttons, and notifies approvers in the Teams Approvals app. But a person has to click **Request approval** on each item, so items AssessIT adds wouldn't start one by themselves. It has only Approve or Reject, with no *Approved with conditions*, and it can't require a comment. The list columns show only the latest activity; full history lives in Teams. Turning it on also turns off Lists sync for that list.
- **Content approval** (**Versioning settings → Require content approval**) hides new items until someone approves them. It has only Pending, Approved and Rejected; comments are optional; and approvers need the **Approve Items** permission. AssessIT also doesn't handle items that stay hidden as Pending.

If two outcomes and optional comments are enough for you, Approvals in Lists is a reasonable choice: requesters (or your reviewers) click **Request approval** on each new item. AssessIT doesn't depend on either feature, so its submissions work the same way.

## Alternative: webhook

If you don't use SharePoint, or don't want users to sign in, AssessIT can POST JSON to Power Automate or any HTTPS endpoint (Zapier, n8n, Jira automation…). Choose **Webhook** in Settings. Nobody signs in, so a webhook **can't verify who submitted**; treat the URL like a password.

With Power Automate:
1. Create an **Instant cloud flow** with the trigger **When an HTTP request is received**.
   - **Who can trigger the flow:** *Anyone*.
   - **Request Body JSON Schema:** paste [`webhook-schema.json`](webhook-schema.json).
2. Add a **Condition**: if `test` is `true`, go straight to a **Response** (200). The app's **Send test** button sets `test: true`.
3. Otherwise, **SharePoint → Create item** on the list above, mapping each column to the same-named value under `fields`. Reviewers then work it as in step 5. *Created By* will be the flow's account, not the requester.
4. End with a **Response** action (status 200), so the app knows the submission arrived.
5. Paste the trigger's **HTTP URL** into **Settings → Approval destination → Webhook URL** and click **Send test**.

Besides `fields`, the request body includes:
- `result`: the score breakdown, drivers and conditions;
- `reviewFlags` and `changedFromAi`;
- the complete `assessment`;
- the `policy` name and version.
