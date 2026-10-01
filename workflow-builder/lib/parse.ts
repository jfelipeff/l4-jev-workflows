// Code side of the planner: split the description into clauses (one per intended step) and find
// the concrete values a config field could be filled with. Jev only ever chooses among these.

export type Clause = {
  text: string;
  branch: 'then' | 'else' | null; // inside an "if ..., X; otherwise Y" construction
  softSplit: boolean; // split on a bare "and"/comma: Jev decides whether it is really a new step
};

export type Value = { kind: string; value: string };

const HARD_JOIN = /\s*,?\s*\b(?:and then|then|after that|afterwards|next|finally|and also)\b\s*,?\s*/i;
const SOFT_JOIN = /\s*(?:,\s*and\s+|,\s+|\s+and\s+)(?=(?:also\s+)?(?:send|post|notify|create|update|add|email|message|alert|ask|request|wait|log|record|save|store|call|fetch|get|look|check|mark|close|assign|attach|upload|generate|book|sync|copy|move|delete|archive|schedule|invoice|charge|refund|share|ping|tell|let)\b)/i;
const CONDITION_START = /^(?:if|when|whenever|in case|unless|only if|once|every|each|on|at|daily|weekly|monthly|hourly)\b/i;
const ELSE_START = /^(?:otherwise|else|if not)\b[,:]?\s*/i;

/** Sentences: split on . ! ? ; and new lines, but not inside numbers ($5,000.50) or emails. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[!?;])\s+|(?<=[a-z)\]"”'])\.\s+|\n+/i)
    .map((s) => s.replace(/[.\s]+$/, '').trim())
    .filter(Boolean);
}

export function splitClauses(description: string): Clause[] {
  const out: Clause[] = [];
  for (const sentence of sentences(description)) {
    // A branch lasts until the end of its sentence; "Otherwise ..." opens the else branch of the previous one.
    let rest = sentence;
    let sentenceBranch: Clause['branch'] = null;
    if (ELSE_START.test(rest)) {
      sentenceBranch = 'else';
      rest = rest.replace(ELSE_START, '');
    }
    // "If X, do Y" / "When X, do Y": the head becomes its own clause.
    // Leading heads, possibly several: "When a payment comes in, if the amount is over $5,000, ..."
    for (let comma = rest.search(/,\s/); CONDITION_START.test(rest) && comma > 0; comma = rest.search(/,\s/)) {
      const head = rest.slice(0, comma).trim(); // "$50,000" is not a clause break: only ", " is
      out.push({ text: head, branch: sentenceBranch, softSplit: false });
      rest = rest.slice(comma + 1).trim();
      if (/^(?:if|unless|only if)\b/i.test(head)) sentenceBranch = 'then';
    }
    for (const hard of rest.split(HARD_JOIN).filter(Boolean)) {
      // "..., otherwise ..." inside a sentence
      const [main, ...elseParts] = hard.split(/\s*,?\s*\b(?:otherwise|or else|else)\b\s*,?\s*/i);
      const pieces = [{ text: main, branch: sentenceBranch }];
      if (elseParts.length) pieces.push({ text: elseParts.join(' '), branch: 'else' });
      for (const piece of pieces) {
        piece.text
          .split(SOFT_JOIN)
          .filter((t) => t && t.trim().length > 2)
          .forEach((t, j) => out.push({ text: t.trim(), branch: piece.branch, softSplit: j > 0 }));
      }
    }
  }
  return out;
}

const PATTERNS: [string, RegExp][] = [
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['url', /https:\/\/[^\s"'”)]+/g],
  ['channel', /(?<![\w&])#[a-z0-9][\w-]*/gi],
  ['mention', /(?<![\w.])@[a-z][\w.-]*(?![\w.-]*@)/gi],
  ['money', /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?[kKmM]?\b|\$\s?\d+(?:\.\d+)?[kKmM]?\b|\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?(?:USD|EUR|GBP|dollars)\b/g],
  ['percent', /\b\d+(?:\.\d+)?\s?%/g],
  ['duration', /\b\d+\s?(?:seconds?|minutes?|hours?|days?|weeks?)\b/gi],
  ['quoted', /["“']([^"”']{2,200})["”']/g],
  ['number', /(?<![\w$#@.,])\d{1,3}(?:,\d{3})*(?:\.\d+)?(?![\w%@]|,\d)|(?<![\w$#@.,])\d+(?:\.\d+)?(?![\w%@.,]\d)/g],
];

/** Every concrete value in the text, typed and deduplicated, in order of appearance. */
export function findValues(text: string): Value[] {
  const seen = new Set<string>();
  const out: Value[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = (kind === 'quoted' ? m[1] : m[0]).trim();
      const key = `${kind}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind, value });
      }
    }
  }
  // Message-like phrases: "saying the invoice was paid", "with the message ..."
  for (const m of text.matchAll(/\b(?:saying|that says|with (?:the )?(?:message|text|note)|message)\s*:?\s+["“]?([^"”]{3,200}?)["”]?(?=$|[.;]|\s+(?:and then|then|to\s+#))/gi)) {
    const value = m[1].trim();
    if (!seen.has(`message:${value}`)) {
      seen.add(`message:${value}`);
      out.push({ kind: 'message', value });
    }
  }
  return out;
}

/** Normalized number from a money/number/percent value: "$5,000" -> "5000", "5k" -> "5000". */
export function numeric(v: string): string | null {
  const m = v.replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kKmM])?/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1);
  return String(n);
}

/** Data the condition talks about: "if the deal amount is over ..." -> "dealAmount". */
export function subjectOf(clause: string): string | null {
  const m = clause.match(
    /^(?:if|when|whenever|unless|only if|in case)\s+(?:the\s+|its\s+|their\s+)?([a-z][\w\s-]{1,40}?)\s+(?:is|are|was|exceeds?|goes|equals?|contains?|>|<|=|over|under|above|below|greater|less|more|higher|lower|matches|starts|ends|has|does)\b/i,
  );
  if (!m) return null;
  const words = m[1].trim().split(/[\s-]+/).filter((w) => !/^(the|a|an|of)$/i.test(w));
  if (!words.length) return null;
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
}
