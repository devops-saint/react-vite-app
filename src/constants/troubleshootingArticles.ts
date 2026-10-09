import { config } from '@/config';

/**
 * Built-in troubleshooting articles for the Troubleshooting page. These
 * describe how this portal itself behaves (statuses, validation rules,
 * access scoping), so they ship with the app and are always searched.
 * Extra pages (Confluence, other internal docs, Matillion docs) come from
 * .env - see config.troubleshooting.
 *
 * `keywords` is deliberately full of the other words people use for the
 * same problem ("stuck", "waiting", "not moving"...), because the fuzzy
 * search matches on those as well as the title and summary.
 */
export interface TroubleshootingArticle {
  id: string;
  title: string;
  summary: string;
  keywords: string;
  steps: string[];
  /** In-app route the article's "go there" button opens, if any. */
  path?: string;
  pathLabel?: string;
}

export const TROUBLESHOOTING_ARTICLES: TroubleshootingArticle[] = [
  {
    id: 'request-stuck-queued',
    title: 'My request is stuck in "Queued"',
    summary:
      'Only one request per market is processed at a time, so two requests can never conflict on the same config branches. Yours starts automatically once the earlier one finishes.',
    keywords:
      'queue queued waiting stuck not moving not starting pending behind another request market lock blocked hanging',
    steps: [
      'Open My Requests and look for an earlier request for the same market that is still in progress.',
      'Requests for a market run oldest first. Yours will start by itself when the earlier one is completed, declined or cancelled.',
      'If that earlier request is yours and no longer needed, open it and cancel it.',
      'If nothing earlier is in progress and yours has been queued for a long time, ask an admin to release the market lock from the request\'s details page.',
    ],
    path: config.routes.requests,
    pathLabel: 'Open My Requests',
  },
  {
    id: 'request-pending-aws-verification',
    title: 'Request stays on "Pending AWS verification"',
    summary:
      'After the final pull request merges, the portal checks the real IAM policy of the agent role in AWS before marking the request Completed. That check repeats about every 10 minutes.',
    keywords:
      'pending verification aws verify not completed still in progress taking long slow merged but not done completed iam policy role validation delay waiting',
    steps: [
      'Give it a few check cycles (about 10 minutes each). The request page shows how many times it has been checked.',
      'The check only passes once the merged change has actually been applied in the target AWS account. If the infrastructure pipeline that applies the merge has not run yet, the request keeps waiting.',
      'For a de-whitelist request the check passes when the resources are gone from the role policy; for a whitelist request, when they are present.',
      'If it is still pending after an hour or so, raise a support ticket with the request ID.',
    ],
  },
  {
    id: 'pr-needs-work-or-declined',
    title: 'My pull request needs work or was declined',
    summary:
      'A reviewer asked for changes ("Needs work") or declined the pull request. Reviewer comments are copied onto the request\'s details page.',
    keywords:
      'needs work declined rejected denied changes requested review comments approver feedback pr pull request refused not approved',
    steps: [
      'Open the request and read the reviewer comments shown in the timeline.',
      'If the status is "Needs work", the reviewer expects a change: address the comments with the reviewer, or cancel the request and submit a corrected one.',
      'A declined request is final. Submit a new request with the corrections.',
    ],
    path: config.routes.requests,
    pathLabel: 'Open My Requests',
  },
  {
    id: 'cannot-create-request-access',
    title: 'I can\'t see my market or environment, or Submit is disabled',
    summary:
      'Create Request and View Whitelist only offer the markets and environments your Azure AD group access allows. If your access can\'t be checked, the portal falls back to read-only.',
    keywords:
      'cannot create request submit button disabled greyed out missing market no markets environment not listed dropdown empty access denied permission read only rbac role admin user forbidden',
    steps: [
      'Check the banner at the top of Create Request: it says when your access could not be verified (read-only mode) or when you have no markets assigned.',
      'Refresh the page, or sign out and back in, to retry the access check.',
      'Your role is shown under your initials in the top-right corner and on the Profile page.',
      'If the market you need is missing, ask an admin to add you to the Azure AD group for that market and environment.',
    ],
    path: config.routes.profile,
    pathLabel: 'Open Profile',
  },
  {
    id: 'remove-access-dewhitelist',
    title: 'How do I remove access that is no longer needed?',
    summary:
      'Removing a resource is a "de-whitelist" request. It goes through the same review and promotion pipeline as a whitelist request, but is a separate request.',
    keywords:
      'remove delete revoke dewhitelist de-whitelist whitelist take away undo access no longer needed unwhitelist clean up resource',
    steps: [
      'Open View Whitelist, pick the market, and click the X next to the resource you want removed.',
      'Or open Create Request and switch to De-whitelist mode, then pick existing resources from the list.',
      'Whitelist and de-whitelist changes cannot be combined in a single request.',
    ],
    path: config.routes.whitelist,
    pathLabel: 'Open View Whitelist',
  },
  {
    id: 'resource-name-or-arn-rejected',
    title: 'My bucket name or ARN is rejected',
    summary:
      'Each resource is checked against its AWS format before you can add it. Copying the value straight from the AWS console avoids most typos.',
    keywords:
      'invalid arn format error validation bucket name rejected secret kms key lambda function arn wrong not accepted cannot add resource justification too short characters',
    steps: [
      'S3 bucket: 3 to 63 characters, lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit.',
      'Secrets Manager: arn:aws:secretsmanager:<region>:<12-digit account>:secret:<name>.',
      'KMS key: arn:aws:kms:<region>:<12-digit account>:key/<key id>. Use the key ARN, not an alias.',
      'Lambda: arn:aws:lambda:<region>:<12-digit account>:function:<name>.',
      'The business justification must be at least 20 characters.',
    ],
    path: config.routes.requestsCreate,
    pathLabel: 'Open Create Request',
  },
  {
    id: 'completed-but-no-access',
    title: 'My request is Completed but I still can\'t reach the resource',
    summary:
      'Whitelisting through this portal is only one part of the integration. The resource\'s own policies and your client-side configuration also have to allow the access.',
    keywords:
      'completed done but still cannot access access denied not working permission denied 403 agent role arn matillion connection fails after whitelist resource policy kms key policy bucket policy',
    steps: [
      'Use the agent role ARN shown on the request and on View Whitelist when configuring your side.',
      'Check that the resource itself (bucket policy, KMS key policy, secret resource policy) allows that role.',
      'Check the Matillion documentation for the client-side configuration steps.',
      'If everything above is in place, raise a support ticket with the request ID and the exact error.',
    ],
    path: config.routes.whitelist,
    pathLabel: 'Open View Whitelist',
  },
  {
    id: 'cancel-a-request',
    title: 'How do I cancel a request?',
    summary:
      'You can cancel your own request until its first merge into the DEV branch. After that it can no longer be cancelled.',
    keywords:
      'cancel withdraw abort stop delete request mistake wrong submitted by mistake undo cancel button missing',
    steps: [
      'Open the request from My Requests and use the Cancel button, with an optional reason.',
      'The Cancel button disappears once the request has merged to DEV. To undo access after that, submit a de-whitelist request.',
    ],
    path: config.routes.requests,
    pathLabel: 'Open My Requests',
  },
  {
    id: 'whitelist-view-empty',
    title: 'View Whitelist shows nothing for my market',
    summary:
      'The whitelist is loaded per market, with one tab per environment. A market or environment that has no configuration yet shows as empty.',
    keywords:
      'whitelist empty blank nothing shown no resources not loading current whitelist missing view tab environment market not found',
    steps: [
      'Make sure a market is selected, then check each environment tab (DEV, QA, PRD).',
      'You only see the markets and environments your access allows.',
      'A resource only appears for an environment once its pull request for that environment has merged.',
    ],
    path: config.routes.whitelist,
    pathLabel: 'Open View Whitelist',
  },
  {
    id: 'no-notification-email',
    title: 'I didn\'t get an email about my request',
    summary:
      'Requesters are emailed when their request completes, and approvers when a pull request needs review. Emails come from a no-reply address.',
    keywords:
      'email notification not received no email mail missing spam junk inbox notify approver requester alert',
    steps: [
      'Check your spam or junk folder for a message from the portal\'s no-reply address.',
      'The request\'s details page always shows the current status, whether or not an email arrived.',
      'If emails never arrive for anyone, an admin should check that the portal\'s sender domain is configured.',
    ],
  },
];
