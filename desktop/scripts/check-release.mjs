#!/usr/bin/env node
// Release artifacts must be signed; developer/CI smoke builds use the ordinary dist command.
const required = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
if (process.platform === 'darwin') required.push('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) throw new Error(`Release signing is not configured: ${missing.join(', ')}. Configure repository signing secrets; unsigned builds cannot be released.`);
