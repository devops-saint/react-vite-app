# DPC Self-Service Whitelisting Portal - Demo Talk

**Audience:** large group plus stakeholders (business, platform, security, delivery)
**Time:** about 25 to 30 minutes, plus questions
**Style:** simple English, spoken style. Read it like you are talking, not like you are reading.

`[Show: ...]` lines tell you what to show on screen. `[Pause]` means stop for a second and look at the audience.

---

## 0. Before you start (checklist for the presenter)

- Login once before the session, so the Microsoft sign-in is already done.
- Keep one market ready where you have permission (for example `UK`) and one old completed request to show the timeline.
- Keep the View Whitelist page and the Create Request page open in two tabs.
- If you want to show the admin part, sign in with an admin account in a second browser window.
- Do not submit a real request on a market that other teams are using. Use a test market, or cancel the request after the demo.

---

## 1. Opening

Good afternoon everyone.

Today I will show you our new **DPC Self-Service Whitelisting Portal**. In short, this is the portal where user can ask for access to their AWS resources to be accessed from dpc pipeline, and the whole process then runs by itself.

I will show you what the user sees, what happens behind the screen, and what we get out of it. At the end we will have time for questions.

---

## 2. The problem we had

First, let me tell you why we built this.

Earlier, when a market needed the Matillion agent to reach an S3 bucket, a secret, a KMS key or a Lambda function, the process was like this:

1. Raise a ticket.
2. L2 team manually clones the config repository and edits a YAML file and then raises a pull request to dev.
4. The approver reviews it and then terraform run applies
5. The PR gets raised for QA and again for production.

So there were a few problems. It took more time. Small typos happened in ARNs. Two people edited the same file and got merge conflicts. And the requester always had to ask, "What is the status of my request?"

[Pause]

So our idea was simple: **let the user ask in one form, and let the system do the rest, with proper approval and proper tracking.**

---

## 3. What is the portal, in one minute

The portal is a web application. The user signs in with the pmi account using sso login.

Behind the screen, three things happen:

- The portal saves the request and tracks the status.
- It creates a **pull request** in the config repository (Bitbucket), so every change is reviewed by the approvers. Nothing goes live without approval.
- After the change is merged in every environment, the portal **checks inside AWS** that the access is really there, and only then marks the request as completed.

So we always keep **Git as the source of truth** and we keep **approval in place**. The portal only removes the manual work.

---

## 4. Sign in and what you see first

[Show: Login page, then Dashboard]

Okay, so first the user signs in with the pmi account sso.

Once you are in, the portal checks who you are and what you are allowed to do. This comes from your Azure AD group. Based on that, you get one of three roles:

- **User:** can work only on the markets and environments given to them.
- **Developer:** can see every market and environment, but cannot do admin actions.
- **Admin:** can do everything, including recovery actions and onboarding a new market.

If the portal cannot confirm your access for some reason, it does not guess. It becomes **read-only** and shows a message. This is a safety choice. We prefer safe over open.

Now this is the Dashboard. Here you can see your requests in numbers, which are in progress, which are completed, and your recent activity. Basically, it is your starting point.

---

## 5. Create a request - step by step

[Show: Create Request page]

Now let me show the main thing, the Create Request page.

### Step 1: Choose the market

First, I choose the market. You will see only the markets you have access to.

One important point here. This market list is **not typed by hand anywhere**. The portal reads the folder names from the config repository. Each market has one folder in the repo, and that folder name is the market code. So when a new market is added in the repo, it appears here automatically. No code change, no redeploy.

### Step 2: See what is already whitelisted

Once I select the market, see, the page now shows what is **already whitelisted** for this market. This is read live from the repository, for DEV, QA and PRD.

This is very useful, because you can quickly check, "Is my bucket already there?" before you ask for it. If you try to add something which is already whitelisted, the portal tells you, "This is already whitelisted. No need to request again."

### Step 3: Add what you need

Now I add the resources. We support four types:

- S3 buckets
- Secrets Manager secrets
- KMS keys
- Lambda functions

I type or paste the name or ARN and add it. The portal checks the format on the spot. For example, a bucket name should follow the AWS rules, and a secret should be a proper secret ARN. So a wrong ARN is caught here itself, not after three days.

I can do this for DEV, QA and PRD using the tabs. One request can cover all three environments.

### Step 4: Remove what you do not need - in the same request

Now this is a nice feature. Below the input box, you can see the list of **currently whitelisted** resources. Next to each one, there is a **cross mark**.

If I click the cross, that resource is marked for removal. It gets a strike-through and a small chip, "Will be removed". If I click by mistake, there is an undo button.

