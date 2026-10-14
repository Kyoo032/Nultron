/**
 * Three brand-neutral themes. A theme holds the font, the heading sizes and the colours; the renderers
 * read them by name. Colours are plain hex without a `#`, and each renderer converts them to its own
 * format (docx takes RRGGBB, exceljs takes ARGB, pdf-lib takes 0 to 1 floats).
 *
 * The PDF renderer draws with the standard Helvetica family, which is the only font it can embed
 * without a font file. `fontFamily` therefore applies to docx and xlsx only.
 */
export const DOC_THEME_NAMES = ["plain", "corporate", "modern"] as const;
export type DocThemeName = (typeof DOC_THEME_NAMES)[number];

export type DocTheme = {
  readonly name: DocThemeName;
  readonly fontFamily: string;
  readonly bodySize: number;
  /** Point sizes for the title, a section heading, and a table or sheet title. */
  readonly titleSize: number;
  readonly headingSize: number;
  readonly textColor: string;
  readonly accentColor: string;
  readonly headerFill: string;
  readonly headerText: string;
  readonly ruleColor: string;
};

export const DOC_THEMES: Readonly<Record<DocThemeName, DocTheme>> = Object.freeze({
  plain: {
    name: "plain",
    fontFamily: "Calibri",
    bodySize: 11,
    titleSize: 22,
    headingSize: 15,
    textColor: "222222",
    accentColor: "333333",
    headerFill: "E5E5E5",
    headerText: "222222",
    ruleColor: "BBBBBB",
  },
  corporate: {
    name: "corporate",
    fontFamily: "Arial",
    bodySize: 10.5,
    titleSize: 24,
    headingSize: 15,
    textColor: "1F2933",
    accentColor: "1F3A5F",
    headerFill: "1F3A5F",
    headerText: "FFFFFF",
    ruleColor: "1F3A5F",
  },
  modern: {
    name: "modern",
    fontFamily: "Segoe UI",
    bodySize: 11,
    titleSize: 26,
    headingSize: 16,
    textColor: "292929",
    accentColor: "0F766E",
    headerFill: "D9F2EE",
    headerText: "0B4F4A",
    ruleColor: "0F766E",
  },
});

export function themeFor(name: DocThemeName): DocTheme {
  return DOC_THEMES[name];
}
