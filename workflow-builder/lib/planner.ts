// Description -> workflow draft, with Jev making every judgment and code doing everything else.
//
//   round 1  trigger type + schedule parts, and per clause: what kind of step it is, which app,
//            and (for clauses split on a bare "and") whether it is really the same step
//   round 2  per step: which action of its top-2 apps (speculative), condition operator/operands,
//            approvers
//   round 3  config fields of the chosen actions, each a Choice among values found in the text,
//            data from earlier steps, or "none"
//
// Each round is ONE request to the TypeSafe API. No LLM is involved anywhere.

import type { Action, Block, Catalog, Field } from './catalog.ts';
import { askJev, choice, JEV_PRICE_PER_TOKEN, noul, topK, type Answers, type JevCache, type Question } from './jev.ts';
import { findValues, numeric, splitClauses, subjectOf, type Value } from './parse.ts';

import { OK } from './constants.ts';
export { OK };

export type Alt = { id: string; label: string; p: number };
export type Pick<T = string> = { value: T | null; confidence: number | null; alternatives?: Alt[] };

export type StepKind = 'integration' | 'condition' | 'approval' | 'wait' | 'http';
export type StepDraft = {
  id: string;
  clause: string;
  branch: 'then' | 'else' | null;
  kind: StepKind;
  kindConfidence: number;
  block?: Pick & { name?: string };
  action?: Pick & { label?: string; def?: Action };
  fields: Record<string, Pick & { field: Field }>;
  condition?: { left: Pick; operator: Pick; right: Pick };
  outputs: string[];
};
export type TriggerDraft = {
  type: string; // catalog trigger type, e.g. api_trigger / schedule_trigger
  confidence: number;
  alternatives: Alt[];
  cron?: string;
  timezone?: string;
  scheduleConfidence?: number;
  eventClause?: string; // the clause that describes the start, when it is not a step
};
export type Draft = {
  description: string;
  trigger: TriggerDraft;
  steps: StepDraft[];
  blockNames: Record<string, string>;
  usage: { rounds: number; questions: number; jevMs: number; inputTokens: number; usd: number; model: string };
};
/** User corrections, keyed by clause text: forces the app/action instead of asking Jev. */
export type Force = Record<string, { block?: string; action?: string; kind?: StepKind }>;

const KINDS: Record<StepKind | 'trigger', string> = {
  trigger: 'Describes when or why the workflow starts (an incoming event or a schedule), not a step to perform',
  integration: 'A step done in an external app or service: send, post, notify, create, update, look up, sync, sign, invoice, charge',
  condition: 'Checks whether something is true to decide which steps run (if ..., only when ..., unless ...)',
  approval: 'Asks a person to approve, sign off on or review something before the workflow continues',
  wait: 'Pauses the workflow for a period of time (wait 2 hours, delay one day)',
  http: 'Calls a URL or HTTP API of a service that is not one of the listed apps',
};

