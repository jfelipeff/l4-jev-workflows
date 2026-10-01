// Draft (Jev's judgments) -> Loopfour workflow JSON + Studio canvas, in plain code. Pure: runs on the
// server after planning and in the browser when the user answers a question, without asking Jev again.
//
// Formats verified against the live API (see README): action steps carry `action` + `config.operation`
// + `config.connection`; conditions use {left, operator, right} with then/else step ids; trigger data
// is {{input.x}} and step outputs are {{steps.<id>.<field>}}; the canvas needs a separate PATCH.

import type { Connection } from './loopfour.ts';
import { numeric } from './parse.ts';
import { OK } from './constants.ts';
import type { Alt, Draft, StepDraft } from './planner.ts';

export type Answers = Record<string, string>; // question id -> value chosen/typed by the user

export type Question = {
  id: string;
  stepId: string | null;
  kind: 'choose' | 'input' | 'info';
  prompt: string;
  options?: Alt[];
  replan?: boolean; // answering needs a new Jev round (different app/action), not just reassembly
};

export type StepView = {
  id: string;
  title: string;
  detail: string;
  kind: string;
  branch: 'then' | 'else' | null;
  confidence: number | null;
  config: Record<string, unknown>;
};

export type Assembled = {
  workflow: { name: string; description: string; trigger: Record<string, unknown>; steps: Record<string, unknown>[] };
  canvasState: Record<string, unknown>;
  questions: Question[];
  view: { trigger: { title: string; detail: string; confidence: number }; steps: StepView[] };
  ready: boolean; // no blocking question left
};

const COL = 360;
const ROW = { main: 220, then: 100, else: 360 };
const TRIGGERS: Record<string, string> = { api_trigger: 'api', schedule_trigger: 'schedule' };

