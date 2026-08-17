import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();
import { ServiceNowAdapter } from './adapters/servicenow';
import { SalesforceAdapter } from './adapters/salesforce';
import { DynamicAdapter } from './adapters/dynamic_adapter';
import { SalesforceDescribeConnector } from './adapters/connectors/salesforce_describe';
import { GeminiLLMClient, GroqLLMClient } from './llm/llm_client';
import { GeminiEmbeddingsClient } from './llm/embeddings_client';
import { VectorStore } from './core/vector_store';
import { UniversalSchemaDiscoveryAgent } from './core/universal_schema_discovery_agent';
import { listAllAdapterConfigs, GeneratedAdapterConfig } from './core/generated_adapter_config';
import {
  ControlEffectivenessAgent,
  InherentAssessmentAgent,
  RiskControlMappingAgent,
  IssueIdentificationAgent
} from './core/agents';
import { withTrace, currentTrace, recentTraces, computeStats } from './core/observability';
import { runIntegrityScan } from './core/integrity_scan';
import { VerificationAgent } from './core/verification_agent';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Disable caching for all API requests to ensure fresh filtered data
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// Initialize core client and adapters
const llmClient = new GeminiLLMClient();
// Separate client/provider from llmClient above — used ONLY by the
// verification layer, deliberately never by any producer agent, so the
// checker can never share the producer's blind spots.
const groqClient = new GroqLLMClient();
const embeddingsClient = new GeminiEmbeddingsClient();
const vectorStore = new VectorStore();
const universalDiscoveryAgent = new UniversalSchemaDiscoveryAgent(llmClient, embeddingsClient, vectorStore);
const salesforceAdapter = new SalesforceAdapter();

// Registry of dynamically onboarded platforms (built by UniversalSchemaDiscoveryAgent).
// Keyed by platformName, so /api/run-agent can route to them alongside the
// hand-written ServiceNow/Salesforce adapters with zero new adapter code.
const dynamicAdapters = new Map<string, DynamicAdapter>();

function buildDynamicAdapter(config: GeneratedAdapterConfig): DynamicAdapter {
  // Only 'salesforce-soql' has a live connection today, so it reuses the
  // same Salesforce credentials already configured for SalesforceAdapter.
  return new DynamicAdapter(
    config,
    process.env.SALESFORCE_INSTANCE_URL || '',
    process.env.SALESFORCE_CLIENT_ID || '',
    process.env.SALESFORCE_CLIENT_SECRET || ''
  );
}

// Load any previously generated adapter configs at startup so onboarded
// platforms survive a server restart.
for (const config of listAllAdapterConfigs()) {
  dynamicAdapters.set(config.platformName, buildDynamicAdapter(config));
  console.log(`[GRC Agnostic Server] Loaded previously generated adapter for platform '${config.platformName}'.`);
}

// Metadata endpoint
app.get('/api/platforms', (req, res) => {
  const discoveredPlatforms = Array.from(dynamicAdapters.values()).map(a => ({
    id: a.getPlatformName(),
    name: `${a.getPlatformName()} (Discovered)`,
    description: `Onboarded via Universal Schema Discovery Agent — ${a.getEntityLabel()}-scoped GRC data.`
  }));

  res.json({
    platforms: [
      { id: 'servicenow', name: 'ServiceNow GRC', description: 'Enterprise Risk & Compliance Workspace' },
      { id: 'salesforce', name: 'Salesforce GRC (Custom)', description: 'Salesforce Custom GRC Cloud Objects' },
      ...discoveredPlatforms
    ],
    agents: [
      { id: 'control-effectiveness', name: 'Control Effectiveness Agent', description: 'Batch assesses control effectiveness against test evidence and audit runs.' },
      { id: 'inherent-assessment', name: 'Inherent Assessment Agent', description: 'Evaluates inherent factors (PII sensitivity, threat model) using guidance rubrics.' },
      { id: 'risk-control-mapping', name: 'Risk-Control Mapping Agent', description: 'Analyses entity risks and maps relevant mitigating controls from library.' },
      { id: 'issue-identification', name: 'Issue Identification Agent', description: 'Drafts a tracked issue for a risk, given its sys_id — trigger is external (e.g. a ServiceNow client script), not scan-based.' }
    ]
  });
});

