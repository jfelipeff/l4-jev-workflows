// TypeSafe System One API, called directly (no gateway). One request carries many questions.

const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
export const JEV_PRICE_PER_TOKEN = 0.042 / 1_000_000; // input tokens only; output tokens are free

export type ChoiceQ = { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> };
export type NoulQ = { type: 'noul'; instructions: unknown; criteria?: { true: string; false: string } };
export type Question = ChoiceQ | NoulQ;

export type ChoiceA = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export type NoulA = { type: 'noul'; noul: number };
export type Answers = Record<string, ChoiceA | NoulA>;

export type JevCall = { answers: Answers; inputTokens: number; ms: number; model: string; questions: number };

/** Optional cache (tests): same request in, same answers out, no API spend on reruns. */
export type JevCache = { get(key: string): JevCall | undefined; set(key: string, value: JevCall): void };

/** `apiKey`: the caller's TypeSafe key. The website passes the visitor's own key; scripts and tests use TYPESAFE_API_KEY. */
export async function askJev(state: unknown, questions: Record<string, Question>, cache?: JevCache, apiKey?: string): Promise<JevCall> {
  const count = Object.keys(questions).length;
  if (count === 0) return { answers: {}, inputTokens: 0, ms: 0, model: MODEL, questions: 0 };
  const body = JSON.stringify({ model: MODEL, state, questions });
  const hit = cache?.get(body);
  if (hit) return hit;

  const t0 = performance.now();
  const key = apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('No TypeSafe API key.');
  const res = await post(body, key);
  if (res.status === 401 || res.status === 403) throw new JevKeyError('TypeSafe rejected the Jev API key.');
  if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const result: JevCall = {
    answers: json.answers,
    inputTokens: json.usage?.input_tokens ?? 0,
    ms: performance.now() - t0,
    model: json.model,
    questions: count,
  };
  cache?.set(body, result);
  return result;
}

export class JevKeyError extends Error {}

/** Retries network errors, 429 and 5xx twice with a short backoff: a person is waiting. */
async function post(body: string, key: string, attempts = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
      });
      if ((res.status === 429 || res.status >= 500) && i < attempts) throw new Error(`TypeSafe API ${res.status}`);
      return res;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 200 * i));
    }
  }
}

export const choice = (a: Answers, id: string) => a[id] as ChoiceA | undefined;
export const noul = (a: Answers, id: string) => (a[id] as NoulA | undefined)?.noul;

/** The k most probable options of a Choice answer, best first. */
export function topK(a: ChoiceA | undefined, k: number, exclude: string[] = []) {
  if (!a) return [];
  return Object.entries(a.probabilities)
    .filter(([id]) => !exclude.includes(id))
    .sort((x, y) => y[1] - x[1])
    .slice(0, k)
    .map(([id, p]) => ({ id, p }));
}