const OPERATORS: Record<string, string> = {
  gt: 'is greater than, over, above, more than, exceeds',
  gte: 'is at least, greater than or equal to',
  lt: 'is less than, under, below',
  lte: 'is at most, less than or equal to',
  eq: 'is equal to, is, equals',
  ne: 'is not equal to, is not, differs from',
  contains: 'contains, includes, mentions',
  startsWith: 'starts with, begins with',
  endsWith: 'ends with',
  exists: 'exists, is present, is set, has a value',
  isEmpty: 'is empty, is missing, is blank',
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NONE = 'none';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'} (${String(h).padStart(2, '0')}:00)`;

function alts(a: ReturnType<typeof choice>, labels: Record<string, string>, k = 3): Alt[] {
  return topK(a, k, [NONE]).map(({ id, p }) => ({ id, label: labels[id] ?? id, p }));
}

export async function plan(
  description: string,
  catalog: Catalog,
  opts: { cache?: JevCache; force?: Force; jevKey?: string } = {},
): Promise<Draft> {
  const usage = { rounds: 0, questions: 0, jevMs: 0, inputTokens: 0, usd: 0, model: '' };
  const ask = async (state: unknown, qs: Record<string, Question>) => {
    const r = await askJev(state, qs, opts.cache, opts.jevKey);
    if (r.questions) {
      usage.rounds++;
      usage.questions += r.questions;
      usage.jevMs += r.ms;
      usage.inputTokens += r.inputTokens;
      usage.model = r.model;
    }
    return r.answers;
  };

  const integrations = catalog.blocks.filter((b) => b.kind === 'integrations');
  const blockLabels = Object.fromEntries(catalog.blocks.map((b) => [b.type, b.name]));
  const raw = splitClauses(description);
  const clauses = raw.map((c) => c.text);

  // ---------------------------------------------------------------- round 1
  const scheduleTrigger = catalog.triggers.find((t) => t.type === 'schedule_trigger');
  const tzOptions = scheduleTrigger?.actions[0]?.fields.find((f) => f.id === 'timezone')?.options ?? [];
  const r1: Record<string, Question> = {
    trigger: {
      type: 'choice',
      instructions:
        'How does the workflow described in `description` start? Pick the trigger. If it names no schedule and none of ' +
        'these event sources, it is started on demand (API).',
      criteria: Object.fromEntries(
        catalog.triggers.map((t) => [
          t.type,
          t.type === 'api_trigger'
            ? `${t.description}. Also the right choice when the starting event comes from an app that is not in this list.`
            : `${t.name}: ${t.description}`,
        ]),
      ),
    },
    sched_freq: {
      type: 'choice',
      instructions: 'If `description` says the workflow runs on a schedule, how often?',
      criteria: {
        hourly: 'every hour',
        daily: 'every day',
        weekdays: 'every weekday (Monday to Friday)',
        weekly: 'once a week on a given day',
        monthly: 'once a month on a given day of the month',
        [NONE]: 'no schedule is described',
      },
    },
    sched_weekday: {
      type: 'choice',
      instructions: 'If the schedule in `description` names a day of the week, which one?',
      criteria: { ...Object.fromEntries(WEEKDAYS.map((d) => [d, null])), [NONE]: 'no day of the week is named' },
    },
    sched_hour: {
      type: 'choice',
      instructions: 'If the schedule in `description` names a time of day, which hour?',
      criteria: { ...Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), hourLabel(h)])), [NONE]: 'no time is named' },
    },
    sched_minute: {
      type: 'choice',
      instructions: 'If the schedule in `description` names a time of day, which minute of the hour?',
      criteria: { '0': ':00 or a whole hour', '15': ':15', '30': ':30 or half past', '45': ':45', [NONE]: 'no time is named' },
    },
    sched_monthday: {
      type: 'choice',
      instructions: 'If the schedule in `description` names a day of the month (the 1st, the 15th, the last day), which one?',
      criteria: { ...Object.fromEntries(Array.from({ length: 28 }, (_, d) => [String(d + 1), null])), [NONE]: 'no day of the month is named' },
    },
    ...(tzOptions.length && {
      sched_tz: {
        type: 'choice',
        instructions: 'If `description` names a time zone or a city/region for the schedule, which time zone?',
        criteria: { ...Object.fromEntries(tzOptions.map((o) => [o.id, o.label])), [NONE]: 'no time zone is named' },
      },
    }),
  };
  clauses.forEach((_, i) => {
    r1[`kind_${i}`] = {
      type: 'choice',
      instructions: `What does \`clauses[${i}]\` describe, as part of the workflow in \`description\`?`,
      criteria: KINDS,
    };
    r1[`block_${i}`] = {
      type: 'choice',
      instructions: `Which app does \`clauses[${i}]\` use or act in? Read it in the context of \`description\`.`,
      criteria: { ...Object.fromEntries(integrations.map((b) => [b.type, `${b.name}: ${b.description}`])), [NONE]: 'none of these apps' },
    };
    if (raw[i].softSplit) {
      r1[`same_${i}`] = {
        type: 'noul',
        instructions: `Are \`clauses[${i - 1}]\` and \`clauses[${i}]\` one single step done with one action, rather than two separate steps?`,
      };
    }
  });
  const a1 = await ask({ description, clauses }, r1);

  // Merge clauses Jev says are the same step, then turn clauses into step drafts.
  type Item = { text: string; branch: StepDraft['branch']; idx: number };
  const items: Item[] = [];
  raw.forEach((c, i) => {
    const same = c.softSplit && (noul(a1, `same_${i}`) ?? 0) > 0.5;
    if (same && items.length) items[items.length - 1].text += `, and ${c.text}`;
    else items.push({ text: c.text, branch: c.branch, idx: i });
  });

  const trigger = readTrigger(a1, catalog);
  const steps: StepDraft[] = [];
  for (const [n, item] of items.entries()) {
    const kindA = choice(a1, `kind_${item.idx}`);
    let kind = (kindA?.choice ?? 'integration') as StepKind | 'trigger';
    const forced = opts.force?.[item.text];
    if (forced?.kind) kind = forced.kind;
    if (kind === 'trigger') {
      trigger.eventClause = item.text;
      continue;
    }
    const blockA = choice(a1, `block_${item.idx}`);
    const step: StepDraft = { id: '', clause: item.text, branch: item.branch, kind, kindConfidence: kindA?.confidence ?? 0, fields: {}, outputs: [] };
    if (kind === 'integration') {
      const top = forced?.block ? [{ id: forced.block, p: 1 }] : topK(blockA, 2, [NONE]);
      step.block = {
        value: top[0]?.id ?? null,
        confidence: forced?.block ? 1 : (blockA?.confidence ?? null),
        alternatives: alts(blockA, blockLabels),
        name: top[0] ? blockLabels[top[0].id] : undefined,
      };
      (step as StepDraft & { candidates?: string[] }).candidates = top.map((t) => t.id);
    }
    steps.push(step);
  }
  // Stable ids: block type + position, so later rounds can reference earlier steps.
  steps.forEach((s, n) => {
    const base = s.kind === 'integration' ? (s.block?.value ?? 'step') : s.kind;
    s.id = slug(`${base}_${n + 1}`);
    s.outputs = outputsFor(s, catalog);
  });

  // ---------------------------------------------------------------- round 2
  const stepClauses = steps.map((s) => s.clause);
  const allValues = findValues(description);
  const r2: Record<string, Question> = {};
  steps.forEach((s, n) => {
    const ref = `\`steps[${n}]\``;
    if (s.kind === 'integration') {
      const cands = opts.force?.[s.clause]?.action ? [] : ((s as StepDraft & { candidates?: string[] }).candidates ?? []);
      for (const type of cands) {
        const block = catalog.byType[type];
        if (!block?.actions.length) continue;
        r2[`action_${n}_${type}`] = {
          type: 'choice',
          instructions: `Which ${block.name} action does ${ref} ask for?`,
          criteria: { ...Object.fromEntries(block.actions.slice(0, 254).map((a) => [a.op, a.label])), [NONE]: `none of these ${block.name} actions` },
        };
      }
    }
    if (s.kind === 'condition') {
      r2[`op_${n}`] = {
        type: 'choice',
        instructions: `Which comparison does the condition in ${ref} make?`,
        criteria: OPERATORS,
      };
      const lefts = dataRefs(steps.slice(0, n), s.clause, blockLabels);
      if (lefts.length) {
        r2[`left_${n}`] = {
          type: 'choice',
          instructions: `Which value does the condition in ${ref} test?`,
          criteria: { ...Object.fromEntries(lefts.map((r) => [r.ref, r.label])), [NONE]: 'none of these values' },
        };
      }
      const rights = findValues(s.clause).filter((v) => ['money', 'number', 'percent', 'quoted', 'email'].includes(v.kind));
      if (rights.length) {
        r2[`right_${n}`] = {
          type: 'choice',
          instructions: `Which value is the tested value compared against in ${ref}?`,
          criteria: { ...Object.fromEntries(rights.map((v) => [v.value, `${v.kind}`])), [NONE]: 'none of these values' },
        };
      }
    }
    if (s.kind === 'approval') {
      const emails = allValues.filter((v) => v.kind === 'email');
      if (emails.length) {
        r2[`approvers_${n}`] = {
          type: 'choice',
          instructions: `Whose approval does ${ref} ask for, in the context of \`description\`?`,
          criteria: { ...Object.fromEntries(emails.map((v) => [v.value, null])), [NONE]: 'none of these people' },
        };
      }
    }
  });
  const a2 = await ask({ description, steps: stepClauses }, r2);

  steps.forEach((s, n) => {
    if (s.kind === 'integration') {
      // Best (block, action) pair across the speculative blocks: P(block) * P(action | block).
      const forced = opts.force?.[s.clause];
      const cands = (s as StepDraft & { candidates?: string[] }).candidates ?? [];
      delete (s as StepDraft & { candidates?: string[] }).candidates;
      let best: { block: Block; action: Action; score: number; conf: number; alts: Alt[] } | null = null;
      for (const type of cands) {
        const block = catalog.byType[type];
        if (!block) continue;
        if (forced?.action) {
          const action = block.actions.find((a) => a.id === forced.action);
          if (action) best = { block, action, score: 1, conf: 1, alts: [] };
          continue;
        }
        const a = choice(a2, `action_${n}_${type}`);
        if (!a || a.choice === NONE) continue;
        const pBlock = s.block?.alternatives?.find((x) => x.id === type)?.p ?? 0;
        const score = pBlock * (a.probabilities[a.choice] ?? 0);
        const action = block.actions.find((x) => x.op === a.choice);
        if (action && (!best || score > best.score)) {
          best = { block, action, score, conf: a.confidence, alts: alts(a, Object.fromEntries(block.actions.map((x) => [x.op, x.label]))) };
        }
      }
      if (best) {
        if (best.block.type !== s.block?.value) s.block = { ...s.block!, value: best.block.type, name: best.block.name };
        s.action = { value: best.action.id, label: best.action.label, confidence: best.conf, alternatives: best.alts, def: best.action };
        s.id = slug(`${best.block.type}_${n + 1}`);
        s.outputs = outputsFor(s, catalog);
      } else {
        s.action = { value: null, confidence: null };
      }
    }
    if (s.kind === 'condition') {
      const op = choice(a2, `op_${n}`);
      const left = choice(a2, `left_${n}`);
      const right = choice(a2, `right_${n}`);
      const rightValue = right && right.choice !== NONE ? (numeric(right.choice) ?? right.choice) : null;
      s.condition = {
        operator: { value: op?.choice ?? null, confidence: op?.confidence ?? null, alternatives: alts(op, OPERATORS) },
        left: { value: left && left.choice !== NONE ? left.choice : null, confidence: left?.confidence ?? null },
        right: { value: rightValue, confidence: right?.confidence ?? null },
      };
    }
    if (s.kind === 'approval') {
      const who = choice(a2, `approvers_${n}`);
      s.fields.approvers = {
        field: { id: 'approvers', title: 'Approvers', control: 'long-input', valueType: 'string', description: 'Comma-separated approver emails', required: true },
        value: who && who.choice !== NONE ? who.choice : null,
        confidence: who?.confidence ?? null,
      };
    }
    if (s.kind === 'wait') {
      const d = findValues(s.clause).find((v) => v.kind === 'duration');
      const m = d?.value.match(/(\d+)\s*(second|minute|hour|day|week)/i);
      const unit = m ? m[2].toLowerCase() : null;
      const amount = m ? Number(m[1]) * (unit === 'week' ? 7 : 1) : null;
      const f = (id: string, value: string | null): StepDraft['fields'][string] => ({
        field: { id, title: id, control: 'short-input', valueType: 'string', description: '', required: true },
        value,
        confidence: value ? 1 : null,
      });
      s.fields.duration = f('duration', amount ? String(amount) : null);
      s.fields.unit = f('unit', unit ? `${unit === 'week' ? 'day' : unit}s` : null);
    }
    if (s.kind === 'http') {
      const url = findValues(s.clause).find((v) => v.kind === 'url');
      s.fields.url = {
        field: { id: 'url', title: 'URL', control: 'short-input', valueType: 'string', description: 'Request URL', required: true },
        value: url?.value ?? null,
        confidence: url ? 1 : null,
      };
    }
  });

  // ---------------------------------------------------------------- round 3
  const r3: Record<string, Question> = {};
  const fieldQs: { n: number; field: Field; key: string; labels: Record<string, string> }[] = [];
  steps.forEach((s, n) => {
    const def = s.action?.def;
    if (!def) return;
    const clauseValues = findValues(s.clause);
    const refs = dataRefs(steps.slice(0, n), s.clause, blockLabels);
    def.fields.forEach((field, k) => {
      if (['code', 'table-selector', 'account-selector', 'slider', 'switch'].includes(field.control)) return;
      const key = `f_${n}_${k}`;
      let criteria: Record<string, string | null> = {};
      if (field.options?.length) {
        // An optional dropdown is only worth asking about when the text mentions one of its options.
        const text = `${s.clause} ${description}`.toLowerCase();
        const mentioned = field.options.some((o) => words(o.label).every((w) => text.includes(w)));
        if (!field.required && !mentioned) return;
        criteria = Object.fromEntries(field.options.slice(0, 254).map((o) => [o.id, o.label]));
      } else {
        const vals = valuesFor(field, clauseValues, allValues);
        if (!vals.length && !field.required) return; // nothing in the text could fill it: leave the default
        for (const v of vals) criteria[v.value] = v.kind;
        for (const r of refs) criteria[r.ref] = r.label;
        if (!Object.keys(criteria).length) return;
      }
      criteria[NONE] = 'none of these: the description does not say';
      r3[key] = {
        type: 'choice',
        instructions: {
          question: `Which value should fill the "${field.title}" field of the ${s.block?.name} "${s.action?.label}" step in \`steps[${n}]\`?`,
          field: field.description || field.title,
        },
        criteria,
      };
      fieldQs.push({ n, field, key, labels: criteria as Record<string, string> });
    });
  });
  const a3 = await ask({ description, steps: stepClauses }, r3);
  for (const { n, field, key, labels } of fieldQs) {
    const a = choice(a3, key);
    const value = a && a.choice !== NONE && a.confidence >= OK ? a.choice : null;
    steps[n].fields[field.id] = { field, value, confidence: a?.confidence ?? null, alternatives: alts(a, labels) };
  }
  // Required fields nobody could fill still show up, empty, so the UI can ask for them.
  for (const s of steps) {
    for (const field of s.action?.def?.fields ?? []) {
      const isMessage = /^(text|message|body|content)$/i.test(field.id);
      if ((field.required || isMessage) && !s.fields[field.id]) s.fields[field.id] = { field, value: null, confidence: null };
    }
  }

  usage.usd = usage.inputTokens * JEV_PRICE_PER_TOKEN;
  return { description, trigger, steps, blockNames: blockLabels, usage };
}

