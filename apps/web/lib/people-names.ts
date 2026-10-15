import { t } from "./i18n";

export type NamedPerson = { readonly userId: string; readonly name: string | null };

export const SHORT_CODE_LENGTH = 6;

export function shortPersonCode(userId: string): string {
  return userId
    .replace(/[^0-9a-zA-Z]/g, "")
    .slice(0, SHORT_CODE_LENGTH)
    .toUpperCase();
}

export function personName(person: NamedPerson): string {
  return person.name ?? t("projects.members.unnamed", { code: shortPersonCode(person.userId) });
}
