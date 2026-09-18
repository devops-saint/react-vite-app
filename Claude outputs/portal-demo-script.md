# DPC Self-Service Whitelisting Portal — Demo Script

A step-by-step talk-through for a mixed audience (Product Owner, Scrum Master, Manager, Lead, and the team). Written the way you'd actually speak it — read it once before the demo so it flows naturally, you don't have to follow it word for word.

**Suggested length:** 15–20 minutes demo + 5–10 minutes questions.

**Before you start:** log in fresh (so you can show the login step), have one market/environment ready that has nothing whitelisted yet (for a clean Create Request demo), and know whether you'll be logged in as Admin or not — decide that before, don't fumble with the Settings unlock live.

---

## 0. Opening (1 minute)

*Say something like:*

"Good morning everyone, thanks for joining. So today I want to walk you through the Self-Service Whitelisting Portal — this is the tool we've built so that whitelisting AWS resources for a market, which used to be a manual, back-and-forth process, is now something anyone on the team can do themselves in a few clicks.

Quickly, the old way: if a market needed an S3 bucket or a secret whitelisted, someone had to manually edit a config file, raise a pull request, get it reviewed, and then repeat that same thing again for QA, again for production. Lot of manual steps, lot of waiting, and honestly, lot of scope for mistakes.

What I'll show you today is the new way — how a request goes in, how it moves automatically, and how anyone can track it without having to ping someone on Slack asking 'what's the status.' Let's get into it."

---

## 1. Login (30 seconds — don't linger here)

*Say:*

"So first, login is through our normal company SSO — Azure AD. Nothing new to learn here, same credentials you already use everywhere else."

*Do:* Log in, land on the Dashboard.

---

## 2. The Dashboard (2 minutes)

*Say:*

"So this is the landing page — the Dashboard. The first thing you notice is these four cards up top: Pending, Approved, Rejected, Completed. These are counting *my* requests, grouped by where they are in the pipeline.

And here's a small but nice touch — these cards are clickable. So if I click on Pending..."

*Do:* Click the Pending card.

"...it takes me straight to My Requests, already filtered to exactly what that card was counting. So there's no separate filtering to do — the number and the list are always in sync, by design."

*Say (turning to Scrum Master / Manager):*

"This is actually useful for tracking — instead of asking in standup 'where is that whitelisting request', anyone can just open this and see it themselves. Full visibility, no manual status updates needed from anyone."

*Do:* Go back to Dashboard, point at Recent Requests table.

"And below that, Recent Requests — a quick table of what's been happening lately."

---

## 3. Raising a request — Create Request (5 minutes, this is the main event)

*Say:*

"Now let's actually raise a request — this is the core of the tool, so let me walk through it properly."

*Do:* Click Create Request.

"First thing you'll notice — nothing on this page works until I pick a market. That's intentional, so nobody accidentally fills in resources against the wrong market."

*Do:* Select a market from the dropdown.

"Once I select the market, the rest of the page lights up. Now I have three tabs — DEV, QA, PRD. Each one is independent, so what I type in DEV doesn't spill over into QA — earlier this used to carry over by mistake, we've fixed that."

*Do:* Stay on DEV tab, add a resource — e.g. type an S3 bucket name and click Add.

"Say I want to whitelist an S3 bucket. I type the name, hit Add... and it's added to the list. Same thing for Secrets Manager, KMS keys, Lambda functions — four resource types, each with its own little card, and yes, we've colour-coded them to match AWS's own console colours for each service, just to make it visually easier to scan."

*Do (optional, if time permits):* Try adding a resource that's already whitelisted.

"One more small thing — if I try to add something that's already whitelisted for this market and environment, it tells me right away, instead of letting me raise a duplicate request. Saves the reviewer's time on the other side too."

*Do:* Fill business justification, submit.

"Last thing — a business justification, just a line on why this is needed, and submit."

*Say (turning to Product Owner / Manager):*

"So from the user's side, that's it. Two minutes, done. Everything else — creating the branch, committing the change, opening the pull request — happens automatically in the background."

---

## 4. What happens after you submit (2 minutes — no clicking, just explain)

