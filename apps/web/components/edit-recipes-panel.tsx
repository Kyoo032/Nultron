"use client";

import { RECIPES } from "@agentforge/core/edit";
import { editKeyGuard } from "@/lib/edit-key-guard";

type Props = {
  onRun: (recipeId: string, name: string) => void;
  /**
   * Hosted only: the tenant has no usable gateway key, so a recipe (which sends "Run recipe <id>" to the
   * Edit agent) is quiet and says why. The studio passes `useHostedNeedsKey()`, false everywhere but the
   * hosted build, so a caller that passes nothing renders exactly what it always did.
   */
  needsKey?: boolean;
};

const RECIPE_BUTTON = "w-full rounded-md border border-[var(--line)] px-2 py-1.5 text-left text-xs hover:bg-[var(--line)]/30";

export function EditRecipesPanel({ onRun, needsKey = false }: Props) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-sm">
      <p className="text-xs text-[var(--text-3)]">Each step becomes its own card after Go.</p>
      <ul className="space-y-1">
        {RECIPES.map((recipe) => (
          <li key={recipe.id}>
            <button
              type="button"
              className={needsKey ? `${RECIPE_BUTTON} cursor-not-allowed opacity-60` : RECIPE_BUTTON}
              data-testid={`edit-recipe-${recipe.id}`}
              onClick={() => onRun(recipe.id, recipe.name)}
              {...editKeyGuard(needsKey)}
            >
              {recipe.name}
              <span className="mt-0.5 block text-xs text-[var(--text-3)]">
                {recipe.steps.length} step{recipe.steps.length === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
