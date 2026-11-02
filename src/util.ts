// Small helpers shared by several modules.

/** Message text of anything thrown (catch variables are `unknown`). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Name of anything thrown, e.g. 'NotFoundError' for a cancelled Bluetooth chooser. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
