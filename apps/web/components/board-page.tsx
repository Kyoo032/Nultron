"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { BoardCardDialog } from "@/components/board-card-dialog";
import { ModeHeader } from "@/components/mode-header";
import {
  createCard,
  createColumn,
  loadBoard,
  updateCard,
  updateColumn,
  type BoardColumn,
  type BoardSnapshot,
  type CardSummary,
} from "@/lib/board-client";
import { openBoardStream, type BoardFrame, type BoardStreamState } from "@/lib/board-stream";
import { boardErrorMessage, cardsByColumn, columnLabel, dropPlacement, personLabel } from "@/lib/board-view";
import { t } from "@/lib/i18n";
import "./board.css";

/**
 * The team board (tester lane, phase K0; team-board-spec.md sections 13 and 14). Server mode only:
 * App.tsx routes `/board` on a hosted build alone, and the host answers 404 on Personal.
 *
 * The stream is used as a nudge. Each event reloads the snapshot (coalesced), and an event about the
 * open card reloads that card. Applying events as patches can come later; K0 keeps one source of
 * truth, the host's snapshot.
 */

const RELOAD_COALESCE_MS = 150;

/** Run a board write, show the desk's sentence for a refusal, then reload. `move` words a conflict for a drag. */
type RunBoardWork = (work: () => Promise<unknown>, context?: "move") => Promise<void>;

export function BoardPage() {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [live, setLive] = useState<BoardStreamState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [openCardKey, setOpenCardKey] = useState(0);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const openCardRef = useRef<string | null>(null);
  openCardRef.current = openCardId;
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await loadBoard());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) {
      return;
    }
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, RELOAD_COALESCE_MS);
  }, [reload]);

  useEffect(() => {
    void reload();
    return () => {
      if (reloadTimer.current) {
        clearTimeout(reloadTimer.current);
      }
    };
  }, [reload]);

  // The stream opens once the first snapshot is drawn, after that snapshot's cursor, so nothing is missed
  // between the two. It is not reopened for later snapshots: it tracks its own last id from then on.
  const cursor = board?.cursor ?? null;
  const streamStarted = cursor !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stream opens on the first snapshot and on a manual reconnect, not on every cursor.
  useEffect(() => {
    if (!streamStarted || cursor === null) {
      return;
    }
    const stream = openBoardStream({
      after: cursor,
      onState: setLive,
      onReset: scheduleReload,
      onEvent: (frame: BoardFrame) => {
        scheduleReload();
        if (typeof frame.data.cardId === "string" && frame.data.cardId === openCardRef.current) {
          setOpenCardKey((key) => key + 1);
        }
      },
    });
    return () => stream.close();
  }, [streamStarted, streamEpoch, scheduleReload]);

  const run: RunBoardWork = async (work, context) => {
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(boardErrorMessage(caught, context));
    }
    await reload();
  };

  if (!board) {
    return (
      <main className="board-page" data-testid="board-page">
        <p className="board-status" role="status">
          {loadFailed ? t("board.loadFailed") : t("board.loading")}
        </p>
        {loadFailed ? (
          <button type="button" className="btn btn-secondary" onClick={() => void reload()}>
            {t("board.retry")}
          </button>
        ) : null}
      </main>
    );
  }

  const grouped = cardsByColumn(board.columns, board.cards);
  const reconnect = () => {
    void reload();
    setStreamEpoch((epoch) => epoch + 1);
  };

  return (
    <main className="board-page" data-testid="board-page" data-mode="board">
      <ModeHeader
        icon="board"
        title={t("board.title")}
        outcomeTestId="board-intro"
        outcome={t("board.intro")}
        actions={<LiveBadge state={live} onReconnect={reconnect} />}
      />

      {error ? (
        <p className="board-error" role="alert" data-testid="board-error">
          {error}
        </p>
      ) : null}

      <div className="board-columns" data-testid="board-columns">
        {board.columns.map((column) => (
          <BoardColumnView
            key={column.id}
            column={column}
            cards={grouped.get(column.id) ?? []}
            board={board}
            onOpen={setOpenCardId}
            run={run}
          />
        ))}
        {board.me.canAdminister ? <AddColumn run={run} /> : null}
      </div>

      {openCardId ? (
        <BoardCardDialog
          cardId={openCardId}
          columns={board.columns}
          people={board.people}
          me={board.me.userId}
          canAdminister={board.me.canAdminister}
          refreshKey={openCardKey}
          onClose={() => setOpenCardId(null)}
          onChanged={scheduleReload}
        />
      ) : null}
    </main>
  );
}

