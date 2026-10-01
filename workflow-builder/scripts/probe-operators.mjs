// Empirical probe: which condition operator names does the Loopfour engine understand?
// Builds trigger -> condition -> (true: wait, false: wait), runs it with amount=5000 vs 1000.
const B = 'https://workflow.loopfour.ai/api/v1';
const H = { 'x-api-key': process.env.LOOPFOUR_API_KEY, 'Content-Type': 'application/json' };
const call = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: H, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const wait = (id, name) => ({ id, name, type: 'wait', config: { duration: 1, unit: 'seconds' } });
const block = (id, name, type, x, y, subBlocks = {}) => ({ id, name, type, enabled: true, outputs: {}, position: { x, y }, subBlocks, horizontalHandles: true });

function workflow(op) {
  const cond = { id: 'check_amount', name: 'Check amount', type: 'condition', action: 'condition.evaluate',
    config: { conditions: [{ field: '{{trigger.input.amount}}', operator: op, value: '1000' }], combineOperator: 'AND' } };
  const steps = [cond, wait('branch_true', 'Branch true'), wait('branch_false', 'Branch false')];
  const canvasState = {
    blocks: {
      trigger: block('trigger', 'API Trigger', 'api_trigger', 120, 220),
      check_amount: block('check_amount', 'Check amount', 'condition', 480, 220, {
        conditions: { id: 'conditions', type: 'condition-input', value: cond.config.conditions },
        combineOperator: { id: 'combineOperator', type: 'dropdown', value: 'AND' } }),
      branch_true: block('branch_true', 'Branch true', 'wait', 840, 120, { duration: { id: 'duration', type: 'short-input', value: '1' }, unit: { id: 'unit', type: 'dropdown', value: 'seconds' } }),
      branch_false: block('branch_false', 'Branch false', 'wait', 840, 340, { duration: { id: 'duration', type: 'short-input', value: '1' }, unit: { id: 'unit', type: 'dropdown', value: 'seconds' } }),
    },
    edges: [
      { id: 'e1', source: 'trigger', target: 'check_amount' },
      { id: 'e2', source: 'check_amount', target: 'branch_true', sourceHandle: 'true' },
      { id: 'e3', source: 'check_amount', target: 'branch_false', sourceHandle: 'false' },
    ],
    loops: {}, parallels: {},
  };
  return { steps, canvasState };
}

const created = await call('POST', '/workflows', { name: '[jev-builder] operator probe (safe to delete)', trigger: { type: 'api' }, steps: workflow('equals').steps });
const id = created.json?.data?.id;
console.log('create', created.status, id ?? JSON.stringify(created.json));
if (!id) process.exit(1);
const ops = (process.argv[2] ?? 'equals,greater_than,gt,greaterThan,>').split(',');
let active = false;
for (const op of ops) {
  const { steps, canvasState } = workflow(op);
  const save = await call('PATCH', `/workflows/${id}/canvas`, { canvasState, steps });
  if (!active) { const a = await call('POST', `/workflows/${id}/activate`); active = a.status < 300; console.log('activate', a.status, a.json?.error?.message ?? ''); }
  const runs = [];
  for (const amount of [5000, 1000]) {
    const r = await call('POST', `/workflows/${id}/run`, { input: { amount }, mode: 'sync', maxExecutionTimeMs: 30000 });
    const runId = r.json?.data?.run_id;
    const logs = runId ? await call('GET', `/runs/${runId}/logs`) : null;
    const text = JSON.stringify(logs?.json ?? r.json);
    runs.push(`${amount}: run=${r.status}/${r.json?.data?.status ?? r.json?.error?.code} true=${text.includes('branch_true') && /branch_true[^}]*(completed|success)/.test(text)} false=${/branch_false[^}]*(completed|success)/.test(text)}`);
    if (amount === 5000 && op === ops[0]) await import('node:fs').then((fs) => fs.writeFileSync('research/probe_logs_sample.json', JSON.stringify(logs?.json ?? r.json, null, 2)));
  }
  console.log(`op=${JSON.stringify(op).padEnd(16)} save=${save.status} | ${runs.join(' | ')}`);
}
await call('POST', `/workflows/${id}/pause`);
console.log('workflow', id, '(paused)');
