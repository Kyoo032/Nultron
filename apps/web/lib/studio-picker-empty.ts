export function studioPickerEmpty(input: {
  loading: boolean;
  keyMissing: boolean;
  listed: boolean;
  models: readonly { id: string }[];
}): boolean {
  return input.listed && !input.loading && !input.keyMissing && input.models.length === 0;
}
