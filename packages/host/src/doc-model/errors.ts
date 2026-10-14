/** Thrown for a spec that breaks the schema or a cap. The message names the field and the limit. */
export class DocModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocModelError";
  }
}
