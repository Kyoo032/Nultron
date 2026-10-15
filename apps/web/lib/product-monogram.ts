export function productMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "A";
  }
  const [first, second] = trimmed.split(/\s+/);
  if (second) {
    return `${first?.[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
  }
  return trimmed.slice(0, 1).toUpperCase();
}
