import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { productMonogram } from "@/components/app-shell";
import { BrandMark } from "@/components/brand-mark";
import { ComponentSetupPanel } from "@/components/component-setup";
import { FfmpegSetupNotice } from "@/components/ffmpeg-setup-notice";
import { OnboardingDesks } from "@/components/onboarding-desks";
import { apiFetch, checkGateway, isElectron } from "@/lib/api-client";
import { useMayChangeCompanyKey } from "@/lib/company-key-access";
import { fetchEditDoctor, type EditDoctor } from "@/lib/edit-client";
import { onboardingFfmpegLaterKey } from "@/lib/ffmpeg-notice-copy";
import { publishGate } from "@/lib/gate-state";
import {
  gatewayReasonKey,
  parseGatewayBlocked,
  parseGatewayGate,
  resolveGate,
  type GatewayGatePayload,
} from "@/lib/gateway-gate";
import { isHostedBuild } from "@/lib/hosted-build";
import { t } from "@/lib/i18n";
import { fetchOtherDesks, openDesk, type OnboardingDesk } from "@/lib/onboarding-desks";
import { useProductBrand, usesBundledMark } from "@/lib/product-brand";
import { useComponentSetup } from "@/lib/use-component-setup";

type Props = {
  onDone: () => void;
  /** Gate the host reported at boot, so the user sees why they were sent back. */
  gateway?: GatewayGatePayload | null;
  /**
   * "Add it later" (Nultron Enterprise only). Given only to a signed-in person on the hosted build
   * (`canOfferKeyLater`); when it is absent the screen has no such button, which is every Personal
   * path: a closed gate there has no way out but a key.
   */
  onLater?: () => void;
  /** Legacy test seam kept optional for type compatibility; onboarding is now a single card. */
  initialStep?: "welcome" | "key" | "try";
};

const fieldClass =
  "mt-1.5 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-2)]/50 px-3.5 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:bg-[var(--surface)] focus:outline-none";

function OnboardingMark({
  productName,
  logoSrc,
  bundled,
}: {
  productName: string;
  logoSrc: string;
  bundled: boolean;
}) {
  if (bundled) {
    return <BrandMark size={32} className="rounded-xl" />;
  }
  if (logoSrc) {
    return <img src={logoSrc} alt="" width={36} height={36} className="h-9 w-9 rounded-xl object-contain" />;
  }
  return (
    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-2)] text-sm font-semibold text-[var(--text)]">
      {productMonogram(productName)}
    </span>
  );
}

