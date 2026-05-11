/** Error thrown for expected Scrumlord failures that should become JSON CLI errors. */
export class ScrumlordError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScrumlordError';
    this.code = code;
  }
}

/** Converts an unknown thrown value into an error message safe for CLI output. */
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};