function readTrigger(a: Answers, catalog: Catalog): TriggerDraft {
  const t = choice(a, 'trigger');
  const labels = Object.fromEntries(catalog.triggers.map((x) => [x.type, x.name]));
  const out: TriggerDraft = { type: t?.choice ?? 'api_trigger', confidence: t?.confidence ?? 0, alternatives: alts(t, labels) };
  if (out.type !== 'schedule_trigger') return out;

  const get = (id: string) => {
    const c = choice(a, id);
    return c && c.choice !== NONE ? c : null;
  };
  const freq = get('sched_freq');
  const hour = get('sched_hour');
  const minute = get('sched_minute');
  const weekday = get('sched_weekday');
  const monthday = get('sched_monthday');
  const h = hour?.choice ?? '9';
  const m = minute?.choice ?? '0';
  const dow = weekday ? String(WEEKDAYS.indexOf(weekday.choice) + 1).replace('7', '0') : '1';
  const cron: Record<string, string> = {
    hourly: `${m} * * * *`,
    daily: `${m} ${h} * * *`,
    weekdays: `${m} ${h} * * 1-5`,
    weekly: `${m} ${h} * * ${dow}`,
    monthly: `${m} ${h} ${monthday?.choice ?? '1'} * *`,
  };
  out.cron = cron[freq?.choice ?? 'daily'] ?? cron.daily;
  out.timezone = get('sched_tz')?.choice ?? 'UTC';
  const used = [freq, hour, freq?.choice === 'weekly' ? weekday : null, freq?.choice === 'monthly' ? monthday : null].filter(Boolean);
  out.scheduleConfidence = used.length ? Math.min(...used.map((c) => c!.confidence)) : 0;
  return out;
}