export function OnboardingScreen({ onDone, gateway, onLater }: Props) {
  const navigate = useNavigate();
  const brand = useProductBrand();
  const { productName, gatewayName } = brand;
  // Hosted only (M4): a member cannot add the company's key (the host answers 403), so the screen
  // tells them who can and lets them wait or look around. A desk has no session and always passes.
  const mayChangeKey = useMayChangeCompanyKey();
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<GatewayGatePayload | null>(gateway ?? null);
  const [doctor, setDoctor] = useState<EditDoctor | null>(null);
  // The other desks on this install, so a desk with no key of its own is never a dead end.
  const [desks, setDesks] = useState<OnboardingDesk[]>([]);
  // Optional native components install themselves here; renders nothing when nothing needs setup.
  const componentSetup = useComponentSetup();
  // Hosted: ffmpeg lives on the server, and a tenant cannot install it there, so no install guide.
  const needsFfmpeg = !isHostedBuild() && doctor?.ffmpeg?.found === false;
  const reasonKey = gatewayReasonKey(gate?.status);
  const reasonText = error ?? (reasonKey ? t(reasonKey, { gatewayName }) : null);

  useEffect(() => {
    void fetchOtherDesks().then(setDesks);
  }, []);

  useEffect(() => {
    void fetchEditDoctor().then((report) => {
      if (report) {
        setDoctor(report);
      }
    });
  }, []);

  function finish() {
    navigate("/chat", { replace: true });
    onDone();
  }

  function applyGate(next: GatewayGatePayload | null): boolean {
    setGate(next);
    setError(null);
    // The panes the desk mounts next must not start from the closed gate the boot read published.
    publishGate(next);
    // Straight into Chat once the host accepts the key — no intermediate try screen.
    if (resolveGate(next, isElectron()) === "app") {
      finish();
      return true;
    }
    if (!next) {
      setError(t("onboarding.gate.error"));
    }
    return false;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/v1/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openaiApiKey }),
      });
      const saved = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const blocked = parseGatewayBlocked(saved);
      if (blocked) {
        setGate(null);
        setError(t(gatewayReasonKey(blocked.status) ?? "onboarding.gate.error", { gatewayName }));
        return;
      }
      const failed = saved?.error as { message?: string } | undefined;
      if (failed) {
        // Catalog copy only. The host message can name the endpoint, and this screen does not.
        setGate(null);
        setError(t("onboarding.gate.error"));
        return;
      }
      applyGate(parseGatewayGate(saved?.gateway));
    } catch {
      setGate(null);
      setError(t("onboarding.gate.unreachable", { gatewayName }));
    } finally {
      setBusy(false);
    }
  }

  async function onRecheck() {
    setError(null);
    setBusy(true);
    try {
      applyGate(await checkGateway());
    } catch {
      setError(t("onboarding.gate.unreachable", { gatewayName }));
    } finally {
      setBusy(false);
    }
  }

  async function onOpenDesk(id: string) {
    setError(null);
    setBusy(true);
    try {
      if (!applyGate(await openDesk(id))) {
        setDesks(await fetchOtherDesks());
      }
    } catch {
      setError(t("onboarding.desks.failed"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The person chose to start without a key. The caller records the choice, then this finishes
   * onboarding and opens Chat directly.
   */
  function later() {
    if (!onLater) {
      return;
    }
    navigate("/chat", { replace: true });
    onLater();
    onDone();
  }

  const title = mayChangeKey ? t("onboarding.welcome", { productName }) : t("onboarding.keyTitleRestricted");
  const subtitle = mayChangeKey
    ? t("onboarding.keyHelp", { productName, gatewayName })
    : t("onboarding.keyHelpRestricted");

  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-5 py-10 text-[var(--text)]">
      <div className="w-full max-w-[420px] space-y-5" data-testid="onboarding-card">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-elev-1 sm:p-7">
          <div className="flex flex-col items-start gap-3">
            <OnboardingMark
              productName={productName}
              logoSrc={brand.logoSrc}
              bundled={usesBundledMark(brand)}
            />
            <div>
              <h1 className="font-heading text-xl font-semibold tracking-[var(--track)] text-[var(--text)]">
                {title}
              </h1>
              <p className="mt-1 text-sm text-[var(--text-3)]">{subtitle}</p>
            </div>
          </div>

          {needsFfmpeg || componentSetup.visible ? (
            <section
              className="mt-5 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-2)]/40"
              data-testid="onboarding-setup-check"
            >
              <h2 className="border-b border-[var(--line)] px-3.5 py-2 text-xs font-semibold text-[var(--text-2)]">
                {t("onboarding.setupCheck")}
              </h2>
              {needsFfmpeg && doctor ? (
                <>
                  <FfmpegSetupNotice doctor={doctor} onDoctor={setDoctor} variant="full" />
                  <p className="px-3.5 py-2 text-xs text-[var(--text-2)]">
                    {t(onboardingFfmpegLaterKey(doctor), { productName })}
                  </p>
                </>
              ) : null}
              <ComponentSetupPanel view={componentSetup} />
            </section>
          ) : null}

          <form
            onSubmit={(event) => void onSubmit(event)}
            className="mt-5 space-y-4"
            data-testid="onboarding-form"
          >
            {reasonText ? (
              <p
                className="rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs text-[var(--danger)]"
                role="alert"
                data-testid="onboarding-gate-reason"
              >
                {reasonText}
              </p>
            ) : null}

            {mayChangeKey ? (
              <label className="block text-xs font-medium text-[var(--text-2)]">
                {t("onboarding.keyLabel")}
                <input
                  className={fieldClass}
                  type="password"
                  autoComplete="off"
                  placeholder={t("onboarding.keyPlaceholder")}
                  value={openaiApiKey}
                  onChange={(event) => setOpenaiApiKey(event.target.value)}
                  data-testid="onboarding-key"
                />
              </label>
            ) : (
              <p className="text-sm text-[var(--text-2)]" data-testid="onboarding-key-restricted">
                {t("onboarding.keyRestricted", { gatewayName })}
              </p>
            )}

            <div className="flex flex-col gap-2.5 pt-1">
              {mayChangeKey ? (
                <button
                  type="submit"
                  className="btn btn-primary w-full justify-center rounded-xl py-2.5 disabled:opacity-50"
                  disabled={busy || !openaiApiKey.trim()}
                  data-testid="onboarding-continue"
                >
                  {t("onboarding.next")}
                </button>
              ) : null}
              {reasonText || !mayChangeKey ? (
                <button
                  type="button"
                  className="btn w-full justify-center rounded-xl disabled:opacity-50"
                  onClick={() => void onRecheck()}
                  disabled={busy}
                  data-testid="onboarding-recheck"
                >
                  {t("onboarding.recheck")}
                </button>
              ) : null}
              {onLater ? (
                <button
                  type="button"
                  className="mt-0.5 self-center text-xs font-medium text-[var(--text-3)] underline-offset-4 hover:text-[var(--text)] hover:underline disabled:opacity-50"
                  onClick={later}
                  disabled={busy}
                  data-testid="onboarding-later"
                >
                  {t("onboarding.later")}
                </button>
              ) : null}
            </div>

            {onLater && mayChangeKey ? (
              <p className="text-center text-xs text-[var(--text-3)]" data-testid="onboarding-later-hint">
                {t("onboarding.laterHint")}
              </p>
            ) : null}
          </form>
        </div>

        <OnboardingDesks desks={desks} busy={busy} onOpen={(id) => void onOpenDesk(id)} />
      </div>
    </main>
  );
}