// Endpoint to run any core GRC agent dynamically
app.post('/api/run-agent', async (req, res) => {
  const { platform, agent, targetId } = req.body;

  if (!platform || !agent || !targetId) {
    return res.status(400).json({ error: 'Missing parameters platform, agent, or targetId.' });
  }

  // 1. Select Adapter
  const adapter = platform === 'servicenow' ? new ServiceNowAdapter() : (platform === 'salesforce' ? salesforceAdapter : dynamicAdapters.get(platform));
  if (!adapter) {
    return res.status(400).json({ error: `Platform '${platform}' is not supported.` });
  }

  // Capture standard log outputs
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(' '));
    originalLog(...args);
  };

  if (!['control-effectiveness', 'inherent-assessment', 'risk-control-mapping', 'issue-identification'].includes(agent)) {
    console.log = originalLog;
    return res.status(400).json({ error: `Unsupported agent action: ${agent}` });
  }

  try {
    // Each execution runs inside an observability trace: every LLM call,
    // embedding call, and platform query/write it triggers becomes a span.
    let traceId = '';
    const result = await withTrace('run-agent', { platform, agent, targetId }, async () => {
      traceId = currentTrace()!.traceId;
      if (agent === 'control-effectiveness') {
        return new ControlEffectivenessAgent(adapter, llmClient).execute(targetId);
      } else if (agent === 'inherent-assessment') {
        return new InherentAssessmentAgent(adapter, llmClient).execute(targetId);
      } else if (agent === 'issue-identification') {
        return new IssueIdentificationAgent(adapter, llmClient).execute(targetId);
      } else {
        return new RiskControlMappingAgent(adapter, llmClient).execute(targetId);
      }
    });

    console.log = originalLog;
    res.json({
      success: true,
      agent,
      platform,
      result,
      traceId,
      logs
    });

    // ── Verification layer (pilot: Control Effectiveness only) ──────────────
    // Fired AFTER the response is sent, not awaited — this must never add
    // latency to the producer agent's response or affect it in any way.
    // Independent of and unrelated to the producer's own success/failure;
    // errors here are logged and swallowed, never surfaced to the caller.
    if (agent === 'control-effectiveness' && groqClient.isLive()) {
      new VerificationAgent(adapter, groqClient).verifyControlEffectiveness(targetId)
        .then(v => console.log(`[VerificationAgent] ${v.success ? 'OK' : 'skipped'}: ${v.message}`))
        .catch(e => console.warn(`[VerificationAgent] Failed: ${e.message}`));
    }
  } catch (error: any) {
    console.log = originalLog;
    res.status(500).json({
      success: false,
      error: error.message,
      logs
    });
  }
});

// ============================================================================
// AI Observability endpoints
// ============================================================================
app.get('/api/observability/traces', async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  res.json({ success: true, traces: await recentTraces(limit, kind) });
});

app.get('/api/observability/stats', async (req, res) => {
  res.json({ success: true, stats: await computeStats() });
});

