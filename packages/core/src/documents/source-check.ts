/**
 * Marks draft sentences the optional source does not support.
 * Overlap is computed here. The model is not called.
 */

export type SourceCheckItem = {
  sectionIndex: number;
  sentence: string;
  supported: boolean;
};

export type SourceCheck = {
  checked: boolean;
  reason?: "no_source";
  items: SourceCheckItem[];
};

export type CheckableDraft = {
  title: string;
  sections: Array<{ heading: string; body: string }>;
};

function numberTokens(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

/** A number counts only as itself: "8" is not inside "18". */
function sourceHasNumber(source: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d])${escaped}(?![\\d])`).test(source);
}

/**
 * `numbered` also keeps a short part that states a number, so "Revenue grew 14%." is checked.
 * A title or heading is a label ("Heading 1", "2. Risks"), so it keeps only the six-word rule.
 */
function sentences(text: string, numbered: boolean): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).length >= 6 || (numbered && numberTokens(part).length > 0));
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function sentenceSupported(sentence: string, sourceNorm: string, sourceWords: Set<string>): boolean {
  const nums = numberTokens(sentence);
  if (nums.some((token) => !sourceHasNumber(sourceNorm, token))) {
    return false;
  }
  const norm = sentence.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm.length >= 12 && sourceNorm.includes(norm)) {
    return true;
  }
  const own = words(sentence);
  if (own.length === 0) {
    return true;
  }
  const hits = own.filter((word) => sourceWords.has(word)).length;
  return hits / own.length >= 0.6;
}

export function checkDraftAgainstSource(draft: CheckableDraft, sourceText: string): SourceCheck {
  const source = sourceText.trim();
  if (!source) {
    return { checked: false, reason: "no_source", items: [] };
  }
  const sourceNorm = source.toLowerCase().replace(/\s+/g, " ");
  const sourceWords = new Set(words(source));
  const items: SourceCheckItem[] = [];
  const consider = (sectionIndex: number, text: string, numbered: boolean) => {
    for (const sentence of sentences(text, numbered)) {
      items.push({
        sectionIndex,
        sentence,
        supported: sentenceSupported(sentence, sourceNorm, sourceWords),
      });
    }
  };
  consider(-1, draft.title, false);
  draft.sections.forEach((section, index) => {
    consider(index, `${section.heading}.`, false);
    consider(index, section.body, true);
  });
  return { checked: true, items };
}
