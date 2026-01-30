# MCP Atlassian Server — AWS Deployment Onboarding

Deploy an [mcp-atlassian](https://github.com/sooperset/mcp-atlassian) server to your own AWS account using ECS Fargate. This gives LangBuilder (or any MCP client) access to JIRA and Confluence via the Model Context Protocol.

## Architecture

```
LangBuilder / MCP Client
    │
    │ JSON-RPC over HTTP, port 9000
    │ (private subnet, no public IP)
    ▼
┌──────────────────────────────────────┐
│ ECS Fargate Service                  │
│  mcp-atlassian container             │
│  0.25 vCPU / 512 MB                 │
│  Env vars from Secrets Manager       │
│  Health check: /healthz              │
│  Transport: streamable-http          │
│  Service Discovery:                  │
│    atlassian.mcp.internal:9000       │
└──────────────┬───────────────────────┘
               │ HTTPS (outbound via NAT Gateway)
               ▼
        Atlassian Cloud APIs
        (JIRA + Confluence)
```

**What gets created:**

| Resource | Purpose |
|----------|---------|
| VPC (2 AZs, public + private subnets) | Network isolation. Skipped if you supply `existingVpcName` |
| NAT Gateway | Allows private-subnet container to reach Atlassian APIs |
| ECS Cluster (Fargate) | Runs the mcp-atlassian container |
| ECR Repository | Stores the Docker image |
| Secrets Manager Secret | Holds JIRA/Confluence credentials securely |
| Security Group | Restricts inbound to port 9000 from `allowedCidr` only |
| Cloud Map Namespace | DNS-based service discovery (`atlassian.mcp.internal`) |
| CloudWatch Log Group | 2-week log retention |

## Cost Estimate

| Item | Monthly Cost |
|------|-------------|
| Fargate (0.25 vCPU + 512 MB, always-on) | ~$9.50 |
| NAT Gateway | ~$3.50 + data transfer |
| Secrets Manager (1 secret) | $0.40 |
| ECR (<1 GB) | ~$0.10 |
| CloudWatch Logs | ~$0.50 |
| Cloud Map | ~$0.10 |
| **Total** | **~$14/month** |

If you deploy into an existing VPC that already has a NAT Gateway, subtract ~$3.50.

---

## Prerequisites

1. **AWS CLI** configured with credentials that have admin-level access
   ```bash
   aws sts get-caller-identity   # verify your identity
   ```

2. **Node.js 18+** and **npm**
   ```bash
   node --version   # must be >= 18
   ```

3. **Docker** running (CDK builds the image locally)
   ```bash
   docker info   # must not error
   ```

4. **Atlassian API Token** — generate one at:
   https://id.atlassian.com/manage-profile/security/api-tokens

5. **Your Atlassian details:**
   - Atlassian URL (e.g. `https://yourcompany.atlassian.net`)
   - Email address associated with the API token
   - The API token itself

---

## Step-by-Step Deployment

### Step 1: Clone the repo

```bash
git clone https://github.com/adubuc-cloudgeometry/mcp-atlassian.git
cd mcp-atlassian
```

### Step 2: Install CDK dependencies

```bash
cd cdk
npm install
```

### Step 3: Bootstrap CDK (first time per AWS account/region)

```bash
npx cdk bootstrap
```

This creates the CDKToolkit CloudFormation stack with an S3 bucket and ECR repository for CDK assets. Only needs to be done once per account/region.

### Step 4: Deploy the stack

```bash
npx cdk deploy
```

The first deploy takes ~3 minutes. CDK will:
- Build the Docker image locally from the repo root `Dockerfile`
- Push it to an ECR repository in your account
- Create all infrastructure resources (VPC, ECS, Secrets Manager, etc.)
- Start the ECS service

> **Note:** On first deploy, the container will crash because Secrets Manager has placeholder credentials. This is expected — fix it in Step 5.

**To deploy into an existing VPC** (saves ~$3.50/month on NAT Gateway):
```bash
npx cdk deploy -c existingVpcName=your-vpc-name
```

**To restrict inbound access to a specific CIDR:**
```bash
npx cdk deploy -c allowedCidr=10.2.0.0/16
```

### Step 5: Set real Atlassian credentials

Replace the placeholder values with your actual credentials:

```bash
aws secretsmanager put-secret-value \
  --secret-id mcp-atlassian/credentials \
  --secret-string '{
    "JIRA_URL": "https://yourcompany.atlassian.net",
    "JIRA_USERNAME": "you@yourcompany.com",
    "JIRA_API_TOKEN": "your-actual-api-token",
    "CONFLUENCE_URL": "https://yourcompany.atlassian.net/wiki",
    "CONFLUENCE_USERNAME": "you@yourcompany.com",
    "CONFLUENCE_API_TOKEN": "your-actual-api-token"
  }'
```

> Typically JIRA and Confluence share the same username and API token.

### Step 6: Restart the service to pick up new credentials

```bash
aws ecs update-service \
  --cluster mcp-atlassian-cluster \
  --service mcp-atlassian \
  --force-new-deployment
```

### Step 7: Verify the container is healthy

Wait ~60 seconds, then:

```bash
aws ecs describe-services \
  --cluster mcp-atlassian-cluster \
  --services mcp-atlassian \
  --query 'services[0].{status:status,running:runningCount,desired:desiredCount}'
```

Expected output:
```json
{
    "status": "ACTIVE",
    "running": 1,
    "desired": 1
}
```

To check container health specifically:
```bash
# Get the task ID
TASK_ARN=$(aws ecs list-tasks --cluster mcp-atlassian-cluster --service-name mcp-atlassian --query 'taskArns[0]' --output text)

# Check health
aws ecs describe-tasks \
  --cluster mcp-atlassian-cluster \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].{status:lastStatus,health:healthStatus}'
```

Expected: `{"status": "RUNNING", "health": "HEALTHY"}`

---

## Connecting LangBuilder to the Deployed Server

Once the MCP server is running on AWS, configure the AtlassianMCPComponent in LangBuilder:

| Field | Value |
|-------|-------|
| MCP Server URL | `http://atlassian.mcp.internal:9000` (if same VPC) or the private IP of the Fargate task |
| Atlassian Email | Your Atlassian email |
| Atlassian API Token | Your Atlassian API token |

> **Important:** The MCP server runs in a private subnet with no public IP. LangBuilder must be in the same VPC or a peered VPC to reach it. Use the service discovery endpoint `atlassian.mcp.internal:9000` if both are in the same VPC.

If LangBuilder is external (e.g., running locally), you'll need to either:
- Add a public ALB in front of the ECS service, or
- Use an SSH tunnel / VPN to the VPC, or
- Temporarily add a public IP to the Fargate task (not recommended for production)

---

## Debugging

### View logs
```bash
aws logs tail /ecs/mcp-atlassian --follow
```

### Check service events (deployment issues)
```bash
aws ecs describe-services \
  --cluster mcp-atlassian-cluster \
  --services mcp-atlassian \
  --query 'services[0].events[0:5]'
```

### Shell into the running container
```bash
TASK_ARN=$(aws ecs list-tasks --cluster mcp-atlassian-cluster --service-name mcp-atlassian --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster mcp-atlassian-cluster \
  --task "$TASK_ARN" \
  --container mcp-atlassian \
  --interactive \
  --command "/bin/sh"
```

### Check what credentials the container sees
```bash
aws secretsmanager get-secret-value \
  --secret-id mcp-atlassian/credentials \
  --query 'SecretString' --output text | python3 -m json.tool
```

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container keeps restarting (circuit breaker) | Placeholder credentials in Secrets Manager | Run Step 5 + Step 6 |
| `ECONNREFUSED` from LangBuilder | LangBuilder not in same VPC, or wrong URL | Check network connectivity |
| Health check failing | Server not binding to `0.0.0.0` | Verify `--host 0.0.0.0` in task definition command |
| Stack deploy fails with "already exists" | Orphaned ECR repo from previous failed deploy | Delete the ECR repo manually: `aws ecr delete-repository --repository-name mcp-atlassian --force` |
| Stack deploy fails with "non-ASCII" | Special characters in resource descriptions | Ensure all strings in CDK code are ASCII-only |

---

## Tear Down

```bash
cd cdk
npx cdk destroy
```

This removes all resources including the VPC, ECS cluster, secrets, and logs. ECR repository is also destroyed (`RemovalPolicy.DESTROY`).

---

## Configuration Reference

| Context Variable | Default | Description |
|-----------------|---------|-------------|
| `existingVpcName` | `null` | Reuse an existing VPC instead of creating one |
| `allowedCidr` | `10.0.0.0/16` | CIDR range allowed to reach port 9000 |

Set via `cdk.json` or CLI flag `-c key=value`.

## Stack Outputs

After deployment, the stack outputs:

| Output | Example |
|--------|---------|
| `SecretArn` | `arn:aws:secretsmanager:us-west-2:123456789012:secret:mcp-atlassian/credentials-AbCdEf` |
| `ServiceDiscoveryEndpoint` | `atlassian.mcp.internal:9000` |
| `EcrRepoUri` | `123456789012.dkr.ecr.us-west-2.amazonaws.com/mcp-atlassian` |
| `ClusterName` | `mcp-atlassian-cluster` |
