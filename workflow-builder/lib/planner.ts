// Description -> workflow draft, with Jev making every judgment and code doing everything else.
//
// The core idea: every part of the description is classified against what each block DOES. Blocks
// are all the apps in the catalog plus the core blocks (AI Agent, Condition, Approval, Wait, API
// Request), each described by when to use it. One clause can need several blocks ("scan Stripe
// events for duplicate charges" = Stripe to fetch + AI Agent to detect).
//
//   round 1  trigger + schedule parts; per clause: the main block (Choice), one yes/no per block
//            ("does this part need it?"), "is it only the trigger?", "same step as the previous
//            clause?"; whole description: "should results be sent to someone?", closest template
//   round 2  per step: the action of its app, condition operator/operands, approvers; whether the
//            closest template really fits
//   round 3  config fields of the chosen actions, each a Choice among values found in the text,
//            data from earlier steps, or "none"
//
// Each round is ONE request to the TypeSafe API. No LLM is involved anywhere.

import type { Action, Catalog, Field } from './catalog.ts';
import { askJev, choice, JEV_PRICE_PER_TOKEN, noul, topK, type Answers, type JevCache, type Question } from './jev.ts';
import { findValues, numeric, splitClauses, subjectOf, type Value } from './parse.ts';

import { OK } from './constants.ts';
export { OK };

export type Alt = { id: string; label: string; p: number };
export type Pick<T = string> = { value: T | null; confidence: number | null; alternatives?: Alt[] };

