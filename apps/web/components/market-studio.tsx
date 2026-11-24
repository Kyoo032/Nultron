"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { MARKET_SPECIALISTS } from "@agentforge/core/market";
import { ArtifactActions } from "@/components/artifact-actions";
import { Confetti } from "@/components/confetti";
import { EnhancePromptButton } from "@/components/enhance-prompt-button";
import { JobProgressList } from "@/components/job-progress";
import type { JobRegenSubmit } from "@/components/job-regen-panel";
import { MarketBoard } from "@/components/market-board";
import { MarketBriefingView } from "@/components/market-briefing-view";
import { MarketWatchlistInput } from "@/components/market-watchlist-input";
import { MascotSlot } from "@/components/mascot-slot";
import { ModeIcon } from "@/components/mode-icons";
import { ModeIllustration } from "@/components/mode-illustration";
import { ModelSelect } from "@/components/model-select";
import { SettingsLinkHint } from "@/components/settings-link-hint";
import { UiSelect } from "@/components/ui-select";
import { WorkingStatus } from "@/components/working-status";
import { isGatewayBlockedText } from "@/lib/gateway-blocked";
import { getLocale, t } from "@/lib/i18n";
import {
  DEFAULT_MARKET_DEPTH,
  DEFAULT_MARKET_SPECIALIST,
  DEFAULT_MAX_CHARS,
  MARKET_DEPTHS,
  MARKET_STARTERS,
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  POSITION_PLACEHOLDER,
  applyRegeneratedSection,
  defaultWatchPrompt,
  downloadMarketDocx,
  friendlyMarketError,
  isMarketSpecialist,
  localizeMarketProgress,
  needsKey,
  nextDepth,
  nextPrompt,
  regenerateBriefingSection,
  specialistHint,
  specialistLabel,
  specialistStarterTickers,
  teamAvailable,
  type MarketDepth,
  type MarketSpecialist,
  type MarketStarter,
  type MarketWatchRequest,
  type MarketWatchResult,
  type WatchLanguage,
} from "@/lib/market-client";
import { specialistSourcesLine } from "@/lib/market-specialist";
import { loadWatchlist, saveWatchlist } from "@/lib/market-watchlists";
import { modelPickBody, regenModelPick, studioModelPick } from "@/lib/model-choice";
import { usePathname, useSearchParams } from "@/lib/nav";
import { useProductBrand } from "@/lib/product-brand";
import { labeled } from "@/lib/ui-copy";
import { useHostedNeedsKey } from "@/lib/use-desk-needs-key";
import { useJobModel } from "@/lib/use-job-model";
import { useJobStream } from "@/lib/use-job-stream";
import { useMarketBoard } from "@/lib/use-market-board";
import { useWorkspaceScope } from "@/lib/workspace-scope";
import "@/components/studio-minimal.css";

function isLanguage(value: string): value is WatchLanguage {
  return value === "id" || value === "en";
}

/** The URL holds the active specialist as `/market?specialist=<id>`. */
const MARKET_PATH = "/market";

function clampMaxChars(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_CHARS;
  }
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.round(value)));
}

