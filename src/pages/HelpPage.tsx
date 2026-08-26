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
        Learn how to use the AWS Self-Service Whitelisting Portal
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
          The AWS Self-Service Whitelisting Portal enables developers and teams
          to submit requests for AWS resource access in a streamlined and
          automated manner. This portal simplifies the process of requesting
          access to S3 buckets, Secrets Manager secrets, and KMS keys across
          different environments.
        </Typography>
        <Typography variant="body1">
          All requests are automatically processed through a GitOps workflow,
          creating pull requests in the configured repository for review and
          approval by the infrastructure team.
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
              primary="2. Fill in Application Information"
              secondary="Provide your market code, application name, and business justification (minimum 20 characters)"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="3. Enter AWS Account Information"
              secondary="The AWS region (eu-west-1) is pre-configured for whitelist requests"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="4. Configure Environments"
              secondary="Add one or more environments (DEV, QA, PRD) and specify the AWS resources needed for each"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="5. Add Resources"
              secondary="For each environment, add S3 bucket names, Secrets Manager ARNs, and/or KMS Key ARNs as needed"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="6. Review and Submit"
              secondary="Review all details carefully before submitting. Once submitted, requests cannot be modified"
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
          After you submit a request, it goes through the following automated
          workflow:
        </Typography>
        <List>
          <ListItem>
            <ListItemText
              primary="SUBMITTED"
              secondary="Your request has been received and is queued for processing"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="BRANCH_CREATED"
              secondary="A new branch has been created in the repository with your changes"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PULL_REQUEST_CREATED"
              secondary="A pull request has been created for review by the infrastructure team"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PENDING_APPROVAL"
              secondary="The pull request is awaiting review and approval from authorized approvers"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="MERGED"
              secondary="The pull request has been approved and merged into the main branch"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="COMPLETED"
              secondary="The changes have been deployed and your resources are now whitelisted"
            />
          </ListItem>
        </List>
        <Alert severity="warning" sx={{ mt: 2 }}>
          <strong>Note:</strong> Requests may also be marked as REJECTED if they
          don&apos;t meet security or compliance requirements. You&apos;ll
          receive feedback in the request comments.
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
              primary="SUBMITTED"
              secondary="Initial status when a request is created"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="BRANCH_CREATED"
              secondary="Git branch created with configuration changes"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PULL_REQUEST_CREATED"
              secondary="Pull request opened for review"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="PENDING_APPROVAL"
              secondary="Awaiting approval from infrastructure team"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="MERGED"
              secondary="Changes merged and ready for deployment"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="COMPLETED"
              secondary="Resources successfully whitelisted"
            />
          </ListItem>
          <ListItem>
            <ListItemText
              primary="REJECTED"
              secondary="Request denied - check comments for details"
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
