export const DOCUMENT_PAGE_PREFIX = "/docs";

export function buddyAllowedAt(pathname: string): boolean {
  return pathname !== DOCUMENT_PAGE_PREFIX && !pathname.startsWith(`${DOCUMENT_PAGE_PREFIX}/`);
}