export type StepKind = 'integration' | 'agent' | 'condition' | 'approval' | 'wait' | 'http';
export type Role = 'fetch' | 'analyze' | 'decide' | 'approve' | 'act' | 'notify' | 'wait';
export type StepDraft = {
  id: string;
  clause: string;
  branch: 'then' | 'else' | null;
  kind: StepKind;
  role: Role;
  blockType: string; // catalog block type: "stripe", "agent", "condition", ...
  forceKey: string; // key the UI uses to correct this step's block/action
  kindConfidence: number; // how sure Jev is that this part of the clause needs this block
  block?: Pick & { name?: string };
  action?: Pick & { label?: string; def?: Action };
  fields: Record<string, Pick & { field: Field }>;
  condition?: { left: Pick; operator: Pick; right: Pick };
  prompt?: string; // AI Agent: the user's own words for this part, copied
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
export type Template = { slug: string; name: string; description: string; steps?: { name?: string }[] };
export type Draft = {
  description: string;
  trigger: TriggerDraft;
  steps: StepDraft[];
  blockNames: Record<string, string>;
  notify: { implied: number; covered: boolean; options: Alt[] }; // "send the results somewhere?"
  template: { slug: string; name: string; fit: number } | null;
  usage: { rounds: number; questions: number; jevMs: number; inputTokens: number; usd: number; model: string };
};
/**
 * User corrections. "<clause>::<blockType>" -> use another block / action for that step, or drop it;
 * "__notify__" -> add a step that sends the results with this app ("none" = don't).
 */
export type Force = Record<string, { block?: string; action?: string; remove?: boolean }>;

/** Core blocks the builder can assemble, described by WHEN to use them (Jev reads these literally). */
const CORE_USE: Record<string, { kind: StepKind; role: Role; use: string }> = {
  agent: {
    kind: 'agent',
    role: 'analyze',
    use:
      'AI judgement over data: detect anomalies, issues or fraud, classify or categorize, summarize, extract fields from ' +
      'documents or messages, score, review, or decide something from unstructured content',
  },
  condition: {
    kind: 'condition',
    role: 'decide',
    use: 'An explicit rule code can check to choose which steps run, like "if the amount is over $5,000" or "only when the status is paid"',
  },
  approval: { kind: 'approval', role: 'approve', use: 'Pause until a person approves, signs off on or reviews something' },
  wait: { kind: 'wait', role: 'wait', use: 'Pause for a set amount of time, like "wait 2 hours" or "a day later"' },
  api: { kind: 'http', role: 'act', use: 'Call an HTTP URL or the API of a service that is not one of the listed apps' },
};
const ROLE_ORDER: Role[] = ['fetch', 'analyze', 'decide', 'approve', 'wait', 'act', 'notify'];
const NOTIFY_APPS = ['slack', 'gmail', 'outlook', 'resend'];

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
const USES = 0.5; // a block is part of a clause when its yes/no is at least this
const MAX_BLOCKS_PER_CLAUSE = 3;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'} (${String(h).padStart(2, '0')}:00)`;

function alts(a: ReturnType<typeof choice>, labels: Record<string, string>, k = 3): Alt[] {
  return topK(a, k, [NONE]).map(({ id, p }) => ({ id, label: labels[id] ?? id, p }));
}

const CUES: Record<string, RegExp> = {
  condition: /^(?:if|when|whenever|unless|only if|only when|in case)\b/i,
  approval: /approv|sign[ -]?off|authori[sz]|review and confirm/i,
  wait: /\b(?:wait|delay|pause|later|after)\b.*\d|\d.*\b(?:later|after)\b/i,
  api: /https?:\/\/|\bapi\b|webhook|endpoint/i,
};

/**
 * Whether a block's yes/no should add it to a clause (besides Jev's main pick). Measured on the test
 * cases: apps the clause names score ~0.95 and unnamed apps 0.4-0.6, and control blocks score high
 * next to an "if" or a delay, so apps must be named and control blocks need their textual cue.
 */
function selected(type: string, name: string, p: number, clause: string): boolean {
  if (type === 'agent') return p >= USES && !CUES.condition.test(clause); // "if X > 5000" is a rule, not AI judgement
  if (CUES[type]) return p >= 0.7 && CUES[type].test(clause);
  return p >= 0.85 && names(name, type).some((n) => clause.toLowerCase().includes(n));
}
/** "Google Sheets" -> ["google sheets", "google sheet", "googlesheets"]; "dropbox-sign" -> ["dropbox sign", ...]. */
const names = (name: string, type: string) => {
  const base = name.toLowerCase();
  return [...new Set([base, base.replace(/s$/, ''), base.replace(/\s+/g, ''), type.replace(/-/g, ' '), type])];
};

/** Role of an app step from its action: list/get/search reads, send/post notifies, the rest acts. */
function roleOfAction(blockType: string, op: string): Role {
  if (/^(list|get|search|query|fetch|retrieve|read|find|lookup|run|download|export|describe)/i.test(op)) return 'fetch';
  if (NOTIFY_APPS.includes(blockType) && /^(send|post|reply|schedule|createDraft)/i.test(op)) return 'notify';
  return 'act';
}

export async function plan(
  description: string,
  catalog: Catalog,
  opts: { cache?: JevCache; force?: Force; jevKey?: string; templates?: Template[] } = {},
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
  const force = opts.force ?? {};

  // Every block Jev can choose, with "what it is for" in plain words.
  const blocks = [
    ...catalog.blocks.filter((b) => b.kind === 'integrations').map((b) => ({ type: b.type, name: b.name, use: `Read or write data in ${b.name}: ${b.description}` })),
    ...Object.entries(CORE_USE)
      .filter(([type]) => catalog.byType[type])
      .map(([type, c]) => ({ type, name: catalog.byType[type].name, use: c.use })),
  ];
  const blockLabels = Object.fromEntries([...catalog.blocks, ...catalog.triggers].map((b) => [b.type, b.name]));
  const blockCriteria = Object.fromEntries(blocks.map((b) => [b.type, `${b.name}: ${b.use}`]));
  const raw = splitClauses(description);
  const clauses = raw.map((c) => c.text);

  // ---------------------------------------------------------------- round 1
  const scheduleTrigger = catalog.triggers.find((t) => t.type === 'schedule_trigger');
  const tzOptions = scheduleTrigger?.actions[0]?.fields.find((f) => f.id === 'timezone')?.options ?? [];
  const templates = (opts.templates ?? []).slice(0, 254);
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
        daily: 'every day (daily)',
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
    notify_implied: {
      type: 'noul',
      instructions:
        'Does the workflow in `description` produce findings or results that a person or team would need to be told about ' +
        '(an alert, a report, a summary), whether or not it says how?',
    },
    ...(templates.length && {
      template: {
        type: 'choice',
        instructions: 'Which of these ready-made Loopfour workflow templates does the same job as `description`?',
        criteria: { ...Object.fromEntries(templates.map((t) => [t.slug, `${t.name}: ${t.description}`])), [NONE]: 'none of these templates' },
      },
    }),
  };
  clauses.forEach((_, i) => {
    r1[`main_${i}`] = {
      type: 'choice',
      instructions: `Which block handles the main thing \`clauses[${i}]\` asks for, as part of the workflow in \`description\`?`,
      criteria: { ...blockCriteria, [NONE]: 'none: this part only says when the workflow starts, or asks for nothing' },
    };
    for (const b of blocks) {
      r1[`uses_${i}__${b.type}`] = {
        type: 'noul',
        instructions: {
          question: `Does carrying out \`clauses[${i}]\` (read in the context of \`description\`) need this block?`,
          block: `${b.name}: ${b.use}`,
        },
      };
    }
    r1[`needs_ai_${i}`] = {
      type: 'noul',
      instructions:
        `Does \`clauses[${i}]\` ask the workflow itself to judge, summarize, group, classify, detect, score or flag something ` +
        'about the data (more than just moving or copying it)?',
    };
    r1[`only_trigger_${i}`] = {
      type: 'noul',
      instructions: `Does \`clauses[${i}]\` only say when the workflow runs or what starts it, with nothing for the workflow to do?`,
    };
    if (raw[i].softSplit) {
      r1[`same_${i}`] = {
        type: 'noul',
        instructions: `Are \`clauses[${i - 1}]\` and \`clauses[${i}]\` one single step done with one action, rather than two separate steps?`,
      };
    }
  });
  const a1 = await ask({ description, clauses }, r1);

  // Merge clauses Jev says are the same step.
  type Item = { text: string; branch: StepDraft['branch']; idx: number };
  const items: Item[] = [];
  raw.forEach((c, i) => {
    const same = c.softSplit && (noul(a1, `same_${i}`) ?? 0) > 0.5;
    if (same && items.length) items[items.length - 1].text += `, and ${c.text}`;
    else items.push({ text: c.text, branch: c.branch, idx: i });
  });

  const trigger = readTrigger(a1, catalog);
  const steps: StepDraft[] = [];
  for (const item of items) {
    const i = item.idx;
    const main = choice(a1, `main_${i}`);
    const mainAlts = alts(main, blockLabels);
    // Blocks this clause needs: Jev's main pick, plus every block whose yes/no is backed by the text
    // (see selected()); strongest first, at most 3.
    const isMain = (type: string) => main?.choice === type && (main?.confidence ?? 0) >= OK;
    const needsAi = noul(a1, `needs_ai_${i}`) ?? 0;
    const scored = blocks
      .map((b) => ({ type: b.type, p: Math.max(noul(a1, `uses_${i}__${b.type}`) ?? 0, b.type === 'agent' ? needsAi : 0), name: b.name }))
      .filter((b) => isMain(b.type) || selected(b.type, b.name, b.p, item.text))
      .sort((x, y) => (isMain(y.type) ? 1 : 0) - (isMain(x.type) ? 1 : 0) || y.p - x.p)
      .slice(0, MAX_BLOCKS_PER_CLAUSE);
    if (!scored.length || ((noul(a1, `only_trigger_${i}`) ?? 0) >= 0.5 && main?.choice === NONE)) {
      if (!scored.length) trigger.eventClause = trigger.eventClause ?? item.text;
      continue;
    }
    for (const { type: original, p } of scored) {
      const forceKey = `${item.text}::${original}`;
      const f = force[forceKey];
      if (f?.remove) continue;
      const type = f?.block ?? original;
      const core = CORE_USE[type];
      steps.push({
        id: '',
        clause: item.text,
        branch: item.branch,
        kind: core?.kind ?? 'integration',
        role: core?.role ?? 'act',
        blockType: type,
        forceKey,
        kindConfidence: f?.block ? 1 : p,
        block: { value: type, name: blockLabels[type], confidence: f?.block ? 1 : p, alternatives: mainAlts },
        fields: {},
        outputs: catalog.byType[type]?.outputs ?? [],
        ...(core?.kind === 'agent' && { prompt: item.text }),
      });
    }
  }

  // Implied "tell someone": add the app the user picked, or ask later (assemble turns it into a question).
  const notifyForced = force.__notify__?.block;
  if (notifyForced && notifyForced !== NONE && catalog.byType[notifyForced]) {
    steps.push({
      id: '',
      clause: 'Send the results',
      branch: null,
      kind: 'integration',
      role: 'notify',
      blockType: notifyForced,
      forceKey: '__notify__',
      kindConfidence: 1,
      block: { value: notifyForced, name: blockLabels[notifyForced], confidence: 1 },
      fields: {},
      outputs: catalog.byType[notifyForced]?.outputs ?? [],
    });
  }

  // ---------------------------------------------------------------- round 2
  const assignIds = () => steps.forEach((s, n) => (s.id = slug(`${s.blockType}_${n + 1}`)));
  assignIds();
  const allValues = findValues(description);
  const r2: Record<string, Question> = {};
  const stepState = () => steps.map((s) => (s.kind === 'integration' ? `${s.clause} [the ${blockLabels[s.blockType]} part]` : s.clause));
  steps.forEach((s, n) => {
    const ref = `\`steps[${n}]\``;
    if (s.kind === 'integration') {
      const forcedAction = force[s.forceKey]?.action;
      const block = catalog.byType[s.blockType];
      if (!forcedAction && block?.actions.length) {
        r2[`action_${n}`] = {
          type: 'choice',
          instructions:
            s.role === 'notify' && s.forceKey === '__notify__'
              ? `Which ${block.name} action sends the results of the workflow in \`description\` to people?`
              : steps.some((o) => o.clause === s.clause && o !== s)
                ? `${ref} uses several blocks. Which ${block.name} action does its ${block.name} part need? If it reads ${block.name} ` +
                  `data to scan, analyze or check, pick the action that lists or reads that data; if it sends, saves or pushes ` +
                  `results to ${block.name}, pick the action that writes them.`
                : `Which ${block.name} action carries out the ${block.name} part of ${ref}?`,
          criteria: { ...Object.fromEntries(block.actions.slice(0, 254).map((a) => [a.op, a.label])), [NONE]: `none of these ${block.name} actions` },
        };
      }
    }
    if (s.kind === 'condition') {
      r2[`op_${n}`] = { type: 'choice', instructions: `Which comparison does the condition in ${ref} make?`, criteria: OPERATORS };
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
  const topTemplate = choice(a1, 'template');
  const template = topTemplate && topTemplate.choice !== NONE ? templates.find((t) => t.slug === topTemplate.choice) : undefined;
  if (template) {
    r2.template_fits = {
      type: 'noul',
      instructions: {
        question: 'Does this ready-made template do what `description` asks for, with the same kind of steps?',
        template: { name: template.name, description: template.description, steps: (template.steps ?? []).map((s) => s.name) },
      },
    };
  }
  const a2 = await ask({ description, steps: stepState() }, r2);

  steps.forEach((s, n) => {
    if (s.kind === 'integration') {
      const block = catalog.byType[s.blockType];
      const forcedAction = force[s.forceKey]?.action;
      const a = choice(a2, `action_${n}`);
      // Jev already said this clause needs this app; if it then answers "none" for the action, keep its
      // best real action with low confidence so the user confirms it instead of getting an empty step.
      const best = a && a.choice === NONE ? topK(a, 1, [NONE])[0] : undefined;
      const action = forcedAction
        ? block?.actions.find((x) => x.id === forcedAction)
        : a && a.choice !== NONE
          ? block?.actions.find((x) => x.op === a.choice)
          : best
            ? block?.actions.find((x) => x.op === best.id)
            : undefined;
      if (action) {
        s.action = {
          value: action.id,
          label: action.label,
          confidence: forcedAction ? 1 : best ? Math.min(best.p, OK - 0.01) : (a?.confidence ?? null),
          alternatives: forcedAction ? [] : alts(a, Object.fromEntries((block?.actions ?? []).map((x) => [x.op, x.label]))),
          def: action,
        };
        if (s.forceKey !== '__notify__') s.role = roleOfAction(s.blockType, action.op);
      } else {
        s.action = { value: null, confidence: null };
      }
    }
    if (s.kind === 'condition') {
      const op = choice(a2, `op_${n}`);
      const left = choice(a2, `left_${n}`);
      const right = choice(a2, `right_${n}`);
      s.condition = {
        operator: { value: op?.choice ?? null, confidence: op?.confidence ?? null, alternatives: alts(op, OPERATORS) },
        left: { value: left && left.choice !== NONE ? left.choice : null, confidence: left?.confidence ?? null },
        right: { value: right && right.choice !== NONE ? (numeric(right.choice) ?? right.choice) : null, confidence: right?.confidence ?? null },
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

  // Order the steps of each clause by role (fetch -> analyze -> ... -> notify); clauses keep their order.
  const clauseOrder = new Map<string, number>();
  steps.forEach((s) => clauseOrder.has(s.clause) || clauseOrder.set(s.clause, clauseOrder.size));
  steps.sort(
    (x, y) =>
      (x.forceKey === '__notify__' ? 1 : 0) - (y.forceKey === '__notify__' ? 1 : 0) ||
      clauseOrder.get(x.clause)! - clauseOrder.get(y.clause)! ||
      ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role),
  );
  assignIds();

  // An AI Agent reads what the steps before it fetched.
  steps.forEach((s, n) => {
    if (s.kind !== 'agent') return;
    const source = [...steps.slice(0, n)].reverse().find((p) => p.role === 'fetch');
    s.fields.input = {
      field: { id: 'input', title: 'Input', control: 'code', valueType: 'json', description: 'Data the agent analyzes', required: false },
      value: source ? `{{steps.${source.id}.result}}` : '{{input}}',
      confidence: 1,
    };
  });

  // ---------------------------------------------------------------- round 3
  const r3: Record<string, Question> = {};
  const fieldQs: { n: number; field: Field; key: string; labels: Record<string, string> }[] = [];
  steps.forEach((s, n) => {
    const def = s.action?.def;
    if (!def) return;
    const clauseValues = findValues(s.clause === 'Send the results' ? description : s.clause);
    const refs = dataRefs(steps.slice(0, n), s.clause, blockLabels);
    def.fields.forEach((field, k) => {
      if (['code', 'table-selector', 'account-selector', 'slider', 'switch'].includes(field.control)) return;
      const key = `f_${n}_${k}`;
      const isMessage = /^(text|message|body|content)$/i.test(field.id);
      let criteria: Record<string, string | null> = {};
      if (field.options?.length) {
        // An optional dropdown is only worth asking about when the text mentions one of its options.
        const text = `${s.clause} ${description}`.toLowerCase();
        const mentioned = field.options.some((o) => words(o.label).every((w) => text.includes(w)));
        if (!field.required && !mentioned) return;
        criteria = Object.fromEntries(field.options.slice(0, 254).map((o) => [o.id, o.label]));
      } else {
        const vals = valuesFor(field, clauseValues, allValues);
        // After an AI step, a message carries the AI's findings, not the raw data it analyzed.
        const lastAgent = [...steps.slice(0, n)].reverse().find((p) => p.kind === 'agent');
        const messageRefs = lastAgent ? refs.filter((r) => r.ref.startsWith(`{{steps.${lastAgent.id}.`)) : refs;
        const usefulRefs = isMessage ? messageRefs : refs.filter((r) => !r.ref.startsWith('{{steps.') || field.required);
        if (!vals.length && !field.required && !(isMessage && usefulRefs.length)) return; // nothing could fill it: keep the default
        for (const v of vals) criteria[v.value] = v.kind;
        for (const r of usefulRefs) criteria[r.ref] = r.label;
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
  const a3 = await ask({ description, steps: stepState() }, r3);
  for (const { n, field, key, labels } of fieldQs) {
    const a = choice(a3, key);
    const value = a && a.choice !== NONE && a.confidence >= OK ? a.choice : null;
    steps[n].fields[field.id] = { field, value, confidence: a?.confidence ?? null, alternatives: alts(a, labels) };
  }
  // A message after an AI step carries the AI's findings when the description gives no text.
  steps.forEach((s, n) => {
    const agent = [...steps.slice(0, n)].reverse().find((p) => p.kind === 'agent');
    if (!agent || s.kind !== 'integration') return;
    for (const field of s.action?.def?.fields ?? []) {
      if (/^(text|message|body|content)$/i.test(field.id) && !s.fields[field.id]?.value) {
        s.fields[field.id] = { field, value: `{{steps.${agent.id}.text}}`, confidence: 1 };
      }
    }
  });
  // Required fields nobody could fill still show up, empty, so the UI can ask for them. A step that
  // sends results also needs its destination (channel, recipient) even where the catalog marks it optional.
  for (const s of steps) {
    for (const field of s.action?.def?.fields ?? []) {
      const isMessage = /^(text|message|body|content)$/i.test(field.id);
      const isDestination = s.role === 'notify' && /^(channel|to|recipients?|email)$/i.test(field.id);
      if (isDestination && !s.fields[field.id]?.value) s.fields[field.id] = { field: { ...field, required: true }, value: null, confidence: null };
      else if ((field.required || isMessage) && !s.fields[field.id]) s.fields[field.id] = { field, value: null, confidence: null };
    }
  }

  const notifyImplied = noul(a1, 'notify_implied') ?? 0;
  const fits = noul(a2, 'template_fits') ?? 0;
  usage.usd = usage.inputTokens * JEV_PRICE_PER_TOKEN;
  return {
    description,
    trigger,
    steps,
    blockNames: blockLabels,
    notify: {
      implied: notifyImplied,
      // Covered when something sends the results, or writes them somewhere after the last analysis step.
      covered:
        steps.some((s) => s.role === 'notify') ||
        force.__notify__?.block === NONE ||
        steps.some((s, n) => s.role === 'act' && steps.slice(0, n).some((p) => p.kind === 'agent')),
      options: NOTIFY_APPS.filter((t) => catalog.byType[t]).map((t) => ({ id: t, label: blockLabels[t], p: 0 })),
    },
    template: template ? { slug: template.slug, name: template.name, fit: fits } : null,
    usage,
  };
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
  const used = [freq, freq?.choice === 'weekly' ? weekday : null, freq?.choice === 'monthly' ? monthday : null].filter(Boolean);
  out.scheduleConfidence = used.length ? Math.min(...used.map((c) => c!.confidence)) : 0;
  return out;
}

/** Data a field or condition could read: the trigger input it talks about, and earlier steps' outputs. */
function dataRefs(previous: StepDraft[], clause: string, blockNames: Record<string, string>) {
  const refs: { ref: string; label: string }[] = [];
  const subject = subjectOf(clause);
  if (subject) refs.push({ ref: `{{input.${subject}}}`, label: `the "${subject}" field of the data the workflow was started with` });
  for (const p of previous) {
    const who = `${blockNames[p.blockType] ?? p.blockType} step for "${p.clause}"`;
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