function LiveBadge({ state, onReconnect }: { state: BoardStreamState; onReconnect: () => void }) {
  return (
    <div className="board-live" data-state={state} data-testid="board-live" role="status">
      <span className="board-live-dot" aria-hidden="true" />
      <span>{t(`board.live.${state}`)}</span>
      {state === "paused" ? (
        <button type="button" className="btn btn-ghost" onClick={onReconnect} data-testid="board-live-resume">
          {t("board.live.resume")}
        </button>
      ) : null}
    </div>
  );
}

type ColumnProps = {
  column: BoardColumn;
  cards: readonly CardSummary[];
  board: BoardSnapshot;
  onOpen: (cardId: string) => void;
  run: RunBoardWork;
};

const DRAG_TYPE = "application/x-board-card";

function BoardColumnView({ column, cards, board, onOpen, run }: ColumnProps) {
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const label = columnLabel(column);

  const drop = (event: DragEvent, targetId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    const draggedId = event.dataTransfer.getData(DRAG_TYPE);
    const dragged = board.cards.find((card) => card.id === draggedId);
    const placement = dragged ? dropPlacement(dragged.id, column.id, targetId) : null;
    if (!dragged || !placement) {
      return;
    }
    void run(() => updateCard(dragged.id, { version: dragged.version, ...placement }), "move");
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text) {
      return;
    }
    setTitle("");
    void run(() => createCard({ title: text, columnId: column.id }));
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    const name = (renaming ?? "").trim();
    setRenaming(null);
    void run(() => updateColumn(column.id, { name: name || null }));
  };

  return (
    <section
      className="board-column"
      data-kind={column.kind}
      data-over={over || undefined}
      data-testid={`board-column-${column.kind === "custom" ? column.id : column.kind}`}
      aria-label={label}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => drop(event, null)}
    >
      <header className="board-column-head">
        {renaming !== null ? (
          <form onSubmit={rename} className="board-inline-form">
            <input
              className="input"
              value={renaming}
              maxLength={60}
              aria-label={t("board.column.namePlaceholder")}
              onChange={(event) => setRenaming(event.target.value)}
            />
            <button type="submit" className="btn btn-secondary">
              {t("board.column.save")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setRenaming(null)}>
              {t("board.column.cancel")}
            </button>
          </form>
        ) : (
          <>
            <h2 className="board-column-title">{label}</h2>
            <span className="board-column-count" aria-label={t("board.column.count", { count: cards.length })}>
              {cards.length}
            </span>
            {board.me.canAdminister ? (
              <span className="board-column-tools" aria-label={t("board.column.actions", { name: label })}>
                <button type="button" className="btn btn-ghost" onClick={() => setRenaming(column.name ?? label)}>
                  {t("board.column.rename")}
                </button>
                {column.kind === "custom" ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void run(() => updateColumn(column.id, { archived: true }))}
                  >
                    {t("board.column.archive")}
                  </button>
                ) : null}
              </span>
            ) : null}
          </>
        )}
      </header>

      <ol className="board-card-list">
        {cards.length === 0 ? <li className="board-column-empty">{t("board.column.empty")}</li> : null}
        {cards.map((card) => (
          <li key={card.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, card.id)}>
            <button
              type="button"
              className="board-card"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, card.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onOpen(card.id)}
              aria-label={t("board.card.open", { title: card.title })}
              data-testid="board-card"
              data-card-id={card.id}
            >
              <span className="board-card-title">{card.title}</span>
              <span className="board-card-meta">
                <span>
                  {card.assignee
                    ? personLabel(board.people, card.assignee.userId, board.me.userId)
                    : t("board.card.unassigned")}
                </span>
                {card.commentCount > 0 ? <span>{t("board.card.comments", { count: card.commentCount })}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <form className="board-inline-form" onSubmit={add}>
        <input
          className="input"
          value={title}
          maxLength={200}
          placeholder={t("board.card.titlePlaceholder")}
          aria-label={t("board.card.add")}
          onChange={(event) => setTitle(event.target.value)}
          data-testid="board-add-card-input"
        />
        <button type="submit" className="btn btn-secondary" disabled={!title.trim()} data-testid="board-add-card">
          {t("board.card.create")}
        </button>
      </form>
    </section>
  );
}

function AddColumn({ run }: { run: RunBoardWork }) {
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = name.trim();
    if (!text) {
      return;
    }
    setName("");
    void run(() => createColumn(text));
  };
  return (
    <form className="board-column board-add-column board-inline-form" onSubmit={submit}>
      <input
        className="input"
        value={name}
        maxLength={60}
        placeholder={t("board.column.namePlaceholder")}
        aria-label={t("board.column.add")}
        onChange={(event) => setName(event.target.value)}
        data-testid="board-add-column-input"
      />
      <button type="submit" className="btn btn-secondary" disabled={!name.trim()} data-testid="board-add-column">
        {t("board.column.add")}
      </button>
    </form>
  );
}