export function assemble(draft: Draft, connections: Connection[], answers: Answers = {}): Assembled {
  const questions: Question[] = [];
  const t = draft.trigger;

  // ---------------------------------------------------------------- trigger
  let triggerType = t.type;
  if (!TRIGGERS[triggerType]) {
    questions.push({
      id: 'trigger_info',
      stepId: null,
      kind: 'info',
      prompt: `Jev picked the "${triggerType}" trigger. This builder only creates API and schedule triggers so far; the workflow starts as an API trigger. Change it in Studio if needed.`,
    });
    triggerType = 'api_trigger';
  }
  if (t.eventClause && triggerType === 'api_trigger') {
    questions.push({
      id: 'trigger_event',
      stepId: null,
      kind: 'info',
      prompt: `"${t.eventClause}" has no trigger block in Loopfour's catalog, so the workflow is started on demand (Run / API) with that event's data as its input.`,
    });
  }
  const cron = answers.cron ?? t.cron;
  const timezone = answers.timezone ?? t.timezone ?? 'UTC';
  if (triggerType === 'schedule_trigger' && (t.scheduleConfidence ?? 0) < OK && !answers.cron) {
    questions.push({ id: 'cron', stepId: null, kind: 'input', prompt: `Check the schedule (cron, ${timezone}). Jev read: ${cron}` });
  }
  const trigger = triggerType === 'schedule_trigger' ? { type: 'schedule', cron, timezone } : { type: 'api' };

  // ---------------------------------------------------------------- steps
  const steps: Record<string, unknown>[] = [];
  const views: StepView[] = [];
  const blocks: Record<string, unknown> = {
    trigger: canvasBlock('trigger', triggerType === 'schedule_trigger' ? 'Schedule' : 'API Trigger', triggerType, 120, ROW.main,
      triggerType === 'schedule_trigger' ? { cronExpression: sub('cronExpression', 'short-input', cron), timezone: sub('timezone', 'combobox', timezone) } : {}),
  };

  for (const s of draft.steps) {
    const { step, view, canvasType, subBlocks } = buildStep(s, draft, connections, answers, questions);
    steps.push(step);
    views.push(view);
    blocks[s.id] = canvasBlock(s.id, view.title, canvasType, 0, 0, subBlocks);
  }

  // Conditions: the then/else steps that follow them in the same sentence.
  const conditionIds = new Map<string, { then: string[]; else: string[] }>();
  let current: { then: string[]; else: string[] } | null = null;
  draft.steps.forEach((s, i) => {
    if (s.kind === 'condition') {
      current = { then: [], else: [] };
      conditionIds.set(s.id, current);
      return;
    }
    if (current && s.branch) current[s.branch].push(s.id);
    else current = null;
    void i;
  });
  for (const step of steps) {
    const c = conditionIds.get(step.id as string);
    if (!c) continue;
    const config = step.config as Record<string, unknown>;
    config.then = c.then.length ? c.then : [];
    if (c.else.length) config.else = c.else;
    if (!c.then.length) {
      questions.push({ id: `${step.id}_then`, stepId: step.id as string, kind: 'info', prompt: 'This condition has no step to run when it is true. Add one in Studio.' });
    }
  }

  // ---------------------------------------------------------------- canvas layout + edges
  const edges: Record<string, unknown>[] = [];
  const edge = (source: string, target: string, sourceHandle?: string) =>
    edges.push({ id: `e-${source}-${target}-0`, source, target, ...(sourceHandle && { sourceHandle }) });
  let col = 1;
  let tails = ['trigger'];
  for (let i = 0; i < draft.steps.length; i++) {
    const s = draft.steps[i];
    const pos = (id: string, c: number, row: number) => Object.assign(blocks[id] as object, { position: { x: 120 + c * COL, y: row } });
    if (s.kind === 'condition' && conditionIds.has(s.id)) {
      pos(s.id, col, ROW.main);
      tails.forEach((t) => edge(t, s.id));
      const c = conditionIds.get(s.id)!;
      const ends: string[] = [];
      let width = 0;
      for (const branch of ['then', 'else'] as const) {
        const ids = c[branch];
        if (!ids.length) {
          if (branch === 'else') ends.push(`${s.id}:false`);
          continue;
        }
        ids.forEach((id, k) => {
          pos(id, col + 1 + k, ROW[branch]);
          edge(k === 0 ? s.id : ids[k - 1], id, k === 0 ? (branch === 'then' ? 'true' : 'false') : undefined);
        });
        ends.push(ids[ids.length - 1]);
        width = Math.max(width, ids.length);
      }
      i += c.then.length + c.else.length;
      col += 1 + width;
      tails = ends;
      continue;
    }
    pos(s.id, col, ROW.main);
    tails.forEach((t) => (t.endsWith(':false') ? edge(t.split(':')[0], s.id, 'false') : edge(t, s.id)));
    tails = [s.id];
    col++;
  }

  const name = answers.name ?? `Jev: ${draft.description.replace(/\s+/g, ' ').slice(0, 80)}`;
  return {
    workflow: { name, description: `Built from: "${draft.description}" (Jev workflow builder)`, trigger, steps },
    canvasState: { blocks, edges, loops: {}, parallels: {} },
    questions,
    view: {
      trigger: {
        title: triggerType === 'schedule_trigger' ? 'Schedule' : 'API trigger (Run / API call)',
        detail: triggerType === 'schedule_trigger' ? `${cron} (${timezone})` : (t.eventClause ?? 'started on demand'),
        confidence: t.confidence,
      },
      steps: views,
    },
    ready: !questions.some((q) => q.kind !== 'info'),
  };
}

