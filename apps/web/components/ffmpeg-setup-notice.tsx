import { useState } from "react";
import { fetchEditDoctor, type EditDoctor, type FfmpegSetup } from "@/lib/edit-client";
import { isHostedBuild } from "@/lib/hosted-build";
import { t } from "@/lib/i18n";
import { useProductBrand } from "@/lib/product-brand";

type Props = {
  doctor: EditDoctor;
  onDoctor: (doctor: EditDoctor) => void;
  /** Compact renders a single banner line; full renders the step list (onboarding). */
  variant?: "compact" | "full";
};

const PLATFORM_LABEL: Record<FfmpegSetup["platform"], string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const NOTICE_CLASS =
  "border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-4 py-2 text-xs text-[var(--text-2)]";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guides the owner through installing ffmpeg for their OS and re-probes without a restart.
 * Renders nothing when ffmpeg is already usable.
 *
 * On the hosted build the machine is the server and a tenant cannot install anything on it, so the guide
 * (a Linux command to copy, a re-check, an install link) is replaced by one calm line with none of those.
 *
 * In the packaged app the installer carries its own ffmpeg, so nobody installs one by hand. When that copy
 * will not run the host marks the hint `bundled`, and this shows one line telling the person to reinstall the
 * app, plus Check again. No command to copy, no install link, no step list, in either variant.
 */
export function FfmpegSetupNotice({ doctor, onDoctor, variant = "compact" }: Props) {
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { productName } = useProductBrand();
  const ffmpeg = doctor.ffmpeg;
  if (!ffmpeg || ffmpeg.found !== false) {
    return null;
  }
  if (isHostedBuild()) {
    return (
      <div className={NOTICE_CLASS} data-testid="edit-needs-ffmpeg" role="status">
        {t("edit.ffmpeg.hostedUnavailable")}
      </div>
    );
  }
  const setup = ffmpeg.setup;
  const command = setup?.installCommand ?? "install ffmpeg 6 or newer";
  const summary = setup?.summary ?? "ffmpeg was not found. Probe, cut, captions and export need it.";

  async function recheck() {
    setChecking(true);
    setCheckError(null);
    const next = await fetchEditDoctor({ recheck: true });
    setChecking(false);
    if (!next) {
      setCheckError("Could not reach the local host to re-check. Try again in a moment.");
      return;
    }
    onDoctor(next);
  }

  async function copy() {
    const ok = await copyText(command);
    setCopied(ok);
    if (ok) {
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  if (setup?.bundled) {
    return (
      <div className={NOTICE_CLASS} data-testid="edit-needs-ffmpeg" data-ffmpeg-bundled="true" role="status">
        <div className="flex flex-wrap items-center gap-2">
          <span>{t("edit.ffmpeg.bundledUnavailable", { productName })}</span>
          <button
            type="button"
            className="btn btn-secondary px-2 py-0.5 text-xs"
            onClick={() => void recheck()}
            disabled={checking}
            data-testid="ffmpeg-recheck"
          >
            {checking ? t("edit.ffmpeg.checking") : t("edit.ffmpeg.checkAgain")}
          </button>
        </div>
        {checkError ? <p className="mt-1 text-red-700">{t("edit.ffmpeg.recheckFailed")}</p> : null}
      </div>
    );
  }

  return (
    <div className={NOTICE_CLASS} data-testid="edit-needs-ffmpeg" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          <strong>{setup ? `${PLATFORM_LABEL[setup.platform]} setup:` : "Setup:"}</strong> {summary}
        </span>
        <code
          className="rounded bg-[var(--surface)] px-2 py-0.5 font-mono text-xs"
          data-testid="ffmpeg-install-command"
        >
          {command}
        </code>
        <button type="button" className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          className="btn btn-secondary px-2 py-0.5 text-xs"
          onClick={() => void recheck()}
          disabled={checking}
          data-testid="ffmpeg-recheck"
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        {setup?.installUrl ? (
          <a className="underline" href={setup.installUrl} target="_blank" rel="noopener noreferrer">
            Install guide
          </a>
        ) : null}
      </div>
      {checkError ? <p className="mt-1 text-red-700">{checkError}</p> : null}
      {variant === "full" && setup ? (
        <ol className="mt-2 list-decimal space-y-1 pl-5" data-testid="ffmpeg-setup-steps">
          {setup.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