*Say:*

"Now, this is the part people usually find interesting — what actually happens behind the scenes.

The moment I submit, the system automatically creates a branch, commits the change into the right config file, and opens a pull request for review. I don't touch the repository at all, and neither does the reviewer need to go looking for it — it's all automatic.

Once that pull request is approved and merged into DEV, if I'd also asked for QA or PRD, the system automatically opens the *next* pull request — DEV to QA, then QA to PRD — one after another, on its own. So one request, if it covers all three environments, actually drives three pull requests in sequence, and I don't have to do anything for that to happen."

*Say (turning to Lead):*

"For the technical folks — this whole thing is built on Lambda functions and DynamoDB, with proper locking so that two requests for the same market can never clash with each other. If a second request comes in for a market that already has one in progress, it's simply queued and starts automatically once the first one finishes — no manual conflict resolution needed."

---

## 5. Tracking a request — My Requests and Request Details (3 minutes)

*Do:* Go to My Requests, open the request you just submitted (or a slightly older one that's progressed further).

*Say:*

"So here's where I can track everything I've raised. Let me open one."

*Do:* Click into a request.

"On this page — market code and market name are shown separately now, so there's no ambiguity. And down here, a full status timeline — every stage it's passed through, PR created, approved, merged, and so on."

*Say:*

"One status that sometimes comes up is 'Sync Failed' — that just means the automated step couldn't reach Bitbucket at that moment, usually something temporary. The system automatically retries this every ten minutes on its own, so nine times out of ten, nobody needs to do anything — it just resolves itself."

*Do (only if logged in as Admin, and only if a suitable request is available):*

"If I'm logged in as an admin, and something's genuinely stuck — say a request is queued behind another one that's clearly dead, or a promotion PR never opened — there are two recovery buttons here, Force Release Lock and Retry Promotion. These are admin-only, exactly for those edge cases."

---

## 6. Seeing what's already whitelisted — View Whitelist (2 minutes)

*Do:* Go to View Whitelist from the sidebar.

*Say:*

"Now this page answers a different question — not 'what did I request', but 'what is actually live right now' for a given market and environment. So I select a market, select an environment..."

*Do:* Pick a market and environment that has data.

"...and it shows me everything that's currently whitelisted — buckets, secrets, KMS keys, Lambda functions — read live from the actual config file, colour-coded the same way as before. Full ARNs shown, nothing truncated, so if someone needs to copy-paste one, they can.

This is handy before raising a new request too — quick check, 'is this already there', before going through the whole form."

---

## 7. Wrap-up (1–2 minutes)

*Say:*

"So to sum up — what used to be a manual, multi-step, back-and-forth process is now: pick a market, add what you need, submit, and the system takes care of the branch, the PR, the review routing, and the promotion across environments, all on its own. And at every step, anyone can see exactly where things stand, without having to ask around.

That's the demo — happy to take any questions."

---

## If they ask... (presenter's own notes — not part of the spoken demo)

Keep this handy for Q&A. Answer honestly and briefly; don't oversell.

**"Is this secure? Can just anyone submit for any market?"** — Login is real (Azure AD), but today the backend doesn't yet verify who's calling at the API level, and there's no restriction yet on which markets a user can submit for. We have a concrete plan ready to close the first gap (using our existing Azure AD setup, no new infrastructure needed), and the second one is waiting on a decision from the identity team about where the market-to-user mapping should live. Both are tracked, neither is a surprise to us.

**"Is this tested?"** — Every change has been verified through type-checking, linting, and manual scenario testing so far. There isn't yet an automated test suite, and that's an acknowledged next step, not something we're hiding.

**"What if two people request the same market at the same time?"** — Exactly the queueing behaviour shown in step 4 — the second one waits and starts automatically once the first finishes. No manual conflict handling needed.

**"Who can see what?"** — Everyone can see their own requests and the current whitelist. A few recovery actions (force-release a stuck lock, retry a stuck promotion, PR links) are limited to Admins.

**"What's next on the roadmap?"** — Closing the two security items above are the priority, followed by building out the automated test suite.
