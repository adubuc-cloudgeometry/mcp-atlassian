# MCP Atlassian — AWS CDK Deployment

Deploy the mcp-atlassian server to AWS ECS Fargate with Secrets Manager for credential storage.

## Architecture

```
LangBuilder (existing VPC or external)
    │
    │ port 9000 (private subnet, no public IP)
    ▼
┌──────────────────────────────────────┐
│ ECS Fargate Task                     │
│  mcp-atlassian container             │
│  0.25 vCPU / 512 MB                 │
│  Env vars from Secrets Manager       │
│  Service Discovery: atlassian.mcp.internal │
└──────────────┬───────────────────────┘
               │ HTTPS (outbound via NAT)
               ▼
        Atlassian Cloud APIs
```

## Cost Estimate

| Item | Monthly Cost |
|------|-------------|
| Fargate (0.25 vCPU + 512MB, always-on) | ~$9.50 |
| Secrets Manager (1 secret) | $0.40 |
| NAT Gateway | ~$3.50 + data |
| ECR (<1GB) | ~$0.10 |
| CloudWatch Logs | ~$0.50 |
| Cloud Map (service discovery) | ~$0.10 |
| **Total** | **~$14/month** |

If deployed into an existing VPC with a NAT gateway, subtract ~$3.50.

## Prerequisites

- AWS CLI configured (`aws configure`)
- Node.js 18+
- CDK bootstrapped: `cd cdk && npx cdk bootstrap`

## Deploy

```bash
cd cdk
npm install

# First deployment — creates infrastructure + placeholder secret
npx cdk deploy

# Update the secret with real Atlassian credentials
aws secretsmanager put-secret-value \
  --secret-id mcp-atlassian/credentials \
  --secret-string '{
    "JIRA_URL": "https://your-domain.atlassian.net",
    "JIRA_USERNAME": "user@company.com",
    "JIRA_API_TOKEN": "your-token",
    "CONFLUENCE_URL": "https://your-domain.atlassian.net/wiki",
    "CONFLUENCE_USERNAME": "user@company.com",
    "CONFLUENCE_API_TOKEN": "your-token"
  }'

# Force service to pick up new secret values
aws ecs update-service \
  --cluster mcp-atlassian-cluster \
  --service mcp-atlassian \
  --force-new-deployment
```

## Deploy into Existing LangBuilder VPC

```bash
npx cdk deploy -c existingVpcName=langbuilder-vpc
```

This reuses the LangBuilder VPC and NAT gateway, saving ~$3.50/month.

## Configuration

| Context Variable | Default | Description |
|-----------------|---------|-------------|
| `existingVpcName` | `null` | Import existing VPC by name instead of creating a new one |
| `allowedCidr` | `10.0.0.0/16` | CIDR range allowed to access the MCP server on port 9000 |

## Debugging

```bash
# Check service status
aws ecs describe-services --cluster mcp-atlassian-cluster --services mcp-atlassian

# View logs
aws logs tail /ecs/mcp-atlassian --follow

# Shell into running container
aws ecs execute-command \
  --cluster mcp-atlassian-cluster \
  --task <task-id> \
  --container mcp-atlassian \
  --interactive \
  --command "/bin/sh"
```

## Destroy

```bash
npx cdk destroy
```

Note: The ECR repository is retained on destroy (RemovalPolicy.RETAIN) to prevent accidental image loss. Delete it manually if needed.
