// DESIGN_AUTHORITY.md §5 (TSK-336), §6.15, GAP-249, CL11: Operations Contract, OpenAPI 3.1.0 and MCP Schema Conformance
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PLANE_ROUTES,
  getOpenApiDocument,
  getMcpSchemaCatalog,
} from '@beercanlabs/factory-control-plane/routes';
import {
  validateOperationContract,
  type OperationContract,
} from '@beercanlabs/factory-contract';

describe('Operations Contract & Schema Conformance (GAP-249, CL11, TSK-336)', () => {
  it('every route in CONTROL_PLANE_ROUTES binds a valid OperationContract', () => {
    assert.ok(CONTROL_PLANE_ROUTES.length >= 256, `Expected >= 256 routes, found ${CONTROL_PLANE_ROUTES.length}`);
    for (const r of CONTROL_PLANE_ROUTES) {
      assert.ok(r.operationId, `Route ${r.method} ${r.pattern} is missing operationId`);
      assert.ok(r.summary, `Route ${r.method} ${r.pattern} is missing summary`);
      assert.ok(r.mcpExposure, `Route ${r.method} ${r.pattern} is missing mcpExposure`);
      assert.doesNotThrow(() => validateOperationContract(r), `Route ${r.method} ${r.pattern} has invalid operation contract`);
    }
  });

  it('no path parameter in pattern is unmapped in pathParamsSchema', () => {
    for (const r of CONTROL_PLANE_ROUTES) {
      const paramMatches = [...r.pattern.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
      if (paramMatches.length > 0) {
        assert.ok(r.pathParamsSchema, `Route ${r.method} ${r.pattern} has path parameters but no pathParamsSchema`);
        const declared = Object.keys(r.pathParamsSchema.properties || {});
        for (const p of paramMatches) {
          assert.ok(declared.includes(p), `Route ${r.method} ${r.pattern} has param :${p} not declared in pathParamsSchema`);
        }
      }
    }
  });

  it('enforces CL6: key generation routes are strictly console-or-cli-only', () => {
    const keyCreation = CONTROL_PLANE_ROUTES.find((r) => r.method === 'POST' && r.pattern === '/api/v1/keys');
    assert.ok(keyCreation);
    assert.equal(keyCreation.mcpExposure, 'console-or-cli-only');

    const keyRotate = CONTROL_PLANE_ROUTES.find((r) => r.method === 'POST' && r.pattern === '/api/v1/keys/:id/rotate');
    assert.ok(keyRotate);
    assert.equal(keyRotate.mcpExposure, 'console-or-cli-only');
  });

  it('enforces human-decision on holds, approvals, and admission routes', () => {
    const humanRoutes = [
      { method: 'POST', pattern: '/api/v1/submissions/:id/admit' },
      { method: 'POST', pattern: '/api/v1/approvals/:id/decide' },
    ];
    for (const hr of humanRoutes) {
      const route = CONTROL_PLANE_ROUTES.find((r) => r.method === hr.method && r.pattern === hr.pattern);
      if (route) {
        assert.equal(route.mcpExposure, 'human-decision', `${hr.method} ${hr.pattern} must be human-decision`);
      }
    }
  });

  it('buildOpenApiDocument outputs valid OpenAPI 3.1.0 with securitySchemes and extensions', () => {
    const doc = getOpenApiDocument();
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.title, 'Agent Factory Control Plane API');
    assert.ok(doc.components.securitySchemes.FactoryApiKey);
    assert.ok(doc.components.securitySchemes.FactorySession);
    assert.ok(doc.components.securitySchemes.McpOAuth2);

    // Every path has at least one method with x-bouncer-privilege or x-route-exception
    for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (typeof op !== 'object' || !op) continue;
        const o = op as Record<string, unknown>;
        assert.ok(o['x-bouncer-privilege'] || o['x-route-exception'], `${method.toUpperCase()} ${pathKey} missing bouncer privilege / exception extension`);
        assert.ok(o['x-factory-staff'], `${method.toUpperCase()} ${pathKey} missing x-factory-staff extension`);
        assert.ok(o['x-mcp-exposure'], `${method.toUpperCase()} ${pathKey} missing x-mcp-exposure extension`);
      }
    }
  });

  it('buildMcpSchemaCatalog enforces tool name regex, unique names, and core tools limit <= 40', () => {
    const catalog = getMcpSchemaCatalog();
    assert.equal(catalog.version, '2024-11-05');
    assert.ok(catalog.tools.length > 0);

    const namePattern = /^[a-z0-9_]{1,40}$/;
    const names = new Set<string>();
    let coreCount = 0;

    for (const tool of catalog.tools) {
      assert.match(tool.name, namePattern, `Tool name ${tool.name} must match ^[a-z0-9_]{1,40}$`);
      assert.ok(!names.has(tool.name), `Duplicate tool name: ${tool.name}`);
      names.add(tool.name);

      assert.equal(tool.inputSchema.type, 'object', `Tool ${tool.name} inputSchema must have type: 'object'`);
      if (tool._meta.inCore) {
        coreCount++;
      }
    }

    assert.ok(coreCount <= 40, `Core toolset count (${coreCount}) must not exceed 40`);

    // Verify console-or-cli-only and internal operations are excluded
    assert.ok(!names.has('keys_create'), 'keys_create must not be an MCP tool');
    assert.ok(!names.has('keys_rotate'), 'keys_rotate must not be an MCP tool');
  });

  it('F2 & F1: every non-internal mutating route declares requestBodySchema or noRequestBody', () => {
    for (const r of CONTROL_PLANE_ROUTES) {
      if (['POST', 'PUT', 'PATCH'].includes(r.method) && r.mcpExposure !== 'internal') {
        const hasBodySchema = Boolean(
          r.requestBodySchema &&
            ((r.requestBodySchema.properties && Object.keys(r.requestBodySchema.properties).length > 0) ||
              r.requestBodySchema.type)
        );
        assert.ok(
          hasBodySchema || r.noRequestBody === true,
          `Mutating route ${r.method} ${r.pattern} (${r.operationId}) must define requestBodySchema or specify noRequestBody: true`
        );
      }
    }
  });

  it('F1 & F2: key mutating tools export non-empty properties in both OpenAPI requestBody and MCP inputSchema', () => {
    const doc = getOpenApiDocument();
    const catalog = getMcpSchemaCatalog();

    const expectedTools = [
      {
        toolName: 'create_agent',
        opId: 'create_agent',
        path: '/api/v1/agents',
        method: 'post',
        expectedProps: ['name', 'role'],
      },
      {
        toolName: 'create_schedule',
        opId: 'create_schedule',
        path: '/api/v1/schedules',
        method: 'post',
        expectedProps: ['cron', 'prompt'],
      },
      {
        toolName: 'create_grant',
        opId: 'create_grant',
        path: '/api/v1/grants',
        method: 'post',
        expectedProps: ['subject', 'role'],
      },
      {
        toolName: 'allocate_agent_budget',
        opId: 'allocate_agent_budget',
        path: '/api/v1/budget/agents/{id}',
        method: 'put',
        expectedProps: ['budgetUsd'],
      },
      {
        toolName: 'decide_approval',
        opId: 'decide_approval',
        path: '/api/v1/approvals/{id}',
        method: 'post',
        expectedProps: ['decision'],
      },
      {
        toolName: 'agents_converse',
        opId: 'agents_converse',
        path: '/api/v1/agents/{id}/conversation',
        method: 'post',
        expectedProps: ['input', 'message'],
      },
    ];

    for (const exp of expectedTools) {
      // Check MCP tool inputSchema
      const tool = catalog.tools.find((t) => t.name === exp.toolName);
      assert.ok(tool, `MCP tool ${exp.toolName} must exist in catalog`);
      assert.equal(tool.inputSchema.type, 'object');
      const toolProps = Object.keys(tool.inputSchema.properties || {});
      for (const prop of exp.expectedProps) {
        assert.ok(
          toolProps.includes(prop),
          `MCP tool ${exp.toolName} inputSchema must include property '${prop}' (found: ${toolProps.join(', ')})`
        );
      }

      // Check OpenAPI requestBody
      const openApiPath = doc.paths[exp.path];
      assert.ok(openApiPath, `OpenAPI path ${exp.path} must exist in document`);
      const op = (openApiPath as Record<string, any>)[exp.method];
      assert.ok(op, `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} must exist`);
      assert.ok(op.requestBody, `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} must have requestBody`);
      const jsonContent = op.requestBody.content?.['application/json'];
      assert.ok(jsonContent, `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} must have application/json content`);
      const bodyProps = Object.keys(jsonContent.schema?.properties || {});
      for (const prop of exp.expectedProps) {
        assert.ok(
          bodyProps.includes(prop),
          `OpenAPI operation ${exp.method.toUpperCase()} ${exp.path} schema must include property '${prop}'`
        );
      }
    }
  });

  it('F3: non-200 creation and async dispatch statusCodes are populated accurately', () => {
    const doc = getOpenApiDocument();

    // POST /api/v1/agents should return 201
    const createAgentRoute = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'create_agent');
    assert.ok(createAgentRoute);
    assert.deepEqual(createAgentRoute.statusCodes, [201]);

    const createAgentOp = (doc.paths['/api/v1/agents'] as Record<string, any>)?.post;
    assert.ok(createAgentOp);
    assert.ok(createAgentOp.responses['201'], 'OpenAPI create_agent should declare 201 response');

    // POST /api/v1/agents/:id/runs should return 200, 202
    const triggerRunRoute = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'start_agent_run');
    assert.ok(triggerRunRoute);
    assert.deepEqual(triggerRunRoute.statusCodes, [200, 202]);

    const triggerRunOp = (doc.paths['/api/v1/agents/{id}/runs'] as Record<string, any>)?.post;
    assert.ok(triggerRunOp);
    assert.ok(triggerRunOp.responses['202'], 'OpenAPI start_agent_run should declare 202 response');
  });

  it('Round 3 F1-F4: verified routes have accurate requestBodySchema and no false noRequestBody', () => {
    // F1: run_post_heartbeat
    const heartbeat = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'run_post_heartbeat');
    assert.ok(heartbeat);
    assert.equal(heartbeat.noRequestBody, undefined);
    assert.ok(heartbeat.requestBodySchema?.properties?.rssMb);

    // F2: deploy_agent
    const deploy = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'deploy_agent');
    assert.ok(deploy);
    assert.equal(deploy.noRequestBody, undefined);
    assert.ok(deploy.requestBodySchema?.properties?.repo);
    assert.ok(deploy.requestBodySchema?.properties?.commit);
    assert.ok(deploy.statusCodes?.includes(202));

    // F3: egress_record_failover
    const failover = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'egress_record_failover');
    assert.ok(failover);
    assert.equal(failover.noRequestBody, undefined);
    assert.ok(failover.requestBodySchema?.properties?.toModel);
    assert.deepEqual(failover.requestBodySchema?.required, ['toModel']);
    assert.ok(failover.requestBodySchema?.properties?.fromModel);
    assert.ok(failover.requestBodySchema?.properties?.reason);

    // F4: post_add_group_member_alias
    const groupMemberAlias = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'post_add_group_member_alias');
    assert.ok(groupMemberAlias);
    assert.equal(groupMemberAlias.noRequestBody, undefined);
    assert.ok(groupMemberAlias.requestBodySchema?.properties?.member);
    assert.deepEqual(groupMemberAlias.requestBodySchema?.required, ['member']);

    // unpublish_skill
    const unpublish = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'unpublish_skill');
    assert.ok(unpublish);
    assert.equal(unpublish.noRequestBody, undefined);
    assert.ok(unpublish.requestBodySchema?.properties?.reason);
  });

  it('Round 3 F5-F9: schema precision across grants, budgets, status codes, keys and schedules', () => {
    // F5: GrantCreateBodySchema
    const createGrant = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'create_grant');
    assert.ok(createGrant);
    const grantProps = createGrant.requestBodySchema?.properties;
    assert.ok(grantProps?.id);
    assert.ok(grantProps?.subjectDisplayName);
    assert.ok(grantProps?.replaceExisting);
    assert.deepEqual(grantProps?.state?.enum, ['active']);
    assert.deepEqual(grantProps?.expiresAt?.type, ['string', 'null']);

    // F6: SpendBudgetsBodySchema & distinct responseSchema
    const setBudgets = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'set_spend_budgets');
    assert.ok(setBudgets);
    const budgetProps = setBudgets.requestBodySchema?.properties;
    assert.ok(budgetProps?.aiMonthUsd);
    assert.ok(budgetProps?.infraMonthUsd);
    assert.ok(budgetProps?.totalMonthUsd);
    assert.equal(setBudgets.requestBodySchema?.required, undefined);
    assert.equal(budgetProps?.alertAt?.minItems, 1);
    assert.equal((budgetProps?.alertAt?.items as any)?.exclusiveMinimum, 0);
    assert.equal((budgetProps?.alertAt?.items as any)?.maximum, 10);
    assert.ok(setBudgets.responseSchema?.properties?.version);
    assert.ok(setBudgets.responseSchema?.properties?.setAt);

    const getBudgets = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'get_spend_budgets');
    assert.ok(getBudgets);
    assert.ok(getBudgets.responseSchema?.properties?.current);
    assert.ok(getBudgets.responseSchema?.properties?.history);

    // F7 & F8: status codes precision
    const skillChecks = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'run_skill_checks');
    assert.ok(skillChecks);
    assert.deepEqual(skillChecks.statusCodes, [202]);

    const consumeApproval = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'egress_consume_approval');
    assert.ok(consumeApproval);
    assert.deepEqual(consumeApproval.statusCodes, [200, 409]);

    const cutover = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'cutover_auth_migration');
    assert.ok(cutover);
    assert.deepEqual(cutover.statusCodes, [200, 409]);

    // F9: handler-read fields in schedules, api keys, default model
    const createSched = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'create_schedule');
    assert.ok(createSched);
    assert.ok(createSched.requestBodySchema?.properties?.id);
    assert.ok(createSched.requestBodySchema?.properties?.requestedBy);

    const createKey = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'create_api_key');
    assert.ok(createKey);
    assert.ok(createKey.requestBodySchema?.properties?.deviceFamily);
    assert.ok(createKey.requestBodySchema?.properties?.scopes);

    const setDefaultModel = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'set_default_model');
    assert.ok(setDefaultModel);
    assert.ok(setDefaultModel.requestBodySchema?.properties?.model);
    assert.ok(setDefaultModel.requestBodySchema?.properties?.name);
  });

  it('Post-sync panel schema fixes: env & wakeAgents in policy schemas and GlobalPolicyBodySchema for budget policy', () => {
    // 1. set_agent_policy & get_agent_policy
    const setPolicy = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'set_agent_policy');
    assert.ok(setPolicy);
    const policyReqProps = setPolicy.requestBodySchema?.properties;
    assert.ok(policyReqProps?.env);
    assert.equal(policyReqProps?.env?.type, 'object');
    assert.equal((policyReqProps?.env?.additionalProperties as any)?.type, 'string');
    assert.ok(policyReqProps?.wakeAgents);

    const getPolicy = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'get_agent_policy');
    assert.ok(getPolicy);
    const policyResProps = getPolicy.responseSchema?.properties;
    assert.ok(policyResProps?.env);
    assert.equal(policyResProps?.env?.type, 'object');
    assert.equal((policyResProps?.env?.additionalProperties as any)?.type, 'string');
    assert.ok(policyResProps?.wakeAgents);

    // MCP inputSchema exports env
    const catalog = getMcpSchemaCatalog();
    const setPolicyTool = catalog.tools.find((t) => t.name === 'set_agent_policy');
    assert.ok(setPolicyTool);
    const toolProps = setPolicyTool.inputSchema.properties;
    assert.ok(toolProps.env);
    assert.equal(toolProps.env.type, 'object');
    assert.equal((toolProps.env.additionalProperties as any)?.type, 'string');

    // 2. set_system_budget_policy (PUT /api/v1/policies/budget)
    const setBudgetPolicy = CONTROL_PLANE_ROUTES.find((r) => r.operationId === 'set_system_budget_policy');
    assert.ok(setBudgetPolicy);
    assert.equal(setBudgetPolicy.requestBodySchema?.required, undefined); // none required
    const globalPolicyProps = setBudgetPolicy.requestBodySchema?.properties;
    assert.ok(globalPolicyProps?.budgetUsd);
    assert.ok(globalPolicyProps?.routes);
    assert.ok(globalPolicyProps?.models);
    assert.ok(globalPolicyProps?.hosts);
    assert.ok(globalPolicyProps?.tools);
    assert.ok(globalPolicyProps?.tokensPerMinute);
    assert.ok(globalPolicyProps?.grounding);
    // env, subagents, and wakeAgents are rejected in global policy
    assert.equal(globalPolicyProps?.env, undefined);
    assert.equal(globalPolicyProps?.subagents, undefined);
    assert.equal(globalPolicyProps?.wakeAgents, undefined);
  });

  it('Round 3 Conformance Guard: every noRequestBody: true route is in an audited explicit allowlist of verified bodyless handlers', () => {
    const AUDITED_NO_REQUEST_BODY_OPERATIONS = new Set([
      'logout_session',
      'cutover_auth_migration',
      'pause_agent',
      'resume_agent',
      'isolate_agent',
      'reset_agent',
      'check_agent_updates',
      'cancel_run',
      'admit_submission',
      'retire_agent',
      'reinstate_agent',
      'purge_agent',
      'egress_consume_approval',
      'accept_agent_transfer',
      'decline_agent_transfer',
      'cancel_agent_transfer',
      'decline_skill_transfer',
      'discover_subscription_models',
      'run_skill_checks',
      'get_skill_training_recommendation',
      'accept_skill_transfer',
      'cancel_skill_transfer',
    ]);

    const actualNoRequestBodyRoutes = CONTROL_PLANE_ROUTES.filter((r) => r.noRequestBody === true);
    assert.equal(actualNoRequestBodyRoutes.length, AUDITED_NO_REQUEST_BODY_OPERATIONS.size);

    for (const route of actualNoRequestBodyRoutes) {
      assert.ok(
        AUDITED_NO_REQUEST_BODY_OPERATIONS.has(route.operationId),
        `Route ${route.method} ${route.pattern} (${route.operationId}) has noRequestBody: true but is not in audited allowlist`
      );
    }
  });
});
