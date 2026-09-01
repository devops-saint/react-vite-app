# Request API infrastructure

**Full setup guide (fast-path script + manual steps + UI setup): see [`SETUP.md`](./SETUP.md).**

This Terraform stack provisions an API Gateway HTTP API, one Python Lambda function, and a DynamoDB table for the whitelist portal.

The HTTP API uses an explicit `$default` stage with automatic deployments. Its invoke URL intentionally has no `/dev` or `/prod` path segment.

| UI action | API route | Storage behavior |
| --- | --- | --- |
| Submit a request | `POST /request` | Stores the original API payload in DynamoDB |
| View My Requests | `GET /listrequests` | Returns the list shape consumed by `requestService` |
| View request details | `GET /requests/{requestId}` | Returns the detail shape consumed by `RequestDetailsPage` |

## Deploy

```bash
cd terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

API Gateway has an HTTP API CORS policy. Copy `terraform.tfvars.example` to `terraform.tfvars` and include every browser origin that will call the API. Before deploying outside development, supply the exact site origin, for example:

```bash
terraform apply -var='cors_allow_origins=["https://portal.example.com"]'
```

For the local portal currently running at `http://localhost:3000`, apply the stack with the default policy (or include that origin in your `terraform.tfvars`):

```bash
terraform apply -var='cors_allow_origins=["http://localhost:3000","http://localhost:5173"]'
```

The current frontend deliberately uses an unauthenticated API client. Add an authorizer (such as JWT or Lambda authorizer) before exposing this API publicly.

## Notes

- DynamoDB uses pay-per-request billing, server-side encryption, and point-in-time recovery.
- The list handler queries the `submitted-by-created-at` index so each dashboard and My Requests view retrieves only that submitter's requests.
- Requests are indexed by the submitting user ID, and the UI passes that ID for list and detail requests. This provides per-user views, but it is not a security boundary until the API validates identity with an API Gateway authorizer.
- Terraform creates `terraform/.build/request_api.zip` locally during planning. It is ignored by the supplied `.gitignore`.