function buildStep(s: StepDraft, draft: Draft, connections: Connection[], answers: Answers, questions: Question[]) {
  const config: Record<string, unknown> = {};
  const subBlocks: Record<string, unknown> = {};
  const set = (id: string, value: unknown, control = 'short-input') => {
    config[id] = value;
    subBlocks[id] = sub(id, control, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const lowKind = s.kindConfidence < OK;
  let step: Record<string, unknown>;
  let title = '';
  let detail = s.clause;
  let canvasType: string = s.kind;
  let confidence: number | null = s.kindConfidence;

  if (s.kind === 'integration') {
    const blockType = answers[`${s.id}_block`] ?? s.block?.value;
    const def = s.action?.def;
    canvasType = blockType ?? 'api';
    title = def ? `${s.block?.name ?? blockType}: ${def.label}` : `${s.block?.name ?? 'Unknown app'}`;
    confidence = Math.min(s.block?.confidence ?? 0, s.action?.confidence ?? 0);
    if ((s.block?.confidence ?? 0) < OK || lowKind) {
      questions.push({ id: `${s.id}_block`, stepId: s.id, kind: 'choose', prompt: `Which app should "${s.clause}" use?`, options: s.block?.alternatives, replan: true });
    }
    if (!def || (s.action?.confidence ?? 0) < OK) {
      questions.push({
        id: `${s.id}_action`,
        stepId: s.id,
        kind: 'choose',
        prompt: def ? `Which ${s.block?.name} action is "${s.clause}"?` : `Jev found no ${s.block?.name ?? ''} action for "${s.clause}". Pick the app again.`,
        options: def ? s.action?.alternatives : s.block?.alternatives,
        replan: true,
      });
    }
    if (def?.opField) set(def.opField, def.op, 'dropdown');
    const conn = pickConnection(blockType, connections);
    if (conn.id) set('connection', conn.id, 'connection-selector');
    if (conn.question) questions.push({ ...conn.question, id: `${s.id}_connection`, stepId: s.id, options: conn.question.options });
    if (answers[`${s.id}_connection`]) set('connection', answers[`${s.id}_connection`], 'connection-selector');

    for (const [id, f] of Object.entries(s.fields)) {
      const answered = answers[`${s.id}.${id}`];
      let value = answered ?? f.value;
      if (value != null && (f.field.valueType === 'number') && !value.startsWith('{{')) value = numeric(value) ?? value;
      if (value != null && value !== '') set(id, f.field.valueType === 'number' && !value.startsWith('{{') ? Number(value) : value, f.field.control);
      else if (f.field.required || isMessageField(f.field.id, f.field.title, def)) {
        questions.push({ id: `${s.id}.${id}`, stepId: s.id, kind: 'input', prompt: `"${f.field.title}" for ${title}${f.field.description ? ` (${f.field.description})` : ''}`, options: f.alternatives });
      }
    }
    step = { id: s.id, name: title, type: 'action', action: def?.id ?? `${blockType}.unknown`, config };
  } else if (s.kind === 'condition') {
    const c = s.condition!;
    const left = answers[`${s.id}.left`] ?? c.left.value;
    const operator = answers[`${s.id}.operator`] ?? c.operator.value ?? 'eq';
    const right = answers[`${s.id}.right`] ?? c.right.value;
    title = 'Condition';
    confidence = Math.min(...[c.left, c.operator, c.right].map((x) => x.confidence ?? 1), s.kindConfidence);
    if (!left) questions.push({ id: `${s.id}.left`, stepId: s.id, kind: 'input', prompt: `What does "${s.clause}" test? (e.g. {{input.amount}})` });
    if (right == null && !['exists', 'isEmpty'].includes(operator)) {
      questions.push({ id: `${s.id}.right`, stepId: s.id, kind: 'input', prompt: `Compare against which value in "${s.clause}"?` });
    }
    if ((c.operator.confidence ?? 0) < OK) questions.push({ id: `${s.id}.operator`, stepId: s.id, kind: 'choose', prompt: `Which comparison is "${s.clause}"?`, options: c.operator.alternatives });
    const conditions = { left: left ?? '', operator, ...(right != null && { right: String(right) }) };
    config.conditions = conditions;
    // Studio's own editor stores conditions as [{field, operator, value}] with "equals" for eq.
    subBlocks.conditions = sub('conditions', 'condition-input', [{ field: conditions.left, operator: operator === 'eq' ? 'equals' : operator, value: conditions.right ?? '' }] as unknown as string);
    subBlocks.combineOperator = sub('combineOperator', 'dropdown', 'AND');
    detail = `${left ?? '?'} ${operator} ${right ?? ''}`.trim();
    step = { id: s.id, name: `Condition: ${s.clause}`.slice(0, 120), type: 'condition', config };
  } else if (s.kind === 'approval') {
    const approvers = answers[`${s.id}.approvers`] ?? s.fields.approvers?.value;
    title = 'Approval';
    set('reason', s.clause, 'long-input'); // the user's own words, copied
    set('timeout', '24h');
    if (approvers) set('approvers', approvers, 'long-input');
    else questions.push({ id: `${s.id}.approvers`, stepId: s.id, kind: 'input', prompt: `Approver email(s) for "${s.clause}"` });
    step = { id: s.id, name: `Approval: ${s.clause}`.slice(0, 120), type: 'approval', action: 'approval.request', config };
  } else if (s.kind === 'wait') {
    title = 'Wait';
    const duration = answers[`${s.id}.duration`] ?? s.fields.duration?.value;
    const unit = answers[`${s.id}.unit`] ?? s.fields.unit?.value ?? 'minutes';
    if (duration) config.duration = Number(duration);
    else questions.push({ id: `${s.id}.duration`, stepId: s.id, kind: 'input', prompt: `How long should "${s.clause}" wait (in ${unit})?` });
    config.unit = unit;
    subBlocks.duration = sub('duration', 'short-input', String(duration ?? ''));
    subBlocks.unit = sub('unit', 'dropdown', unit);
    detail = `${duration ?? '?'} ${unit}`;
    step = { id: s.id, name: `Wait ${detail}`, type: 'wait', config };
  } else {
    title = 'API Request';
    canvasType = 'api';
    const url = answers[`${s.id}.url`] ?? s.fields.url?.value;
    if (url) set('url', url);
    else questions.push({ id: `${s.id}.url`, stepId: s.id, kind: 'input', prompt: `URL to call for "${s.clause}" (https://...)` });
    set('method', 'POST', 'dropdown');
    step = { id: s.id, name: `API request: ${s.clause}`.slice(0, 120), type: 'action', action: 'api.request', config };
  }

  if (lowKind && s.kind !== 'integration') {
    questions.push({ id: `${s.id}_kind`, stepId: s.id, kind: 'info', prompt: `Jev was unsure "${s.clause}" is a ${s.kind} step (${Math.round(s.kindConfidence * 100)}%).` });
  }
  void draft;
  const view: StepView = { id: s.id, title, detail, kind: s.kind, branch: s.branch, confidence, config };
  return { step, view, canvasType, subBlocks };
}

/** The text of a send/post/notify action: an empty one would send an empty message. */
function isMessageField(id: string, title: string, def: { op: string } | undefined) {
  return !!def && /^(send|post|reply|schedule|create(draft|message))/i.test(def.op) && /^(text|message|body|content)$/i.test(id + '') && !!title;
}

/** The user's connection for an app: the only active one, else the default active one, else ask. */
function pickConnection(provider: string | null | undefined, connections: Connection[]) {
  const mine = connections.filter((c) => c.provider === provider);
  const active = mine.filter((c) => c.status === 'active');
  const chosen = active.length === 1 ? active[0] : active.find((c) => c.isDefault);
  if (chosen) return { id: chosen.id };
  if (active.length > 1) {
    return {
      id: active[0].id,
      question: { kind: 'choose' as const, prompt: `Which ${provider} connection?`, options: active.map((c) => ({ id: c.id, label: `${c.provider} ${c.id.slice(0, 8)}`, p: 0 })) },
    };
  }
  return {
    id: null,
    question: {
      kind: 'info' as const,
      prompt: mine.length
        ? `Your ${provider} connection is ${mine[0].status}. Finish connecting it in Studio before running.`
        : `No ${provider} connection in this workspace. Connect ${provider} in Studio before running.`,
      options: undefined,
    },
  };
}

const sub = (id: string, type: string, value: string) => ({ id, type, value });
const canvasBlock = (id: string, name: string, type: string, x: number, y: number, subBlocks: Record<string, unknown>) => ({
  id,
  name,
  type,
  enabled: true,
  outputs: {},
  position: { x, y },
  subBlocks,
  horizontalHandles: true,
});