function outputsFor(s: StepDraft, catalog: Catalog): string[] {
  if (s.kind === 'integration') return catalog.byType[s.block?.value ?? '']?.outputs ?? [];
  return catalog.byType[s.kind === 'http' ? 'api' : s.kind]?.outputs ?? [];
}

/** Data a field or condition could read: the trigger input it talks about, and earlier steps' outputs. */
function dataRefs(previous: StepDraft[], clause: string, blockNames: Record<string, string>) {
  const refs: { ref: string; label: string }[] = [];
  const subject = subjectOf(clause);
  if (subject) refs.push({ ref: `{{input.${subject}}}`, label: `the "${subject}" field of the data the workflow was started with` });
  for (const p of previous) {
    const who = p.kind === 'integration' ? `${blockNames[p.block?.value ?? ''] ?? p.block?.value} step "${p.clause}"` : `${p.kind} step "${p.clause}"`;
    for (const out of p.outputs.slice(0, 8)) refs.push({ ref: `{{steps.${p.id}.${out}}}`, label: `the "${out}" returned by the ${who}` });
  }
  return refs;
}

const STOP = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'to', 'in', 'for', 'by', 'on', '&', '-']);
const words = (label: string) => label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

/** Values from the text that fit a field, by field name and type; the clause's own values first. */
function valuesFor(field: Field, clauseValues: Value[], allValues: Value[]): Value[] {
  const name = `${field.id} ${field.title}`.toLowerCase();
  const kinds = /email|recipient|\bto\b|\bcc\b|approver/.test(name)
    ? ['email']
    : /channel/.test(name)
      ? ['channel']
      : /user|mention|assignee/.test(name)
        ? ['mention', 'email']
        : /url|link|endpoint/.test(name)
          ? ['url']
          : /amount|price|total|value|quantity|qty|rate/.test(name) || field.valueType === 'number'
            ? ['money', 'number', 'percent']
            : /text|message|body|subject|note|description|comment|memo|title|content/.test(name)
              ? ['message', 'quoted']
              : ['quoted', 'email', 'channel', 'url', 'money', 'number'];
  const pick = (vs: Value[]) => vs.filter((v) => kinds.includes(v.kind));
  const own = pick(clauseValues);
  const rest = kinds.includes('email') || kinds.includes('channel') ? pick(allValues).filter((v) => !own.some((o) => o.value === v.value)) : [];
  return [...own, ...rest].slice(0, 20);
}