So in **one single request** I can add new resources and also remove old resources. Earlier, these were two different requests. Now it is one. The button text changes by itself: "Submit whitelist request", "Submit de-whitelist request", or "Submit whitelist + de-whitelist request". And the summary shows how many I am adding and how many I am removing.

### Step 5: Policy preview

Before I submit, I can click **Policy preview**. It shows what permissions will be given for these resources, for example `s3:GetObject` and `s3:ListBucket` for a bucket. So the requester and the reviewer both know exactly what access means.

### Step 6: Business justification

Then I write the business justification, why I need this. There is no character limit. Just write the reason clearly, so the approver can decide fast.

### Step 7: Submit

[Show: click Submit]

I click submit. That's it. The user's work is done here. Now the system takes over.

---

## 6. What happens after submit (the behind-the-screen story)

Let me explain this in simple steps. You can see the same steps on the screen in the request timeline.

1. **Request received.** The portal saves the request and gives it an ID like `REQ-1A2B3C4D`.

2. **Queue check, per market.** Now, a small but important thing. If another request for the **same market** is already running, your request waits in a queue. Status is `QUEUED`. The reason is simple: two requests for the same market change the same config file, and they can conflict. So we run one request per market at a time, and the next one starts automatically when the first is finished. Different markets run in parallel, no problem.

3. **Branch and pull request.** The portal creates a branch for your request in the repo, updates the right YAML files for your market and environments, and raises a **pull request** to `dev`. The approvers get an email with the link.

4. **Approval and merge.** The approvers review the pull request. This is the human control. When they merge, the portal knows about it automatically.

5. **Promotion to QA and PRD.** If your request also has QA and PRD, the portal then raises the next pull request, from dev to qa, and then from qa to master. Each one is again reviewed and merged. If many requests of the same market reach the same stage together, they ride on one promotion pull request, so there is no duplicate noise.

6. **AWS verification.** Now see, merging in Git does not mean the access is live. So the portal waits. It periodically goes into the target AWS account, reads the real IAM policy of the Matillion agent role, and checks: are my resources really there? If I asked for removal, are they really gone? Only when everything matches, the status becomes **Completed**.

7. **Email to requester.** When it is completed, the requester gets an email.

[Pause]

So the "completed" in our portal does not mean "somebody merged something". It means **"verified in AWS"**. I think this is a big difference.

---

## 7. Track your request

[Show: My Requests, then open one request]

Now the user does not need to ask anybody for status.

In **My Requests**, you see all your requests with status. Open any one, and you see the **timeline**: received, PR created, approved, merged to dev, waiting for qa, and so on. Each step has a time and the PR number.

If your request is waiting in the queue, the page tells you **which request is blocking it**. So no confusion.

You can also **cancel** a request, but only until it is merged to dev. After that, other environments may already be moving with other teams' requests, so we do not allow cancel. The portal explains this clearly.

For admins, there are also **PR links** on these pages, so they can jump to Bitbucket directly.

---

## 8. View Whitelist

[Show: View Whitelist page]

This page is for anybody who just wants to **see** what is whitelisted. Choose the market, and you get DEV, QA and PRD side by side. It is read live from the repository, so it is always current.

You can also copy the **Matillion agent role ARN** with one click. Many teams ask for this ARN, so we kept it right here.

If you want to remove something from here, there is a de-whitelist option also. It creates the same kind of request with the same approval.

---

## 9. Help when something is not working

[Show: Troubleshoot page]

Now, every support team knows this, same questions come again and again. "My request is stuck." "My ARN is not accepted." "Why is it still pending?"

So we built a **Troubleshooting page**. You just type your problem in your own words, like "my request is waiting since two days", and the search finds the right article. It even works if you have small spelling mistakes.

It searches three places:

- The portal's own built-in articles.
- Our internal documents and Matillion documents.
- The **Confluence pages** of our team. These pages are inside the company and need a service account to read. So the **backend reads them using a service account** whose password is safely stored in AWS Secrets Manager. The browser never sees the credentials. The user just gets the answer.

And if the article does not solve the problem, there is a button to **raise a support ticket**.

Next to it, we have a **Q&A forum**. Anybody can ask a question, and admins answer. Questions and answers are visible to all, so the next person does not need to ask again. When a new question comes, the admins get an email, and when it is answered, the asker gets an email.

---

## 10. For admins

[Show: admin window]

Now a few things only for admins.