// ============================================================================
// Integrity scan — the async half of the "0 issues" monitoring pair. The
// synchronous writeVerified() check inside agents.ts catches a bad write the
// instant it happens; this catches drift (a field that was fine right after
// the write but got cleared by something else afterward — confirmed possible
// on this project). Meant to be hit by a scheduler (Vercel Cron, see
// vercel.json), not a human — gated by a shared secret since it triggers real
// writes (flagging affected records) against the live platform, same as
// /api/run-agent.
// ============================================================================
app.get('/api/health/integrity-scan', async (req, res) => {
  // Vercel automatically sends CRON_SECRET as `Authorization: Bearer <value>`
  // on cron-triggered requests — this is Vercel's own documented mechanism,
  // not a custom header, so a scheduled invocation authenticates for free.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (req.get('authorization') !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header.' });
    }
  } else {
    console.warn('[IntegrityScan] CRON_SECRET is not set — endpoint is running unauthenticated.');
  }

  const sinceHours = Math.min(Math.max(parseInt(String(req.query.sinceHours || '6'), 10) || 6, 1), 72);

  try {
    const results = await withTrace('integrity-scan', { sinceHours }, async () => {
      const servicenowResult = await runIntegrityScan(new ServiceNowAdapter(), sinceHours);
      const salesforceResult = await runIntegrityScan(salesforceAdapter, sinceHours);
      return [servicenowResult, salesforceResult];
    });

    const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);
    res.json({ success: true, totalFindings, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to list all available risks from ServiceNow (live or mock)
app.get('/api/platforms/servicenow/risks', async (req, res) => {
  try {
    const risks = await new ServiceNowAdapter().getAllRisks();
    res.json({ success: true, risks });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to list all assessment instances from ServiceNow (live or mock)
app.get('/api/platforms/servicenow/assessments', async (req, res) => {
  try {
    const adapter = new ServiceNowAdapter();
    const agentFilter = req.query.agent ? String(req.query.agent) : undefined;
    const instances = await adapter.getAllAssessmentInstances(agentFilter);
    res.json({
      success: true,
      useLive: (adapter as any).useLive,
      instanceUrl: (adapter as any).instanceUrl ? 'configured' : 'missing',
      instances
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to list all available risks from Salesforce (live or mock)
app.get('/api/platforms/salesforce/risks', async (req, res) => {
  try {
    const risks = await salesforceAdapter.getAllRisks();
    res.json({ success: true, risks });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to list all assessment instances from Salesforce (live or mock)
app.get('/api/platforms/salesforce/assessments', async (req, res) => {
  try {
    const agent = req.query.agent as string;
    const instances = await salesforceAdapter.getAllAssessmentInstances(agent);
    res.json({ success: true, instances });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to parse new platform schemas from pasted metadata text (no live connection required)
app.post('/api/schema-discovery', async (req, res) => {
  const { rawMetadata, platformName } = req.body;
  if (!rawMetadata) {
    return res.status(400).json({ error: 'Missing parameter rawMetadata.' });
  }

  try {
    const result = await universalDiscoveryAgent.executeFromPastedMetadata(platformName || 'Custom GRC Platform', rawMetadata);
    res.json({
      success: true,
      result
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint to onboard a new platform via LIVE schema introspection + vector matching.
// Today only Salesforce orgs are supported as a live connection type — the
// pipeline reuses the same SALESFORCE_* credentials already configured for
// the hand-written SalesforceAdapter.
app.post('/api/schema-discovery/live', async (req, res) => {
  const { platformName, entityLabel } = req.body;
  if (!platformName) {
    return res.status(400).json({ error: 'Missing parameter platformName.' });
  }

  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL || '';
  const clientId = process.env.SALESFORCE_CLIENT_ID || '';
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET || '';
  const connector = new SalesforceDescribeConnector(instanceUrl, clientId, clientSecret);

  if (!connector.isConfigured()) {
    return res.status(400).json({ error: 'Live discovery requires SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET to be configured in .env.' });
  }

  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: any[]) => { logs.push(args.join(' ')); originalLog(...args); };
  console.warn = (...args: any[]) => { logs.push(args.join(' ')); originalWarn(...args); };

  try {
    const config = await withTrace('schema-discovery', { platformName }, () =>
      universalDiscoveryAgent.executeLive(platformName, connector, 'salesforce-soql', entityLabel)
    );
    dynamicAdapters.set(config.platformName, buildDynamicAdapter(config));

    console.log = originalLog;
    console.warn = originalWarn;
    res.json({ success: true, config, logs });
  } catch (error: any) {
    console.log = originalLog;
    console.warn = originalWarn;
    res.status(500).json({ success: false, error: error.message, logs });
  }
});

// Purpose-based candidate ranking (fast — no LLM confirmation pass).
// Ranks every queryable object in the connected Salesforce org by semantic
// similarity to the gold-standard table purposes learned from the
// hand-written adapters, and returns the top matches with scores.
app.get('/api/schema-discovery/candidates', async (req, res) => {
  const connector = new SalesforceDescribeConnector(
    process.env.SALESFORCE_INSTANCE_URL || '',
    process.env.SALESFORCE_CLIENT_ID || '',
    process.env.SALESFORCE_CLIENT_SECRET || ''
  );
  if (!connector.isConfigured()) {
    return res.status(400).json({ success: false, error: 'Salesforce credentials not configured in .env.' });
  }
  try {
    const topK = parseInt(String(req.query.topK || '15'), 10);
    const candidates = await universalDiscoveryAgent.rankCandidateObjects(connector, topK);
    res.json({ success: true, semantic: embeddingsClient.isLive(), candidates });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Lists platforms onboarded via the Universal Schema Discovery agent
app.get('/api/platforms/discovered', (req, res) => {
  res.json({
    success: true,
    platforms: Array.from(dynamicAdapters.values()).map(a => ({
      platformName: a.getPlatformName(),
      entityLabel: a.getEntityLabel()
    })),
    configs: listAllAdapterConfigs()
  });
});

// Generic risk/assessment listing for dynamically onboarded platforms
app.get('/api/platforms/:platformName/risks', async (req, res) => {
  const adapter = dynamicAdapters.get(req.params.platformName);
  if (!adapter) return res.status(404).json({ success: false, error: `No discovered platform named '${req.params.platformName}'.` });
  try {
    const risks = await adapter.getAllRisks();
    res.json({ success: true, risks });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/platforms/:platformName/assessments', async (req, res) => {
  const adapter = dynamicAdapters.get(req.params.platformName);
  if (!adapter) return res.status(404).json({ success: false, error: `No discovered platform named '${req.params.platformName}'.` });
  try {
    const agent = req.query.agent as string;
    const instances = await adapter.getAllAssessmentInstances(agent);
    res.json({ success: true, instances });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Export for Vercel (and other serverless runtimes) which import the app
// directly without calling listen(). Local Express dev still calls listen().
// Diagnostic endpoint: describe any Salesforce object by name
// Usage: GET /api/debug/salesforce/describe/Ema_Audit_Trail__c
app.get('/api/debug/salesforce/describe/:objectName', async (req, res) => {
  try {
    const { objectName } = req.params;

    // Use the Salesforce adapter to query the describe API
    const token = (salesforceAdapter as any).getAccessToken ?
      await (salesforceAdapter as any).getAccessToken() :
      null;

    if (!token) {
      return res.status(401).json({ error: 'Salesforce credentials not configured' });
    }

    const instanceUrl = (salesforceAdapter as any).instanceUrl;

    const response = await axios.get(
      `${instanceUrl}/services/data/v60.0/sobjects/${objectName}/describe`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const describe = response.data;

    // Return simplified field list
    const fields = (describe as any).fields.map((f: any) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      updateable: f.updateable,
      createable: f.createable,
      length: f.length,
      custom: f.custom
    }));

    res.json({
      objectName,
      totalFields: fields.length,
      fields
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default app;

// Server bootup — skipped on Vercel where the platform invokes the handler directly
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[GRC Agnostic Server] Listening on http://localhost:${PORT}`);
  });
}