export function MarketStudio() {
  const navigate = useNavigate();
  const { productName } = useProductBrand();
  const { models, model, pinned: modelPinned, setModel } = useJobModel("market");
  const job = useJobStream<MarketWatchResult>();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { id: workspaceId } = useWorkspaceScope();

  const onMarket = pathname === MARKET_PATH;
  const rawSpecialist = searchParams.get("specialist");
  const urlSpecialist: MarketSpecialist = isMarketSpecialist(rawSpecialist) ? rawSpecialist : DEFAULT_MARKET_SPECIALIST;
  const lastSpecialistRef = useRef<MarketSpecialist>(urlSpecialist);
  const specialist = onMarket ? urlSpecialist : lastSpecialistRef.current;

  const [tickers, setTickers] = useState<string[]>(() => loadWatchlist(workspaceId, specialist));
  const [language, setLanguage] = useState<WatchLanguage>(() => getLocale());
  const [depth, setDepth] = useState<MarketDepth>(DEFAULT_MARKET_DEPTH);
  const [prompt, setPrompt] = useState<string>(() => defaultWatchPrompt(specialist, getLocale()));
  const [position, setPosition] = useState("");
  const [maxChars, setMaxChars] = useState<number>(DEFAULT_MAX_CHARS);
  const [showOptions, setShowOptions] = useState(false);
  const [result, setResult] = useState<MarketWatchResult | null>(null);
  const [landed, setLanded] = useState(0);
  const [busy, setBusy] = useState<"download" | "regen" | null>(null);
  const [regenIndex, setRegenIndex] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [errorStale, setErrorStale] = useState(false);
  const board = useMarketBoard(tickers);
  const scopeKey = `${workspaceId ?? ""}|${specialist}`;
  const lastScopeRef = useRef(scopeKey);

  const keyMissing = useHostedNeedsKey();
  const rawError = errorStale ? null : (localError ?? job.error?.message ?? null);
  const error = rawError ? friendlyMarketError(rawError) : null;
  const locked = job.busy || busy !== null;
  const ready = tickers.length > 0 && prompt.trim().length > 0;

  const teamReady = teamAvailable(specialist);
  const requestDepth = nextDepth({ depth, specialist });
  const teamProgress = localizeMarketProgress(job.progress, labeled);

  useEffect(() => {
    const movedDesk = lastSpecialistRef.current !== specialist;
    lastSpecialistRef.current = specialist;
    if (!movedDesk && lastScopeRef.current === scopeKey) {
      return;
    }
    lastScopeRef.current = scopeKey;
    setTickers(loadWatchlist(workspaceId, specialist));
    setLocalError(null);
    setErrorStale(true);
    if (movedDesk) {
      setPrompt((current) => nextPrompt({ prompt: current, specialist, language }));
      setDepth((current) => nextDepth({ depth: current, specialist }));
    }
  }, [scopeKey, specialist, workspaceId, language]);

  function changeTickers(next: string[]): void {
    setTickers(next);
    saveWatchlist(workspaceId, specialist, next);
    setLocalError(null);
    setErrorStale(true);
  }

  function onLanguageChange(next: string): void {
    if (!isLanguage(next)) {
      return;
    }
    setLanguage(next);
    setPrompt(nextPrompt({ prompt, specialist, language: next }));
  }

  function onSpecialistPick(next: string): void {
    if (!isMarketSpecialist(next) || next === specialist) {
      return;
    }
    navigate(`${MARKET_PATH}?specialist=${encodeURIComponent(next)}`);
  }

  async function onGenerate(event: FormEvent) {
    event.preventDefault();
    if (locked || tickers.length === 0 || keyMissing) {
      return;
    }
    setLocalError(null);
    setErrorStale(false);
    const body: MarketWatchRequest = {
      prompt: (prompt.trim() || defaultWatchPrompt(specialist, language)).trim(),
      tickers,
      positionContext: position.trim(),
      language,
      specialist,
      depth: requestDepth,
      maxChars: clampMaxChars(maxChars),
      ...modelPickBody(studioModelPick(model, modelPinned)),
    };
    const next = await job.run("/api/v1/market/stream", body);
    if (next) {
      setResult(next);
      setLanded((count) => count + 1);
    }
  }

  async function onRegenerate(index: number, payload: JobRegenSubmit) {
    if (!result || locked || keyMissing) {
      return;
    }
    setBusy("regen");
    setRegenIndex(index);
    setLocalError(null);
    try {
      const rewritten = await regenerateBriefingSection({
        briefing: result.briefing,
        section: index,
        instruction: payload.instruction || undefined,
        ...modelPickBody(regenModelPick(payload.model, model, modelPinned)),
      });
      setResult((current) => (current ? applyRegeneratedSection(current, index, rewritten) : current));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t("market.errors.rewrite"));
    } finally {
      setBusy(null);
      setRegenIndex(null);
    }
  }

  async function onDownload() {
    if (!result || locked) {
      return;
    }
    setBusy("download");
    setLocalError(null);
    try {
      await downloadMarketDocx(result.briefing);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t("market.errors.docx"));
    } finally {
      setBusy(null);
    }
  }

  function applyStarter(starter: MarketStarter) {
    changeTickers([...starter.tickers]);
  }

  const uiLocale = getLocale();
  const specialistName = (id: MarketSpecialist): string =>
    labeled(`market.specialists.${id}.label`, specialistLabel(id, uiLocale));
  const specialistTip = (id: MarketSpecialist): string =>
    labeled(`market.specialists.${id}.hint`, specialistHint(id, uiLocale));

  const specialistOptions = useMemo(
    () =>
      MARKET_SPECIALISTS.map((id) => ({
        value: id,
        label: labeled(`market.specialists.${id}.label`, specialistLabel(id, uiLocale)),
        description: labeled(`market.specialists.${id}.hint`, specialistHint(id, uiLocale)),
      })),
    [uiLocale],
  );

  const specialistSources = specialistSourcesLine({
    specialist,
    prefix: t("market.studio.sourcesLabel"),
    computedLabel: t("market.studio.sourcesComputed"),
  });

  const depthControl = (
    <div
      className="studio-segmented"
      role="group"
      aria-label={t("market.depth.aria")}
      data-testid="market-depth"
      title={teamReady ? t("market.depth.hint") : t("market.depth.unavailable")}
    >
      {MARKET_DEPTHS.map((option) => (
        <button
          key={option}
          type="button"
          className="studio-segmented-btn"
          aria-pressed={requestDepth === option}
          onClick={() => setDepth(option)}
          disabled={locked || (option === "team" && !teamReady)}
          data-testid={`market-depth-${option}`}
        >
          {t(`market.depth.${option}`)}
        </button>
      ))}
    </div>
  );

  return (
    <main data-mode="market" className="studio-shell" data-testid="market-studio">
      <header className="studio-head">
        <div className="studio-head-main">
          <span className="studio-head-icon" aria-hidden="true">
            <ModeIcon name="market" size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="studio-head-title">{t("market.studio.title")}</h1>
            <p className="studio-head-sub">{t("market.studio.expectedInputs")}</p>
          </div>
        </div>
        {result ? (
          <button
            type="button"
            onClick={() => void onDownload()}
            disabled={locked}
            className="btn btn-primary h-9 rounded-pill px-4"
            data-testid="market-download"
          >
            {busy === "download" ? <WorkingStatus label={t("market.studio.building")} /> : t("market.studio.download")}
          </button>
        ) : null}
      </header>

      {error && !isGatewayBlockedText(error) ? (
        <p
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--danger)]"
          role="alert"
          data-testid="market-error"
        >
          {error}
          {needsKey(rawError ?? "") ? (
            <>
              {" "}
              <SettingsLinkHint i18nKey="market.studio.openSettings" testId="market-error-settings" />
            </>
          ) : null}
        </p>
      ) : null}

      {keyMissing ? (
        <p className="text-xs text-[var(--text-3)]" role="status" data-testid="market-needs-key">
          <SettingsLinkHint i18nKey="market.studio.needsKeyNote" testId="market-needs-key-settings" />
        </p>
      ) : null}

      <form className="space-y-4" onSubmit={(event) => void onGenerate(event)} data-testid="market-inputs">
        {/* Tier 1: Compact watchlist bar + single-row starter chips */}
        <section className="studio-composer">
          <div className="space-y-3 p-4">
            <MarketWatchlistInput tickers={tickers} onChange={changeTickers} disabled={locked} />
            <div className="studio-chips-row" data-testid="market-starters" aria-label={t("market.studio.startersLead")}>
              <button
                type="button"
                className="studio-chip"
                data-testid="market-specialist-starter"
                title={specialistStarterTickers(specialist).join(", ")}
                onClick={() => changeTickers(specialistStarterTickers(specialist))}
                disabled={locked}
              >
                {t("market.studio.specialistStarter", { label: specialistName(specialist) })}
              </button>
              {MARKET_STARTERS.map((starter) => (
                <button
                  key={starter.id}
                  type="button"
                  className="studio-chip"
                  data-testid="market-starter"
                  title={starter.tickers.join(", ")}
                  onClick={() => applyStarter(starter)}
                  disabled={locked}
                >
                  <span>{labeled(`market.starters.${starter.id}.label`, starter.label)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Tier 2: Unified minimalist control strip */}
          <div className="studio-composer-bar">
            <UiSelect
              variant="pill"
              prefix={t("market.studio.specialistLabel")}
              ariaLabel={t("market.studio.specialistAria")}
              testId="market-specialist-select"
              value={specialist}
              onChange={onSpecialistPick}
              disabled={locked}
              options={specialistOptions}
              minPanelWidth={280}
            />
            <UiSelect
              variant="pill"
              ariaLabel={t("market.studio.languageAria")}
              testId="market-language"
              value={language}
              onChange={onLanguageChange}
              disabled={locked}
              options={[
                { value: "id", label: t("common.bahasa") },
                { value: "en", label: t("common.english") },
              ]}
              minPanelWidth={180}
            />
            <ModelSelect
              models={models}
              value={model}
              onChange={setModel}
              disabled={locked}
              testId="market-studio-model"
              variant="pill"
              prefix={t("market.studio.modelLabel")}
              ariaLabel={t("market.studio.modelLabel")}
            />
            {depthControl}
            <button
              type="button"
              className={`studio-pill-toggle ${showOptions ? "studio-pill-toggle-active" : ""}`}
              onClick={() => setShowOptions((open) => !open)}
              aria-expanded={showOptions}
              data-testid="market-options-toggle"
            >
              {showOptions ? t("market.studio.hideOptions") : t("market.studio.options")}
            </button>
            <div className="ml-auto flex items-center gap-2">
              {job.busy ? (
                <button
                  type="button"
                  className="studio-pill-toggle"
                  onClick={job.cancel}
                  data-testid="market-cancel"
                >
                  {t("market.studio.cancel")}
                </button>
              ) : null}
              <button
                type="submit"
                className="btn btn-primary h-8 shrink-0 rounded-pill px-4 text-xs"
                disabled={locked || !ready || keyMissing}
                data-testid="market-generate"
              >
                {job.busy ? <WorkingStatus label={t("market.studio.writing")} /> : t("market.studio.writeBriefing")}
              </button>
            </div>
          </div>

          <div className="studio-composer-notes">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-3)]">
              <span className="font-medium text-[var(--text-2)]" data-testid="market-specialist-current">
                {specialistName(specialist)}
              </span>
              <span data-testid="market-specialist-hint">{specialistTip(specialist)}</span>
              <span data-testid="market-specialist-sources">{specialistSources}</span>
              <span data-testid={teamReady ? "market-depth-hint" : "market-depth-unavailable"}>
                {teamReady ? t("market.depth.hint") : t("market.depth.unavailable")}
              </span>
            </div>
            <p className="text-xs text-[var(--text-3)]">{t("market.studio.machineNote", { product: productName })}</p>
          </div>

          {showOptions ? (
            <div
              className="grid gap-4 border-t border-[var(--line)] p-4 md:grid-cols-2"
              data-testid="market-options"
            >
              <div className="space-y-4">
                <div>
                  <label htmlFor="market-position-input" className="panel-label">
                    {t("market.studio.positionLabel")}
                  </label>
                  <textarea
                    id="market-position-input"
                    rows={4}
                    value={position}
                    onChange={(event) => setPosition(event.target.value)}
                    className="input mt-2 text-[13px]"
                    placeholder={POSITION_PLACEHOLDER}
                    disabled={locked}
                    data-testid="market-position"
                  />
                  <p className="mt-1 text-xs text-[var(--text-3)]">{t("market.studio.positionHelp")}</p>
                </div>
                <div>
                  <label htmlFor="market-maxchars-input" className="panel-label">
                    {t("market.studio.lengthLimit")}
                  </label>
                  <input
                    id="market-maxchars-input"
                    type="number"
                    min={MIN_MAX_CHARS}
                    max={MAX_MAX_CHARS}
                    step={500}
                    className="input mt-2 w-40"
                    value={maxChars}
                    onChange={(event) => setMaxChars(Number(event.target.value))}
                    onBlur={() => setMaxChars(clampMaxChars(maxChars))}
                    disabled={locked}
                    data-testid="market-maxchars"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="market-prompt-input" className="panel-label">
                  {t("market.studio.promptLabel")}
                </label>
                <textarea
                  id="market-prompt-input"
                  rows={6}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="input mt-2 text-[13px]"
                  disabled={locked}
                  data-testid="market-prompt"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn text-xs"
                    onClick={() => setPrompt(defaultWatchPrompt(specialist, language))}
                    disabled={locked || prompt === defaultWatchPrompt(specialist, language)}
                    data-testid="market-prompt-reset"
                  >
                    {t("market.studio.resetPrompt")}
                  </button>
                  <EnhancePromptButton
                    text={prompt}
                    surface="market"
                    model={model}
                    disabled={locked}
                    testId="market-enhance"
                    onApply={setPrompt}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </section>

        {tickers.length > 0 && !(job.busy || (job.progress.phases.length > 0 && !result)) ? (
          <div className="flex">
            <MascotSlot mode="market" placement="empty" />
          </div>
        ) : null}
        {tickers.length > 0 ? (
          <MarketBoard
            board={board.board}
            loading={board.loading}
            error={board.error}
            tickers={tickers}
            onRefresh={board.refresh}
          />
        ) : null}
      </form>

      <div className="space-y-4">
        {job.busy || (job.progress.phases.length > 0 && !result) ? (
          <JobProgressList progress={teamProgress} busy={job.busy} mode="market" testId="market-progress" />
        ) : null}
        {result ? (
          <div className="enter-rise relative space-y-4">
            {landed > 0 ? <Confetti key={landed} /> : null}
            <div className="flex flex-wrap items-baseline gap-2">
              <h4 className="text-base font-medium text-[var(--text)]">{result.briefing.title}</h4>
              <span className="chip" data-testid="market-briefing-specialist">
                <span className="chip-dot" aria-hidden="true" />
                {specialistName(
                  isMarketSpecialist(result.briefing.specialist) ? result.briefing.specialist : specialist,
                )}
              </span>
            </div>
            <ArtifactActions
              title={result.briefing.title}
              markdown={result.markdown}
              artifactId={result.artifactId}
              kbType="Brief"
              disabled={locked}
              testIdPrefix="market"
            />
            <MarketBriefingView
              briefing={result.briefing}
              guard={result.guard}
              models={models}
              defaultModel={model}
              regeneratingIndex={regenIndex}
              onRegenerate={(index, payload) => void onRegenerate(index, payload)}
            />
          </div>
        ) : null}
        {tickers.length === 0 && !job.busy ? (
          <div
            className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-10 text-center text-[var(--text-2)]"
            data-testid="market-studio-empty"
          >
            <ModeIllustration mode="market" />
            <p className="mt-4 text-sm">{t("market.studio.empty")}</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
