import {
  Container,
  Typography,
  Paper,
  Box,
  Divider,
  List,
  ListItem,
  ListItemText,
  Alert,
} from '@mui/material';
import InfoIcon from '@mui/icons-material/Info';
import TimelineIcon from '@mui/icons-material/Timeline';
import ContactSupportIcon from '@mui/icons-material/ContactSupport';

export function HelpPage() {
  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Typography variant="h4" fontWeight="bold" gutterBottom>
        Help & Documentation
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Learn how to use the DPC Self-Service Whitelisting Portal
      </Typography>

      {/* Purpose Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <InfoIcon color="primary" />
          <Typography variant="h6" fontWeight="bold">
            Purpose of the Portal
          </Typography>
        </Box>
        <Divider sx={{ mb: 2 }} />
        <Typography variant="body1" paragraph>
          The DPC Self-Service Whitelisting Portal enables teams to submit
          requests for AWS resource access in a streamlined, automated
          manner. This portal simplifies the process of requesting access to
          S3 buckets, Secrets Manager secrets, KMS keys, and Lambda functions
          across the DEV, QA, and PRD environments.
        </Typography>
        <Typography variant="body1">
          Every request is processed through an automated GitOps workflow: a
          pull request is opened against the config repository for the DEV
          environment, and once it&apos;s reviewed and merged in Bitbucket the
          same change is automatically promoted through QA and on to PRD via
          follow-on pull requests &mdash; no manual re-submission needed.
        </Typography>
      </Paper>

      {/* How to Submit Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" fontWeight="bold" gutterBottom>
          How to Submit a Whitelist Request
        </Typography>
        <Divider sx={{ mb: 2 }} />
        <List>
          <ListItem>
            <ListItemText
              primary="1. Navigate to Create Request"
              secondary="Click on 'Create Request' in the sidebar menu"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="2. Select your market"
              secondary="Choose your market from the dropdown; the market name fills in automatically"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="3. Add a business justification"
              secondary="Explain why the access is needed (minimum 20 characters)"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="4. Stage resources per environment"
              secondary="Switch between the DEV, QA, and PRD tabs and add S3 bucket names, Secrets Manager ARNs, KMS Key ARNs, and/or Lambda function ARNs for each environment that needs access"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="5. Review and submit"
              secondary="Review all details carefully before submitting. Once submitted, requests cannot be edited"
            />
          </ListItem>
        </List>
      </Paper>

      {/* Request Lifecycle Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <TimelineIcon color="primary" />
          <Typography variant="h6" fontWeight="bold">
            Request Lifecycle
          </Typography>
        </Box>
        <Divider sx={{ mb: 2 }} />
        <Typography variant="body1" paragraph>
          After you submit a request, it moves through the following
          automated workflow. A request that only targets DEV completes
          after one merge; a request that also targets QA and/or PRD is
          promoted automatically, one environment at a time.
        </Typography>
        <List>
          <ListItem>
            <ListItemText
              primary="Request received"
              secondary="Your request has been received and queued for processing"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="Pull request opened"
              secondary="A branch and pull request have been created in Bitbucket for the DEV environment"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="Pull request reviewed"
              secondary="Approvers review the pull request in Bitbucket; it may be approved, sent back for changes, or declined"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="Merged and promoted"
              secondary="Once merged, the change is automatically opened as a new pull request against the next environment (DEV → QA → PRD) and the cycle repeats"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="Completed"
              secondary="The pull request into your final target environment has merged and the resources are whitelisted"
            />
          </ListItem>
        </List>
        <Alert severity="info" sx={{ mt: 2 }}>
          <strong>Note:</strong> There&apos;s no separate manual approval step
          in the portal itself &mdash; approval happens on the pull request in
          Bitbucket. If a sync step fails (for example, a transient Bitbucket
          error), the portal automatically retries it on a schedule, so a
          request can briefly show as failed before recovering on its own.
        </Alert>
      </Paper>

      {/* Status Definitions Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" fontWeight="bold" gutterBottom>
          Status Definitions
        </Typography>
        <Divider sx={{ mb: 2 }} />
        <List>
          <ListItem>
            <ListItemText
              primary="REQUEST_RECEIVED"
              secondary="Initial status when a request is created"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PR_CREATED"
              secondary="A pull request has been opened in Bitbucket for the current environment"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PR_UPDATED"
              secondary="The open pull request received a new commit or update"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PR_APPROVED"
              secondary="An approver has approved the pull request"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PR_NEEDS_WORK"
              secondary="A reviewer requested changes before the pull request can be merged"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PR_DECLINED / PR_DELETED"
              secondary="The pull request was closed without merging or was removed &mdash; the request will not progress further; contact support if this wasn't expected"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="{ENV}_MERGED_AWAITING_{NEXT_ENV}"
              secondary="For example DEV_MERGED_AWAITING_QA: the pull request for that environment merged, and the automatic promotion pull request into the next environment is being opened"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="COMPLETED"
              secondary="The pull request into your final target environment has merged &mdash; resources are whitelisted"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="SYNC_FAILED"
              secondary="An automated step (branch, PR, or promotion) hit an error. The portal retries this automatically on a schedule; it usually clears on its own within a few retry cycles"
            />
          </ListItem>
        </List>
      </Paper>

      {/* Support Section */}
      <Paper sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <ContactSupportIcon color="primary" />
          <Typography variant="h6" fontWeight="bold">
            Support & Contact
          </Typography>
        </Box>
        <Divider sx={{ mb: 2 }} />
        <Typography variant="body1" paragraph>
          If you need assistance or have questions about the whitelisting
          process:
        </Typography>
        <List>
          <ListItem>
            <ListItemText
              primary="Email Support"
              secondary="infrastructure-support@company.com"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="Slack Channel"
              secondary="#aws-infrastructure-support"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="Documentation"
              secondary="https://docs.company.com/aws-whitelisting"
            />
          </ListItem>
        </List>
        <Alert severity="info" sx={{ mt: 2 }}>
          <strong>Tip:</strong> For faster resolution, include your Request ID
          when contacting support.
        </Alert>
      </Paper>
    </Container>
  );
}
