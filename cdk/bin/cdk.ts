#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { McpAtlassianStack } from '../lib/mcp-atlassian-stack';

const app = new cdk.App();

new McpAtlassianStack(app, 'McpAtlassianStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'MCP Atlassian server — JIRA and Confluence access via Model Context Protocol',
});
