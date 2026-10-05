/**
 * The inputs of the six cases. All synthetic: a bakery that does not exist, numbers invented for the
 * test. Short on purpose, because this runs against a billed gateway key.
 */

export const CHAT_PLAIN_PROMPT = "Reply with the word ready.";

/** 17.5% of 2340 is 409.5. */
export const CHAT_TOOL_PROMPT = "Use the calculator: what is 17.5% of 2340?";

/** 20 rows, 4 regions x 5 months. East sold the most (610), then North 475, South 300, West 200. */
export const SALES_CSV = [
  "region,product,units,unit_price,month",
  "North,Widget,120,9.5,2026-01",
  "North,Gadget,80,14.0,2026-02",
  "North,Widget,95,9.5,2026-03",
  "North,Gadget,70,14.0,2026-04",
  "North,Widget,110,9.5,2026-05",
  "South,Widget,60,9.5,2026-01",
  "South,Gadget,55,14.0,2026-02",
  "South,Widget,70,9.5,2026-03",
  "South,Gadget,65,14.0,2026-04",
  "South,Widget,50,9.5,2026-05",
  "East,Widget,140,9.5,2026-01",
  "East,Gadget,100,14.0,2026-02",
  "East,Widget,150,9.5,2026-03",
  "East,Gadget,90,14.0,2026-04",
  "East,Widget,130,9.5,2026-05",
  "West,Widget,40,9.5,2026-01",
  "West,Gadget,45,14.0,2026-02",
  "West,Widget,35,9.5,2026-03",
  "West,Gadget,50,14.0,2026-04",
  "West,Widget,30,9.5,2026-05",
].join("\n");

export const SALES_FILENAME = "harness-sales.csv";
export const DATA_PROMPT = "Which region sold the most units in total, and how many units was that?";
export const DATA_TOP_REGION = "East";
export const DATA_TOP_UNITS = "610";

export const DOCUMENT_SOURCE = [
  "Lakeside Bakery opened its second branch on 3 March.",
  "The new branch seats 40 guests and employs six staff.",
  "Weekday lunch is the busiest period, with a queue of about ten minutes.",
  "The owner wants an online ordering page live before June.",
  "Rent for the new branch is 18 million rupiah per month.",
].join(" ");
export const DOCUMENT_PROMPT =
  "Write a short briefing note for the owner from the source material. Use three sections.";

export const PRESENTATION_BRIEF =
  "Pitch the Lakeside Bakery online ordering page to the owner. Cover why now, what it costs, and the plan for the first month.";
export const PRESENTATION_PROMPT = `Make a 3-slide presentation. Brief: ${PRESENTATION_BRIEF}`;
export const PRESENTATION_SLIDES = 3;

/** Narrow on purpose: one fact with one well-known answer, so the sources agree and the run stays small. */
export const RESEARCH_PROMPT = "What is the default TCP port of a PostgreSQL server?";
export const RESEARCH_ANSWER = "5432";

export const SALES_ROWS = SALES_CSV.split("\n").length - 1;
