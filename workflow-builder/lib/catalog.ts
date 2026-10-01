// The Loopfour block catalog (GET /api/v1/blocks), normalized into what the planner chooses from:
// triggers, blocks, and per-block actions with the fields that apply to each action.
// Everything here comes from the live catalog; nothing is invented.

export type Option = { id: string; label: string };
type Condition = { field: string; value: string | string[]; not?: boolean; and?: Condition };

export type Field = {
  id: string;
  title: string;
  control: string; // authoring control: short-input, dropdown, combobox, switch, ...
  valueType: string; // string | number | boolean | json | array | file
  description: string;
  options?: Option[];
  required: boolean;
};

export type Action = {
  id: string; // fully qualified, e.g. "slack.sendMessage"
  op: string; // value of the block's operation field, e.g. "sendMessage"
  opField: string | null; // "operation" for most blocks, "action" for stagehand, null when there is none
  label: string; // "Send Message"
  fields: Field[]; // fields that apply to this action (connection and operation excluded)
};

export type Block = {
  type: string;
  name: string;
  description: string;
  kind: 'core' | 'integrations' | 'triggers';
  connectionRequired: boolean;
  outputs: string[];
  actions: Action[];
};

export type Catalog = { blocks: Block[]; triggers: Block[]; byType: Record<string, Block> };

type RawSubBlock = {
  id: string;
  title?: string;
  type: string;
  required?: boolean;
  requiredWhen?: Condition;
  visibleWhen?: Condition;
  options?: { id: string; label?: string }[];
};
type RawBlock = {
  type: string;
  name: string;
  description?: string;
  kind: Block['kind'];
  connectionRequired?: boolean;
  actions?: string[];
  inputs?: { key: string; type: string; description?: string }[];
  outputs?: string[];
  subBlocks?: RawSubBlock[];
};

const SKIP_FIELDS = new Set(['connection', 'operation']);

function matches(cond: Condition | undefined, values: Record<string, string>): boolean {
  if (!cond) return true;
  const actual = values[cond.field];
  const wanted = Array.isArray(cond.value) ? cond.value : [cond.value];
  let ok = actual !== undefined && wanted.includes(actual);
  if (cond.not) ok = !ok;
  return ok && matches(cond.and, values);
}

/** "createInvoice" -> "Create Invoice" */
export const humanize = (id: string) =>
  id.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function normalizeBlock(raw: RawBlock): Block {
  const subBlocks = raw.subBlocks ?? [];
  const inputs = Object.fromEntries((raw.inputs ?? []).map((i) => [i.key, i]));
  const opSub = subBlocks.find((s) => s.id === 'operation') ?? subBlocks.find((s) => s.id === 'action' && s.options?.length);
  const ops: Option[] = opSub?.options?.length
    ? opSub.options.map((o) => ({ id: o.id, label: o.label ?? humanize(o.id) }))
    : (raw.actions ?? []).map((a) => {
        const id = a.split('.').slice(1).join('.');
        return { id, label: humanize(id) };
      });

  const actions: Action[] = ops.map((o) => {
    const values = opSub ? { [opSub.id]: o.id } : {};
    const fields = subBlocks
      .filter((s) => !SKIP_FIELDS.has(s.id) && s.id !== opSub?.id && matches(s.visibleWhen, values))
      .map((s) => ({
        id: s.id,
        title: s.title ?? humanize(s.id),
        control: s.type,
        valueType: inputs[s.id]?.type ?? 'string',
        description: inputs[s.id]?.description ?? '',
        options: s.options?.length ? s.options.map((x) => ({ id: x.id, label: x.label ?? x.id })) : undefined,
        required: !!s.required || (s.requiredWhen ? matches(s.requiredWhen, values) : false),
      }));
    return { id: `${raw.type}.${o.id}`, op: o.id, opField: opSub?.id ?? null, label: o.label, fields };
  });

  return {
    type: raw.type,
    name: raw.name,
    description: raw.description ?? '',
    kind: raw.kind,
    connectionRequired: !!raw.connectionRequired,
    outputs: raw.outputs ?? [],
    actions,
  };
}

export function buildCatalog(raw: { core: RawBlock[]; integrations: RawBlock[]; triggers: RawBlock[] }): Catalog {
  const blocks = [...raw.integrations, ...raw.core].map(normalizeBlock);
  const triggers = raw.triggers.map(normalizeBlock);
  return { blocks, triggers, byType: Object.fromEntries([...blocks, ...triggers].map((b) => [b.type, b])) };
}
