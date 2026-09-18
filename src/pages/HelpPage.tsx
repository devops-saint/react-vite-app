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

      {/* Request Lifecycle / Status Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <TimelineIcon color="primary" />
          <Typography variant="h6" fontWeight="bold">
            Request Status
          </Typography>
        </Box>
        <Divider sx={{ mb: 2 }} />
        <Typography variant="body1" paragraph>
          Every request shows one of three statuses, no matter how many
          environments it targets or what&apos;s happening behind the
          scenes:
        </Typography>
        <List>
          <ListItem>
            <ListItemText
              primary="Pending"
              secondary="Received and queued - processing hasn't started yet"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="In Progress"
              secondary="Actively being processed. For a request targeting more than one environment, this covers the whole run - DEV, then QA, then PRD are handled automatically, one after another, with no extra action needed from you"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="Completed"
              secondary="The request has reached its final outcome and nothing further will happen automatically. This also covers a request that was declined or removed during review - either way, you're notified by email with the outcome"
            />
          </ListItem>
        </List>
        <Alert severity="info" sx={{ mt: 2 }}>
          <strong>Note:</strong> A request can occasionally take longer than
          usual to move out of In Progress - it&apos;s still being retried
          automatically in the background and needs no action from you. If
          it stays In Progress for more than a day, contact support below.
        </Alert>
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
