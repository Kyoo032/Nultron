"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import type { DocFormat, DocKind } from "@/lib/docs-client";
import { downloadFormats } from "./doc-format";

const FORMAT_LABEL_KEY: Readonly<Record<DocFormat, string>> = {
  docx: "docpage.menu.word",
  pdf: "docpage.menu.pdf",
  xlsx: "docpage.menu.excel",
};

type Props = {
  readonly kind: DocKind;
  readonly busy: boolean;
  readonly onPick: (format: DocFormat) => void;
};

export function DownloadMenu({ kind, busy, onPick }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="doc-menu">
      <button
        type="button"
        className="btn btn-primary doc-download"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        data-testid="docpage-download"
      >
        {t("docpage.download")} ▾
      </button>
      {open ? (
        <ul className="doc-menu-list" role="menu" aria-label={t("docpage.menu.label")} data-testid="docpage-menu">
          {downloadFormats(kind).map((format) => (
            <li key={format} role="none">
              <button
                type="button"
                role="menuitem"
                className="doc-menu-item"
                onClick={() => {
                  setOpen(false);
                  onPick(format);
                }}
              >
                {t(FORMAT_LABEL_KEY[format])}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