**Onboard a new market.** Earlier, adding a new market meant somebody creating folders and files by hand in four places. Now the admin opens **Onboard Market**, types the market code, and clicks the button. The portal creates the market folder with four files: `values.yaml`, `values.dev.yaml`, `values.qa.yaml` and `values.prd.yaml`. And it raises a pull request for each of dev, qa and master, so the approvers still review everything. After the dev pull request is merged, the market appears in the market list for everybody.

**Release a stuck lock.** If some request gets stuck because the pull request was handled outside the portal, the admin can release the market queue with one click.

**Retry promotion.** If a promotion pull request was not created for some reason, the admin can retry it.

And we also have two kinds of senior roles: **admins** and **developers**. A developer can see everything, but cannot do these admin actions. This list of real admins is controlled by one configuration, `portal_admin_emails`.

---

## 11. Safety and reliability

Let me say a few words on this, because I know many of you will think about it.

- **Approval is always there.** Every change in the config repo goes through a pull request. The portal never writes directly to a main branch.
- **Git is the record.** Who asked, what they asked, who approved, when it was merged. All of it is saved.
- **Least access.** The portal reads the agent role policy using a separate, read-only role, called the validator role, which is created in each AWS account (DEV, QA, PRD). It can only read IAM details of the Matillion agent roles. It cannot change anything.
- **Secrets are not in code.** The Bitbucket token and the Confluence service account are stored in AWS Secrets Manager. Only the specific Lambda that needs a secret has permission to read it.
- **If Bitbucket is down.** The portal retries by itself. If it still fails, the request is marked as sync failed, and an automatic job tries again every ten minutes, a limited number of times. Nobody needs to resubmit.
- **One request per market.** No clashing changes.
- **If access cannot be confirmed, it is read-only.** Safe default.

One honest point also: right now the portal's API does not do its own sign-in check on the server side. The user signs in on the browser, and the portal uses that identity. Stronger server-side authentication is on our roadmap. I am mentioning this so that there are no surprises later.

---

## 12. What we gain

To summarize the benefits:

- **Faster.** The requester finishes in a few minutes. The waiting time is only for approvals.
- **Fewer mistakes.** The format of every ARN is checked, and AWS itself is checked at the end.
- **Clear status.** Anybody can see where the request is. No more follow-up mails.
- **Safe.** Approval, history and least-access are all there.
- **Less manual work for the platform team.** They only review, they do not type.
- **Self-help.** Troubleshooting and Q&A reduce repeat questions.

---

## 13. Quick recap

[Pause]

So if I tell the whole story in four lines:

1. The user asks in one form, to add and remove in one go.
2. The portal creates the pull request and the approvers approve.
3. The change moves from dev to qa to production.
4. The portal checks inside AWS, and then says "Completed".

---

## 14. What is next

Some things we are planning next:

- Stronger server-side authentication for the API.
- More notifications for approvers and requesters.
- More self-service for admin tasks.
- More reports on how long requests take.

If you have other ideas, please tell us. We will add them to the list.

---

## 15. Closing

That's all from my side. Thank you for your time, and thank you to everyone who helped to build and test this.

I am happy to take your questions now.

---

## 16. Questions people usually ask (keep these answers ready)

**Q: Does the portal give access directly in AWS?**
No. The portal only changes the config in Git, after approval. The Matillion agent setup picks it up from there. Then the portal verifies the result in AWS.

**Q: Who approves the requests?**
The approvers who review pull requests in Bitbucket. The list of approvers who get the email is a configuration in the portal's infrastructure code.

**Q: What if two teams request for the same market at the same time?**
The second request waits in the queue and starts automatically after the first one finishes. Different markets do not wait for each other.

**Q: Can I undo a request?**
You can cancel until it is merged to dev. After that, you can raise a new request to remove the resource.

**Q: How long does it take?**
Our part is a few minutes. The remaining time depends on how fast the approvers review the pull requests, and on the verification check, which runs every ten minutes.

**Q: What if the verification never completes?**
The request stays in "pending AWS verification" and the portal records every attempt and the reason. Usually it means the agent has not yet picked up the new config, or the validator role is not set for that environment. An admin or the platform team can then check.

**Q: Where do the markets come from?**
From the folders in the config repository. To add one, an admin uses the Onboard Market page.

**Q: Can anybody see the Confluence page content?**
The portal shows only short text from the pages that the team has configured for the Troubleshooting page. The credentials are never sent to the browser.

**Q: Is anything stored outside AWS?**
Requests, history and Q&A are stored in a DynamoDB table in our AWS account. The config lives in Bitbucket.

**Q: What if Bitbucket or AWS is down?**
The portal retries by itself and keeps the request in a clear failed or pending status. Nothing is lost.
