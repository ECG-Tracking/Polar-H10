// ECG prompts during a synchronised ECG tracking: every few minutes the page beeps and asks for a 30-second ECG on the
// watch (the watch can't be started from the app). Each prompt counts as done when a strip recorded after it, and before
// the next prompt, is found; a strip downloaded late still counts for the prompt it belongs to, by its recording time.

export interface EcgPrompt { at: number; strip: number | null }

/** Prompt times: the first a little after the start, then every `everyMs`, up to `untilMs`. */
export const FIRST_PROMPT_MS = 30_000;
export function promptTimes(startMs: number, everyMs: number, untilMs: number): number[] {
  const out: number[] = [];
  for (let t = startMs + FIRST_PROMPT_MS; t <= untilMs; t += everyMs) out.push(t);
  return out;
}

/** The `n`th prompt's time (0 = the first), worked out directly: never a list of every future prompt. */
export const promptAt = (startMs: number, everyMs: number, n: number): number => startMs + FIRST_PROMPT_MS + n * everyMs;

/** Each prompt with the first strip that started at or after it and before the next prompt (null = missed). */
export function matchPrompts(prompts: readonly number[], strips: readonly number[]): EcgPrompt[] {
  const sorted = [...strips].sort((a, b) => a - b);
  return prompts.map((at, i) => {
    const next = prompts[i + 1] ?? Infinity;
    return { at, strip: sorted.find((s) => s >= at && s < next) ?? null };
  });
}

/** "2 of 3 ECGs taken" */
export const promptSummary = (p: readonly EcgPrompt[]): string => `${p.filter((x) => x.strip != null).length} of ${p.length} ECG${p.length === 1 ? '' : 's'} taken`;
